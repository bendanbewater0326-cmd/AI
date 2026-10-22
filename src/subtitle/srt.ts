/**
 * 字幕（R-059）：SRT 解析/生成 + 落到时间线。
 *
 * ## 为什么先做 SRT 而不是"语音识别"
 *
 * 语音识别需要 ASR 模型（本地跑不动，云端要额外通道）；而字幕功能真正的价值在于
 * **文本 → 时间线**这一步：拿到 SRT（外部工具/宿主模型生成）之后，导入、排布、替换、
 * 再导出去别处用，才是剪辑器该负责的部分。
 *
 * 明确边界：**不做语音识别**。要"一句话自动出字幕"，需要宿主提供转写能力
 * （`AIModelPort` 目前只有 `complete(prompt)`，没有音频输入通道，那是一个接口扩展）。
 *
 * ## 时间口径
 *
 * SRT 用 `HH:MM:SS,mmm`。这里所有换算都走 timebase：
 * 毫秒 → 微秒 → 项目帧，**不允许在别处写 `/1000`**（时基守卫会拦）。
 */
import type { ClipOperation, Frame, MilliFps, Project } from '../core/types';
import { createClip, createTextContent } from '../core/types';
import { textTrackFor } from '../core/placement';
import { frameToMs as tbFrameToMs, msToFrame as tbMsToFrame } from '../core/timebase';

export interface SubtitleCue {
  /** 毫秒（SRT 原生单位）。 */
  startMs: number;
  endMs: number;
  text: string;
}

/** `HH:MM:SS,mmm` → 毫秒。 */
function parseTimestamp(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(text.trim());
  if (match === null) return null;
  const [, h, m, s, ms] = match;
  const hours = Number(h);
  const minutes = Number(m);
  const seconds = Number(s);
  const millis = Number((ms ?? '0').padEnd(3, '0'));
  if (![hours, minutes, seconds, millis].every((value) => Number.isFinite(value))) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis; // timebase-allow: SRT 时间戳解析，毫秒是格式本身
}

/** 毫秒 → `HH:MM:SS,mmm`。 */
function formatTimestamp(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  // 以下三行是纯文本格式化（毫秒拆成时分秒），不参与任何帧号换算
  const hours = Math.floor(safe / 3_600_000); // timebase-allow: 文本格式化
  const minutes = Math.floor((safe % 3_600_000) / 60_000); // timebase-allow: 文本格式化
  const seconds = Math.floor((safe % 60_000) / 1000); // timebase-allow: 文本格式化
  const millis = safe % 1000;
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

/**
 * 解析 SRT。
 *
 * 容错取向：**坏块跳过、不整份失败**——字幕文件常见手工编辑错误（缺序号、多余空行、
 * 时间轴用 `.` 而不是 `,`），整份拒绝会让用户没法用。返回 `cues` 与 `skipped` 计数。
 */
export function parseSrt(input: string): { cues: SubtitleCue[]; skipped: number } {
  const normalized = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (normalized === '') return { cues: [], skipped: 0 };

  const blocks = normalized.split(/\n{2,}/);
  const cues: SubtitleCue[] = [];
  let skipped = 0;

  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) continue;
    // 第一行可能是序号（纯数字），也可能直接是时间轴
    let cursor = 0;
    if (/^\d+$/.test(lines[0]?.trim() ?? '')) cursor = 1;
    const timeLine = lines[cursor];
    if (timeLine === undefined) {
      skipped += 1;
      continue;
    }
    const range = /^(.*?)\s*-->\s*(.*)$/.exec(timeLine);
    if (range === null) {
      skipped += 1;
      continue;
    }
    const startMs = parseTimestamp(range[1] ?? '');
    // 结束时间后面可能跟坐标（`X1:... Y1:...`），只取第一段
    const endMs = parseTimestamp((range[2] ?? '').split(/\s+/)[0] ?? '');
    const text = lines.slice(cursor + 1).join('\n').trim();
    if (startMs === null || endMs === null || endMs <= startMs || text === '') {
      skipped += 1;
      continue;
    }
    cues.push({ startMs, endMs, text });
  }
  return { cues, skipped };
}

/** 生成 SRT（序号从 1 起，块之间空行）。 */
export function serializeSrt(cues: readonly SubtitleCue[]): string {
  const sorted = [...cues].sort((left, right) => left.startMs - right.startMs);
  return sorted
    .map((cue, index) => `${index + 1}\n${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}\n${cue.text}`)
    .join('\n\n')
    .concat('\n');
}

/** 毫秒 → 项目帧（直接复用 timebase 的原语）。 */
export function msToFrame(ms: number, fpsMilli: MilliFps): Frame {
  return tbMsToFrame(ms, fpsMilli);
}

/** 项目帧 → 毫秒。 */
export function frameToMs(frame: Frame, fpsMilli: MilliFps): number {
  return tbFrameToMs(frame, fpsMilli);
}

export interface SubtitlePlacement {
  /** 落哪条视频轨（通常是最上面那条）。 */
  trackId: string;
  /** 字幕文字样式。 */
  fontSize?: number;
  color?: string;
}

/**
 * 把字幕 cue 变成文本片段（`addClip` 操作）。
 *
 * 每个 cue 一个片段：`startFrame` 由毫秒换算，时长按帧取整但**至少 1 帧**
 * （0 帧片段在时间线上不可见，也没有意义）。
 */
export function buildSubtitleClips(
  cues: readonly SubtitleCue[],
  doc: Project,
  placement: SubtitlePlacement,
): Array<ReturnType<typeof createClip>> {
  const clips = [];
  for (const cue of cues) {
    const startFrame = msToFrame(cue.startMs, doc.fpsMilli);
    const endFrame = msToFrame(cue.endMs, doc.fpsMilli);
    const durationFrames = Math.max(1, endFrame - startFrame);
    clips.push(
      createClip({
        assetId: '',
        trackId: placement.trackId,
        startFrame,
        inFrame: 0,
        outFrame: durationFrames,
        durationFrames,
        text: createTextContent({
          content: cue.text,
          fontSize: placement.fontSize ?? 64,
          color: placement.color ?? '#ffffff',
          align: 'center',
        }),
        source: 'ui',
      }),
    );
  }
  return clips;
}

/** 一条字幕的最短时长（毫秒）：再短在时间线上不足 1 帧，用户看不见也改不了。 */
export const MIN_CUE_MS = 40;

export interface CueResolveResult {
  cues: SubtitleCue[];
  /** 被丢弃的条数（被后一条挤没 / 本来就不足最短时长）。 */
  dropped: number;
  /** 被截短尾巴的条数（与后一条重叠）。 */
  truncated: number;
}

/**
 * 消解**重叠 cue**：字幕不能同时出现两条（会叠在一起看不清）。
 *
 * 规则（顺序不可换）：
 * 1. 按起点排序（外部工具生成的 SRT 可能乱序）；
 * 2. 后一条的起点早于前一条的终点 → **前一条的终点收到后一条起点**（计一次 truncated）；
 * 3. 收完之后不足 `MIN_CUE_MS` 的丢掉（说明它被后一条挤没了）。
 *
 * 为什么两条入口（SRT 导入 / 语音识别）必须共用这一份：重叠处理是**有损**的
 * （会改用户的时间轴），两处各写一遍迟早口径不同，用户看到的字幕就会时好时坏。
 */
export function resolveCueOverlaps(cues: readonly SubtitleCue[]): CueResolveResult {
  const sorted = [...cues].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const resolved: SubtitleCue[] = [];
  let truncated = 0;
  for (const cue of sorted) {
    const previous = resolved[resolved.length - 1];
    if (previous !== undefined && cue.startMs < previous.endMs) {
      previous.endMs = cue.startMs;
      truncated += 1;
    }
    resolved.push({ ...cue });
  }
  let dropped = 0;
  const kept = resolved.filter((cue) => {
    if (cue.endMs - cue.startMs >= MIN_CUE_MS) return true;
    dropped += 1;
    return false;
  });
  return { cues: kept, dropped, truncated };
}

export interface SubtitleReplacePlan {
  ops: ClipOperation[];
  /** 字幕落在哪条轨（**文字轨**，没有就顺手建一条）。 */
  trackId: string;
  /** 被替换掉的旧文本片段数。 */
  removed: number;
  /** 因重叠被截短尾巴的 cue 数（0 = 输入本身没有重叠）。 */
  truncated: number;
}

/**
 * 把一批 cue **整段替换**成字幕片段（一个撤销步）。
 *
 * 为什么"整段替换"而不是"追加"：字幕是**唯一**的（同一时刻不该有两份字幕叠着），
 * 导入第二次 SRT 或者重新识别一次，正确行为都是覆盖旧的。
 * 之前这段逻辑只写在顶栏的 SRT 导入里；语音识别也要走同一条路，所以抽到这里
 * （**同一条规则只能有一个定义点**）。
 *
 * 落轨走 `textTrackFor`：**字幕与手动添加的文字落在同一条文字轨**。
 * 2026-10-23 之前这里找的是"最上面的视频轨"，于是手动加的字在 T1、导入的字幕在 V2，
 * 用户会以为"字幕没导进来"（两条轨在时间线上离得很远）。
 *
 * 不再返回 `null`：没有文字轨就建一条，没有视频轨也能放字幕。
 */
export function buildSubtitleReplaceOps(
  cues: readonly SubtitleCue[],
  doc: Project,
): SubtitleReplacePlan {
  // 先消解重叠：SRT 里允许两条时间轴交叠（双语字幕、工具生成），但落到时间线上
  // 就是同轨重叠的两个文本片段——两行字叠着画，谁都看不清。
  const resolved = resolveCueOverlaps(cues);
  const placement = textTrackFor(doc);
  const ops: ClipOperation[] = [...placement.ops];
  let removed = 0;
  for (const existing of doc.tracks) {
    for (const clip of existing.clips) {
      if (clip.text !== null && clip.text !== undefined) {
        ops.push({ op: 'removeClip', clipId: clip.id, removed: clip });
        removed += 1;
      }
    }
  }
  for (const clip of buildSubtitleClips(resolved.cues, doc, { trackId: placement.trackId })) {
    ops.push({ op: 'addClip', clip });
  }
  return { ops, trackId: placement.trackId, removed, truncated: resolved.truncated };
}

/** 从工程里提取字幕（所有文本片段），按起点排序。 */export function extractSubtitles(doc: Project): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.text === null || clip.text === undefined) continue;
      cues.push({
        startMs: frameToMs(clip.startFrame, doc.fpsMilli),
        endMs: frameToMs(clip.startFrame + clip.durationFrames, doc.fpsMilli),
        text: clip.text.content,
      });
    }
  }
  return cues.sort((left, right) => left.startMs - right.startMs);
}
