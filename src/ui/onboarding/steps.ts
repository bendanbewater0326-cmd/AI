/**
 * 新手引导的**步骤配置**（只有数据，没有逻辑、不碰 DOM、不依赖 React）。
 *
 * ## 为什么单独一个文件
 *
 * 引导浮层（`Onboarding.tsx`）要做的事很多：定位、挖洞、键盘、三种退出方式。
 * 把「讲什么、指哪儿」独立出来，改文案就不必在 260 行组件里翻找字符串。
 * 另一个好处是**可单测**：`steps.ts` 是纯数据，Node 里能直接 import 校验
 * （见 `tests/onboarding.test.mjs`）。
 *
 * ## 锚点为什么都用 `data-v`
 *
 * 项目里所有可被外部定位的节点都带 `data-v="..."`（E2E 也靠它）。
 * 用它而不是 class：class 会被样式重构改名，`data-v` 是**契约**。
 * 6 个锚点全部是「常驻节点」，不会因为空工程 / 切 Tab 而消失——
 * 特别注意第 ② 步用的是 `asset-content`（整栏外壳），不是 `asset-empty`
 * （那个节点只在没有素材时存在，先导入素材再触发引导就会指空）。
 *
 * ## 文案约定
 *
 * - 全简体中文，**不出现技术术语**（不说"轨道""关键帧""编解码"）。
 * - 每一步**只说一件事**。第 ③ 步讲时间轴时不能写"拖动这个片段"——
 *   空工程时没有片段，要描述**位置**而不是指某个具体对象。
 * - `body` 允许出现 `**加粗**` 标记（G2 渲染时拆分），但目前 6 条初稿都是纯文本，
 *   没有用标记：引导框本来就很短，满屏加粗反而没有重点。
 */

/** 6 个步骤的稳定 id（顺序即 `ONBOARDING_STEPS` 的数组顺序）。 */
export type OnboardingStepId = 'panel' | 'assets' | 'timeline' | 'inspector' | 'export' | 'ai';

/**
 * 提示框相对目标元素的位置。
 *
 * 不做运行时"哪边空间大放哪边"的自动推算：每一步的目标在哪个方向是**确定的**
 * （左栏目标 → 提示放右边；右栏目标 → 放左边；顶栏目标 → 放下方；时间轴 → 放上方），
 * 写死比猜更稳，也避免了测量失败时提示框乱跳。
 */
export type OnboardingPlacement = 'right' | 'left' | 'below' | 'above';

export interface OnboardingStep {
  /** 稳定标识（用于埋点 / 手动跳步 / 单测断言）。 */
  id: OnboardingStepId;
  /** 中文标题（一句话，不超过 12 字）。 */
  title: string;
  /** 中文正文（1~2 句，可以含 `**加粗**` 标记，不要写 HTML）。 */
  body: string;
  /** 目标元素的 CSS 选择器（一律 `[data-v="..."]` 形式）。 */
  selector: string;
  /** 提示框相对目标的位置。 */
  placement: OnboardingPlacement;
  /**
   * 需要宿主提供 AI 通道才展示（只有第 ⑥ 步）。
   * 纯前端独立运行时没有 AI 入口，指着空气讲 Ctrl+K 只会让人困惑——
   * 过滤逻辑见 `state.ts` 的 `resolveSteps`。
   */
  requiresAI?: boolean;
  /** 主按钮文案；缺省时由组件用「下一步」。仅最后一步是「开始创作」。 */
  primaryLabel?: string;
}

/**
 * 6 步配置（顺序 = 用户认知顺序：从哪儿开始 → 怎么进素材 → 在哪儿剪 →
 * 怎么调 → 怎么出片 → 还有什么捷径）。
 *
 * `readonly` 是为了防止调用方（组件 / 测试）就地改数组把引导改坏。
 */
export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    id: 'panel',
    title: '左边是功能区',
    // 只列**有内容**的面板，且顺序对齐图标条。不写"全部"：贴纸目前是空壳，
    // 列进去等于主动引导用户去踩空；"常用的都在这排"既不说谎，也给以后加面板留了余地。
    body: '素材、音频、文本、特效、转场、字幕、调节、设置——常用的都在这排。做片从「素材」开始。',
    selector: '[data-v="left-tab-media"]',
    placement: 'right',
  },
  {
    id: 'assets',
    title: '先把素材放进来',
    body: '两种方式：把视频或图片直接拖进窗口，或者点这里的「导入」。',
    selector: '[data-v="asset-content"]',
    placement: 'right',
  },
  {
    id: 'timeline',
    title: '这里是时间轴',
    body: '片段按时间从左到右排开（导入后就会出现）。拖动它换位置、拖两端改长短，右键能切分、删除、分离音频。',
    selector: '[data-v="timeline"]',
    placement: 'above',
  },
  {
    id: 'inspector',
    title: '选中片段，右边能调',
    body: '点一下片段，右边就会显示它的属性：位置、大小、不透明、颜色、声音。',
    selector: '[data-v="inspector-panel"]',
    placement: 'left',
  },
  {
    id: 'export',
    title: '满意了就导出',
    body: '点「导出」，选个规格（竖屏短视频 / 1080P / 720P），改个文件名就行。',
    selector: '[data-v="export-open"]',
    placement: 'below',
  },
  {
    id: 'ai',
    title: '还能直接说人话',
    // 顶栏 AI 入口只在宿主提供通道时才渲染，所以这一步 requiresAI
    body: '按 Ctrl + K（Mac 是 ⌘ + K）说「把亮度调低点」「自动生成字幕」，它会自己动手。',
    selector: '[data-v="ai-open"]',
    placement: 'below',
    requiresAI: true,
    primaryLabel: '开始创作',
  },
];

/** 全部步骤的 id 顺序（单测/埋点用，避免在别处再抄一遍）。 */
export const ONBOARDING_STEP_IDS: readonly OnboardingStepId[] = ONBOARDING_STEPS.map((step) => step.id);
