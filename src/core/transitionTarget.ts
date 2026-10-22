/**
 * 转场落点与时长（纯函数）。
 *
 * ## 为什么单独抽出来
 *
 * 三条规则最容易写错，而且都要穷举边界：
 * 1. **某帧上是哪个片段** —— 半开区间（起点算、终点不算），差一帧就会选错片段；
 * 2. **"左侧紧邻"是严格相等** —— `endOf(prev) === clip.startFrame`，有 1 帧缝隙就不算。
 *    渲染层 `transitionPlan` 找左邻用的就是这个判据，两边必须一致，
 *    否则会出现"面板说能叠化、渲染时找不到左邻"；
 * 3. **两侧互斥** —— 同一个片段同时有 in/out 时，`transitionPlan` 取 `min(opacity)`，
 *    表现是"转场看起来很弱"。所以设一侧就清另一侧，且必须**同一次 dispatch**。
 *
 * 做成纯函数就能在 Node 里把这些边界全跑一遍（`tests/transition-target.test.mjs`）。
 */
import type { Clip, ClipOperation, Frame, MilliFps, Project, Track, Transition } from './types';
import { maxTransitionFrames } from './types';
import { secondsToFrames } from './timebase';
import type { TransitionPreset } from './transitionPresets';

/** 片段结束帧（不含）。 */
function endOf(clip: Clip): Frame {
  return clip.startFrame + clip.durationFrames;
}

/** 某帧上这条轨是哪个片段（半开区间 `[start, end)`）。 */
export function clipAtFrame(track: Track, frame: Frame): Clip | null {
  for (const clip of track.clips) {
    if (frame >= clip.startFrame && frame < endOf(clip)) return clip;
  }
  return null;
}

/**
 * 左侧**严格紧邻**的片段（`endOf(prev) === clip.startFrame`）。
 *
 * 与 `media/transitionPlan.ts` 里找 previous 的判据完全一致 —— 这条规则只能有一份实现，
 * 两处不一致会得到"面板允许叠化、渲染时却找不到左邻"。
 */
export function previousAdjacent(track: Track, clip: Clip): Clip | null {
  const candidates = track.clips
    .filter((item) => item.id !== clip.id && endOf(item) === clip.startFrame)
    .sort((left, right) => right.startFrame - left.startFrame);
  return candidates[0] ?? null;
}

/**
 * 时长换算 + 夹取：`min(秒 → 帧, maxTransitionFrames(clip))`。
 *
 * 上限是**片段时长的一半**（`maxTransitionFrames`）：转场窗口以接缝为中心，
 * 超过一半的话进出转场会互相覆盖，中间永远到不了不透明。
 * 右侧属性栏与左栏面板共用这一个函数，避免两处各夹一次、边界还不一样。
 */
export function resolveDuration(seconds: number, clip: Clip, fpsMilli: MilliFps): Frame {
  const requested = Math.max(1, secondsToFrames(Math.max(0.05, seconds), fpsMilli));
  return Math.min(requested, maxTransitionFrames(clip));
}

export interface TransitionTarget {
  clipId: string;
  side: 'in' | 'out';
  /** 已夹到该片段允许的上限 */
  durationFrames: Frame;
}

/**
 * 把落点吸附到附近的**接缝**（某个片段的起点）。
 *
 * 为什么拖拽需要它：叠化/淡入要挂在**右侧**片段的入点，而鼠标稍微偏左一点点，
 * `clipAtFrame` 就会命中左边那段 —— 叠化会去找左段的左邻，很可能直接判"不可用"。
 * 吸附一下，用户"大概放在接缝上"就能落对。
 *
 * 容差由调用方按像素换算成帧（时间线用 12px / zoom）。
 */
export function snapToSeam(track: Track, frame: Frame, toleranceFrames: Frame): Frame {
  let best: Frame | null = null;
  for (const clip of track.clips) {
    const delta = Math.abs(clip.startFrame - frame);
    if (delta > toleranceFrames) continue;
    if (best === null || delta < Math.abs(best - frame)) best = clip.startFrame;
  }
  return best ?? frame;
}

/**
 * 落点 → 转场目标（带可读原因）。
 *
 * `frame` 是落点帧：点击场景传播放头，拖拽场景传鼠标换算的帧。
 * 落在两个片段的接缝上时，`clipAtFrame` 会选中**右侧**那一段（半开区间），
 * 这正是叠化/淡入要挂的那一侧。
 */
export function resolveTransitionTarget(
  doc: Project,
  track: Track,
  frame: Frame,
  preset: TransitionPreset,
  seconds: number,
): TransitionTarget | { message: string } {
  const clip = clipAtFrame(track, frame);
  if (clip === null) return { message: '这里没有片段：转场要落在片段上' };
  if (preset.needsPrevious && previousAdjacent(track, clip) === null) {
    return { message: `${preset.name}需要左侧紧挨着一段素材（中间不能有空隙）` };
  }
  return {
    clipId: clip.id,
    side: preset.side,
    durationFrames: resolveDuration(seconds, clip, doc.fpsMilli),
  };
}

/**
 * 构造"设置某一侧转场"的操作（**两侧互斥**，同一次 dispatch = 一个撤销步）。
 *
 * 先清两侧、再按需设置。已经是要设置的那个值、且另一侧为空时返回空数组（不发无用撤销步）。
 */
export function buildTransitionOps(
  clip: Clip,
  side: 'in' | 'out',
  next: Transition | null,
): ClipOperation[] {
  const sameSide = side === 'in' ? clip.transitionIn : clip.transitionOut;
  const otherSide = side === 'in' ? clip.transitionOut : clip.transitionIn;
  if (
    next !== null &&
    otherSide === null &&
    sameSide !== null &&
    sameSide.type === next.type &&
    sameSide.durationFrames === next.durationFrames
  ) {
    return [];
  }
  const ops: ClipOperation[] = [];
  if (clip.transitionIn !== null) {
    ops.push({ op: 'setClipTransition', clipId: clip.id, side: 'in', from: clip.transitionIn, to: null });
  }
  if (clip.transitionOut !== null) {
    ops.push({ op: 'setClipTransition', clipId: clip.id, side: 'out', from: clip.transitionOut, to: null });
  }
  if (next !== null) {
    ops.push({ op: 'setClipTransition', clipId: clip.id, side, from: null, to: next });
  }
  return ops;
}

/** 该片段当前生效的转场（用于面板卡片高亮；两侧只可能有一侧）。 */
export function currentTransition(clip: Clip): { side: 'in' | 'out'; transition: Transition } | null {
  if (clip.transitionIn !== null) return { side: 'in', transition: clip.transitionIn };
  if (clip.transitionOut !== null) return { side: 'out', transition: clip.transitionOut };
  return null;
}

/** 在工程里按 id 找片段（面板/拖拽用）。 */
export function findClipById(doc: Project, clipId: string): { clip: Clip; track: Track } | null {
  for (const track of doc.tracks) {
    const clip = track.clips.find((item) => item.id === clipId);
    if (clip !== undefined) return { clip, track };
  }
  return null;
}
