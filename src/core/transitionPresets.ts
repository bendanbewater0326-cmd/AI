/**
 * 转场预设（左栏「转场」面板的数据源）。
 *
 * ## 为什么只有 3 个
 *
 * 渲染层的 `TransitionOverride` 只有 `opacity` + `frozenFrame` 两个字段
 * （见 `media/transitionPlan.ts`），**能表达的转场只有"透明度渐变"这一类**。
 * 滑入 / 擦除 / 缩放需要给合成器加位移或裁剪矩形，属于渲染模型扩展，
 * 不在面板范围内。所以这里先如实只列 3 个，不做"看起来有 8 个、点下去一半没效果"。
 *
 * ## `side` 是数据的一部分
 *
 * 转场挂在**片段的某一侧**（`transitionIn` / `transitionOut`）：
 * - 叠化 / 淡入 → 入点（`in`）
 * - 淡出 → 出点（`out`）
 *
 * 这条规则写进数据而不是写在 UI 的 if 里：以后补新类型时只加一条数据，
 * 面板与拖拽两条链路都不用改。
 */

export type TransitionKind = 'crossDissolve' | 'fadeIn' | 'fadeOut';

export interface TransitionPreset {
  id: string;
  /** 全中文名 */
  name: string;
  type: TransitionKind;
  /** 落在片段的哪一侧 */
  side: 'in' | 'out';
  /**
   * 是否要求"左侧紧挨着一段素材"。
   *
   * 叠化需要：渲染时它会把左邻片段一起拉进来做反向淡出（`transitionPlan` 里
   * 找的是 `endOf(previous) === clip.startFrame` 的片段）。没有左邻就没东西可叠，
   * 直接落库会得到一个"只有自己淡入"的假叠化 —— 所以这里如实标出来，面板给提示。
   */
  needsPrevious: boolean;
  /** 缩略图画法（纯 DOM，不用 canvas、不用渐变） */
  preview: 'overlap' | 'fadeInBars' | 'fadeOutBars';
  /** 卡片 tooltip 里的中文说明 */
  hint: string;
}

export const TRANSITION_PRESETS: readonly TransitionPreset[] = [
  {
    id: 'trs-dissolve',
    name: '叠化',
    type: 'crossDissolve',
    side: 'in',
    needsPrevious: true,
    preview: 'overlap',
    hint: '叠化：前一段淡出、后一段淡入，需要左侧紧挨着一段素材',
  },
  {
    id: 'trs-fade-in',
    name: '淡入',
    type: 'fadeIn',
    side: 'in',
    needsPrevious: false,
    preview: 'fadeInBars',
    hint: '淡入：这一段的开头从透明渐渐显出来',
  },
  {
    id: 'trs-fade-out',
    name: '淡出',
    type: 'fadeOut',
    side: 'out',
    needsPrevious: false,
    preview: 'fadeOutBars',
    hint: '淡出：这一段的结尾渐渐隐掉',
  },
];

/** 时长档位（秒）。默认 0.5，与右侧属性栏一致。 */
export const TRANSITION_DURATIONS = [0.3, 0.5, 1.0] as const;
export const DEFAULT_TRANSITION_SECONDS = 0.5;

export function transitionPresetById(id: string): TransitionPreset | null {
  return TRANSITION_PRESETS.find((preset) => preset.id === id) ?? null;
}
