/**
 * 语音识别的前置音频处理（R-059）。
 *
 * ## 为什么客户端要自己抽音频
 *
 * 宿主只提供"转写"能力，它拿不到时间线上的 PCM——素材在浏览器里、解码靠 WebCodecs。
 * 所以链路是：
 *
 *   时间线 → 混音（`mixTimelineAudio`，48k 立体声）→ 下混单声道 → 重采样 16k → 交给宿主
 *
 * 统一到 **16k 单声道 Float32** 是因为这几乎是所有 ASR 的公共输入格式；
 * 让宿主去关心我们的工程采样率和声道数，等于把内部细节泄给每一个接入方。
 *
 * ## 为什么线性插值就够
 *
 * 48k → 16k 是整数倍下采样，线性插值的误差集中在高频（ASR 模型本来就要做
 * 8k 低通 + 特征提取），相比"引入重采样库"的收益，不值得多一个依赖。
 * 真正的抗混叠滤波在模型侧的特征提取里。
 *
 * ## 边界
 *
 * - 上限 `MAX_ASR_SECONDS`：整段 PCM 要攒在内存里（16k 单声道 30 分钟约 115MB），
 *   超过就给可读拒绝，而不是让浏览器 OOM；
 * - 全静音不拒绝（静音视频也可能想生成空字幕），但会回一个可读提示（见 `rmsOf`）。
 */
import type { Frame, Project, Result } from '../core/types';
import { fail, makeError, ok } from '../core/types';
import { frameToUs, samplesToUs, usToSeconds } from '../core/timebase';
import { computeProjectDerived } from '../core/store';
import { createDecoderPool } from '../media/decoderPool';
import { mixTimelineAudio } from '../export/audioMix';
import { getExportProbe } from '../media/previewSource';
import { registerProjectSources } from '../media/sourceRegistry';
import type { Mp4ProbeResult } from '../media/demuxMp4';

/** ASR 输入采样率（业界默认）。 */
export const ASR_SAMPLE_RATE = 16000;
/** 单次转写上限（秒）。16k 单声道 30 分钟 ≈ 115MB。 */
export const MAX_ASR_SECONDS = 1800;

export interface AsrAudio {
  audio: Float32Array;
  sampleRate: number;
  durationSec: number;
  /** 均方根电平（0..1）：接近 0 说明整段没声音。 */
  rms: number;
}

/** 多声道 → 单声道（简单平均；不要取最大声道，会把相位相反的成分放大）。 */
export function downmixToMono(channels: readonly Float32Array[]): Float32Array {
  const usable = channels.filter((channel) => channel.length > 0);
  if (usable.length === 0) return new Float32Array(0);
  if (usable.length === 1) return usable[0] as Float32Array;
  const length = Math.min(...usable.map((channel) => channel.length));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    let sum = 0;
    for (const channel of usable) sum += channel[i] ?? 0;
    out[i] = sum / usable.length;
  }
  return out;
}

/**
 * 线性插值重采样。
 *
 * 采样率相同时直接返回原数组（不复制：调用方只读）。
 */
export function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate <= 0 || toRate <= 0 || input.length === 0) return new Float32Array(0);
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLength);
  const lastIndex = input.length - 1;
  for (let i = 0; i < outLength; i += 1) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(lastIndex, left + 1);
    const t = position - left;
    const a = input[left] ?? 0;
    const b = input[right] ?? 0;
    out[i] = a + (b - a) * t;
  }
  return out;
}

/** 均方根电平（0..1）。 */
export function rmsOf(audio: Float32Array): number {
  if (audio.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < audio.length; i += 1) {
    const value = audio[i] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / audio.length);
}

export interface ExtractAsrOptions {
  doc: Project;
  /** 只转写这个区间（项目帧）；缺省 = 整条时间线。 */
  startFrame?: Frame;
  endFrame?: Frame;
  onStage?: (stage: string) => void;
}

/**
 * 抽时间线音频 → 16k 单声道。
 *
 * 与粗剪一样**用原片**（代理音频是重编码过的，识别准确率会掉）。
 */
export async function extractAsrAudio(options: ExtractAsrOptions): Promise<Result<AsrAudio>> {
  const { doc } = options;
  const total = computeProjectDerived(doc).durationFrames;
  const startFrame = Math.max(0, options.startFrame ?? 0);
  const endFrame = Math.min(total, options.endFrame ?? total);
  if (endFrame <= startFrame) {
    return fail(makeError('E_DECODE_FAILED', '时间线是空的，没有可识别的音频', 'asrAudio'));
  }

  const fps = doc.fpsMilli;
  const spanSeconds = usToSeconds(frameToUs(endFrame - startFrame, fps));
  if (spanSeconds > MAX_ASR_SECONDS) {
    return fail(
      makeError(
        'E_DECODE_FAILED',
        `要识别的区间太长（${Math.round(spanSeconds / 60)} 分钟），单次上限 ${MAX_ASR_SECONDS / 60} 分钟`,
        '先切成几段，或只识别选中的区间',
      ),
    );
  }

  options.onStage?.('抽取音频');
  const pool = createDecoderPool();
  let mixed;
  try {
    registerProjectSources(pool, doc);
    mixed = await mixTimelineAudio({
      doc,
      startFrame,
      endFrame,
      pool,
      getProbe: (assetId) => getExportProbe(assetId) as Mp4ProbeResult | undefined,
    });
  } finally {
    await pool.dispose();
  }
  if (!mixed.ok) {
    return fail(makeError('E_DECODE_FAILED', `读取音频失败：${mixed.error.message}`, 'asrAudio'));
  }

  const mono = downmixToMono(mixed.value.channels);
  const audio = resampleLinear(mono, mixed.value.sampleRate, ASR_SAMPLE_RATE);
  const durationSec = usToSeconds(samplesToUs(audio.length, ASR_SAMPLE_RATE));
  return ok({ audio, sampleRate: ASR_SAMPLE_RATE, durationSec, rms: rmsOf(audio) });
}
