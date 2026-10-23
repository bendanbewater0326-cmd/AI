/**
 * 调节的写入层：把「改调色 / 曲线 / LUT / 蒙版」收敛成**一处实现**。
 *
 * ## 为什么要有这个文件
 *
 * 属性栏（`InspectorPanel`）和左栏「调节」面板（`ui/adjust/AdjustPanel`）都要写这四类效果。
 * 如果各写一份 `commitGrade`，就会出现本项目最典型的 bug 类型：
 * **同一条规则有两个定义点**（见 MEMORY「最重要的两课」第 2 条）。
 * 所以四个写入函数全部收敛到这里，UI 只负责取值和展示。
 *
 * ## 三条必须遵守的规则（都是踩过的）
 *
 * 1. **每次都从 doc 取最新 clip**，不要用调用方持有的对象。
 *    属性栏曾经因为只订阅选中态、拿着过期 clip，出现"设了淡入再设淡出，淡入没被清掉"。
 * 2. **`setClipEffect` 是同类型替换**（先删旧再写新）：一次 dispatch = 一个撤销步。
 * 3. **蒙版必须保留 `current.keyframes`**：参数细调不能把用户手动打的关键帧（手动跟踪）抹掉。
 *    另外 `invert` 在 params 里存 **1/0**，`maskOf` 判的是 `=== 1`（boolean 会被静默当 false）。
 */
import type { Clip, ClipOperation, Effect } from './types';
import { createId } from './types';
import { store } from './store';
import type { ColorGrade } from '../render/compositor';
import { NEUTRAL_CURVE, curveOf } from '../render/curve';
import type { CurveParams } from '../render/curve';
import { DEFAULT_MASK, MASK_EFFECT, maskOf } from '../render/mask';
import type { MaskParams } from '../render/mask';
import { LUT_EFFECT, parseCube } from '../render/lut';
import { makeError } from './types';

export const GRADE_EFFECT = 'colorGrade';
export const CURVE_EFFECT = 'curve';
export { LUT_EFFECT, MASK_EFFECT };

/** 调色的中性值（全 0 = 不加调色）。 */
export const NEUTRAL_GRADE: ColorGrade = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
};

/**
 * 从 doc 里取**最新**的 clip。
 *
 * 调用方（属性栏 / 调节面板）手里的 clip 可能已经过期（doc 变了但组件还没重渲染）。
 * 所有写入都从 doc 现场查，避免把基于旧值的操作提交上去。
 */
export function latestClip(clipId: string): Clip | null {
  for (const track of store.getDoc().tracks) {
    const found = track.clips.find((clip) => clip.id === clipId);
    if (found !== undefined) return found;
  }
  return null;
}

/** 取某片段上的某类效果（不要求 enabled：重置/替换都要看原始那条）。 */
function effectOf(clip: Clip, effectType: string): Effect | null {
  return clip.effects.find((effect) => effect.type === effectType) ?? null;
}

/** 读调色（没有则中性值）。**总是返回完整 4 参数**，UI 不必处理缺字段。 */
export function readGrade(clip: Clip): ColorGrade {
  const effect = effectOf(clip, GRADE_EFFECT);
  if (effect === null) return { ...NEUTRAL_GRADE };
  const num = (key: keyof ColorGrade): number => {
    const raw = effect.params[key];
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  };
  return {
    brightness: num('brightness'),
    contrast: num('contrast'),
    saturation: num('saturation'),
    temperature: num('temperature'),
  };
}

/** 读曲线（没有则中性）。 */
export function readCurve(clip: Clip): CurveParams {
  return curveOf(clip) ?? { ...NEUTRAL_CURVE };
}

/** 读 LUT 状态：没载入时 `cube` 为空串。 */
export function readLut(clip: Clip): { title: string; strength: number; loaded: boolean } {
  const effect = effectOf(clip, LUT_EFFECT);
  if (effect === null) return { title: '', strength: 1, loaded: false };
  const cube = effect.params['cube'];
  const rawTitle = effect.params['title'];
  const rawStrength = effect.params['strength'];
  return {
    title: typeof rawTitle === 'string' && rawTitle !== '' ? rawTitle : '已加载',
    strength: typeof rawStrength === 'number' ? Math.min(1, Math.max(0, rawStrength)) : 1,
    loaded: typeof cube === 'string' && cube !== '',
  };
}

/** 读蒙版（没有则 null —— 与属性栏一致："null = 这个片段没有蒙版"）。 */
export function readMask(clip: Clip, offsetFrames = 0): MaskParams | null {
  return maskOf(clip, offsetFrames);
}

/* ---------------- 纯构造函数（供单测，不碰 store） ---------------- */

/**
 * 构造一条调色效果。
 *
 * **为什么单独导出纯函数**：单测用的是 `createStore()` 的独立实例，
 * 而 `applyGrade` 依赖模块级全局 store（生产正确、测试无法注入）。
 * 把"构造 effect"与"dispatch"分开后，单测能直接验证 params 的完整性
 * （尤其是"4 个参数必须齐全"和"同类型只有一条"这两条），不必搭 store。
 */
export function buildGradeEffect(clip: Clip, patch: Partial<ColorGrade>): Effect {
  const current = effectOf(clip, GRADE_EFFECT);
  const next = { ...readGrade(clip), ...patch };
  return {
    id: current?.id ?? createId('fx'),
    clipId: clip.id,
    type: GRADE_EFFECT,
    params: { brightness: next.brightness, contrast: next.contrast, saturation: next.saturation, temperature: next.temperature },
    keyframes: [],
    enabled: true,
    order: 0,
    source: 'ui',
  };
}

/** 构造一条曲线效果（x1/x2 固定 0.25/0.75，只改 y —— 与属性栏一致）。 */
export function buildCurveEffect(clip: Clip, patch: Partial<CurveParams>): Effect {
  const current = effectOf(clip, CURVE_EFFECT);
  const next = { ...readCurve(clip), ...patch };
  return {
    id: current?.id ?? createId('fx'),
    clipId: clip.id,
    type: CURVE_EFFECT,
    params: { x1: next.x1, y1: next.y1, x2: next.x2, y2: next.y2 },
    keyframes: [],
    enabled: true,
    order: 0,
    source: 'ui',
  };
}

/**
 * 构造一条蒙版效果。
 *
 * 两条硬规则：
 * 1. **保留 `current.keyframes`** —— 细调参数不能抹掉用户手动打的关键帧；
 * 2. **`invert` 存 1/0** —— `maskOf` 判的是 `params['invert'] === 1`，boolean 会被静默当 false。
 */
export function buildMaskEffect(clip: Clip, patch: Partial<MaskParams>): Effect {
  const current = effectOf(clip, MASK_EFFECT);
  const base = readMask(clip) ?? DEFAULT_MASK;
  const next = { ...base, ...patch };
  return {
    id: current?.id ?? createId('fx'),
    clipId: clip.id,
    type: MASK_EFFECT,
    params: {
      shape: next.shape,
      x: next.x,
      y: next.y,
      w: next.w,
      h: next.h,
      feather: next.feather,
      invert: next.invert ? 1 : 0,
    },
    keyframes: current?.keyframes ?? [],
    enabled: true,
    order: current?.order ?? 0,
    source: 'ui',
  };
}

/** 构造 LUT 强度变更后的效果（保留 cube 原文与其它 params）。 */
export function buildLutStrengthEffect(clip: Clip, strength: number): Effect | null {
  const current = effectOf(clip, LUT_EFFECT);
  if (current === null) return null;
  const clamped = Math.min(1, Math.max(0, strength));
  return { ...current, params: { ...current.params, strength: clamped } };
}

/** 统一的单效果写入：`to: null` 表示删除。 */
function writeEffect(
  clipId: string,
  effectType: string,
  from: Effect | null,
  to: Effect | null,
  label: string,
): void {
  const op: ClipOperation = { op: 'setClipEffect', clipId, effectType, from, to };
  store.dispatch([op], label);
}

/** 改调色（`patch` 只需带被改的字段，其余沿用当前值）。 */
export function applyGrade(clipId: string, patch: Partial<ColorGrade>, label = '调整调色'): void {
  const clip = latestClip(clipId);
  if (clip === null) return;
  const current = effectOf(clip, GRADE_EFFECT);
  const next = buildGradeEffect(clip, patch);
  // **值真的变了才 dispatch**：UI 侧无法可靠判断（它的 value 是显示值，拖动中已被改），
  // 所以"是否产生撤销步"统一由这里决定 —— 单一判断点，避免两处规则不一致。
  if (current !== null && gradeParamsEqual(current.params, next.params)) return;
  writeEffect(clipId, GRADE_EFFECT, current, next, label);
}

/** 两份调色 params 是否完全相等（无 current 时不比较）。 */
function gradeParamsEqual(left: Record<string, number | string>, right: Record<string, number | string>): boolean {
  return (
    left['brightness'] === right['brightness'] &&
    left['contrast'] === right['contrast'] &&
    left['saturation'] === right['saturation'] &&
    left['temperature'] === right['temperature']
  );
}

/** 重置调色 = **删除 effect**（比写全 0 更干净：不会留一条"全中性但存在"的效果）。 */
export function resetGrade(clipId: string): void {
  const clip = latestClip(clipId);
  if (clip === null) return;
  const current = effectOf(clip, GRADE_EFFECT);
  if (current === null) return;
  writeEffect(clipId, GRADE_EFFECT, current, null, '重置调色');
}

/** 改曲线（x 固定 0.25/0.75，只调暗部/亮部的 y —— 与属性栏一致）。 */
export function applyCurve(clipId: string, patch: Partial<CurveParams>, label = '调整曲线'): void {
  const clip = latestClip(clipId);
  if (clip === null) return;
  const current = effectOf(clip, CURVE_EFFECT);
  const next = buildCurveEffect(clip, patch);
  if (current !== null && curveParamsEqual(current.params, next.params)) return;
  writeEffect(clipId, CURVE_EFFECT, current, next, label);
}

function curveParamsEqual(left: Record<string, number | string>, right: Record<string, number | string>): boolean {
  return left['x1'] === right['x1'] && left['y1'] === right['y1'] && left['x2'] === right['x2'] && left['y2'] === right['y2'];
}

/** 重置曲线 = 删除 effect。 */
export function resetCurve(clipId: string): void {
  const clip = latestClip(clipId);
  if (clip === null) return;
  const current = effectOf(clip, CURVE_EFFECT);
  if (current === null) return;
  writeEffect(clipId, CURVE_EFFECT, current, null, '重置曲线');
}

/** 改 LUT 强度（未载入时无效 —— 没有 cube 的 LUT 效果没有意义）。 */
export function applyLutStrength(clipId: string, strength: number, label = '调整 LUT 强度'): void {
  const clip = latestClip(clipId);
  if (clip === null) return;
  const current = effectOf(clip, LUT_EFFECT);
  if (current === null) return;
  const to = buildLutStrengthEffect(clip, strength);
  if (to === null) return;
  store.dispatch([{ op: 'setClipEffect', clipId, effectType: LUT_EFFECT, from: current, to }], label);
}

/**
 * 载入 .cube（原文存进 params，工程文件自带，换机器也能用）。
 * @returns 成功时的标题；失败已 pushError 并返回 null。
 */
export async function applyLutFile(clipId: string, file: File): Promise<string | null> {
  const clip = latestClip(clipId);
  if (clip === null) return null;
  const text = await file.text();
  const parsed = parseCube(text);
  if (!parsed.ok) {
    store.pushError(parsed.error);
    return null;
  }
  const current = effectOf(clip, LUT_EFFECT);
  const title = parsed.value.title || file.name;
  const strength = readLut(clip).strength;
  writeEffect(
    clipId,
    LUT_EFFECT,
    current,
    {
      id: current?.id ?? createId('fx'),
      clipId,
      type: LUT_EFFECT,
      params: { cube: text, strength, title },
      keyframes: [],
      enabled: true,
      order: 0,
      source: 'ui',
    },
    '载入 LUT',
  );
  return title;
}

/** 移除 LUT。 */
export function removeLut(clipId: string): void {
  const clip = latestClip(clipId);
  if (clip === null) return;
  const current = effectOf(clip, LUT_EFFECT);
  if (current === null) return;
  writeEffect(clipId, LUT_EFFECT, current, null, '移除 LUT');
}

/**
 * 改蒙版参数。
 *
 * **保留 `current?.keyframes`**：用户可能已经手动打过跟踪关键帧，细调参数不能把它们抹掉。
 * `invert` 存 1/0（`maskOf` 判 `=== 1`）。
 */
export function applyMask(
  clipId: string,
  patch: Partial<MaskParams>,
  label = '调整蒙版',
): void {
  const clip = latestClip(clipId);
  if (clip === null) return;
  const current = effectOf(clip, MASK_EFFECT);
  writeEffect(clipId, MASK_EFFECT, current, buildMaskEffect(clip, patch), label);
}

/** 移除蒙版。 */
export function removeMask(clipId: string): void {
  const clip = latestClip(clipId);
  if (clip === null) return;
  const current = effectOf(clip, MASK_EFFECT);
  if (current === null) return;
  writeEffect(clipId, MASK_EFFECT, current, null, '移除蒙版');
}

/** 添加蒙版（默认矩形正中 50%）。已存在时无操作。 */
export function addMask(clipId: string): void {
  const clip = latestClip(clipId);
  if (clip === null) return;
  if (effectOf(clip, MASK_EFFECT) !== null) return;
  applyMask(clipId, { ...DEFAULT_MASK }, '添加蒙版');
}

/** 供 UI 展示的时间线提示：目标片段不存在时给一句人话（不要静默失败）。 */
export function assertClipExists(clipId: string | null): boolean {
  if (clipId === null) {
    store.pushError(makeError('E_INVALID_TIMECODE', '请先选中一个片段（或把播放头移到片段上）'));
    return false;
  }
  if (latestClip(clipId) === null) {
    store.pushError(makeError('E_ASSET_OFFLINE', '片段不存在（可能已被删除）'));
    return false;
  }
  return true;
}
