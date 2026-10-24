/**
 * WAV 容器解析（纯音频导入，W1）。
 *
 * ## 职责边界
 *
 * 只做三件事：校验 RIFF/WAVE 结构、读 `fmt `/`data` 两个 chunk、按 **1 秒一块** 切样本索引。
 * 解码不做——PCM 是裸数据，`decoderPool.decodeAudioRange` 走 **PCM 直通**（按索引切字节
 * 直接构造 `AudioData`，见 `pcmChunkToPlanarF32`），不经过 AudioDecoder。
 *
 * ## 支持范围（用户拍板）
 *
 * - PCM 族：format 1（整数 PCM）与 3（IEEE float），bits 8/16/24/32；
 *   **WAVE_FORMAT_EXTENSIBLE（0xFFFE）按 SubFormat GUID 前 2 字节判定**（真实世界的
 *   24bit WAV 大多是 extensible 包装，不支持会把大部分专业 WAV 拒之门外）；
 * - 其余（ADPCM 6/7、µ-law 7 等）：**拒绝并给中文可读提示**（用户拍板的文案，见 openWav）。
 *
 * 本模块全部为纯解析（输入 BlobLike 只做分块读），Node 可直接单测。
 */
import type { Frame, Result, SampleIndexEntry } from '../core/types';
import { makeError } from '../core/types';
import { samplesToUs } from '../core/timebase';
import type { BlobLike } from './demuxMp4';
import { readBlobBytes } from './demuxMp4';

/** 非 PCM 的 WAV 拒绝文案（用户拍板的中文提示，不要改成技术术语）。 */
export const WAV_NON_PCM_MESSAGE = '该 WAV 文件为压缩格式，请转为 PCM 格式后再导入';

/** 波长 → codec 字符串（与 WebCodecs AudioDecoderConfig 的 PCM 命名一致，decoderPool 按前缀分流）。 */
export type WavPcmCodec = 'pcm-u8' | 'pcm-s16' | 'pcm-s24' | 'pcm-s32' | 'pcm-f32';

export interface WavAudioInfo {
  codec: WavPcmCodec;
  sampleRate: number;
  channels: number;
  /** 兼容 Mp4AudioTrackInfo 的形状（timescale 对音频 = sampleRate）。 */
  timescale: number;
  sampleCount: number;
  description: null;
  samples: SampleIndexEntry[];
}

export interface WavProbeResult {
  container: 'wav';
  hasVideo: false;
  hasAudio: true;
  width: null;
  height: null;
  fpsMilli: null;
  /** 素材时基帧数（DEFAULT_FPS_MILLI 时基；WAV 无视频帧，按秒×30 取整）。 */
  durationFrames: Frame;
  videoCodec: null;
  audioCodec: WavPcmCodec;
  sampleRate: number;
  channels: number;
  keyframeIndex: [];
  /** 视频样本（纯音频 = 空）；音频样本在 `audio.samples`。 */
  samples: [];
  exactSeek: true;
  needsIndexScan: false;
  durationSec: number;
  audio: WavAudioInfo;
  timescale: number;
  durationTicks: number;
}

export interface WavFormatInfo {
  codec: WavPcmCodec;
  /** 每采样字节数。 */
  bytesPerSample: number;
  isFloat: boolean;
  sampleRate: number;
  channels: number;
}

/** `fmt ` chunk → 格式信息；非 PCM 族返回 null（调用方给中文提示）。 */
export function parseWavFormat(fmt: Uint8Array): WavFormatInfo | null {
  const view = new DataView(fmt.buffer, fmt.byteOffset, fmt.byteLength);
  if (fmt.byteLength < 16) return null;
  let audioFormat = view.getUint16(0, true);
  const channels = view.getUint16(2, true);
  const sampleRate = view.getUint32(4, true);
  const bits = view.getUint16(14, true);
  // WAVE_FORMAT_EXTENSIBLE：真实格式在 SubFormat GUID 的前 2 字节（fmt ≥ 40 字节）
  if (audioFormat === 0xfffe && fmt.byteLength >= 40) {
    audioFormat = view.getUint16(24, true);
  }
  if (audioFormat === 1 && bits === 8) return { codec: 'pcm-u8', bytesPerSample: 1, isFloat: false, sampleRate, channels };
  if (audioFormat === 1 && bits === 16) return { codec: 'pcm-s16', bytesPerSample: 2, isFloat: false, sampleRate, channels };
  if (audioFormat === 1 && bits === 24) return { codec: 'pcm-s24', bytesPerSample: 3, isFloat: false, sampleRate, channels };
  if (audioFormat === 1 && bits === 32) return { codec: 'pcm-s32', bytesPerSample: 4, isFloat: false, sampleRate, channels };
  if (audioFormat === 3 && bits === 32) return { codec: 'pcm-f32', bytesPerSample: 4, isFloat: true, sampleRate, channels };
  return null;
}

/** codec 字符串 → 每采样字节数与是否 float（decoderPool 的 PCM 直通用）。 */
export function pcmCodecFormat(codec: string): { bytesPerSample: number; isFloat: boolean } | null {
  if (codec === 'pcm-u8') return { bytesPerSample: 1, isFloat: false };
  if (codec === 'pcm-s16') return { bytesPerSample: 2, isFloat: false };
  if (codec === 'pcm-s24') return { bytesPerSample: 3, isFloat: false };
  if (codec === 'pcm-s32') return { bytesPerSample: 4, isFloat: false };
  if (codec === 'pcm-f32') return { bytesPerSample: 4, isFloat: true };
  return null;
}

/**
 * PCM 字节块 → f32 平面（**字节级可测**的纯函数，decoderPool 的 PCM 直通用它）。
 *
 * - 16/24/32 位整数按满幅归一（/32768、/8388608、/2147483648）；
 * - 8 位是无符号（中心 128）；
 * - 32 位 float 原样；
 * - 交错输入 → 按声道拆平面（AudioData `f32-planar` 的内存布局）。
 */
export function pcmChunkToPlanarF32(
  bytes: Uint8Array,
  format: { bytesPerSample: number; isFloat: boolean; channels: number },
): Float32Array[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frameCount = Math.floor(bytes.byteLength / (format.bytesPerSample * format.channels));
  const planes: Float32Array[] = [];
  for (let channel = 0; channel < format.channels; channel += 1) {
    planes.push(new Float32Array(frameCount));
  }
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < format.channels; channel += 1) {
      const base = (frame * format.channels + channel) * format.bytesPerSample;
      let value: number;
      if (format.isFloat && format.bytesPerSample === 4) {
        value = view.getFloat32(base, true);
      } else if (format.bytesPerSample === 1) {
        value = (view.getUint8(base) - 128) / 128;
      } else if (format.bytesPerSample === 2) {
        value = view.getInt16(base, true) / 32768;
      } else if (format.bytesPerSample === 3) {
        const raw = view.getUint8(base) | (view.getUint8(base + 1) << 8) | (view.getUint8(base + 2) << 16);
        const signed = raw >= 0x800000 ? raw - 0x1000000 : raw;
        value = signed / 8388608;
      } else {
        value = view.getInt32(base, true) / 2147483648;
      }
      const plane = planes[channel];
      if (plane !== undefined) plane[frame] = value;
    }
  }
  return planes;
}

/**
 * 打开 WAV：读 RIFF 头 + 走 chunk 表拿 `fmt `/`data`，产出与 mp4/webm 同构的 probe。
 *
 * **只读头部**（`data` chunk 不进内存）——样本索引只记 offset/size，解码时按索引分块读。
 */
export async function openWav(source: BlobLike): Promise<Result<WavProbeResult>> {
  const head = await readBlobBytes(source, 0, 12);
  if (head.byteLength < 12 || textAt(head, 0) !== 'RIFF' || textAt(head, 8) !== 'WAVE') {
    return { ok: false, error: makeError('E_UNSUPPORTED_CONTAINER', '不是有效的 WAV 文件') };
  }

  let format: WavFormatInfo | null = null;
  let dataOffset = -1;
  let dataSize = 0;
  // RIFF size 只做完整性参考（有些工具写 0xFFFFFFFF），实际以 chunk 表走到尾为准
  let offset = 12;
  const total = Number(source.size);
  while (offset + 8 <= total) {
    const header = await readBlobBytes(source, offset, offset + 8);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const chunkId = textAt(header, 0);
    const chunkSize = view.getUint32(4, true);
    const contentStart = offset + 8;
    if (chunkId === 'fmt ') {
      const fmt = await readBlobBytes(source, contentStart, contentStart + Math.min(chunkSize, 64));
      format = parseWavFormat(fmt);
      // 非 PCM 族（ADPCM/µ-law 等）：立即给中文拒绝文案（用户拍板），不要拖到"缺 data"的笼统报错
      if (format === null) {
        return { ok: false, error: makeError('E_UNSUPPORTED_CONTAINER', WAV_NON_PCM_MESSAGE) };
      }
    } else if (chunkId === 'data') {
      dataOffset = contentStart;
      dataSize = Math.min(chunkSize, Math.max(0, total - contentStart));
      break; // data 之后的内容与解码无关
    }
    offset = contentStart + chunkSize + (chunkSize % 2); // chunk 按 2 字节对齐
  }

  if (format === null || dataOffset < 0 || dataSize <= 0) {
    return {
      ok: false,
      error: makeError('E_UNSUPPORTED_CONTAINER', 'WAV 缺少 fmt 或 data 数据块', `size=${total}`),
    };
  }
  if (format.channels < 1 || format.channels > 8 || format.sampleRate < 1) {
    return {
      ok: false,
      error: makeError('E_UNSUPPORTED_CONTAINER', 'WAV 声道数或采样率非法', JSON.stringify(format)),
    };
  }

  const bytesPerFrame = format.bytesPerSample * format.channels;
  const totalFrames = Math.floor(dataSize / bytesPerFrame);
  const durationSec = totalFrames / format.sampleRate;
  // 素材时基帧数：WAV 无视频帧，按 DEFAULT_FPS_MILLI（30fps）时基折算（webm 纯音频同口径）
  const durationFrames: Frame = Math.max(1, Math.round(durationSec * 30));

  // 样本索引：按 1 秒一块（bytesPerFrame × sampleRate），ptsUs 按秒累计
  const samples: SampleIndexEntry[] = [];
  const framesPerEntry = format.sampleRate;
  const entryCount = Math.ceil(totalFrames / framesPerEntry);
  for (let index = 0; index < entryCount; index += 1) {
    const frameStart = index * framesPerEntry;
    const frames = Math.min(framesPerEntry, totalFrames - frameStart);
    samples.push({
      index,
      offset: dataOffset + frameStart * bytesPerFrame,
      size: frames * bytesPerFrame,
      dtsUs: samplesToUs(frameStart, format.sampleRate),
      ptsUs: samplesToUs(frameStart, format.sampleRate),
      isKey: true,
    });
  }

  return {
    ok: true,
    value: {
      container: 'wav',
      hasVideo: false,
      hasAudio: true,
      width: null,
      height: null,
      fpsMilli: null,
      durationFrames,
      videoCodec: null,
      audioCodec: format.codec,
      sampleRate: format.sampleRate,
      channels: format.channels,
      keyframeIndex: [],
      samples: [],
      exactSeek: true,
      needsIndexScan: false,
      durationSec,
      audio: {
        codec: format.codec,
        sampleRate: format.sampleRate,
        channels: format.channels,
        timescale: format.sampleRate,
        sampleCount: totalFrames,
        description: null,
        samples,
      },
      timescale: format.sampleRate,
      durationTicks: totalFrames,
    },
  };
}

function textAt(bytes: Uint8Array, offset: number): string {
  let out = '';
  for (let index = offset; index < offset + 4; index += 1) out += String.fromCharCode(bytes[index] ?? 0);
  return out;
}
