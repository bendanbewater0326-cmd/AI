/**
 * 左栏（S1.3）：44px 纵向图标条 + Tab 内容区。
 *
 * ## 布局决策（用户拍板 A 方案）
 *
 * 44px 图标条**算在左栏 25% 之内**（与 opencut-classic 的 `tabbar` 一致），
 * 不是"25% + 44px"。好处是拖拽上限 40% 时不会额外挤压中间预览区，
 * 窄屏（820px）下也不会把预览挤没。
 *
 * ```
 * ┌──────────────────────────── 25% ────────────────────────────┐
 * │ 44px │ 内容区（25% − 44px）                                  │
 * │ 图标 │ 素材面板 / 「功能开发中」占位                          │
 * └─────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## 为什么素材面板**始终挂载**、只用 `hidden` 藏起来
 *
 * 切到别的 Tab 时如果卸载 `AssetPanel`，会连带丢掉：
 *   - 正在进行的导入（`importing.current` 是 ref，卸载后仍在跑，回来时状态已丢）；
 *   - 已解析好的缩略图（`thumbs` 是组件 state，回来要重新从 IDB 读一遍）；
 *   - 隐藏的 `<input type=file>` 节点（重链流程依赖它，卸载后 `ref.click()` 静默失效）。
 *
 * `hidden` 同时满足无障碍要求：`display: none` 的元素不可聚焦，读屏也会跳过。
 *
 * ## 未实现的 Tab 不置灰
 *
 * 用户明确要求：9 个 Tab 视觉统一，未实现的点进去给友好提示，**不做 disabled**。
 * 置灰会让整条图标条看起来"缺了几块"，也会让人以为软件坏了。
 */

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { AssetPanel } from './AssetPanel';
import { TextPanel } from './TextPanel';
import { TransitionPanel } from './TransitionPanel';
import { EffectPanel } from './EffectPanel';
import { AdjustPanel } from './adjust/AdjustPanel';

/** 9 个 Tab 的固定顺序（对齐 opencut-classic 的 TAB_KEYS，去掉我们不做的 adjustment 之外的项）。 */
export const LEFT_TABS = [
  { key: 'media', label: '素材', hint: '导入与管理本地音视频' },
  { key: 'audio', label: '音频', hint: '音乐库、音效与配音' },
  { key: 'text', label: '文本', hint: '标题、花字与文字模板' },
  { key: 'sticker', label: '贴纸', hint: '表情与装饰贴纸' },
  { key: 'effect', label: '特效', hint: '画面特效与滤镜' },
  { key: 'transition', label: '转场', hint: '片段之间的过渡效果' },
  { key: 'caption', label: '字幕', hint: '字幕样式与批量识别' },
  { key: 'adjust', label: '调节', hint: '亮度、对比度与色彩' },
  { key: 'settings', label: '设置', hint: '工程参数与偏好' },
] as const;

export type LeftTabKey = (typeof LEFT_TABS)[number]['key'];

const STORAGE_KEY = 'veditor:leftTab';

/** 当前激活的 Tab（模块级镜像：测试钩子要在组件外读到它）。 */
let activeTabMemo: LeftTabKey = 'media';

export function getActiveLeftTab(): LeftTabKey {
  return activeTabMemo;
}

function isTabKey(value: string | null): value is LeftTabKey {
  return value !== null && LEFT_TABS.some((tab) => tab.key === value);
}

function readStoredTab(): LeftTabKey {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
    return isTabKey(raw) ? raw : 'media';
  } catch {
    // 隐私模式下读不到：回到默认
    return 'media';
  }
}

function storeTab(key: LeftTabKey): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, key);
  } catch {
    // 写不进去不影响本次会话
  }
}

/**
 * 图标：16px 线性图标，`currentColor` 描边。
 *
 * 不用 emoji：不同系统字体渲染差异很大（Windows 上是彩色 emoji、Linux 上可能是
 * 黑白字形），会让 9 个图标看起来粗细不一 —— 这是"不够专业"最直观的来源。
 */
function TabIcon({ tab }: { tab: LeftTabKey }): ReactElement {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (tab) {
    case 'media':
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M10 9.2l5.2 2.8L10 14.8z" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'audio':
      return (
        <svg {...common}>
          <path d="M9 17.5V6.2l8-1.7v11" />
          <circle cx="6.6" cy="17.8" r="2.4" />
          <circle cx="14.6" cy="15.8" r="2.4" />
        </svg>
      );
    case 'text':
      return (
        <svg {...common}>
          {/* 干净的 T：加底部横杠会变成"工"，和"文本"对不上 */}
          <path d="M5 6.5h14M12 6.5V18" />
        </svg>
      );
    case 'sticker':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M9 10h.01M15 10h.01M8.8 14c.9 1.2 2 1.8 3.2 1.8s2.3-.6 3.2-1.8" />
        </svg>
      );
    case 'effect':
      return (
        <svg {...common}>
          <path d="M11 3.5l1.7 4.3 4.3 1.7-4.3 1.7L11 15.5 9.3 11.2 5 9.5l4.3-1.7z" />
          <path d="M17.6 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
        </svg>
      );
    case 'transition':
      return (
        <svg {...common}>
          <rect x="3.2" y="6" width="9.2" height="12" rx="1.6" />
          <rect x="11.6" y="6" width="9.2" height="12" rx="1.6" />
        </svg>
      );
    case 'caption':
      return (
        <svg {...common}>
          <rect x="3" y="5.5" width="18" height="13" rx="2" />
          <path d="M6.8 10.6h4M6.8 14.2h10M13.4 10.6h3.8" />
        </svg>
      );
    case 'adjust':
      return (
        <svg {...common}>
          <path d="M4 8h9M17 8h3M4 16h3M11 16h9" />
          <circle cx="15" cy="8" r="2" />
          <circle cx="9" cy="16" r="2" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3.1" />
          <path d="M12 3.6v2.2M12 18.2v2.2M3.6 12h2.2M18.2 12h2.2M6.1 6.1l1.5 1.5M16.4 16.4l1.5 1.5M17.9 6.1l-1.5 1.5M7.6 16.4l-1.5 1.5" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
        </svg>
      );
  }
}

/**
 * 未实现 Tab 的占位。
 *
 * 文案刻意写成"**做什么** + 现在怎么办"，而不是干巴巴一句"开发中"——
 * 用户点进来是想找某个能力，得让他知道这里将来会有什么、此刻替代路径在哪。
 */
function TabPlaceholder({ label, hint }: { label: string; hint: string }): ReactElement {
  return (
    <div className="v-tabplaceholder" data-v="tab-placeholder" data-tab-label={label}>
      <div className="v-tabplaceholder__icon" aria-hidden="true">
        <TabIcon tab={LEFT_TABS.find((tab) => tab.label === label)?.key ?? 'media'} />
      </div>
      <div className="v-tabplaceholder__title" data-v="tab-placeholder-title">
        {label}功能开发中
      </div>
      <div className="v-tabplaceholder__hint">{hint}，正在开发中。</div>
      <div className="v-tabplaceholder__hint v-tabplaceholder__hint--dim">
        当前版本请先在「素材」里导入文件，拖到时间轴开始剪辑。
      </div>
    </div>
  );
}

/** 左栏：图标条 + 内容区。 */
export function LeftPanel(): ReactElement {
  const [active, setActive] = useState<LeftTabKey>(() => {
    const stored = readStoredTab();
    activeTabMemo = stored;
    return stored;
  });

  // 记住上次停留的 Tab（桌面软件习惯：关掉再开还在原处）
  useEffect(() => {
    activeTabMemo = active;
    storeTab(active);
  }, [active]);

  const current = LEFT_TABS.find((tab) => tab.key === active) ?? LEFT_TABS[0];

  return (
    <aside className="v-rail v-rail--left" data-v="asset-panel" data-left-tab={active} aria-label="左侧面板">
      <nav className="v-tabbar" data-v="left-tabbar" aria-label="左侧功能切换">
        {LEFT_TABS.map((tab) => {
          const selected = tab.key === active;
          return (
            <button
              key={tab.key}
              type="button"
              className="v-tabbar__btn"
              data-v={`left-tab-${tab.key}`}
              data-active={selected}
              /**
               * **不要加 `disabled`**：未实现的 Tab 也要能点开看提示。
               * `aria-current` 而不是 `aria-selected`：这是一组按钮，不是 tablist
               * （真正的 tablist 要求键盘左右键切换，这里没做，别骗读屏）。
               */
              aria-current={selected ? 'true' : undefined}
              aria-label={tab.label}
              title={tab.label}
              onClick={() => setActive(tab.key)}
            >
              <TabIcon tab={tab.key} />
              <span className="v-tabbar__label">{tab.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="v-tabpane" data-v="left-content" data-tab={active}>
        {/*
          素材面板常驻挂载，非激活时 `hidden`（见文件头注释：卸载会丢导入状态/缩略图/文件输入框）。
        */}
        <div className="v-tabpane__slot" hidden={active !== 'media'} data-v="asset-content-slot">
          <AssetPanel />
        </div>
        {/*
          文本面板同样**常驻挂载**：切走再切回来，用户选中的分类还在
          （卸载会把 `category` 重置成「全部」，属于"我明明选过字幕"的小挫败）。
        */}
        <div className="v-tabpane__slot" hidden={active !== 'text'} data-v="text-content-slot">
          <TextPanel />
        </div>
        <div className="v-tabpane__slot" hidden={active !== 'transition'} data-v="transition-content-slot">
          <TransitionPanel />
        </div>
        {/* 特效面板：同样常驻挂载（分类筛选与缩略图源不必每次重算） */}
        <div className="v-tabpane__slot" hidden={active !== 'effect'} data-v="effect-content-slot">
          <EffectPanel />
        </div>
        {/*
          调节面板：与特效面板**共用同一份 clip.effects** ——
          特效选风格、调节调数值，任一侧改动另一侧立刻同步。
          同样常驻挂载：折叠态与拖动中的值不必每次切 Tab 就重置。
        */}
        <div className="v-tabpane__slot" hidden={active !== 'adjust'} data-v="adjust-content-slot">
          <AdjustPanel />
        </div>
        {active === 'media' || active === 'text' || active === 'transition' || active === 'effect' || active === 'adjust' ? null : (
          <TabPlaceholder label={current.label} hint={current.hint} />
        )}
      </div>
    </aside>
  );
}
