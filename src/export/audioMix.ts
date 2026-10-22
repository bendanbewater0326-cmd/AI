/**
 * 导出音频混音（M3）：把时间线 `[startFrame, endFrame)` 内所有可听片段
 * 解码 → 重采样到 48kHz → 叠加成一条 48kHz 多声道 PCM。
 *
 * ## 为什么要独立于播放用的 `audioEngine`
 *
 * 播放调度是"分块、实时、允许空洞"；导出必须是"整段、确定性、零空洞"，
 * 否则导出的成片会缺音或时长对不上。两者共用同一套换算入口（timebase）
 * 与同一个解码器池端口，但不共享调度状态。
 *
 * ## 时长口径
 *
 * 输出采样数 = `totalSamplesFor(endFrame - startFrame, fpsMilli)`（T10 ⑧ 的守恒口径），
 * 与视频帧数严格对应：导出音频与视频总时长差 ≤ 1 帧。
 */
import { frameToUs, mapProjectFrameToAssetFrame, samplesToUs, secondsToFrames, usToSeconds } from '../core/timebase';
import type { Asset, Clip, Frame, Project, Result } from '../core/types';
import { makeError } from '../core/types';
import { softLimit } from '../core/volume';
import { isTrackAudible } from '../core/trackAudibility';
import type { Mp4ProbeResult } from '../media/demuxMp4';
import { PROJECT_SAMPLE_RATE, envelopeAt, resample, totalSamplesFor } from '../media/audioEngine';
import { applyDenoise, denoiseOf } from '../media/denoise';
import { keyframesFor, sampleKeyframes } from '../core/keyframes';
import type { AudioDecodePort } from '../media/audioEngine';

export interface MixOptions {
  doc: Project;
  startFrame: Frame;
  endFrame: Frame;
  pool: AudioDecodePort | null;
  getProbe: (assetId: string) => Mp4ProbeResult | undefined;
  /**
   * 只混这一个片段（"导出这段的音频"）。
   *
   * 不给就是整段区间混音（正常导出）。给了之后**仍然按区间对齐**：
   * 输出长度还是 `endFrame - startFrame`，只是别的片段不参与——这样
   * "导出单个片段的音频"与"导出整段"共用同一条时间轴，不会出现
   * "单段导出的前 0.3 秒是静音（因为它在时间线上不是从 0 开始）"这种怪结果，
   * 调用方只要把区间设成片段自己的区间即可。
   */
  onlyClipId?: string;
  /** 取消信号（导出可中断）。 */
  signal?: AbortSignal;
  onProgress?: (ratio: number) => void;
}

export interface MixedAudio {
  sampleRate: number;
  channels: Float32Array[];
  /** 每声道采样数。 */
  length: number;
}

/**
 * 找出区间内可听的片段（未静音轨 + 素材有音频 + 片段启用 + 不是"只出画"的片段）。
 *
 * **`role === 'video'` 必须跳过**：分离音频之后，原片段只负责画面，声音在音频轨上那个
 * `role: 'audio'` 的片段里。这里若不过滤，导出的成片会把同一段声音混两遍
 * （音量翻倍、相位偏移导致发闷）。预览用的 `audioEngine` 有同样的判断——
 * 两处**必须**一致，否则"预览听着正常、导出炸了"。
 */
export function audibleClipsFor(
  doc: Project,
  startFrame: Frame,
  endFrame: Frame,
  onlyClipId?: string,
): Array<{ clip: Clip; asset: Asset }> {
  const out: Array<{ clip: Clip; asset: Asset }> = [];
  for (const track of doc.tracks) {
    // 与预览走同一份判断（`core/trackAudibility`），否则"预览有声、导出没声"
    if (!isTrackAudible(doc, track)) continue;
    for (const clip of track.clips) {
      if (!clip.enabled) continue;
      if (clip.role === 'video') continue;
      if (onlyClipId !== undefined && clip.id !== onlyClipId) continue;
      const clipEnd = clip.startFrame + clip.durationFrames;
      if (clipEnd <= startFrame || clip.startFrame >= endFrame) continue;
      const asset = doc.assets.find((item) => item.id === clip.assetId);
      if (asset === undefined || !asset.hasAudio) continue;
      out.push({ clip, asset });
    }
  }
  return out;
}

/** 二分：样本表里覆盖 `us` 的样本下标。 */
function sampleIndexAt(samples: ReadonlyArray<{ ptsUs: number }>, us: number): number {
  let lo = 0;
  let hi = samples.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const item = samples[mid];
    if (item === undefined) break;
    if (item.ptsUs <= us) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** 把一个片段的音频混进目标缓冲（按项目帧对齐）。 */
async function mixClip(
  target: Float32Array[],
  targetLength: number,
  clip: Clip,
  asset: Asset,
  doc: Project,
  startFrame: Frame,
  pool: AudioDecodePort,
  probe: Mp4ProbeResult,
): Promise<boolean> {
  const audio = probe.audio;
  if (audio === null || audio.samples.length === 0) return false;

  // 片段与导出区间的交集（项目帧）
  const from = Math.max(startFrame, clip.startFrame);
  const to = Math.min(startFrame + targetLength, clip.startFrame + clip.durationFrames);
  if (to <= from) return false;

  const assetFrame = mapProjectFrameToAssetFrame(from, clip, asset, doc.fpsMilli);
  if (assetFrame === null) return false;
  const startUs = frameToUs(assetFrame, asset.fpsMilli);
  const spanUs = frameToUs(to - from, doc.fpsMilli);
  const index = sampleIndexAt(audio.samples, startUs);
  const first = audio.samples[index];
  const second = audio.samples[index + 1];
  const sampleDurUs = first === undefined ? 0 : Math.max(1, (second?.ptsUs ?? startUs + 21333) - first.ptsUs);
  const need = Math.ceil(spanUs / sampleDurUs) + 2;
  const decoded = await pool.decodeAudioRange(asset.id, index, Math.min(need, audio.samples.length - index));
  if (!decoded.ok) return false;

  const chunks = decoded.value;
  try {
    const totalFrames = chunks.reduce((sum, item) => sum + item.numberOfFrames, 0);
    if (totalFrames === 0) return false;
    const channelCount = Math.max(1, audio.channels);
    const planes = Array.from({ length: channelCount }, () => new Float32Array(totalFrames));
    let cursor = 0;
    for (const data of chunks) {
      for (let c = 0; c < channelCount; c += 1) {
        const plane = planes[c];
        if (plane === undefined) continue;
        try {
          data.copyTo(plane.subarray(cursor, cursor + data.numberOfFrames), {
            planeIndex: Math.min(c, data.numberOfChannels - 1),
            format: 'f32-planar',
          });
        } catch {
          // 平面布局不支持：该声道静音，但不放弃整块
        }
      }
      cursor += data.numberOfFrames;
    }

    const leadUs = first === undefined ? 0 : startUs - first.ptsUs;
    const lead = Math.max(0, Math.min(totalFrames - 1, Math.round(usToSeconds(leadUs) * audio.sampleRate)));
    const trimmed = planes.map((plane) => plane.subarray(lead));
    const resampled =
      audio.sampleRate === PROJECT_SAMPLE_RATE
        ? trimmed
        : trimmed.map((plane) => resample(plane, audio.sampleRate, PROJECT_SAMPLE_RATE));

    // 降噪（R-061）：在混音之前逐片段处理，与预览走同一个函数
    const denoise = denoiseOf(clip);
    if (denoise !== null) {
      applyDenoise(resampled as Float32Array[], denoise, PROJECT_SAMPLE_RATE);
    }

    // 目标起点 = 片段在导出区间内的相对帧 → 采样下标
    const offsetFrames = from - startFrame;
    const offsetSamples = Math.round(usToSeconds(frameToUs(offsetFrames, doc.fpsMilli)) * PROJECT_SAMPLE_RATE);
    const baseGain = Math.max(0, clip.audio.gain);
    const hasFade = clip.audio.fadeInFrames > 0 || clip.audio.fadeOutFrames > 0;
    const gainPoints = keyframesFor(clip, 'audio.gain');
    const hasGainAnim = gainPoints.length >= 2;
    const clipOffset = from - clip.startFrame;
    for (let c = 0; c < target.length; c += 1) {
      const dst = target[c];
      const src = resampled[Math.min(c, resampled.length - 1)];
      if (dst === undefined || src === undefined) continue;
      const count = Math.min(src.length, Math.max(0, targetLength - offsetSamples));
      for (let i = 0; i < count; i += 1) {
        const at = offsetSamples + i;
        if (at < 0 || at >= targetLength) continue;
        // 淡变与音量关键帧都必须逐样本算：块首尾插值在"跨过斜坡/断点"时会算错
        let gain = baseGain;
        if (hasFade || hasGainAnim) {
          const offset =
            clipOffset +
            secondsToFrames(usToSeconds(samplesToUs(i, PROJECT_SAMPLE_RATE)), doc.fpsMilli);
          const keyed = hasGainAnim ? Math.max(0, sampleKeyframes(gainPoints, offset) ?? baseGain) : baseGain;
          gain = hasFade ? keyed * envelopeAt(clip, offset) : keyed;
        }
        dst[at] = (dst[at] ?? 0) + (src[i] ?? 0) * gain;
      }
    }
    return true;
  } finally {
    for (const data of chunks) data.close();
  }
}

/** 混合导出区间内的全部音频。 */
export async function mixTimelineAudio(options: MixOptions): Promise<Result<MixedAudio>> {
  const { doc, startFrame, endFrame } = options;
  const frames = Math.max(0, endFrame - startFrame);
  if (frames === 0) {
    return { ok: false, error: makeError('E_DECODE_FAILED', '导出区间为空', 'mixTimelineAudio') };
  }
  const length = totalSamplesFor(frames, doc.fpsMilli);
  const channels = [new Float32Array(length), new Float32Array(length)];
  const clips = audibleClipsFor(doc, startFrame, endFrame, options.onlyClipId);
  if (clips.length === 0 || options.pool === null) {
    // 无音频是合法结果：静音轨导出（视频照常）
    return { ok: true, value: { sampleRate: PROJECT_SAMPLE_RATE, channels, length } };
  }

  let done = 0;
  for (const { clip, asset } of clips) {
    if (options.signal?.aborted === true) {
      return { ok: false, error: makeError('E_DECODE_FAILED', '导出已取消', 'mixTimelineAudio') };
    }
    const probe = options.getProbe(asset.id);
    if (probe !== undefined) {
      try {
        await mixClip(channels, length, clip, asset, doc, startFrame, options.pool, probe);
      } catch {
        // 单个片段失败不拖垮整段导出：该片段静音，其余照常
      }
    }
    done += 1;
    options.onProgress?.(done / clips.length);
  }

  /**
   * 峰值保护（与预览同一条规则，见 `core/volume.softLimit`）。
   *
   * 单个片段的增益已经在自己那条路径上限过幅，但**多轨叠加**仍可能超过 0dB
   * （两条 0dB 的轨相加就是 +6dB）。这里对最终混音再过一次软限幅，
   * 保证导出的 WAV/MP4 不会出现硬削波的方波边。
   *
   * 先扫一遍峰值：没超过拐点（0.9）就完全不动 —— 正常素材不会付出任何音质代价。
   */
  let peak = 0;
  for (const plane of channels) {
    for (let i = 0; i < plane.length; i += 1) {
      const magnitude = Math.abs(plane[i] ?? 0);
      if (magnitude > peak) peak = magnitude;
    }
  }
  if (peak > 0.9) {
    for (const plane of channels) {
      for (let i = 0; i < plane.length; i += 1) plane[i] = softLimit(plane[i] ?? 0);
    }
  }

  return { ok: true, value: { sampleRate: PROJECT_SAMPLE_RATE, channels, length } };
}

/** 交错成 AudioData 需要的 planar 数据（供 AudioEncoder 直接吃）。 */
export function planarsOf(mixed: MixedAudio): Float32Array[] {
  return mixed.channels.map((plane) => plane);
}

/** 导出 WAV（16bit PCM 小端）。 */
export function encodeWav(mixed: MixedAudio): Blob {
  const channelCount = mixed.channels.length;
  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataBytes = mixed.length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, mixed.sampleRate, true);
  view.setUint32(28, mixed.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < mixed.length; i += 1) {
    for (let c = 0; c < channelCount; c += 1) {
      const sample = Math.max(-1, Math.min(1, mixed.channels[c]?.[i] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
