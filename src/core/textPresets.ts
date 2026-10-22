/**
 * 文字模板库（左栏「文本」面板的数据源）。
 *
 * ## 为什么是"纯数据 + 一个转换函数"
 *
 * 模板不该带任何副作用：面板只负责把它渲染成卡片，落片走
 * `createTextContent` + 一条 `addClip`（或 `setClipText`）。
 * 把"点击后做什么"写进数据里，以后加拖拽/右键/Agent 调用时就得复制一遍逻辑。
 *
 * ## 坐标是 1080p 的绝对像素
 *
 * `TextContent.x/y` 是相对画面中心的**绝对像素**（现有语义，没动）。
 * 这里的数值按 1920×1080 写：`x=±820` 离画面边缘 140px，`y=+430` 离底 110px。
 * 4K 工程下同样的偏移会显得偏小 —— **已知限制**，改它等于动时基，不在本次范围。
 *
 * ## 预设里只放"看得见的差异"
 *
 * 每个预设至少在一个维度上明显不同（字号 / 颜色 / 底衬 / 位置 / 粗体 / 描边），
 * 否则 10 个卡片会长得一模一样，用户只能靠名字猜。
 */
import type { TextContent } from './types';
import { createTextContent } from './types';

export type TextCategory = 'title' | 'caption' | 'label' | 'quote';

/**
 * 新建文字片段的默认时长（秒）。
 *
 * 手动新建（面板 / 工具栏「文字」/ 拖拽）共用这一个常量 ——
 * 三处各写一个 3 迟早会变成 3 / 3 / 5，用户会觉得"同一个操作时长不一样"。
 */
export const TEXT_CLIP_SECONDS = 3;

export interface TextPreset {
  id: string;
  /** 全中文名（界面上不出现英文） */
  name: string;
  category: TextCategory;
  /** 点一下填进新片段的内容（含 `\n` 的会变成多行） */
  content: string;
  /** 只覆盖样式，不含 content */
  style: Partial<Omit<TextContent, 'content'>>;
  /**
   * 缩略图底色。
   * 白底黑字条这类浅色预设必须用 `light`，否则白字压在白底卡片上什么都看不见。
   */
  previewBg: 'dark' | 'light';
}

export const TEXT_CATEGORIES: ReadonlyArray<{ key: TextCategory | 'all'; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'title', label: '标题' },
  { key: 'caption', label: '字幕' },
  { key: 'label', label: '标注' },
  { key: 'quote', label: '金句' },
];

/** 首批 10 个模板（顺序即展示顺序）。 */
export const TEXT_PRESETS: readonly TextPreset[] = [
  {
    id: 'tpl-title-main',
    name: '主标题',
    category: 'title',
    content: '主标题',
    style: { fontSize: 88, color: '#ffffff', align: 'center', y: 0, bold: true },
    previewBg: 'dark',
  },
  {
    id: 'tpl-title-sub',
    name: '副标题',
    category: 'title',
    content: '副标题',
    style: { fontSize: 48, color: '#ffffff', align: 'center', y: 90 },
    previewBg: 'dark',
  },
  {
    id: 'tpl-title-big',
    name: '大标题',
    category: 'title',
    content: '大标题',
    style: { fontSize: 120, color: '#ffffff', align: 'center', y: -80, bold: true },
    previewBg: 'dark',
  },
  {
    id: 'tpl-title-pair',
    name: '主副标题',
    category: 'title',
    content: '主标题\n副标题',
    style: { fontSize: 64, color: '#ffffff', align: 'center', y: 0, bold: true },
    previewBg: 'dark',
  },
  {
    id: 'tpl-caption-bottom',
    name: '底部字幕',
    category: 'caption',
    content: '这里输入字幕',
    style: { fontSize: 44, color: '#ffffff', align: 'center', y: 380 },
    previewBg: 'dark',
  },
  {
    id: 'tpl-caption-dark',
    name: '黑底白字条',
    category: 'caption',
    content: '这里输入字幕',
    style: { fontSize: 44, color: '#ffffff', align: 'center', y: 380, background: 'rgba(0,0,0,0.62)' },
    previewBg: 'dark',
  },
  {
    id: 'tpl-caption-light',
    name: '白底黑字条',
    category: 'caption',
    content: '这里输入字幕',
    style: { fontSize: 44, color: '#1a1a1a', align: 'center', y: 380, background: 'rgba(255,255,255,0.88)' },
    previewBg: 'light',
  },
  {
    id: 'tpl-label-corner',
    name: '左上角标',
    category: 'label',
    content: '角标',
    style: { fontSize: 30, color: '#ffffff', align: 'left', x: -820, y: -430, background: 'rgba(0,0,0,0.45)' },
    previewBg: 'dark',
  },
  {
    id: 'tpl-label-date',
    name: '右下日期',
    category: 'label',
    content: '2026-10-23',
    style: { fontSize: 28, color: '#e6e6e6', align: 'right', x: 820, y: 430 },
    previewBg: 'dark',
  },
  {
    id: 'tpl-quote-stroke',
    name: '金句描边',
    category: 'quote',
    content: '一句话金句',
    style: {
      fontSize: 72,
      color: '#ffffff',
      align: 'center',
      y: 0,
      bold: true,
      stroke: { width: 6, color: '#000000' },
    },
    previewBg: 'dark',
  },
];

/** 按 id 取预设（拖拽时只传 id，回来要还原成模板）。 */
export function textPresetById(id: string): TextPreset | null {
  return TEXT_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** 按分类筛选（`all` 返回全部）。 */
export function textPresetsIn(category: TextCategory | 'all'): readonly TextPreset[] {
  return category === 'all' ? TEXT_PRESETS : TEXT_PRESETS.filter((preset) => preset.category === category);
}

/**
 * 预设 → 可直接落片的 `TextContent`。
 *
 * ## 三个参数
 *
 * - `content` 传了就用传的（"套样式但保留用户写的字"走这条），
 *   不传就用模板自带的内容（"新建一段文字"走这条）；
 * - `size` 是**目标工程的分辨率**，缺省 1920×1080。
 *
 * ## 为什么必须按分辨率换算
 *
 * `TextContent.x/y/fontSize` 都是**绝对像素**（现有语义）。模板里写的是 1080p 参考值，
 * 如果原样落进 1280×720 的工程：`y=380` 会超过 720/2=360 的半个画面高 ——
 * 文字直接被推到画面外**完全看不见**（实测：720p 素材 + 「底部字幕」= 一片黑）。
 * 4K 工程则相反，偏移和字号都显得偏小。
 *
 * 所以按"高度比例"换算一次：字号 × height/1080、y × height/1080、x × width/1920。
 * 这样同一套模板在 720p / 1080p / 4K 下的**相对位置与视觉大小完全一致**。
 */
export function presetToText(
  preset: TextPreset,
  content?: string,
  size: { width: number; height: number } = { width: 1920, height: 1080 },
): TextContent {
  const style = preset.style;
  const scaleY = size.height / 1080;
  const scaleX = size.width / 1920;
  const scaled: Partial<Omit<TextContent, 'content'>> = { ...style };
  if (style.fontSize !== undefined) scaled.fontSize = Math.max(8, Math.round(style.fontSize * scaleY));
  if (style.x !== undefined) scaled.x = Math.round(style.x * scaleX);
  if (style.y !== undefined) scaled.y = Math.round(style.y * scaleY);
  // 描边粗细也要跟着分辨率走，否则 4K 下描边细得像没画
  if (style.stroke !== null && style.stroke !== undefined) {
    scaled.stroke = { width: Math.max(1, Math.round(style.stroke.width * scaleY)), color: style.stroke.color };
  }
  return createTextContent({
    ...scaled,
    content: content === undefined ? preset.content : content,
  });
}
