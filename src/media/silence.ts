/**
 * 静音检测（R-060 智能粗剪的分析层）。
 *
 * ## 为什么用"窗口 RMS"而不是逐样本阈值
 *
 * 逐样本判"振幅小于 x"会把语音的过零点全判成静音；而按窗口算 RMS 再比 dBFS，
 * 才能表达"这一小段时间整体没有声音"。窗口取 20ms：比一个音节短，又足够稳。
 *
 * ## 为什么阈值用 dBFS 而不是线性
 *
 * 人耳是对数的，-40dBFS 这类说法在音频工具里是通用语言；线性阈值（0.01）在不同
 * 音量素材上表现差异巨大，用户也没法调。默认 -40dBFS 覆盖"正常说话 + 底噪"的场景。
 *
 * ## 边界约定
 *
 * - 返回的是**项目帧**区间（`[startFrame, endFrame)`），由调用方决定落在哪条轨；
 * - `paddingFrames` 是"往回收"的余量：静音两端各保留一点，避免把字头/字尾削掉；
 * - 收完余量后仍短于 `minSilenceFrames` 的区间**丢弃**（短停顿不剪，否则听感碎）。
 *
 * 纯函数（只依赖 timebase），可在 Node 里用合成 PCM 单测。
 */
import type { Frame, MilliFps } from '../core/types';
import { samplesToUs, usToFrame } from '../core/timebase';

export interface SilenceRange {
  /** 项目帧，闭开区间。 */
  startFrame: Frame;
  endFrame: Frame;
}

export interface SilenceDetectOptions {
  sampleRate: number;
  fpsMilli: MilliFps;
  /** 短于该帧数的静音不返回。 */
  minSilenceFrames: Frame;
  /** 静音阈值（dBFS，默认 -40）。 */
  thresholdDb?: number;
  /** 分析窗口（毫秒，默认 20）。 */
  windowMs?: number;
  /** 静音两端保留的余量（项目帧，默认 0）。 */
  paddingFrames?: Frame;
}

export interface SilenceDetection {
  ranges: SilenceRange[];
  /** 被判定为静音的帧数（收余量之后）。 */
  silentFrames: Frame;
}

const DEFAULT_THRESHOLD_DB = -40;
const DEFAULT_WINDOW_MS = 20;

/** 线性 RMS → dBFS（0 → -Infinity）。 */
function toDb(rms: number): number {
  return rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY;
}

/**
 * 检测静音区间。
 *
 * `length` 是每声道采样数；`channels` 少于 `length` 的部分按 0 处理（不静默截断）。
 */
export function detectSilenceRanges(
  channels: readonly Float32Array[],
  length: number,
  options: SilenceDetectOptions,
): SilenceDetection {
  const thresholdDb = options.thresholdDb ?? DEFAULT_THRESHOLD_DB;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const padding = Math.max(0, options.paddingFrames ?? 0);
  // timebase-allow: 毫秒窗口 → 采样数，属于采样域换算，不涉及帧号
  const windowSamples = Math.max(1, Math.round((options.sampleRate * windowMs) / 1000));
  const windows = Math.floor(length / windowSamples);
  if (windows <= 0) return { ranges: [], silentFrames: 0 };

  const channelCount = Math.max(1, channels.length);
  const silent = new Uint8Array(windows);
  for (let w = 0; w < windows; w += 1) {
    let sumSquares = 0;
    const from = w * windowSamples;
    const to = from + windowSamples;
    for (const plane of channels) {
      for (let i = from; i < to && i < plane.length; i += 1) {
        const value = plane[i] ?? 0;
        sumSquares += value * value;
      }
    }
    const rms = Math.sqrt(sumSquares / (windowSamples * channelCount));
    silent[w] = toDb(rms) < thresholdDb ? 1 : 0;
  }

  // 合并连续静音窗口
  const runs: Array<{ from: number; to: number }> = [];
  let runStart = -1;
  for (let w = 0; w < windows; w += 1) {
    if (silent[w] === 1 && runStart < 0) runStart = w;
    if (silent[w] === 0 && runStart >= 0) {
      runs.push({ from: runStart * windowSamples, to: w * windowSamples });
      runStart = -1;
    }
  }
  if (runStart >= 0) runs.push({ from: runStart * windowSamples, to: windows * windowSamples });

  const ranges: SilenceRange[] = [];
  let silentFrames = 0;
  for (const run of runs) {
    const startFrame = usToFrame(samplesToUs(run.from, options.sampleRate), options.fpsMilli) + padding;
    const endFrame = usToFrame(samplesToUs(run.to, options.sampleRate), options.fpsMilli) - padding;
    if (endFrame - startFrame < Math.max(1, options.minSilenceFrames)) continue;
    ranges.push({ startFrame, endFrame });
    silentFrames += endFrame - startFrame;
  }
  return { ranges, silentFrames };
}
