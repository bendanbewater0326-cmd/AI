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
 * 存 `localStorage['veditor:adjust:openGroups']`（JSON 数组）。
 * 刷新后保持用户上次的展开状态 —— 不能每次打开都回到默认（用户展开曲线后
 * 点一下别的 Tab 再回来，又折叠上会很烦）。
 */
import { useCallback, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

const STORAGE_KEY = 'veditor:adjust:openGroups';

function readOpenGroups(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function writeOpenGroups(groups: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
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
   * - `plain`：**属性栏用的纯标题**（复刻 `.v-inspector__section` 的 DOM 与样式，不折叠）
   *
   * 为什么要这个模式：S5 要求属性栏与左栏共用同一套组件，但属性栏原来是
   * "平铺分组标题、不折叠"。直接套折叠卡片会改变它的外观与交互（用户要求"无感知升级"），
   * 所以让同一个组件支持两种呈现，而不是为了共用去牺牲属性栏的既有体验。
   */
  variant?: 'panel' | 'plain';
  /** 仅 `panel` 模式有效：`plain` 永远不折叠。 */
  defaultOpen?: boolean;
}

export function CollapsibleSection(props: CollapsibleSectionProps): ReactElement {
  const { title, groupKey, defaultOpen = false, actions, children, testId, variant = 'panel' } = props;

  // 属性栏模式：**复刻既有 DOM**（`.v-inspector__group--section` + `.v-inspector__section`），
  // 保证外观与"不折叠"的交互完全不变。
  if (variant === 'plain') {
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
    const stored = readOpenGroups();
    if (stored.includes(groupKey)) return true;
    // 没有记录时用默认值；但"默认展开"的分组不写进存储，保持"未选择"语义
    return defaultOpen && !stored.includes(`!${groupKey}`);
  });

  const toggle = useCallback((): void => {
    setOpen((previous) => {
      const next = !previous;
      const stored = readOpenGroups().filter((item) => item !== groupKey && item !== `!${groupKey}`);
      // 展开的存裸 key、折叠的存 `!key` —— 否则"用户主动折叠了默认展开的分组"记不住
      stored.push(next ? groupKey : `!${groupKey}`);
      writeOpenGroups(stored);
      return next;
    });
  }, [groupKey]);

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
