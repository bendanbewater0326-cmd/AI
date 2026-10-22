/**
 * WebM / Matroska 解封装（task:T19）。
 *
 * ## 为什么要单独一个 demuxer
 *
 * WebM 是 EBML（可变长二进制元语言）容器，与 mp4 的 box 结构完全不同：
 * 元素 ID 与 size 都是**可变长整数**（vint），且允许 `size` 为"未知"（表示延伸到文件尾）。
 * 但**输出契约必须与 mp4 完全一致**（`SampleIndexEntry` / `MediaProbeResult`），
 * 否则 T06 的解码器池要写两套分支。
 *
 * ## 三条来自实测的硬约束（架构 task:T19 ①②）
 *
 * 1. **必须按 `TrackNumber` 分流**：视频 block → `samples`，音频 block → 独立音频样本表。
 * 2. **音频 block 的 `0x80` flag 无意义**：实测每条音轨所有 block 该位都是 1，
 *    若计入关键帧会得到上百个假关键帧（`keyframeIndex` 只取视频轨）。
 * 3. **未知 size 必须处理**：`compat/webm-nocues.webm` 的 Segment size 就是
 *    `0x01FFFFFFFFFFFFFF`（全 1 = 未知），按"延伸到文件尾"处理；未知 size 的 Cluster
 *    按"读到下一个 Cluster ID 或 EOF"处理。
 *
 * ## lacing
 *
 * 三种（Xiph / EBML / fixed）用**单元测试**覆盖，不靠 fixture——现有 5 个 webm 素材的
 * lacing bits 全为 0（每个 block 恰好一帧），拿它们测 lacing 等于没测。
 */
import type { MediaProbeResult, Result, SampleIndexEntry } from '../core/types';
import { fail, ok } from '../core/types';
import type { BlobLike } from './demuxMp4';

/* ================= 元素 ID（EBML / Matroska） ================= */

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  DefaultDuration: 0x23e383,
  CodecDelay: 0x56aa,
  SeekPreRoll: 0x56bb,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  OutputSamplingFrequency: 0x78b5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  ReferenceBlock: 0xfb,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  CueRelativePosition: 0xf0,
  Chapters: 0x1043a770,
  Tags: 0x1254c367,
  Attachments: 0x1941a469,
  Void: 0xec,
  CRC32: 0xbf,
} as const;

/** 默认 TimecodeScale：1 毫秒（单位纳秒）。 */
const DEFAULT_TIMECODE_SCALE_NS = 1_000_000; // timebase-allow: 容器 TimecodeScale 默认值（纳秒），非帧↔时间换算
/** 帧时间戳未知时给的上限保护。 */
const MAX_BLOCKS = 2_000_000;

/* ================= 基础类型 ================= */

/** 元素头信息。 */
export interface ElementHeader {
  /** 元素 ID（保留 vint 的 marker bit，与 EBML 规范一致）。 */
  id: number;
  /** 内容字节数；`null` = 未知 size（延伸到文件尾 / 下一个同级 ID）。 */
  size: number | null;
  /** 内容起始偏移（header 之后）。 */
  contentStart: number;
  /** header 占用的字节数（1-12）。 */
  headerSize: number;
}

/* ================= vint 解析 ================= */

/**
 * 读一个可变长整数。
 *
 * 长度由首个字节的前导零决定：`0x80`→1 字节，`0x40`→2，`0x20`→3 … `0x01`→8。
 * `keepMarker` 为 true 时保留 marker bit（用于**元素 ID**）；false 时去掉（用于 **size**）。
 *
 * 返回 `null` 表示字节不足或首字节为 0（非法）。
 */
export function readVint(
  bytes: Uint8Array,
  pos: number,
  keepMarker: boolean,
): { value: number; length: number } | null {
  const first = bytes[pos];
  if (first === undefined || first === 0) return null;

  let length = 1;
  let mask = 0x80;
  while ((first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8 || pos + length > bytes.length) return null;

  // 第一字节：keepMarker 时保留整个字节，否则去掉 marker bit
  let value = keepMarker ? first : first & (mask - 1);
  for (let i = 1; i < length; i += 1) {
    const byte = bytes[pos + i];
    if (byte === undefined) return null;
    // 用乘法而非 <<，避免超过 32 位时符号位污染
    value = value * 256 + byte;
  }
  return { value, length };
}

/**
 * 读元素头。
 *
 * `size` 全为 1（如 `0x01FFFFFFFFFFFFFF`）表示**未知 size** → 返回 `size: null`。
 */
export function readElementHeader(bytes: Uint8Array, pos: number): ElementHeader | null {
  const id = readVint(bytes, pos, true);
  if (id === null) return null;
  const sizePart = readVint(bytes, pos + id.length, false);
  if (sizePart === null) return null;

  const headerSize = id.length + sizePart.length;
  const contentStart = pos + headerSize;
  // 未知 size：去掉 marker 后所有 bit 全为 1
  const allOnes = 2 ** (7 * sizePart.length) - 1;
  const unknown = sizePart.value === allOnes;
  return {
    id: id.value,
    size: unknown ? null : sizePart.value,
    contentStart,
    headerSize,
  };
}

/* ================= 整数 / 浮点读取 ================= */

function readUint(bytes: Uint8Array): number {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
}

function readFloat(bytes: Uint8Array): number {
  if (bytes.length === 4) {
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getFloat32(0, false);
  }
  if (bytes.length === 8) {
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, false);
  }
  return 0;
}

function readString(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) {
    if (byte === 0) break;
    text += String.fromCharCode(byte);
  }
  return text;
}

/* ================= Block lacing ================= */

export type LacingKind = 'none' | 'xiph' | 'fixed' | 'ebml';

/** 一个 block 拆出的帧（压缩帧字节范围 + 是否关键帧）。 */
export interface BlockFrame {
  /** 相对整个文件的字节偏移。 */
  offset: number;
  size: number;
  isKey: boolean;
  /** 相对 cluster 的毫秒时间戳（lacing 多帧时逐帧 +1ms 递增）。 */
  relativeMs: number;
}

/**
 * 解析一个 block 的 lacing，把帧切成若干段。
 *
 * `data` 是 block 载荷（TrackNumber/timecode/flags 之后的部分），
 * `baseOffset` 是 `data[0]` 在文件中的绝对偏移（用于生成 offset）。
 *
 * ## 三种 lacing（T19 ①，靠单测覆盖）
 * - **Xiph**：每帧 size 用"255 累加字节"，最后非 255 字节收尾。
 * - **EBML**：首帧用无符号 vint，后续帧用**带符号** vint 差值（相对前一帧 size）。
 * - **fixed**：帧数由 lacing 头给出，数据均分；除不尽的余数归最后一帧。
 */
export function splitBlockLacing(
  data: Uint8Array,
  baseOffset: number,
  lacing: LacingKind,
  isKey: boolean,
  relativeMs: number,
): BlockFrame[] | null {
  if (lacing === 'none') {
    return [{ offset: baseOffset, size: data.length, isKey, relativeMs }];
  }

  // lacing 头：第 1 字节 = 帧数 - 1
  const frameCountByte = data[0];
  if (frameCountByte === undefined) return null;
  const frameCount = frameCountByte + 1;
  if (frameCount < 1) return null;
  const sizes: number[] = [];

  if (lacing === 'fixed') {
    const payload = data.length - 1;
    const base = Math.floor(payload / frameCount);
    for (let i = 0; i < frameCount; i += 1) {
      sizes.push(i === frameCount - 1 ? payload - base * (frameCount - 1) : base);
    }
    return buildFrames(sizes, baseOffset + 1, isKey, relativeMs);
  }

  if (lacing === 'xiph') {
    let pos = 1;
    for (let i = 0; i < frameCount - 1; i += 1) {
      let size = 0;
      for (;;) {
        const byte = data[pos];
        if (byte === undefined) return null;
        pos += 1;
        size += byte;
        if (byte !== 255) break;
      }
      sizes.push(size);
    }
    const used = sizes.reduce((sum, size) => sum + size, 0);
    sizes.push(data.length - pos - used);
    if ((sizes[sizes.length - 1] ?? -1) < 0) return null;
    return buildFrames(sizes, baseOffset + pos, isKey, relativeMs);
  }

  // EBML lacing
  const firstSize = readVint(data, 1, false);
  if (firstSize === null) return null;
  sizes.push(firstSize.value);
  let pos = 1 + firstSize.length;
  for (let i = 1; i < frameCount - 1; i += 1) {
    const diff = readSignedVint(data, pos);
    if (diff === null) return null;
    sizes.push((sizes[i - 1] ?? 0) + diff.value);
    pos += diff.length;
  }
  const sumSoFar = sizes.reduce((sum, size) => sum + size, 0);
  sizes.push(data.length - pos - sumSoFar);
  if ((sizes[sizes.length - 1] ?? -1) < 0) return null;
  return buildFrames(sizes, baseOffset + pos, isKey, relativeMs);
}

/** EBML lacing 的"带符号"vint：值 = 无符号值 - (2^(7L-1) - 1)。 */
function readSignedVint(bytes: Uint8Array, pos: number): { value: number; length: number } | null {
  const raw = readVint(bytes, pos, false);
  if (raw === null) return null;
  const bias = 2 ** (7 * raw.length - 1) - 1;
  return { value: raw.value - bias, length: raw.length };
}

function buildFrames(
  sizes: number[],
  payloadStart: number,
  isKey: boolean,
  relativeMs: number,
): BlockFrame[] {
  const frames: BlockFrame[] = [];
  let offset = payloadStart;
  for (let i = 0; i < sizes.length; i += 1) {
    frames.push({
      offset,
      size: sizes[i] ?? 0,
      isKey,
      // 同 block 内的多帧按 1ms 递增（EBML/Matroska 约定）
      relativeMs: relativeMs + i,
    });
    offset += sizes[i] ?? 0;
  }
  return frames;
}

/** 从 block flags 字节解析 lacing 类型。 */
export function lacingOf(flags: number): LacingKind {
  const bits = (flags >> 1) & 0b11;
  if (bits === 0) return 'none';
  if (bits === 1) return 'xiph';
  if (bits === 2) return 'fixed';
  return 'ebml';
}

/* ================= 主解析：openWebm ================= */

/** webm 探测结果：`MediaProbeResult` 的超集（与 `Mp4ProbeResult` 同构）。 */
export interface WebmProbeResult extends MediaProbeResult {
  container: 'webm';
  /** 时间基（纳秒），来自 `TimecodeScale`。 */
  timecodeScaleNs: number;
  /** Segment 时长（毫秒，来自 `Info/Duration`）；缺失为 null。 */
  durationMs: number | null;
  video: WebmTrackInfo | null;
  audio: WebmAudioTrackInfo | null;
  /** 是否有 Cues（无 Cues 时 keyframeIndex 靠扫描回填）。 */
  hasCues: boolean;
}

export interface WebmTrackInfo {
  codec: string;
  width: number;
  height: number;
  sampleCount: number;
  /** VP8/VP9 无 codec private，恒 null（保留字段与 mp4 同构）。 */
  description: Uint8Array | null;
  hasBFrames: boolean;
  keyframeCount: number;
  /** 由 DefaultDuration 或样本 PTS 差推出的毫帧率。 */
  fpsMilli: number;
}

export interface WebmAudioTrackInfo {
  codec: string;
  sampleRate: number;
  channels: number;
  sampleCount: number;
  description: Uint8Array | null;
  samples: SampleIndexEntry[];
}

const VIDEO_TRACK = 1;
const AUDIO_TRACK = 2;

async function readBytes(source: BlobLike, start: number, end: number): Promise<Uint8Array> {
  const safeStart = Math.max(0, Math.min(start, source.size));
  const safeEnd = Math.max(safeStart, Math.min(end, source.size));
  if (safeEnd <= safeStart) return new Uint8Array(0);
  return new Uint8Array(await source.slice(safeStart, safeEnd).arrayBuffer());
}

/**
 * 在 `[start, end)` 内遍历同级元素。
 *
 * 未知 size 的处理：
 * - `Segment` 未知 → 延伸到文件尾；
 * - `Cluster` 未知 → 读到下一个同 ID 元素头或 `end`（T19 ①）。
 */
function* iterElements(
  bytes: Uint8Array,
  start: number,
  end: number,
  absoluteBase: number,
): Generator<{ header: ElementHeader; absStart: number }> {
  let pos = start;
  while (pos < end) {
    const header = readElementHeader(bytes, pos);
    if (header === null) return;
    const absStart = absoluteBase + pos;
    const limit = header.size === null ? end : Math.min(end, header.contentStart + header.size);
    yield { header, absStart };
    if (header.size === null) {
      // 未知 size 交给调用方按 ID 解析；顺序遍历无法跳步，直接停止（Segment/Cluster 各自处理）
      return;
    }
    if (limit <= pos) return;
    pos = limit;
  }
}

/** 解析核心：读窗口内的 Segment 结构。 */
async function parseSegment(
  source: BlobLike,
  segmentStart: number,
  segmentEnd: number,
): Promise<Result<WebmProbeResult>> {
  // 一次读入整个 Segment（webm 通常几 MB；超过 64MB 拒绝，避免内存爆炸）
  const MAX_SEGMENT = 128 * 1024 * 1024;
  if (segmentEnd - segmentStart > MAX_SEGMENT) {
    return fail({
      code: 'E_UNSUPPORTED_VARIANT',
      message: 'WebM 文件过大',
      detail: `segment ${segmentEnd - segmentStart} 字节 > ${MAX_SEGMENT}`,
      at: Date.now(),
    });
  }
  const bytes = await readBytes(source, segmentStart, segmentEnd);

  let timecodeScaleNs = DEFAULT_TIMECODE_SCALE_NS;
  let durationMs: number | null = null;
  let hasCues = false;

  interface TrackMeta {
    number: number;
    type: number;
    codecId: string;
    codecPrivate: Uint8Array | null;
    width: number;
    height: number;
    sampleRate: number;
    channels: number;
    defaultDurationNs: number | null;
  }
  const tracks: TrackMeta[] = [];

  // 第一遍：Info / Tracks / Cues 是否存在
  for (const { header } of iterElements(bytes, 0, bytes.length, 0)) {
    if (header.id === ID.Info && header.size !== null) {
      const body = bytes.subarray(header.contentStart, header.contentStart + header.size);
      for (const { header: child } of iterElements(body, 0, body.length, 0)) {
        if (child.size === null) continue;
        const value = body.subarray(child.contentStart, child.contentStart + child.size);
        if (child.id === ID.TimecodeScale) timecodeScaleNs = readUint(value) || DEFAULT_TIMECODE_SCALE_NS;
        if (child.id === ID.Duration) durationMs = readFloat(value);
      }
    }
    if (header.id === ID.Tracks && header.size !== null) {
      const body = bytes.subarray(header.contentStart, header.contentStart + header.size);
      for (const { header: entry } of iterElements(body, 0, body.length, 0)) {
        if (entry.id !== ID.TrackEntry || entry.size === null) continue;
        const entryBody = body.subarray(entry.contentStart, entry.contentStart + entry.size);
        const meta: TrackMeta = {
          number: 0, type: 0, codecId: '', codecPrivate: null,
          width: 0, height: 0, sampleRate: 0, channels: 0, defaultDurationNs: null,
        };
        for (const { header: field } of iterElements(entryBody, 0, entryBody.length, 0)) {
          if (field.size === null) continue;
          const value = entryBody.subarray(field.contentStart, field.contentStart + field.size);
          switch (field.id) {
            case ID.TrackNumber: meta.number = readUint(value); break;
            case ID.TrackType: meta.type = readUint(value); break;
            case ID.CodecID: meta.codecId = readString(value); break;
            case ID.CodecPrivate: meta.codecPrivate = new Uint8Array(value); break;
            case ID.DefaultDuration: meta.defaultDurationNs = readUint(value); break;
            case ID.Video: {
              for (const { header: v } of iterElements(value, 0, value.length, 0)) {
                if (v.size === null) continue;
                const inner = value.subarray(v.contentStart, v.contentStart + v.size);
                if (v.id === ID.PixelWidth) meta.width = readUint(inner);
                if (v.id === ID.PixelHeight) meta.height = readUint(inner);
              }
              break;
            }
            case ID.Audio: {
              for (const { header: a } of iterElements(value, 0, value.length, 0)) {
                if (a.size === null) continue;
                const inner = value.subarray(a.contentStart, a.contentStart + a.size);
                if (a.id === ID.SamplingFrequency) meta.sampleRate = readFloat(inner);
                if (a.id === ID.OutputSamplingFrequency) {
                  const out = readFloat(inner);
                  if (out > 0) meta.sampleRate = out;
                }
                if (a.id === ID.Channels) meta.channels = readUint(inner);
              }
              break;
            }
            default: break;
          }
        }
        if (meta.number > 0) tracks.push(meta);
      }
    }
    if (header.id === ID.Cues) hasCues = true;
  }

  const videoTrack = tracks.find((track) => track.type === VIDEO_TRACK) ?? null;
  const audioTrack = tracks.find((track) => track.type === AUDIO_TRACK) ?? null;
  if (videoTrack === null && audioTrack === null) {
    return fail({
      code: 'E_UNSUPPORTED_VARIANT',
      message: 'WebM 既无视频轨也无音频轨',
      detail: `tracks=${tracks.map((track) => track.type).join(',')}`,
      at: Date.now(),
    });
  }

  // 第二遍：遍历 Cluster，按 TrackNumber 分流
  const videoSamples: SampleIndexEntry[] = [];
  const audioSamples: SampleIndexEntry[] = [];
  const videoKeyframes: number[] = [];
  const videoPts: number[] = [];

  const videoNumber = videoTrack?.number ?? -1;
  const audioNumber = audioTrack?.number ?? -1;
  let blockCount = 0;

  /** 处理单个 block 载荷（SimpleBlock / BlockGroup 的 Block）。 */
  const handleBlock = (
    payload: Uint8Array,
    payloadAbsOffset: number,
    isSimpleBlock: boolean,
    referenced: boolean,
    clusterTimeMs: number,
  ): void => {
    blockCount += 1;
    if (blockCount > MAX_BLOCKS) return;

    const trackVint = readVint(payload, 0, false);
    if (trackVint === null) return;
    const trackNumber = trackVint.value;
    let pos = trackVint.length;
    if (payload.length < pos + 3) return;

    // int16 大端相对时间戳
    const relHigh = payload[pos] ?? 0;
    const relLow = payload[pos + 1] ?? 0;
    let relative = (relHigh << 8) | relLow;
    if (relative >= 0x8000) relative -= 0x10000;
    pos += 2;

    const flags = payload[pos] ?? 0;
    pos += 1;
    // SimpleBlock 的 bit7 才是关键帧标志；BlockGroup 的 Block 靠 ReferenceBlock 判断
    const keyFlag = isSimpleBlock ? (flags & 0x80) !== 0 : !referenced;
    const lacing = lacingOf(flags);
    const timeMs = clusterTimeMs + relative;

    const frames = splitBlockLacing(payload.subarray(pos), payloadAbsOffset + pos, lacing, keyFlag, relative);
    if (frames === null) return;

    for (const frame of frames) {
      // timebase-allow: 容器时间基（纳秒）→ 微秒，封装层时间戳，与项目帧时基无关
      const ptsUs = Math.round(((clusterTimeMs + frame.relativeMs) * timecodeScaleNs) / 1000);
      if (trackNumber === videoNumber) {
        const index = videoSamples.length;
        videoSamples.push({ index, offset: frame.offset, size: frame.size, dtsUs: ptsUs, ptsUs, isKey: frame.isKey });
        videoPts.push(ptsUs);
        if (frame.isKey) videoKeyframes.push(index);
      } else if (trackNumber === audioNumber) {
        const index = audioSamples.length;
        // 音频 isKey 恒 false：0x80 位在音轨无意义（T19 ② 实测 174/201 假关键帧）
        audioSamples.push({ index, offset: frame.offset, size: frame.size, dtsUs: ptsUs, ptsUs, isKey: false });
      }
      void timeMs;
    }
  };

  // 遍历顶层 Cluster（未知 size 的 Cluster 用"读到下一个 Cluster ID"处理）
  let pos = 0;
  while (pos < bytes.length) {
    const header = readElementHeader(bytes, pos);
    if (header === null) break;
    if (header.id !== ID.Cluster) {
      if (header.size === null) break;
      pos = Math.min(bytes.length, header.contentStart + header.size);
      continue;
    }

    // Cluster 结束边界
    let clusterEnd: number;
    if (header.size !== null) {
      clusterEnd = Math.min(bytes.length, header.contentStart + header.size);
    } else {
      // 未知 size：向后找下一个 Cluster ID（或 EOF）
      clusterEnd = findNextCluster(bytes, header.contentStart);
    }

    let innerPos = header.contentStart;
    let clusterTimeMs = 0;
    while (innerPos < clusterEnd) {
      const child = readElementHeader(bytes, innerPos);
      if (child === null) break;
      // 遇到下一个 Cluster（未知 size 场景）就停
      if (child.id === ID.Cluster) break;

      const childEnd = child.size === null ? clusterEnd : Math.min(clusterEnd, child.contentStart + child.size);
      if (child.id === ID.Timecode && child.size !== null) {
        clusterTimeMs = readUint(bytes.subarray(child.contentStart, child.contentStart + child.size));
      } else if (child.id === ID.SimpleBlock && child.size !== null) {
        handleBlock(
          bytes.subarray(child.contentStart, child.contentStart + child.size),
          segmentStart + child.contentStart,
          true,
          false,
          clusterTimeMs,
        );
      } else if (child.id === ID.BlockGroup && child.size !== null) {
        // BlockGroup：内部 Block 是数据，ReferenceBlock 存在即非关键帧
        let blockPayload: Uint8Array | null = null;
        let blockAbs = 0;
        let referenced = false;
        const groupEnd = child.contentStart + child.size;
        let gp = child.contentStart;
        while (gp < groupEnd) {
          const field = readElementHeader(bytes, gp);
          if (field === null || field.size === null) break;
          if (field.id === ID.Block) {
            blockPayload = bytes.subarray(field.contentStart, field.contentStart + field.size);
            blockAbs = segmentStart + field.contentStart;
          }
          if (field.id === ID.ReferenceBlock) referenced = true;
          gp = Math.min(groupEnd, field.contentStart + field.size);
        }
        if (blockPayload !== null) handleBlock(blockPayload, blockAbs, false, referenced, clusterTimeMs);
      }
      if (childEnd <= innerPos) break;
      innerPos = childEnd;
    }
    pos = clusterEnd;
  }

  // 帧率：优先 DefaultDuration，否则用 PTS 差值中位数
  let fpsMilli = 0;
  if (videoTrack?.defaultDurationNs !== null && videoTrack !== null && videoTrack.defaultDurationNs > 0) {
    // timebase-allow: DefaultDuration（纳秒/帧）→ 毫帧率。**单位陷阱**：1e9/ns 得到的是
    // 帧/秒（30），还要 ×1000 才是毫帧率（30000）；写成 1e9 会让帧率小 1000 倍、整个时基崩塌。
    fpsMilli = Math.round(1_000_000_000_000 / videoTrack.defaultDurationNs);
  } else if (videoPts.length >= 2) {
    const deltas: number[] = [];
    for (let i = 1; i < Math.min(videoPts.length, 60); i += 1) {
      const delta = (videoPts[i] ?? 0) - (videoPts[i - 1] ?? 0);
      if (delta > 0) deltas.push(delta);
    }
    deltas.sort((a, b) => a - b);
    const median = deltas[Math.floor(deltas.length / 2)] ?? 0;
    // PTS 差值（微秒/帧）→ 毫帧率：1e6/us 是帧/秒，×1000 才是毫帧率，故分子用 1e9。
    if (median > 0) fpsMilli = Math.round(1_000_000_000 / median); // timebase-allow: 素材帧率探测，非项目帧换算
  }
  if (fpsMilli <= 0) fpsMilli = 30000;
  const durationFrames = videoSamples.length > 0 ? videoSamples.length : null;

  const video: WebmTrackInfo | null = videoTrack === null ? null : {
    codec: videoCodecString(videoTrack.codecId, videoTrack.codecPrivate),
    width: videoTrack.width,
    height: videoTrack.height,
    sampleCount: videoSamples.length,
    // **VP8/VP9/AV1 不需要 description**：WebCodecs 的 VideoDecoderConfig.description 只对
    // AVC(avcC)/HEVC(hvcC) 有意义。把 VP9 的 CodecPrivate 传进去会让 configure 失败 → 永远黑屏。
    // 保留字段为 null 才是与 mp4「同构但语义正确」。
    description: null,
    hasBFrames: false,
    keyframeCount: videoKeyframes.length,
    fpsMilli,
  };

  const audio: WebmAudioTrackInfo | null = audioTrack === null ? null : {
    codec: audioCodecString(audioTrack.codecId),
    sampleRate: Math.round(audioTrack.sampleRate) || 48000,
    channels: audioTrack.channels || 2,
    sampleCount: audioSamples.length,
    description: audioTrack.codecPrivate,
    samples: audioSamples,
  };

  return ok({
    container: 'webm',
    hasVideo: video !== null,
    hasAudio: audio !== null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    fpsMilli: video === null ? null : fpsMilli,
    durationFrames,
    videoCodec: video?.codec ?? null,
    audioCodec: audio?.codec ?? null,
    sampleRate: audio?.sampleRate ?? null,
    channels: audio?.channels ?? null,
    exactSeek: true,
    keyframeIndex: videoKeyframes,
    needsIndexScan: !hasCues,
    samples: videoSamples,
    timecodeScaleNs,
    durationMs,
    video,
    audio,
    hasCues,
  });
}

/** 未知 size 的 Cluster：找到下一个 Cluster 元素头的起始偏移。 */
function findNextCluster(bytes: Uint8Array, from: number): number {
  for (let pos = from; pos + 4 <= bytes.length; pos += 1) {
    // Cluster ID = 1F 43 B6 75
    if (bytes[pos] === 0x1f && bytes[pos + 1] === 0x43 && bytes[pos + 2] === 0xb6 && bytes[pos + 3] === 0x75) {
      return pos;
    }
  }
  return bytes.length;
}

function videoCodecString(codecId: string, privateData: Uint8Array | null): string {
  if (codecId === 'V_VP9') {
    // vp09.<profile>.<level>.<bitDepth>；profile/level 从 CodecPrivate 无法可靠读出，
    // 用标准 8bit 4:2:0 profile 0 的 RFC6381 串（WebCodecs 接受）。
    return 'vp09.00.10.08';
  }
  if (codecId === 'V_VP8') return 'vp8';
  if (codecId === 'V_AV1') return 'av01.0.04M.08';
  void privateData;
  return codecId.toLowerCase();
}

function audioCodecString(codecId: string): string {
  if (codecId === 'A_OPUS') return 'opus';
  if (codecId === 'A_VORBIS') return 'vorbis';
  if (codecId === 'A_AAC') return 'mp4a.40.2';
  return codecId.toLowerCase();
}

/**
 * 打开并解析 webm。
 *
 * 只解析 `Segment`；`EBML` 头跳过。未知 size 的 Segment 视作延伸到文件尾（T19 ①）。
 */
export async function openWebm(source: BlobLike): Promise<Result<WebmProbeResult>> {
  try {
    const head = await readBytes(source, 0, Math.min(source.size, 64));
    const ebml = readElementHeader(head, 0);
    if (ebml === null || ebml.id !== ID.EBML) {
      return fail({
        code: 'E_UNSUPPORTED_CONTAINER',
        message: '不是 WebM 文件',
        detail: '缺少 EBML 魔数',
        at: Date.now(),
      });
    }
    if (ebml.size === null) {
      return fail({ code: 'E_DECODE_FAILED', message: 'EBML 头 size 未知', at: Date.now() });
    }

    // EBML 头之后应紧跟 Segment
    const segmentHeaderPos = ebml.contentStart + ebml.size;
    const segmentHeader = readElementHeader(head, segmentHeaderPos);
    if (segmentHeader === null || segmentHeader.id !== ID.Segment) {
      // 头 64 字节不够读 Segment 头时，多读一点
      const wider = await readBytes(source, segmentHeaderPos, Math.min(source.size, segmentHeaderPos + 32));
      const retry = readElementHeader(wider, 0);
      if (retry === null || retry.id !== ID.Segment) {
        return fail({
          code: 'E_UNSUPPORTED_CONTAINER',
          message: 'WebM 缺少 Segment',
          detail: `offset=${segmentHeaderPos}`,
          at: Date.now(),
        });
      }
      return parseSegment(
        source,
        segmentHeaderPos + retry.headerSize,
        retry.size === null ? source.size : Math.min(source.size, segmentHeaderPos + retry.headerSize + retry.size),
      );
    }

    // Segment size 未知（0x01FFFFFFFFFFFFFF）→ 延伸到文件尾
    const segmentStart = segmentHeaderPos + segmentHeader.headerSize;
    const segmentEnd = segmentHeader.size === null
      ? source.size
      : Math.min(source.size, segmentStart + segmentHeader.size);
    return parseSegment(source, segmentStart, segmentEnd);
  } catch (error) {
    return fail({
      code: 'E_DECODE_FAILED',
      message: 'WebM 解析失败',
      detail: error instanceof Error ? error.message : String(error),
      at: Date.now(),
    });
  }
}
