/**
 * 片段剪贴板（R-039）：复制/粘贴保留片段全部属性，粘贴落点为播放头。
 *
 * ## 三条约定
 *
 * 1. **保留相对位置**：复制多段后粘贴，它们之间的相对间隔不变（以最早的一段为 0）。
 * 2. **粘贴到同一轨道**；原轨道不存在时退到第一条同类型轨道（视频→视频轨，音频→音轨）。
 * 3. **不允许重叠**：目标位置与已有片段冲突时，向后挪到冲突片段的末尾。
 *    不做"跳过"——用户按了粘贴却少一段，比位置被挪更难理解。
 *
 * 剪贴板是进程内内存（刷新即失效），不写 IndexedDB：跨会话粘贴系统剪贴板里的片段
 * 需要序列化协议，属于 M5 的"工程文件迁出"范畴，不在本轮。
 */
import type { Clip, Project } from './types';
import { createId } from './types';

interface ClipboardEntry {
  clip: Clip;
  trackId: string;
  /** 相对复制集中最早片段的起始帧偏移。 */
  offset: Frame;
}

type Frame = number;

let entries: ClipboardEntry[] = [];

/** 深拷贝片段（纯数据，JSON 足够；避免共享 effects/keyframes 数组引用）。 */
function cloneClip(clip: Clip): Clip {
  return JSON.parse(JSON.stringify(clip)) as Clip;
}

/** 复制选中的片段；返回复制的段数。 */
export function copyClips(doc: Project, clipIds: readonly string[]): number {
  const found: Array<{ clip: Clip; trackId: string }> = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clipIds.includes(clip.id)) found.push({ clip, trackId: track.id });
    }
  }
  if (found.length === 0) return 0;
  const minStart = Math.min(...found.map((item) => item.clip.startFrame));
  entries = found.map((item) => ({
    clip: cloneClip(item.clip),
    trackId: item.trackId,
    offset: item.clip.startFrame - minStart,
  }));
  return entries.length;
}

export function clipboardSize(): number {
  return entries.length;
}

export function clearClipboard(): void {
  entries = [];
}

/** 目标轨道上与该区间冲突的片段结束帧（无冲突返回 null）。 */
function conflictEnd(clips: readonly Clip[], ignoreIds: readonly string[], start: number, duration: number): number | null {
  let latest: number | null = null;
  for (const clip of clips) {
    if (ignoreIds.includes(clip.id)) continue;
    const end = clip.startFrame + clip.durationFrames;
    if (start < end && start + duration > clip.startFrame) {
      latest = latest === null ? end : Math.max(latest, end);
    }
  }
  return latest;
}

export interface PasteResult {
  ops: Array<{ op: 'addClip'; clip: Clip }>;
  clipIds: string[];
}

/**
 * 计算粘贴操作（纯函数，不写 store）。
 *
 * 拆出来是为了能在 Node 里单测"重叠后移""轨道回退"这些分支，
 * 不必起浏览器。
 */
export function buildPasteOperations(doc: Project, atFrame: number): PasteResult {
  const ops: PasteResult['ops'] = [];
  const clipIds: string[] = [];
  if (entries.length === 0) return { ops, clipIds };

  // 模拟轨道现状（含本次已排入的片段），保证多段粘贴之间也不重叠
  const trackState = new Map<string, Clip[]>();
  for (const track of doc.tracks) trackState.set(track.id, [...track.clips]);

  for (const entry of [...entries].sort((left, right) => left.offset - right.offset)) {
    const sourceTrack = doc.tracks.find((track) => track.id === entry.trackId);
    const fallback = doc.tracks.find((track) => track.kind === (sourceTrack?.kind ?? 'video'));
    const target = sourceTrack ?? fallback;
    if (target === undefined) continue;

    const clips = trackState.get(target.id) ?? [];
    let start = Math.max(0, atFrame + entry.offset);
    // 冲突就往后贴到冲突片段末尾，直到不冲突
    for (let guard = 0; guard < 100; guard += 1) {
      const end = conflictEnd(clips, [], start, entry.clip.durationFrames);
      if (end === null) break;
      start = end;
    }

    const clip: Clip = {
      ...cloneClip(entry.clip),
      id: createId('clp'),
      trackId: target.id,
      startFrame: start,
      source: 'ui',
    };
    clips.push(clip);
    trackState.set(target.id, clips);
    ops.push({ op: 'addClip', clip });
    clipIds.push(clip.id);
  }

  return { ops, clipIds };
}
