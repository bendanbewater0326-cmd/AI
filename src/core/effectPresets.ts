/**
 * 画面特效预设库（左栏「特效」面板的数据源）。
 *
 * ## 为什么"特效"= 调色预设
 *
 * 渲染层能真实表达的**画面**效果只有四种：`colorGrade`（四个连续参数）、
 * `curve`（只有 2 个控制点）、`lut`（要外部 .cube 文件）、`mask`（空间挖洞，不是滤镜）。
 * 没有模糊 / 像素化 / 光效 / 故障 —— 要做那些得给 `Compositor` 加新的 shader pass
 * （WebGL 与 Canvas2D 两套实现都要改），属于渲染器改造，不是面板范围。
 *
 * 所以「一键滤镜」只有一条路：`colorGrade` 的参数组合。这也正好和「调节」Tab 分工：
 * **特效 = 选风格（预设），调节 = 调数值（滑块）**，两者写的是同一份 `clip.effects`。
 *
 * ## 参数含义（-100..100，0 = 不变）
 *
 * | 参数 | 正向 | 着色器里怎么用 |
 * |---|---|---|
 * | brightness | 变亮 | `c += v/200`（**加法**） |
 * | contrast | 反差变大 | `c = (c-0.5)*(1+v/100)+0.5` |
 * | saturation | 更艳 | `c = mix(luma, c, 1+v/100)` |
 * | temperature | 更暖 | `r += v/100*0.15; b -= v/100*0.15` |
 *
 * 每个预设至少在一个维度上和邻居明显不同，否则 14 张卡片长得一模一样，用户只能靠名字猜。
 *
 * 类型 `ColorGrade` 从 `render/compositor` **只导入类型**（`import type`，编译后消失），
 * 所以 `core/` 对渲染实现没有任何运行时依赖。
 */
import type { ColorGrade } from '../render/compositor';

export type EffectCategory = 'basic' | 'tone' | 'style';

export interface EffectPreset {
  id: string;
  /** 全中文名（界面上不出现英文） */
  name: string;
  category: EffectCategory;
  /** 四个调色参数；全 0 = 原片（应用它等于移除特效） */
  params: ColorGrade;
  /** 悬停提示：一句话说清"这个预设干什么" */
  hint: string;
}

export const EFFECT_CATEGORIES: ReadonlyArray<{ key: EffectCategory | 'all'; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'basic', label: '基础' },
  { key: 'tone', label: '冷暖' },
  { key: 'style', label: '风格' },
];

/** 原片：**不是**"写四个 0 的 effect"，而是"把 effect 删掉"（见 `buildEffectOps`）。 */
export const ORIGINAL_PRESET: EffectPreset = {
  id: 'fx-original',
  name: '原片',
  category: 'basic',
  params: { brightness: 0, contrast: 0, saturation: 0, temperature: 0 },
  hint: '不加任何调色（点它会移除已有特效）',
};

/** 14 个预设（顺序即展示顺序；原片固定第一条）。 */
export const EFFECT_PRESETS: readonly EffectPreset[] = [
  ORIGINAL_PRESET,
  {
    id: 'fx-brighten',
    name: '提亮',
    category: 'basic',
    params: { brightness: 18, contrast: 0, saturation: 0, temperature: 0 },
    hint: '整体抬亮，适合欠曝的素材',
  },
  {
    id: 'fx-darken',
    name: '压暗',
    category: 'basic',
    params: { brightness: -18, contrast: 0, saturation: 0, temperature: 0 },
    hint: '整体压暗，救过曝的画面',
  },
  {
    id: 'fx-contrast',
    name: '高对比',
    category: 'basic',
    params: { brightness: 0, contrast: 28, saturation: 0, temperature: 0 },
    hint: '拉开明暗，画面更"硬"',
  },
  {
    id: 'fx-soft',
    name: '柔和',
    category: 'basic',
    params: { brightness: 6, contrast: -22, saturation: -6, temperature: 0 },
    hint: '压低反差，适合人像与回忆感',
  },
  {
    id: 'fx-warm',
    name: '暖阳',
    category: 'tone',
    params: { brightness: 6, contrast: 0, saturation: 8, temperature: 34 },
    hint: '加暖加饱和，像下午的阳光',
  },
  {
    id: 'fx-cool',
    name: '冷调',
    category: 'tone',
    params: { brightness: 0, contrast: 6, saturation: 0, temperature: -34 },
    hint: '偏蓝的冷色，适合科技与夜景',
  },
  {
    id: 'fx-warm-night',
    name: '暖夜',
    category: 'tone',
    params: { brightness: -14, contrast: 8, saturation: -6, temperature: 22 },
    hint: '压暗加暖，霓虹夜景色',
  },
  {
    id: 'fx-cool-white',
    name: '冷白',
    category: 'tone',
    params: { brightness: 12, contrast: 4, saturation: -10, temperature: -18 },
    hint: '提亮去黄，干净的产品/口播感',
  },
  {
    id: 'fx-mono',
    name: '黑白',
    category: 'style',
    params: { brightness: 0, contrast: 8, saturation: -100, temperature: 0 },
    hint: '完全去色（饱和度拉到 -100）',
  },
  {
    id: 'fx-retro',
    name: '复古胶片',
    category: 'style',
    params: { brightness: 4, contrast: -12, saturation: -26, temperature: 18 },
    hint: '低饱和偏黄，老胶片质感',
  },
  {
    id: 'fx-cinema',
    name: '电影感',
    category: 'style',
    params: { brightness: -6, contrast: 20, saturation: -14, temperature: -10 },
    hint: '压暗拉反差去饱和，偏青的影调',
  },
  {
    id: 'fx-japan',
    name: '日系清透',
    category: 'style',
    params: { brightness: 12, contrast: -14, saturation: -6, temperature: -4 },
    hint: '提亮降反差，通透的日常感',
  },
  {
    id: 'fx-vivid',
    name: '鲜艳',
    category: 'style',
    params: { brightness: 0, contrast: 10, saturation: 38, temperature: 0 },
    hint: '饱和度拉高，风景与美食',
  },
];

/** 按 id 取预设（拖拽载荷里只有 id）。 */
export function effectPresetById(id: string): EffectPreset | null {
  return EFFECT_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * 分类下的预设。
 *
 * **原片永远排第一**：它就是"取消特效"的入口，用户切到「风格」分类后仍然要能点它，
 * 否则想撤掉特效还得先切回「全部」（多一步，而且没人会想到）。
 */
export function effectPresetsIn(category: EffectCategory | 'all'): readonly EffectPreset[] {
  if (category === 'all') return EFFECT_PRESETS;
  return [
    ORIGINAL_PRESET,
    ...EFFECT_PRESETS.filter((preset) => preset.category === category && preset.id !== ORIGINAL_PRESET.id),
  ];
}

/** 是不是「原片」（= 移除特效）。 */
export function isOriginalPreset(preset: EffectPreset): boolean {
  return preset.id === ORIGINAL_PRESET.id;
}
