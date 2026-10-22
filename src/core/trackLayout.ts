/**
 * 时间轴几何的**唯一真相源**。
 *
 * ## 为什么要有这个文件
 *
 * 改造前，`RULER_HEIGHT` / `TRACK_HEIGHT` / `TRACK_HEADER_WIDTH` 三个常量散在
 * `render/timelinePainter.ts`、`ui/timelineController.ts`、`ui/TimelineView.tsx` 里各用一遍，
 * 而且 **6 个 E2E 把 `56` 硬编码在坐标换算里**。
 *
 * 于是"把轨道头从 56px 改成 130px"这种纯视觉需求，会变成"改一个常量 → 六个测试一起红"。
 * 收敛之后：**所有几何都从 `trackLayout(doc)` 查表**，改尺寸只改这一处的常量表。
 *
 * ## 为什么高度要按轨道类型分
 *
 * 剪映式时间线的信息密度是分层的：视频轨最高（要放缩略图）、音频轨次之（波形）、
 * 字幕轨最矮（一行字）。等高会让字幕轨浪费一半高度、视频轨挤不下缩略图。
 *
 * ## 顺序
 *
 * `rows` 按**显示顺序**（自上而下）：字幕 → 视频（order 大的在上）→ 音频。
 * 与 `types.trackDisplayOrder` 完全一致——**不要在这里另排一套**。
 */
import type { Frame, Project, Track, TrackKind } from './types';
import { trackDisplayOrder } from './types';

/** 标尺高度（px）。 */
export const RULER_HEIGHT = 24;

/** 轨道头宽度（px）。剪映约 120–140，取 130 能放下"图标 + 名称 + 四个按钮"。 */
export const TRACK_HEADER_WIDTH = 130;

/** 轨道高度可调范围（px），对应轨道头下边缘的拖拽热区。 */
export const TRACK_MIN_HEIGHT = 24;
export const TRACK_MAX_HEIGHT = 120;

/**
 * 各类型轨道的默认高度（px）。
 *
 * 视频 60：放得下 51px 的缩略图条；
 * 音频 50：波形 + 音量线；
 * 字幕 32：一行字，最矮。
 */
export const TRACK_HEIGHT_BY_KIND: Record<TrackKind, number> = {
  text: 32,
  video: 60,
  audio: 50,
};

/**
 * 兼容常量：**只用于"没有具体轨道时"的估算**（例如空工程算画布高）。
 * 任何"第 i 条轨的 y"都必须查 `trackLayout()`，不要乘这个数。
 */
export const TRACK_HEIGHT = TRACK_HEIGHT_BY_KIND.video;

export interface TrackRow {
  trackId: string;
  kind: TrackKind;
  name: string;
  /** 相对画布顶部的 y（**含标尺**，即第一条轨的 top = RULER_HEIGHT）。 */
  top: number;
  height: number;
  /** 第几行（0 开始，显示顺序）。 */
  index: number;
}

export interface TimelineLayout {
  headerWidth: number;
  rulerHeight: number;
  rows: TrackRow[];
  /** 画布总高 = 标尺 + 所有轨道高度。 */
  totalHeight: number;
}

/** 一条轨的实际高度（用户调过就用调过的，否则按类型默认，并夹在允许范围内）。 */
export function trackHeightOf(track: Track): number {
  const raw = track.height;
  const fallback = TRACK_HEIGHT_BY_KIND[track.kind] ?? TRACK_HEIGHT;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.min(TRACK_MAX_HEIGHT, Math.max(TRACK_MIN_HEIGHT, Math.round(raw)));
}

/**
 * 算出整条时间线的布局。
 *
 * 纯函数、O(轨道数)，可以在每次绘制时直接调（不需要缓存——轨道数是个位数到几十）。
 */
export function trackLayout(doc: Project): TimelineLayout {
  const rows: TrackRow[] = [];
  let top = RULER_HEIGHT;
  for (const [index, track] of trackDisplayOrder(doc.tracks).entries()) {
    const height = trackHeightOf(track);
    rows.push({ trackId: track.id, kind: track.kind, name: track.name, top, height, index });
    top += height;
  }
  return { headerWidth: TRACK_HEADER_WIDTH, rulerHeight: RULER_HEIGHT, rows, totalHeight: top };
}

/** y（画布坐标）→ 落在哪一行；在标尺上或超出末尾返回 null。 */
export function trackRowAtY(layout: TimelineLayout, y: number): TrackRow | null {
  if (y < layout.rulerHeight) return null;
  for (const row of layout.rows) {
    if (y >= row.top && y < row.top + row.height) return row;
  }
  return null;
}

/** trackId → 行；不存在返回 null。 */
export function trackRowOf(layout: TimelineLayout, trackId: string): TrackRow | null {
  return layout.rows.find((row) => row.trackId === trackId) ?? null;
}

/**
 * 帧 → 轨道内的相对 y（0..1）。画波形/音量线时按比例定位用。
 * 轨道高度可调之后，"离顶部 8px"这种写法必须换成比例，否则矮轨道会画到外面。
 */
export function verticalRatio(row: TrackRow, y: number): number {
  return row.height <= 0 ? 0 : Math.min(1, Math.max(0, (y - row.top) / row.height));
}

/** 时间线总时长（帧）：最后一段的结束点。 */
export function contentEndFrame(doc: Project): Frame {
  return doc.tracks.reduce(
    (max, track) => track.clips.reduce((inner, clip) => Math.max(inner, clip.startFrame + clip.durationFrames), max),
    0,
  );
}
