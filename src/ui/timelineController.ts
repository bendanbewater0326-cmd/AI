/**
 * 时间线交互控制器（架构 §9，task:T16）。
 *
 * ## 职责与铁律
 *
 * 1. **纯逻辑与副作用分离**：命中测试 / 吸附 / 重叠避让 / 裁剪 clamp / 缩放锚点
 *    全部是**纯函数**（只读入参，不碰 store、不碰 DOM），可单元测试。指针状态机
 *    （`TimelineController`）是唯一的副作用层，只做两件事：把指针事件换算成纯函数
 *    入参，以及把结果写回 store（拖动期间 `setDraft`，松手 `dispatch`）。
 * 2. **一次拖拽 = 一个撤销步**（§7.4 / T16 ⑤）：拖动全程只 `setDraft`（写 ephemeral，
 *    不触发 doc 通道）；`pointerup` 时用 `beginTransaction({ mergeKey })` + `upsert` +
 *    `commit`，同 mergeKey 后写覆盖前写，最终只入栈一次。
 * 3. **拖动期间 React 不重渲染**（§9.4 / T16 ⑥）：全程不 `dispatch`、不写 doc，
 *    只 `setDraft` + `requestPaint`（rAF 合帧，由 TimelineView 提供）。
 *
 * ## 时基换算纪律
 *
 * 帧 → 像素 `frame * zoomLevel`（zoom 单位 px/帧）；像素 → 帧 `round(dx / zoomLevel)`。
 * 裁剪的素材帧跨度 → 项目帧时长用 `projectSpanFrames`；裁剪左边缘改 `inFrame` 后的
 * 新 `startFrame` 用 `assetFrameToProjectFrame`（half-up，仅裁剪/建片段时合法）。
 */
import {
  MAX_ZOOM_LEVEL,
  MIN_ZOOM_LEVEL,
  trackDisplayOrder,
} from '../core/types';
import type {
  Clip,
  ClipOperation,
  DragDraft,
  EphemeralState,
  Frame,
  Px,
  Project,
  TrimState,
} from '../core/types';
import { assetFrameToProjectFrame, projectSpanFrames } from '../core/timebase';
import { trackLayout, trackRowAtY } from '../core/trackLayout';

/* ================= 常量 ================= */

/** 吸附阈值（px）；Alt 按住时禁用吸附（R-022）。 */
export const SNAP_THRESHOLD_PX = 8;
/** 手柄命中宽度（px），与 painter 的 `HANDLE_WIDTH` 一致。 */
export const HANDLE_HIT_PX = 8;
/**
 * 未选中片段的手柄命中宽度（略窄一点）。
 *
 * 手柄**不要求先选中**（旧实现要求，导致"第一次抓右端变成整体移动"，用户以为裁剪坏了）；
 * 但选中之后给更宽的目标，因为那时用户明确是在调这一段。
 */
export const HANDLE_HIT_PX_UNSELECTED = 6;

/* ================= 命中测试 ================= */

export type HitZone =
  | 'ruler'
  | 'track-header'
  | 'track-body'
  | 'clip-body'
  | 'clip-handle-left'
  | 'clip-handle-right';

export interface HitResult {
  zone: HitZone;
  clipId: string | null;
  trackId: string | null;
  /** 命中处的项目帧（用于标尺 seek）。 */
  frame: Frame;
}

/**
 * 命中测试：把画布坐标（**未加滚动**的原始 x、含滚动后的 y 无所谓，x 传"内容坐标"）
 * 映射到交互区。
 *
 * @param x 内容坐标（lane 坐标系：`canvasX - TRACK_HEADER_WIDTH + scrollX`；
 *          `< 0` 即落在轨道头那一列）
 * @param y 画布 y
 */
export function hitTest(
  doc: Project,
  ephemeral: EphemeralState,
  x: number,
  y: number,
): HitResult {
  const zoom = doc.zoomLevel;
  const frame = Math.max(0, Math.floor(x / zoom));

  /**
   * 标尺区 / 轨道定位。
   *
   * **必须查 `trackLayout`**：轨道高度按类型不同（视频 60 / 音频 50 / 字幕 32），
   * 用"第几行 × 统一行高"会在第二条轨之后全错位（点 V1 命中到 V2、拖放落到别处）。
   */
  const layout = trackLayout(doc);
  if (y < layout.rulerHeight) return { zone: 'ruler', clipId: null, trackId: null, frame };

  const row = trackRowAtY(layout, y);
  const track = row === null ? undefined : doc.tracks.find((item) => item.id === row.trackId);
  if (track === undefined) return { zone: 'track-body', clipId: null, trackId: null, frame };

  // 轨道头（lane 坐标系里 x<0 就是头部那一列）
  if (x < 0) return { zone: 'track-header', clipId: null, trackId: track.id, frame };

  // 片段命中：从后往前（上层优先）
  for (let i = track.clips.length - 1; i >= 0; i -= 1) {
    const clip = track.clips[i];
    if (clip === undefined) continue;
    const startPx = clip.startFrame * zoom;
    const endPx = (clip.startFrame + clip.durationFrames) * zoom;
    if (x < startPx || x >= endPx) continue;

    // 手柄**任何时候都能命中**（不要求"先选中"）。
    // 旧实现要求 `selectedClipId === clip.id` 才算手柄，于是用户第一次抓片段右端拖动时
    // 命中是 `clip-body` → 变成整体移动，看起来像"裁剪拖不动 / 只能整体往右跑"。
    // 真实剪辑软件都是"hover 到边缘就能裁"，不需要先点一下。
    const handlePx = ephemeral.selectedClipId === clip.id ? HANDLE_HIT_PX : HANDLE_HIT_PX_UNSELECTED;
    if (x - startPx < handlePx) {
      return { zone: 'clip-handle-left', clipId: clip.id, trackId: track.id, frame };
    }
    if (endPx - x < handlePx) {
      return { zone: 'clip-handle-right', clipId: clip.id, trackId: track.id, frame };
    }
    return { zone: 'clip-body', clipId: clip.id, trackId: track.id, frame };
  }

  return { zone: 'track-body', clipId: null, trackId: track.id, frame };
}

/* ================= 吸附（R-022） ================= */

/** 收集吸附候选帧：所有片段边界（start / end）、播放头、0 帧。 */
export function collectSnapCandidates(doc: Project, movingClipId: string): Frame[] {
  const candidates = new Set<number>([0, doc.playheadFrame]);
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.id === movingClipId) continue;
      candidates.add(clip.startFrame);
      candidates.add(clip.startFrame + clip.durationFrames);
    }
  }
  return [...candidates].sort((a, b) => a - b);
}

/**
 * 吸附：返回 `frame` 若落在候选帧 ±thresholdPx 内，否则返回原始帧。
 * `alt` 为 true 时禁用吸附（R-022 ④）。
 */
export function snapFrame(
  frame: Frame,
  candidates: Frame[],
  zoom: Px,
  alt: boolean,
  thresholdPx = SNAP_THRESHOLD_PX,
): { frame: Frame; snapped: boolean } {
  if (alt) return { frame, snapped: false };
  const thresholdFrames = thresholdPx / zoom;
  let best: Frame | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const dist = Math.abs(candidate - frame);
    if (dist <= thresholdFrames && dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best === null ? { frame, snapped: false } : { frame: best, snapped: true };
}

/* ================= 重叠避让（T16 ①） ================= */

/** 片段在项目时基上的区间。 */
interface Interval {
  start: Frame;
  end: Frame; // exclusive
}

/**
 * 解析移动落点：把片段移到 `trackId` 的 `proposedStart`，若与同轨其它片段重叠，
 * 选左右两侧可用空间中距离更近者；两侧相等取右侧（向右避让，保持与左侧片段的相对顺序）。
 *
 * 返回 `valid: false` 表示目标轨是音轨（视频片段不可落音轨，R-020），
 * 调用方应回弹并显示禁止光标。
 */
export function resolveMoveTarget(
  doc: Project,
  clip: Clip,
  targetTrackId: string,
  proposedStart: Frame,
): { startFrame: Frame; valid: boolean; snapLineFrame: Frame | null } {
  const targetTrack = doc.tracks.find((track) => track.id === targetTrackId);
  if (targetTrack === undefined) return { startFrame: proposedStart, valid: false, snapLineFrame: null };
  const asset = doc.assets.find((item) => item.id === clip.assetId);
  if (asset?.kind === 'video' && targetTrack.kind === 'audio') {
    return { startFrame: proposedStart, valid: false, snapLineFrame: null };
  }

  const duration = clip.durationFrames;
  const others: Interval[] = targetTrack.clips
    .filter((item) => item.id !== clip.id)
    .map((item) => ({ start: item.startFrame, end: item.startFrame + item.durationFrames }))
    .sort((a, b) => a.start - b.start);

  const proposed: Interval = { start: proposedStart, end: proposedStart + duration };
  const overlaps = others.some((item) => item.start < proposed.end && proposed.start < item.end);
  if (!overlaps) {
    return { startFrame: proposedStart, valid: true, snapLineFrame: null };
  }

  // 枚举所有"宽度 ≥ duration"的空隙（含首尾），对每个空隙取贴左/贴右两个落点，
  // 选离 proposedStart 最近者；距离相等取右侧（向右避让）。
  //
  // 为什么不能只算"左候选/右候选"：与 proposed 重叠的片段可能 **straddle**（横跨）
  // 目标区间——它既不在"完全在左"集合里，也不在"完全在右"集合里，会导致左右候选
  // 双双漏掉它而退回 0。枚举空隙对 straddle 天然免疫。
  const gaps: Array<{ lo: number; hi: number }> = [];
  let prevEnd = 0;
  for (const item of others) {
    if (item.start - prevEnd >= duration) gaps.push({ lo: prevEnd, hi: item.start });
    prevEnd = Math.max(prevEnd, item.end);
  }
  gaps.push({ lo: prevEnd, hi: Number.POSITIVE_INFINITY });

  let best: number | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  let bestIsRight = false;
  for (const gap of gaps) {
    const candidates = [gap.lo];
    if (Number.isFinite(gap.hi)) candidates.push(gap.hi - duration);
    for (const candidate of candidates) {
      if (candidate < 0) continue;
      const dist = Math.abs(candidate - proposedStart);
      const isRight = candidate > proposedStart;
      if (dist < bestDist || (dist === bestDist && isRight && !bestIsRight)) {
        bestDist = dist;
        best = candidate;
        bestIsRight = isRight;
      }
    }
  }

  const resolved = best ?? 0;
  return { startFrame: resolved, valid: true, snapLineFrame: resolved };
}

/* ================= 裁剪（T16 ② / R-021） ================= */

/**
 * 解析裁剪：`handle` 为 left/right，`deltaFrames` 为拖动的项目帧增量。
 *
 * - 左手柄改 `inFrame`（同步移动 `startFrame`，保证内容不跳变），clamp 到 [0, outFrame-1]
 * - 右手柄改 `outFrame`，clamp 到 [inFrame+1, asset.durationFrames]
 * - 最短 1 帧（`durationFrames ≥ 1` 由 clamp 保证）
 * - `durationFrames` 用 `projectSpanFrames` 重算（素材帧跨度 → 项目帧，half-up）
 *
 * 返回 null 表示该方向无法再裁（已到边界，控制器据此不产生拖动）。
 */
export function resolveTrim(
  doc: Project,
  clip: Clip,
  handle: 'left' | 'right',
  deltaFrames: Frame,
): TrimState | null {
  const asset = doc.assets.find((item) => item.id === clip.assetId);
  if (asset === undefined) return null;
  const assetEnd = asset.durationFrames ?? Number.POSITIVE_INFINITY;

  if (handle === 'left') {
    const newInFrame = Math.min(Math.max(clip.inFrame + deltaFrames, 0), clip.outFrame - 1);
    if (newInFrame === clip.inFrame && deltaFrames !== 0) return null;
    const newStartFrame = assetFrameToProjectFrame(newInFrame, clip, asset, doc.fpsMilli);
    const newDuration = projectSpanFrames(clip.outFrame - newInFrame, asset.fpsMilli, doc.fpsMilli, clip.speedMilli ?? 1000);
    return { inFrame: newInFrame, outFrame: clip.outFrame, startFrame: newStartFrame, durationFrames: newDuration };
  }

  const maxOut = Math.min(assetEnd, clip.outFrame + deltaFrames < clip.inFrame + 1 ? clip.inFrame + 1 : clip.outFrame + deltaFrames);
  const newOutFrame = Math.min(Math.max(clip.inFrame + 1, clip.outFrame + deltaFrames), maxOut);
  if (newOutFrame === clip.outFrame && deltaFrames !== 0) return null;
  const newDuration = projectSpanFrames(newOutFrame - clip.inFrame, asset.fpsMilli, doc.fpsMilli, clip.speedMilli ?? 1000);
  return { inFrame: clip.inFrame, outFrame: newOutFrame, startFrame: clip.startFrame, durationFrames: newDuration };
}

/* ================= 缩放（R-029 / T16 ⑦） ================= */

export function clampZoom(zoom: number): Px {
  if (!Number.isFinite(zoom)) return 5 as Px;
  return Math.min(Math.max(zoom, MIN_ZOOM_LEVEL), MAX_ZOOM_LEVEL) as Px;
}

/**
 * 以 `anchorFrame` 为锚缩放：返回新的 scrollX，使 anchor 帧在视口中的像素位置不变。
 *
 * `anchorX` = anchor 帧当前在视口中的 x（px）。缩放后
 * `newScrollX = anchorFrame * newZoom - anchorX`。
 */
export function zoomScrollX(
  anchorFrame: Frame,
  anchorViewportX: number,
  newZoom: Px,
): number {
  return anchorFrame * newZoom - anchorViewportX;
}

/* ================= 操作构造 ================= */

/** 把一次拖动落点构造成 `moveClip` op（含跨轨）。 */
export function buildMoveOperation(clip: Clip, fromTrackId: string, fromStart: Frame, to: { trackId: string; startFrame: Frame }): ClipOperation {
  return {
    op: 'moveClip',
    clipId: clip.id,
    from: { trackId: fromTrackId, startFrame: fromStart },
    to: { trackId: to.trackId, startFrame: to.startFrame },
  };
}

/** 把一次裁剪构造成 `trimClip` op。 */
export function buildTrimOperation(clip: Clip, from: TrimState, to: TrimState): ClipOperation {
  return { op: 'trimClip', clipId: clip.id, from, to };
}

/* ================= 控制器（副作用层） ================= */

export interface TimelineControllerDeps {
  /** 读当前 doc（含 zoomLevel）。 */
  getDoc: () => Project;
  /** 读 ephemeral（选中态等）。 */
  getEphemeral: () => EphemeralState;
  /** 读当前水平滚动（px）。 */
  getScrollX: () => number;
  /** 写拖动草稿（拖动期间每帧调用）。 */
  setDraft: (draft: DragDraft | null) => void;
  /** 拖动松手时提交操作（一次拖动一个撤销步）。 */
  commit: (ops: ClipOperation[], label: string) => void;
  /** 选中片段。 */
  select: (clipId: string | null) => void;
  /** 播放头 seek（标尺点击）。 */
  seek: (frame: Frame, mode: 'exact' | 'scrub') => void;
  /** 请求重绘（rAF 合帧，TimelineView 提供）。 */
  requestPaint: () => void;
  /** 缩放（以播放头为锚）。 */
  setZoom: (zoom: Px) => void;
  /**
   * 操作被拒绝时给一句可读提示（例如"轨道已锁定"）。
   *
   * 为什么需要：锁定轨上的片段**能选中**（用户要能看它的属性），
   * 但拖动/裁剪必须被拒绝。拒绝时如果不说话，用户会以为"软件卡了"——
   * 这是所有剪辑软件里最容易让人暴躁的一类反馈缺失。
   */
  notifyBlocked?: (message: string) => void;
}

/** 拖拽进行中的状态。 */
interface DragState {
  kind: 'move' | 'trim-left' | 'trim-right' | 'scrub';
  clipId: string | null;
  trackId: string | null;
  /** 拖动的起始画布 x（内容坐标）。 */
  startX: number;
  /** 片段拖动前的原始位置（用于 move op 的 `from`）。 */
  fromStart: Frame;
  fromTrackId: string;
  /** 当前累计的项目帧增量。 */
  deltaFrames: Frame;
  /** 最近一次算出的落点（用于松手提交）。 */
  resolvedStart: Frame | null;
  resolvedTrackId: string | null;
  /** 吸附线帧。 */
  snapLineFrame: Frame | null;
  /** 按下时指针所在的帧（松手时若没拖动，用它把播放头移过来）。 */
  pressFrame: Frame;
  /** 是否合法（音轨回弹）。 */
  valid: boolean;
}

/**
 * 创建时间线控制器。**不直接绑 DOM**——`onPointerDown/Move/Up` 由 TimelineView 调用，
 * 这样 E2E 可以在合成事件里精确控制坐标与时机。
 */
export function createTimelineController(deps: TimelineControllerDeps) {
  let drag: DragState | null = null;

  function pointerDown(x: number, y: number): void {
    const doc = deps.getDoc();
    const ephemeral = deps.getEphemeral();
    // **x 已经是内容坐标**（`TimelineView.laneX()` 里加过 scrollX）。
    // 这里再加一次是"双重偏移"：平时 scrollX=0 看不出来，**一旦时间线滚动**（跟随播放头）
    // 所有点击都会偏到 `2×scrollX` 之外 —— 表现为"播完之后点哪都没反应、也选不中片段"，
    // 按空格重播（播放头回 0、滚动归零）才恢复（用户实测的"死循环"）。
    const hit = hitTest(doc, ephemeral, x, y);

    if (hit.zone === 'ruler') {
      drag = {
        kind: 'scrub', clipId: null, trackId: null,
        startX: x, fromStart: hit.frame, fromTrackId: '',
        deltaFrames: 0, resolvedStart: null, resolvedTrackId: null,
        snapLineFrame: null, valid: true, pressFrame: hit.frame,
      };
      deps.seek(hit.frame, 'scrub');
      return;
    }

    if (hit.clipId === null) {
      // 点空白：取消选中 + **把播放头移过来**（不产生撤销步）。
      // 只取消选中会让用户以为"点了没反应"——大多数剪辑软件点时间线任意位置都会定位播放头。
      deps.select(null);
      deps.seek(hit.frame, 'exact');
      return;
    }

    const clip = findClip(doc, hit.clipId);
    if (clip === undefined) return;
    deps.select(clip.id);

    /**
     * **锁定轨：允许选中，拒绝拖动/裁剪**。
     *
     * 顺序很重要：先 `select`（用户要能选中它去右栏看属性、或者干脆解锁），
     * 再拦拖动。如果连选中都拦掉，用户点一下完全没反应，会以为界面坏了。
     *
     * 锁定是轨道级的（S3 的决定），所以判 `track.locked` 而不是片段字段。
     */
    const ownerTrack = doc.tracks.find((track) => track.id === clip.trackId);
    if (ownerTrack?.locked === true) {
      deps.notifyBlocked?.(`轨道 ${ownerTrack.name} 已锁定，先解锁才能拖动或裁剪`);
      deps.requestPaint();
      return;
    }

    const isLeftHandle = hit.zone === 'clip-handle-left';
    const isRightHandle = hit.zone === 'clip-handle-right';
    const kind = isLeftHandle ? 'trim-left' : isRightHandle ? 'trim-right' : 'move';

    drag = {
      kind,
      clipId: clip.id,
      trackId: hit.trackId,
      startX: x,
      fromStart: clip.startFrame,
      fromTrackId: clip.trackId,
      deltaFrames: 0,
      resolvedStart: clip.startFrame,
      resolvedTrackId: clip.trackId,
      snapLineFrame: null,
      valid: true,
      pressFrame: hit.frame,
    };

    if (kind === 'move') {
      // 立即进入拖动草稿（不 dispatch）
      deps.setDraft({ kind: 'move', clipId: clip.id, trackId: clip.trackId, startFrame: clip.startFrame, inFrame: clip.inFrame, outFrame: clip.outFrame, durationFrames: clip.durationFrames, snapLineFrame: null, valid: true });
    }
  }

  function pointerMove(x: number, y: number, alt: boolean): void {
    if (drag === null) return;
    const doc = deps.getDoc();
    const zoom = doc.zoomLevel;

    if (drag.kind === 'scrub') {
      // 同上：x 已是内容坐标，不再叠加 scrollX
      const frame = Math.max(0, Math.floor(x / zoom));
      deps.seek(frame, 'scrub');
      deps.requestPaint();
      return;
    }

    if (drag.clipId === null || drag.trackId === null) return;
    const clip = findClip(doc, drag.clipId);
    if (clip === undefined) return;

    const dx = x - drag.startX;
    const deltaFrames = Math.round(dx / zoom);
    drag.deltaFrames = deltaFrames;

    if (drag.kind === 'move') {
      // 计算目标轨道（拖到别的轨）：y 与绘制共用 trackDisplayOrder，否则多轨时必错位
      const hitTrackIndex = Math.floor((y - 24) / 56);
      const targetTrack = trackDisplayOrder(doc.tracks)[hitTrackIndex];
      const targetTrackId = targetTrack?.id ?? drag.fromTrackId;

      // 吸附（移动时吸附片段起始位置）
      const candidates = collectSnapCandidates(doc, clip.id);
      const proposed = Math.max(0, drag.fromStart + deltaFrames);
      const snapped = snapFrame(proposed, candidates, zoom, alt);

      const resolved = resolveMoveTarget(doc, clip, targetTrackId, snapped.frame);
      drag.resolvedStart = resolved.startFrame;
      drag.resolvedTrackId = targetTrackId;
      drag.snapLineFrame = resolved.snapLineFrame ?? (snapped.snapped ? snapped.frame : null);
      drag.valid = resolved.valid;

      deps.setDraft({
        kind: 'move',
        clipId: clip.id,
        trackId: resolved.valid ? targetTrackId : drag.fromTrackId,
        startFrame: resolved.startFrame,
        inFrame: clip.inFrame,
        outFrame: clip.outFrame,
        durationFrames: clip.durationFrames,
        snapLineFrame: drag.snapLineFrame,
        valid: resolved.valid,
      });
      deps.requestPaint();
      return;
    }

    // trim
    const handle = drag.kind === 'trim-left' ? 'left' : 'right';
    const trimmed = resolveTrim(doc, clip, handle, deltaFrames);
    if (trimmed !== null) {
      deps.setDraft({
        kind: 'trim',
        clipId: clip.id,
        trackId: clip.trackId,
        startFrame: trimmed.startFrame,
        inFrame: trimmed.inFrame,
        outFrame: trimmed.outFrame,
        durationFrames: trimmed.durationFrames,
        snapLineFrame: null,
        valid: true,
      });
      deps.requestPaint();
    }
  }

  function pointerUp(): void {
    if (drag === null) return;
    const doc = deps.getDoc();

    if (drag.kind === 'scrub') {
      const frame = Math.max(0, drag.deltaFrames === 0 ? drag.fromStart : drag.fromStart);
      // scrub 松手：精确 seek（两段式由 seek 的 exact 模式保证）
      deps.seek(frame, 'exact');
      drag = null;
      deps.setDraft(null);
      return;
    }

    if (drag.clipId === null) {
      drag = null;
      deps.setDraft(null);
      return;
    }
    const clip = findClip(doc, drag.clipId);
    if (clip === undefined) {
      drag = null;
      deps.setDraft(null);
      return;
    }

    if (drag.kind === 'move') {
      // 点一下（没拖动）也把播放头移到点击位置：
      // 用户直觉是"点时间线上某个位置 = 到那个位置"，而不是只有 24px 的标尺条能定位。
      if (drag.deltaFrames === 0) deps.seek(drag.pressFrame, 'exact');
      if (drag.valid && drag.resolvedStart !== null && drag.resolvedTrackId !== null) {
        const from = { trackId: drag.fromTrackId, startFrame: drag.fromStart };
        const to = { trackId: drag.resolvedTrackId, startFrame: drag.resolvedStart };
        if (from.trackId !== to.trackId || from.startFrame !== to.startFrame) {
          deps.commit([buildMoveOperation(clip, from.trackId, from.startFrame, to)], '移动片段');
        }
      }
    } else {
      const handle = drag.kind === 'trim-left' ? 'left' : 'right';
      const trimmed = resolveTrim(doc, clip, handle, drag.deltaFrames);
      if (trimmed !== null && trimmed.durationFrames !== clip.durationFrames) {
        const from: TrimState = { inFrame: clip.inFrame, outFrame: clip.outFrame, startFrame: clip.startFrame, durationFrames: clip.durationFrames };
        deps.commit([buildTrimOperation(clip, from, trimmed)], '裁剪片段');
      }
    }

    drag = null;
    deps.setDraft(null);
  }

  function cancel(): void {
    drag = null;
    deps.setDraft(null);
  }

  return {
    pointerDown,
    pointerMove,
    pointerUp,
    cancel,
    get drag(): DragState | null {
      return drag;
    },
  };
}

/* ---------------- 工具 ---------------- */

function findClip(doc: Project, clipId: string): Clip | undefined {
  for (const track of doc.tracks) {
    const clip = track.clips.find((item) => item.id === clipId);
    if (clip !== undefined) return clip;
  }
  return undefined;
}

/** 布局常量（与 painter / app.css 对齐；导出供 TimelineView 复用）。 */
export const TIMELINE_RULER_HEIGHT = 24;
export const TIMELINE_TRACK_HEIGHT = 56;
export const TIMELINE_TRACK_HEADER_WIDTH = 56;
