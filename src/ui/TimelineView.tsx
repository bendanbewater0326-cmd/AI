/**
 * 时间线视图（T16 UI 层，架构 §9）：把 T15 painter + T16 controller 接进真实 canvas。
 *
 * ## 布局
 *
 * `.v-timeline` 是 grid：toolbar 28 / ruler 24 / tracks(1fr)。canvas 跨 ruler+tracks
 * 两行（grid-row 2/4），内部高 24 + 3×56，与 `timelinePainter` 的
 * `RULER_HEIGHT`/`TRACK_HEIGHT` 完全对齐。
 *
 * **canvas 内部尺寸 = CSS 尺寸**（1:1）：早期版本把内部宽固定成 1200 再让 CSS 拉伸，
 * 指针坐标必须按 `canvas.width / rect.width` 换算，缩放窗口后拖拽会飘；改成 1:1 后
 * 坐标直接相减，且横向滚动可以直接用像素表达。
 *
 * ## 坐标体系
 *
 * - **屏幕坐标**：canvas 像素，x 从 0 开始（0–56 是轨道头那一列）。
 * - **lane 坐标（内容坐标）**：`screenX - TRACK_HEADER_WIDTH + scrollX`，即"时间线内容"
 *   的坐标系，`frame × zoom` 就在这个体系里。painter 用 `translate(56,0)` 绘制，
 *   controller 的命中测试吃 lane 坐标。
 *
 * ## 铁律（§9.4）
 *
 * 1. **拖动期间不 dispatch**：controller 全程只 `setDraft` + `requestPaint`，松手才 `commit`。
 * 2. **rAF 合帧**：`requestPaint` 用 pending 标记合并同一帧内的多次请求。
 * 3. **播放头滚动**（R-011）：播放头越出可视区才滚，步长 ≥ 1 屏宽，不逐帧抖。
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { Clip, Project, Track, TrackKind } from '../core/types';
import { createClip, createTextContent, makeError, normalizeRotation, trackDisplayOrder } from '../core/types';
import { buildPlaceAssetOps, nextTrackFor, trackRemoveBlockReason } from '../core/placement';
import { secondsToFrames } from '../core/timebase';
import { trackLayout, trackRowAtY } from '../core/trackLayout';
import {
  buildDuplicateTrackOps,
  buildMoveTrackOps,
  buildShiftTrackOps,
  heightFromDrag,
  moveBlockReason,
  trackDropTarget,
} from '../core/trackOps';
import { store, useDerived, useSelection, useSnapEnabled } from '../core/store';
import { applyFirstAssetParams } from '../core/operations';
import type { Transport } from '../media/playbackClock';
import { getThumbnail, putThumbnail } from '../persist/autosave';
import { probeMediaFile } from '../media/importPipeline';
import { downloadExport, exportProject } from '../export/exporter';
import {
  DEFAULT_TIMELINE_COLORS,
  RULER_HEIGHT,
  TRACK_HEIGHT,
  TRACK_HEADER_WIDTH,
  frameToX,
  paintTimeline,
} from '../render/timelinePainter';
import type { TimelineColors } from '../render/timelinePainter';
import {
  clampZoom,
  collectSnapCandidates,
  createTimelineController,
  hitTest,
  snapFrame,
  zoomScrollX,
} from './timelineController';
import { buildPasteOperations, clipboardSize, copyClips } from '../core/clipboard';
import { buildDetachAudioOps, detachAudioBlockReason } from '../core/detachAudio';
import { buildFreezeOps, freezeBlockReason } from '../core/freeze';
import { ContextMenu } from './ContextMenu';
import { TrackHeader } from './TrackHeader';
import type { ContextMenuItem, ContextMenuState } from './ContextMenu';
import { formatTimecode } from './TopBar';
import { clearDraggingAsset, getDraggingAssetId, hasAssetDrag, readAssetDrag } from './dnd';

/** 从 CSS 变量读时间线配色（深色主题时覆盖）。 */
function readColors(): TimelineColors {
  if (typeof window === 'undefined') return DEFAULT_TIMELINE_COLORS;
  const css = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string): string => {
    const value = css.getPropertyValue(name).trim();
    return value === '' ? fallback : value;
  };
  return {
    ...DEFAULT_TIMELINE_COLORS,
    bg: pick('--v-bg', DEFAULT_TIMELINE_COLORS.bg),
    track: pick('--v-track', DEFAULT_TIMELINE_COLORS.track),
    // 分类型底色：必须在 CSS 里定义成变量，否则高对比主题（[data-theme='contrast']）覆盖不到
    offline: pick('--v-tl-offline', DEFAULT_TIMELINE_COLORS.offline),
    lockedOverlay: pick('--v-tl-locked', DEFAULT_TIMELINE_COLORS.lockedOverlay),
    lockedBorder: pick('--v-tl-locked-border', DEFAULT_TIMELINE_COLORS.lockedBorder),
    hoverGlow: pick('--v-tl-hover-glow', DEFAULT_TIMELINE_COLORS.hoverGlow),
    trackVideo: pick('--v-tl-track-video-bg', DEFAULT_TIMELINE_COLORS.trackVideo),
    trackAudio: pick('--v-tl-track-audio-bg', DEFAULT_TIMELINE_COLORS.trackAudio),
    trackText: pick('--v-tl-track-text-bg', DEFAULT_TIMELINE_COLORS.trackText),
    border: pick('--v-border', DEFAULT_TIMELINE_COLORS.border),
    rulerBg: pick('--v-surface', DEFAULT_TIMELINE_COLORS.rulerBg),
    rulerText: pick('--v-fg-dim', DEFAULT_TIMELINE_COLORS.rulerText),
    clip: pick('--v-clip', DEFAULT_TIMELINE_COLORS.clip),
    clipText: pick('--v-fg', DEFAULT_TIMELINE_COLORS.clipText),
    accent: pick('--v-accent', DEFAULT_TIMELINE_COLORS.accent),
    selection: pick('--v-accent', DEFAULT_TIMELINE_COLORS.selection),
    playhead: DEFAULT_TIMELINE_COLORS.playhead,
  };
}

interface TimelineViewProps {
  transport: Transport;
}

interface RenameState {
  trackId: string;
  draft: string;
}

export function TimelineView({ transport }: TimelineViewProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** 右键菜单（片段）：{x,y,clipId}。 */
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const scrollXRef = useRef(0);
  const thumbnailsRef = useRef<Map<string, ImageBitmap>>(new Map());
  const pendingRef = useRef(false);
  const derived = useDerived();
  const selection = useSelection();
  const [rename, setRename] = useState<RenameState | null>(null);
  /** 上一次绘制时的播放头位置：用来区分"播放头自己动了"和"用户手动横向滚动"。 */
  const lastPlayheadRef = useRef(-1);
  /**
   * 待导入音频的落点。
   *
   * 点"配音频…"时先把落点记下来，再 `click()` 隐藏的 `<input type=file>`；
   * 用户取消选择时 `change` 不会触发，落点会留到下一次——所以每次点菜单都**覆盖**它，
   * 而不是"用完清空就完事"（否则第二次点菜单会用到上一次的落点）。
   */
  const audioImportRef = useRef<{ startFrame: number; label: string } | null>(null);
  const audioInputRef = useRef<HTMLInputElement | null>(null);

  const doc = store.getDoc();
  /**
   * 吸附开关（ephemeral：不进工程、不进撤销栈）。
   *
   * **不能直接读 `store.getEphemeral()`**：`notify()` 之后 `useDerived` 的派生对象
   * 在 doc 没变时是同一个引用，React 判定"快照没变"就不重渲染 —— 按钮标签会一直停在旧值。
   * 所以用 `useVersion()` 订阅"任何状态变化"，切换吸附才真的会刷新界面。
   */
  const snapEnabled = useSnapEnabled();
  /** 布局单一真相源：轨道高度按类型不同，画布高必须查表，不能"轨数 × 统一行高"。 */
  const layout = trackLayout(doc);
  const canvasHeight = layout.totalHeight;
  /** "当前操作轨道" = 选中片段所在的轨（不额外维护状态，避免两处不同步）。 */
  const selectedClipTrackId =
    selection === null ? null : (doc.tracks.find((track) => track.clips.some((clip) => clip.id === selection))?.id ?? null);

  /**
   * 拖拽兜底清理：拖到画布外松手、或按 Esc 取消时，`drop` / `dragleave` 都不会触发，
   * 落点预览会一直挂在画布上（看起来像卡住）。`dragend` 一定会在拖拽结束时触发。
   */
  useEffect(() => {
    const cleanup = (): void => {
      clearDraggingAsset();
      if (store.getEphemeral().dropGhost !== null) store.setDropGhost(null);
    };
    window.addEventListener('dragend', cleanup);
    window.addEventListener('drop', cleanup);
    return () => {
      window.removeEventListener('dragend', cleanup);
      window.removeEventListener('drop', cleanup);
    };
  }, []);

  /* ---------- 缩略图：doc.assets 变化时从 IDB 读回 → ImageBitmap ---------- */
  useEffect(() => {
    let cancelled = false;
    const assets = store.getDoc().assets;
    for (const asset of assets) {
      if (asset.thumbnailRef === null) continue;
      if (thumbnailsRef.current.has(asset.id)) continue;
      void (async () => {
        const stored = await getThumbnail(asset.thumbnailRef as string);
        if (cancelled || !stored.ok || stored.value === null) return;
        try {
          const bitmap = await createImageBitmap(stored.value);
          if (cancelled) {
            bitmap.close();
            return;
          }
          thumbnailsRef.current.set(asset.id, bitmap);
          requestPaint();
        } catch {
          // 缩略图损坏不影响绘制
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [derived]);

  /* ---------- 绘制（rAF 合帧，无副作用） ---------- */
  function requestPaint(): void {
    if (pendingRef.current) return;
    pendingRef.current = true;
    requestAnimationFrame(() => {
      pendingRef.current = false;
      const canvas = canvasRef.current;
      if (canvas === null) return;
      const ctx = canvas.getContext('2d');
      if (ctx === null) return;
      const current = store.getDoc();
      clampScroll(current, canvas.width);
      // 只有播放头真的移动了才自动跟随；否则用户一横向滚动就会被拽回播放头处
      const moved = current.playheadFrame !== lastPlayheadRef.current;
      if (moved || transport.playing) {
        lastPlayheadRef.current = current.playheadFrame;
        ensurePlayheadVisible(canvas.width, current);
      }
      // 把滚动量挂到 DOM 上：E2E 与线上排障都能直接读到"到底滚了多少像素"
      canvas.dataset['scrollX'] = String(Math.round(scrollXRef.current));
      paintTimeline(ctx, {
        doc: current,
        ephemeral: store.getEphemeral(),
        viewport: { width: canvas.width, height: canvas.height },
        scrollX: scrollXRef.current,
        thumbnails: thumbnailsRef.current,
        colors: readColors(),
      });
    });
  }

  /** lane 可视宽度（扣除轨道头）。 */
  function laneWidth(viewportWidth: number): number {
    return Math.max(1, viewportWidth - TRACK_HEADER_WIDTH);
  }

  /** 内容总宽：末帧 + 一屏余量，至少一屏。 */
  function contentWidth(doc: Project, viewportWidth: number): number {
    const lane = laneWidth(viewportWidth);
    const durationPx = doc.playheadFrame * doc.zoomLevel + doc.zoomLevel * 300;
    const clipEnd = doc.tracks.reduce(
      (max, track) => Math.max(max, ...track.clips.map((clip) => clip.startFrame + clip.durationFrames)),
      0,
    );
    return Math.max(lane, Math.max(durationPx, clipEnd * doc.zoomLevel) + lane * 0.25);
  }

  function maxScroll(doc: Project, viewportWidth: number): number {
    return Math.max(0, contentWidth(doc, viewportWidth) - laneWidth(viewportWidth));
  }

  function clampScroll(doc: Project, viewportWidth: number): void {
    const max = maxScroll(doc, viewportWidth);
    if (scrollXRef.current > max) scrollXRef.current = max;
    if (scrollXRef.current < 0) scrollXRef.current = 0;
  }

  /**
   * R-011：播放头越出可视区才滚，步长 ≥ 1 屏宽。
   *
   * **滚动位置不能越过内容末尾**：旧实现按"整屏"跳，播到结尾时会把播放头放在视口**左边缘**，
   * 于是整个可视区右侧全是空白（超出 duration 的帧）。用户点画布任何位置都映射到
   * `frame >= duration` → seek 被 clamp → **播放头一动不动、也选不中任何片段**，
   * 表现为"播完之后时间线整个点不动，按空格重播才恢复"（用户实测）。
   * 这里把滚动夹到"内容末尾对齐右边缘"，保证播放头周围始终有内容可点。
   */
  function ensurePlayheadVisible(viewportWidth: number, doc: Project): void {
    const zoom = doc.zoomLevel;
    const playheadX = frameToX(doc.playheadFrame, zoom);
    const lane = laneWidth(viewportWidth);
    const left = scrollXRef.current;
    const right = scrollXRef.current + lane;
    if (playheadX < left || playheadX >= right) {
      const contentEndPx = doc.tracks.reduce(
        (max, track) =>
          Math.max(
            max,
            ...track.clips.map((clip) => frameToX(clip.startFrame + clip.durationFrames, zoom)),
            0,
          ),
        0,
      );
      const limit = Math.max(0, Math.min(maxScroll(doc, viewportWidth), contentEndPx - lane));
      scrollXRef.current = Math.max(0, Math.min(limit, Math.floor(playheadX / lane) * lane));
    }
  }

  /* ---------- 控制器（指针交互） ---------- */
  const controllerRef = useRef<ReturnType<typeof createTimelineController> | null>(null);
  function getController(): ReturnType<typeof createTimelineController> {
    if (controllerRef.current === null) {
      controllerRef.current = createTimelineController({
        notifyBlocked: (message) => store.pushError(makeError('E_INVALID_PROJECT', message)),
        getDoc: () => store.getDoc(),
        getEphemeral: () => store.getEphemeral(),
        getScrollX: () => scrollXRef.current,
        setDraft: (draft) => store.setDrag(draft),
        commit: (ops, label) => {
          store.setDrag(null);
          store.dispatch(ops, label);
        },
        select: (clipId) => store.setSelectedClipId(clipId),
        toggleSelection: (clipId) => store.toggleSelection(clipId),
        seek: (frame, mode) => transport.seekTo(frame, mode),
        requestPaint,
        setZoom: (zoom) => store.setZoomLevel(zoom),
      });
    }
    return controllerRef.current;
  }

  /* ---------- 订阅重绘（doc 通道 + 播放头总线 + 选中态） ---------- */
  useEffect(() => {
    const unsubDoc = store.subscribe(requestPaint);
    const unsubPlayhead = store.playheadBus.subscribe(requestPaint);
    return () => {
      unsubDoc();
      unsubPlayhead();
    };
  }, [derived]);

  useEffect(() => {
    requestPaint();
  }, [selection]);

  /* ---------- canvas 尺寸 1:1 + 首帧绘制 ---------- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const resize = (): void => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(320, Math.round(rect.width));
      if (canvas.width !== width) canvas.width = width;
      requestPaint();
    };
    resize();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    observer?.observe(canvas);
    window.addEventListener('resize', resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas !== null && canvas.height !== canvasHeight) {
      canvas.height = canvasHeight;
    }
    requestPaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasHeight]);

  /* ---------- 指针事件 ---------- */
  function screenX(event: { clientX: number }): number {
    const canvas = canvasRef.current;
    if (canvas === null) return 0;
    const rect = canvas.getBoundingClientRect();
    // canvas 内部宽 = CSS 宽，仍然做一次比例换算兜底（DPR/缩放场景）
    const scale = rect.width > 0 ? canvas.width / rect.width : 1;
    return (event.clientX - rect.left) * scale;
  }
  function screenY(event: { clientY: number }): number {
    const canvas = canvasRef.current;
    if (canvas === null) return 0;
    const rect = canvas.getBoundingClientRect();
    const scale = rect.height > 0 ? canvas.height / rect.height : 1;
    return (event.clientY - rect.top) * scale;
  }
  /** 屏幕 x → lane 内容坐标。 */
  function laneX(event: { clientX: number }): number {
    return screenX(event) - TRACK_HEADER_WIDTH + scrollXRef.current;
  }

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>): void {
    // 拖动中的光标由这里接管（`onPointerMove` 在拖动时不改光标）
    if (canvasRef.current !== null) canvasRef.current.style.cursor = 'grabbing';
    event.preventDefault();
    const y = screenY(event);
    const x = screenX(event);
    // 轨道头：单击不改数据（双击才改名），避免误操作
    if (x < TRACK_HEADER_WIDTH && y >= RULER_HEIGHT) return;
    /**
     * `Ctrl / Cmd` 点击 = 加选（不进入拖动）。
     *
     * Mac 用 `metaKey`：只判 `ctrlKey` 的话 Mac 用户按 Cmd 加选会变成单选，
     * 而 Cmd 才是 Mac 的惯例键。
     */
    getController().pointerDown(laneX(event), y, { additive: event.ctrlKey || event.metaKey });
  }
  /**
   * 指针移动：拖动中交给 controller；**没在拖时更新悬停态与光标**。
   *
   * 悬停态在 S4 之前一直是"实现了但没接上"——`ephemeral.hoverClipId` 从来没被写过，
   * 所以 `drawClip` 里的 hover 分支是死代码。这里补上，并且顺手把光标也管起来：
   * 光标是最便宜的可发现性提示（用户不用试就知道这里能不能拖、能不能裁）。
   */
  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>): void {
    const ctrl = getController();
    if (ctrl.drag !== null) {
      // `alt` 在 controller 里是"这次拖动不吸附"：按住 Alt 临时关，
      // 或者用户已经把吸附整体关掉（`snapEnabled === false`）——两者等价
      ctrl.pointerMove(laneX(event), screenY(event), event.altKey || !snapEnabled);
      return;
    }

    const doc = store.getDoc();
    const hit = hitTest(doc, store.getEphemeral(), laneX(event), screenY(event));
    store.setHoverClipId(hit.clipId);

    const canvas = canvasRef.current;
    if (canvas === null) return;
    if (hit.clipId === null) {
      // 标尺上给 `pointer`（点了会移动播放头），空白轨道区给默认
      canvas.style.cursor = hit.zone === 'ruler' ? 'pointer' : 'default';
      return;
    }
    const track = doc.tracks.find((item) => item.id === hit.trackId);
    if (track?.locked === true) {
      // 锁定：明确告诉用户"这里不能动"，而不是拖了才被拒
      canvas.style.cursor = 'not-allowed';
      return;
    }
    canvas.style.cursor =
      hit.zone === 'clip-handle-left' || hit.zone === 'clip-handle-right' ? 'ew-resize' : 'grab';
  }

  /**
   * 指针离开画布。
   *
   * 两件事必须一起做：
   * 1. `cancel()` —— 拖动中离开画布要放弃这次拖动（否则回来时草稿还挂着）；
   * 2. 清悬停态 + 光标 —— 否则最后一次悬停的片段会一直亮着，
   *    而 `canvas.style.cursor` 会一直停在 `grab`。
   */
  function onPointerLeave(): void {
    getController().cancel();
    store.setHoverClipId(null);
    const canvas = canvasRef.current;
    if (canvas !== null) canvas.style.cursor = 'default';
  }
  function onPointerUp(): void {
    getController().pointerUp();
  }

  /* ---------- 从素材库拖进时间轴（剪映式拖拽，P0-1） ---------- */

  /**
   * 这次拖拽落在哪个帧、哪条轨；不在轨道区域（标尺上/轨道头列）则返回 null。
   *
   * 落点**也走吸附**（R-022 的 `snapFrame`，阈值 8px）：拖到别的片段边缘附近会
   * 自动贴齐，和剪映一样"啪"地吸上去。按住 `Alt` 或关掉吸附（`N`）则不吸。
   */
  function dropTargetAt(event: { clientX: number; clientY: number; altKey?: boolean }): {
    frame: number;
    track: Track;
  } | null {
    const y = screenY(event);
    if (y < RULER_HEIGHT) return null;
    // 轨道头那一列不算落点：往那里拖的意图通常是"我想放到这条轨上"，
    // 但位置没意义（帧 0），不如不接（松手后什么都不发生，也不会误插到开头）
    if (screenX(event) < TRACK_HEADER_WIDTH) return null;
    const row = trackRowAtY(layout, y);
    const track = row === null ? undefined : doc.tracks.find((item) => item.id === row.trackId);
    if (track === undefined) return null;
    const lane = laneX(event);
    // lane 坐标里 0 = 时间线内容起点（轨道头那一列已经减掉了）
    const raw = Math.max(0, Math.floor(lane / Math.max(1, doc.zoomLevel)));
    const snapped = snapFrame(
      raw,
      collectSnapCandidates(doc, ''),
      doc.zoomLevel,
      event.altKey === true || !snapEnabled,
    );
    return { frame: snapped.frame, track };
  }

  /**
   * 落点预览与真正 drop **走同一个函数**。
   *
   * 这样"看到的就是落到的"：如果目标位置被占用而系统把片段挪到了另一条轨，
   * ghost 会直接画在那条轨上，用户不会以为放错了地方。
   */
  function planForDrop(assetId: string, target: { frame: number; track: Track }) {
    const docNow = store.getDoc();
    const asset = docNow.assets.find((item) => item.id === assetId);
    if (asset === undefined) return { message: '素材不存在' };
    if (asset.status === 'offline') return { message: '素材已离线，请先重新链接' };
    return buildPlaceAssetOps(docNow, asset, target.frame, { trackId: target.track.id });
  }

  function onDragOver(event: React.DragEvent<HTMLCanvasElement>): void {
    if (!hasAssetDrag(event.dataTransfer)) return;
    // **必须 preventDefault**，否则浏览器不允许 drop（HTML5 拖放的硬规则）
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    const target = dropTargetAt(event);
    if (target === null) {
      store.setDropGhost(null);
      return;
    }
    // dragover 阶段读不到 getData()，素材 id 来自 ui/dnd 的页面内变量
    const assetId = getDraggingAssetId();
    if (assetId === null) return;
    const plan = planForDrop(assetId, target);
    if ('message' in plan) {
      store.setDropGhost({
        trackId: target.track.id,
        startFrame: target.frame,
        durationFrames: 1,
        valid: false,
        reason: plan.message,
      });
      return;
    }
    store.setDropGhost({
      trackId: plan.trackId,
      startFrame: target.frame,
      durationFrames: plan.durationFrames,
      valid: true,
    });
  }

  function onDragLeave(event: React.DragEvent<HTMLCanvasElement>): void {
    if (!hasAssetDrag(event.dataTransfer)) return;
    // 只有真的离开画布才清：在画布内部换轨道时 dragleave 也会触发
    const canvas = canvasRef.current;
    if (canvas !== null) {
      const rect = canvas.getBoundingClientRect();
      const { clientX, clientY } = event;
      if (clientX > rect.left && clientX < rect.right && clientY > rect.top && clientY < rect.bottom) return;
    }
    store.setDropGhost(null);
  }

  function onDrop(event: React.DragEvent<HTMLCanvasElement>): void {
    if (!hasAssetDrag(event.dataTransfer)) return;
    event.preventDefault();
    const assetId = readAssetDrag(event.dataTransfer) ?? getDraggingAssetId();
    clearDraggingAsset();
    store.setDropGhost(null);
    if (assetId === null) return;
    const target = dropTargetAt(event);
    if (target === null) return;
    const plan = planForDrop(assetId, target);
    if ('message' in plan) {
      store.pushError(makeError('E_INVALID_PROJECT', plan.message));
      return;
    }
    store.dispatch(plan.ops, '拖入片段');
    store.setSelectedClipId(plan.clipId);
  }

  /**
   * 导出单个片段的音频（右键 → 导出这段的音频）。
   *
   * 区间取**片段自己的区间**、`onlyClipId` 只让它一个参与混音：
   * 导出的 WAV 从头就是这段的声音，不带前后静音、也不混别的轨。
   *
   * 为什么直接下载而不是弹导出面板：面板是"整片导出"的心智模型（格式/范围/分辨率），
   * 而这里用户想的就是"把这段的声音存下来"。走面板要改 4 个字段才能按对，反而更绕。
   */
  async function exportClipAudio(clip: Clip): Promise<void> {
    store.setBusy('正在导出音频…');
    try {
      const result = await exportProject({
        doc: store.getDoc(),
        format: 'wav',
        startFrame: clip.startFrame,
        endFrame: clip.startFrame + clip.durationFrames,
        onlyClipId: clip.id,
        onProgress: (progress) => {
          store.setBusy(`正在导出音频… ${Math.round(progress.ratio * 100)}%`);
        },
      });
      if (!result.ok) {
        store.pushError(result.error);
        return;
      }
      downloadExport(result.value);
    } finally {
      store.setBusy(null);
    }
  }

  /** 打开文件选择框，为 `startFrame` 处配一段音频（落点先记在 ref 里）。 */
  function pickAudioAt(startFrame: number, label: string): void {
    audioImportRef.current = { startFrame, label };
    audioInputRef.current?.click();
  }

  /**
   * 用户选完文件：导入成素材 → 落到音频轨。
   *
   * 复用 `probeMediaFile`（与素材栏同一条管线）与 `buildPlaceAssetOps`（同一套落轨规则）：
   * 少一份实现就少一处"只有某个入口会崩"。
   */
  async function onAudioPicked(file: File): Promise<void> {
    const target = audioImportRef.current;
    if (target === null) return;
    store.setBusy('正在解析音频…');
    try {
      const result = await probeMediaFile(file, null);
      if (!result.ok) {
        store.pushError(result.error);
        return;
      }
      const { asset, thumbnailBlob } = result.value;
      applyFirstAssetParams(store, asset);
      store.addAsset(asset);
      if (thumbnailBlob !== null) void putThumbnail(asset.id, thumbnailBlob);
      // 导入进来的音频固定落音频轨：素材本身可能带画面（mp4），但这里用户要的是"声音"
      const plan = buildPlaceAssetOps(store.getDoc(), asset, target.startFrame, { kind: 'audio' });
      if ('message' in plan) {
        store.pushError(makeError('E_DECODE_FAILED', plan.message, asset.name));
        return;
      }
      store.dispatch(plan.ops, target.label);
      store.setSelectedClipId(plan.clipId);
    } finally {
      store.setBusy(null);
    }
  }

  /**
   * 右键片段 → 菜单（删除片段）。
   *
   * 为什么必须给右键：删除只能靠键盘 Delete 的话，用户得先知道有这回事；
   * 而且触摸板/远程桌面里 Delete 经常不在手边。
   */
  function onContextMenu(event: React.MouseEvent<HTMLCanvasElement>): void {
    event.preventDefault();
    const doc = store.getDoc();
    const hit = hitTest(doc, store.getEphemeral(), laneX(event), screenY(event));
    /**
     * 空白处右键：粘贴 + 在**这个位置**插入一段音频。
     *
     * **这条分支以前永远走不到**：旧代码在 `hit.clipId === null` 时就 `setMenu(null)`
     * 提前返回了，于是"粘贴到此处"从上线起就没生效过（用户右键空白处什么都不会发生，
     * 只会以为右键坏了）。判空必须在**取到片段之后**做，而不是在 hitTest 之后。
     */
    const clip =
      hit.clipId === null
        ? undefined
        : doc.tracks.flatMap((track) => track.clips).find((item) => item.id === hit.clipId);
    if (clip === undefined) {
      const items: ContextMenuItem[] = [];
      if (clipboardSize() > 0) {
        items.push({
          label: '粘贴到此处',
          onSelect: () => {
            const result = buildPasteOperations(store.getDoc(), hit.frame);
            if (result.ops.length === 0) return;
            store.dispatch(result.ops, '粘贴片段');
          },
        });
      }
      items.push({
        label: '在此处插入音频…',
        onSelect: () => pickAudioAt(hit.frame, '插入音频'),
      });
      setMenu({ x: event.clientX, y: event.clientY, items });
      return;
    }
    store.setSelectedClipId(clip.id);

    const asset = doc.assets.find((item) => item.id === clip.assetId);
    const detachBlocked = detachAudioBlockReason(doc, clip);
    const muted = clip.audio.gain === 0;
    const hasAudio = asset !== undefined && asset.hasAudio;
    const freezeBlocked = freezeBlockReason(doc, clip, store.getPlayheadFrame());
    const items: ContextMenuItem[] = [
      // 「分离音频」放在第一位：这是剪映/PR 里最常用的右键操作
      {
        label: detachBlocked === null ? '分离音频' : `分离音频（${detachBlocked}）`,
        ...(detachBlocked === null ? {} : { disabled: true }),
        onSelect: () => {
          const plan = buildDetachAudioOps(store.getDoc(), clip.id);
          if ('message' in plan) {
            store.pushError(makeError('E_INVALID_PROJECT', plan.message));
            return;
          }
          store.dispatch(plan.ops, '分离音频');
        },
      },
      {
        // 只把**这一段的**声音存成 WAV（区间 = 片段区间，且只有它参与混音）
        label: '导出这段的音频…',
        disabled: !hasAudio,
        onSelect: () => {
          void exportClipAudio(clip);
        },
      },
      {
        // 从片段开头对齐插入一段外部音频（相当于给这段配一条声轨）
        label: '配一段音频…',
        onSelect: () => pickAudioAt(clip.startFrame, '配音频'),
      },
      { separator: true },
      {
        // 定格：播放头那一帧冻住 3 秒（剪映的默认值），后面的内容整体后移
        label: freezeBlocked === null ? '定格（播放头这一帧，3 秒）' : `定格（${freezeBlocked}）`,
        ...(freezeBlocked === null ? {} : { disabled: true }),
        onSelect: () => {
          const plan = buildFreezeOps(store.getDoc(), clip.id, store.getPlayheadFrame());
          if ('message' in plan) {
            store.pushError(makeError('E_INVALID_PROJECT', plan.message));
            return;
          }
          store.dispatch(plan.ops, '定格 3 秒');
          store.setSelectedClipId(plan.clipId);
        },
      },
      {
        // 倒放只倒画面（音频路径按块解码，倒放会变成一段段碎的怪声）——
        // 所以倒放同时把这段的声音关掉，文案里写清楚
        label: clip.reversed === true ? '取消倒放' : '倒放（只倒画面，静音）',
        disabled: clip.freeze === true,
        onSelect: () => {
          const next = clip.reversed !== true;
          store.dispatch(
            [
              { op: 'setClipProps', clipId: clip.id, path: 'reversed', from: clip.reversed ?? false, to: next },
              { op: 'setClipProps', clipId: clip.id, path: 'role', from: clip.role, to: next ? 'video' : undefined },
            ],
            next ? '倒放' : '取消倒放',
          );
        },
      },
      {
        // 旋转/翻转：菜单里给最常用的两个，细调在属性栏（`docs/nle-baseline.md` §6）
        label: '向右旋转 90°',
        onSelect: () => {
          const from = normalizeRotation(clip.transform.rotation);
          store.dispatch(
            [{ op: 'setClipProps', clipId: clip.id, path: 'transform.rotation', from, to: normalizeRotation(from + 90) }],
            '向右旋转 90°',
          );
        },
      },
      {
        label: clip.transform.flipX === true ? '取消水平翻转' : '水平翻转',
        onSelect: () => {
          const next = clip.transform.flipX !== true;
          store.dispatch(
            [{ op: 'setClipProps', clipId: clip.id, path: 'transform.flipX', from: clip.transform.flipX ?? false, to: next }],
            next ? '水平翻转' : '取消水平翻转',
          );
        },
      },
      {
        // 直接"把声音扔掉"（不新建片段），和"静音"是两件事：
        // 静音还能调回来，删除音频是把这段的音频角色彻底去掉
        label: '删除音频（只留画面）',
        disabled: !hasAudio || clip.role === 'video',
        onSelect: () => {
          store.dispatch(
            [{ op: 'setClipProps', clipId: clip.id, path: 'role', from: clip.role, to: 'video' }],
            '删除音频',
          );
        },
      },
      {
        label: muted ? '取消静音' : '静音',
        disabled: !hasAudio,
        onSelect: () => {
          store.dispatch(
            [{ op: 'setClipProps', clipId: clip.id, path: 'audio.gain', from: clip.audio.gain, to: muted ? 1 : 0 }],
            muted ? '取消静音' : '静音片段',
          );
        },
      },
      { separator: true },
      {
        label: '复制',
        onSelect: () => {
          copyClips(store.getDoc(), [clip.id]);
        },
      },
      {
        label: '删除片段',
        danger: true,
        onSelect: () => {
          store.dispatch([{ op: 'removeClip', clipId: clip.id, removed: clip }], '删除片段');
        },
      },
    ];
    setMenu({ x: event.clientX, y: event.clientY, items });
  }

  /* ---------- 缩放（Ctrl+滚轮，以播放头为锚，R-029）/ 横向滚动（R-011 长项目） ---------- */
  function onWheel(event: React.WheelEvent<HTMLCanvasElement>): void {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const docNow = store.getDoc();
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const anchorViewportX = frameToX(docNow.playheadFrame, docNow.zoomLevel) - scrollXRef.current;
      const factor = event.deltaY < 0 ? 1.25 : 0.8;
      const newZoom = clampZoom(docNow.zoomLevel * factor);
      if (newZoom === docNow.zoomLevel) return;
      store.setZoomLevel(newZoom);
      scrollXRef.current = Math.max(0, zoomScrollX(docNow.playheadFrame, anchorViewportX, newZoom));
      requestPaint();
      return;
    }
    // 横向滚动：Shift+滚轮 = 横向；普通滚轮在内容超宽时也走横向（时间线没有纵向滚动）
    const delta = event.shiftKey ? event.deltaY : event.deltaY !== 0 ? event.deltaY : event.deltaX;
    if (maxScroll(docNow, canvas.width) <= 0) return;
    event.preventDefault();
    scrollXRef.current = Math.max(
      0,
      Math.min(maxScroll(docNow, canvas.width), scrollXRef.current + delta),
    );
    requestPaint();
  }

  function commitRename(): void {
    if (rename === null) return;
    const name = rename.draft.trim();
    const track = store.getDoc().tracks.find((item) => item.id === rename.trackId);
    setRename(null);
    if (track === undefined || name === '' || name === track.name) return;
    store.dispatch([{ op: 'renameTrack', trackId: track.id, from: track.name, to: name }], '重命名轨道');
  }

  /** 在播放头处加一段 3 秒文字（R-034）。放在最上层的视频轨，避免被素材盖住。 */
  function addText(): void {
    const docNow = store.getDoc();
    const track = trackDisplayOrder(docNow.tracks).find((item) => item.kind === 'video');
    if (track === undefined) return;
    const start = store.getPlayheadFrame();
    const duration = Math.max(1, secondsToFrames(3, docNow.fpsMilli));
    const clip = createClip({
      assetId: '',
      trackId: track.id,
      startFrame: start,
      inFrame: 0,
      outFrame: duration,
      durationFrames: duration,
      text: createTextContent(),
    });
    store.dispatch([{ op: 'addClip', clip }], '添加文字');
    store.setSelectedClipId(clip.id);
  }

  function addTrack(kind: TrackKind = 'video'): void {
    // 命名/order 规则与"素材自动落新轨"共用 `core/placement.nextTrackFor`：
    // 两处各自算一次就会出现"点按钮建出 V3、双击素材建出 V2"这种重名。
    const label = kind === 'video' ? '添加视频轨' : kind === 'audio' ? '添加音频轨' : '添加字幕轨';
    store.dispatch([{ op: 'addTrack', track: nextTrackFor(store.getDoc(), kind) }], label);
  }

  /* ---------- 高度拖拽（S3） ---------- */

  /**
   * 拖动轨道头下边缘改高度。
   *
   * ## 两个关键决定
   *
   * 1. **用 `pointermove` 在 window 上监听**，不是在元素上：指针一旦移出那 5px 热区，
   *    元素上的 move 就收不到了，拖动会"卡住"（用户必须一直压着那条细线）。
   * 2. **每次 move 都 dispatch，但带 `mergeKey`**：撤销栈里只留一步，
   *    而画面能跟手。反过来"只在松手时写"会让拖动期间完全看不到变化。
   */
  const heightDragRef = useRef<{ trackId: string; startY: number; startHeight: number; current: number } | null>(
    null,
  );

  function startHeightDrag(event: React.PointerEvent<HTMLElement>, trackId: string, startHeight: number): void {
    // 阻止冒泡：否则轨道头的 onPointerDown 会同时启动"排序拖拽"
    event.stopPropagation();
    event.preventDefault();
    heightDragRef.current = { trackId, startY: event.clientY, startHeight, current: startHeight };
    document.body.classList.add('v-track-resizing');
    const move = (moveEvent: PointerEvent): void => {
      const drag = heightDragRef.current;
      if (drag === null) return;
      const next = heightFromDrag(drag.startHeight, moveEvent.clientY - drag.startY);
      if (next === drag.current) return;
      /**
       * `from` 用**上一帧的值**，不是拖动起点。
       *
       * 撤销栈会按 `mergeKey` 把连续的这几步合成一条，并保留**最早那一条的
       * `inverses`**（见 store 的合并逻辑）。所以这里写"上一帧 → 这一帧"是对的：
       * 合并后撤销能一步回到拖动开始前，重做能一步回到松手时。
       *
       * **顺序不能反**：先 `drag.current = next` 再取 `previous`，第一步就变成
       * `next → next`（无效 op），合并后最早的 from 是 70 而不是 60 ——
       * 表现是"撤销一步只回到中途的某个高度"（实测 60 → 100 撤销回 70）。
       */
      const previous = drag.current;
      drag.current = next;
      store.dispatch(
        [{ op: 'setTrackHeight', trackId: drag.trackId, from: previous, to: next }],
        '调整轨道高度',
        'ui',
        { mergeKey: `track-height:${drag.trackId}` },
      );
    };
    const up = (): void => {
      heightDragRef.current = null;
      document.body.classList.remove('v-track-resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /* ---------- 拖拽排序（S3） ---------- */

  /**
   * 按住轨道头空白处上下拖动排序。
   *
   * ## 为什么要"移动超过 4px 才算拖"
   *
   * 同一个位置还要响应**双击改名**。如果 pointerdown 立刻进入拖拽模式，
   * 双击的第一下就会把轨道拖起来，改名永远触发不了。
   * 4px 是"手抖"和"真的在拖"的分界线（触摸也够用）。
   *
   * ## 为什么指示线只画、不改文档
   *
   * 拖动中改 `order` 会让整条时间线重排（所有片段的 y 都变），
   * 画面抖动严重且产生几十个撤销步。松手才提交。
   */
  function startTrackDrag(event: React.PointerEvent<HTMLElement>, trackId: string): void {
    if (event.button !== 0) return;
    const startY = event.clientY;
    let started = false;
    const track = store.getDoc().tracks.find((item) => item.id === trackId);
    if (track === undefined) return;

    const move = (moveEvent: PointerEvent): void => {
      if (!started) {
        if (Math.abs(moveEvent.clientY - startY) < 4) return;
        started = true;
        document.body.classList.add('v-track-dragging');
      }
      const layoutNow = trackLayout(store.getDoc());
      /**
       * **必须把屏幕坐标换算成画布坐标**。
       *
       * `trackLayout` 的 `top/height` 是画布坐标（CSS 像素，从画布顶算起），
       * 而 PointerEvent 给的是视口坐标。直接用 `clientY` 会让指针"看起来"
       * 永远落在最下面那行（数值大了几十上百）——实测拖到最上面却算出
       * `targetIndex = 2`，松手后顺序纹丝不动。
       */
      const canvas = canvasRef.current;
      if (canvas === null) return;
      const canvasY = moveEvent.clientY - canvas.getBoundingClientRect().top;
      const target = trackDropTarget(layoutNow, store.getDoc(), trackId, canvasY);
      if (target === null) return;
      store.setTrackDrag({ trackId, indicatorTop: target.indicatorTop, targetIndex: target.targetIndex });
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.classList.remove('v-track-dragging');
      const drag = store.getEphemeral().trackDrag;
      store.setTrackDrag(null);
      if (!started || drag === null) return;
      const plan = buildMoveTrackOps(store.getDoc(), drag.trackId, drag.targetIndex);
      if ('message' in plan) return;
      if (plan.ops.length === 0) return;
      store.dispatch(plan.ops, '调整轨道顺序');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /**
   * 轨道头右键 / ⋮ 菜单。
   *
   * 只放**现在就能用**的项：重命名 / 独奏 / 删除轨道。
   * "复制轨道 / 上移 / 下移"要等 S3 的 `duplicateTrack` / `setTrackOrder` 两个操作，
   * 现在放上去就是死按钮——宁可少一项，也不给点了没反应的菜单。
   */
  function openTrackMenu(trackId: string, point: { clientX: number; clientY: number }): void {
    const track = store.getDoc().tracks.find((item) => item.id === trackId);
    if (track === undefined) return;
    const blocked = trackRemoveBlockReason(store.getDoc(), trackId);
    const upBlocked = moveBlockReason(store.getDoc(), trackId, -1);
    const downBlocked = moveBlockReason(store.getDoc(), trackId, 1);
    setMenu({
      x: point.clientX,
      y: point.clientY,
      items: [
        { label: '重命名轨道', onSelect: () => setRename({ trackId, draft: track.name }) },
        {
          label: track.solo === true ? '取消独奏' : '独奏（只听这条）',
          onSelect: () => store.setTrackFlag(trackId, 'solo', track.solo !== true),
        },
        /**
         * 视频/字幕轨的头像按钮是"眼睛"（隐藏），没有静音入口。
         * 但"整条轨静音"是合法需求（配乐在视频轨上时），所以放进 ⋮ 菜单，不丢能力。
         */
        ...(track.kind === 'audio'
          ? []
          : [
              {
                label: track.muted ? '取消静音' : '静音这条轨',
                onSelect: () => store.setTrackFlag(trackId, 'muted', !track.muted),
              },
            ]),
        { separator: true },
        /**
         * 复制 / 上移 / 下移（S3）。
         *
         * 上移/下移**只在自己那一组里排**（视频/音频/字幕互不跨越），
         * 到边界时置灰并把原因写在文案里 —— 和"删除轨道"同一个套路：
         * 先解释为什么不行，比点了没反应好。
         */
        {
          label: '复制轨道',
          onSelect: () => {
            const plan = buildDuplicateTrackOps(store.getDoc(), trackId);
            if ('message' in plan) {
              store.pushError(makeError('E_INVALID_PROJECT', plan.message));
              return;
            }
            store.dispatch(plan.ops, `复制轨道 ${track.name}`);
            store.setSelectedClipId(null);
          },
        },
        {
          label: upBlocked === null ? '上移' : `上移（${upBlocked}）`,
          ...(upBlocked === null ? {} : { disabled: true }),
          onSelect: () => {
            const plan = buildShiftTrackOps(store.getDoc(), trackId, -1);
            if ('message' in plan) return;
            if (plan.ops.length > 0) store.dispatch(plan.ops, '上移轨道');
          },
        },
        {
          label: downBlocked === null ? '下移' : `下移（${downBlocked}）`,
          ...(downBlocked === null ? {} : { disabled: true }),
          onSelect: () => {
            const plan = buildShiftTrackOps(store.getDoc(), trackId, 1);
            if ('message' in plan) return;
            if (plan.ops.length > 0) store.dispatch(plan.ops, '下移轨道');
          },
        },
        { separator: true },
        {
          label: blocked === null ? '删除轨道' : `删除轨道（${blocked}）`,
          danger: true,
          ...(blocked === null ? {} : { disabled: true }),
          onSelect: () => removeTrack(trackId),
        },
      ],
    });
  }

  /** 底部「＋ 添加轨道」：三选一（视频/音频/字幕），收纳在一个小菜单里。 */
  function openAddTrackMenu(event: { clientX: number; clientY: number }): void {
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        { label: '添加视频轨', onSelect: () => addTrack('video') },
        { label: '添加音频轨', onSelect: () => addTrack('audio') },
        { label: '添加字幕轨', onSelect: () => addTrack('text') },
      ],
    });
  }

  /**
   * 删除轨道（含轨道上的片段）。
   *
   * 为什么必须给这个入口：界面能「＋ 轨道」、双击素材在占用时还会**自动新建轨**，
   * 但没有删除——轨道只增不减，用户误点几下就攒出一堆空轨，永远清不掉。
   */
  function removeTrack(trackId: string): void {
    const docNow = store.getDoc();
    const reason = trackRemoveBlockReason(docNow, trackId);
    if (reason !== null) {
      store.pushError(makeError('E_INVALID_PROJECT', reason));
      return;
    }
    const track = docNow.tracks.find((item) => item.id === trackId);
    if (track === undefined) return;
    const clips = track.clips.length;
    store.dispatch(
      [{ op: 'removeTrack', trackId, removed: track }],
      clips === 0 ? `删除轨道 ${track.name}` : `删除轨道 ${track.name}（含 ${clips} 个片段）`,
    );
  }

  return (
    <section className="v-timeline" data-v="timeline" aria-label="时间线" ref={sectionRef}>
      <div className="v-timeline__splitter" data-v="timeline-splitter" role="separator" aria-hidden="true" />
      <div className="v-tl-toolbar" data-v="timeline-toolbar">
        <span>时间线</span>
        <span className="v-tl-toolbar__spacer" />
        <span data-v="timeline-duration" title="时间线总时长">
          {formatTimecode(derived.durationFrames, doc.fpsMilli)}
        </span>
        <button
          type="button"
          className={`v-tl-snap${snapEnabled ? ' v-tl-snap--on' : ''}`}
          data-v="toggle-snap"
          aria-pressed={snapEnabled}
          title={`吸附：${snapEnabled ? '开' : '关'}（快捷键 N，拖动时按住 Alt 临时关闭）`}
          onClick={() => store.setSnapEnabled(!snapEnabled)}
        >
          吸附 {snapEnabled ? '开' : '关'}
        </button>
        <button type="button" className="v-tl-add-text" data-v="add-text" onClick={addText}>
          ＋ 文本
        </button>
        <button
          type="button"
          className="v-tl-add-track"
          data-v="add-track"
          title="添加轨道（视频 / 音频 / 字幕）"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            openAddTrackMenu({ clientX: rect.left, clientY: rect.bottom + 2 });
          }}
        >
          ＋ 轨道
        </button>
      </div>
      {/*
        * 轨道变多时画布会比时间线区域高（4 条轨就要 248px，区域只有 220px）。
        * 旧实现让画布直接溢出（`overflow: visible`），于是**下面的轨道被挤出视口**——
        1280×720 下加一条轨之后 A1 整条看不见，也就拖不进去（用户实测"拖不到 V3"）。
        * 现在画布放在滚动容器里，轨道再多也能滚到。
        */}
      <div className="v-tl-scroll" data-v="timeline-scroll">
        <div className="v-tl-inner" style={{ height: canvasHeight }}>
      <canvas
        ref={canvasRef}
        className="v-tl-canvas"
        data-v="timeline-canvas"
        width={1200}
        height={canvasHeight}
        style={{ height: canvasHeight }}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        onContextMenu={onContextMenu}
        onWheel={onWheel}
      />
      {/**
       * 轨道头（DOM）：图标 / 名称 / 显示隐藏或静音 / 锁定 / 更多。
       *
       * 一条轨一个组件，`top/height` 全部来自 `layout.rows`——轨道高度按类型不同
       * （视频 60 / 音频 50 / 字幕 32），不能再"第几条 × 统一行高"。
       */}
      {layout.rows.map((row) => {
        const track = doc.tracks.find((item) => item.id === row.trackId);
        if (track === undefined) return null;
        return (
          <TrackHeader
            key={row.trackId}
            track={track}
            row={row}
            // "当前操作轨道" = 选中片段所在的轨（不额外维护一份状态，避免两处不同步）
            selected={selectedClipTrackId === row.trackId}
            renaming={rename !== null && rename.trackId === row.trackId}
            renameDraft={rename !== null && rename.trackId === row.trackId ? rename.draft : ''}
            onRenameStart={() => setRename({ trackId: track.id, draft: track.name })}
            onRenameDraft={(draft) => setRename({ trackId: track.id, draft })}
            onRenameCommit={commitRename}
            onRenameCancel={() => setRename(null)}
            onToggleFlag={(flag, value) => store.setTrackFlag(track.id, flag, value)}
            onOpenMenu={(point) => openTrackMenu(track.id, point)}
            onResizeStart={(event) => startHeightDrag(event, track.id, row.height)}
            onBodyPointerDown={(event) => startTrackDrag(event, track.id)}
          />
        );
      })}

      {/**
       * 底部「＋ 添加轨道」：通栏按钮，点开三选一（视频/音频/字幕）。
       * 放在轨道下方而不是工具栏里——"加一条轨"是轨道区的操作，放这里更符合直觉。
       */}
      <button
        type="button"
        className="v-tl-add-track-row"
        data-v="add-track-row"
        style={{ top: layout.totalHeight }}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          openAddTrackMenu({ clientX: rect.left + 8, clientY: rect.bottom + 2 });
        }}
      >
        ＋ 添加轨道
      </button>
        </div>
      </div>
      {/**
       * 隐藏的文件选择框（右键"配一段音频…/在此处插入音频…"用）。
       *
       * 不用 `showOpenFilePicker`：它在内嵌面板/受限 iframe 里会抛
       * （素材栏"重新链接"就踩过这个坑，最后退回 `<input type=file>`）。
       * 代价是拿不到文件句柄 → 素材落"内存模式"，由常驻警告条提示。
       */}
      <input
        ref={audioInputRef}
        type="file"
        accept="audio/*,video/mp4,video/quicktime"
        data-v="audio-file-input"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // 清空 value：同一个文件选第二次也要触发 change
          event.target.value = '';
          if (file !== undefined) void onAudioPicked(file);
        }}
      />
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </section>
  );
}

export { TRACK_HEADER_WIDTH, TRACK_HEIGHT, RULER_HEIGHT };
