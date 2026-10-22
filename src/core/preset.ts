/**
 * 预设（R-053）：把"一个片段长什么样"存成可复用的数据，一键套到别的片段上。
 *
 * ## 存什么、不存什么
 *
 * 存：**视觉与声音的"样式"** —— 变换（缩放/位置/不透明度/混合）、调色、音量与淡化、文字样式。
 * 不存：
 * - **时间相关**（起止帧、时长、速度）：套到别的片段上会改变它的长度，属于"剪辑决定"，
 *   不能靠一个按钮替用户做；
 * - **转场**：转场取决于"和谁相邻"，套用会得到意料之外的结果；
 * - **内容**（文字内容、素材引用）：预设是样式，不是复制片段。
 *
 * ## 为什么生成的是 `ClipOperation[]` 而不是直接改 doc
 *
 * 套用预设必须是**一个撤销步**、且能被 Ctrl+Z 完整还原。所以这里只负责"算出操作"，
 * 由 store 统一 dispatch（与 AI 那条链路同一个规矩）。
 */
import type {
  Clip,
  ClipAudio,
  ClipOperation,
  Effect,
  TextContent,
  Transform,
} from './types';
import { createId } from './types';

/** 预设里能存的字段（全部可选：只覆盖存在的那些）。 */
export interface PresetPayload {
  transform?: Partial<Transform>;
  /** 调色参数（`colorGrade` 效果的 params）。 */
  colorGrade?: Record<string, number>;
  audio?: Partial<ClipAudio>;
  /** 文字样式（不含内容）。 */
  textStyle?: Partial<Omit<TextContent, 'content'>>;
}

export interface Preset {
  id: string;
  name: string;
  createdAt: number;
  payload: PresetPayload;
}

/** 预设最多存多少个：够用且不会把 settings 撑爆。 */
export const MAX_PRESETS = 40;
/** 名字长度上限（UI 输入框也按这个限制）。 */
export const MAX_PRESET_NAME = 24;

/** 从片段抓取样式。返回 null = 这个片段没有任何可存的样式。 */
export function capturePreset(clip: Clip): PresetPayload | null {
  const payload: PresetPayload = {};

  const transform: Partial<Transform> = {};
  // 只存"被改过"的字段：默认值不写，预设才能跨片段复用而不互相打架
  if (clip.transform.scale !== 1) transform.scale = clip.transform.scale;
  if (clip.transform.x !== 0) transform.x = clip.transform.x;
  if (clip.transform.y !== 0) transform.y = clip.transform.y;
  if (clip.transform.opacity !== 1) transform.opacity = clip.transform.opacity;
  if (clip.transform.blendMode !== 'normal') transform.blendMode = clip.transform.blendMode;
  if (Object.keys(transform).length > 0) payload.transform = transform;

  const grade = clip.effects.find((effect) => effect.type === 'colorGrade' && effect.enabled);
  if (grade !== undefined) {
    const params: Record<string, number> = {};
    for (const key of ['brightness', 'contrast', 'saturation', 'temperature']) {
      const value = grade.params[key];
      if (typeof value === 'number' && value !== 0) params[key] = value;
    }
    if (Object.keys(params).length > 0) payload.colorGrade = params;
  }

  const audio: Partial<ClipAudio> = {};
  if (clip.audio.gain !== 1) audio.gain = clip.audio.gain;
  if (clip.audio.fadeInFrames > 0) audio.fadeInFrames = clip.audio.fadeInFrames;
  if (clip.audio.fadeOutFrames > 0) audio.fadeOutFrames = clip.audio.fadeOutFrames;
  if (Object.keys(audio).length > 0) payload.audio = audio;

  if (clip.text !== null && clip.text !== undefined) {
    payload.textStyle = {
      fontSize: clip.text.fontSize,
      color: clip.text.color,
      align: clip.text.align,
      background: clip.text.background,
      // 预设是"一整套样式"：粗体/描边也要带上，否则套用后两者保持原样，视觉与预设不一致
      bold: clip.text.bold === true,
      stroke: clip.text.stroke ?? null,
    };
  }

  return Object.keys(payload).length === 0 ? null : payload;
}

/** 新建预设（自动补 id / 时间戳 / 名字清洗）。 */
export function createPreset(name: string, payload: PresetPayload, now: number = Date.now()): Preset {
  const clean = name.trim().slice(0, MAX_PRESET_NAME);
  return {
    id: createId('pst'),
    name: clean === '' ? '未命名预设' : clean,
    createdAt: now,
    payload,
  };
}

/** 规范化从存储里读出来的预设（旧数据可能缺字段/类型不对）。 */
export function normalizePreset(raw: unknown): Preset | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as Partial<Preset>;
  if (typeof item.id !== 'string' || item.id === '') return null;
  const payload = normalizePayload(item.payload);
  if (payload === null) return null;
  return {
    id: item.id,
    name: typeof item.name === 'string' && item.name.trim() !== '' ? item.name : '未命名预设',
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
    payload,
  };
}

function normalizePayload(raw: unknown): PresetPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const source = raw as Record<string, unknown>;
  const payload: PresetPayload = {};

  const transform = source['transform'];
  if (typeof transform === 'object' && transform !== null) {
    const t = transform as Record<string, unknown>;
    const next: Partial<Transform> = {};
    if (typeof t['scale'] === 'number') next.scale = Math.min(5, Math.max(0, t['scale']));
    if (typeof t['x'] === 'number') next.x = t['x'];
    if (typeof t['y'] === 'number') next.y = t['y'];
    if (typeof t['opacity'] === 'number') next.opacity = Math.min(1, Math.max(0, t['opacity']));
    const blend = t['blendMode'];
    if (blend === 'normal' || blend === 'overlay' || blend === 'screen' || blend === 'multiply') {
      next.blendMode = blend;
    }
    if (Object.keys(next).length > 0) payload.transform = next;
  }

  const grade = source['colorGrade'];
  if (typeof grade === 'object' && grade !== null) {
    const params: Record<string, number> = {};
    for (const [key, value] of Object.entries(grade as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) params[key] = value;
    }
    if (Object.keys(params).length > 0) payload.colorGrade = params;
  }

  const audio = source['audio'];
  if (typeof audio === 'object' && audio !== null) {
    const a = audio as Record<string, unknown>;
    const next: Partial<ClipAudio> = {};
    if (typeof a['gain'] === 'number') next.gain = Math.max(0, a['gain']);
    if (typeof a['fadeInFrames'] === 'number') next.fadeInFrames = Math.max(0, Math.trunc(a['fadeInFrames']));
    if (typeof a['fadeOutFrames'] === 'number') next.fadeOutFrames = Math.max(0, Math.trunc(a['fadeOutFrames']));
    if (Object.keys(next).length > 0) payload.audio = next;
  }

  const text = source['textStyle'];
  if (typeof text === 'object' && text !== null) {
    const t = text as Record<string, unknown>;
    const next: Partial<Omit<TextContent, 'content'>> = {};
    if (typeof t['fontSize'] === 'number') next.fontSize = Math.max(1, Math.trunc(t['fontSize']));
    if (typeof t['color'] === 'string') next.color = t['color'];
    if (t['align'] === 'left' || t['align'] === 'center' || t['align'] === 'right') {
      next.align = t['align'];
    }
    if (typeof t['background'] === 'string') next.background = t['background'];
    // 旧预设里没有这两个字段 → 保持 undefined，套用时不动片段当前值（向后兼容）
    if (t['bold'] === true || t['bold'] === false) next.bold = t['bold'] === true;
    const stroke = t['stroke'];
    if (stroke === null) {
      next.stroke = null;
    } else if (typeof stroke === 'object' && stroke !== null) {
      const s = stroke as Record<string, unknown>;
      const width = typeof s['width'] === 'number' ? Math.max(0, Math.min(40, s['width'])) : 0;
      const color = typeof s['color'] === 'string' ? s['color'] : '#000000';
      if (width > 0) next.stroke = { width, color };
    }
    if (Object.keys(next).length > 0) payload.textStyle = next;
  }

  return Object.keys(payload).length === 0 ? null : payload;
}

/** 该预设能不能套到这个片段上（文字样式只对文字片段有效）。 */
export function presetAppliesTo(preset: Preset, clip: Clip): boolean {
  const isText = clip.text !== null && clip.text !== undefined;
  if (isText) return true;
  // 非文字片段：只要有非文字样式就能套
  return (
    preset.payload.transform !== undefined ||
    preset.payload.colorGrade !== undefined ||
    preset.payload.audio !== undefined
  );
}

/**
 * 生成"套用预设"的操作序列。
 *
 * 每个字段一条 `setClipProps`（带 `from` 才能撤销）；调色走 `setClipEffect`（整组替换）；
 * 文字样式走 `setClipText`（整份替换，保留内容）。全部操作一次性 dispatch = 一个撤销步。
 */
export function buildPresetOps(clip: Clip, preset: Preset): ClipOperation[] {
  const ops: ClipOperation[] = [];
  const { transform, colorGrade, audio, textStyle } = preset.payload;

  if (transform !== undefined) {
    for (const key of ['scale', 'x', 'y', 'opacity', 'blendMode'] as const) {
      const value = transform[key];
      if (value === undefined) continue;
      const current = clip.transform[key];
      if (current === value) continue;
      ops.push({
        op: 'setClipProps',
        clipId: clip.id,
        path: `transform.${key}`,
        from: current,
        to: value,
      });
    }
  }

  if (colorGrade !== undefined) {
    const current = clip.effects.find((effect) => effect.type === 'colorGrade') ?? null;
    const next: Effect = {
      id: current?.id ?? createId('fx'),
      clipId: clip.id,
      type: 'colorGrade',
      params: { ...colorGrade },
      keyframes: [],
      enabled: true,
      order: 0,
      source: 'ui',
    };
    ops.push({ op: 'setClipEffect', clipId: clip.id, effectType: 'colorGrade', from: current, to: next });
  }

  if (audio !== undefined) {
    for (const key of ['gain', 'fadeInFrames', 'fadeOutFrames'] as const) {
      const value = audio[key];
      if (value === undefined) continue;
      const current = clip.audio[key];
      if (current === value) continue;
      ops.push({
        op: 'setClipProps',
        clipId: clip.id,
        path: `audio.${key}`,
        from: current,
        to: value,
      });
    }
  }

  if (textStyle !== undefined && clip.text !== null && clip.text !== undefined) {
    const next: TextContent = { ...clip.text, ...textStyle };
    const changed = (Object.keys(textStyle) as Array<keyof typeof textStyle>).some(
      (key) => clip.text?.[key] !== textStyle[key],
    );
    if (changed) {
      ops.push({ op: 'setClipText', clipId: clip.id, from: clip.text, to: next });
    }
  }

  return ops;
}
