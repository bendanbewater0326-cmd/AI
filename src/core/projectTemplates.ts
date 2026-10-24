/**
 * 创作模板（P1，2026-10-25）：「编排方案」作用于当前工程——文字样式 + 系统特效 + 转场的
 * 纯配置组合，零素材依赖、零新增能力。
 *
 * ## 语义（用户拍板）
 *
 * 模板不是"凭空生成工程"：特效/转场必须挂在视频片段上，所以模板套用 = **追加**到当前工程——
 * 有视频片段时给目标片段挂特效/转场 + 落模板文字；空工程（或只有文字）降级为只落文字，
 * notes 给可读提示（不静默、不硬造无效效果）。
 *
 * ## 复用（同一条规则只有一个定义点）
 *
 * - 文字：`core/textClip.buildNewTextOps`（建轨+落片同批）+ `presetToText`（坐标字号按工程
 *   分辨率换算——模板全部写 1080p 参考值）
 * - 特效：`core/effectTarget.buildEffectOps`（id 复用/等值跳过/同类型单例替换）
 * - 转场：`core/transitionTarget.buildTransitionOps` + `resolveDuration`（时长夹取）
 * - 合并 ops 一次 dispatch = **单个撤销步**
 *
 * 本文件纯函数（不碰 store），Node 可单测。
 */
import type { ClipOperation, Project } from './types';
import { buildNewTextOps } from './textClip';
import { textPresetById, presetToText } from './textPresets';
import { EFFECT_PRESETS, effectPresetById } from './effectPresets';
import { buildEffectOps } from './effectTarget';
import { buildTransitionOps, resolveDuration } from './transitionTarget';
import { transitionPresetById } from './transitionPresets';
import { applyOperation } from './operations';

/** 文字落点基准：开场=工程 0 帧；结尾=时间线末尾；展示=播放头（用户拍板：按模板类型差异化）。 */
export type TemplateAnchor = 'start' | 'end' | 'playhead';

export interface TemplateTextSpec {
  /** 引用现有文字样式预设（`textPresets.TEXT_PRESETS` 的 id）——不新造样式。 */
  presetId: string;
  /** 模板自己的文案（不填用预设默认文案）。 */
  content: string;
  /** 相对锚点的帧偏移。 */
  offsetFrames: number;
}

export interface ProjectTemplate {
  id: string;
  /** 全中文显示名（chips 上直接用）。 */
  name: string;
  anchor: TemplateAnchor;
  texts: TemplateTextSpec[];
  /** 特效预设 id（null = 本模板不带特效）。挂在目标视频片段上。 */
  effectId: string | null;
  /** 转场（null = 不带）：目标片段的入场或出场。 */
  transition: { presetId: string; side: 'in' | 'out' } | null;
  /** 目标片段选择：开场类=首个视频片段；结尾类=末个。 */
  target: 'first-video' | 'last-video';
}

export const PROJECT_TEMPLATES: readonly ProjectTemplate[] = [
  {
    id: 'tpl-vlog-open',
    name: 'Vlog 开场',
    anchor: 'start',
    texts: [
      { presetId: 'tpl-title-main', content: '这里是你的标题', offsetFrames: 0 },
      { presetId: 'tpl-title-sub', content: '日期 · 地点 · 一句话', offsetFrames: 15 },
    ],
    effectId: 'fx-brighten',
    transition: { presetId: 'trs-fade-in', side: 'in' },
    target: 'first-video',
  },
  {
    id: 'tpl-sci-head',
    name: '知识科普片头',
    anchor: 'start',
    texts: [{ presetId: 'tpl-label-corner', content: '第 1 期 · 主题', offsetFrames: 0 }],
    effectId: 'fx-contrast',
    transition: { presetId: 'trs-fade-in', side: 'in' },
    target: 'first-video',
  },
  {
    id: 'tpl-short-end',
    name: '短视频结尾',
    anchor: 'end',
    texts: [{ presetId: 'tpl-quote-stroke', content: '喜欢的话点个关注', offsetFrames: -30 }],
    effectId: 'fx-warm',
    transition: { presetId: 'trs-fade-out', side: 'out' },
    target: 'last-video',
  },
  {
    id: 'tpl-goods',
    name: '好物展示',
    anchor: 'playhead',
    texts: [{ presetId: 'tpl-caption-bottom', content: '好物名称 · 一句话卖点', offsetFrames: 0 }],
    effectId: 'fx-soft',
    transition: { presetId: 'trs-fade-in', side: 'in' },
    target: 'first-video',
  },
];

export interface TemplateApply {
  ops: ClipOperation[];
  /** 给用户看的一句话（套用了什么/降级了什么）。 */
  summary: string;
  /** 降级说明（无视频片段时特效/转场未套）。 */
  notes: string[];
}

/** 时间线末尾（所有片段 end 的最大值；空工程 = 0）。 */
function timelineEndFrame(doc: Project): number {
  let end = 0;
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      const clipEnd = clip.startFrame + clip.durationFrames;
      if (clipEnd > end) end = clipEnd;
    }
  }
  return end;
}

/** 目标视频片段（非文字；按 target 取首/末）。 */
function targetVideoClip(doc: Project, target: 'first-video' | 'last-video'): import('./types').Clip | null {
  const videoClips = doc.tracks
    .filter((track) => track.kind === 'video')
    .flatMap((track) => track.clips)
    .filter((clip) => clip.text === null || clip.text === undefined);
  if (videoClips.length === 0) return null;
  return target === 'first-video' ? videoClips[0] ?? null : videoClips[videoClips.length - 1] ?? null;
}

/** 锚点帧。 */
function anchorFrame(doc: Project, anchor: TemplateAnchor): number {
  if (anchor === 'start') return 0;
  if (anchor === 'end') return timelineEndFrame(doc);
  return Math.max(0, doc.playheadFrame);
}

/**
 * 编译模板 → 操作数组（不 dispatch，调用方一次提交 = 单撤销步）。
 *
 * 多段文字/特效/转场之间存在依赖（第二段文字的建轨要看到第一段的结果），所以
 * 逐件构建并 `applyOperation` 累进模拟——与 `compileIntents` 的串行叠加同一手法。
 */
export function buildTemplateOps(doc: Project, template: ProjectTemplate): TemplateApply {
  const ops: ClipOperation[] = [];
  const notes: string[] = [];
  let sim = doc;
  const size = { width: doc.width, height: doc.height };

  // ---- 文字（永远落：降级场景也保留）----
  for (const spec of template.texts) {
    const preset = textPresetById(spec.presetId);
    if (preset === null) continue;
    const text = presetToText(preset, spec.content, size);
    const start = Math.max(0, anchorFrame(sim, template.anchor) + spec.offsetFrames);
    const plan = buildNewTextOps(sim, start, text);
    for (const op of plan.ops) {
      ops.push(op);
      sim = applyOperation(sim, op);
    }
  }

  // ---- 特效 + 转场（挂在目标视频片段上；无片段则降级）----
  const target = targetVideoClip(sim, template.target);
  if (target === null) {
    if (template.effectId !== null || template.transition !== null) {
      notes.push('当前工程没有视频片段：模板的文字已添加，特效与转场会在有素材后再次套用时应用');
    }
  } else {
    if (template.effectId !== null) {
      const preset = effectPresetById(template.effectId);
      if (preset !== null) {
        const effectOps = buildEffectOps(target, preset);
        for (const op of effectOps) {
          ops.push(op);
          sim = applyOperation(sim, op);
        }
      }
    }
    if (template.transition !== null) {
      const preset = transitionPresetById(template.transition.presetId);
      if (preset !== null) {
        const side = template.transition.side;
        const durationFrames = resolveDuration(0.5, target, sim.fpsMilli);
        const next = { type: preset.type, durationFrames } as const;
        const transitionOps = buildTransitionOps(target, side, next);
        for (const op of transitionOps) {
          ops.push(op);
          sim = applyOperation(sim, op);
        }
      }
    }
  }

  const textCount = template.texts.length;
  const summary =
    notes.length > 0
      ? `套用「${template.name}」（文字 ${textCount} 条；特效转场待有素材后补充）`
      : `套用「${template.name}」（文字 ${textCount} 条 + 特效转场）`;
  return { ops, summary, notes };
}

void EFFECT_PRESETS;
