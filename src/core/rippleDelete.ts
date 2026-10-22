/**
 * 波纹删除（R-060 粗剪的落地方式）：把一条轨上的 `[start, end)` 整段拿掉，后面的内容左移补齐。
 *
 * ## 为什么不用 `compileRemoveRange`
 *
 * 那个函数解决的是"剪掉某个**片段内**的一段"，头尾两种情况的语义是"只改素材入/出点"——
 * 剪尾会让片段变短、**后面留空**。粗剪要的是"停顿没了、内容接上来"，
 * 所以这里统一走：**切两刀 → 删中间 → 整条轨后面全部左移**。
 *
 * 对单个片段，两者结果一致；对"停顿横跨两个相邻片段"的情况，只有这里能合拢接缝。
 *
 * ## 顺序与守恒
 *
 * 调用方必须**从后往前**处理多个区间（倒序），否则前一次的左移会让后面区间的帧号失效。
 * 本函数内部每一步都用 `applyOperation` 推进模拟态，因此返回的 ops 是**自洽的一串**，
 * 一次性 `dispatch` 就是一个撤销步。
 */
import { buildSplitOperations } from './keymap';
import { applyOperation } from './operations';
import type { Clip, ClipOperation, Frame, Project, Track } from './types';

function trackOf(doc: Project, trackId: string): Track | null {
  return doc.tracks.find((track) => track.id === trackId) ?? null;
}

/** 取覆盖该帧的片段（`start <= frame < start + duration`）。 */
function clipCovering(track: Track, frame: Frame): Clip | null {
  for (const clip of track.clips) {
    if (clip.startFrame <= frame && frame < clip.startFrame + clip.durationFrames) return clip;
  }
  return null;
}

/**
 * 生成"波纹删除 `[startFrame, endFrame)`"的操作序列（已按顺序在内部模拟校验过）。
 *
 * 返回空数组表示**这里没有可删的东西**（整段落在空白区、或切点切不动，
 * 例如文本片段没有素材帧可以切）。调用方应把它当成"跳过"，而不是失败。
 */
export function buildRippleDeleteOps(
  doc: Project,
  trackId: string,
  startFrame: Frame,
  endFrame: Frame,
): ClipOperation[] {
  if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame)) return [];
  if (endFrame <= startFrame || startFrame < 0) return [];

  let sim = doc;
  const ops: ClipOperation[] = [];

  // 1) 在起点切一刀（起点正好落在片段边界时不用切）
  const beforeTrack = trackOf(sim, trackId);
  if (beforeTrack === null) return [];
  const head = clipCovering(beforeTrack, startFrame);
  if (head !== null && head.startFrame < startFrame) {
    const split = buildSplitOperations(sim, startFrame, head.id);
    if (split.length === 0) return [];
    for (const op of split) sim = applyOperation(sim, op);
    ops.push(...split);
  }

  // 2) 在终点切一刀（终点是独占边界；正好等于某片段起点时不用切）
  const midTrack = trackOf(sim, trackId);
  if (midTrack === null) return [];
  const tail = clipCovering(midTrack, endFrame);
  if (tail !== null && tail.startFrame < endFrame) {
    const split = buildSplitOperations(sim, endFrame, tail.id);
    if (split.length === 0) return [];
    for (const op of split) sim = applyOperation(sim, op);
    ops.push(...split);
  }

  // 3) 删掉完全落在区间内的片段
  const spannedTrack = trackOf(sim, trackId);
  if (spannedTrack === null) return [];
  const doomed = spannedTrack.clips.filter(
    (clip) => clip.startFrame >= startFrame && clip.startFrame + clip.durationFrames <= endFrame,
  );
  if (doomed.length === 0) return [];
  for (const clip of doomed) {
    const op: ClipOperation = { op: 'removeClip', clipId: clip.id, removed: clip };
    sim = applyOperation(sim, op);
    ops.push(op);
  }

  // 4) 区间之后的片段整体左移，补上空洞
  const afterTrack = trackOf(sim, trackId);
  if (afterTrack === null) return ops;
  const span = endFrame - startFrame;
  const shifts = afterTrack.clips
    .filter((clip) => clip.startFrame >= endFrame)
    .map((clip) => ({ clipId: clip.id, from: clip.startFrame, to: clip.startFrame - span }));
  if (shifts.length > 0) {
    const op: ClipOperation = { op: 'rippleShift', shifts };
    sim = applyOperation(sim, op);
    ops.push(op);
  }
  return ops;
}
