/**
 * 可折叠分组（调节面板的「基础调色 / 曲线 / LUT / 蒙版」用它包）。
 *
 * ## 为什么不用原生 `<details>`
 *
 * `<details>/<summary>` 看似省事，但标题右侧要放「重置」按钮 —— 点它会**同时**触发折叠
 * （summary 的 click 冒泡），得靠 `stopPropagation` 打补丁，而且不同浏览器对
 * summary 内部交互元素的处理不一致。这里用 button + 条件渲染，行为完全可控。
 *
 * ## 折叠态持久化
 *
 * 存 `localStorage[storageKey]`（JSON 数组），默认 `veditor:adjust:openGroups`。
 * 刷新后保持用户上次的展开状态 —— 不能每次打开都回到默认（用户展开曲线后
 * 点一下别的 Tab 再回来，又折叠上会很烦）。
 *
 * **为什么要 `storageKey` 可选参数（S2）**：设置面板要用同一套交互，但折叠态必须
 * 与调节面板**互不串味**（`veditor:settings:openGroups`）。复制一份折叠组件会造出
 * 第二个"展开/折叠"定义点；给同一个组件传不同 key 才符合"规则只有一个定义点"。
 */
import { useCallback, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

const DEFAULT_STORAGE_KEY = 'veditor:adjust:openGroups';

function readOpenGroups(storageKey: string): string[] {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function writeOpenGroups(storageKey: string, groups: string[]): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(groups));
  } catch {
    // 隐私模式/配额满：折叠记忆失效可接受，不影响功能
  }
}

export interface CollapsibleSectionProps {
  title: string;
  /** 分组唯一 key（存折叠态用，建议 `adjust:grade` 这种带前缀的形式）。 */
  groupKey: string;
  /** 标题右侧操作区（如「重置」按钮）。 */
  actions?: ReactNode;
  children: ReactNode;
  /** `data-v` 前缀，如 `adjust-group-grade`。 */
  testId: string;
  /**
   * 渲染模式。
   * - `panel`（默认）：左栏用的可折叠卡片（`.v-adjust__*`）
   * - `plain`：**属性栏用的纯标题**（复刻 `.v-inspector__section` 的 DOM 与样式）
   *
   * 为什么要这个模式：S5 要求属性栏与左栏共用同一套组件，但属性栏原来是
   * "平铺分组标题、不折叠"。直接套折叠卡片会改变它的外观与交互（用户要求"无感知升级"），
   * 所以让同一个组件支持两种呈现，而不是为了共用去牺牲属性栏的既有体验。
   */
  variant?: 'panel' | 'plain';
  /** 仅 `panel` 模式有效：`plain` 永远不折叠。 */
  defaultOpen?: boolean;
  /**
   * 折叠态存哪个 localStorage key（默认调节面板的）。
   * 设置面板传 `veditor:settings:openGroups` —— 两处折叠互不影响。
   */
  storageKey?: string;
  /**
   * 仅 `plain` 模式：标题变成**可折叠**（属性栏动态分组的折叠交互）。
   * 与 `panel` 的区别是不写 localStorage——属性栏的折叠态跟片段类型走，
   * 切换选中片段就回到默认态（不同片段间继承折叠配置只会造成"它怎么收起来了"的困惑）。
   * 键盘回车/空格切换由 `<button>` 原生承担，无障碍能力与 panel 一致。
   */
  collapsible?: boolean;
}

/**
 * plain + collapsible 的实现体（hooks 不能出现在条件分支里，拆成独立组件）。
 * 折叠态是**纯本地 state**：不读写任何存储，每次挂载（选中片段变化 → 父组件用 key 重挂）
 * 都回到 `defaultOpen`。
 */
function PlainCollapsibleSection(props: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  testId: string;
  defaultOpen: boolean;
}): ReactElement {
  const [open, setOpen] = useState(props.defaultOpen);
  return (
    <>
      <div
        className="v-inspector__group v-inspector__group--section"
        data-v={props.testId}
        data-open={open ? 'true' : 'false'}
      >
        <button
          type="button"
          className="v-inspector__section-toggle"
          data-v={`${props.testId}-toggle`}
          aria-expanded={open}
          onClick={() => setOpen((previous) => !previous)}
        >
          <span className="v-inspector__section-caret" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span className="v-inspector__section">{props.title}</span>
        </button>
        {props.actions === undefined ? null : <div className="v-adjust__actions">{props.actions}</div>}
      </div>
      {open ? props.children : null}
    </>
  );
}

export function CollapsibleSection(props: CollapsibleSectionProps): ReactElement {
  const {
    title,
    groupKey,
    defaultOpen = false,
    actions,
    children,
    testId,
    variant = 'panel',
    storageKey = DEFAULT_STORAGE_KEY,
    collapsible = false,
  } = props;

  // 属性栏模式：**复刻既有 DOM**（`.v-inspector__group--section` + `.v-inspector__section`），
  // 保证外观与"不折叠"的交互完全不变；`collapsible` 时同一套外观加折叠能力。
  if (variant === 'plain') {
    if (collapsible) {
      return (
        <PlainCollapsibleSection title={title} actions={actions} testId={testId} defaultOpen={defaultOpen}>
          {children}
        </PlainCollapsibleSection>
      );
    }
    return (
      <>
        <div className="v-inspector__group v-inspector__group--section" data-v={testId}>
          <span className="v-inspector__section">{title}</span>
          {actions === undefined ? null : <div className="v-adjust__actions">{actions}</div>}
        </div>
        {children}
      </>
    );
  }

  // 懒惰初始化：读一次 localStorage（避免每次渲染都读）
  const [open, setOpen] = useState<boolean>(() => {
    const stored = readOpenGroups(storageKey);
    if (stored.includes(groupKey)) return true;
    // 没有记录时用默认值；但"默认展开"的分组不写进存储，保持"未选择"语义
    return defaultOpen && !stored.includes(`!${groupKey}`);
  });

  const toggle = useCallback((): void => {
    setOpen((previous) => {
      const next = !previous;
      const stored = readOpenGroups(storageKey).filter((item) => item !== groupKey && item !== `!${groupKey}`);
      // 展开的存裸 key、折叠的存 `!key` —— 否则"用户主动折叠了默认展开的分组"记不住
      stored.push(next ? groupKey : `!${groupKey}`);
      writeOpenGroups(storageKey, stored);
      return next;
    });
  }, [groupKey, storageKey]);

  return (
    <section className="v-adjust__section" data-v={testId} data-open={open ? 'true' : 'false'}>
      <div className="v-adjust__header">
        <button
          type="button"
          className="v-adjust__toggle"
          data-v={`${testId}-toggle`}
          aria-expanded={open}
          onClick={toggle}
        >
          <span className="v-adjust__caret" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span className="v-adjust__title">{title}</span>
        </button>
        {actions === undefined ? null : <div className="v-adjust__actions">{actions}</div>}
      </div>
      {open ? <div className="v-adjust__body">{children}</div> : null}
    </section>
  );
}
