/**
 * 音量（滑块位置 ↔ dB ↔ 线性增益）与峰值保护。
 *
 * ## 为什么不能直接"滑块值 = 振幅倍数"
 *
 * 旧实现 `gain = 滑块值`（0..2 线性振幅）。它的问题是**上半段几乎没用、下半段一脚踩空**：
 * - 100% → 0dB，50% → **-6dB**（听起来只小了一点点），25% → -12dB；
 * - 也就是说 0~50% 这段承担了 -∞~-6dB，而 50~100% 只承担 6dB，手感极不均匀；
 * - 200% 只给到 +6dB（2 倍振幅），拿不到"小幅放大"的 +12dB。
 *
 * ## 现在的映射：**分段线性 dB**
 *
 * ```
 * 位置 0%          100%              200%
 *  │               │                 │
 *  -∞ dB  ←──────  0 dB  ──────→   +12 dB
 *      (衰减 60dB)      (增益 12dB)
 * ```
 *
 * - `0 < 位置 ≤ 1`：dB = -60 + 60 × 位置（**每 1% 走 0.6dB**）
 * - `1 < 位置 ≤ 2`：dB = 12 × (位置 - 1)（**每 1% 走 0.12dB**）
 * - `位置 = 0`：真静音（gain 0，不是 -60dB 的 0.001）
 *
 * 为什么下半段每 1% 走 0.6dB、上半段只走 0.12dB：人耳对"衰减"的容忍度远大于"放大"。
 * 下半段要能快速拉到底（找静音），上半段要能精细控制 +1/+2dB —— 这是所有调音台的
 * 共同做法（推子下半程行程大、上半程行程小）。**全程按 dB 线性**，所以手感是均匀的：
 * 每一段滑块行程对应的"听觉变化量"一致，不会出现"前面拖半天没变、后面一动就爆"。
 *
 * ## 为什么不改 `Clip.audio.gain` 的存储含义
 *
 * 存的是**线性振幅**（0 ~ 3.98），不是 dB、也不是滑块位置。原因：
 * 1. 音频引擎、导出混音、预设、工程文件全都按振幅算，改语义等于全线迁移；
 * 2. 老工程里 `gain = 0.5` 的声音**一点都不会变**（它仍然是 -6dB），
 *    只是滑块会显示在 90% 的位置 —— 声音优先，界面其次。
 */

/** 衰减下限（dB）。低于它的位置按静音处理（-60dB 已经听不见了）。 */
export const VOLUME_MIN_DB = -60;
/** 增益上限（dB）。+12dB ≈ 4 倍振幅，够"把声音提上来"用。 */
export const VOLUME_MAX_DB = 12;
/** 滑块 100% 的位置（0dB 基准）。 */
export const VOLUME_UNITY_POSITION = 1;
/** 滑块最大位置（200% → +12dB）。 */
export const VOLUME_MAX_POSITION = 2;

/**
 * 峰值保护（软限幅）的拐点：|x| ≤ 0.9（约 -0.9dB）时**完全不动**，
 * 超过之后用 tanh 平滑压到 1.0 以下。
 *
 * 为什么拐点取 0.9 而不是 1.0：到 1.0 才开始压就来不及了——数字域没有余量，
 * 越过 1.0 之后任何压缩都已经是"削掉的波形"。留 0.9 的余量，正常素材（峰值通常
 * 在 -3dB 以下）完全不受影响，而 +12dB 的增益会在到达满刻度前被柔和地收住。
 */
const LIMIT_KNEE = 0.9;

/**
 * 限幅后的**天花板**（0.999，而不是 1.0）。
 *
 * 为什么留这一点余量：16bit PCM 的满刻度是 32767/32768 ≈ 0.99997，
 * 如果限幅恰好停在 1.0，写文件时仍会被当成"到顶"，某些播放器会显示削波。
 * 0.999 对应 -0.009dB，听不出来，但所有下游（WAV/MP4 编码器）都安全。
 */
const LIMIT_CEIL = 0.999;

/** 滑块位置 → dB（0 → -Infinity，1 → 0dB，2 → +12dB）。 */
export function positionToDb(position: number): number {
  const p = Number.isFinite(position) ? position : 0;
  if (p <= 0) return Number.NEGATIVE_INFINITY;
  if (p <= VOLUME_UNITY_POSITION) {
    // -60 → 0：每 1% 走 0.6dB
    return VOLUME_MIN_DB + (0 - VOLUME_MIN_DB) * p;
  }
  const clamped = Math.min(p, VOLUME_MAX_POSITION);
  return VOLUME_MAX_DB * (clamped - VOLUME_UNITY_POSITION);
}

/** dB → 滑块位置（-Infinity → 0，0dB → 1，+12dB → 2）。 */
export function dbToPosition(db: number): number {
  if (!Number.isFinite(db) || db <= VOLUME_MIN_DB) return 0;
  if (db <= 0) return (db - VOLUME_MIN_DB) / (0 - VOLUME_MIN_DB);
  return VOLUME_UNITY_POSITION + Math.min(db, VOLUME_MAX_DB) / VOLUME_MAX_DB;
}

/** dB → 线性振幅。 */
export function dbToGain(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return 10 ** (db / 20);
}

/** 线性振幅 → dB（0 → -Infinity）。 */
export function gainToDb(gain: number): number {
  if (!Number.isFinite(gain) || gain <= 0) return Number.NEGATIVE_INFINITY;
  return 20 * Math.log10(gain);
}

/** 滑块位置 → 线性振幅（0 位置是真静音）。 */
export function positionToGain(position: number): number {
  return dbToGain(positionToDb(position));
}

/** 线性振幅 → 滑块位置。 */
export function gainToPosition(gain: number): number {
  return dbToPosition(gainToDb(gain));
}

/**
 * 软限幅：把超过 0dB 的样本平滑压到 1.0 以下，而不是硬切（硬切 = 方波 = 爆音）。
 *
 * 拐点以下**恒等**（不染色），拐点以上用 `tanh` 渐近到 1.0：
 * `y = K + (1-K)·tanh((|x|-K)/(1-K))`，K = 0.9。
 * 这个函数是奇函数且单调，所以不会引入直流偏移，也不会把波形折回去。
 */
export function softLimit(sample: number): number {
  if (!Number.isFinite(sample)) return 0;
  const magnitude = Math.abs(sample);
  if (magnitude <= LIMIT_KNEE) return sample;
  const sign = sample < 0 ? -1 : 1;
  const over = (magnitude - LIMIT_KNEE) / (1 - LIMIT_KNEE);
  return sign * (LIMIT_KNEE + (LIMIT_CEIL - LIMIT_KNEE) * Math.tanh(over));
}

/** dB 的可读文案：`-∞ dB` / `0.0 dB` / `+3.0 dB` / `-6.0 dB`。 */
export function formatDb(db: number): string {
  if (!Number.isFinite(db)) return '-∞ dB';
  const rounded = Math.round(db * 10) / 10;
  if (Math.abs(rounded) < 0.05) return '0.0 dB';
  const text = rounded > 0 ? `+${rounded.toFixed(1)}` : rounded.toFixed(1);
  return `${text} dB`;
}

/** 位置的可读百分比（0~200%）。 */
export function formatPercent(position: number): string {
  return `${Math.round(Math.min(VOLUME_MAX_POSITION, Math.max(0, position)) * 100)}%`;
}
