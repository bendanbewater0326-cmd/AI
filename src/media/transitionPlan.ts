/**
 * 转场编排（R-033）：纯函数，给定一帧算出"每个片段该以多少不透明度、用哪一帧素材"。
 *
 * ## 为什么用「冻结帧溶解」而不是"吃掉两侧内容"
 *
 * PRD 明确要求**转场不吃掉接缝两侧内容**。真要做"真素材溶解"，需要 A 的出点之后
 * 与 B 的入点之前还有可用素材（handle）；而 AI 生成的片段通常首尾就是内容的边界，
 * 强行向外取帧会取到不存在的素材，或者让 `mapProjectFrameToAssetFrame` 越界抛错。
 *
 * 这里的折中：转场窗口**以接缝为中心**（`[cut - D/2, cut + D/2)`），
 * - 窗口前半段：A 正常播放，B 冻在首帧淡入；
 * - 窗口后半段：A 冻在末帧淡出，B 正常播放。
 *
 * 也就是说每一侧都有一半时间在放真实内容，另一半是冻结帧，时间线长度与两侧内容都不变。
 * 代价是 0.5 秒的溶解里有一半是静帧——对短视频足够，且没有任何时基风险。
 *
 * ## 为什么单独成文件
 *
 * 这段逻辑是"在片段边界之外还要画一帧"，最容易写出越界素材帧。
 * 做成纯函数就能在 Node 里穷举边界（窗口前后一帧、首尾片段、无前序片段）。
 */
import type { Clip, Frame, Project } from '../core/types';
import { isTrackVisible } from '../core/trackAudibility';
import { maxTransitionFrames } from '../core/types';

export interface TransitionOverride {
  /** 乘在 `clip.transform.opacity` 上（0..1）。 */
  opacity: number;
  /** 非 null = 这一帧画这张冻结帧（片段边界之外）。 */
  frozenFrame: Frame | null;
}

/** 片段在轨道上的结束帧（exclusive）。 */
function endOf(clip: Clip): Frame {
  return clip.startFrame + clip.durationFrames;
}

/**
 * 计算本帧的转场覆盖表。
 *
 * 键是 clipId；没有条目 = 该片段按常规渲染（opacity 原值、素材帧按常规映射）。
 */
export function planTransitions(doc: Project, frame: Frame): Map<string, TransitionOverride> {
  const overrides = new Map<string, TransitionOverride>();

  const put = (clipId: string, next: TransitionOverride): void => {
    const current = overrides.get(clipId);
    if (current === undefined) {
      overrides.set(clipId, next);
      return;
    }
    // 同时命中淡入与淡出（极短片段）：取更小的不透明度，冻结帧优先保留已有
    overrides.set(clipId, {
      opacity: Math.min(current.opacity, next.opacity),
      frozenFrame: current.frozenFrame ?? next.frozenFrame,
    });
  };

  for (const track of doc.tracks) {
    // 与 `collectVisibleClips` 同一判据（隐藏 + 独奏让位）：否则独奏时
    // 转场的"边界外那一侧"还会被额外画进来，画面里出现本不该有的片段。
    if (!isTrackVisible(doc, track)) continue;
    for (const clip of track.clips) {
      const tIn = clip.transitionIn;
      // 兜底夹一次：工程文件/宿主通道可能送来"比片段还长"的转场。
      // 不夹的话窗口会越过片段边界，片段结束时进度还不到 1 → **永远半透明**。
      const limit = maxTransitionFrames(clip);
      if (tIn !== null && tIn.durationFrames > 0) {
        const duration = Math.min(tIn.durationFrames, limit);
        const windowStart = clip.startFrame - Math.floor(duration / 2);
        const windowEnd = windowStart + duration;
        if (frame >= windowStart && frame < windowEnd) {
          const progress = (frame - windowStart) / duration;
          put(clip.id, {
            opacity: progress,
            // 还没到片段起点：冻在首帧
            frozenFrame: frame < clip.startFrame ? clip.inFrame : null,
          });

          if (tIn.type === 'crossDissolve') {
            // 同一轨道上"正好接在这里"的前一个片段
            const previous = track.clips
              .filter((item) => item.id !== clip.id && endOf(item) === clip.startFrame)
              .sort((left, right) => right.startFrame - left.startFrame)[0];
            if (previous !== undefined) {
              put(previous.id, {
                opacity: 1 - progress,
                // 已经过了片段终点：冻在末帧
                frozenFrame: frame >= endOf(previous) ? Math.max(previous.inFrame, previous.outFrame - 1) : null,
              });
            }
          }
        }
      }

      const tOut = clip.transitionOut;
      if (tOut !== null && tOut.type === 'fadeOut' && tOut.durationFrames > 0) {
        const duration = Math.min(tOut.durationFrames, limit);
        const windowStart = endOf(clip) - duration;
        if (frame >= windowStart && frame < endOf(clip)) {
          const progress = (frame - windowStart) / duration;
          put(clip.id, { opacity: 1 - progress, frozenFrame: null });
        }
      }
    }
  }

  return overrides;
}

/** 找出覆盖表里"本帧本来不可见"的片段（需要额外画进来）。 */
export function clipsNeedingExtraDraw(doc: Project, frame: Frame, plan: Map<string, TransitionOverride>): Clip[] {
  const extra: Clip[] = [];
  for (const track of doc.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      if (!plan.has(clip.id)) continue;
      const visible = frame >= clip.startFrame && frame < endOf(clip);
      if (!visible) extra.push(clip);
    }
  }
  return extra;
}
