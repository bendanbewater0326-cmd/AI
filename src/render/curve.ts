/**
 * 曲线调色（R-055）：4 个控制点的分段线性曲线，作用在 RGB 上。
 *
 * ## 为什么是"分段线性 4 点"而不是样条
 *
 * 样条（Catmull-Rom / 单调三次）要解方程、要处理过冲，而着色器里每像素都要算一遍。
 * 4 点分段线性（端点固定 0/0 与 1/1，中间两点可调）已经能表达"提亮暗部 / 压高光 / 加对比"，
 * 且**实现与验证都简单**：JS 与 GLSL 各自 10 行，公式一致，不会漂。
 *
 * ## 与调色的关系
 *
 * 调色（brightness/contrast/saturation/temperature）是"线性 + 混色"，曲线是"任意映射"。
 * 顺序上**先调色后曲线**：用户调完滑块再用曲线收口，符合直觉；反过来会让滑块的非线性更难预测。
 */
import type { Clip } from '../core/types';

export interface CurveParams {
  /** 第一个控制点（暗部）：x 在 0..1，y 在 0..1。 */
  x1: number;
  y1: number;
  /** 第二个控制点（亮部）。 */
  x2: number;
  y2: number;
}

export const CURVE_EFFECT = 'curve';
/** 恒等曲线：y = x。 */
export const NEUTRAL_CURVE: CurveParams = { x1: 0.25, y1: 0.25, x2: 0.75, y2: 0.75 };

/** 是否等于恒等（是则跳过 uniform 设置）。 */
export function isNeutralCurve(curve: CurveParams): boolean {
  return (
    Math.abs(curve.x1 - curve.y1) < 1e-6 &&
    Math.abs(curve.x2 - curve.y2) < 1e-6
  );
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 从片段的 effects 里取曲线（没有/被禁用返回 null）。 */
export function curveOf(clip: Clip): CurveParams | null {
  const effect = clip.effects.find((item) => item.type === CURVE_EFFECT && item.enabled);
  if (effect === undefined) return null;
  const num = (key: string, fallback: number): number => {
    const raw = effect.params[key];
    return typeof raw === 'number' && Number.isFinite(raw) ? clamp01(raw) : fallback;
  };
  const curve: CurveParams = {
    x1: num('x1', NEUTRAL_CURVE.x1),
    y1: num('y1', NEUTRAL_CURVE.y1),
    x2: num('x2', NEUTRAL_CURVE.x2),
    y2: num('y2', NEUTRAL_CURVE.y2),
  };
  // x 必须递增，否则分母为 0（脏数据兜底）
  if (curve.x2 <= curve.x1) {
    curve.x1 = Math.min(curve.x1, 0.49);
    curve.x2 = Math.max(curve.x2, curve.x1 + 0.01);
  }
  return curve;
}

/**
 * 求曲线在 `v` 处的值（与着色器里的 `curveChannel` 同一套公式）。
 *
 * 三段：`[0,x1]`、`[x1,x2]`、`[x2,1]`，端点固定 (0,0) 与 (1,1)。
 */
export function applyCurveValue(v: number, curve: CurveParams): number {
  const x = clamp01(v);
  const { x1, y1, x2, y2 } = curve;
  if (x <= x1) {
    return x1 <= 1e-6 ? y1 : (x / x1) * y1;
  }
  if (x <= x2) {
    const span = Math.max(1e-6, x2 - x1);
    return y1 + ((x - x1) / span) * (y2 - y1);
  }
  const span = Math.max(1e-6, 1 - x2);
  return y2 + ((x - x2) / span) * (1 - y2);
}

/**
 * 自然语言 → 曲线参数（R-055 的"自然语言生成曲线参数"）。
 *
 * 只认三组常见诉求，并且**只改 y**（x 保持 0.25/0.75）：
 * 用户说"更亮"时想要的是"暗部抬起来"，不是"控制点横坐标变了"。
 */
export function curveFromPhrase(text: string): CurveParams | null {
  const wantsContrast = /(对比|反差|层次)/.test(text);
  const stronger = /(强|高|加大|提高|更硬)/.test(text);
  const weaker = /(弱|低|减小|降低|更柔|平)/.test(text);
  const brighter = /(亮|提亮|通透)/.test(text) && !/(暗)/.test(text);
  const darker = /(暗|压暗|沉)/.test(text);

  if (wantsContrast) {
    if (stronger) return { x1: 0.25, y1: 0.16, x2: 0.75, y2: 0.84 };
    if (weaker) return { x1: 0.25, y1: 0.32, x2: 0.75, y2: 0.68 };
    return null;
  }
  if (brighter) return { x1: 0.25, y1: 0.34, x2: 0.75, y2: 0.82 };
  if (darker) return { x1: 0.25, y1: 0.16, x2: 0.75, y2: 0.68 };
  return null;
}
