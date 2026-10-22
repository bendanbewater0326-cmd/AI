/**
 * 右属性栏（T14）：4 项片段属性（缩放/位置/不透明度/混合）。
 *
 * ## 交互语义
 *
 * - 未选中：4 项 `disabled` + 标签保留（R-014）。
 * - 选中：值反映 `clip.transform` 真实值（R-027）。
 * - 连续拖动（缩放/不透明度滑块）：**拖动期间只更新本地显示**（不 dispatch，避免 React
 *   每帧重渲染），`onPointerUp` 才 `dispatch` 一次 → 预览 1 帧内变化 + **1 个撤销步**（T14 ④）。
 * - 离散控件（位置数字框 / 混合下拉）：`onChange` 立即 dispatch（低频，无所谓重渲染）。
 * - 越界不接受：滑块 `min/max` 硬约束，数字框越界回退原值（R-028 ③）。
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { BlendMode, Clip, ClipOperation, Effect, TextContent, Transition } from '../core/types';
import { createId, normalizeRotation } from '../core/types';
import { framesPerSecond, secondsToFrames } from '../core/timebase';
import {
  VOLUME_MAX_POSITION,
  VOLUME_UNITY_POSITION,
  formatDb,
  formatPercent,
  gainToPosition,
  positionToDb,
  positionToGain,
} from '../core/volume';
import type { ColorGrade } from '../render/compositor';
import { store, useDoc, useFrame, useSelection } from '../core/store';
import { buildPresetOps, capturePreset, createPreset, MAX_PRESET_NAME } from '../core/preset';
import { buildTransitionOps, resolveDuration } from '../core/transitionTarget';
import type { Preset } from '../core/preset';
import { PRESETS_CHANGED, addPreset, loadPresets, removePreset } from '../persist/presets';
import { DEFAULT_DENOISE, denoiseOf } from '../media/denoise';
import type { DenoiseParams } from '../media/denoise';
import { curveOf, NEUTRAL_CURVE } from '../render/curve';
import type { CurveParams } from '../render/curve';
import { LUT_EFFECT, parseCube } from '../render/lut';
import { DEFAULT_MASK, MASK_EFFECT, maskOf } from '../render/mask';
import type { MaskParams, MaskShape } from '../render/mask';
import {
  ANIMATABLE_PROPERTIES,
  keyframeAt,
  keyframesFor,
  sampleKeyframes,
  staticValueOf,
} from '../core/keyframes';
import type { AnimatableProperty } from '../core/keyframes';

const BLEND_MODES: ReadonlyArray<{ value: BlendMode; label: string }> = [
  { value: 'normal', label: '正常' },
  { value: 'overlay', label: '叠加' },
  { value: 'screen', label: '滤色' },
  { value: 'multiply', label: '正片叠底' },
];

function findClipIn(doc: import('../core/types').Project, clipId: string): Clip | null {
  for (const track of doc.tracks) {
    const clip = track.clips.find((item) => item.id === clipId);
    if (clip !== undefined) return clip;
  }
  return null;
}

/** 构造 setClipProps 操作（含 from/to）。 */
function setProp(clip: Clip, path: string, value: unknown): ClipOperation {
  return { op: 'setClipProps', clipId: clip.id, path, from: readPath(clip, path), to: value };
}

/** 取片段上的调色效果（没有则 null）。 */
function gradeEffectOf(clip: Clip): Effect | null {
  return clip.effects.find((effect) => effect.type === 'colorGrade') ?? null;
}

function gradeOf(clip: Clip): ColorGrade {
  const effect = gradeEffectOf(clip);
  const num = (key: string): number => {
    const raw = effect?.params[key];
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

function readPath(clip: Clip, path: string): unknown {
  let node: unknown = clip;
  for (const key of path.split('.')) {
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

export function InspectorPanel(): ReactElement {
  const selectedClipId = useSelection();
  // 必须订阅 doc：只订阅选中态的话，改完属性（或撤销）后本组件不会重渲染，
  // 手里的 `clip` 还是旧对象——典型症状是"连续设两次转场，第一次的没被清掉"。
  const doc = useDoc((value) => value);
  const playhead = useFrame();
  const clip = selectedClipId === null ? null : findClipIn(doc, selectedClipId);

  // 本地显示值（拖动期间实时更新，松手才写回 doc）
  const [scale, setScale] = useState(1);
  const [opacity, setOpacity] = useState(1);
  const [posX, setPosX] = useState('0');
  const [posY, setPosY] = useState('0');
  const [grade, setGrade] = useState<ColorGrade>({ brightness: 0, contrast: 0, saturation: 0, temperature: 0 });
  /**
   * 音量滑块的位置（0..2），**不是增益**。
   *
   * 位置 → dB → 振幅的换算在 `core/volume` 里（100% = 0dB、200% = +12dB、0% = 静音）。
   * 存进 doc 的仍然是线性振幅（`clip.audio.gain`），这样老工程的声音一点不变。
   */
  const [volume, setVolume] = useState(VOLUME_UNITY_POSITION);
  const [fadeIn, setFadeIn] = useState('0');
  const [fadeOut, setFadeOut] = useState('0');
  const [textDraft, setTextDraft] = useState<TextContent | null>(null);
  const [transitionSeconds, setTransitionSeconds] = useState('0.5');
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetName, setPresetName] = useState('');
  const [denoise, setDenoise] = useState<DenoiseParams>(DEFAULT_DENOISE);
  const [curve, setCurve] = useState<CurveParams>(NEUTRAL_CURVE);
  /** LUT：标题（显示用）+ 强度。原文在 effect.params.cube 里。 */
  const [lutTitle, setLutTitle] = useState('');
  const [lutStrength, setLutStrength] = useState(1);
  /** 蒙版（R-056）：null = 这个片段没有蒙版。参数细调在这里，方位词在命令栏。 */
  const [mask, setMask] = useState<MaskParams | null>(null);
  const [speed, setSpeed] = useState('1');

  // 选中变化时，本地值同步到真实值
  useEffect(() => {
    if (clip === null) return;
    setScale(clip.transform.scale);
    setOpacity(clip.transform.opacity);
    setPosX(String(clip.transform.x));
    setPosY(String(clip.transform.y));
    setGrade(gradeOf(clip));
    setVolume(gainToPosition(clip.audio.gain));
    setTextDraft(clip.text ?? null);
    setDenoise(denoiseOf(clip) ?? DEFAULT_DENOISE);
    setCurve(curveOf(clip) ?? NEUTRAL_CURVE);
    const lutEffect = clip.effects.find((effect) => effect.type === LUT_EFFECT);
    const lutCube = lutEffect?.params['cube'];
    setLutTitle(typeof lutCube === 'string' && lutCube !== '' ? '已加载' : '');
    setLutStrength(typeof lutEffect?.params['strength'] === 'number' ? (lutEffect.params['strength'] as number) : 1);
    const fps = framesPerSecond(store.getDoc().fpsMilli);
    setFadeIn(String(Number((clip.audio.fadeInFrames / Math.max(1, fps)).toFixed(2))));
    setFadeOut(String(Number((clip.audio.fadeOutFrames / Math.max(1, fps)).toFixed(2))));
    const t = clip.transitionOut ?? clip.transitionIn;
    setTransitionSeconds(String(Number((((t?.durationFrames ?? 0) / Math.max(1, fps)) || 0.5).toFixed(2))));
    setSpeed(String(Number(((clip.speedMilli ?? 1000) / 1000).toFixed(2))));
    // 依赖整个 clip（而不是 id）：撤销/重做会换掉 clip 对象但 id 不变，
    // 只盯 id 的话滑块会停在旧值（撤销了调色，滑块还显示 -100）
  }, [clip]); // eslint-disable-line react-hooks/exhaustive-deps

  // 蒙版单独同步：它可能带关键帧（值随播放头变），所以依赖 playhead；
  // 不并进上面那个 effect，否则播放时每帧都要重跑整段同步（调色/文字/转场全被重设）。
  useEffect(() => {
    setMask(clip === null ? null : maskOf(clip, Math.max(0, playhead - clip.startFrame)));
  }, [clip, playhead]);

  function commitScale(next: number): void {
    if (clip === null) return;
    store.dispatch([setProp(clip, 'transform.scale', next)], '修改缩放');
  }
  function commitOpacity(next: number): void {
    if (clip === null) return;
    store.dispatch([setProp(clip, 'transform.opacity', next)], '修改不透明度');
  }
  function commitPos(axis: 'x' | 'y', raw: string): void {
    if (clip === null) return;
    const next = Number.parseInt(raw, 10);
    if (!Number.isInteger(next)) {
      // 非法：回退原值
      setPosX(String(clip.transform.x));
      setPosY(String(clip.transform.y));
      return;
    }
    const path = axis === 'x' ? 'transform.x' : 'transform.y';
    store.dispatch([setProp(clip, path, next)], '修改位置');
  }
  function commitBlend(next: BlendMode): void {
    if (clip === null) return;
    store.dispatch([setProp(clip, 'transform.blendMode', next)], '修改混合模式');
  }

  /**
   * 旋转 90° 步进（`docs/nle-baseline.md` §6：不做任意角度，避免画面外黑边）。
   *
   * 每次都是"在**当前值**上再转 90°"，所以连点四下回到原样——功能不是一次性的。
   */
  function rotateBy(delta: 90 | -90): void {
    if (clip === null) return;
    const from = normalizeRotation(clip.transform.rotation);
    const to = normalizeRotation(from + delta);
    store.dispatch([setProp(clip, 'transform.rotation', to)], delta > 0 ? '向右旋转 90°' : '向左旋转 90°');
  }

  /** 水平/垂直翻转（开关式：再点一次取消）。 */
  function toggleFlip(axis: 'flipX' | 'flipY'): void {
    if (clip === null) return;
    const next = clip.transform[axis] !== true;
    const name = axis === 'flipX' ? '水平翻转' : '垂直翻转';
    store.dispatch([setProp(clip, `transform.${axis}`, next)], next ? name : `取消${name}`);
  }

  /** 画面复位：旋转/翻转/位置/缩放一次回到初始（一个撤销步）。 */
  function resetFrame(): void {
    if (clip === null) return;
    const targets: Array<[string, unknown]> = [
      ['transform.rotation', 0],
      ['transform.flipX', false],
      ['transform.flipY', false],
      ['transform.x', 0],
      ['transform.y', 0],
      ['transform.scale', 1],
    ];
    // 只把**真的会变**的写进操作里：全是默认值时不该产生一个空的撤销步
    const changed = targets.filter(([path, value]) => {
      const current = path === 'transform.rotation' ? normalizeRotation(readPath(clip, path)) : readPath(clip, path);
      return current !== value;
    });
    if (changed.length === 0) return;
    store.dispatch(changed.map(([path, value]) => setProp(clip, path, value)), '还原画面');
  }

  /** 速度提交：接受 0.1–10 的十进制倍数（0.25/0.5/1/2/4），越界或非法回退。 */
  function commitSpeed(raw: string): void {
    if (clip === null) return;
    const factor = Number.parseFloat(raw);
    const current = (clip.speedMilli ?? 1000) / 1000;
    if (!Number.isFinite(factor) || factor < 0.1 || factor > 10) {
      setSpeed(String(Number(current.toFixed(2))));
      return;
    }
    const speedMilli = Math.round(factor * 1000);
    if (speedMilli === (clip.speedMilli ?? 1000)) return;
    store.dispatch(
      [{ op: 'setClipSpeed', clipId: clip.id, from: clip.speedMilli ?? 1000, to: speedMilli }],
      '修改速度',
    );
  }

  function commitGrade(patch: Partial<ColorGrade>): void {
    if (clip === null) return;
    const current = gradeEffectOf(clip);
    const next = { ...gradeOf(clip), ...patch };
    const effect: Effect = {
      id: current?.id ?? createId('fx'),
      clipId: clip.id,
      type: 'colorGrade',
      params: { ...next },
      keyframes: [],
      enabled: true,
      order: 0,
      source: 'ui',
    };
    store.dispatch(
      [{ op: 'setClipEffect', clipId: clip.id, effectType: 'colorGrade', from: current, to: effect }],
      '调整调色',
    );
  }

  function commitAudio(
    patch: { gain?: number; fadeIn?: string; fadeOut?: string },
    options: { mergeKey?: string } = {},
  ): void {
    if (clip === null) return;
    const fps = framesPerSecond(store.getDoc().fpsMilli);
    const ops: ClipOperation[] = [];
    if (patch.gain !== undefined) ops.push(setProp(clip, 'audio.gain', patch.gain));
    if (patch.fadeIn !== undefined) {
      const sec = Math.max(0, Math.min(2, Number(patch.fadeIn) || 0));
      ops.push(setProp(clip, 'audio.fadeInFrames', secondsToFrames(sec, store.getDoc().fpsMilli)));
    }
    if (patch.fadeOut !== undefined) {
      const sec = Math.max(0, Math.min(2, Number(patch.fadeOut) || 0));
      ops.push(setProp(clip, 'audio.fadeOutFrames', secondsToFrames(sec, store.getDoc().fpsMilli)));
    }
    void fps;
    // 音量滑块每 0.05 一步都会调这里：用 mergeKey 合并，一次拖动只占一个撤销步
    if (ops.length > 0) {
      store.dispatch(ops, '调整音量', 'ui', options.mergeKey === undefined ? undefined : { mergeKey: options.mergeKey });
    }
  }

  /** 转场类型切换：同一时刻只保留一侧（入场或出场），避免两条斜坡互相打架。 */
  function commitTransition(type: 'none' | 'crossDissolve' | 'fadeIn' | 'fadeOut', secondsText?: string): void {
    if (clip === null) return;
    const fps = store.getDoc().fpsMilli;
    const seconds = Math.max(0.1, Math.min(2, Number(secondsText ?? transitionSeconds) || 0.5));
    // 时长夹取与"两侧互斥"都收敛在 `core/transitionTarget`：
    // 左栏转场面板调的是同一份，两处各夹一次必然边界不一致（上限是片段时长的一半）
    const durationFrames = resolveDuration(seconds, clip, fps);
    const next: Transition | null = type === 'none' ? null : { type, durationFrames };
    const side: 'in' | 'out' = type === 'fadeOut' ? 'out' : 'in';
    const ops = buildTransitionOps(clip, side, next);
    // 空数组 = 已经是这个转场了（同类型同时长、另一侧也为空），不发无用撤销步
    if (ops.length > 0) store.dispatch(ops, '设置转场');
  }

  /** 在播放头处添加/删除某个属性的关键帧（◆ 实心 = 已打点）。 */
  function toggleKeyframe(property: AnimatableProperty): void {
    if (clip === null) return;
    const offset = playhead - clip.startFrame;
    if (offset < 0 || offset >= clip.durationFrames) return;
    const existing = keyframeAt(clip, property, offset);
    // 旧工程可能没有 keyframes 字段（该字段加入前持久化的），统一按空数组处理
    const current = clip.keyframes ?? [];
    const rest = current.filter(
      (point) => !(point.property === property && point.frame === offset),
    );
    const value =
      sampleKeyframes(keyframesFor(clip, property), offset) ?? staticValueOf(clip, property);
    const next = existing !== null
      ? rest
      : [...rest, { frame: offset, property, value, easing: 'linear' as const }];
    store.dispatch(
      [{ op: 'setClipKeyframes', clipId: clip.id, from: current, to: next }],
      existing !== null ? '删除关键帧' : '添加关键帧',
    );
  }

  function commitText(patch: Partial<TextContent>): void {
    if (clip === null || clip.text === null || clip.text === undefined) return;
    const next: TextContent = { ...clip.text, ...patch };
    store.dispatch([{ op: 'setClipText', clipId: clip.id, from: clip.text, to: next }], '编辑文字');
  }

  /**
   * 预设是用户偏好（存在 settings 里），进面板时读一次。
   * 同时订阅变更广播：左栏「文本」面板也能存/删预设，两边列表要同步。
   */
  useEffect(() => {
    const reload = (): void => {
      void loadPresets().then((list) => setPresets(list));
    };
    reload();
    window.addEventListener(PRESETS_CHANGED, reload);
    return () => window.removeEventListener(PRESETS_CHANGED, reload);
  }, []);

  /** 载入 LUT（R-058）：.cube 原文存进 effect params（工程文件自带，换机器也能用）。 */
  async function loadLutFile(file: File): Promise<void> {
    if (clip === null) return;
    const text = await file.text();
    const parsed = parseCube(text);
    if (!parsed.ok) {
      store.pushError(parsed.error);
      return;
    }
    const current = clip.effects.find((effect) => effect.type === LUT_EFFECT) ?? null;
    store.dispatch(
      [
        {
          op: 'setClipEffect',
          clipId: clip.id,
          effectType: LUT_EFFECT,
          from: current,
          to: {
            id: current?.id ?? createId('fx'),
            clipId: clip.id,
            type: LUT_EFFECT,
            params: { cube: text, strength: lutStrength, title: parsed.value.title || file.name },
            keyframes: [],
            enabled: true,
            order: 0,
            source: 'ui',
          },
        },
      ],
      '载入 LUT',
    );
    setLutTitle(parsed.value.title || file.name);
  }

  /** 调 LUT 强度。 */
  function commitLutStrength(value: number): void {
    if (clip === null) return;
    const current = clip.effects.find((effect) => effect.type === LUT_EFFECT) ?? null;
    if (current === null) return;
    store.dispatch(
      [
        {
          op: 'setClipEffect',
          clipId: clip.id,
          effectType: LUT_EFFECT,
          from: current,
          to: { ...current, params: { ...current.params, strength: value } },
        },
      ],
      '调整 LUT 强度',
    );
  }

  /**
   * 写蒙版参数（R-056）。
   *
   * 两个必须注意的点：
   * 1. **`invert` 存成 1/0**，不是 boolean——`maskOf` 读的是 `params['invert'] === 1`；
   * 2. **保留 `current.keyframes`**：参数细调不能把用户手动打的关键帧（手动跟踪）抹掉。
   */
  function commitMask(patch: Partial<MaskParams>, label: string): void {
    if (clip === null) return;
    const current = clip.effects.find((effect) => effect.type === MASK_EFFECT) ?? null;
    const base = mask ?? DEFAULT_MASK;
    const next = { ...base, ...patch };
    store.dispatch(
      [
        {
          op: 'setClipEffect',
          clipId: clip.id,
          effectType: MASK_EFFECT,
          from: current,
          to: {
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
          },
        },
      ],
      label,
    );
    setMask(next);
  }

  /** 移除蒙版（走 setClipEffect 的 `to: null`，可撤销）。 */
  function removeMask(): void {
    if (clip === null) return;
    const current = clip.effects.find((effect) => effect.type === MASK_EFFECT) ?? null;
    if (current === null) return;
    store.dispatch(
      [{ op: 'setClipEffect', clipId: clip.id, effectType: MASK_EFFECT, from: current, to: null }],
      '移除蒙版',
    );
    setMask(null);
  }

  /** 调曲线（R-055）：x 固定 0.25/0.75，只调暗部/亮部的 y。 */
  function commitCurve(patch: Partial<CurveParams>): void {
    if (clip === null) return;
    const current = clip.effects.find((effect) => effect.type === 'curve') ?? null;
    const next = { ...(curveOf(clip) ?? NEUTRAL_CURVE), ...patch };
    store.dispatch(
      [
        {
          op: 'setClipEffect',
          clipId: clip.id,
          effectType: 'curve',
          from: current,
          to: {
            id: current?.id ?? createId('fx'),
            clipId: clip.id,
            type: 'curve',
            params: { ...next },
            keyframes: [],
            enabled: true,
            order: 0,
            source: 'ui',
          },
        },
      ],
      '调整曲线',
    );
  }

  /** 开关降噪（R-061）：走 setClipEffect，可撤销。 */
  function toggleDenoise(on: boolean): void {
    if (clip === null) return;
    const current = clip.effects.find((effect) => effect.type === 'denoise') ?? null;
    store.dispatch(
      [
        {
          op: 'setClipEffect',
          clipId: clip.id,
          effectType: 'denoise',
          from: current,
          to: on
            ? {
                id: current?.id ?? createId('fx'),
                clipId: clip.id,
                type: 'denoise',
                params: { ...denoise },
                keyframes: [],
                enabled: true,
                order: 0,
                source: 'ui',
              }
            : null,
        },
      ],
      on ? '开启降噪' : '关闭降噪',
    );
  }

  /** 调降噪参数（拖动结束才提交，避免每个像素一个撤销步）。 */
  function commitDenoise(patch: Partial<DenoiseParams>): void {
    if (clip === null) return;
    const current = clip.effects.find((effect) => effect.type === 'denoise') ?? null;
    if (current === null) return;
    const next = { ...(denoiseOf(clip) ?? DEFAULT_DENOISE), ...patch };
    store.dispatch(
      [
        {
          op: 'setClipEffect',
          clipId: clip.id,
          effectType: 'denoise',
          from: current,
          to: { ...current, params: { ...next } },
        },
      ],
      '调整降噪',
    );
  }

  /** 存当前片段的样式为预设（只存"被改过"的字段，见 core/preset.ts）。 */
  function savePreset(): void {
    if (clip === null) return;
    const payload = capturePreset(clip);
    if (payload === null) return;
    const preset = createPreset(presetName, payload);
    void addPreset(preset).then((result) => {
      if (!result.ok) {
        store.pushError(result.error);
        return;
      }
      setPresets(result.value);
      setPresetName('');
    });
  }

  /** 套用预设：一次 dispatch = 一个撤销步。 */
  function applyPreset(preset: Preset): void {
    if (clip === null) return;
    const ops = buildPresetOps(clip, preset);
    if (ops.length === 0) return;
    store.dispatch(ops, `套用预设：${preset.name}`, 'ui');
  }

  function deletePreset(id: string): void {
    void removePreset(id).then((result) => {
      if (!result.ok) {
        store.pushError(result.error);
        return;
      }
      setPresets(result.value);
    });
  }

  const disabled = clip === null;
  const blendValue: BlendMode = clip?.transform.blendMode ?? 'normal';
  const isText = clip?.text !== null && clip?.text !== undefined;
  const asset = clip === null ? undefined : store.getDoc().assets.find((item) => item.id === clip.assetId);
  const hasAudio = asset?.hasAudio === true;
  const transitionType: 'none' | 'crossDissolve' | 'fadeIn' | 'fadeOut' =
    clip === null
      ? 'none'
      : clip.transitionOut !== null
        ? 'fadeOut'
        : clip.transitionIn !== null
          ? clip.transitionIn.type
          : 'none';

  return (
    <aside
      className="v-rail v-rail--right"
      data-v="inspector-panel"
      data-selection={clip === null ? 'none' : 'clip'}
      aria-label="属性栏"
    >
      <div className="v-inspector__group">
        <label className="v-inspector__label" htmlFor="v-inspector-scale">缩放</label>
        <input
          id="v-inspector-scale"
          className="v-inspector__control"
          data-v="inspector-scale"
          type="range"
          min={0.1}
          max={5}
          step={0.1}
          value={scale}
          disabled={disabled}
          onChange={(event) => setScale(Number(event.target.value))}
          onPointerUp={() => commitScale(scale)}
        />
        <span className="v-inspector__value" data-v="inspector-scale-value">
          {disabled ? '—' : `${Math.round(scale * 100)}%`}
        </span>
      </div>

      <div className="v-inspector__group">
        <span className="v-inspector__label">旋转 / 翻转</span>
        <div className="v-inspector__buttons">
          <button
            type="button"
            className="v-inspector__btn"
            data-v="inspector-rotate-left"
            disabled={disabled}
            title="向左旋转 90°"
            onClick={() => rotateBy(-90)}
          >
            左转 90°
          </button>
          <button
            type="button"
            className="v-inspector__btn"
            data-v="inspector-rotate-right"
            disabled={disabled}
            title="向右旋转 90°"
            onClick={() => rotateBy(90)}
          >
            右转 90°
          </button>
          <button
            type="button"
            className={`v-inspector__btn${clip?.transform.flipX === true ? ' v-inspector__btn--on' : ''}`}
            data-v="inspector-flip-x"
            aria-pressed={clip?.transform.flipX === true}
            disabled={disabled}
            title="水平翻转（左右镜像）"
            onClick={() => toggleFlip('flipX')}
          >
            水平翻转
          </button>
          <button
            type="button"
            className={`v-inspector__btn${clip?.transform.flipY === true ? ' v-inspector__btn--on' : ''}`}
            data-v="inspector-flip-y"
            aria-pressed={clip?.transform.flipY === true}
            disabled={disabled}
            title="垂直翻转（上下镜像）"
            onClick={() => toggleFlip('flipY')}
          >
            垂直翻转
          </button>
          <button
            type="button"
            className="v-inspector__btn v-inspector__btn--wide"
            data-v="inspector-frame-reset"
            disabled={disabled}
            title="旋转/翻转/位置/缩放一次还原"
            onClick={resetFrame}
          >
            还原画面
          </button>
        </div>
        <span className="v-inspector__value" data-v="inspector-rotation-value">
          {disabled ? '—' : `${normalizeRotation(clip?.transform.rotation ?? 0)}°`}
        </span>
      </div>

      <div className="v-inspector__group">
        <label className="v-inspector__label" htmlFor="v-inspector-pos">位置</label>
        <div className="v-inspector__pos">
          <input
            id="v-inspector-pos"
            className="v-inspector__control"
            data-v="inspector-x"
            type="text"
            value={posX}
            disabled={disabled}
            inputMode="numeric"
            onChange={(event) => setPosX(event.target.value)}
            onBlur={() => commitPos('x', posX)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
            }}
          />
          <span className="v-inspector__sep">,</span>
          <input
            className="v-inspector__control"
            data-v="inspector-y"
            type="text"
            value={posY}
            disabled={disabled}
            inputMode="numeric"
            onChange={(event) => setPosY(event.target.value)}
            onBlur={() => commitPos('y', posY)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
            }}
          />
        </div>
      </div>

      <div className="v-inspector__group">
        <label className="v-inspector__label" htmlFor="v-inspector-opacity">不透明度</label>
        <input
          id="v-inspector-opacity"
          className="v-inspector__control"
          data-v="inspector-opacity"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={opacity}
          disabled={disabled}
          onChange={(event) => setOpacity(Number(event.target.value))}
          onPointerUp={() => commitOpacity(opacity)}
        />
        <span className="v-inspector__value" data-v="inspector-opacity-value">
          {disabled ? '—' : `${Math.round(opacity * 100)}%`}
        </span>
      </div>

      <div className="v-inspector__group">
        <label className="v-inspector__label" htmlFor="v-inspector-blend">混合</label>
        <select
          id="v-inspector-blend"
          className="v-inspector__control"
          data-v="inspector-blend"
          value={blendValue}
          disabled={disabled}
          onChange={(event) => commitBlend(event.target.value as BlendMode)}
        >
          {BLEND_MODES.map((mode) => (
            <option key={mode.value} value={mode.value}>{mode.label}</option>
          ))}
        </select>
      </div>

      <div className="v-inspector__group">
        <label className="v-inspector__label" htmlFor="v-inspector-speed">速度</label>
        <input
          id="v-inspector-speed"
          className="v-inspector__control"
          data-v="inspector-speed"
          type="text"
          value={speed}
          disabled={disabled}
          inputMode="decimal"
          onChange={(event) => setSpeed(event.target.value)}
          onBlur={() => commitSpeed(speed)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
          }}
        />
        <span className="v-inspector__value" data-v="inspector-speed-value">
          {disabled ? '—' : `×${speed}`}
        </span>
      </div>

      {!disabled ? (
        <>
          <div className="v-inspector__group v-inspector__group--section">
            <span className="v-inspector__section">预设</span>
          </div>
          <div className="v-inspector__group v-inspector__group--tight">
            <input
              className="v-inspector__control"
              data-v="preset-name"
              placeholder="预设名（可空）"
              maxLength={MAX_PRESET_NAME}
              value={presetName}
              onChange={(event) => setPresetName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') savePreset();
              }}
            />
            <button
              type="button"
              className="v-inspector__kf"
              data-v="preset-save"
              title="把当前片段的缩放/位置/不透明度/调色/音量/文字样式存成预设"
              onClick={savePreset}
            >
              ＋ 存为预设
            </button>
          </div>
          {presets.length === 0 ? (
            <div className="v-inspector__group v-inspector__group--tight">
              <span className="v-inspector__hint" data-v="preset-empty">还没有预设</span>
            </div>
          ) : (
            presets.map((preset) => (
              <div className="v-inspector__group v-inspector__group--tight" key={preset.id}>
                <button
                  type="button"
                  className="v-inspector__kf"
                  data-v="preset-apply"
                  data-preset-id={preset.id}
                  title={`套用「${preset.name}」到当前片段`}
                  onClick={() => applyPreset(preset)}
                >
                  {preset.name}
                </button>
                <button
                  type="button"
                  className="v-inspector__preset-del"
                  data-v="preset-delete"
                  data-preset-id={preset.id}
                  aria-label={`删除预设 ${preset.name}`}
                  onClick={() => deletePreset(preset.id)}
                >
                  ×
                </button>
              </div>
            ))
          )}

          <div className="v-inspector__group v-inspector__group--section">
            <span className="v-inspector__section">转场</span>
          </div>
          <div className="v-inspector__group">
            <label className="v-inspector__label" htmlFor="v-inspector-transition">类型</label>
            <select
              id="v-inspector-transition"
              className="v-inspector__control"
              data-v="inspector-transition"
              value={transitionType}
              onChange={(event) =>
                commitTransition(event.target.value as 'none' | 'crossDissolve' | 'fadeIn' | 'fadeOut')
              }
            >
              <option value="none">无</option>
              <option value="crossDissolve">交叉溶解</option>
              <option value="fadeIn">淡入</option>
              <option value="fadeOut">淡出</option>
            </select>
          </div>
          {transitionType !== 'none' ? (
            <div className="v-inspector__group">
              <label className="v-inspector__label" htmlFor="v-inspector-transition-sec">时长(秒)</label>
              <input
                id="v-inspector-transition-sec"
                className="v-inspector__control"
                data-v="inspector-transition-sec"
                type="number"
                min={0.1}
                max={2}
                step={0.1}
                value={transitionSeconds}
                onChange={(event) => setTransitionSeconds(event.target.value)}
                onBlur={() => commitTransition(transitionType, transitionSeconds)}
              />
            </div>
          ) : null}
        </>
      ) : null}

      {isText && clip !== null && clip.text !== null && clip.text !== undefined ? (
        <>
          <div className="v-inspector__group v-inspector__group--section">
            <span className="v-inspector__section">文字</span>
          </div>
          <div className="v-inspector__group">
            <label className="v-inspector__label" htmlFor="v-inspector-text">内容</label>
            <textarea
              id="v-inspector-text"
              className="v-inspector__control v-inspector__textarea"
              data-v="inspector-text"
              rows={2}
              value={textDraft?.content ?? clip.text.content}
              onChange={(event) => setTextDraft({ ...clip.text as TextContent, content: event.target.value })}
              onBlur={(event) => commitText({ content: event.target.value })}
            />
          </div>
          <div className="v-inspector__group">
            <label className="v-inspector__label" htmlFor="v-inspector-fontsize">字号</label>
            <input
              id="v-inspector-fontsize"
              className="v-inspector__control"
              data-v="inspector-fontsize"
              type="number"
              min={8}
              max={400}
              value={clip.text.fontSize}
              onChange={(event) => commitText({ fontSize: Math.max(8, Math.min(400, Number(event.target.value) || 8)) })}
            />
          </div>
          <div className="v-inspector__group">
            <label className="v-inspector__label" htmlFor="v-inspector-textcolor">颜色</label>
            <input
              id="v-inspector-textcolor"
              className="v-inspector__control"
              data-v="inspector-textcolor"
              type="color"
              value={clip.text.color}
              onChange={(event) => commitText({ color: event.target.value })}
            />
          </div>
          <div className="v-inspector__group">
            <label className="v-inspector__label" htmlFor="v-inspector-textalign">对齐</label>
            <select
              id="v-inspector-textalign"
              className="v-inspector__control"
              data-v="inspector-textalign"
              value={clip.text.align}
              onChange={(event) => commitText({ align: event.target.value as TextContent['align'] })}
            >
              <option value="left">左</option>
              <option value="center">中</option>
              <option value="right">右</option>
            </select>
          </div>
          {/*
            粗体 / 描边（2026-10-23 新增）。
            必须给用户"能关掉"的入口：模板里有「金句描边」，套上去之后如果只能在
            属性栏里改颜色、没法去描边，用户就只能换模板重来。
          */}
          <div className="v-inspector__group">
            <label className="v-inspector__label" htmlFor="v-inspector-textbold">
              <input
                id="v-inspector-textbold"
                data-v="inspector-textbold"
                type="checkbox"
                checked={clip.text.bold === true}
                onChange={(event) => commitText({ bold: event.target.checked })}
              />{' '}
              加粗
            </label>
          </div>
          <div className="v-inspector__group">
            <label className="v-inspector__label" htmlFor="v-inspector-textstroke">
              <input
                id="v-inspector-textstroke"
                data-v="inspector-textstroke"
                type="checkbox"
                checked={clip.text.stroke !== null && clip.text.stroke !== undefined}
                onChange={(event) =>
                  commitText({ stroke: event.target.checked ? { width: 6, color: '#000000' } : null })
                }
              />{' '}
              描边
            </label>
            {clip.text.stroke !== null && clip.text.stroke !== undefined ? (
              <input
                className="v-inspector__control"
                data-v="inspector-strokewidth"
                type="number"
                min={1}
                max={40}
                title="描边粗细（项目像素）"
                value={clip.text.stroke.width}
                onChange={(event) =>
                  commitText({
                    stroke: {
                      width: Math.max(1, Math.min(40, Number(event.target.value) || 1)),
                      color: (clip.text as TextContent).stroke?.color ?? '#000000',
                    },
                  })
                }
              />
            ) : null}
          </div>
        </>
      ) : null}

      {!disabled && !isText ? (
        <>
          <div className="v-inspector__group v-inspector__group--section">
            <span className="v-inspector__section">调色</span>
          </div>
          {([
            ['brightness', '亮度'],
            ['contrast', '对比'],
            ['saturation', '饱和'],
            ['temperature', '色温'],
          ] as Array<[keyof ColorGrade, string]>).map(([key, label]) => (
            <div className="v-inspector__group" key={key}>
              <label className="v-inspector__label" htmlFor={`v-inspector-${key}`}>{label}</label>
              <input
                id={`v-inspector-${key}`}
                className="v-inspector__control"
                data-v={`inspector-${key}`}
                type="range"
                min={-100}
                max={100}
                step={1}
                value={grade[key]}
                onChange={(event) => setGrade({ ...grade, [key]: Number(event.target.value) })}
                onPointerUp={() => commitGrade({ [key]: grade[key] } as Partial<ColorGrade>)}
              />
              <span className="v-inspector__value" data-v={`inspector-${key}-value`}>{grade[key]}</span>
            </div>
          ))}
        </>
      ) : null}

      {!disabled && !isText ? (
        <>
          <div className="v-inspector__group v-inspector__group--section">
            <span className="v-inspector__section">曲线</span>
          </div>
          <div className="v-inspector__group">
            <label className="v-inspector__label" htmlFor="v-inspector-curve-shadow">暗部</label>
            <input
              id="v-inspector-curve-shadow"
              className="v-inspector__control"
              data-v="inspector-curve-shadow"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={curve.y1}
              onChange={(event) => setCurve({ ...curve, y1: Number(event.target.value) })}
              onPointerUp={() => commitCurve({ y1: curve.y1 })}
            />
            <span className="v-inspector__value" data-v="inspector-curve-shadow-value">
              {Math.round(curve.y1 * 100)}
            </span>
          </div>
          <div className="v-inspector__group">
            <label className="v-inspector__label" htmlFor="v-inspector-curve-highlight">亮部</label>
            <input
              id="v-inspector-curve-highlight"
              className="v-inspector__control"
              data-v="inspector-curve-highlight"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={curve.y2}
              onChange={(event) => setCurve({ ...curve, y2: Number(event.target.value) })}
              onPointerUp={() => commitCurve({ y2: curve.y2 })}
            />
            <span className="v-inspector__value" data-v="inspector-curve-highlight-value">
              {Math.round(curve.y2 * 100)}
            </span>
          </div>
        </>
      ) : null}

      {!disabled && !isText ? (
        <>
          <div className="v-inspector__group v-inspector__group--section">
            <span className="v-inspector__section">蒙版</span>
          </div>
          {mask === null ? (
            <div className="v-inspector__group v-inspector__group--tight">
              <button
                type="button"
                className="v-inspector__kf"
                data-v="inspector-mask-add"
                onClick={() => commitMask({}, '添加蒙版')}
              >
                ＋ 加蒙版
              </button>
              <span className="v-inspector__hint">也可以直接说「遮住左边」</span>
            </div>
          ) : (
            <>
              <div className="v-inspector__group v-inspector__group--tight">
                <label className="v-inspector__label" htmlFor="v-inspector-mask-shape">形状</label>
                <select
                  id="v-inspector-mask-shape"
                  className="v-inspector__control"
                  data-v="inspector-mask-shape"
                  value={mask.shape}
                  onChange={(event) => commitMask({ shape: event.target.value as MaskShape }, '修改蒙版形状')}
                >
                  <option value="rect">矩形</option>
                  <option value="ellipse">椭圆</option>
                </select>
                <label className="v-inspector__kf">
                  <input
                    type="checkbox"
                    data-v="inspector-mask-invert"
                    checked={mask.invert}
                    onChange={(event) => commitMask({ invert: event.target.checked }, '蒙版反向')}
                  />
                  反向
                </label>
              </div>
              {([
                ['x', '左', 0, 1],
                ['y', '上', 0, 1],
                ['w', '宽', 0.02, 1],
                ['h', '高', 0.02, 1],
                ['feather', '羽化', 0, 0.5],
              ] as Array<[keyof MaskParams & ('x' | 'y' | 'w' | 'h' | 'feather'), string, number, number]>).map(
                ([key, label, min, max]) => (
                  <div className="v-inspector__group" key={key}>
                    <label className="v-inspector__label" htmlFor={`v-inspector-mask-${key}`}>{label}</label>
                    <input
                      id={`v-inspector-mask-${key}`}
                      className="v-inspector__control"
                      data-v={`inspector-mask-${key}`}
                      type="range"
                      min={min}
                      max={max}
                      step={0.01}
                      value={mask[key]}
                      onChange={(event) => setMask({ ...mask, [key]: Number(event.target.value) })}
                      onPointerUp={() => commitMask({ [key]: mask[key] }, '调整蒙版')}
                    />
                    <span className="v-inspector__value" data-v={`inspector-mask-${key}-value`}>
                      {Math.round(mask[key] * 100)}
                    </span>
                  </div>
                ),
              )}
              <div className="v-inspector__group v-inspector__group--tight">
                <button
                  type="button"
                  className="v-inspector__kf"
                  data-v="inspector-mask-remove"
                  onClick={removeMask}
                >
                  移除蒙版
                </button>
              </div>
            </>
          )}
        </>
      ) : null}

      {!disabled && !isText ? (
        <>
          <div className="v-inspector__group v-inspector__group--section">
            <span className="v-inspector__section">LUT</span>
          </div>
          <div className="v-inspector__group v-inspector__group--tight">
            <label className="v-inspector__kf" style={{ cursor: 'pointer' }}>
              <span aria-hidden="true">＋</span> 载入 .cube
              <input
                type="file"
                accept=".cube,text/plain"
                hidden
                data-v="inspector-lut-file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file !== undefined) void loadLutFile(file);
                }}
              />
            </label>
            <span className="v-inspector__hint" data-v="inspector-lut-title">
              {lutTitle === '' ? '未加载' : lutTitle}
            </span>
          </div>
          {lutTitle !== '' ? (
            <div className="v-inspector__group">
              <label className="v-inspector__label" htmlFor="v-inspector-lut-strength">强度</label>
              <input
                id="v-inspector-lut-strength"
                className="v-inspector__control"
                data-v="inspector-lut-strength"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={lutStrength}
                onChange={(event) => setLutStrength(Number(event.target.value))}
                onPointerUp={() => commitLutStrength(lutStrength)}
              />
              <span className="v-inspector__value" data-v="inspector-lut-strength-value">
                {Math.round(lutStrength * 100)}%
              </span>
            </div>
          ) : null}
        </>
      ) : null}

      {!disabled ? (
        <>
          <div className="v-inspector__group v-inspector__group--section">
            <span className="v-inspector__section">
              {clip !== null && playhead >= clip.startFrame && playhead < clip.startFrame + clip.durationFrames
                ? `关键帧 · 第 ${playhead - clip.startFrame} 帧`
                : '关键帧（播放头不在片段内）'}
            </span>
          </div>
          {ANIMATABLE_PROPERTIES.map((property) => {
            const offset = clip === null ? -1 : playhead - clip.startFrame;
            const inside = clip !== null && offset >= 0 && offset < clip.durationFrames;
            const active = clip !== null && keyframeAt(clip, property, offset) !== null;
            const count = clip === null ? 0 : keyframesFor(clip, property).length;
            const label =
              property === 'transform.scale'
                ? '缩放'
                : property === 'transform.x'
                  ? '位置X'
                  : property === 'transform.y'
                    ? '位置Y'
                    : property === 'transform.opacity'
                      ? '不透明'
                      : '音量';
            return (
              <div className="v-inspector__group v-inspector__group--tight" key={property}>
                <button
                  type="button"
                  className={`v-inspector__kf${active ? ' v-inspector__kf--on' : ''}`}
                  data-v={`kf-${property.replace('.', '-')}`}
                  disabled={!inside}
                  title={inside ? `在第 ${offset} 帧${active ? '删除' : '添加'}关键帧` : '把播放头移到片段内'}
                  onClick={() => toggleKeyframe(property)}
                >
                  <span aria-hidden="true">{active ? '◆' : '◇'}</span> {label}
                  <span className="v-inspector__kf-count">{count > 0 ? count : ''}</span>
                </button>
              </div>
            );
          })}
        </>
      ) : null}

      {!disabled && hasAudio ? (
        <>
          <div className="v-inspector__group v-inspector__group--section">
            <span className="v-inspector__section">降噪</span>
          </div>
          <div className="v-inspector__group v-inspector__group--tight">
            <label className="v-inspector__check">
              <input
                type="checkbox"
                data-v="inspector-denoise"
                checked={clip !== null && clip.effects.some((effect) => effect.type === 'denoise' && effect.enabled)}
                onChange={(event) => toggleDenoise(event.target.checked)}
              />
              <span>噪声门 + 人声增强</span>
            </label>
          </div>
          {clip !== null && clip.effects.some((effect) => effect.type === 'denoise' && effect.enabled) ? (
            <>
              <div className="v-inspector__group">
                <label className="v-inspector__label" htmlFor="v-inspector-denoise-threshold">门限(dB)</label>
                <input
                  id="v-inspector-denoise-threshold"
                  className="v-inspector__control"
                  data-v="inspector-denoise-threshold"
                  type="range"
                  min={-70}
                  max={-20}
                  step={1}
                  value={denoise.thresholdDb}
                  onChange={(event) => setDenoise({ ...denoise, thresholdDb: Number(event.target.value) })}
                  onPointerUp={() => commitDenoise({ thresholdDb: denoise.thresholdDb })}
                />
                <span className="v-inspector__value" data-v="inspector-denoise-threshold-value">
                  {denoise.thresholdDb}
                </span>
              </div>
              <div className="v-inspector__group">
                <label className="v-inspector__label" htmlFor="v-inspector-denoise-enhance">增强</label>
                <input
                  id="v-inspector-denoise-enhance"
                  className="v-inspector__control"
                  data-v="inspector-denoise-enhance"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={denoise.enhance}
                  onChange={(event) => setDenoise({ ...denoise, enhance: Number(event.target.value) })}
                  onPointerUp={() => commitDenoise({ enhance: denoise.enhance })}
                />
                <span className="v-inspector__value" data-v="inspector-denoise-enhance-value">
                  {Math.round(denoise.enhance * 100)}%
                </span>
              </div>
            </>
          ) : null}

          <div className="v-inspector__group v-inspector__group--section">
            <span className="v-inspector__section">声音</span>
          </div>
          <div className="v-inspector__group">
            <label className="v-inspector__label" htmlFor="v-inspector-gain">音量</label>
            <input
              id="v-inspector-gain"
              className="v-inspector__control"
              data-v="inspector-gain"
              type="range"
              min={0}
              max={VOLUME_MAX_POSITION}
              step={0.01}
              value={volume}
              title="100% = 0dB（原始音量）；200% = +12dB；0% = 静音" 
              /**
               * **change 就提交**，不再等 `onPointerUp`。
               *
               * 旧实现只在 `pointerup` 写 doc，于是"点轨道跳值 / 键盘调 / 触摸抬起在别处"
               * 都只改了显示、没改实际值——用户把音量拖到 5%，界面写着 5%，
               * 实际还是 100%（听起来"5% 也过响"），或者某次误提交成 0（听起来"没声音"）。
               * 现在显示值永远等于真实值；撤销步靠 `mergeKey` 合并成一步。
               */
              onChange={(event) => {
                const position = Number(event.target.value);
                setVolume(position);
                // 位置 → 振幅后写进 doc：显示值永远等于真实值（见下方注释）
                commitAudio({ gain: positionToGain(position) }, { mergeKey: `gain:${clip?.id ?? ''}` });
              }}
            />
            {/*
              **dB 为主、百分比为辅**：人耳是按 dB 感知的，同一个百分比在不同素材上
              听起来差别很大；而 "-6dB" 在哪段素材上都是"小一半"。剪映/PR 也都是这么显示的。
            */}
            <span className="v-inspector__value" data-v="inspector-gain-value">
              {formatDb(positionToDb(volume))}
            </span>
            <span className="v-inspector__hint" data-v="inspector-gain-percent">
              {formatPercent(volume)}
            </span>
          </div>
          <div className="v-inspector__group">
            <label className="v-inspector__label" htmlFor="v-inspector-fadein">淡入(秒)</label>
            <input
              id="v-inspector-fadein"
              className="v-inspector__control"
              data-v="inspector-fadein"
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={fadeIn}
              onChange={(event) => setFadeIn(event.target.value)}
              onBlur={() => commitAudio({ fadeIn })}
            />
          </div>
          <div className="v-inspector__group">
            <label className="v-inspector__label" htmlFor="v-inspector-fadeout">淡出(秒)</label>
            <input
              id="v-inspector-fadeout"
              className="v-inspector__control"
              data-v="inspector-fadeout"
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={fadeOut}
              onChange={(event) => setFadeOut(event.target.value)}
              onBlur={() => commitAudio({ fadeOut })}
            />
          </div>
        </>
      ) : null}
    </aside>
  );
}

/** 供 E2E 定位用（导出 panel 的 DOM 结构 data-v 说明）。 */
export const INSPECTOR_ITEM_IDS = [
  'inspector-scale',
  'inspector-x',
  'inspector-y',
  'inspector-opacity',
  'inspector-blend',
] as const;

void createId; // 保留导入以维持模块依赖清晰（后续加动画关键帧时用）
