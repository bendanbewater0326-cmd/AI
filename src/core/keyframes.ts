/**
 * 关键帧求值（R-038）：把「若干关键帧」变成「某一帧的属性值」。
 *
 * ## 规则（PRD 明写，必须照做）
 *
 * 1. **同一属性 ≥ 2 个关键帧才产生动画**——只有一个点时不生效，避免"打了一个点画面就跳"。
 * 2. 首尾之外取端点值（clamp），不外推。
 * 3. 区间内线性插值（`easing` 目前只有 linear）。
 *
 * ## 为什么是纯函数
 *
 * 预览、导出、音频三处都要用同一套求值：预览走 `playbackEngine`，导出复用同一个引擎，
 * 音频走 `audioEngine/audioMix`。任何一处另写一份插值，都会出现"画面在动、声音没动"这类
 * 极难归因的偏差。纯函数还能在 Node 里穷举边界（0 点 / 1 点 / 2 点 / 越界）。
 */
import type { Clip, Frame, Keyframe } from '../core/types';

/** 允许打关键帧的属性（白名单，AI 与 UI 共用）。 */
export type AnimatableProperty =
  | 'transform.scale'
  | 'transform.x'
  | 'transform.y'
  | 'transform.opacity'
  | 'audio.gain';

export const ANIMATABLE_PROPERTIES: readonly AnimatableProperty[] = [
  'transform.scale',
  'transform.x',
  'transform.y',
  'transform.opacity',
  'audio.gain',
];

/** 某个属性的关键帧（按帧号升序）。 */
export function keyframesFor(clip: Clip, property: AnimatableProperty): Keyframe[] {
  // `clip.keyframes` 类型上是必填，但**旧工程**（该字段加入前持久化的）恢复后是 undefined；
  // 手工构造的桩 clip（测试/导入中间态）同样可能缺字段。裸 `.filter` 会让播放/导出直接崩，
  // 这里统一兜底为空数组。
  return (clip.keyframes ?? [])
    .filter((point) => point.property === property)
    .sort((left, right) => left.frame - right.frame);
}

/** 属性在片段内某个偏移帧处的值；关键帧不足 2 个时返回 null（= 不参与动画）。 */
export function sampleKeyframes(points: readonly Keyframe[], offsetFrames: number): number | null {
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return null;
  if (offsetFrames <= first.frame) return first.value;
  if (offsetFrames >= last.frame) return last.value;

  for (let index = 0; index < points.length - 1; index += 1) {
    const left = points[index];
    const right = points[index + 1];
    if (left === undefined || right === undefined) continue;
    if (offsetFrames < left.frame || offsetFrames > right.frame) continue;
    const span = right.frame - left.frame;
    if (span <= 0) return right.value;
    const ratio = (offsetFrames - left.frame) / span;
    return left.value + (right.value - left.value) * ratio;
  }
  return last.value;
}

export interface AnimatedValues {
  scale?: number;
  x?: number;
  y?: number;
  opacity?: number;
  /** 音量倍数（0–2）；undefined = 该片段没有音量动画。 */
  gain?: number;
}

/**
 * 求某个项目帧处、该片段所有动画属性的值。
 *
 * @param projectFrame 项目帧（绝对）
 * @returns 只包含"确实有 ≥2 个关键帧"的属性
 */
export function animatedValuesAt(clip: Clip, projectFrame: Frame): AnimatedValues {
  const offset = projectFrame - clip.startFrame;
  const values: AnimatedValues = {};

  const scale = sampleKeyframes(keyframesFor(clip, 'transform.scale'), offset);
  if (scale !== null) values.scale = scale;
  const x = sampleKeyframes(keyframesFor(clip, 'transform.x'), offset);
  if (x !== null) values.x = x;
  const y = sampleKeyframes(keyframesFor(clip, 'transform.y'), offset);
  if (y !== null) values.y = y;
  const opacity = sampleKeyframes(keyframesFor(clip, 'transform.opacity'), offset);
  if (opacity !== null) values.opacity = opacity;
  const gain = sampleKeyframes(keyframesFor(clip, 'audio.gain'), offset);
  if (gain !== null) values.gain = gain;

  return values;
}

/** 该片段是否有任何动画（用于"块上显示关键帧图标"这类判断）。 */
export function hasAnimation(clip: Clip): boolean {
  const counts = new Map<string, number>();
  for (const point of clip.keyframes) {
    counts.set(point.property, (counts.get(point.property) ?? 0) + 1);
  }
  for (const count of counts.values()) {
    if (count >= 2) return true;
  }
  return false;
}

/** 在 `offsetFrames` 处精确存在关键帧时返回它（UI 的 ◆ 按钮用它判断实心/空心）。 */
export function keyframeAt(clip: Clip, property: AnimatableProperty, offsetFrames: number): Keyframe | null {
  return (
    clip.keyframes.find(
      (point) => point.property === property && point.frame === offsetFrames,
    ) ?? null
  );
}

/** 读取属性的静态值（没有动画时的基准值）。 */
export function staticValueOf(clip: Clip, property: AnimatableProperty): number {
  switch (property) {
    case 'transform.scale':
      return clip.transform.scale;
    case 'transform.x':
      return clip.transform.x;
    case 'transform.y':
      return clip.transform.y;
    case 'transform.opacity':
      return clip.transform.opacity;
    case 'audio.gain':
      return clip.audio.gain;
    default:
      return 0;
  }
}
