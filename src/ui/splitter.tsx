/**
 * 三栏之间的可拖拽分隔条（+ 折叠按钮）。
 *
 * ## 为什么拖拽只改 CSS 变量、不改 React state
 *
 * 拖拽时每秒会触发 60+ 次 `pointermove`。如果每次都 `setState`，
 * 整个 `App`（含时间线、预览、素材栏）都会重渲染 —— 拖动会明显发涩。
 *
 * 所以：**拖动中直接改 `document.documentElement` 上的 `--v-left-w` / `--v-right-w`**，
 * 浏览器自己重排（这一层只有 3 个 flex/grid 子项，成本可忽略）；
 * 松手时才写 localStorage。React 只负责"折叠态"的图标渲染。
 *
 * ## 折叠为什么不是"宽度 0"
 *
 * 宽度 0 之后用户没有任何可点的东西能把它拉回来（分隔条也没了）。
 * 所以折叠态下分隔条**变宽到 18px**，中间留一个展开按钮 —— 面板本身宽度 0。
 */

import { useRef } from 'react';
import type { ReactElement, RefObject } from 'react';

/** 面板宽度百分比的下限 / 上限（对齐 opencut-classic 的 min 15 / max 40）。 */
export const PANEL_MIN_PCT = 15;
export const PANEL_MAX_PCT = 40;
/** 默认 25%（opencut-classic 的 `PANEL_CONFIG.tools/properties`）。 */
export const PANEL_DEFAULT_PCT = 25;

const STORAGE_LEFT = 'veditor:leftPct';
const STORAGE_RIGHT = 'veditor:rightPct';
const STORAGE_LEFT_COLLAPSED = 'veditor:leftCollapsed';
const STORAGE_RIGHT_COLLAPSED = 'veditor:rightCollapsed';

/** 读一个百分比（非法值回退到默认）。 */
export function readStoredPct(side: 'left' | 'right'): number {
  try {
    const raw = globalThis.localStorage?.getItem(side === 'left' ? STORAGE_LEFT : STORAGE_RIGHT);
    const value = raw === null || raw === undefined ? Number.NaN : Number.parseFloat(raw);
    if (!Number.isFinite(value)) return PANEL_DEFAULT_PCT;
    return Math.min(PANEL_MAX_PCT, Math.max(PANEL_MIN_PCT, value));
  } catch {
    return PANEL_DEFAULT_PCT;
  }
}

export function readStoredCollapsed(side: 'left' | 'right'): boolean {
  try {
    return globalThis.localStorage?.getItem(side === 'left' ? STORAGE_LEFT_COLLAPSED : STORAGE_RIGHT_COLLAPSED) === '1';
  } catch {
    return false;
  }
}

/**
 * 用户是否**显式拖过**这个面板（localStorage 里有合法数值）。
 *
 * 为什么需要这个判断：`applyPanelWidth` 写的是**行内** `style`，
 * 而媒体查询（≤1024px → 20%、≤820px → 16%）写在 `:root` 里 ——
 * 行内样式优先级更高，所以只要挂载时无条件写一次 25%，
 * **窄屏收窄就永远不会生效**（实测 820px 窗口下左栏仍是 25% = 205px，缩略图挤成一列）。
 *
 * 所以：没拖过 → 不写行内值，交给 CSS；拖过 → 用户的选择优先，覆盖媒体查询。
 */
export function hasStoredPct(side: 'left' | 'right'): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(side === 'left' ? STORAGE_LEFT : STORAGE_RIGHT);
    if (raw === null || raw === undefined) return false;
    return Number.isFinite(Number.parseFloat(raw));
  } catch {
    return false;
  }
}

export function storePct(side: 'left' | 'right', pct: number): void {
  try {
    globalThis.localStorage?.setItem(side === 'left' ? STORAGE_LEFT : STORAGE_RIGHT, String(pct));
  } catch {
    // 隐私模式下写不进去：本次会话仍生效（变量已经改了）
  }
}

export function storeCollapsed(side: 'left' | 'right', collapsed: boolean): void {
  try {
    globalThis.localStorage?.setItem(side === 'left' ? STORAGE_LEFT_COLLAPSED : STORAGE_RIGHT_COLLAPSED, collapsed ? '1' : '0');
  } catch {
    // 同上
  }
}

/** 把百分比写到根节点的 CSS 变量上（`collapsed` 时写 0px）。 */
export function applyPanelWidth(side: 'left' | 'right', pct: number, collapsed: boolean): void {
  if (typeof document === 'undefined') return;
  const name = side === 'left' ? '--v-left-w' : '--v-right-w';
  document.documentElement.style.setProperty(name, collapsed ? '0px' : `${pct}%`);
}

/** 读当前实际百分比（折叠时返回上次记住的值，用于展开恢复）。 */
export function currentPanelPct(side: 'left' | 'right'): number {
  if (typeof document === 'undefined') return PANEL_DEFAULT_PCT;
  const name = side === 'left' ? '--v-left-w' : '--v-right-w';
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : PANEL_DEFAULT_PCT;
}

export interface SplitterProps {
  side: 'left' | 'right';
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** 拖拽开始（供调用方记住"拖动前是否折叠"）。 */
  onResizeStart?: () => void;
  /** 拖拽结束（写 localStorage）。 */
  onResizeEnd?: (pct: number) => void;
  /** 拖拽用的容器（宽度换算成百分比）。 */
  containerRef: RefObject<HTMLElement | null>;
}

/**
 * 一条分隔条。
 *
 * 拖拽用 **window 上的 pointermove**（不是元素自身）：指针一旦离开这条 4px 的细线，
 * 元素上的 move 就收不到了 —— 拖动会"卡住"（S3 的轨道高度拖拽踩过同一个坑）。
 */
export function Splitter({
  side,
  collapsed,
  onToggleCollapse,
  onResizeStart,
  onResizeEnd,
  containerRef,
}: SplitterProps): ReactElement {
  const dragRef = useRef<{ startX: number; startPct: number; width: number } | null>(null);

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    // 点在折叠按钮上时不启动拖拽（按钮自己处理 click）
    if ((event.target as HTMLElement).dataset['role'] === 'toggle') return;
    const container = containerRef.current;
    if (container === null) return;
    event.preventDefault();
    dragRef.current = {
      startX: event.clientX,
      startPct: currentPanelPct(side),
      width: Math.max(1, container.getBoundingClientRect().width),
    };
    onResizeStart?.();
    document.body.classList.add('v-splitter-dragging');

    const move = (moveEvent: PointerEvent): void => {
      const drag = dragRef.current;
      if (drag === null) return;
      const deltaPct = ((moveEvent.clientX - drag.startX) / drag.width) * 100;
      // 左栏：往右拖变大；右栏：往左拖变大（方向相反）
      const next = Math.min(
        PANEL_MAX_PCT,
        Math.max(PANEL_MIN_PCT, drag.startPct + (side === 'left' ? deltaPct : -deltaPct)),
      );
      applyPanelWidth(side, next, false);
    };
    const up = (): void => {
      const drag = dragRef.current;
      dragRef.current = null;
      document.body.classList.remove('v-splitter-dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (drag === null) return;
      onResizeEnd?.(currentPanelPct(side));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  return (
    <div
      className={`v-splitter v-splitter--${side}`}
      data-v={`splitter-${side}`}
      data-collapsed={collapsed}
      role="separator"
      aria-orientation="vertical"
      aria-label={`${side === 'left' ? '左' : '右'}侧面板分隔条（拖动调整宽度）`}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onToggleCollapse()}
      title="拖动调整宽度，双击折叠/展开"
    >
      <button
        type="button"
        className="v-splitter__toggle"
        data-v={`splitter-toggle-${side}`}
        data-role="toggle"
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? '展开' : '折叠'}${side === 'left' ? '左' : '右'}侧面板`}
        title={`${collapsed ? '展开' : '折叠'}${side === 'left' ? '左' : '右'}侧面板`}
        onClick={(event) => {
          event.stopPropagation();
          onToggleCollapse();
        }}
      >
        {/* 折叠时箭头朝"展开"方向，展开时朝"收起"方向 */}
        {side === 'left' ? (collapsed ? '›' : '‹') : collapsed ? '‹' : '›'}
      </button>
    </div>
  );
}
