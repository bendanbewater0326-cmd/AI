/**
 * 字幕面板的**迷你时间轴视图**（C4）。
 *
 * ## 为什么要一个时间轴视图
 *
 * 列表视图回答"字幕写了什么"，回答不了"字幕怎么分布的"——
 * 3 条字幕挤在前 2 秒、还是均匀铺满 30 秒，只有按真实时长摆出来的横条能一眼看出。
 * 这里只做**一根 32px 的横条轨**，不复制主时间线（主时间线已经能拖片段了）：
 * 进这个视图的用户目标是"把这条字幕拖长 / 拖短"，所以条块上就只给两个把手。
 *
 * ## 时间基准：**最晚结束帧**，不是工程总时长
 *
 * 工程总时长可能被一段 5 分钟的空镜头撑着，而字幕只在前 8 秒。
 * 用工程总时长当分母，所有条块会被压成一条线（1 秒字幕在 300 秒工程里只占 0.33%）。
 * 所以分母取 `max(startFrame + durationFrames)` —— 画面永远被字幕铺满，
 * 比例仍然是真的（两条 2 秒字幕宽度一样，4 秒的是它们的 2 倍）。
 *
 * ## 拖动：**只改本地 state，松手才 dispatch**
 *
 * 和 `TimelineView` 的轨道高度拖动不同（那边用 `mergeKey` 每帧 dispatch 来"跟手"），
 * 这里**绝不能**每帧 dispatch：`buildRetimeOps` 每次都会生成一条 `trimClip`，
 * 一次拖动 60 帧就会往撤销栈里塞 60 步，用户按撤销要按到崩溃。
 * 所以拖动期间只更新本地预览（视觉跟手），`pointerup` 时才**一次性**提交 ——
 * 一次拖动 = 一个撤销步。
 *
 * 提交走 `core/captions.buildRetimeOps`，**不自己算** op：
 * 起点钳到 ≥0、时长下限 1 帧、`outFrame` 跟随 `durationFrames`、同轨重叠拒绝，
 * 这些保护都在那个纯函数里（见 `core/captions.ts` 文件头）。
 * 失败时把中文原因交给全局错误条（`store.pushError`），本地预览已经回滚。
 *
 * ## 三向联动
 *
 * | 方向 | 怎么实现 |
 * |---|---|
 * | 列表选中 → 条块高亮 | `selectedIds` prop（与列表同一个 selection） |
 * | 点条块 → 选中 + 跳播放头 | `store.setSelectedClipId` + 外部注入的 `onSeek` |
 * | 播放中 → 当前条块高亮 | 订阅 `playheadBus`，**只在跨条时 setState** |
 */
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import { store } from '../../core/store';
import { buildRetimeOps, formatCaptionMs } from '../../core/captions';
import type { CaptionRow } from '../../core/captions';
import { frameToMs } from '../../core/timebase';
import { findClipById } from '../../core/transitionTarget';
import type { Frame } from '../../core/types';

/** 条块两端把手的可拖方向。 */
type DragEdge = 'left' | 'right';

/** 一次拖动会话（`pointerdown` 时冻结，拖动过程中不重算基准）。 */
interface DragSession {
  clipId: string;
  edge: DragEdge;
  pointerId: number;
  /** 按下时的视口 X（所有位移都相对它算，避免累计误差）。 */
  pointerStartX: number;
  /** 按下时的起点/时长 —— 拖动中的每一帧都以它为基础，而不是上一帧。 */
  baseStart: Frame;
  baseDuration: Frame;
  /** 像素 → 帧的分母（拖动开始时的时间基准，拖动中**不动**）。 */
  totalFrames: Frame;
  /** 轨道容器宽度（像素）。 */
  trackWidth: number;
  /** 拿到指针捕获的元素（松手时释放）。 */
  captureEl: HTMLElement;
}

/** 拖动中的本地预览范围（不进 doc、不进撤销栈）。 */
interface DraftRange {
  clipId: string;
  startFrame: Frame;
  durationFrames: Frame;
}

export interface CaptionTimelineProps {
  rows: CaptionRow[];
  /** 与列表共用的选中集（时间轴上高亮）。 */
  selectedIds: readonly string[];
  /** 跳播放头（由 App 注入 transport.seekTo，经 CaptionPanel 透传）。 */
  onSeek: (frame: Frame) => void;
}

/**
 * 值 → 百分比（夹在 0–100）。
 *
 * 纯像素/帧比例，不涉及帧 ↔ 毫秒换算（时间码一律走 `frameToMs` / `formatCaptionMs`）。
 */
function percentOf(value: number, total: Frame): number {
  if (total <= 0) return 0;
  const ratio = value / total;
  return Math.min(100, Math.max(0, ratio * 100));
}

export function CaptionTimeline(props: CaptionTimelineProps): ReactElement {
  const { rows, selectedIds, onSeek } = props;

  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragSession | null>(null);
  /** 预览值同时放 ref：`pointerup` 的闭包读不到最新的 state。 */
  const draftRef = useRef<DraftRange | null>(null);
  /** 当前拖动的监听清理器（卸载 / 重复按下时兜底）。 */
  const cleanupRef = useRef<(() => void) | null>(null);
  /** 拖动结束后紧跟的 `click` 要吞掉（否则松手会顺带跳一次播放头）。 */
  const suppressClickRef = useRef(false);

  const [draft, setDraft] = useState<DraftRange | null>(null);
  /** 播放头所在的条块（播放联动高亮）。 */
  const [activeId, setActiveId] = useState<string | null>(null);

  /** 时间轴分母：所有字幕的最晚结束帧（不是工程总时长，见文件头）。 */
  const totalFrames = rows.reduce(
    (max, row) => Math.max(max, row.startFrame + row.durationFrames),
    1,
  );
  const fpsMilli = store.getDoc().fpsMilli;

  // 播放联动：只在"跨到另一条"时重渲染（订阅 60Hz 总线但不每帧 setState）
  useEffect(() => {
    let previous = '';
    const subscribe = store.playheadBus.subscribe((frame) => {
      const hit = rows.find(
        (row) => frame >= row.startFrame && frame < row.startFrame + row.durationFrames,
      );
      const next = hit?.clipId ?? '';
      if (next === previous) return;
      previous = next;
      setActiveId(next === '' ? null : next);
    });
    // 切到时间轴视图时播放头可能已经停在某条字幕里：先同步一次，别等下一次播放
    const initial = store.playheadBus.get();
    const initialHit = rows.find(
      (row) => initial >= row.startFrame && initial < row.startFrame + row.durationFrames,
    );
    previous = initialHit?.clipId ?? '';
    setActiveId(initialHit?.clipId ?? null);
    return subscribe;
  }, [rows]);

  // 卸载时若还在拖：把 window 监听清掉，避免泄漏到别的视图
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      dragRef.current = null;
      document.body.classList.remove('v-caption-tl-dragging');
    };
  }, []);

  function applyDraft(next: DraftRange | null): void {
    draftRef.current = next;
    setDraft(next);
  }

  /**
   * 开始拖把手。
   *
   * `setPointerCapture` 挂在把手上：鼠标移出条块（甚至移出面板）后
   * `pointermove` 仍然投递给它，拖动不会"卡住"。同时再挂一份 window 监听，
   * 兼容不支持指针捕获的环境（合成事件 / 旧内核里 `setPointerCapture` 会抛）。
   */
  function beginDrag(
    event: ReactPointerEvent<HTMLElement>,
    row: CaptionRow,
    edge: DragEdge,
  ): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const track = trackRef.current;
    if (track === null) return;
    const trackWidth = track.getBoundingClientRect().width;
    if (trackWidth <= 0) return; // 容器还没布局（隐藏 Tab）：直接放弃，避免除零

    // 上一次拖动若还残留监听，先清掉（正常路径下不会发生，防御性）
    cleanupRef.current?.();
    cleanupRef.current = null;

    const captureEl = event.currentTarget;
    try {
      captureEl.setPointerCapture(event.pointerId);
    } catch {
      // 环境不支持 / pointerId 无效：window 监听仍能保证拖出条块继续
    }

    const session: DragSession = {
      clipId: row.clipId,
      edge,
      pointerId: event.pointerId,
      pointerStartX: event.clientX,
      baseStart: row.startFrame,
      baseDuration: row.durationFrames,
      totalFrames: Math.max(1, totalFrames),
      trackWidth,
      captureEl,
    };
    dragRef.current = session;
    applyDraft({
      clipId: row.clipId,
      startFrame: row.startFrame,
      durationFrames: row.durationFrames,
    });
    document.body.classList.add('v-caption-tl-dragging');

    const move = (moveEvent: PointerEvent): void => {
      const drag = dragRef.current;
      if (drag === null) return;
      const deltaPx = moveEvent.clientX - drag.pointerStartX;
      // 像素 → 帧：分母用拖动开始时冻结的基准，拖动中不随预览变化（否则会来回抖）
      const deltaFrames = Math.round((deltaPx / drag.trackWidth) * drag.totalFrames);

      let startFrame = drag.baseStart;
      let durationFrames = drag.baseDuration;
      if (drag.edge === 'left') {
        // 左把手：终点钉住，起点跟着指针走（起点 ≥0，且至少留 1 帧）
        const endFrame = drag.baseStart + drag.baseDuration;
        startFrame = Math.max(0, Math.min(endFrame - 1, drag.baseStart + deltaFrames));
        durationFrames = endFrame - startFrame;
      } else {
        // 右把手：起点钉住，时长跟着指针走（下限 1 帧）
        durationFrames = Math.max(1, drag.baseDuration + deltaFrames);
      }

      const current = draftRef.current;
      if (
        current !== null &&
        current.startFrame === startFrame &&
        current.durationFrames === durationFrames
      ) {
        return; // 值没变：不 setState，拖动期间一次多余渲染都不做
      }
      applyDraft({ clipId: drag.clipId, startFrame, durationFrames });
    };

    const cleanup = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      cleanupRef.current = null;
    };

    /** 松手：**唯一**的提交点（一次拖动 = 一个撤销步）。 */
    const finish = (): void => {
      const drag = dragRef.current;
      const next = draftRef.current;
      cleanup();
      dragRef.current = null;
      document.body.classList.remove('v-caption-tl-dragging');
      applyDraft(null);

      if (drag !== null) {
        try {
          if (drag.captureEl.hasPointerCapture(drag.pointerId)) {
            drag.captureEl.releasePointerCapture(drag.pointerId);
          }
        } catch {
          // 浏览器可能已经自动释放，忽略
        }
      }
      if (drag === null || next === null) return;
      // 没挪动：什么都不做（不留空撤销步）
      if (next.startFrame === drag.baseStart && next.durationFrames === drag.baseDuration) return;

      // 松手后浏览器紧接着派发的 click 只是拖动的尾巴，不能当成"点选跳转"
      suppressClickRef.current = true;

      const found = findClipById(store.getDoc(), drag.clipId);
      if (found === null) return;
      const result = buildRetimeOps(
        found.clip,
        next.startFrame,
        next.durationFrames,
        store.getDoc(),
      );
      if (!result.ok) {
        // 重叠 / 非法时间：中文原因进全局错误条，本地预览已回滚到 doc 的真实值
        store.pushError(result.error);
        return;
      }
      if (result.value.length === 0) return;
      store.dispatch(result.value, '调整字幕时间');
    };

    cleanupRef.current = cleanup;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }

  /**
   * 分母：拖动中若把字幕拖得比现有最晚结束帧还晚，分母跟着长 ——
   * 否则条块会顶出轨道右边被裁掉。预览增长是连续的，视觉上像轻微"缩小"，
   * 比"拖到边界就拖不动"更符合直觉（松手后仍会按真实数据重排）。
   */
  /* ---------------- 框选（C5-6） ---------------- */

  /**
   * 框选矩形（**相对轨道左上角**的坐标）。`null` = 没在框选。
   *
   * 用相对坐标而不是 `clientX/Y`：滚动/布局变化时相对位置不变，
   * 比较条块时也统一换算到同一个坐标系，不必反复加 rect.left。
   */
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  /** 拖出框选的最小位移（px）：小于它视为"点了一下空白"，不是框选。 */
  const MARQUEE_THRESHOLD = 4;

  function localPoint(event: { clientX: number; clientY: number }, track: HTMLDivElement): { x: number; y: number } {
    const rect = track.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /**
   * 在**轨道空白处**按下 → 开始框选。
   *
   * 必须判 `event.target === track`：条块和把手的 `pointerdown` 会冒泡到轨道，
   * 不排除的话"点条块"也会开始框选（随后 click 又被吞掉，条块就点不中了）。
   */
  function beginMarquee(event: React.PointerEvent<HTMLDivElement>): void {
    const track = trackRef.current;
    if (track === null) return;
    if (event.target !== track) return;
    if (event.button !== 0) return;

    const origin = localPoint(event, track);
    const additive = event.ctrlKey || event.metaKey;
    setMarquee({ x0: origin.x, y0: origin.y, x1: origin.x, y1: origin.y });

    /**
     * **用 window 监听，不用 `setPointerCapture`。**
     *
     * 曾用 capture + 元素上的 onPointerMove/onPointerUp，实测拖动一开始就失败：
     * 渲染选框元素会让 track 的子节点变化 → 重新渲染 → **capture 丢失并触发 pointercancel** →
     * `setMarquee(null)`，表现为"框一下就不见了"。
     * 这和拖把手用的是同一套模式（window 兜底），行为一致也更好调试。
     */
    const onMove = (moveEvent: PointerEvent): void => {
      const point = localPoint(moveEvent, track);
      setMarquee({ x0: origin.x, y0: origin.y, x1: point.x, y1: point.y });
    };

    const onUp = (upEvent: PointerEvent): void => {
      cleanup();
      const point = localPoint(upEvent, track);
      const left = Math.min(origin.x, point.x);
      const right = Math.max(origin.x, point.x);
      const width = right - left;
      setMarquee(null);

      const trackRect = track.getBoundingClientRect();
      if (width < MARQUEE_THRESHOLD) {
        // 几乎没拖：当成"点空白"，清空选择（按着 Ctrl 时不动，避免误清）
        if (!additive) store.setSelectedClipId(null);
        return;
      }

      const hitIds: string[] = [];
      for (const node of track.querySelectorAll<HTMLElement>('[data-v="caption-tl-block"]')) {
        const rect = node.getBoundingClientRect();
        const blockLeft = rect.left - trackRect.left;
        const blockRight = rect.right - trackRect.left;
        // **相交判定**（不是包含）：矩形起点落在块内部时那块也要选中
        if (blockLeft < right && left < blockRight) {
          const id = node.getAttribute('data-clip-id');
          if (id !== null) hitIds.push(id);
        }
      }

      if (additive) {
        // Ctrl 框选 = 加到现有选择集（已选的保持，不重复 toggle）
        for (const id of hitIds) {
          if (!selectedIds.includes(id)) store.toggleSelection(id);
        }
        return;
      }
      store.setSelectedClipId(null);
      for (const id of hitIds) store.toggleSelection(id);
    };

    function cleanup(): void {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    }
    function onCancel(): void {
      cleanup();
      setMarquee(null);
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

  const displayTotal =
    draft === null ? totalFrames : Math.max(totalFrames, draft.startFrame + draft.durationFrames);
  const totalMs = frameToMs(totalFrames, fpsMilli);

  return (
    <div className="v-caption-tl" data-v="caption-timeline">
      <div
        className="v-caption-tl__track"
        data-v="caption-tl-track"
        ref={trackRef}
        onPointerDown={beginMarquee}
      >
        {rows.map((row) => {
          const activeDraft = draft !== null && draft.clipId === row.clipId ? draft : null;
          const startFrame = activeDraft === null ? row.startFrame : activeDraft.startFrame;
          const durationFrames =
            activeDraft === null ? row.durationFrames : activeDraft.durationFrames;
          const selected = selectedIds.includes(row.clipId);
          const active = activeId === row.clipId;
          const startMs = frameToMs(startFrame, fpsMilli);
          const endMs = frameToMs(startFrame + durationFrames, fpsMilli);
          const hint = `${formatCaptionMs(startMs)} → ${formatCaptionMs(endMs)}　${row.text}`;

          return (
            <div
              key={row.clipId}
              className="v-caption-tl__block"
              data-v="caption-tl-block"
              data-clip-id={row.clipId}
              data-origin={row.origin}
              data-selected={selected ? 'true' : 'false'}
              data-active={active ? 'true' : 'false'}
              data-dragging={activeDraft === null ? 'false' : 'true'}
              style={{
                left: `${percentOf(startFrame, displayTotal)}%`,
                width: `${percentOf(durationFrames, displayTotal)}%`,
              }}
              title={hint}
              onPointerDown={() => {
                // 新的按下 = 新的一轮交互，清掉上一轮拖动的"吞 click"标记
                suppressClickRef.current = false;
              }}
              onClick={() => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                store.setSelectedClipId(row.clipId);
                onSeek(row.startFrame);
              }}
            >
              <span
                className="v-caption-tl__handle"
                data-v="caption-tl-handle"
                data-edge="left"
                title="拖动调整开始时间"
                onPointerDown={(event) => beginDrag(event, row, 'left')}
                onClick={(event) => event.stopPropagation()}
              />
              <span className="v-caption-tl__text" data-v="caption-tl-text">
                {row.text}
              </span>
              <span
                className="v-caption-tl__handle"
                data-v="caption-tl-handle"
                data-edge="right"
                title="拖动调整结束时间"
                onPointerDown={(event) => beginDrag(event, row, 'right')}
                onClick={(event) => event.stopPropagation()}
              />
            </div>
          );
        })}
        {marquee === null ? null : (
          <div
            className="v-caption-tl__marquee"
            data-v="caption-tl-marquee"
            style={{
              left: Math.min(marquee.x0, marquee.x1),
              top: Math.min(marquee.y0, marquee.y1),
              width: Math.abs(marquee.x1 - marquee.x0),
              height: Math.abs(marquee.y1 - marquee.y0),
            }}
          />
        )}
      </div>
      <div className="v-caption-tl__axis" data-v="caption-tl-axis">
        <span>{formatCaptionMs(0)}</span>
        <span>{formatCaptionMs(totalMs)}</span>
      </div>
      <div className="v-caption-tl__hint" data-v="caption-tl-hint">
        拖动条块两端把手调整起止时间，松手才生效（一次拖动 = 一步撤销）
      </div>
    </div>
  );
}
