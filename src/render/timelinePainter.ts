/**
 * 时间线画布绘制（架构 §9，task:T15）。
 *
 * ## 铁律（§9.4）
 *
 * 1. **纯绘制、无副作用**：本文件只读 `doc + ephemeral + 缩放`，绝不写 store、不 dispatch。
 * 2. **不碰时基换算之外的除法**：帧 → 秒一律 `usToSeconds(frameToUs(...))`，
 *    帧 → 像素 `frame * zoomLevel`（zoomLevel 单位是 px/帧，§7.4）。
 * 3. **拖动期间只画 `drag`（ghost + 吸附线），不画真实片段位移**——真实位移由
 *    `tx.draft` 在 dispatch 时落定（T16），本文件只负责把 `DragDraft` 渲染成视觉。
 *
 * ## 布局（与 `app.css` 的 CSS 变量对齐）
 *
 * | 常量 | 值 | 来源 |
 * |---|---|---|
 * | 标尺高 | 24px | `--v-tl-ruler-h` |
 * | 轨道高 | 56px | `--v-track-h` |
 * | 轨道头宽 | 56px | `--v-track-head-w` |
 * | 手柄宽 | 8px | `--v-handle-w` |
 */
import { frameToUs, framesPerSecond, usToSeconds } from '../core/timebase';
import { isTrackVisible } from '../core/trackAudibility';
import type {
  Asset,
  Clip,
  EphemeralState,
  Frame,
  MilliFps,
  Px,
  Project,
} from '../core/types';

/* ---------- 布局常量 ---------- */

/**
 * 几何常量**统一从 `core/trackLayout` 来**（2026-10-22 收敛）。
 *
 * 这里仍然 `export`，是为了不动其它文件的 import；但**新增代码不要直接用 TRACK_HEIGHT
 * 算"第几条轨的 y"**——轨道高度按类型不同（视频 60 / 音频 50 / 字幕 32），
 * 一律查 `trackLayout(doc).rows[i].top`。
 */
export { RULER_HEIGHT, TRACK_HEADER_WIDTH, TRACK_HEIGHT } from '../core/trackLayout';
import {
  RULER_HEIGHT,
  TRACK_HEADER_WIDTH,
  TRACK_HEIGHT,
  trackLayout,
  trackRowOf,
  type TrackRow,
  type TimelineLayout,
} from '../core/trackLayout';
export const HANDLE_WIDTH = 8;
/** 转场角标的宽度（px）。 */
const TRANSITION_MARK_WIDTH = 12;
/** 片段块内缩略图的最大高度（块高减去上下留白）。 */
const THUMB_MAX_H = TRACK_HEIGHT - 12;

/* ---------- 颜色 ---------- */

export interface TimelineColors {
  bg: string;
  /** 兼容旧字段（未按类型着色时用）。 */
  track: string;
  trackAlt: string;
  /** 离线素材的角标底色（红）。 */
  offline: string;
  /** 锁定态的蒙层（30% 黑，规范 §3.1）。 */
  lockedOverlay: string;
  /** 锁定态的描边：**不用主色**——主色在这套配色里表示"可操作"。 */
  lockedBorder: string;
  /** 悬停时的"亮度提升"：叠一层 10% 白，比 `filter: brightness()` 便宜得多。 */
  hoverGlow: string;
  /** 分类型底色（2026-10-22）：视频浅灰 / 音频浅蓝 / 字幕最浅。 */
  trackVideo: string;
  trackAudio: string;
  trackText: string;
  border: string;
  rulerBg: string;
  rulerText: string;
  rulerTick: string;
  clip: string;
  /** 块内文字颜色。 */
  clipText: string;
  /** 文本片段块的底色（与视频块区分，避免误以为是素材）。 */
  textClip: string;
  clipAudio: string;
  accent: string;
  accentWeak: string;
  selection: string;
  hover: string;
  playhead: string;
  snap: string;
  ghost: string;
  ghostInvalid: string;
  overlayMark: string;
  emptyText: string;
  headerText: string;
  muted: string;
  locked: string;
}

export const DEFAULT_TIMELINE_COLORS: TimelineColors = {
  bg: '#ffffff',
  track: '#f7f7f7',
  trackAlt: '#f0f0f0',
  offline: '#d4380d',
  lockedOverlay: 'rgba(0, 0, 0, 0.30)',
  lockedBorder: '#8c8c8c',
  hoverGlow: 'rgba(255, 255, 255, 0.10)',
  trackVideo: '#f5f5f5',
  trackAudio: '#f0f7ff',
  trackText: '#fafafa',
  border: '#e4e4e4',
  rulerBg: '#fafafa',
  rulerText: '#8a8a8a',
  rulerTick: '#c9c9c9',
  clip: '#d9d7f0',
  clipText: '#1f1f1f',
  textClip: '#ffe9c7',
  clipAudio: '#cfe3d6',
  accent: '#1677ff',
  accentWeak: '#e6f4ff',
  selection: '#1677ff',
  hover: '#efeef9',
  playhead: '#d64545',
  snap: '#2f9e6e',
  ghost: '#1677ff',
  ghostInvalid: '#c0392b',
  overlayMark: '#d64545',
  emptyText: '#8a8a8a',
  headerText: '#6a6a6a',
  muted: '#c0392b',
  locked: '#8a8a8a',
};

/* ---------- 绘制输入 ---------- */

export interface TimelinePaintState {
  doc: Project;
  ephemeral: EphemeralState;
  /** 画布像素宽高。 */
  viewport: { width: number; height: number };
  /** 水平滚动偏移（px，向右为正）。 */
  scrollX: number;
  /** 素材缩略图缓存：assetId → ImageBitmap（T12 导入时填充，本文件只管画）。 */
  thumbnails: Map<string, ImageBitmap>;
  colors?: Partial<TimelineColors>;
  /** 是否处于高 DPI（缩放画布时会由调用方处理，本文件只按 CSS 像素画）。 */
  timeFormatter?: (frame: Frame, fpsMilli: MilliFps) => string;
}

/* ---------- 像素换算（唯一入口） ---------- */

/** 项目帧 → 画布 x（未减滚动；调用方传 scrollX 一起算）。 */
export function frameToX(frame: Frame, zoomLevel: Px): number {
  return frame * zoomLevel;
}

/** 画布 x（已加滚动）→ 项目帧（floor，向下取整到所在帧）。 */
export function xToFrame(x: number, zoomLevel: Px, scrollX: number): Frame {
  if (zoomLevel <= 0) return 0;
  return Math.floor((x + scrollX) / zoomLevel);
}

/* ---------- 刻度算法 ---------- */

/** 从候选步长里选 ≥ raw 的最小"nice"值。 */
function niceStep(candidates: number[], raw: number): number {
  for (const candidate of candidates) {
    if (candidate >= raw) return candidate;
  }
  return Math.max(1, Math.ceil(raw));
}

const SECOND_STEPS = [1, 2, 5, 10, 15, 30, 60];
const MINUTE_STEPS = [1, 2, 5, 10, 30];

/** 帧 → 秒（整数秒，floor）。走 timebase 唯一入口，不写裸除法。 */
function frameToWholeSecond(frame: Frame, fpsMilli: MilliFps): number {
  return Math.floor(usToSeconds(frameToUs(frame, fpsMilli)));
}

/** 帧 → "m:ss" 或 "ss" 标签。 */
export function frameToSecondLabel(frame: Frame, fpsMilli: MilliFps): string {
  const total = frameToWholeSecond(frame, fpsMilli);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

interface TickSpec {
  /** 帧间隔（整数帧）。 */
  frameInterval: Frame;
  /** 是否画标签。 */
  labeled: boolean;
  /** 刻度高度（自标尺底向上）。 */
  height: number;
}

/**
 * 计算当前缩放下的三级刻度规格（帧 / 秒 / 分）。
 *
 * 自适应：帧级刻度只在缩放够大时出现（否则糊成一片）；秒/分级刻度间距必须 ≥ 最小
 * 像素间隔（默认 44px / 80px），保证标签不重叠。
 */
export function tickSpecs(
  zoomLevel: Px,
  fpsMilli: MilliFps,
  minSecondPx = 44,
  minMinutePx = 80,
): { frames: TickSpec; seconds: TickSpec; minutes: TickSpec } {
  const fps = framesPerSecond(fpsMilli); // 30
  const pxPerFrame = zoomLevel;
  const pxPerSecond = pxPerFrame * fps;
  const pxPerMinute = pxPerSecond * 60;

  // 帧级：每 N 帧一短线，N 取 ceil(8 / zoom)，保证短线间距 ≥ 8px；
  // frameInterval 按定义恒满足 interval × zoom ≥ 8px，所以帧级刻度始终可画。
  const frameInterval = Math.max(1, Math.ceil(8 / pxPerFrame));

  // 秒级：间距 ≥ minSecondPx
  const secondRaw = minSecondPx / pxPerSecond;
  const secondIntervalSec = niceStep(SECOND_STEPS, secondRaw);

  // 分级：间距 ≥ minMinutePx
  const minuteRaw = minMinutePx / pxPerMinute;
  const minuteIntervalMin = niceStep(MINUTE_STEPS, minuteRaw);

  return {
    frames: { frameInterval, labeled: false, height: 5 },
    seconds: {
      frameInterval: Math.round(secondIntervalSec * fps),
      labeled: true,
      height: 9,
    },
    minutes: {
      frameInterval: Math.round(minuteIntervalMin * 60 * fps),
      labeled: true,
      height: 16,
    },
  };
}

/* ---------- 片段块 ---------- */

interface ClipBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 片段的像素盒（含轨道 y 偏移）。 */
function clipBox(clip: Clip, row: TrackRow, zoomLevel: Px, scrollX: number): ClipBox {
  const x = frameToX(clip.startFrame, zoomLevel) - scrollX;
  return {
    x,
    y: row.top,
    width: Math.max(1, frameToX(clip.durationFrames, zoomLevel)),
    height: row.height,
  };
}

/** 找到片段所在的轨道下标（视频轨优先，音频轨接在后面；找不到返回 -1）。 */
/**
 * 片段/轨道 → **屏幕行号**。
 *
 * **必须用 `trackDisplayOrder`**（V2/V1/A1），不能用 `doc.tracks` 的存储顺序
 * （A1/V1/V2）—— 两者在默认工程里正好相反，用错会让 ghost 画到别的轨道上
 * （V2 上的片段，ghost 跑到 A1 那行）。这个 bug 之前就存在于"拖动已有片段"的 ghost 上，
 * 因为 E2E 只拖过 V1（存储顺序与显示顺序恰好都是 1），一直没暴露。
 */
/**
 * 片段 → 它所在的**行**（找不到返回 null）。
 *
 * 行高按类型不同（视频 60 / 音频 50 / 字幕 32），所以不能用"第几行 × 行高"，
 * 必须查 `trackLayout()` 给出的 `top/height`。
 */
function rowOfClip(doc: Project, layout: TimelineLayout, clipId: string): TrackRow | null {
  for (const track of doc.tracks) {
    if (track.clips.some((clip) => clip.id === clipId)) return trackRowOf(layout, track.id);
  }
  return null;
}

/** 片段对应的素材。 */
function assetOf(doc: Project, clip: Clip): Asset | undefined {
  return doc.assets.find((asset) => asset.id === clip.assetId);
}

/* ---------- 主绘制 ---------- */

/** 无副作用地把整条时间线画进 ctx。 */
export function paintTimeline(ctx: CanvasRenderingContext2D, state: TimelinePaintState): void {
  const colors: TimelineColors = { ...DEFAULT_TIMELINE_COLORS, ...state.colors };
  const { doc, ephemeral } = state;
  const { width, height } = state.viewport;

  ctx.clearRect(0, 0, width, height);

  // 标尺底色通栏（含轨道头那一列），刻度/标签只画在 lane 内
  ctx.fillStyle = colors.rulerBg;
  ctx.fillRect(0, 0, width, RULER_HEIGHT);

  withLane(ctx, state, () => drawRuler(ctx, state, colors));
  drawTracks(ctx, state, colors);

  // lane 内的所有内容统一裁剪到轨道头右侧：片段块从 x=0 起画会压住轨道名，
  // 而块宽必须精确等于 `durationFrames × zoom`（R-012），所以只能用裁剪而不是缩窄。
  withLane(ctx, state, () => {
    // 空态提示（所有轨都没有片段时）
    const hasAnyClip = doc.tracks.some((track) => track.clips.length > 0);
    if (!hasAnyClip) {
      ctx.save();
      ctx.fillStyle = colors.emptyText;
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // fillText(text, x, y)：上一版把 x/y 写反，文字被画到画布外（画布高 192、y 却是 628）
      ctx.fillText('把素材拖到时间线上', (width - TRACK_HEADER_WIDTH) / 2, RULER_HEIGHT + TRACK_HEIGHT * 1.5);
      ctx.restore();
    }

    /**
     * 片段块（屏幕顺序：字幕在上、视频居中、音频在下）。
     *
     * 遍历 `layout.rows` 而不是 `trackDisplayOrder` + 下标：行高按类型不同，
     * 必须用 row.top/row.height，不能"第几行 × 统一行高"。
     */
    const layout = trackLayout(doc);
    for (const row of layout.rows) {
      const track = doc.tracks.find((item) => item.id === row.trackId);
      if (track === undefined) continue;
      for (const clip of track.clips) {
        drawClip(ctx, clip, row, state, colors);
      }
    }

    // AI 建议切点（M4，纯绘制）
    for (const mark of ephemeral.overlayMarks) {
      drawOverlayMark(ctx, mark.frame, state, colors);
    }

    // 拖动 ghost + 吸附线（覆盖在最上）
    if (ephemeral.drag !== null) {
      drawDragDraft(ctx, ephemeral.drag, state, colors);
    }
    /**
     * 从素材库拖入的落点预览（与上面的"内部移动"互斥出现）。
     *
     * **用 `?? null` 兜底而不是 `!== null`**：`EphemeralState` 字段多，测试里常手搓
     * 一个"只填了用得上的字段"的对象（`verify-t15` 的 `emptyEphemeral()` 就是），
     * 新加字段后那边不会自动补 —— `undefined !== null` 成立，于是走进来读
     * `ghost.trackId` 直接抛异常，表现为"整条时间线画不出来"（实测 t15 红了 107 秒）。
     * painter 是纯渲染函数，不该因为入参少一个字段就崩。
     */
    const dropGhost = ephemeral.dropGhost ?? null;
    if (dropGhost !== null) {
      drawDropGhost(ctx, dropGhost, state, colors);
    }

    /**
     * 轨道排序的指示线（S3）。
     *
     * 画在最上层、**贯穿整条画布**（含轨道头列）：用户是从轨道头拖起来的，
     * 只看内容区的线会不确定"到底插在哪两条之间"。
     * 2px 主色 + 两端小圆点，比虚线更容易在缩略图/波形上分辨出来。
     */
    const trackDrag = ephemeral.trackDrag ?? null;
    if (trackDrag !== null) {
      const y = trackDrag.indicatorTop;
      ctx.save();
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(state.viewport.width, y + 0.5);
      ctx.stroke();
      ctx.fillStyle = colors.accent;
      for (const x of [3, state.viewport.width - 3]) {
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // 入点/出点区间（R-040）：画在片段之上、播放头之下
    drawMarkRange(ctx, state, colors);

    // 播放头（最后画，覆盖一切）
    drawPlayhead(ctx, state, colors);
  });
}

/**
 * 在「lane 坐标系」里绘制：原点右移到轨道头右侧，并裁剪到 lane 内。
 *
 * 内部所有几何仍是 `frame × zoom`（内容坐标），因此块宽断言、播放头位置断言
 * 都保持原口径，不需要在业务代码里到处加偏移。
 */
function withLane(
  ctx: CanvasRenderingContext2D,
  state: TimelinePaintState,
  draw: () => void,
): void {
  const { width, height } = state.viewport;
  ctx.save();
  ctx.beginPath();
  ctx.rect(TRACK_HEADER_WIDTH, 0, Math.max(0, width - TRACK_HEADER_WIDTH), height);
  ctx.clip();
  ctx.translate(TRACK_HEADER_WIDTH, 0);
  draw();
  ctx.restore();
}


/**
 * 入点/出点区间（R-040）：区间外压暗 + 两条竖线 + 标尺上的「入/出」字样。
 *
 * 压暗而不是高亮区间：用户已经能看见片段块，压暗"不导出的部分"更符合"我选了一段"的直觉。
 */
function drawMarkRange(
  ctx: CanvasRenderingContext2D,
  state: TimelinePaintState,
  colors: TimelineColors,
): void {
  const { markIn, markOut } = state.ephemeral;
  if (markIn === null && markOut === null) return;
  const { width, height } = state.viewport;
  const zoom = state.doc.zoomLevel;
  const scroll = state.scrollX;

  let start = markIn;
  let end = markOut;
  // 只标了一侧：另一侧取时间线首/尾，保证始终能看到一个区间
  if (start === null) start = 0;
  if (end === null) {
    end = state.doc.tracks.reduce(
      (max, track) => Math.max(max, ...track.clips.map((clip) => clip.startFrame + clip.durationFrames)),
      0,
    );
  }
  if (end <= start) return;

  const x0 = frameToX(start, zoom) - scroll;
  const x1 = frameToX(end, zoom) - scroll;

  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.07)';
  if (x0 > 0) ctx.fillRect(0, RULER_HEIGHT, Math.min(x0, width), height - RULER_HEIGHT);
  if (x1 < width) ctx.fillRect(Math.max(0, x1), RULER_HEIGHT, width - Math.max(0, x1), height - RULER_HEIGHT);

  const line = (x: number, label: string): void => {
    if (x < -40 || x > width + 40) return;
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x + 0.5, RULER_HEIGHT);
    ctx.lineTo(x + 0.5, height);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = colors.accent;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(label, x + 3, 2);
  };
  line(x0, '入');
  line(x1, '出');
  ctx.restore();
}

function drawRuler(
  ctx: CanvasRenderingContext2D,
  state: TimelinePaintState,
  colors: TimelineColors,
): void {
  const { width } = state.viewport;
  const { doc } = state;
  const zoomLevel = doc.zoomLevel;
  const scrollX = state.scrollX;
  const fpsMilli = doc.fpsMilli;

  ctx.save();
  // 底色已由 paintTimeline 通栏填充；这里只画刻度/标签/分隔线（在 lane 坐标系内）

  const specs = tickSpecs(zoomLevel, fpsMilli);
  const firstFrame = Math.max(0, Math.floor(scrollX / zoomLevel));
  const lastFrame = Math.ceil((scrollX + width) / zoomLevel);

  // 帧级短线
  if (specs.frames.height > 0) {
    ctx.strokeStyle = colors.rulerTick;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const interval = specs.frames.frameInterval;
    for (let f = Math.ceil(firstFrame / interval) * interval; f <= lastFrame; f += interval) {
      const x = frameToX(f, zoomLevel) - scrollX;
      ctx.moveTo(x, RULER_HEIGHT);
      ctx.lineTo(x, RULER_HEIGHT - specs.frames.height);
    }
    ctx.stroke();
  }

  // 秒级（跳过整分钟，交给分级）
  {
    ctx.strokeStyle = colors.rulerTick;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const interval = specs.seconds.frameInterval;
    const minuteFrames = specs.minutes.frameInterval;
    for (let f = Math.ceil(firstFrame / interval) * interval; f <= lastFrame; f += interval) {
      if (minuteFrames > 0 && f % minuteFrames === 0) continue;
      const x = frameToX(f, zoomLevel) - scrollX;
      ctx.moveTo(x, RULER_HEIGHT);
      ctx.lineTo(x, RULER_HEIGHT - specs.seconds.height);
    }
    ctx.stroke();
  }

  // 标签（秒 + 分）
  ctx.fillStyle = colors.rulerText;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const labelSets: Array<{ interval: Frame; y: number; bold: boolean }> = [
    { interval: specs.seconds.frameInterval, y: RULER_HEIGHT - 13, bold: false },
    { interval: specs.minutes.frameInterval, y: RULER_HEIGHT - 6, bold: true },
  ];
  for (const set of labelSets) {
    const interval = set.interval;
    if (interval <= 0) continue;
    for (let f = Math.ceil(firstFrame / interval) * interval; f <= lastFrame; f += interval) {
      // 秒标签跳过整分钟位置（分级已画）
      if (!set.bold && specs.minutes.frameInterval > 0 && f % specs.minutes.frameInterval === 0) continue;
      const x = frameToX(f, zoomLevel) - scrollX + 3;
      if (x < 0 || x > width) continue;
      ctx.fillStyle = set.bold ? colors.rulerText : colors.rulerText;
      ctx.fillText(frameToSecondLabel(f, fpsMilli), x, set.y);
    }
  }

  // 底边分隔线
  ctx.strokeStyle = colors.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, RULER_HEIGHT + 0.5);
  ctx.lineTo(width, RULER_HEIGHT + 0.5);
  ctx.stroke();

  ctx.restore();
}

/**
 * 轨道底 + 分隔线。
 *
 * **轨道头的内容（图标/名称/按钮）由 DOM 画**（`ui/TrackHeader.tsx`），这里只铺底色：
 * canvas 画文字拿不到无障碍、hover、tooltip，而轨道头正是最需要这三样的地方。
 * 底色仍在这里铺，是为了 DOM 还没挂载/被滚动裁掉时不出现透明洞。
 */
function drawTracks(
  ctx: CanvasRenderingContext2D,
  state: TimelinePaintState,
  colors: TimelineColors,
): void {
  const { width, height } = state.viewport;
  const { doc } = state;
  const layout = trackLayout(doc);

  for (const row of layout.rows) {
    /**
     * 按类型分底色：视频浅灰 / 音频浅蓝 / 字幕最浅（剪映的分层逻辑）。
     *
     * **每行都必须整条铺满**（哪怕这条轨是空的/隐藏的）：画布虽然每帧都 `clearRect`，
     * 但轨道底色是"这段区域属于哪条轨"的唯一视觉依据，漏铺一行就是一条白带。
     */
    ctx.fillStyle =
      row.kind === 'audio' ? colors.trackAudio : row.kind === 'text' ? colors.trackText : colors.trackVideo;
    ctx.fillRect(0, row.top, width, row.height);


    // 轨道头列：铺一层稍深的底，DOM 头就压在上面
    ctx.fillStyle = colors.rulerBg;
    ctx.fillRect(0, row.top, TRACK_HEADER_WIDTH, row.height);
    ctx.strokeStyle = colors.border;
    ctx.beginPath();
    ctx.moveTo(TRACK_HEADER_WIDTH + 0.5, row.top);
    ctx.lineTo(TRACK_HEADER_WIDTH + 0.5, row.top + row.height);
    ctx.stroke();

    // 轨道底部分隔线
    ctx.beginPath();
    ctx.moveTo(0, row.top + row.height + 0.5);
    ctx.lineTo(width, row.top + row.height + 0.5);
    ctx.stroke();

    /**
     * 隐藏/让位的轨道：整行压一层**黑色蒙层**。
     *
     * 两个必须注意的点（都是实测踩出来的）：
     * 1. **必须在轨道头列的 `rulerBg` 之后画** —— 先画会被那一层浅色整块盖住，
     *    表现为"代码明明加了压暗，画面一点没变"（实测 250→250）；
     * 2. **用黑色蒙层而不是换底色** —— 轨道底色本身就浅（#f5f5f5），换成
     *    `trackAlt`(#f0f0f0) 只差 2–3 个色阶，肉眼完全看不出。
     *    10% 黑蒙层压掉约 25 个色阶，一眼可辨，且不改任何主题配色。
     */
    const track = doc.tracks.find((item) => item.id === row.trackId);
    if (track !== undefined && !isTrackVisible(doc, track)) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.10)';
      ctx.fillRect(0, row.top, width, row.height);
    }
  }

  // 覆盖到最底部（轨道少于视口时，下面留空）
  if (layout.totalHeight < height) {
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, layout.totalHeight, width, height - layout.totalHeight);
  }
}

function drawClip(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  row: TrackRow,
  state: TimelinePaintState,
  colors: TimelineColors,
): void {
  const { doc, ephemeral } = state;
  const box = clipBox(clip, row, doc.zoomLevel, state.scrollX);
  if (box.x + box.width < 0 || box.x > state.viewport.width) return; // 视口裁剪

  const isSelected = ephemeral.selectedClipId === clip.id;
  const isHovered = ephemeral.hoverClipId === clip.id;
  const isAudio = row.kind === 'audio';
  const isText = clip.text !== null && clip.text !== undefined;
  const asset = assetOf(doc, clip);
  /**
   * 轨道不可见（隐藏 / 独奏时被让位）→ 整段压暗。
   *
   * 为什么必须画出来：用户点眼睛之后，预览变黑了，但时间线上这段片段看起来
   * 和刚才一模一样 —— 分不清"是隐藏了"还是"素材坏了"。压暗是剪映/PR 的通行做法。
   * 判据用 `isTrackVisible`（与渲染同源），不自己写 `track.hidden`，
   * 否则独奏让位的轨道不会变暗。
   */
  const track = doc.tracks.find((item) => item.id === row.trackId);
  const dimmed = track === undefined ? false : !isTrackVisible(doc, track);
  /**
   * ---- 片段四态（S4）----
   *
   * 优先级 **锁定 > 选中 > 悬停 > 默认**。
   *
   * 为什么锁定压过选中：锁定是"这段不能动"，选中是"我正看着它"。
   * 一个被锁住的片段被选中时，如果还画主色描边，用户会以为可以拖 ——
   * 拖动确实会被拒绝（`timelineController` 里拦），那种"看着能拖、拖了没反应"
   * 的落差比"一看就不能拖"糟得多。
   *
   * 锁定是**轨道级**的（S3 定的：不设片段级锁定）：轨道一锁，整条轨的片段一起进锁定态。
   */
  const locked = track?.locked === true;
  const visual: 'locked' | 'selected' | 'hovered' | 'default' = locked
    ? 'locked'
    : isSelected
      ? 'selected'
      : isHovered
        ? 'hovered'
        : 'default';

  ctx.save();
  if (dimmed) ctx.globalAlpha = 0.38;
  // 圆角块底：横向**不内缩**——块宽必须精确等于 durationFrames × zoomLevel（T15 ② 误差 ≤1px），
  // 相邻片段首尾相接。只做纵向留白（y+2, height-4）。
  const radius = 4;
  const { x, y, width, height } = box;
  roundRect(ctx, x, y + 2, width, height - 4, radius);
  ctx.fillStyle = isAudio ? colors.clipAudio : isText ? colors.textClip : colors.clip;
  ctx.fill();

  // 缩略图（视频片段）：缩到块高，靠左，超出块宽裁掉
  if (!isAudio && asset !== undefined) {
    const thumb = state.thumbnails.get(asset.id);
    if (thumb !== undefined && thumb.width > 0 && thumb.height > 0) {
      const drawH = THUMB_MAX_H;
      const drawW = Math.round((thumb.width / thumb.height) * drawH);
      // 沿块宽重复铺满，模拟胶片
      ctx.save();
      ctx.beginPath();
      roundRect(ctx, x, y + 3, width, height - 6, radius - 1);
      ctx.clip();
      let px = x;
      while (px < x + width) {
        ctx.drawImage(thumb, px, y + 3, drawW, drawH);
        px += drawW;
      }
      ctx.restore();
    }
  }

  /**
   * 悬停态：叠一层 10% 白（"亮度提升"）。
   *
   * 为什么不用 `ctx.filter = 'brightness(1.1)'`：那个滤镜会走一条离屏合成路径，
   * 100 个片段重绘时是实打实的性能开销（T15 的 0.1ms 指标就是这条红线）。
   * 叠一层半透明白色在视觉上几乎等价，而 `fillRect` 是纯光栅操作。
   */
  if (visual === 'hovered') {
    ctx.save();
    ctx.fillStyle = colors.hoverGlow;
    roundRect(ctx, x, y + 2, width, height - 4, radius);
    ctx.fill();
    ctx.restore();
  }

  // 边框：锁定=灰、选中=2px 主色、悬停=1.5px 淡主色、默认=1px 细边
  ctx.beginPath();
  roundRect(ctx, x, y + 2, width, height - 4, radius);
  if (visual === 'locked') {
    ctx.strokeStyle = colors.lockedBorder;
    ctx.lineWidth = 1.5;
  } else if (visual === 'selected') {
    ctx.strokeStyle = colors.selection;
    ctx.lineWidth = 2;
  } else if (visual === 'hovered') {
    ctx.strokeStyle = colors.hover;
    ctx.lineWidth = 1.5;
  } else {
    ctx.strokeStyle = colors.border;
    ctx.lineWidth = 1;
  }
  ctx.stroke();

  // 转场角标：左/右边缘画一个半透明楔形，表示这一侧有淡入/淡出
  if (clip.transitionIn !== null) {
    ctx.fillStyle = 'rgba(83, 74, 183, 0.28)';
    ctx.beginPath();
    ctx.moveTo(x, y + 2);
    ctx.lineTo(x + TRANSITION_MARK_WIDTH, y + 2);
    ctx.lineTo(x, y + height - 2);
    ctx.closePath();
    ctx.fill();
  }
  if (clip.transitionOut !== null) {
    ctx.fillStyle = 'rgba(83, 74, 183, 0.28)';
    ctx.beginPath();
    ctx.moveTo(x + width, y + 2);
    ctx.lineTo(x + width - TRANSITION_MARK_WIDTH, y + 2);
    ctx.lineTo(x + width, y + height - 2);
    ctx.closePath();
    ctx.fill();
  }

  // 文本片段：块内显示首行文字，比"T"更有辨识度
  if (isText && clip.text !== null && clip.text !== undefined && width > 40) {
    ctx.fillStyle = colors.clipText;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(clip.text.content.split('\n')[0] ?? '', x + 8, y + height / 2, width - 12);
  }

  // 素材名（块足够宽时才画，避免挤压）
  if (!isText && width > 40 && asset !== undefined) {
    ctx.fillStyle = colors.clipText;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const name = asset.name;
    const maxChars = Math.max(1, Math.floor((width - 16) / 7));
    const label = name.length > maxChars ? `${name.slice(0, maxChars)}…` : name;
    ctx.fillText(label, x + 6, y + height - 12);
  }

  /**
   * 左右裁切把手。
   *
   * - **选中**：实色（明确"这就是能拖的地方"）；
   * - **悬停**：半透明（"移上来才发现能裁"，符合规范"悬停态把手显现"）；
   * - **锁定**：不画（锁定的片段没有可拖的地方，画了就是骗人）。
   */
  if (visual === 'selected' || visual === 'hovered') {
    ctx.save();
    if (visual === 'hovered') ctx.globalAlpha = 0.55;
    ctx.fillStyle = colors.accent;
    ctx.fillRect(x, y + 2, HANDLE_WIDTH, height - 4);
    ctx.fillRect(x + width - HANDLE_WIDTH, y + 2, HANDLE_WIDTH, height - 4);
    ctx.restore();
  }

  /**
   * 选中态的四角锚点（规范 §3.1）。
   *
   * **纯视觉，不响应拖拽**：时间线上没有"拖角缩放"这个操作（缩放是属性栏的事）。
   * 画它是为了让选中的片段"框得住"，同时尺寸压到 3px —— 太大就会被当成可拖的把手。
   * 锁定态不画（同把手）。
   */
  if (visual === 'selected' && width > 12 && height > 12) {
    ctx.save();
    ctx.fillStyle = colors.selection;
    for (const [cx, cy] of [
      [x + 1.5, y + 3.5],
      [x + width - 1.5, y + 3.5],
      [x + 1.5, y + height - 3.5],
      [x + width - 1.5, y + height - 3.5],
    ] as const) {
      ctx.fillRect(cx - 1.5, cy - 1.5, 3, 3);
    }
    ctx.restore();
  }

  /**
   * 静音/只出画标记（**最后画**，压在手柄之上）。
   *
   * 为什么必须画出来：用户报过"这条轨只有画面没声音"，而原因很可能是这段片段的
   * 音量被调到了 0（或做过「删除音频」）。没有标记的话，从时间线上完全看不出
   * "这段不出声"，只能选中它去右栏看——等于让人猜。
   *
   * 为什么必须最后画：先画会被**选中手柄**（右端 8px 的实色块）盖住 ——
   * 而"选中它调音量"正是最需要看到这个标记的时刻（实测红像素 857→532 反而变少）。
   */
  /**
   * 离线素材：**整段 40% 灰蒙层 + 左上角红色「离线」角标**。
   *
   * 为什么蒙层要盖在片段内容（缩略图/波形）之上、徽标之下：
   * 用户扫一眼时间线时，"哪几段是灰的"比任何图标都快；
   * 而角标必须在最上层（否则被蒙层压得看不清）。
   *
   * 判据用 `asset.status === 'offline'`（素材级），不是片段级 ——
   * 同一素材的所有片段**一起**变灰，这才是"这个源没了"的正确表达。
   */
  const offline = asset?.status === 'offline';
  if (offline) {
    ctx.save();
    ctx.fillStyle = 'rgba(120, 120, 120, 0.40)';
    roundRect(ctx, x, y + 2, width, height - 4, radius);
    ctx.fill();
    ctx.restore();
  }

  /**
   * 锁定态：**30% 黑蒙层**（规范 §3.1）。
   *
   * 位置很讲究：必须在"离线灰蒙层之后、所有徽标之前"。
   * - 早于离线蒙层：会被那层 40% 灰冲淡，锁定看起来比离线还浅；
   * - 晚于徽标：把「离线」「静音」这些状态说明也压暗了，用户看不清为什么不能动。
   *
   * 用黑色而不是灰色：离线已经用灰（表示"褪色/失效"），锁定用黑（表示"压住/不可操作"），
   * 两种语义在视觉上能分开；两者同时出现时总暗度约 0.58，确实"双重失效"，符合事实。
   */
  if (locked) {
    ctx.save();
    ctx.fillStyle = colors.lockedOverlay;
    roundRect(ctx, x, y + 2, width, height - 4, radius);
    ctx.fill();
    ctx.restore();
  }

  const silent = clip.audio.gain === 0 || clip.role === 'video';
  if (silent && width > 40) {
    const label = clip.role === 'video' ? '只出画' : '静音';
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const textWidth = ctx.measureText(label).width;
    const badgeW = Math.min(width - 8, textWidth + 8);
    /**
     * 画在**左端**（不是右端）。
     *
     * 右端看着更"整齐"，但长片段的右端往往在视口外——用户滚到哪儿都看不到标记，
     * 等于没画（实测：240 帧 × zoom5 = 1200px，比可视宽度还宽，徽标整个在屏幕外）。
     * 左端跟着片段起点走，只要能看到这段的开头就一定能看到它；剪映的静音图标也在左侧。
     * 选中时左端 8px 是裁切手柄，往右让开。
     */
    const leftEdge = x + (isSelected ? HANDLE_WIDTH + 2 : 2);
    ctx.fillStyle = colors.ghostInvalid;
    roundRect(ctx, leftEdge, y + 4, badgeW, 12, 3);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, leftEdge + 4, y + 10);
  }

  /**
   * 「离线」角标：**左上角**、红底白字、始终可见。
   *
   * 与"静音"徽标错开纵向位置（离线在 y+4，静音在 y+18）：
   * 两者可能同时成立（离线的音频片段 + 静音），叠在一起谁都看不清。
   */
  if (offline && width > 30) {
    const text = '离线';
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const badgeW = Math.min(width - 6, ctx.measureText(text).width + 8);
    const leftEdge = x + (isSelected ? HANDLE_WIDTH + 2 : 2);
    ctx.fillStyle = colors.offline;
    roundRect(ctx, leftEdge, y + 18, badgeW, 12, 3);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, leftEdge + 4, y + 24);
  }

  /**
   * 「锁」角标：**右上角**。
   *
   * 为什么在右上：左上已经被「静音」（y+4）和「离线」（y+18）占了，
   * 三者可能同时成立（锁定 + 离线的静音片段），挤在一起谁都看不清。
   * 用灰底而不是红底：锁定不是错误状态，红色留给"素材没了"。
   */
  if (locked && width > 30) {
    const text = '锁';
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const badgeW = Math.min(width - 6, ctx.measureText(text).width + 8);
    const rightEdge = x + width - (isSelected ? HANDLE_WIDTH + 2 : 2);
    ctx.fillStyle = colors.lockedBorder;
    roundRect(ctx, rightEdge - badgeW, y + 4, badgeW, 12, 3);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, rightEdge - 4, y + 10);
  }

  ctx.restore();
}

function drawOverlayMark(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  state: TimelinePaintState,
  colors: TimelineColors,
): void {
  const x = frameToX(frame, state.doc.zoomLevel) - state.scrollX;
  ctx.save();
  ctx.strokeStyle = colors.overlayMark;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(x + 0.5, RULER_HEIGHT);
  ctx.lineTo(x + 0.5, state.viewport.height);
  ctx.stroke();
  ctx.restore();
}

/**
 * 从素材库拖进来的落点预览。
 *
 * 与 `drawDragDraft` 的区别：那个是"时间线内部移动已有片段"（有吸附线、有原位置），
 * 这个是"外部素材落到某条轨某帧"，所以画一块实心 + 起点竖线，不做吸附线
 * （落点已经由 `buildPlaceAssetOps` 解析过，画出来的就是最终位置）。
 */
function drawDropGhost(
  ctx: CanvasRenderingContext2D,
  ghost: NonNullable<EphemeralState['dropGhost']>,
  state: TimelinePaintState,
  colors: TimelineColors,
): void {
  const row = trackRowOf(trackLayout(state.doc), ghost.trackId);
  if (row === null) return;
  const x = frameToX(ghost.startFrame, state.doc.zoomLevel) - state.scrollX;
  const width = Math.max(2, frameToX(ghost.durationFrames, state.doc.zoomLevel));
  const y = row.top;
  const fill = ghost.valid ? colors.ghost : colors.ghostInvalid;

  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.fillStyle = fill;
  roundRect(ctx, x, y + 2, width, row.height - 4, 4);
  ctx.fill();

  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = fill;
  ctx.lineWidth = 1.5;
  roundRect(ctx, x, y + 2, width, row.height - 4, 4);
  ctx.stroke();

  // 起点竖线：拖到哪一帧要一眼看得出来（比块宽更好认）
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 0.5, y);
  ctx.lineTo(x + 0.5, y + row.height);
  ctx.stroke();
  ctx.restore();
}

function drawDragDraft(
  ctx: CanvasRenderingContext2D,
  drag: NonNullable<EphemeralState['drag']>,
  state: TimelinePaintState,
  colors: TimelineColors,
): void {
  const { doc } = state;
  const row = rowOfClip(doc, trackLayout(doc), drag.clipId);
  const ghostX = frameToX(drag.startFrame, doc.zoomLevel) - state.scrollX;
  const ghostW = Math.max(1, frameToX(drag.durationFrames, doc.zoomLevel));

  // 吸附线
  if (drag.snapLineFrame !== null) {
    const snapX = frameToX(drag.snapLineFrame, doc.zoomLevel) - state.scrollX;
    ctx.save();
    ctx.strokeStyle = colors.snap;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(snapX + 0.5, 0);
    ctx.lineTo(snapX + 0.5, state.viewport.height);
    ctx.stroke();
    ctx.restore();
  }

  if (row === null) return;

  // ghost 块（高度跟着轨道走，轨道可调高之后不能再写死 TRACK_HEIGHT）
  const y = row.top;
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = drag.valid ? colors.ghost : colors.ghostInvalid;
  roundRect(ctx, ghostX, y + 2, ghostW, row.height - 4, 4);
  ctx.fill();
  ctx.restore();
}

function drawPlayhead(
  ctx: CanvasRenderingContext2D,
  state: TimelinePaintState,
  colors: TimelineColors,
): void {
  const x = frameToX(state.doc.playheadFrame, state.doc.zoomLevel) - state.scrollX;
  if (x < -1 || x > state.viewport.width + 1) return;
  ctx.save();
  ctx.strokeStyle = colors.playhead;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 0.5, 0);
  ctx.lineTo(x + 0.5, state.viewport.height);
  ctx.stroke();

  // 标尺上的小三角
  ctx.fillStyle = colors.playhead;
  ctx.beginPath();
  ctx.moveTo(x - 4, 0);
  ctx.lineTo(x + 4, 0);
  ctx.lineTo(x, RULER_HEIGHT);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** 画圆角矩形路径（不 fill/stroke）。 */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}
