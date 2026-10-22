/**
 * 蒙版（R-056）：矩形/椭圆 + 羽化 + 关键帧（"跨帧变化"）。
 *
 * ## 能力边界（必须先说清楚）
 *
 * **不做自动跟踪**。真正的"跟踪"要用视觉模型逐帧找目标，本地没有这个能力。
 * 这里提供的是"关键帧蒙版"：用户（或 AI 按规则）在不同时间点摆好位置，
 * 中间帧由线性插值补出来——这是所有剪辑软件里"手动跟踪"的标准做法，
 * 也是没有模型时唯一诚实的实现。
 *
 * ## 坐标口径
 *
 * `x/y/w/h` 都是 **0..1 的相对值**（相对画面宽高），与项目分辨率解耦：
 * 换分辨率（R-031）后蒙版位置不会跑偏。`x/y` 是左上角，`w/h` 是尺寸。
 *
 * ## 为什么羽化用 smoothstep 而不是高斯
 *
 * 高斯要采样半径内的多个点；smoothstep 一次就够，视觉上都是"软边"，
 * 但前者在 4K 全屏逐像素时成本高一个数量级。
 */
import type { Clip, Frame } from '../core/types';
import { sampleKeyframes } from '../core/keyframes';

export const MASK_EFFECT = 'mask';

export type MaskShape = 'rect' | 'ellipse';

export interface MaskParams {
  shape: MaskShape;
  /** 左上角（0..1）。 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 羽化宽度（0..0.5，相对短边）。 */
  feather: number;
  /** 反向（保留外面、挖掉里面）。 */
  invert: boolean;
}

export const DEFAULT_MASK: MaskParams = {
  shape: 'rect',
  x: 0.15,
  y: 0.15,
  w: 0.7,
  h: 0.7,
  feather: 0.05,
  invert: false,
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * 取某一帧的蒙版参数：静态值 + 关键帧覆盖。
 *
 * `offsetFrames` 是**相对片段起点**的帧号（关键帧的 frame 也是这个口径）。
 * 关键帧属性名用 `mask.x` / `mask.y` / `mask.w` / `mask.h`。
 */
export function maskOf(clip: Clip, offsetFrames: Frame = 0): MaskParams | null {
  const effect = clip.effects.find((item) => item.type === MASK_EFFECT && item.enabled);
  if (effect === undefined) return null;
  const num = (key: string, fallback: number): number => {
    const raw = effect.params[key];
    return typeof raw === 'number' && Number.isFinite(raw) ? clamp01(raw) : fallback;
  };
  const params: MaskParams = {
    shape: effect.params['shape'] === 'ellipse' ? 'ellipse' : 'rect',
    x: num('x', DEFAULT_MASK.x),
    y: num('y', DEFAULT_MASK.y),
    w: num('w', DEFAULT_MASK.w),
    h: num('h', DEFAULT_MASK.h),
    feather: Math.min(0.5, num('feather', DEFAULT_MASK.feather)),
    invert: effect.params['invert'] === 1,
  };
  // 关键帧覆盖（有就打点值，没有就保留静态值）
  for (const key of ['x', 'y', 'w', 'h'] as const) {
    const keyed = sampleKeyframes(
      effect.keyframes.filter((point) => point.property === `mask.${key}`),
      offsetFrames,
    );
    if (keyed !== null) params[key] = clamp01(keyed);
  }
  return params;
}

/**
 * 蒙版在归一化坐标 (u,v) 处的 alpha（0 = 完全遮住，1 = 完全显示）。
 *
 * 与着色器里的 `maskAlpha` 是同一套公式（两边必须一起改）。
 */
export function maskAlphaAt(u: number, v: number, mask: MaskParams): number {
  const feather = Math.max(1e-4, mask.feather);
  let distance: number;
  if (mask.shape === 'ellipse') {
    // 椭圆：把坐标归一化到以中心为原点的椭圆空间，半径 1 为边界
    const cx = mask.x + mask.w / 2;
    const cy = mask.y + mask.h / 2;
    const nx = (u - cx) / Math.max(1e-4, mask.w / 2);
    const ny = (v - cy) / Math.max(1e-4, mask.h / 2);
    distance = 1 - Math.sqrt(nx * nx + ny * ny);
  } else {
    // 矩形：到四条边的最小距离（内部为正）
    distance = Math.min(u - mask.x, mask.x + mask.w - u, v - mask.y, mask.y + mask.h - v);
  }
  // 软边：distance 从 0 到 feather 线性过渡（与 smoothstep 同形）
  const t = Math.min(1, Math.max(0, distance / feather));
  const alpha = t * t * (3 - 2 * t);
  return mask.invert ? 1 - alpha : alpha;
}

/**
 * 自然语言 → 蒙版参数（R-056 的"自然语言描述区域"）。
 *
 * ## 语义（**这里曾经反了，改的时候别改回去**）
 *
 * `maskAlphaAt` 的口径是"**区域内保留、区域外遮住**"（标准蒙版语义）。
 * 所以同一个区域词配上不同动词，含义正好相反：
 *
 * - "**遮住**左边" = 把左边挖掉 → 区域=左半 + `invert: true`
 * - "**只露**左边" = 只留左边   → 区域=左半 + `invert: false`
 *
 * 2026-10-21 复核发现旧实现一律 `invert: false`：说"遮住左边"，实际露出的是左边、
 * 遮住的是右边。E2E 只断言"平均亮度掉一半"，两种结果都满足，所以一直没被抓到
 * （现在 verify-mask 改成分别量左右半）。
 *
 * 只认方位词，认不出返回 null（不瞎猜）。
 */
export function maskFromPhrase(text: string): MaskParams | null {
  const wantsMask = /(蒙版|遮罩|遮住|盖住|只露|只留|露出|裁掉|挖掉)/.test(text);
  if (!wantsMask) return null;
  const base = { ...DEFAULT_MASK };
  // "只露/只留/露出/显示" = 保留区域；其余（遮住/盖住/裁掉/挖掉）= 挖掉区域
  const keep = /(只露|只留|保留|露出|显示)/.test(text);
  let region: Pick<MaskParams, 'x' | 'y' | 'w' | 'h'> | null = null;
  if (/(左边|左侧|左半)/.test(text)) region = { x: 0, y: 0, w: 0.5, h: 1 };
  else if (/(右边|右侧|右半)/.test(text)) region = { x: 0.5, y: 0, w: 0.5, h: 1 };
  else if (/(上半|上面一半|顶部)/.test(text)) region = { x: 0, y: 0, w: 1, h: 0.5 };
  else if (/(下半|下面一半|底部)/.test(text)) region = { x: 0, y: 0.5, w: 1, h: 0.5 };
  else if (/(中间|中心)/.test(text)) region = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  if (region === null) return null;
  return { ...base, ...region, invert: !keep };
}
