/**
 * 面板之间的可拖拽分隔条（左栏 / 右栏 / 时间线，共用一个组件）。
 *
 * ## 为什么拖拽只改 CSS 变量、不改 React state
 *
 * 拖拽时每秒会触发 60+ 次 `pointermove`。如果每次都 `setState`，
 * 整个 `App`（含时间线、预览、素材栏）都会重渲染 —— 拖动会明显发涩。
 *
 * 所以：**拖动中直接改 `document.documentElement` 上的 CSS 变量**，
 * 浏览器自己重排（这一层只有 3 个 flex/grid 子项，成本可忽略）；
 * 松手时才写 localStorage。React 只负责"折叠态"的图标渲染。
 *
 * ## 三个面板共用一份逻辑（S1.4）
 *
 * 左栏/右栏是 **x 轴**（拖宽度、`col-resize`），时间线是 **y 轴**（拖高度、`row-resize`）。
 * 差别只有"写哪个变量、往哪个方向算、范围多少"，全部收进 `PANELS` 表里 ——
 * 复制一份时间线专用实现的话，热区宽度、clamp 边界、`pointermove` 挂 window
 * 这些细节必然有一处对不上（本项目"同一规则写两遍"的 bug 全是这么来的）。
 *
 * ## 折叠为什么不是"宽度 0"
 *
 * 宽度 0 之后用户没有任何可点的东西能把它拉回来（分隔条也没了）。
 * 所以折叠态下分隔条**变宽到 18px**，中间留一个展开按钮 —— 面板本身宽度 0。
 * 时间线**不提供折叠**（高度归零后时间线没有替代入口，属于纯破坏性操作）。
 */

import { useRef } from 'react';
import type { ReactElement, RefObject } from 'react';

/** 面板宽度百分比的下限 / 上限（对齐 opencut-classic 的 min 15 / max 40）。 */
export const PANEL_MIN_PCT = 15;
export const PANEL_MAX_PCT = 40;
/** 默认 25%（opencut-classic 的 `PANEL_CONFIG.tools/properties`）。 */
export const PANEL_DEFAULT_PCT = 25;

/** 时间线高度：默认 50%（opencut-classic 的 mainContent 50 / timeline 50），可拖 15%–70%。 */
export const TIMELINE_MIN_PCT = 15;
export const TIMELINE_MAX_PCT = 70;
export const TIMELINE_DEFAULT_PCT = 50;

export type SplitterSide = 'left' | 'right' | 'timeline';

interface PanelSpec {
  /** 拖拽轴：x = 左右拖（改宽度），y = 上下拖（改高度）。 */
  axis: 'x' | 'y';
  /** 写到根节点上的 CSS 变量名。 */
  varName: string;
  /**
   * 变量单位。左/右栏写百分比（`25%`）；时间线写**无单位数字**（`50`）——
   * 因为 `--v-timeline-h` 还要用 `calc((100vh - 顶栏) * var(--v-timeline-pct) / 100)`
   * 参与长度运算，带 `%` 会让这个 calc 在 `bottom` / `width` 语境下算出错误结果。
   */
  unit: '%' | '';
  storage: string;
  storageCollapsed: string;
  /** 指针沿正方向移动时面板变大(1)还是变小(-1)。 */
  sign: 1 | -1;
  min: number;
  max: number;
  defaultPct: number;
  label: string;
}

const PANELS: Record<SplitterSide, PanelSpec> = {
  left: {
    axis: 'x',
    varName: '--v-left-w',
    unit: '%',
    storage: 'veditor:leftPct',
    storageCollapsed: 'veditor:leftCollapsed',
    sign: 1,
    min: PANEL_MIN_PCT,
    max: PANEL_MAX_PCT,
    defaultPct: PANEL_DEFAULT_PCT,
    label: '左侧面板',
  },
  right: {
    axis: 'x',
    varName: '--v-right-w',
    unit: '%',
    storage: 'veditor:rightPct',
    storageCollapsed: 'veditor:rightCollapsed',
    sign: -1,
    min: PANEL_MIN_PCT,
    max: PANEL_MAX_PCT,
    defaultPct: PANEL_DEFAULT_PCT,
    label: '右侧面板',
  },
  timeline: {
    axis: 'y',
    varName: '--v-timeline-pct',
    unit: '',
    storage: 'veditor:timelinePct',
    storageCollapsed: 'veditor:timelineCollapsed',
    // 往上拖 → 时间线变高（deltaY 为负）
    sign: -1,
    min: TIMELINE_MIN_PCT,
    max: TIMELINE_MAX_PCT,
    defaultPct: TIMELINE_DEFAULT_PCT,
    label: '时间线',
  },
};

/** 读一个百分比（非法值回退到该面板的默认值）。 */
export function readStoredPct(side: SplitterSide): number {
  const spec = PANELS[side];
  try {
    const raw = globalThis.localStorage?.getItem(spec.storage);
    const value = raw === null || raw === undefined ? Number.NaN : Number.parseFloat(raw);
    if (!Number.isFinite(value)) return spec.defaultPct;
    return Math.min(spec.max, Math.max(spec.min, value));
  } catch {
    return spec.defaultPct;
  }
}

export function readStoredCollapsed(side: SplitterSide): boolean {
  try {
    return globalThis.localStorage?.getItem(PANELS[side].storageCollapsed) === '1';
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
export function hasStoredPct(side: SplitterSide): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(PANELS[side].storage);
    if (raw === null || raw === undefined) return false;
    return Number.isFinite(Number.parseFloat(raw));
  } catch {
    return false;
  }
}

export function storePct(side: SplitterSide, pct: number): void {
  try {
    globalThis.localStorage?.setItem(PANELS[side].storage, String(pct));
  } catch {
    // 隐私模式下写不进去：本次会话仍生效（变量已经改了）
  }
}

export function storeCollapsed(side: SplitterSide, collapsed: boolean): void {
  try {
    globalThis.localStorage?.setItem(PANELS[side].storageCollapsed, collapsed ? '1' : '0');
  } catch {
    // 同上
  }
}

/** 把百分比写到根节点的 CSS 变量上（`collapsed` 时写 0）。 */
export function applyPanelWidth(side: SplitterSide, pct: number, collapsed: boolean): void {
  if (typeof document === 'undefined') return;
  const spec = PANELS[side];
  const value = collapsed ? (spec.unit === '' ? '0' : '0px') : `${pct}${spec.unit}`;
  document.documentElement.style.setProperty(spec.varName, value);
}

/** 读当前实际百分比（折叠时返回上次记住的值，用于展开恢复）。 */
export function currentPanelPct(side: SplitterSide): number {
  const spec = PANELS[side];
  if (typeof document === 'undefined') return spec.defaultPct;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(spec.varName).trim();
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : spec.defaultPct;
}

/** 该面板当前实际占用多少像素（时间线用它算"50% 到底是多少 px"，测试用）。 */
export function panelExtentPx(side: SplitterSide, container: HTMLElement | null): number {
  if (container === null) return 0;
  const rect = container.getBoundingClientRect();
  return Math.max(1, PANELS[side].axis === 'x' ? rect.width : rect.height);
}

export interface SplitterProps {
  side: SplitterSide;
  collapsed: boolean;
  /** 折叠按钮；不传则这条分隔条**没有**折叠入口（时间线就是这样）。 */
  onToggleCollapse?: () => void;
  /** 拖拽开始（供调用方记住"拖动前是否折叠"）。 */
  onResizeStart?: () => void;
  /** 拖拽结束（写 localStorage）。 */
  onResizeEnd?: (pct: number) => void;
  /** 拖拽用的容器（尺寸换算成百分比）。 */
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
  const spec = PANELS[side];
  const isX = spec.axis === 'x';
  const dragRef = useRef<{ start: number; startPct: number; extent: number } | null>(null);

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    // 点在折叠按钮上时不启动拖拽（按钮自己处理 click）
    if ((event.target as HTMLElement).dataset['role'] === 'toggle') return;
    const container = containerRef.current;
    if (container === null) return;
    event.preventDefault();
    dragRef.current = {
      start: isX ? event.clientX : event.clientY,
      startPct: currentPanelPct(side),
      extent: panelExtentPx(side, container),
    };
    onResizeStart?.();
    document.body.classList.add('v-splitter-dragging');
    document.body.classList.add(isX ? 'v-splitter-dragging--x' : 'v-splitter-dragging--y');

    const move = (moveEvent: PointerEvent): void => {
      const drag = dragRef.current;
      if (drag === null) return;
      const delta = ((isX ? moveEvent.clientX : moveEvent.clientY) - drag.start) / drag.extent;
      const next = Math.min(spec.max, Math.max(spec.min, drag.startPct + spec.sign * delta * 100));
      applyPanelWidth(side, next, false);
    };
    const up = (): void => {
      const drag = dragRef.current;
      dragRef.current = null;
      document.body.classList.remove('v-splitter-dragging');
      document.body.classList.remove('v-splitter-dragging--x');
      document.body.classList.remove('v-splitter-dragging--y');
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
      data-axis={spec.axis}
      role="separator"
      aria-orientation={isX ? 'vertical' : 'horizontal'}
      aria-label={`${spec.label}分隔条（拖动调整${isX ? '宽度' : '高度'}）`}
      onPointerDown={onPointerDown}
      onDoubleClick={onToggleCollapse === undefined ? undefined : () => onToggleCollapse()}
      title={
        onToggleCollapse === undefined
          ? `拖动调整${spec.label}高度`
          : `拖动调整宽度，双击折叠/展开`
      }
    >
      {onToggleCollapse === undefined ? null : (
        <button
          type="button"
          className="v-splitter__toggle"
          data-v={`splitter-toggle-${side}`}
          data-role="toggle"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? '展开' : '折叠'}${spec.label}`}
          title={`${collapsed ? '展开' : '折叠'}${spec.label}`}
          onClick={(event) => {
            event.stopPropagation();
            onToggleCollapse();
          }}
        >
          {/* 折叠时箭头朝"展开"方向，展开时朝"收起"方向 */}
          {side === 'left' ? (collapsed ? '›' : '‹') : collapsed ? '‹' : '›'}
        </button>
      )}
    </div>
  );
}
