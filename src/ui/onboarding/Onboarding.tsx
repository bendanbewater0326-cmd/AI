/**
 * 新手引导浮层（G2）：一块挖了洞的蒙层 + 一个跟着目标走的提示框。
 *
 * ## 视觉：为什么用 box-shadow 挖洞，而不是四块蒙层 / clip-path
 *
 * - 四块拼接要算 8 个坐标，窗口一改就要重算，容易出缝；
 * - `clip-path` 在部分环境有抗锯齿毛边；
 * - **一个 div + 超大投影**：位置一变只改 `left/top/width/height` 四个值，永远无缝隙。
 *
 * ## ⚠️ 指针事件：整层 `pointer-events: none`（与最初设计有一处**必须**的修正）
 *
 * 原方案是「外层容器 `pointer-events: auto` + spotlight `none`」，靠"目标不在容器子树里、
 * 事件不冒泡到容器"来做到"点目标不关闭"。**这条路在浏览器里不成立**：
 * 命中测试只看几何、不看背景透明度，一个 `inset:0; pointer-events:auto` 的外层容器
 * 会把整屏的点击全部吃掉——底下的「导入」按钮、时间轴一个都点不到（与"引导期间用户能真操作"直接冲突）。
 *
 * 所以这里反着来：
 * - 外层容器 `pointer-events: none`（整层透明，事件原样落到真实 UI 上）；
 * - spotlight `pointer-events: none`（它只是画阴影的，不拦截）；
 * - **只有 tip** `pointer-events: auto`（按钮要能点）。
 *
 * 「点空白处关闭」改由 `window` 上的 `pointerdown` 监听判断（组件内的 `closeOnBlank`）：
 * 点到 tip 里 → 忽略；点到当前步的目标元素（含其子节点）→ 忽略（用户正在真操作）；
 * 其余位置 → 关闭。判 `contains` 而不是靠 `stopPropagation`：tip 在 portal 里，
 * 冒泡路径绕过 React 根容器，只有 `contains` 可靠（`ContextMenu` 踩过同一个坑）。
 *
 * ## 容错
 *
 * - 目标不存在 / 宽高为 0（`display:none`、布局还没稳）：**跳过该步**，向前向后找最近的可用步；
 *   全都不可用 → `onClose('skipped')`，绝不指空。
 * - `resize` / `scroll`（捕获阶段，能收到任意内层滚动容器的事件）时重算矩形，
 *   `requestAnimationFrame` 合帧：连续 resize 只算一次。
 *
 * ## 监听器为什么不依赖 `onClose`
 *
 * 父组件（`App`）每帧播放都会重渲染，`onClose` 是内联箭头函数 → 每次都是新引用。
 * 若把它放进 effect 依赖，键鼠监听会**逐帧**卸载/重挂。这里用 `closeRef` 镜像它。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactElement, ReactNode } from 'react';
import { resolveSteps } from './state';
import type { OnboardingPlacement, OnboardingStep } from './steps';

export interface OnboardingProps {
  /** 是否显示。父组件控制（首次自动开 / 设置面板手动开）。 */
  open: boolean;
  /** 关闭回调：`done` = 走完最后一步；`skipped` = 跳过 / Esc / 点空白。 */
  onClose: (status: 'done' | 'skipped') => void;
  /** 是否有 AI 通道（来自 `hasTranscribeChannel`），传给 `resolveSteps` 过滤第 6 步。 */
  aiAvailable: boolean;
}

/** 视口坐标下的矩形（CSS 像素）。 */
interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Size {
  width: number;
  height: number;
}

/** 提示框与目标之间的间距。 */
const TIP_GAP = 16;
/** 提示框距视口边缘的最小留白（clamp 用）。 */
const EDGE_MARGIN = 8;

/**
 * 量一个目标元素。
 *
 * @returns 视口矩形；元素不存在或**宽高为 0** 时返回 `null`
 *   （`display:none` 的 Tab 内容、还没布局完的首帧都会是 0 —— 一律按"不存在"处理，
 *   否则会画出一个 0×0 的高亮洞，看起来像"引导指着一团空气"）。
 */
function measureTarget(selector: string): Rect | null {
  const element = document.querySelector(selector);
  if (element === null) return null;
  const box = element.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  return { left: box.left, top: box.top, width: box.width, height: box.height };
}

/**
 * 从 `from` 起沿 `direction` 找一个目标可用的步骤下标；找不到返回 -1。
 *
 * 只往一个方向走 —— 「下一步/上一步」用这个（走完就走完，不会掉头）。
 */
function findUsable(steps: readonly OnboardingStep[], from: number, direction: 1 | -1): number {
  for (let index = from; index >= 0 && index < steps.length; index += direction) {
    const step = steps[index];
    if (step !== undefined && measureTarget(step.selector) !== null) return index;
  }
  return -1;
}

/**
 * 找一个"落得下"的步骤下标：先向前，再向后（向前向后都要能跳）。都没有返回 -1。
 *
 * 用于**修正**（当前步目标消失了、或刚打开时第 1 步不可用），不是用于步进。
 */
function resolveUsable(steps: readonly OnboardingStep[], from: number): number {
  const forward = findUsable(steps, from, 1);
  if (forward !== -1) return forward;
  return findUsable(steps, Math.min(from, steps.length - 1) - 1, -1);
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * 算提示框位置：按 `placement` 摆在目标旁边，放不下就**翻到另一侧**，最后 clamp 进视口。
 *
 * 翻转是必需的：目标贴着窗口边缘时（如左栏第 1 步的目标在最左边，但窗口很窄），
 * 按原方位算出来的 tip 会跑到视口外 —— 看得见一半、按钮点不到。
 */
function placeTip(target: Rect, size: Size, placement: OnboardingPlacement): { left: number; top: number } {
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  const maxLeft = viewportW - size.width - EDGE_MARGIN;
  const maxTop = viewportH - size.height - EDGE_MARGIN;

  if (placement === 'right' || placement === 'left') {
    let side: 'right' | 'left' = placement;
    let left = side === 'right' ? target.left + target.width + TIP_GAP : target.left - TIP_GAP - size.width;
    if (left < EDGE_MARGIN || left > maxLeft) {
      side = side === 'right' ? 'left' : 'right';
      left = side === 'right' ? target.left + target.width + TIP_GAP : target.left - TIP_GAP - size.width;
    }
    const top = target.top + target.height / 2 - size.height / 2;
    return { left: clamp(left, EDGE_MARGIN, maxLeft), top: clamp(top, EDGE_MARGIN, maxTop) };
  }

  let side: 'below' | 'above' = placement;
  let top = side === 'below' ? target.top + target.height + TIP_GAP : target.top - TIP_GAP - size.height;
  if (top < EDGE_MARGIN || top > maxTop) {
    side = side === 'below' ? 'above' : 'below';
    top = side === 'below' ? target.top + target.height + TIP_GAP : target.top - TIP_GAP - size.height;
  }
  const left = target.left + target.width / 2 - size.width / 2;
  return { left: clamp(left, EDGE_MARGIN, maxLeft), top: clamp(top, EDGE_MARGIN, maxTop) };
}

/**
 * 正文渲染：把 `**加粗**` 拆成 `<strong>`（配置里写明允许这个标记）。
 * 没有标记时直接返回字符串，不额外包节点。
 */
function renderBody(body: string): ReactNode {
  if (!body.includes('**')) return body;
  const parts = body.split('**');
  return parts.map((part, index) =>
    index % 2 === 1 ? <strong key={index}>{part}</strong> : <span key={index}>{part}</span>,
  );
}

/** 焦点是否在可输入的地方（引导期间用户可能正在改文件名 / 打字，方向键不该被抢）。 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * 这些元素上的点击算"用户在操作软件"，**不关闭**引导。
 *
 * 方案 §5 明确要求"引导期间换 Tab / 拖时间轴不打断引导"，
 * 而那几个入口（Tab 图标、按钮、时间线画布）在别的步骤里正好落在暗区上。
 * 如果一律按"点空白就关"，用户想边看边试的第一步就会被自己的操作打断。
 * 真正的空白（预览区留白、面板底色、顶栏空隙）不匹配这个选择器 → 关闭。
 */
const INTERACTIVE_SELECTOR =
  'button, a, input, select, textarea, label, canvas, [role="button"], [role="tab"], [contenteditable="true"]';

/**
 * 新手引导浮层。`open` 为 false 时**不渲染任何东西**（也不挂监听）。
 */
export function Onboarding({ open, onClose, aiAvailable }: OnboardingProps): ReactElement | null {
  /** 过滤后的步骤（AI 不可用时第 6 步整条剔除）。**不在这里重复判 `requiresAI`**。 */
  const steps = useMemo<OnboardingStep[]>(() => resolveSteps({ aiAvailable }), [aiAvailable]);

  /** 当前步下标（指向 `steps`）。 */
  const [index, setIndex] = useState(0);
  /** 目标矩形（视口坐标）。null = 还没量到 / 目标暂时不可用。 */
  const [rect, setRect] = useState<Rect | null>(null);
  /** 提示框最终位置（量完自身尺寸才能算，所以另存一份）。 */
  const [tipPos, setTipPos] = useState<{ left: number; top: number } | null>(null);
  /** 目标失效信号：量到 null 时 +1，唤醒"换到下一个可用步"的修正 effect。 */
  const [probe, setProbe] = useState(0);

  const tipRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  const step = steps[index];

  /* 每次打开都从第一步开始（父组件可以反复打开：设置面板的「重新查看」）。 */
  useEffect(() => {
    if (!open) return;
    setIndex(0);
    setRect(null);
    setTipPos(null);
  }, [open]);

  /**
   * 修正：当前步的目标不可用（不存在 / 尺寸 0）就换到最近的可用步；全都不行就关掉。
   *
   * 依赖 `probe`：量矩形时发现目标消失会 +1 唤醒这里（否则 index 不变、effect 不会重跑，
   * 界面会停在"什么都不显示"的状态）。注意**量矩形的 effect 不能依赖 `probe`**，
   * 否则两边互相唤醒会成死循环。
   */
  useEffect(() => {
    if (!open) return;
    if (steps.length === 0) {
      closeRef.current('skipped');
      return;
    }
    const usable = resolveUsable(steps, index);
    if (usable === -1) {
      closeRef.current('skipped');
      return;
    }
    if (usable !== index) setIndex(usable);
  }, [open, index, steps, probe]);

  /* 量当前步的矩形，并跟随 resize / scroll（rAF 合帧：连续 resize 只算一次）。 */
  useEffect(() => {
    if (!open || step === undefined) return;
    const apply = (): void => {
      const measured = measureTarget(step.selector);
      setRect(measured);
      // 目标被藏起来了（切了 Tab / 面板被关 / 窗口缩到 0）：叫修正 effect 换步，别指空
      if (measured === null) setProbe((value) => value + 1);
    };
    apply();

    let frame = 0;
    const schedule = (): void => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        apply();
      });
    };
    window.addEventListener('resize', schedule);
    // 捕获阶段：内层容器（时间线 / 素材栏）滚动不会冒泡到 window，只有捕获收得到
    window.addEventListener('scroll', schedule, true);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [open, step]);

  /** 下一步；已经是最后一个可用步时等于"看完了"。 */
  const goNext = useCallback((): void => {
    const next = findUsable(steps, index + 1, 1);
    if (next === -1) {
      closeRef.current('done');
      return;
    }
    setIndex(next);
  }, [steps, index]);

  /** 上一步（第一步时是空操作，按钮本身也不渲染）。 */
  const goPrev = useCallback((): void => {
    const previous = findUsable(steps, index - 1, -1);
    if (previous !== -1) setIndex(previous);
  }, [steps, index]);

  /* 键盘：→/Enter 下一步，← 上一步，Esc 跳过。只在 open 时挂，关闭即清理。 */
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current('skipped');
        return;
      }
      const forward = event.key === 'ArrowRight' || event.key === 'Enter';
      const backward = event.key === 'ArrowLeft';
      if (!forward && !backward) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      if (forward) goNext();
      else goPrev();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, goNext, goPrev]);

  /**
   * 点空白关闭（外层容器 `pointer-events: none`，所以只能用 window 监听）。
   *
   * 三种情况**不关**：
   * 1. 点在 tip 上（按钮 / 正文）；
   * 2. 点在当前步的目标元素里（用户真正在导入素材 / 拖片段 —— 这时候关掉最招人烦）；
   * 3. 点在可交互控件上（换 Tab、按按钮、拖时间线画布）—— 方案 §5 要求不打断。
   * 其余位置（预览区留白、面板底色…）→ 关闭。
   */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (tipRef.current !== null && tipRef.current.contains(target)) return;
      if (target.closest(INTERACTIVE_SELECTOR) !== null) return;
      if (step !== undefined) {
        const anchor = document.querySelector(step.selector);
        if (anchor !== null && anchor.contains(target)) return;
      }
      closeRef.current('skipped');
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, step]);

  /* 量 tip 自身尺寸 → 算位置。不放 `tipPos` 依赖，否则 setState 会自激成死循环。 */
  useLayoutEffect(() => {
    if (rect === null || step === undefined) {
      setTipPos(null);
      return;
    }
    const tip = tipRef.current;
    if (tip === null) return;
    const box = tip.getBoundingClientRect();
    setTipPos(placeTip(rect, { width: box.width, height: box.height }, step.placement));
  }, [rect, step]);

  /* 「上一步」只在前面还有可用步时才显示（首次进入若前几步被跳过，不该给一个点了没反应的按钮）。 */
  const canGoPrev = useMemo((): boolean => index > 0 && findUsable(steps, index - 1, -1) !== -1, [steps, index]);

  if (!open || step === undefined || rect === null) return null;

  /*
   * 最后**视觉上**的一步：
   * - 有 `primaryLabel`（AI 那步自带「开始创作」）→ 用它的文案；
   * - 没有（AI 被过滤掉，导出成了最后一步）→ 兜底也用「开始创作」，
   *   否则走完最后一屏还写着「下一步」，用户不知道点完就结束了。
   */
  const isLastStep = index === steps.length - 1;
  const finishes = step.primaryLabel !== undefined || isLastStep;
  const primaryLabel = step.primaryLabel ?? (isLastStep ? '开始创作' : '下一步');

  /**
   * **必须挂到 document.body**（portal）。
   * 引导可能由左栏/时间线里的元素触发，而这些容器都有 `overflow: hidden`，
   * `position: fixed` 的元素超出祖先裁剪区后看不见也点不到（`ContextMenu` 踩过）。
   */
  return createPortal(
    <div className="v-onboarding" data-v="onboarding">
      <div
        className="v-onboarding__spotlight"
        data-v="onboarding-spotlight"
        style={{
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        }}
      />
      <div
        ref={tipRef}
        className="v-onboarding__tip"
        data-v="onboarding-tip"
        role="dialog"
        aria-modal="false"
        aria-labelledby="v-onboarding-title"
        style={{
          left: `${tipPos?.left ?? rect.left}px`,
          top: `${tipPos?.top ?? rect.top}px`,
          // 第一次渲染先藏起来量宽度，量完再显示，避免位置闪一下
          visibility: tipPos === null ? 'hidden' : 'visible',
        }}
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="v-onboarding__step" data-v="onboarding-step">
          第 {index + 1} 步 / 共 {steps.length} 步
        </div>
        <div className="v-onboarding__title" id="v-onboarding-title" data-v="onboarding-title">
          {step.title}
        </div>
        <div className="v-onboarding__body" data-v="onboarding-body">
          {renderBody(step.body)}
        </div>
        <div className="v-onboarding__actions">
          <button
            type="button"
            className="v-onboarding__skip"
            data-v="onboarding-skip"
            onClick={() => closeRef.current('skipped')}
          >
            跳过
          </button>
          <div className="v-onboarding__nav">
            {canGoPrev ? (
              <button type="button" className="v-onboarding__btn" data-v="onboarding-prev" onClick={goPrev}>
                上一步
              </button>
            ) : null}
            <button
              type="button"
              className="v-onboarding__btn v-onboarding__btn--primary"
              data-v="onboarding-next"
              onClick={() => {
                if (finishes) closeRef.current('done');
                else goNext();
              }}
            >
              {primaryLabel}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
