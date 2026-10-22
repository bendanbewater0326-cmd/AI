/**
 * 音频降噪（R-061）：噪声门 + 人声增强，直接作用在 PCM 上。
 *
 * ## 为什么是"门 + 高通"而不是谱减
 *
 * 谱减（spectral subtraction）要 FFT、要估计噪声谱、要处理音乐噪声，是一整个 DSP 子系统的体量；
 * 而口播/访谈里最常见的问题是**底噪一直响**（空调、风扇、房间混响）。噪声门能把静音段压干净，
 * 高通 + 存在感提升能让声音更"贴脸"——两者加起来解决了 80% 的听感问题，且**逐样本可预测**。
 *
 * 明确不做：去混响、去特定噪声源、音乐场景降噪。那些要模型，不是这段代码能承诺的。
 *
 * ## 三条工程约束
 *
 * 1. **无状态**：每次处理一块 PCM（0.5s），不依赖上一块——预览是分块调度的，
 *    跨块状态一旦不同步（seek/跳播）就会爆音。
 * 2. **软门限而不是硬切**：硬切在阈值附近会"抽气"（gain 0/1 反复跳），这里用
 *    `threshold ~ threshold+6dB` 的线性过渡，听感平滑。
 * 3. **预览与导出用同一函数**：两条链路各写一遍必然出现"预览干净、成片还是有底噪"。
 */
import type { Clip } from '../core/types';

export interface DenoiseParams {
  /** 噪声门阈值（dBFS，-70..-20）。 */
  thresholdDb: number;
  /** 人声增强强度 0..1（0 = 只过门，1 = 高通 + 存在感提升拉满）。 */
  enhance: number;
}

export const DENOISE_EFFECT = 'denoise';
export const DEFAULT_DENOISE: DenoiseParams = { thresholdDb: -42, enhance: 0.5 };

/**
 * 识别"降噪"类指令（R-061 的自然语言入口）。
 *
 * 与粗剪同理：这条指令**不需要模型**——降噪是本地 DSP，"要不要降噪"用关键词判断足够，
 * 交给模型只会多一次网络往返，还可能被它改写成本地不支持的意图。
 */
export function parseDenoiseRequest(text: string): boolean {
  return /(降噪|去噪|底噪|人声增强|噪声门)/.test(text);
}

/** 从片段的 effects 里读降噪参数（没有/被禁用返回 null）。 */
export function denoiseOf(clip: Clip): DenoiseParams | null {
  const effect = clip.effects.find((item) => item.type === DENOISE_EFFECT && item.enabled);
  if (effect === undefined) return null;
  const raw = effect.params;
  const threshold = typeof raw['thresholdDb'] === 'number' ? raw['thresholdDb'] : DEFAULT_DENOISE.thresholdDb;
  const enhance = typeof raw['enhance'] === 'number' ? raw['enhance'] : DEFAULT_DENOISE.enhance;
  return {
    thresholdDb: Math.min(-20, Math.max(-70, threshold)),
    enhance: Math.min(1, Math.max(0, enhance)),
  };
}

/** 一阶高通系数（RC 高通，`fc` 为截止频率）。 */
function highPassCoefficient(sampleRate: number, cutoffHz: number): number {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / sampleRate;
  return rc / (rc + dt);
}

/**
 * 就地处理一段 PCM（多声道各自独立）。
 *
 * 处理顺序：高通（去掉低频隆隆声）→ 存在感（轻微抬 2–4kHz 附近的"临场感"）→ 噪声门。
 * 门放在最后：前面的滤波会把底噪一起改掉，先用最终信号估包络更准。
 */
export function applyDenoise(
  planes: Float32Array[],
  params: DenoiseParams,
  sampleRate: number,
): void {
  const threshold = Math.pow(10, params.thresholdDb / 20);
  // 软门限上限：阈值 +6dB 之内线性过渡
  const ceiling = threshold * 2;
  const hpCutoff = 60 + params.enhance * 90; // 60–150Hz
  const hp = highPassCoefficient(sampleRate, hpCutoff);
  const presence = params.enhance * 0.25;

  for (const plane of planes) {
    const n = plane.length;
    if (n === 0) continue;

    // 1) 一阶高通
    let prevIn = plane[0] ?? 0;
    let prevOut = 0;
    for (let i = 0; i < n; i += 1) {
      const x = plane[i] ?? 0;
      const y = hp * (prevOut + x - prevIn);
      prevIn = x;
      prevOut = y;
      plane[i] = y;
    }

    // 2) 存在感：一阶差分（简易高频抬升），强度由 enhance 控制
    if (presence > 0) {
      let prev = plane[0] ?? 0;
      for (let i = 0; i < n; i += 1) {
        const x = plane[i] ?? 0;
        const diff = x - prev;
        prev = x;
        plane[i] = x + diff * presence;
      }
    }

    // 3) 噪声门：包络跟随（快起慢落）+ 软门限
    const attack = 1 - Math.exp(-1 / (0.005 * sampleRate));
    const release = 1 - Math.exp(-1 / (0.08 * sampleRate));
    let envelope = 0;
    for (let i = 0; i < n; i += 1) {
      const x = plane[i] ?? 0;
      const magnitude = Math.abs(x);
      envelope += (magnitude - envelope) * (magnitude > envelope ? attack : release);
      let gain = 1;
      if (envelope <= threshold) gain = 0;
      else if (envelope < ceiling) gain = (envelope - threshold) / (ceiling - threshold);
      plane[i] = x * gain;
    }
  }
}
