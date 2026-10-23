/**
 * 字幕面板的纯逻辑层（C1）。
 *
 * ## 为什么单独成文件
 *
 * 字幕面板要做的事（列表 / 编辑文本 / 改时间 / 合并 / 平移 / 批量样式）全部是
 * **"给定当前 doc，算出一批 ClipOperation"** —— 没有 DOM、没有 store 副作用。
 * 抽成纯函数后：
 * - 单测直接跑（不必起浏览器）
 * - UI 只负责"取值 + dispatch"，规则只有一份
 *
 * 和 `core/adjust.ts` 同一个思路，区别是 adjust 需要读全局 store（因为要写效果），
 * 这里连 store 都不需要 —— 调用方把 doc 传进来。
 *
 * ## 数据同源，不造第二份
 *
 * 字幕就是**文字片段**（`clip.text !== null` + `text` 轨），与「文本」面板完全同源。
 * 判据用全项目统一的那一条（`effectTarget` / `preset` / `playbackEngine` 也都是它），
 * 不在这里自创"什么算字幕"。
 *
 * ## 改时间的两个陷阱
 *
 * 1. **文字片段的 `outFrame` 必须等于 `durationFrames`**（inFrame 恒为 0）。
 *    只改 durationFrames 而不改 outFrame，会让 `mapProjectFrameToAssetFrame` 算出越界帧。
 * 2. **同轨不能重叠**：两条字幕时间交叠 = 两行字叠着画，谁都看不清。
 *    改时间和合并都要检查（`overlapsOthers`）。
 */
import type { Clip, ClipOperation, Frame, Project, Result, TextContent, TextOrigin } from './types';
import { fail, makeError, ok } from './types';

/* ---------------- 列表 ---------------- */

export interface CaptionRow {
  clipId: string;
  text: string;
  startFrame: Frame;
  durationFrames: Frame;
  /** 来源（决定列表角标）：手动 / SRT 导入 / AI 转写。 */
  origin: TextOrigin;
}

/**
 * 取文字片段的**来源**。
 *
 * 这是"什么来源算哪种"的**唯一判断点**（UI 不要自己再判一次）。
 *
 * - 新数据：`text.origin` 显式写了，直接用；
 * - 旧工程：没有这个字段 → 按 `clip.source` 推断（`ai` → 'ai'，其余 'manual'）。
 *
 * ⚠️ 旧工程里**由 SRT 导入的字幕会被推断成 'manual'**：那个年代没记录来源，
 * 事后无法还原（除非按"同一次导入的字幕字号/颜色一致"猜，太脆弱，不做）。
 * 这是已知限制，比"乱猜"可靠。
 */
export function captionOrigin(clip: Clip): TextOrigin {
  const explicit = clip.text?.origin;
  if (explicit === 'manual' || explicit === 'caption' || explicit === 'ai') return explicit;
  return clip.source === 'ai' ? 'ai' : 'manual';
}

/** 列出所有字幕/文字片段，**按起点升序**（同起点按轨道顺序，保证稳定）。 */
export function listCaptions(doc: Project): CaptionRow[] {
  const rows: CaptionRow[] = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.text === null || clip.text === undefined) continue;
      rows.push({
        clipId: clip.id,
        text: clip.text.content,
        startFrame: clip.startFrame,
        durationFrames: clip.durationFrames,
        origin: captionOrigin(clip),
      });
    }
  }
  rows.sort((left, right) => left.startFrame - right.startFrame || left.clipId.localeCompare(right.clipId));
  return rows;
}

/** 找一条字幕片段（不是文字片段就返回 null）。 */
export function findCaption(doc: Project, clipId: string): Clip | null {
  for (const track of doc.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip !== undefined) return clip.text === null || clip.text === undefined ? null : clip;
  }
  return null;
}

/* ---------------- 改文本 ---------------- */

/** 改一条字幕的文本（一个 `setClipText`）。空文本拒绝 —— 空字幕在时间线上是不可见的黑洞。 */
export function buildEditTextOps(clip: Clip, text: string): Result<ClipOperation[]> {
  if (clip.text === null || clip.text === undefined) {
    return fail(makeError('E_INVALID_TIMECODE', '这个片段不是文字/字幕'));
  }
  const trimmed = text.trim();
  if (trimmed === '') {
    return fail(makeError('E_INVALID_TIMECODE', '字幕内容不能为空（要删就删整条）'));
  }
  if (trimmed === clip.text.content) return ok([]);
  return ok([
    {
      op: 'setClipText',
      clipId: clip.id,
      from: clip.text,
      to: { ...clip.text, content: trimmed },
    },
  ]);
}

/* ---------------- 改时间 ---------------- */

/** 同轨（`text` 轨）上与这条时间交叠的其它片段。 */
function overlapsOthers(doc: Project, clip: Clip, start: Frame, duration: Frame): boolean {
  const end = start + duration;
  for (const track of doc.tracks) {
    if (track.id !== clip.trackId) continue;
    for (const other of track.clips) {
      if (other.id === clip.id) continue;
      const otherEnd = other.startFrame + other.durationFrames;
      if (start < otherEnd && other.startFrame < end) return true;
    }
  }
  return false;
}

/**
 * 改一条字幕的起止时间（`trimClip`）。
 *
 * **`outFrame` 必须跟着 `durationFrames` 一起改**：文字片段没有素材，
 * `inFrame` 恒为 0、`outFrame` 恒等于 `durationFrames`。只改一个会让
 * 时基映射算出越界帧（文字不取素材帧，但 `clipSpan` / 导出的时长判定会读它）。
 */
export function buildRetimeOps(
  clip: Clip,
  startFrame: Frame,
  durationFrames: Frame,
  doc: Project,
): Result<ClipOperation[]> {
  if (clip.text === null || clip.text === undefined) {
    return fail(makeError('E_INVALID_TIMECODE', '这个片段不是文字/字幕'));
  }
  const start = Math.max(0, Math.round(startFrame));
  const duration = Math.max(1, Math.round(durationFrames));
  if (start === clip.startFrame && duration === clip.durationFrames) return ok([]);
  if (overlapsOthers(doc, clip, start, duration)) {
    return fail(makeError('E_INVALID_TIMECODE', '新时间与其它字幕重叠（两条字幕不能同时出现）'));
  }
  return ok([
    {
      op: 'trimClip',
      clipId: clip.id,
      from: {
        inFrame: clip.inFrame,
        outFrame: clip.outFrame,
        startFrame: clip.startFrame,
        durationFrames: clip.durationFrames,
      },
      to: { inFrame: 0, outFrame: duration, startFrame: start, durationFrames: duration },
    },
  ]);
}

/* ---------------- 合并 ---------------- */

/**
 * 合并多条字幕成一条。
 *
 * 文本用**空格**拼接（中文不加分隔符会粘在一起，英文不加会连成一个词）；
 * 时间取"最早起点 → 最晚结束"的并集。要求：至少 2 条、都在同一轨。
 */
export function buildMergeOps(clips: readonly Clip[], doc: Project): Result<ClipOperation[]> {
  if (clips.length < 2) {
    return fail(makeError('E_INVALID_TIMECODE', '至少选两条字幕才能合并'));
  }
  const trackIds = new Set(clips.map((clip) => clip.trackId));
  if (trackIds.size > 1) {
    return fail(makeError('E_INVALID_TIMECODE', '只能合并同一条轨上的字幕'));
  }
  for (const clip of clips) {
    if (clip.text === null || clip.text === undefined) {
      return fail(makeError('E_INVALID_TIMECODE', '选中的片段里有不是字幕的'));
    }
  }
  const sorted = [...clips].sort((left, right) => left.startFrame - right.startFrame);
  const first = sorted[0]!;
  const start = first.startFrame;
  const end = Math.max(...sorted.map((clip) => clip.startFrame + clip.durationFrames));

  // 合并后的时间跨度不能压到"没选中"的其它字幕上（否则两条字幕叠着画）。
  // 注意要排除被合并的这些自己 —— 它们中间的空隙本来就是合法的。
  const selectedIds = new Set(sorted.map((clip) => clip.id));
  for (const track of doc.tracks) {
    if (track.id !== first.trackId) continue;
    for (const other of track.clips) {
      if (selectedIds.has(other.id)) continue;
      const otherEnd = other.startFrame + other.durationFrames;
      if (start < otherEnd && other.startFrame < end) {
        return fail(makeError('E_INVALID_TIMECODE', '合并后的时间会盖到其它字幕（先挪开或一并选中）'));
      }
    }
  }
  const content = sorted
    .map((clip) => (clip.text as TextContent).content.trim())
    .filter((text) => text !== '')
    .join(' ');

  const ops: ClipOperation[] = [];
  for (const clip of sorted) ops.push({ op: 'removeClip', clipId: clip.id, removed: clip });
  const template = first.text as TextContent;
  ops.push({
    op: 'addClip',
    clip: {
      ...first,
      // 新 id 由调用方无法预知，这里用确定性的派生 id（同一次操作内唯一即可）
      id: `clp_merged_${first.id}`,
      startFrame: start,
      inFrame: 0,
      outFrame: end - start,
      durationFrames: end - start,
      text: { ...template, content },
    },
  });
  return ok(ops);
}

/* ---------------- 批量平移 ---------------- */

/**
 * 批量平移（`rippleShift`）：整组字幕整体前后移动。
 *
 * **只挪起点、不改时长**——这条是"对齐音频"用的，改时长会变成另一件事。
 * 平移后最小起点不能小于 0（否则第一条会被钳在 0，其余照常前移，字幕就挤在一起了）。
 */
export function buildShiftOps(
  clips: readonly Clip[],
  deltaFrames: Frame,
  _doc: Project,
): Result<ClipOperation[]> {
  if (clips.length === 0) return fail(makeError('E_INVALID_TIMECODE', '没有选中字幕'));
  const delta = Math.round(deltaFrames);
  if (delta === 0) return ok([]);
  const minStart = Math.min(...clips.map((clip) => clip.startFrame));
  if (minStart + delta < 0) {
    return fail(makeError('E_INVALID_TIMECODE', `不能前移 ${Math.abs(delta) - minStart} 帧以上（第一条会跑到 0 之前）`));
  }
  return ok([
    {
      op: 'rippleShift',
      shifts: clips.map((clip) => ({
        clipId: clip.id,
        from: clip.startFrame,
        to: clip.startFrame + delta,
      })),
    },
  ]);
}

/* ---------------- 批量样式 ---------------- */

/**
 * 批量改样式（字号 / 颜色 / 对齐 / 底衬 / 粗体 / 描边）。
 *
 * 逐条 `setClipText`：一条字幕一个 op，同一次 dispatch 里 = **一个撤销步**。
 * 只带被改的字段（`patch`），其余保持各条自己的值 —— 批量改字号不该顺手把颜色统一掉。
 */
export function buildBatchStyleOps(
  clips: readonly Clip[],
  patch: Partial<TextContent>,
): ClipOperation[] {
  const ops: ClipOperation[] = [];
  for (const clip of clips) {
    if (clip.text === null || clip.text === undefined) continue;
    ops.push({
      op: 'setClipText',
      clipId: clip.id,
      from: clip.text,
      to: { ...clip.text, ...patch },
    });
  }
  return ops;
}

/* ---------------- 时间码（毫秒口径） ---------------- */

// 毫秒 ↔ `HH:MM:SS.mmm` 的实现在 `core/timebase.ts`（`formatMs` / `parseMs`）。
// 不放这里是因为 `check-timebase` 守卫禁止其它文件出现"与时间标识符同现的 1000 缩放"，
// 而时分秒进位正是那种运算 —— 这是守卫在履行职责，不是绕路。
export { formatMs as formatCaptionMs, parseMs as parseCaptionMs } from './timebase';
