/**
 * 批量操作的**动作层**：把 `core/captions` 的纯函数包成"一次 dispatch"。
 *
 * ## 为什么单独一层
 *
 * `core/captions.ts` 只负责「给定 doc 算出一批 op」；这一层负责「取最新 clip、调纯函数、
 * 一次 dispatch、把失败翻成中文」。UI（`BatchBar`）只调这里，不直接碰 store。
 *
 * 这样 batch 的规则也只有一份：以后加"批量改对齐"之类，改这里就行。
 *
 * ## 每个动作都保证「一个撤销步」
 *
 * 所有纯函数返回的是 `ClipOperation[]`，这里把它们（以及多片段时的多组）**拼成一个数组**
 * 再 dispatch 一次。E2E 用"按一次 Ctrl+Z 是否全部还原"来验，不是数 op 条数。
 *
 * ## 失败一律转中文
 *
 * `buildShiftOps` / `buildMergeOps` 会拒绝非法操作（越界、跨轨、压到别人），
 * 它们的 `error.message` 本来就是中文，直接透传；不在这里再造一套措辞。
 */
import { store } from '../../core/store';
import type { Clip, ClipOperation, TextContent } from '../../core/types';
import {
  buildBatchStyleOps,
  buildDeleteOps,
  buildMergeOps,
  buildShiftOps,
  buildTemplateOps,
} from '../../core/captions';
import { buildPresetOps } from '../../core/preset';
import type { Preset } from '../../core/preset';
import type { TextPreset } from '../../core/textPresets';

export interface BatchOutcome {
  ok: boolean;
  /** 成功时给用户看的一句话；失败时是中文原因（已 pushError 的这里也带一份便于内联显示）。 */
  message: string;
}

/** 批量删除（≥1 条）。 */
export function batchDelete(clips: readonly Clip[]): BatchOutcome {
  if (clips.length === 0) return { ok: false, message: '没有选中字幕' };
  const ops = buildDeleteOps(clips);
  if (ops.length === 0) return { ok: false, message: '没有可删除的字幕' };
  store.dispatch(ops, `删除字幕（${clips.length} 条）`);
  return { ok: true, message: `已删除 ${clips.length} 条字幕` };
}

/**
 * 批量平移（只挪起点、不改时长）。
 *
 * `deltaFrames` 正数后移、负数前移；越界/非法由 `buildShiftOps` 拒绝。
 */
export function batchShift(clips: readonly Clip[], deltaFrames: number): BatchOutcome {
  if (clips.length === 0) return { ok: false, message: '没有选中字幕' };
  const result = buildShiftOps(clips, deltaFrames, store.getDoc());
  if (!result.ok) {
    store.pushError(result.error);
    return { ok: false, message: result.error.message };
  }
  if (result.value.length === 0) return { ok: true, message: '位置没有变化' };
  const rounded = Math.round(deltaFrames);
  const direction = rounded > 0 ? '后移' : '前移';
  store.dispatch(result.value, `平移字幕（${direction} ${Math.abs(rounded)} 帧）`);
  return { ok: true, message: `已${direction} ${Math.abs(rounded)} 帧` };
}

/** 合并（≥2 条、同轨、不压到未选中的字幕）。 */
export function batchMerge(clips: readonly Clip[]): BatchOutcome {
  if (clips.length < 2) return { ok: false, message: '至少选两条才能合并' };
  const result = buildMergeOps(clips, store.getDoc());
  if (!result.ok) {
    store.pushError(result.error);
    return { ok: false, message: result.error.message };
  }
  store.dispatch(result.value, `合并字幕（${clips.length} 条）`);
  return { ok: true, message: `已合并 ${clips.length} 条字幕` };
}

/** 批量改样式字段（只改 patch 里带的，其余沿用各条自己的值）。 */
export function batchStyle(clips: readonly Clip[], patch: Partial<TextContent>): BatchOutcome {
  if (clips.length === 0) return { ok: false, message: '没有选中字幕' };
  const ops = buildBatchStyleOps(clips, patch);
  if (ops.length === 0) return { ok: false, message: '没有可修改的字幕' };
  store.dispatch(ops, `修改字幕样式（${clips.length} 条）`);
  return { ok: true, message: `已修改 ${clips.length} 条样式` };
}

/**
 * 批量套用**模板库**（10 个内置模板）。
 *
 * 保留每条自己的文本与 `origin`（见 `buildTemplateOps` 的注释：
 * `presetToText` 默认会把 origin 写成 manual，不显式带回就会冲掉 AI 角标）。
 */
export function batchTemplate(
  clips: readonly Clip[],
  preset: TextPreset,
  size: { width: number; height: number },
): BatchOutcome {
  if (clips.length === 0) return { ok: false, message: '没有选中字幕' };
  const ops = buildTemplateOps(clips, preset, size);
  if (ops.length === 0) return { ok: false, message: '没有可修改的字幕' };
  store.dispatch(ops, `套用模板「${preset.name}」（${clips.length} 条）`);
  return { ok: true, message: `已套用「${preset.name}」到 ${clips.length} 条` };
}

/** 批量套用**我的预设**（`core/preset.buildPresetOps` 已处理"保留内容"）。 */
export function batchPreset(clips: readonly Clip[], preset: Preset): BatchOutcome {
  if (clips.length === 0) return { ok: false, message: '没有选中字幕' };
  const ops: ClipOperation[] = [];
  for (const clip of clips) ops.push(...buildPresetOps(clip, preset));
  if (ops.length === 0) return { ok: false, message: '这个预设没有可套用的样式' };
  store.dispatch(ops, `套用预设「${preset.name}」（${clips.length} 条）`);
  return { ok: true, message: `已套用「${preset.name}」到 ${clips.length} 条` };
}

/** 格式刷要复制的字段（**不含 content / origin**——文案和来源不该被刷掉）。 */
const STYLE_FIELDS = [
  'fontSize',
  'color',
  'align',
  'background',
  'bold',
  'stroke',
  'x',
  'y',
] as const;

/**
 * 「同主选样式」= 格式刷：把**源片段**的样式刷给其余选中项。
 *
 * 为什么刷位置（x/y）：用户说"同主选样式"时，期待的是"长得一样"——
 * 只刷字号不刷位置，一堆字幕会字号统一但各自错位，看起来像没生效。
 * 但**文案和来源绝不刷**（那是内容，不是样式）。
 */
export function batchSameStyleAs(
  clips: readonly Clip[],
  source: Clip,
): BatchOutcome {
  if (source.text === null || source.text === undefined) {
    return { ok: false, message: '主选片段不是文字/字幕' };
  }
  const targets = clips.filter((clip) => clip.id !== source.id);
  if (targets.length === 0) return { ok: false, message: '除了主选，没有其它选中的字幕' };

  const patch: Partial<TextContent> = {};
  for (const field of STYLE_FIELDS) {
    const value = source.text[field];
    if (value !== undefined) {
      // 逐字段赋值的类型收窄在 TS 里不好做，用一次断言；字段名来自上面的白名单，安全
      (patch as Record<string, unknown>)[field] = value;
    }
  }
  const ops = buildBatchStyleOps(targets, patch);
  if (ops.length === 0) return { ok: false, message: '没有可同步的字幕' };
  store.dispatch(ops, `同步主选样式（${targets.length} 条）`);
  return { ok: true, message: `已把主选样式同步到 ${targets.length} 条` };
}
