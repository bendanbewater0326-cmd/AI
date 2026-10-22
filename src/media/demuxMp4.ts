/**
 * 自研 ISO BMFF（mp4 / mov）解封装（架构 §8.1 / §8.2 / §8.5，task:T05）。
 *
 * ## 支持矩阵（与架构 §8.5 同步，任何未列出的变体一律显式拒绝）
 *
 * | 变体 | 处理 |
 * |---|---|
 * | moov 前置 / moov 在尾部 | ✅ 顶层 box 按 `offset+size` 链式遍历，**不假设 moov 位置** |
 * | 有 B 帧（存在 `ctts`） | ✅ `dtsUs`（stts 累加）与 `ptsUs`（+ctts）**分别独立存储**，索引按 `ptsUs` 升序 |
 * | 长 GOP / 单关键帧 | ✅ `keyframeIndex` 取自 `stss`（presentation order 序号） |
 * | HEVC（`hvc1`/`hev1`） | ✅ 走 `hvcC`（**不假设 `avcC` 存在**） |
 * | 纯音频 mp4 | ✅ `hasVideo:false`、`keyframeIndex:[]`、`samples` 只含音轨 |
 * | 非恒定 stts delta | ✅ 一律用 stts 实际 delta 构建时间戳，禁止假设 `delta === 1` |
 * | fragmented mp4（`moof`/`mfra`） | ❌ `E_UNSUPPORTED_VARIANT` |
 * | 多 sample entry（`stsd.entry_count > 1`） | ❌ `E_UNSUPPORTED_VARIANT` |
 * | 加密（`encv`/`enca`/`sinf`） | ❌ `E_UNSUPPORTED_VARIANT` |
 * | webm / mkv / 其它容器 | ❌ `E_UNSUPPORTED_CONTAINER`（webm 由 task:T19 的 `demuxWebm` 负责） |
 *
 * ## 两条硬约束
 *
 * 1. **按需 slice，禁止整体读入内存**：`long_ntsc.mp4` 是 52MB（mdat 54MB），
 *    本模块只读 box 头（每个 16 字节）与 `moov` 本体（本例 25KB）。
 * 2. **禁止 throw 到调用方**：内部用 `DemuxRejection` 中断解析，`openMp4` 统一捕获并
 *    转成 `Result.ok === false`。异常会让导入流程留下半插入的 asset 条目（架构 §8.5）。
 *    也**禁止返回半成品**：样本表不自洽（stts/stsz/stsc 对不上）直接整条失败。
 *
 * 本模块**不依赖 WebCodecs**（Node 可直接单测）；缩略图解码在 `mediaProbe.ts` 且可注入。
 */

import type {
  ErrorCode,
  MediaProbeResult,
  MilliFps,
  Result,
  SampleIndexEntry,
  VEditorError,
} from '../core/types';
import { makeError } from '../core/types';

/* ---------- 输入抽象（File / Blob 结构化兼容，Node 里可注入 fs 分块读） ---------- */

/** `Blob.slice()` 的返回值最小契约。 */
export interface BlobSliceLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * `File` / `Blob` 的结构化子集。
 *
 * `File` 天然满足本接口（`slice` 的额外 `contentType` 参数是可选的），
 * Node 单测里用 `fs` 分块读可注入一个等价实现，从而在无浏览器环境下验证解析逻辑。
 */
export interface BlobLike {
  readonly size: number;
  slice(start?: number, end?: number): BlobSliceLike;
}

/** 顶层 box 上限：防御损坏文件造成的死循环。 */
const MAX_TOP_LEVEL_BOXES = 4096;

/** moov 上限：超过即视为异常变体（正常 moov 为 KB 级，216k 样本 ≈ 6MB）。 */
const MAX_MOOV_BYTES = 64 * 1024 * 1024;

/** 毫单位基数：帧率用"毫帧率"整数表示，故每秒 1000 毫单位。 */
const MILLI_PER_SECOND = 1000;

/**
 * 微秒换算分子：容器 timescale tick → 微秒（封装层时间戳，与项目帧时基无关；
 * 架构 §5 管的是项目帧换算，本模块不参与）。
 */
const US_PER_SECOND = 1_000_000; // timebase-allow: 容器 timescale tick → 微秒，不是帧↔时间换算

/** ftyp 之前的合法前置 box（部分编码器会插入 free/wide）。 */
const PREAMBLE_BOXES = new Set(['ftyp', 'free', 'skip', 'wide', 'styp', 'mdat']);

/** 视觉 sample entry 的 fourcc（`stsd` 第一名）。 */
const VISUAL_FORMATS = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'vp08', 'vp09', 'av01']);

/** 音频 sample entry 的 fourcc。 */
const AUDIO_FORMATS = new Set(['mp4a', 'Opus', 'opus', 'ac-3', 'ec-3', 'alac', 'fLaC', 'twos', 'sowt', 'lpcm', 'mp3 ']);

/** 加密 sample entry 的 fourcc。 */
const ENCRYPTED_FORMATS = new Set(['encv', 'enca', 'encs', 'enct', 'encf']);

/* ---------- 内部拒绝（不外泄异常） ---------- */

/** 解析中断信号：只在 `openMp4` 边界被捕获，转换为 `Result`。 */
class DemuxRejection extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'DemuxRejection';
  }

  /** 转成统一的 `VEditorError`（`at` 由 makeError 填）。 */
  toEditorError(): VEditorError {
    return makeError(this.code, this.message, this.detail);
  }
}

/** 抛内部拒绝（`never` 便于在表达式位置使用）。 */
function reject(code: ErrorCode, message: string, detail?: string): never {
  throw new DemuxRejection(code, message, detail);
}

/* ---------- 字节读取 ---------- */

/** 在给定 `Uint8Array` 上建立 `DataView`（注意 byteOffset，避免共享 buffer 时错位）。 */
function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** 读 4 字节 fourcc / ASCII。 */
function readAscii(dv: DataView, position: number, length: number): string {
  let text = '';
  for (let i = 0; i < length; i += 1) {
    text += String.fromCharCode(dv.getUint8(position + i));
  }
  return text;
}

/** 从 blob 按需读取 `[start, end)` 字节；越界自动裁剪。 */
async function readBytes(source: BlobLike, start: number, end: number): Promise<Uint8Array> {
  const safeStart = Math.max(0, Math.min(start, source.size));
  const safeEnd = Math.max(safeStart, Math.min(end, source.size));
  if (safeEnd <= safeStart) return new Uint8Array(0);
  const buffer = await source.slice(safeStart, safeEnd).arrayBuffer();
  return new Uint8Array(buffer);
}

/* ---------- box 遍历 ---------- */

interface BoxRange {
  type: string;
  /** box 起点（含 header）。 */
  boxStart: number;
  /** 内容起点（header 之后）。 */
  contentStart: number;
  /** box 结束（不含）。 */
  boxEnd: number;
}

/**
 * 遍历 `[start, end)` 内的同级 box。
 *
 * 未知 `size === 0`（延伸到文件尾）与 `size === 1`（64 位 largesize）都按 ISO 14496-12 处理；
 * 结构不自洽（size 越界 / 小于 header）时安静结束，由调用方判断"缺 box"。
 */
function* iterBoxes(dv: DataView, start: number, end: number): Generator<BoxRange> {
  let offset = start;
  while (offset + 8 <= end) {
    let size = dv.getUint32(offset);
    const type = readAscii(dv, offset + 4, 4);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) return;
      const largeSize = dv.getBigUint64(offset + 8);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return;
      size = Number(largeSize);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) return;
    yield { type, boxStart: offset, contentStart: offset + headerSize, boxEnd: offset + size };
    offset += size;
  }
}

/** 在 `[start, end)` 内查找第一个指定类型的 box。 */
function findBox(dv: DataView, start: number, end: number, type: string): BoxRange | null {
  for (const box of iterBoxes(dv, start, end)) {
    if (box.type === type) return box;
  }
  return null;
}

/* ---------- 顶层扫描（按需 slice） ---------- */

interface TopLevelBox {
  type: string;
  offset: number;
  size: number;
  headerSize: number;
  /** true = 声明的 size 超出文件长度（截断文件）。 */
  truncated: boolean;
}

/** 顺序遍历顶层 box：每个 box 只读 16 字节头，**不读 mdat 内容**。 */
async function scanTopLevelBoxes(source: BlobLike): Promise<TopLevelBox[]> {
  const boxes: TopLevelBox[] = [];
  const total = source.size;
  let offset = 0;
  while (offset + 8 <= total && boxes.length < MAX_TOP_LEVEL_BOXES) {
    const head = await readBytes(source, offset, Math.min(offset + 16, total));
    if (head.length < 8) break;
    const dv = viewOf(head);
    let size = dv.getUint32(0);
    const type = readAscii(dv, 4, 4);
    let headerSize = 8;
    if (size === 1) {
      if (head.length < 16) break;
      const largeSize = dv.getBigUint64(8);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(largeSize);
      headerSize = 16;
    } else if (size === 0) {
      // size === 0 → 延伸到文件尾（ISO 14496-12），其后不可能再有 moov
      boxes.push({ type, offset, size: total - offset, headerSize, truncated: false });
      break;
    }
    if (size < headerSize) break;
    if (offset + size > total) {
      boxes.push({ type, offset, size: total - offset, headerSize, truncated: true });
      break;
    }
    boxes.push({ type, offset, size, headerSize, truncated: false });
    offset += size;
  }
  return boxes;
}

/* ---------- fil 时间戳换算 ---------- */

/**
 * 容器 timescale tick → 微秒（封装层时间戳，与项目帧时基无关）。
 *
 * 必须先乘后除并只在返回前取整一次，否则 1001/24000 这类 NTSC 时基会累积漂移。
 *
 * **取整方向必须与 `timebase.frameToUs` 一致（向下取整）**：这样 CFR 素材的
 * `samples[S].ptsUs === frameToUs(S, fpsMilli)` 恒等（T06 ① 断言 `frame.timestamp ===
 * frameToUs(137, 30000) === 4566666`，若这里用四舍五入会差 1µs）。这条一致性是 T05/T06
 * 的接口契约，改动前先看 `tests/verify-t06.mjs` 的 ①。
 */
function ticksToUs(ticks: number, timescale: number): number {
  if (timescale <= 0) return 0;
  return Math.floor((ticks * US_PER_SECOND) / timescale);
}

/* ---------- codec 字符串（RFC 6381） ---------- */

/** 32 位按位反转（HEVC 的 `general_profile_compatibility_flags` 需要反转后输出）。 */
function reverseBits32(value: number): number {
  let result = 0;
  let input = value >>> 0;
  for (let i = 0; i < 32; i += 1) {
    result = (result << 1) | (input & 1);
    input >>>= 1;
  }
  return result >>> 0;
}

/** 两位小写十六进制（RFC 6381 / ffprobe 的 mime codec string 用小写）。 */
function hex2(value: number): string {
  return (value & 0xff).toString(16).padStart(2, '0');
}

/** 两位大写十六进制（HEVC 的 constraint bytes 惯例大写）。 */
function hex2Upper(value: number): string {
  return (value & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

/**
 * AVC：`avc1.PPCCLL`（profile / constraint flags / level，来自 `avcC` 记录）。
 * 例：`avc1.640028`（High@L40）、`avc1.64001e`（High@L30）。
 */
function formatAvcCodec(format: string, record: Uint8Array): string {
  const dv = viewOf(record);
  const profile = dv.getUint8(1);
  const compat = dv.getUint8(2);
  const level = dv.getUint8(3);
  return `${format}.${hex2(profile)}${hex2(compat)}${hex2(level)}`;
}

/**
 * HEVC：`hvc1.1.6.L93.B0` 形式（来自 `hvcC` 记录）。
 *
 * 注意 `hvc1` / `hev1` 的 `description` 与 `avcC` **结构不同**，
 * 因此代码里绝不能"假设 avcC 存在"（`hevc.mp4` 只有 `hvcC`）。
 */
function formatHevcCodec(format: string, record: Uint8Array): string {
  if (record.length < 13) return format;
  const dv = viewOf(record);
  const byte1 = dv.getUint8(1);
  const profileSpace = (byte1 >> 6) & 0x03;
  const tierFlag = (byte1 >> 5) & 0x01;
  const profileIdc = byte1 & 0x1f;
  const compatFlags = reverseBits32(dv.getUint32(2));
  const levelIdc = dv.getUint8(12);
  const space = profileSpace === 0 ? '' : String.fromCharCode(64 + profileSpace);
  const constraints: string[] = [];
  for (let i = 6; i < 12; i += 1) constraints.push(hex2Upper(dv.getUint8(i)));
  while (constraints.length > 0 && constraints[constraints.length - 1] === '00') constraints.pop();
  const base = `${format}.${space}${profileIdc}.${compatFlags.toString(16).toUpperCase()}.${
    tierFlag === 1 ? 'H' : 'L'
  }${levelIdc}`;
  return constraints.length > 0 ? `${base}.${constraints.join('.')}` : base;
}

/** VP9：`vp09.PP.LL.DD`（`vpcC`）。 */
function formatVp9Codec(format: string, record: Uint8Array): string {
  if (record.length < 7) return format;
  const dv = viewOf(record);
  const profile = dv.getUint8(4);
  const level = dv.getUint8(5);
  const bitDepth = (dv.getUint8(6) >> 4) & 0x0f;
  return `${format}.${hex2(profile)}.${hex2(level)}.${hex2(bitDepth)}`;
}

/** AV1：`av01.P.LLT`（`av1C`，M2 不做解码，只给出可读标识）。 */
function formatAv1Codec(format: string, record: Uint8Array): string {
  if (record.length < 3) return format;
  const dv = viewOf(record);
  const byte1 = dv.getUint8(1);
  const seqProfile = (byte1 >> 5) & 0x07;
  const seqLevelIdx = byte1 & 0x1f;
  const tier = (dv.getUint8(2) >> 7) & 0x01;
  return `${format}.${seqProfile}.${seqLevelIdx}${tier === 1 ? 'H' : 'M'}`;
}

/* ---------- sample entry（stsd） ---------- */

interface VisualEntry {
  kind: 'video';
  format: string;
  width: number;
  height: number;
  codec: string;
  /** `avcC` / `hvcC` / `vpcC` / `av1C` 记录的原始字节（WebCodecs `description`）。 */
  description: Uint8Array | null;
}

interface AudioEntry {
  kind: 'audio';
  format: string;
  channelCount: number;
  sampleRate: number;
  codec: string;
  /** `esds` 中的 AudioSpecificConfig（WebCodecs 的 `description`）。 */
  description: Uint8Array | null;
}

type SampleEntry = VisualEntry | AudioEntry;

/** 复制 `[start, end)` 字节（脱离 moov 大 buffer，避免长生命周期持有）。 */
function copyBytes(bytes: Uint8Array, start: number, end: number): Uint8Array {
  const from = Math.max(0, Math.min(start, bytes.length));
  const to = Math.max(from, Math.min(end, bytes.length));
  return bytes.slice(from, to);
}

/** 解析 ES_Descriptor 链，取出 AAC 对象类型与 AudioSpecificConfig。 */
function parseEsds(bytes: Uint8Array, start: number, end: number): { codec: string; description: Uint8Array | null } {
  const dv = viewOf(bytes);
  let objectTypeIndication = 0x40;
  let audioObjectType = 2;
  let asc: Uint8Array | null = null;

  /** 顺序读 descriptor（tag + 1..4 字节变长长度）。 */
  const walk = (from: number, to: number): void => {
    let offset = from;
    while (offset + 2 <= to) {
      const tag = dv.getUint8(offset);
      offset += 1;
      let length = 0;
      let lengthBytes = 0;
      while (offset < to && lengthBytes < 4) {
        const byte = dv.getUint8(offset);
        offset += 1;
        lengthBytes += 1;
        length = (length << 7) | (byte & 0x7f);
        if ((byte & 0x80) === 0) break;
      }
      const payloadStart = offset;
      const payloadEnd = Math.min(payloadStart + length, to);
      if (tag === 0x03) {
        // ES_Descriptor：ES_ID(2) + flags(1)，flags 的 streamDependence/URL/OCR 会追加字节
        const flags = payloadStart + 2 < payloadEnd ? dv.getUint8(payloadStart + 2) : 0;
        let inner = payloadStart + 3;
        if ((flags & 0x80) !== 0) inner += 2;
        if ((flags & 0x40) !== 0) {
          if (inner < payloadEnd) inner += 1 + dv.getUint8(inner);
        }
        if ((flags & 0x20) !== 0) inner += 2;
        walk(inner, payloadEnd);
      } else if (tag === 0x04) {
        // DecoderConfigDescriptor：objectTypeIndication + streamType 等 13 字节固定头
        if (payloadStart < payloadEnd) objectTypeIndication = dv.getUint8(payloadStart);
        walk(payloadStart + 13, payloadEnd);
      } else if (tag === 0x05) {
        asc = copyBytes(bytes, payloadStart, payloadEnd);
        if (asc.length > 0) {
          const first = asc[0] ?? 0;
          audioObjectType = (first >> 3) & 0x1f;
          if (audioObjectType === 31 && asc.length > 1) {
            const second = asc[1] ?? 0;
            audioObjectType = 32 + (((first & 0x07) << 3) | ((second >> 5) & 0x07));
          }
        }
        return;
      } else {
        walk(payloadStart, payloadEnd);
      }
      offset = payloadEnd;
    }
  };

  walk(start, end);
  const codec = objectTypeIndication === 0x40
    ? `mp4a.40.${audioObjectType}`
    : `mp4a.${hex2(objectTypeIndication)}`;
  return { codec, description: asc };
}

/** 解析视觉 sample entry（`avc1`/`hvc1`/…），子 box 从内容 +78 开始。 */
function parseVisualEntry(bytes: Uint8Array, box: BoxRange): VisualEntry {
  const dv = viewOf(bytes);
  const content = box.contentStart;
  if (content + 78 > box.boxEnd) {
    reject('E_DECODE_FAILED', '视觉 sample entry 结构不完整', `${box.type} @${box.boxStart}`);
  }
  const width = dv.getUint16(content + 24);
  const height = dv.getUint16(content + 26);
  let description: Uint8Array | null = null;
  let codec = box.type;
  for (const child of iterBoxes(dv, content + 78, box.boxEnd)) {
    if (child.type === 'avcC' || child.type === 'hvcC' || child.type === 'vpcC' || child.type === 'av1C') {
      description = copyBytes(bytes, child.contentStart, child.boxEnd);
      if (child.type === 'avcC') codec = formatAvcCodec(box.type, description);
      else if (child.type === 'hvcC') codec = formatHevcCodec(box.type, description);
      else if (child.type === 'vpcC') codec = formatVp9Codec(box.type, description);
      else codec = formatAv1Codec(box.type, description);
    }
    // 加密素材一定带 sinf（即使 sample entry 类型伪装成 avc1）
    if (child.type === 'sinf') {
      reject('E_UNSUPPORTED_VARIANT', '加密素材无法解码', `${box.type} 内含 sinf`);
    }
  }
  return { kind: 'video', format: box.type, width, height, codec, description };
}

/** 解析音频 sample entry（`mp4a` 等），子 box 偏移随 QuickTime sound version 变化。 */
function parseAudioEntry(bytes: Uint8Array, box: BoxRange): AudioEntry {
  const dv = viewOf(bytes);
  const content = box.contentStart;
  if (content + 28 > box.boxEnd) {
    reject('E_DECODE_FAILED', '音频 sample entry 结构不完整', `${box.type} @${box.boxStart}`);
  }
  const soundVersion = dv.getUint16(content + 8);
  const channelCount = dv.getUint16(content + 16);
  const sampleRate = dv.getUint32(content + 24) >>> 16;
  // QuickTime v1 追加 16 字节、v2 追加 36 字节
  const childStart = content + (soundVersion === 1 ? 44 : soundVersion === 2 ? 64 : 28);
  let codec = box.type === 'mp4a' ? 'mp4a.40.2' : box.type.trim();
  let description: Uint8Array | null = null;
  if (childStart < box.boxEnd) {
    for (const child of iterBoxes(dv, childStart, box.boxEnd)) {
      if (child.type === 'sinf') {
        reject('E_UNSUPPORTED_VARIANT', '加密素材无法解码', `${box.type} 内含 sinf`);
      }
      if (child.type === 'esds') {
        // esds：version/flags(4) 之后才是 ES_Descriptor
        const parsed = parseEsds(bytes, child.contentStart + 4, child.boxEnd);
        codec = parsed.codec;
        description = parsed.description;
      }
    }
  }
  // **声道数以 AudioSpecificConfig 为准**：微信/部分安卓相机在 stsd 的 channelcount 里
  // 一律写 2，而真实 AAC 流是单声道（实测微信视频：stsd=2、ffprobe=1）。
  // 信错会让预览把单声道复制成双声道（音量 +3dB、pcmBytes 翻倍），诊断信息也会误导。
  const ascChannels = description === null ? null : channelCountFromAsc(description);
  return {
    kind: 'audio',
    format: box.type,
    channelCount: ascChannels ?? channelCount,
    sampleRate,
    codec,
    description,
  };
}

/**
 * 从 AudioSpecificConfig 读 `channelConfiguration`（ASC 第 2 个字节的高 4 位）。
 *
 * 布局：audioObjectType(5bit) + samplingFrequencyIndex(4bit) + channelConfiguration(4bit)…
 * 只处理 objectType ≠ 31 的常见情况（AAC-LC/HE-AAC 都是 2）。
 * 返回值 1..7 有效，0 表示"由程序决定"（此时返回 null，让调用方退回 stsd）。
 */
function channelCountFromAsc(asc: Uint8Array): number | null {
  if (asc.length < 2) return null;
  const first = asc[0] ?? 0;
  const second = asc[1] ?? 0;
  const objectType = first >> 3;
  if (objectType === 31) return null; // 转义写法：布局不同，不猜
  // 位序：[objectType 5][freqIndex 4][channels 4][…]
  const freqIndex = ((first & 0x07) << 1) | (second >> 7);
  if (freqIndex === 15) return null; // 显式采样率会多 24 位，后面全错位
  const channels = (second >> 3) & 0x0f;
  return channels >= 1 && channels <= 7 ? channels : null;
}

/** 解析 `stsd`：多 sample entry / 加密变体在此拒绝（架构 §8.5）。 */
function parseStsd(bytes: Uint8Array, box: BoxRange): SampleEntry {
  const dv = viewOf(bytes);
  if (box.contentStart + 8 > box.boxEnd) {
    reject('E_DECODE_FAILED', 'stsd 结构不完整');
  }
  const entryCount = dv.getUint32(box.contentStart + 4);
  if (entryCount === 0) {
    reject('E_DECODE_FAILED', 'stsd 无 sample entry');
  }
  if (entryCount > 1) {
    reject('E_UNSUPPORTED_VARIANT', '多 sample entry 素材暂不支持', `stsd.entry_count=${entryCount}`);
  }
  const firstEntry = iterBoxes(dv, box.contentStart + 8, box.boxEnd).next();
  if (firstEntry.done === true) {
    reject('E_DECODE_FAILED', 'stsd 未找到 sample entry');
  }
  const entry = firstEntry.value;
  if (ENCRYPTED_FORMATS.has(entry.type)) {
    reject('E_UNSUPPORTED_VARIANT', '加密素材无法解码', `sample entry=${entry.type}`);
  }
  if (VISUAL_FORMATS.has(entry.type)) return parseVisualEntry(bytes, entry);
  if (AUDIO_FORMATS.has(entry.type)) return parseAudioEntry(bytes, entry);
  reject('E_UNSUPPORTED_VARIANT', '不支持的 sample entry 类型', `sample entry=${entry.type}`);
}

/* ---------- 轨道表 ---------- */

interface SttsEntry {
  count: number;
  delta: number;
}

interface CttsEntry {
  count: number;
  offset: number;
}

interface StscEntry {
  firstChunk: number;
  samplesPerChunk: number;
}

interface TrackTables {
  handler: string;
  timescale: number;
  durationTicks: number;
  entry: SampleEntry | null;
  stts: SttsEntry[];
  ctts: CttsEntry[] | null;
  /** 1 起的**解码顺序**样本号（stss 语义），null = 无 stss（全关键帧）。 */
  stss: number[] | null;
  stsc: StscEntry[];
  chunkOffsets: number[];
  sampleSizes: Uint32Array | null;
  uniformSize: number;
  sampleCount: number;
  /** `edts/elst` 首段的 media_time（timescale tick）；null = 无 edts 或为 -1（空编辑）。 */
  editMediaTimeTicks: number | null;
  /** `tkhd` 变换矩阵推出的顺时针显示旋转（0/90/180/270）。手机竖拍视频靠这个。 */
  rotation: number;
}

/**
 * 从 `tkhd` 的变换矩阵推出显示旋转（0/90/180/270，顺时针）。
 *
 * 矩阵是 9 个 32 位定点数（前 4 个 16.16，后 2 个 2.30）。只看左上 2×2：
 * `[a b; c d]`，旋转角 = atan2(b, a)。手机竖拍视频通常是 90 或 270。
 *
 * **为什么必须处理**：WebCodecs 不做旋转，解码出来是存储朝向（横的）；
 * 不应用这个矩阵，竖屏视频就会横躺着显示，且素材宽高比也是错的。
 */
function parseTkhdRotation(dv: DataView, box: BoxRange): number {
  const version = dv.getUint8(box.contentStart);
  // v0: matrix 在 content 偏移 40；v1（64 位时间字段）在 52
  const matrixOffset = box.contentStart + (version === 1 ? 52 : 40);
  if (matrixOffset + 36 > box.boxEnd) return 0;
  const a = dv.getInt32(matrixOffset) / 65536;
  const b = dv.getInt32(matrixOffset + 4) / 65536;
  if (Math.abs(a) < 1e-6 && Math.abs(b) < 1e-6) return 0;
  const degrees = Math.round((Math.atan2(b, a) * 180) / Math.PI);
  return ((degrees % 360) + 360) % 360;
}

/** 解析 `mdhd`：取 timescale 与 duration（v0 32 位 / v1 64 位）。 */
function parseMdhd(dv: DataView, box: BoxRange): { timescale: number; durationTicks: number } {
  const version = dv.getUint8(box.contentStart);
  const base = box.contentStart;
  if (version === 1) {
    return {
      timescale: dv.getUint32(base + 20),
      durationTicks: Number(dv.getBigUint64(base + 24)),
    };
  }
  return {
    timescale: dv.getUint32(base + 12),
    durationTicks: dv.getUint32(base + 16),
  };
}

/** 解析 `stts`（decoding time to sample）。 */
function parseStts(dv: DataView, box: BoxRange): SttsEntry[] {
  const entryCount = dv.getUint32(box.contentStart + 4);
  const entries: SttsEntry[] = [];
  const limit = Math.min(entryCount, Math.floor((box.boxEnd - box.contentStart - 8) / 8));
  for (let i = 0; i < limit; i += 1) {
    const at = box.contentStart + 8 + i * 8;
    entries.push({ count: dv.getUint32(at), delta: dv.getUint32(at + 4) });
  }
  return entries;
}

/** 解析 `ctts`（composition time to sample）；version 1 的 offset 是有符号数。 */
function parseCtts(dv: DataView, box: BoxRange): CttsEntry[] {
  const version = dv.getUint8(box.contentStart);
  const entryCount = dv.getUint32(box.contentStart + 4);
  const entries: CttsEntry[] = [];
  const limit = Math.min(entryCount, Math.floor((box.boxEnd - box.contentStart - 8) / 8));
  for (let i = 0; i < limit; i += 1) {
    const at = box.contentStart + 8 + i * 8;
    entries.push({
      count: dv.getUint32(at),
      offset: version === 1 ? dv.getInt32(at + 4) : dv.getUint32(at + 4),
    });
  }
  return entries;
}

/** 解析 `stss`（sync sample table），返回 1 起解码顺序样本号。 */
function parseStss(dv: DataView, box: BoxRange): number[] {
  const entryCount = dv.getUint32(box.contentStart + 4);
  const limit = Math.min(entryCount, Math.floor((box.boxEnd - box.contentStart - 4) / 4));
  const numbers: number[] = [];
  for (let i = 0; i < limit; i += 1) {
    numbers.push(dv.getUint32(box.contentStart + 8 + i * 4));
  }
  return numbers;
}

/** 解析 `stsc`（sample to chunk）。 */
function parseStsc(dv: DataView, box: BoxRange): StscEntry[] {
  const entryCount = dv.getUint32(box.contentStart + 4);
  const entries: StscEntry[] = [];
  const limit = Math.min(entryCount, Math.floor((box.boxEnd - box.contentStart - 8) / 12));
  for (let i = 0; i < limit; i += 1) {
    const at = box.contentStart + 8 + i * 12;
    entries.push({
      firstChunk: dv.getUint32(at),
      samplesPerChunk: dv.getUint32(at + 4),
    });
  }
  return entries;
}

/** 解析 `stco` / `co64`（chunk offset）。 */
function parseChunkOffsets(dv: DataView, box: BoxRange): number[] {
  const entryCount = dv.getUint32(box.contentStart + 4);
  const offsets: number[] = [];
  if (box.type === 'co64') {
    const limit = Math.min(entryCount, Math.floor((box.boxEnd - box.contentStart - 8) / 8));
    for (let i = 0; i < limit; i += 1) {
      offsets.push(Number(dv.getBigUint64(box.contentStart + 8 + i * 8)));
    }
    return offsets;
  }
  const limit = Math.min(entryCount, Math.floor((box.boxEnd - box.contentStart - 8) / 4));
  for (let i = 0; i < limit; i += 1) {
    offsets.push(dv.getUint32(box.contentStart + 8 + i * 4));
  }
  return offsets;
}

/** 解析 `stsz`：`sample_size !== 0` 表示所有样本同尺寸。 */
function parseStsz(dv: DataView, box: BoxRange): { sizes: Uint32Array | null; uniformSize: number; sampleCount: number } {
  const uniformSize = dv.getUint32(box.contentStart + 4);
  const sampleCount = dv.getUint32(box.contentStart + 8);
  if (uniformSize !== 0) return { sizes: null, uniformSize, sampleCount };
  const limit = Math.min(sampleCount, Math.floor((box.boxEnd - box.contentStart - 12) / 4));
  const sizes = new Uint32Array(limit);
  for (let i = 0; i < limit; i += 1) {
    sizes[i] = dv.getUint32(box.contentStart + 12 + i * 4);
  }
  return { sizes, uniformSize: 0, sampleCount: limit };
}

/** 解析单个 `trak`（只取 M2 需要的字段）。 */
function parseTrak(bytes: Uint8Array, dv: DataView, trak: BoxRange): TrackTables {
  let handler = '';
  let timescale = 0;
  let durationTicks = 0;
  let entry: SampleEntry | null = null;
  let stts: SttsEntry[] = [];
  let ctts: CttsEntry[] | null = null;
  let stss: number[] | null = null;
  let stsc: StscEntry[] = [];
  let chunkOffsets: number[] = [];
  let sampleSizes: Uint32Array | null = null;
  let uniformSize = 0;
  let sampleCount = 0;
  let editMediaTimeTicks: number | null = null;
  let rotation = 0;

  // tkhd 的变换矩阵：手机竖拍视频的真实朝向靠它（存储仍是横的 1920×1080）
  const tkhd = findBox(dv, trak.contentStart, trak.boxEnd, 'tkhd');
  if (tkhd !== null) rotation = parseTkhdRotation(dv, tkhd);

  // edts/elst：首段 media_time（音频/视频的呈现起点；B 帧素材通常 = 重排延迟）
  const edts = findBox(dv, trak.contentStart, trak.boxEnd, 'edts');
  if (edts !== null) {
    const elst = findBox(dv, edts.contentStart, edts.boxEnd, 'elst');
    if (elst !== null) {
      const version = dv.getUint8(elst.contentStart);
      const entryCount = dv.getUint32(elst.contentStart + 4);
      if (entryCount > 0) {
        const at = elst.contentStart + 8;
        if (version === 1) {
          const mediaTime = at + 8 + 8 <= elst.boxEnd ? Number(dv.getBigInt64(at + 8)) : -1;
          editMediaTimeTicks = mediaTime >= 0 ? mediaTime : null;
        } else {
          const mediaTime = at + 4 + 4 <= elst.boxEnd ? dv.getInt32(at + 4) : -1;
          editMediaTimeTicks = mediaTime >= 0 ? mediaTime : null;
        }
      }
    }
  }

  const mdia = findBox(dv, trak.contentStart, trak.boxEnd, 'mdia');
  if (mdia === null) return { handler, timescale, durationTicks, entry, stts, ctts, stss, stsc, chunkOffsets, sampleSizes, uniformSize, sampleCount, editMediaTimeTicks, rotation };

  for (const child of iterBoxes(dv, mdia.contentStart, mdia.boxEnd)) {
    if (child.type === 'mdhd') {
      const parsed = parseMdhd(dv, child);
      timescale = parsed.timescale;
      durationTicks = parsed.durationTicks;
    } else if (child.type === 'hdlr') {
      handler = readAscii(dv, child.contentStart + 8, 4);
    }
  }

  for (const child of iterBoxes(dv, mdia.contentStart, mdia.boxEnd)) {
    if (child.type !== 'minf') continue;
    const stbl = findBox(dv, child.contentStart, child.boxEnd, 'stbl');
    if (stbl === null) continue;
    for (const table of iterBoxes(dv, stbl.contentStart, stbl.boxEnd)) {
      switch (table.type) {
        case 'stsd':
          entry = parseStsd(bytes, table);
          break;
        case 'stts':
          stts = parseStts(dv, table);
          break;
        case 'ctts':
          ctts = parseCtts(dv, table);
          break;
        case 'stss':
          stss = parseStss(dv, table);
          break;
        case 'stsc':
          stsc = parseStsc(dv, table);
          break;
        case 'stco':
        case 'co64':
          chunkOffsets = parseChunkOffsets(dv, table);
          break;
        case 'stsz': {
          const parsed = parseStsz(dv, table);
          sampleSizes = parsed.sizes;
          uniformSize = parsed.uniformSize;
          sampleCount = parsed.sampleCount;
          break;
        }
        default:
          break;
      }
    }
  }

  if (stts.length === 0) {
    reject('E_DECODE_FAILED', 'stts 缺失，无法构建样本时间戳', `handler=${handler}`);
  }
  const sttsTotal = stts.reduce((sum, item) => sum + item.count, 0);
  if (sampleCount === 0) sampleCount = sttsTotal;
  if (sttsTotal !== sampleCount) {
    reject(
      'E_DECODE_FAILED',
      'stts 与 stsz 样本数不一致（拒绝返回半成品索引）',
      `stts=${sttsTotal} stsz=${sampleCount} handler=${handler}`,
    );
  }

  return { handler, timescale, durationTicks, entry, stts, ctts, stss, stsc, chunkOffsets, sampleSizes, uniformSize, sampleCount, editMediaTimeTicks, rotation };
}

/* ---------- 样本索引构建 ---------- */

interface BuiltIndex {
  samples: SampleIndexEntry[];
  /** presentation order 中的关键帧序号。 */
  keyframeIndex: number[];
  hasBFrames: boolean;
  maxCttsOffset: number;
}

/**
 * 构建样本索引（架构 §8.2）。
 *
 * 步骤：
 *   1. `stsz` + `stsc` + `stco/co64` → 每个样本的文件偏移与长度；
 *   2. `stts` 累加 → DTS（解码顺序）；`ctts` → composition offset；
 *   3. `pts = dts + cttsOffset`，按 PTS 升序重排为 **presentation order**，
 *      `index` 即素材帧号 S（`dtsUs` / `ptsUs` 各自独立保存，禁止互相覆盖）。
 */
function buildIndex(tables: TrackTables): BuiltIndex {
  const count = tables.sampleCount;
  const sizes = new Uint32Array(count);
  if (tables.uniformSize > 0) {
    sizes.fill(tables.uniformSize);
  } else if (tables.sampleSizes !== null) {
    if (tables.sampleSizes.length < count) {
      reject('E_DECODE_FAILED', 'stsz 样本数不足', `${tables.sampleSizes.length} < ${count}`);
    }
    sizes.set(tables.sampleSizes.subarray(0, count));
  } else {
    reject('E_DECODE_FAILED', 'stsz 缺失');
  }

  const offsets = new Float64Array(count);
  if (tables.chunkOffsets.length === 0 || tables.stsc.length === 0) {
    reject('E_DECODE_FAILED', 'stco/stsc 缺失，无法定位样本', `chunks=${tables.chunkOffsets.length}`);
  }
  {
    let sampleCursor = 0;
    let stscCursor = 0;
    for (let chunkIndex = 1; chunkIndex <= tables.chunkOffsets.length; chunkIndex += 1) {
      while (
        stscCursor + 1 < tables.stsc.length &&
        (tables.stsc[stscCursor + 1]?.firstChunk ?? Number.POSITIVE_INFINITY) <= chunkIndex
      ) {
        stscCursor += 1;
      }
      const perChunk = tables.stsc[stscCursor]?.samplesPerChunk ?? 0;
      const chunkOffset = tables.chunkOffsets[chunkIndex - 1] ?? 0;
      let cursor = chunkOffset;
      for (let k = 0; k < perChunk && sampleCursor < count; k += 1) {
        offsets[sampleCursor] = cursor;
        cursor += sizes[sampleCursor] ?? 0;
        sampleCursor += 1;
      }
      if (sampleCursor >= count) break;
    }
    if (sampleCursor !== count) {
      reject(
        'E_DECODE_FAILED',
        'stsc/stco 与样本数不自洽（拒绝返回半成品索引）',
        `覆盖 ${sampleCursor}/${count} 个样本`,
      );
    }
  }

  // DTS：stts 累加（**禁止假设 delta === 1**）
  const dtsTicks = new Float64Array(count);
  {
    let cursor = 0;
    let accumulated = 0;
    for (const entry of tables.stts) {
      for (let i = 0; i < entry.count && cursor < count; i += 1) {
        dtsTicks[cursor] = accumulated;
        accumulated += entry.delta;
        cursor += 1;
      }
      if (cursor >= count) break;
    }
  }

  // composition offset：ctts（run-length），缺失样本按 0 补齐
  const cttsOffsets = new Float64Array(count);
  let maxCttsOffset = 0;
  if (tables.ctts !== null) {
    let cursor = 0;
    for (const entry of tables.ctts) {
      for (let i = 0; i < entry.count && cursor < count; i += 1) {
        cttsOffsets[cursor] = entry.offset;
        if (entry.offset > maxCttsOffset) maxCttsOffset = entry.offset;
        cursor += 1;
      }
      if (cursor >= count) break;
    }
  }

  const ptsTicks = new Float64Array(count);
  let minPtsTicks = Number.POSITIVE_INFINITY;
  for (let i = 0; i < count; i += 1) {
    const pts = (dtsTicks[i] ?? 0) + (cttsOffsets[i] ?? 0);
    ptsTicks[i] = pts;
    if (pts < minPtsTicks) minPtsTicks = pts;
  }
  if (!Number.isFinite(minPtsTicks)) minPtsTicks = 0;

  // 关键帧集合（stss 语义：1 起、解码顺序）
  const isKey = new Uint8Array(count);
  if (tables.stss === null) {
    isKey.fill(1); // 无 stss ⇒ 全关键帧（ISO 14496-12）
  } else {
    for (const number of tables.stss) {
      const decodeIndex = number - 1;
      if (decodeIndex >= 0 && decodeIndex < count) isKey[decodeIndex] = 1;
    }
  }

  // presentation order：按 PTS 升序（同 PTS 用 DTS、再用解码序号稳定排序）
  const order = new Int32Array(count);
  for (let i = 0; i < count; i += 1) order[i] = i;
  const sorted = Array.from(order).sort((a, b) => {
    const ptsDelta = (ptsTicks[a] ?? 0) - (ptsTicks[b] ?? 0);
    if (ptsDelta !== 0) return ptsDelta;
    const dtsDelta = (dtsTicks[a] ?? 0) - (dtsTicks[b] ?? 0);
    if (dtsDelta !== 0) return dtsDelta;
    return a - b;
  });

  const timescale = tables.timescale;
  const samples: SampleIndexEntry[] = new Array(count);
  const keyframeIndex: number[] = [];
  for (let presentation = 0; presentation < count; presentation += 1) {
    const decode = sorted[presentation] ?? 0;
    const key = isKey[decode] === 1;
    samples[presentation] = {
      index: presentation,
      offset: offsets[decode] ?? 0,
      size: sizes[decode] ?? 0,
      // 时间戳以最小呈现时间为原点归一（fixtures 实测 min === 0，此处仅防御非零起点）
      dtsUs: ticksToUs((dtsTicks[decode] ?? 0) - minPtsTicks, timescale),
      ptsUs: ticksToUs((ptsTicks[decode] ?? 0) - minPtsTicks, timescale),
      isKey: key,
    };
    if (key) keyframeIndex.push(presentation);
  }

  return { samples, keyframeIndex, hasBFrames: maxCttsOffset > 0, maxCttsOffset };
}

/* ---------- 探测结果 ---------- */

/** 视频轨附加信息（供 task:T06/T10 配置解码器；不进入 `MediaProbeResult` 契约）。 */
export interface Mp4VideoTrackInfo {
  codec: string;
  width: number;
  height: number;
  timescale: number;
  sampleCount: number;
  /** `avcC` / `hvcC` 记录字节，直接作为 `VideoDecoderConfig.description`。 */
  description: Uint8Array | null;
  hasBFrames: boolean;
  keyframeCount: number;
  /** `tkhd` 变换矩阵推出的显示旋转（0/90/180/270）。0 = 无需旋转。 */
  rotation: number;
  /**
   * `edts/elst` 首段 media_time（timescale tick）；null = 无 edts。
   *
   * 仅供诊断与 task:T09 校验用：B 帧素材的 media_time 通常等于重排延迟
   * （fixtures 实测 30fps/24fps = 1024、60fps = 512，恰为 2 帧），
   * 与 `samples[0].ptsUs === 0` 的归一化基准一致。
   */
  editMediaTimeTicks: number | null;
}

/** 音频轨附加信息（供 task:T10）。 */
export interface Mp4AudioTrackInfo {
  codec: string;
  sampleRate: number;
  channels: number;
  timescale: number;
  sampleCount: number;
  /** AAC 的 AudioSpecificConfig。 */
  description: Uint8Array | null;
  /**
   * 音频样本索引（解码顺序，AAC 帧粒度；`isKey` 对音频无意义）。
   *
   * 与 `MediaProbeResult.samples`（视频 presentation order）**分开放**：
   * task:T10 的 audioEngine 需要按块取压缩帧，不能拿视频帧号去索引音频样本。
   */
  samples: SampleIndexEntry[];
}

/**
 * `openMp4()` 的返回类型：`MediaProbeResult` 的**超集**。
 *
 * 多出的字段（`video` / `audio` / `timescale` …）是解码器配置与 `Asset.durationSec` 所需，
 * 但架构 §4.1 的 `MediaProbeResult` 是跨容器公共契约（webm 不能承诺这些），
 * 因此只在 mp4 侧扩展，避免污染公共类型。
 */
export interface Mp4ProbeResult extends MediaProbeResult {
  container: 'mp4';
  timescale: number;
  durationTicks: number;
  /** 主轨（有视频取视频，否则音频）时长，仅用于 `Asset.durationSec` 校验字段。 */
  durationSec: number;
  video: Mp4VideoTrackInfo | null;
  audio: Mp4AudioTrackInfo | null;
}

/** 由 `moov` 字节构建探测结果。 */
function buildProbeResult(moovBytes: Uint8Array): Mp4ProbeResult {
  const dv = viewOf(moovBytes);
  const moovBox = [...iterBoxes(dv, 0, moovBytes.length)].find((box) => box.type === 'moov') ?? null;
  if (moovBox === null) {
    reject('E_DECODE_FAILED', 'moov 解析失败');
  }

  const tracks: TrackTables[] = [];
  for (const child of iterBoxes(dv, moovBox.contentStart, moovBox.boxEnd)) {
    if (child.type === 'trak') tracks.push(parseTrak(moovBytes, dv, child));
  }
  if (tracks.length === 0) {
    reject('E_DECODE_FAILED', 'moov 内没有 trak');
  }

  const videoTrack = tracks.find((track) => track.handler === 'vide') ?? null;
  const audioTrack = tracks.find((track) => track.handler === 'soun') ?? null;
  if (videoTrack === null && audioTrack === null) {
    reject('E_UNSUPPORTED_VARIANT', '素材既无视频轨也无音频轨', `handlers=${tracks.map((t) => t.handler).join(',')}`);
  }

  let video: Mp4VideoTrackInfo | null = null;
  let videoSamples: SampleIndexEntry[] = [];
  let keyframeIndex: number[] = [];
  let fpsMilli: MilliFps | null = null;

  if (videoTrack !== null) {
    const entry = videoTrack.entry;
    if (entry === null || entry.kind !== 'video') {
      reject('E_DECODE_FAILED', '视频轨缺少可用的 sample entry');
    }
    if (videoTrack.timescale <= 0) {
      reject('E_DECODE_FAILED', '视频轨 mdhd.timescale 非法', `timescale=${videoTrack.timescale}`);
    }
    const built = buildIndex(videoTrack);
    videoSamples = built.samples;
    keyframeIndex = built.keyframeIndex;
    const totalDeltaTicks = videoTrack.stts.reduce((sum, item) => sum + item.count * item.delta, 0);
    // 平均帧率（VFR 时即平均）：sampleCount * timescale * 1000 / 累计 ticks，四舍五入到毫帧率
    fpsMilli = totalDeltaTicks > 0
      ? Math.round((videoTrack.sampleCount * videoTrack.timescale * MILLI_PER_SECOND) / totalDeltaTicks)
      : null;
    video = {
      codec: entry.codec,
      width: entry.width,
      height: entry.height,
      timescale: videoTrack.timescale,
      sampleCount: videoTrack.sampleCount,
      description: entry.description,
      hasBFrames: built.hasBFrames,
      keyframeCount: built.keyframeIndex.length,
      editMediaTimeTicks: videoTrack.editMediaTimeTicks,
      rotation: videoTrack.rotation,
    };
  }

  let audio: Mp4AudioTrackInfo | null = null;
  let audioSamples: SampleIndexEntry[] = [];
  if (audioTrack !== null) {
    const entry = audioTrack.entry;
    if (entry === null || entry.kind !== 'audio') {
      reject('E_DECODE_FAILED', '音频轨缺少可用的 sample entry');
    }
    const built = buildIndex(audioTrack);
    audioSamples = built.samples;
    audio = {
      codec: entry.codec,
      sampleRate: entry.sampleRate,
      channels: entry.channelCount,
      timescale: audioTrack.timescale,
      sampleCount: audioTrack.sampleCount,
      description: entry.description,
      samples: audioSamples,
    };
  }

  // 样本索引与素材帧号 1:1 → 有视频时只暴露视频样本（音频由 audioEngine 单独按块解）
  const samples = video !== null ? videoSamples : audioSamples;
  const primaryTrack = videoTrack ?? audioTrack;
  if (primaryTrack === null || primaryTrack.timescale <= 0) {
    reject('E_DECODE_FAILED', '主轨 timescale 非法');
  }

  return {
    container: 'mp4',
    hasVideo: video !== null,
    hasAudio: audio !== null,
    width: video === null ? null : video.width,
    height: video === null ? null : video.height,
    fpsMilli,
    durationFrames: video === null ? null : videoSamples.length,
    // 纯音频没有画面可 seek，`keyframeIndex` 按规格返回 []（不是 null）
    videoCodec: video === null ? null : video.codec,
    audioCodec: audio === null ? null : audio.codec,
    sampleRate: audio === null ? null : audio.sampleRate,
    channels: audio === null ? null : audio.channels,
    keyframeIndex: video === null ? [] : keyframeIndex,
    samples,
    exactSeek: true,
    needsIndexScan: false,
    timescale: primaryTrack.timescale,
    durationTicks: primaryTrack.durationTicks,
    durationSec: primaryTrack.durationTicks / primaryTrack.timescale,
    video,
    audio,
  };
}

/* ---------- 公共 API ---------- */

/** EBML 魔数（webm / mkv）。 */
function isEbml(head: Uint8Array): boolean {
  return head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
}

/**
 * 打开 mp4 / mov 并返回探测结果 + 完整样本索引。
 *
 * **不抛异常**：任何失败都返回 `{ ok: false }`（架构 §8.5 硬约束 ②）。
 * `mdat` 内容不读入内存（架构 §8.5 / T05 ⑦）。
 */
export async function openMp4(source: BlobLike): Promise<Result<Mp4ProbeResult>> {
  try {
    const head = await readBytes(source, 0, Math.min(source.size, 16));
    if (isEbml(head)) {
      reject('E_UNSUPPORTED_CONTAINER', '暂不支持该容器', 'WebM 支持将在 T19 提供');
    }
    const boxes = await scanTopLevelBoxes(source);
    if (boxes.length === 0) {
      reject('E_UNSUPPORTED_CONTAINER', '暂不支持该容器，请转为 mp4 或 webm', '文件头不足 8 字节');
    }
    const firstType = boxes[0]?.type ?? '';
    const hasMoov = boxes.some((box) => box.type === 'moov');
    if (!PREAMBLE_BOXES.has(firstType) && !hasMoov) {
      reject('E_UNSUPPORTED_CONTAINER', '暂不支持该容器，请转为 mp4 或 webm', `首个 box: ${firstType}`);
    }
    const fragmented = boxes.find((box) => box.type === 'moof' || box.type === 'mfra');
    if (fragmented !== undefined) {
      reject(
        'E_UNSUPPORTED_VARIANT',
        'fragmented mp4 (moof) 暂不支持，请用非分片 mp4',
        `检测到 ${fragmented.type} @${fragmented.offset}`,
      );
    }
    const moov = boxes.find((box) => box.type === 'moov');
    if (moov === undefined) {
      reject('E_DECODE_FAILED', '未找到 moov（文件可能被截断）', `顶层 box: ${boxes.map((b) => b.type).join(',')}`);
    }
    if (moov.truncated || moov.size < moov.headerSize) {
      reject('E_DECODE_FAILED', 'moov 被截断');
    }
    if (moov.size > MAX_MOOV_BYTES) {
      reject('E_UNSUPPORTED_VARIANT', 'moov 过大，疑似异常变体', `size=${moov.size}`);
    }
    const moovBytes = await readBytes(source, moov.offset, moov.offset + moov.size);
    if (moovBytes.length < moov.size) {
      reject('E_DECODE_FAILED', 'moov 读取不完整', `${moovBytes.length}/${moov.size}`);
    }
    return { ok: true, value: buildProbeResult(moovBytes) };
  } catch (error) {
    if (error instanceof DemuxRejection) {
      return { ok: false, error: error.toEditorError() };
    }
    return {
      ok: false,
      error: makeError(
        'E_DECODE_FAILED',
        'mp4 解析失败',
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
}

/**
 * 按样本索引读取原始样本字节（喂 `EncodedVideoChunk` 用）。
 *
 * 只 slice 该样本的区间，不整片读取。
 */
export async function readSample(source: BlobLike, sample: SampleIndexEntry): Promise<Uint8Array> {
  return readBytes(source, sample.offset, sample.offset + sample.size);
}

/**
 * 按需读取任意区间字节（容器嗅探 / 缩略图取首样本复用，**不整片读入**）。
 *
 * 放在此处而不是新开 `utils/`：目录规范禁止泛工具目录（架构 §3）。
 */
export async function readBlobBytes(source: BlobLike, start: number, end: number): Promise<Uint8Array> {
  return readBytes(source, start, end);
}
