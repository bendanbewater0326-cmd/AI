/**
 * 画面特效的落点与操作构造（纯函数）。
 *
 * ## 三条规则收敛在这里
 *
 * 1. **落点是"整块片段"**，不是帧、也不是接缝 —— 特效挂在片段上，没有时间跨度。
 *    所以"选中片段优先，否则取播放头所在片段"，音频片段与文字片段要拒绝。
 * 2. **`setClipEffect` 是同类型单例**（`operations.ts` 先 filter 掉同类型再加），
 *    所以"应用第二个特效"是**替换**不是叠加。`buildEffectOps` 把这件事显式化：
 *    已经是要设的值就返回空数组（不发无用撤销步）。
 * 3. **「原片」= 删除 effect**，不是"写四个 0 的 effect"。写 0 虽然画面上等价，
 *    但 `clip.effects` 里会留一条"看起来有特效"的空记录，属性栏也会显示一个空调色。
 *
 * 做成纯函数就能在 Node 里穷举边界（`tests/effect-presets.test.mjs`）。
 */
import type { Clip, ClipOperation, Frame, Project } from './types';
import { createId } from './types';
import type { ColorGrade } from '../render/compositor';
import type { EffectPreset } from './effectPresets';
import { EFFECT_PRESETS, ORIGINAL_PRESET, isOriginalPreset } from './effectPresets';

/**
 * `clip.effects` 里调色的类型名。
 *
 * 这个字符串在 `core/preset`、`media/playbackEngine`、`ui/InspectorPanel` 里都是字面量，
 * 这里给个常量供新代码使用（老代码不动，避免无意义的 diff）。
 */
export const GRADE_EFFECT = 'colorGrade';

/** 取片段上**生效中**的调色（null = 没加特效）。 */
export function currentGrade(clip: Clip): ColorGrade | null {
  const effect = clip.effects.find((item) => item.type === GRADE_EFFECT && item.enabled);
  if (effect === undefined) return null;
  const num = (key: string): number => {
    const raw = effect.params[key];
    const value = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(value) ? value : 0;
  };
  return {
    brightness: num('brightness'),
    contrast: num('contrast'),
    saturation: num('saturation'),
    temperature: num('temperature'),
  };
}

/** 四个参数是否完全相等（"这个预设已经应用过了"的判据）。 */
export function gradeEquals(left: ColorGrade, right: ColorGrade): boolean {
  return (
    left.brightness === right.brightness &&
    left.contrast === right.contrast &&
    left.saturation === right.saturation &&
    left.temperature === right.temperature
  );
}

/**
 * 片段当前对应的预设 id。
 *
 * - 没有调色 → `fx-original`（原片本来就是"什么都不加"）
 * - 参数正好等于某个预设 → 那个预设
 * - 都不匹配（用户在属性栏手调过）→ 空串，卡片一个都不高亮
 *
 * 返回**字符串**而不是对象：面板用 `useDoc` 订阅，返回新对象会让
 * `useSyncExternalStore` 认为"一直在变"（无限重渲染）。
 */
export function appliedPresetId(grade: ColorGrade | null): string {
  if (grade === null) return ORIGINAL_PRESET.id;
  const hit = EFFECT_PRESETS.find((preset) => !isOriginalPreset(preset) && gradeEquals(preset.params, grade));
  return hit?.id ?? '';
}

export interface EffectTarget {
  clip: Clip;
  trackId: string;
}

/** 文字片段 / 音频片段不能加画面特效（原因见下方注释）。 */
function reject(clip: Clip): { message: string } | null {
  if (clip.text !== null && clip.text !== undefined) {
    // 属性栏里"调色"整块被 `!isText` 包着 —— 文字片段加得上、却没有任何控件能去掉它。
    // 与其留一个"加了去不掉"的状态，不如直接拒绝并说清楚。
    return { message: '文字片段不支持画面特效（调色只对视频片段开放）' };
  }
  if (clip.role === 'audio') {
    return { message: '这是音频片段，画面特效加不上去' };
  }
  return null;
}

/**
 * 落点：**选中的片段优先**，没选中就用播放头所在的片段。
 *
 * `playhead` 由调用方传（点击时是播放头，拖拽时是鼠标换算的帧），
 * 面板与拖拽共用这一份规则。
 */
export function resolveEffectTarget(
  doc: Project,
  selectedClipId: string | null,
  playhead: Frame,
): EffectTarget | { message: string } {
  if (selectedClipId !== null) {
    for (const track of doc.tracks) {
      const hit = track.clips.find((clip) => clip.id === selectedClipId);
      if (hit !== undefined) {
        const why = reject(hit);
        if (why !== null) return why;
        return { clip: hit, trackId: track.id };
      }
    }
  }
  /**
   * 没选中时按播放头找：**跳过不能加特效的片段继续往下找**，而不是立刻报错。
   *
   * 文字片段通常压在视频上面，播放头停在字幕上时如果直接返回"文字片段不支持"，
   * 用户会觉得"明明有一段视频在那儿，为什么不让加"。只有整条时间线都找不到
   * 能加的片段时，才把第一次遇到的原因说出来（比"先选中一个片段"更具体）。
   */
  let blocked: string | null = null;
  for (const track of doc.tracks) {
    // 音频轨没有画面
    if (track.kind === 'audio') continue;
    for (const clip of track.clips) {
      if (playhead < clip.startFrame) continue;
      if (playhead >= clip.startFrame + clip.durationFrames) continue;
      const why = reject(clip);
      if (why !== null) {
        blocked = blocked ?? why.message;
        continue;
      }
      return { clip, trackId: track.id };
    }
  }
  return { message: blocked ?? '先选中一个片段，或把播放头移到片段上' };
}

/**
 * 构造"应用这个预设"的操作。
 *
 * 返回空数组的两种情况（都不该产生撤销步）：
 * - 点「原片」而片段本来就没有特效；
 * - 点的预设与当前参数完全一致。
 */
export function buildEffectOps(clip: Clip, preset: EffectPreset): ClipOperation[] {
  const from = clip.effects.find((item) => item.type === GRADE_EFFECT) ?? null;

  if (isOriginalPreset(preset)) {
    if (from === null) return [];
    return [{ op: 'setClipEffect', clipId: clip.id, effectType: GRADE_EFFECT, from, to: null }];
  }

  const current = currentGrade(clip);
  if (current !== null && gradeEquals(current, preset.params)) return [];

  const next = {
    // 复用原 effect 的 id：属性栏/关键帧都按 id 关联，换新 id 会让它们"跟丢"
    id: from?.id ?? createId('fx'),
    clipId: clip.id,
    type: GRADE_EFFECT,
    params: { ...preset.params },
    keyframes: [],
    enabled: true,
    order: 0,
    source: 'ui' as const,
  };
  return [{ op: 'setClipEffect', clipId: clip.id, effectType: GRADE_EFFECT, from, to: next }];
}
