/**
 * MP3 容器解析（纯音频导入，W2）。
 *
 * ## 职责边界
 *
 * MP3 没有容器索引——本模块**全量读入字节**逐帧扫描建索引（与 `demuxWebm` 的
 * needsIndexScan 全量扫描同口径；MP3 文件几 MB 级，内存可接受）：
 *
 * 1. 跳过 `ID3v2` 头（syncsafe 大小）；
 * 2. 从首个同步字（0xFFE）开始逐帧解析：版本/层/码率/采样率/padding → 帧长；
 * 3. 每帧一条样本索引（Layer3 每帧 1152/576 采样），`ptsUs` 按采样数累计（timebase）；
 * 4. **容错截断**：同步字丢失/非法头 → 逐字节前进重新找同步字（丢弃字节计入
 *    `droppedBytes`），不中断导入；整份文件解析出的帧数为 0 才报错；
 * 5. 解码**完全走现有 AudioSession**（codec `'mp3'`，Chrome/Edge/WebView2 的
 *    `AudioDecoder` 原生支持）——decoderPool 零改动；解码失败给可读中文报错（用户拍板）。
 *
 * VBR 天然支持：帧长逐帧按各自头计算，不假设码率恒定。
 * 本模块全部为纯解析，Node 可直接单测。
 */
import type { Frame, Result, SampleIndexEntry } from '../core/types';
import { makeError } from '../core/types';
import { samplesToUs } from '../core/timebase';
import type { BlobLike } from './demuxMp4';
import { readBlobBytes } from './demuxMp4';

export interface Mp3AudioInfo {
  codec: 'mp3';
  sampleRate: number;
  channels: number;
  /** 兼容 Mp4AudioTrackInfo 的形状（timescale 对音频 = sampleRate）。 */
  timescale: number;
  sampleCount: number;
  description: null;
  samples: SampleIndexEntry[];
  /** 同步字丢失时丢弃的字节数（诊断用；正常文件为 0）。 */
  droppedBytes: number;
}

export interface Mp3ProbeResult {
  container: 'mp3';
  hasVideo: false;
  hasAudio: true;
  width: null;
  height: null;
  fpsMilli: null;
  /** 素材时基帧数（DEFAULT_FPS_MILLI 时基；与 WAV 同口径）。 */
  durationFrames: Frame;
  videoCodec: null;
  audioCodec: 'mp3';
  sampleRate: number;
  channels: number;
  keyframeIndex: [];
  samples: [];
  exactSeek: true;
  needsIndexScan: false;
  durationSec: number;
  audio: Mp3AudioInfo;
  timescale: number;
  durationTicks: number;
}

/** Layer3 码率表（kbps）：index 0 = free，15 = bad。 */
const BITRATES: Record<number, number[]> = {
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // MPEG1
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // MPEG2
  0: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // MPEG2.5
};

/** 采样率表（versionBits → 三档）。 */
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000], // MPEG2.5
};

/** Layer3 每帧采样数（MPEG1 = 1152，MPEG2/2.5 = 576）。 */
const SAMPLES_PER_FRAME: Record<number, number> = { 3: 1152, 2: 576, 0: 576 };

interface Mp3FrameHeader {
  frameLength: number;
  samplesPerFrame: number;
  sampleRate: number;
  channels: number;
}

/** 解析 4 字节帧头；非法（保留版本/保留层/保留码率/保留采样率/非法帧长）返回 null。 */
export function parseMp3FrameHeader(bytes: Uint8Array, offset: number): Mp3FrameHeader | null {
  if (offset + 4 > bytes.byteLength) return null;
  const b1 = bytes[offset] ?? 0;
  const b2 = bytes[offset + 1] ?? 0;
  const b3 = bytes[offset + 2] ?? 0;
  if (b1 !== 0xff || (b2 & 0xe0) !== 0xe0) return null; // 11 位同步字
  const versionBits = (b2 >> 3) & 0x03; // 11=MPEG1 10=MPEG2 00=MPEG2.5
  if (versionBits === 1) return null; // 保留
  const layerBits = (b2 >> 1) & 0x03;
  if (layerBits !== 1) return null; // 只支持 Layer3（01 = Layer3）
  const bitrateIndex = (b3 >> 4) & 0x0f;
  if (bitrateIndex === 0 || bitrateIndex === 15) return null;
  const rateIndex = (b3 >> 2) & 0x03;
  if (rateIndex === 3) return null; // 保留
  const sampleRate = SAMPLE_RATES[versionBits]?.[rateIndex];
  if (sampleRate === undefined) return null;
  const bitrateKbps = BITRATES[versionBits]?.[bitrateIndex];
  if (bitrateKbps === undefined || bitrateKbps <= 0) return null;
  const padding = (b3 >> 1) & 0x01;
  const channelMode = (b3 >> 6) & 0x03;
  const samplesPerFrame = SAMPLES_PER_FRAME[versionBits] ?? 576;
  // Layer3 帧长系数：MPEG1 = 144，MPEG2/2.5 = 72（= 144/2，每帧样本数减半）
  const coefficient = versionBits === 3 ? 144 : 72;
  const frameLength = Math.floor((coefficient * bitrateKbps * 1000) / sampleRate) + padding;
  if (frameLength < 4) return null;
  return {
    frameLength,
    samplesPerFrame,
    sampleRate,
    channels: channelMode === 3 ? 1 : 2,
  };
}

/**
 * 打开 MP3：全量读入 → ID3 跳过 → 逐帧扫描建索引。
 *
 * 首帧的采样率/声道决定整个 probe（AudioDecoder 只 configure 一次；
 * 中途变采样率的文件本身就是损坏的，按容错丢弃处理）。
 */
export async function openMp3(source: BlobLike): Promise<Result<Mp3ProbeResult>> {
  const bytes = await readBlobBytes(source, 0, Number(source.size));
  if (bytes.byteLength < 4) {
    return { ok: false, error: makeError('E_UNSUPPORTED_CONTAINER', '不是有效的 MP3 文件（文件过小）') };
  }

  let offset = 0;
  // ID3v2：'ID3' + 2 字节版本 + 1 字节 flags + 4 字节 syncsafe 大小
  if (
    bytes.byteLength >= 10 &&
    (bytes[0] ?? 0) === 0x49 &&
    (bytes[1] ?? 0) === 0x44 &&
    (bytes[2] ?? 0) === 0x33
  ) {
    const size =
      ((bytes[6] ?? 0) << 21) | ((bytes[7] ?? 0) << 14) | ((bytes[8] ?? 0) << 7) | (bytes[9] ?? 0);
    offset = 10 + size;
  }

  let sampleRate = -1;
  let channels = -1;
  let totalSamples = 0;
  let droppedBytes = 0;
  const frames: Array<{ offset: number; size: number; sampleStart: number }> = [];

  while (offset + 4 <= bytes.byteLength) {
    const header = parseMp3FrameHeader(bytes, offset);
    if (header === null) {
      offset += 1; // 容错：丢 1 字节重新找同步字
      droppedBytes += 1;
      continue;
    }
    // **帧尾超出文件尾 = 截断损坏**：丢弃剩余字节并结束（解码时字节不足必然失败）
    if (offset + header.frameLength > bytes.byteLength) {
      droppedBytes += bytes.byteLength - offset;
      break;
    }
    if (sampleRate < 0) {
      // 首帧定基准
      sampleRate = header.sampleRate;
      channels = header.channels;
    } else if (header.sampleRate !== sampleRate) {
      // 中途变采样率 = 损坏流：丢字节容错（AudioDecoder 只 configure 一次）
      offset += 1;
      droppedBytes += 1;
      continue;
    }
    frames.push({ offset, size: header.frameLength, sampleStart: totalSamples });
    totalSamples += header.samplesPerFrame;
    offset += header.frameLength;
  }

  if (sampleRate < 0 || frames.length === 0) {
    return {
      ok: false,
      error: makeError(
        'E_UNSUPPORTED_CONTAINER',
        '不是有效的 MP3 文件（没有可解析的音频帧）',
        `droppedBytes=${droppedBytes}`,
      ),
    };
  }

  // 索引第二遍生成（首帧确定 sampleRate 后才能算 ptsUs）
  const samples: SampleIndexEntry[] = frames.map((frame, index) => ({
    index,
    offset: frame.offset,
    size: frame.size,
    dtsUs: samplesToUs(frame.sampleStart, sampleRate),
    ptsUs: samplesToUs(frame.sampleStart, sampleRate),
    isKey: true,
  }));

  const durationSec = totalSamples / sampleRate;
  const durationFrames: Frame = Math.max(1, Math.round(durationSec * 30));

  return {
    ok: true,
    value: {
      container: 'mp3',
      hasVideo: false,
      hasAudio: true,
      width: null,
      height: null,
      fpsMilli: null,
      durationFrames,
      videoCodec: null,
      audioCodec: 'mp3',
      sampleRate,
      channels,
      keyframeIndex: [],
      samples: [],
      exactSeek: true,
      needsIndexScan: false,
      durationSec,
      audio: {
        codec: 'mp3',
        sampleRate,
        channels,
        timescale: sampleRate,
        sampleCount: totalSamples,
        description: null,
        samples,
        droppedBytes,
      },
      timescale: sampleRate,
      durationTicks: totalSamples,
    },
  };
}
