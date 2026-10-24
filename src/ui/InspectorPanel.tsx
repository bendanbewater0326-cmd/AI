/**
 * 右属性栏（T14；2026-10-24 动态分组改造）。
 *
 * ## 交互语义
 *
 * - 未选中：保持既有展示——变换控件全部 `disabled`（R-014）。
 * - 选中：**按片段类型条件渲染分组**（视频=基础变换/画面调节/曲线调色/LUT滤镜/蒙版/混合模式；
 *   音频=音量调节/淡入淡出/音频效果；文字=文字内容/文字样式/位置变换）。
 *   不支持的分组**直接不渲染 DOM**，而不是折叠隐藏——无效参数堆砌是本次改造要消除的核心问题。
 * - 多选：同类型 = 显示该类型全部分组，参数显示公共值（不一致时空），修改后**一次 dispatch
 *   批量应用**（一个撤销步）；混合类型 = 只渲染基础变换（视频侧）与音量调节（音频侧）。
 * - 连续拖动（缩放/不透明度滑块）：**拖动期间只更新本地显示**（不 dispatch，避免 React
 *   每帧重渲染），`onPointerUp` 才 `dispatch` 一次 → 预览 1 帧内变化 + **1 个撤销步**（T14 ④）。
 * - 离散控件（位置数字框 / 混合下拉）：`onChange` 立即 dispatch（低频，无所谓重渲染）。
 * - 越界不接受：滑块 `min/max` 硬约束，数字框越界回退原值（R-028 ③）。
 *
 * ## 分组折叠
 *
 * 复用 `CollapsibleSection`（`variant="plain" + collapsible`），**折叠态不持久化**：
 * 切换选中片段后分组按 key 重挂，回到该类型的默认展开/折叠状态——不同片段间
 * 继承折叠配置只会造成"它怎么收起来了"的困惑。
 *
 * ## 保持不变的部分
 *
 * 预设 / 转场 / 关键帧 / 速度 是与类型无关的既有功能（本次改造的规格未涉及），
 * 仍按主选片段工作，混合多选时不渲染（规格：混合只显示通用基础属性）。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import type { BlendMode, Clip, ClipOperation, Effect, Project, TextContent, Transition } from '../core/types';
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
import { clipKindOf, type ClipKind } from './clipKind';
import { buildPresetOps, capturePreset, createPreset, MAX_PRESET_NAME } from '../core/preset';
import { buildTransitionOps, resolveDuration } from '../core/transitionTarget';
import type { Preset } from '../core/preset';
import { PRESETS_CHANGED, addPreset, loadPresets, removePreset } from '../persist/presets';
import { DEFAULT_DENOISE, denoiseOf } from '../media/denoise';
import type { DenoiseParams } from '../media/denoise';
import { curveOf, NEUTRAL_CURVE } from '../render/curve';
import type { CurveParams } from '../render/curve';
import { LUT_EFFECT, parseCube } from '../render/lut';
import { AdjustRow } from './adjust/AdjustRow';
import { CollapsibleSection } from './adjust/CollapsibleSection';
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

/** 选中集合的类型：none=未选中，mixed=混合多类型。 */
type SelectionKind = 'none' | ClipKind | 'mixed';

function findClipIn(doc: Project, clipId: string): Clip | null {
  for (const track of doc.tracks) {
    const clip = track.clips.find((item) => item.id === clipId);
    if (clip !== undefined) return clip;
  }
  return null;
}

/** 订阅完整选中集合（主选 + Ctrl 加选），快照用拼接串保证稳定。 */
function useSelectionIds(): string[] {
  const joined = useSyncExternalStore(
    store.subscribe,
    () => store.getSelection().join('|'),
    () => '',
  );
  return joined === '' ? [] : joined.split('|');
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

/** 选中片段在某属性上是否全部同值（批量显示公共值的判据）。 */
function allEqual<T>(clips: Clip[], read: (clip: Clip) => T): boolean {
  if (clips.length <= 1) return true;
  const first = read(clips[0] as Clip);
  return clips.every((clip) => read(clip) === first);
}

/**
 * 批量输入框的显示值：**用户正在输的脏值优先**（本地值 ≠ 主选同步值 = 正在编辑，直接显示），
 * 否则一致显示公共值、不一致显示空状态。提交端用同一套判据过滤"没输入就失焦"的空提交。
 */
function batchShown(local: string, mainFormatted: string, consistent: boolean): string {
  return local !== mainFormatted ? local : consistent ? mainFormatted : '';
}

/** 属性栏用的折叠分组标题（统一收口默认态，别处不要再散着写）。 */
function InspectorGroup(props: {
  title: string;
  testId: string;
  defaultOpen: boolean;
  selectionKey: string;
  children: ReactElement | Array<ReactElement | null>;
}): ReactElement {
  return (
    <CollapsibleSection
      title={props.title}
      groupKey={`inspector:${props.testId}`}
      testId={props.testId}
      variant="plain"
      collapsible
      defaultOpen={props.defaultOpen}
      /**
       * key = 选中集合：切换片段时分组**重挂**，折叠态回到该类型的默认值
       * （CollapsibleSection 的折叠态是本地 state，重挂即重置——不写 localStorage）。
       */
      key={`grp-${props.selectionKey}`}
    >
      {props.children}
    </CollapsibleSection>
  );
}

export function InspectorPanel(): ReactElement {
  const mainSelectedId = useSelection();
  // 必须订阅 doc：只订阅选中态的话，改完属性（或撤销）后本组件不会重渲染，
  // 手里的 `clip` 还是旧对象——典型症状是"连续设两次转场，第一次的没被清掉"。
  const doc = useDoc((value) => value);
  const playhead = useFrame();
  const selectedIds = useSelectionIds();
  const railRef = useRef<HTMLElement | null>(null);

  const targets = selectedIds
    .map((id) => findClipIn(doc, id))
    .filter((item): item is Clip => item !== null);
  /** 主选片段：预设/转场/关键帧/速度这些"与类型无关"的既有功能仍按它工作。 */
  const clip = targets[0] ?? null;

  const kindSet = new Set(targets.map((item) => clipKindOf(doc, item)));
  const kind: SelectionKind =
    targets.length === 0 ? 'none' : kindSet.size > 1 ? 'mixed' : ([...kindSet][0] as ClipKind);
  const isMixed = kind === 'mixed';

  /** 各类型的目标集合（批量提交 = 每个目标一条 op，合并进**同一次 dispatch**）。 */
  const videoTargets = targets.filter((item) => clipKindOf(doc, item) === 'video');
  const textTargets = targets.filter((item) => clipKindOf(doc, item) === 'text');
  /** 画面类参数（变换/调色/蒙版…）的作用目标：文字选中时作用到文字片段（位置/不透明度可调）。 */
  const transformTargets = kind === 'text' ? textTargets : videoTargets;
  /** 有声音的目标（视频带音轨也算——与改造前的 `hasAudio` 判据一致）。 */
  const audibleTargets = targets.filter((item) => {
    const asset = doc.assets.find((candidate) => candidate.id === item.assetId);
    return asset?.hasAudio === true;
  });

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
  /**
   * 音量滑块拖动中的 **rAF 合帧**（性能专项 2026-10-24，用户拍板）：
   * 拖动里每个 input 步长（0.05）原本都走一次完整 dispatch（doc 拷贝 + 订阅通知），
   * 2000 片段实测连发 20 次出现 ~95ms 单帧尖峰。合帧后每个渲染帧至多提交一次、
   * 且只提交**最后一次的值**；松手语义/撤销合并（mergeKey）不变。
   * 数值输入框（淡入淡出）保持原失焦即时提交，不走这里。
   */
  const gainFrameRef = useRef<number | null>(null);

  // 选中变化时，本地值同步到真实值（批量时以主选片段为准，不一致项在渲染层显示空）
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

  // 选中片段变化：滚动回顶部（= 第一个展开分组的顶部），不截断也不停在上一片段的滚动位置
  useEffect(() => {
    railRef.current?.scrollTo({ top: 0 });
  }, [mainSelectedId]);

  function commitScale(next: number): void {
    if (transformTargets.length === 0) return;
    store.dispatch(transformTargets.map((item) => setProp(item, 'transform.scale', next)), '修改缩放');
  }
  function commitOpacity(next: number): void {
    if (transformTargets.length === 0) return;
    store.dispatch(transformTargets.map((item) => setProp(item, 'transform.opacity', next)), '修改不透明度');
  }
  function commitPos(axis: 'x' | 'y', raw: string): void {
    if (transformTargets.length === 0) return;
    // 批量显示空状态时输入框是 ''：什么都不做（不能把主选的值偷偷写回去）
    if (raw === '') return;
    const mainFormatted = String(axis === 'x' ? posMainX : posMainY);
    const consistent = allEqual(posTargets, (item) => (axis === 'x' ? item.transform.x : item.transform.y));
    if (!batchBlur(raw, mainFormatted, consistent)) return;
    const next = Number.parseInt(raw, 10);
    if (!Number.isInteger(next)) {
      // 非法：回退原值
      setPosX(String(clip?.transform.x ?? 0));
      setPosY(String(clip?.transform.y ?? 0));
      return;
    }
    const path = axis === 'x' ? 'transform.x' : 'transform.y';
    store.dispatch(transformTargets.map((item) => setProp(item, path, next)), '修改位置');
  }
  function commitBlend(next: BlendMode): void {
    if (videoTargets.length === 0) return;
    store.dispatch(videoTargets.map((item) => setProp(item, 'transform.blendMode', next)), '修改混合模式');
  }

  /**
   * 旋转 90° 步进（`docs/nle-baseline.md` §6：不做任意角度，避免画面外黑边）。
   *
   * 每次都是"在**各自当前值**上再转 90°"，所以连点四下回到原样——批量时每个片段
   * 从自己的角度出发，不会互相拉齐。
   */
  function rotateBy(delta: 90 | -90): void {
    if (transformTargets.length === 0) return;
    const ops = transformTargets.map((item) => {
      const from = normalizeRotation(item.transform.rotation);
      return setProp(item, 'transform.rotation', normalizeRotation(from + delta));
    });
    store.dispatch(ops, delta > 0 ? '向右旋转 90°' : '向左旋转 90°');
  }

  /** 水平/垂直翻转（开关式：再点一次取消）。批量 = 全部翻到主选的反面（拉齐）。 */
  function toggleFlip(axis: 'flipX' | 'flipY'): void {
    if (transformTargets.length === 0 || clip === null) return;
    const next = clip.transform[axis] !== true;
    const name = axis === 'flipX' ? '水平翻转' : '垂直翻转';
    store.dispatch(
      transformTargets.map((item) => setProp(item, `transform.${axis}`, next)),
      next ? name : `取消${name}`,
    );
  }

  /** 画面复位：旋转/翻转/位置/缩放一次回到初始（一个撤销步；每个片段只写真的会变的项）。 */
  function resetFrame(): void {
    if (transformTargets.length === 0) return;
    const targetsList: Array<[string, unknown]> = [
      ['transform.rotation', 0],
      ['transform.flipX', false],
      ['transform.flipY', false],
      ['transform.x', 0],
      ['transform.y', 0],
      ['transform.scale', 1],
    ];
    const ops: ClipOperation[] = [];
    for (const item of transformTargets) {
      for (const [path, value] of targetsList) {
        const current =
          path === 'transform.rotation' ? normalizeRotation(readPath(item, path)) : readPath(item, path);
        if (current !== value) ops.push(setProp(item, path, value));
      }
    }
    if (ops.length > 0) store.dispatch(ops, '还原画面');
  }

  /** 速度提交：接受 0.1–10 的十进制倍数（0.25/0.5/1/2/4），越界或非法回退。 */
  function commitSpeed(raw: string): void {
    if (targets.length === 0) return;
    // 批量失焦保护：没输入且当前不一致时，失焦不算"我要批量改"（空状态也不能被主选值覆盖）
    if (!batchBlur(raw, speedMain, allEqual(targets, (item) => item.speedMilli ?? 1000))) return;
    const factor = Number.parseFloat(raw);
    const current = (clip?.speedMilli ?? 1000) / 1000;
    if (!Number.isFinite(factor) || factor < 0.1 || factor > 10) {
      setSpeed(String(Number(current.toFixed(2))));
      return;
    }
    const speedMilli = Math.round(factor * 1000);
    const ops = targets
      .filter((item) => speedMilli !== (item.speedMilli ?? 1000))
      .map(
        (item) =>
          ({ op: 'setClipSpeed', clipId: item.id, from: item.speedMilli ?? 1000, to: speedMilli }) as ClipOperation,
      );
    if (ops.length > 0) store.dispatch(ops, '修改速度');
  }

  function commitGrade(patch: Partial<ColorGrade>): void {
    if (videoTargets.length === 0) return;
    const ops: ClipOperation[] = videoTargets.map((item) => {
      const current = gradeEffectOf(item);
      const next = { ...gradeOf(item), ...patch };
      return {
        op: 'setClipEffect',
        clipId: item.id,
        effectType: 'colorGrade',
        from: current,
        to: {
          id: current?.id ?? createId('fx'),
          clipId: item.id,
          type: 'colorGrade',
          params: { ...next },
          keyframes: [],
          enabled: true,
          order: 0,
          source: 'ui',
        },
      };
    });
    store.dispatch(ops, '调整调色');
  }

  function commitAudio(
    patch: { gain?: number; fadeIn?: string; fadeOut?: string },
    options: { mergeKey?: string } = {},
  ): void {
    if (audibleTargets.length === 0) return;
    // 批量失焦保护（仅淡入淡出的数字框需要）：没输入且不一致时，失焦不算"我要批量改"
    if (
      (patch.fadeIn !== undefined && !batchBlur(patch.fadeIn, clip === null ? '0' : formatFade(clip.audio.fadeInFrames), fadeConsistent('fadeInFrames'))) ||
      (patch.fadeOut !== undefined && !batchBlur(patch.fadeOut, clip === null ? '0' : formatFade(clip.audio.fadeOutFrames), fadeConsistent('fadeOutFrames')))
    ) {
      return;
    }
    const ops: ClipOperation[] = [];
    for (const item of audibleTargets) {
      if (patch.gain !== undefined) ops.push(setProp(item, 'audio.gain', patch.gain));
      if (patch.fadeIn !== undefined) {
        const sec = Math.max(0, Math.min(2, Number(patch.fadeIn) || 0));
        ops.push(setProp(item, 'audio.fadeInFrames', secondsToFrames(sec, store.getDoc().fpsMilli)));
      }
      if (patch.fadeOut !== undefined) {
        const sec = Math.max(0, Math.min(2, Number(patch.fadeOut) || 0));
        ops.push(setProp(item, 'audio.fadeOutFrames', secondsToFrames(sec, store.getDoc().fpsMilli)));
      }
    }
    // 音量滑块每 0.05 一步都会调这里：用 mergeKey 合并，一次拖动只占一个撤销步
    if (ops.length > 0) {
      store.dispatch(ops, '调整音量', 'ui', options.mergeKey === undefined ? undefined : { mergeKey: options.mergeKey });
    }
  }

  /** 转场类型切换：同一时刻只保留一侧（入场或出场），避免两条斜坡互相打架。 */
  function commitTransition(type: 'none' | 'crossDissolve' | 'fadeIn' | 'fadeOut', secondsText?: string): void {
    if (targets.length === 0) return;
    const fps = store.getDoc().fpsMilli;
    const seconds = Math.max(0.1, Math.min(2, Number(secondsText ?? transitionSeconds) || 0.5));
    // 时长夹取与"两侧互斥"都收敛在 `core/transitionTarget`：时长上限是**各自**片段时长的一半，
    // 所以批量时每个片段单独 resolve，不共用主选的夹取结果
    const side: 'in' | 'out' = type === 'fadeOut' ? 'out' : 'in';
    const ops = targets.flatMap((item) => {
      const durationFrames = resolveDuration(seconds, item, fps);
      const next: Transition | null = type === 'none' ? null : { type, durationFrames };
      return buildTransitionOps(item, side, next);
    });
    // 空数组 = 已经是这个转场了（同类型同时长、另一侧也为空），不发无用撤销步
    if (ops.length > 0) store.dispatch(ops, '设置转场');
  }

  /** 在播放头处添加/删除某个属性的关键帧（◆ 实心 = 已打点）。关键帧是主选片段的精确操作，不批量。 */
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
    if (textTargets.length === 0) return;
    const ops: ClipOperation[] = [];
    for (const item of textTargets) {
      if (item.text === null || item.text === undefined) continue;
      ops.push({
        op: 'setClipText',
        clipId: item.id,
        from: item.text,
        to: { ...item.text, ...patch },
      });
    }
    if (ops.length > 0) store.dispatch(ops, '编辑文字');
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

  /** 载入 LUT（R-058）：.cube 原文存进 effect params（工程文件自带，换机器也能用）。批量 = 画面类目标全部套同一份。 */
  async function loadLutFile(file: File): Promise<void> {
    if (videoTargets.length === 0) return;
    const text = await file.text();
    const parsed = parseCube(text);
    if (!parsed.ok) {
      store.pushError(parsed.error);
      return;
    }
    const ops: ClipOperation[] = videoTargets.map((item) => {
      const current = item.effects.find((effect) => effect.type === LUT_EFFECT) ?? null;
      return {
        op: 'setClipEffect',
        clipId: item.id,
        effectType: LUT_EFFECT,
        from: current,
        to: {
          id: current?.id ?? createId('fx'),
          clipId: item.id,
          type: LUT_EFFECT,
          params: { cube: text, strength: lutStrength, title: parsed.value.title || file.name },
          keyframes: [],
          enabled: true,
          order: 0,
          source: 'ui',
        },
      };
    });
    store.dispatch(ops, '载入 LUT');
    setLutTitle(parsed.value.title || file.name);
  }

  /** 调 LUT 强度。 */
  function commitLutStrength(value: number): void {
    if (videoTargets.length === 0) return;
    const ops: ClipOperation[] = [];
    for (const item of videoTargets) {
      const current = item.effects.find((effect) => effect.type === LUT_EFFECT) ?? null;
      if (current === null) continue;
      ops.push({
        op: 'setClipEffect',
        clipId: item.id,
        effectType: LUT_EFFECT,
        from: current,
        to: { ...current, params: { ...current.params, strength: value } },
      });
    }
    if (ops.length > 0) store.dispatch(ops, '调整 LUT 强度');
  }

  /**
   * 写蒙版参数（R-056）。
   *
   * 两个必须注意的点：
   * 1. **`invert` 存成 1/0**，不是 boolean——`maskOf` 读的是 `params['invert'] === 1`；
   * 2. **保留 `current.keyframes`**：参数细调不能把用户手动打的关键帧（手动跟踪）抹掉。
   */
  function commitMask(patch: Partial<MaskParams>, label: string): void {
    if (videoTargets.length === 0) return;
    const base = mask ?? DEFAULT_MASK;
    const next = { ...base, ...patch };
    const ops: ClipOperation[] = videoTargets.map((item) => {
      const current = item.effects.find((effect) => effect.type === MASK_EFFECT) ?? null;
      return {
        op: 'setClipEffect',
        clipId: item.id,
        effectType: MASK_EFFECT,
        from: current,
        to: {
          id: current?.id ?? createId('fx'),
          clipId: item.id,
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
      };
    });
    store.dispatch(ops, label);
    setMask(next);
  }

  /** 移除蒙版（走 setClipEffect 的 `to: null`，可撤销）。 */
  function removeMask(): void {
    if (videoTargets.length === 0) return;
    const ops: ClipOperation[] = [];
    for (const item of videoTargets) {
      const current = item.effects.find((effect) => effect.type === MASK_EFFECT) ?? null;
      if (current === null) continue;
      ops.push({ op: 'setClipEffect', clipId: item.id, effectType: MASK_EFFECT, from: current, to: null });
    }
    if (ops.length > 0) store.dispatch(ops, '移除蒙版');
    setMask(null);
  }

  /** 调曲线（R-055）：x 固定 0.25/0.75，只调暗部/亮部的 y。 */
  function commitCurve(patch: Partial<CurveParams>): void {
    if (videoTargets.length === 0) return;
    const ops: ClipOperation[] = videoTargets.map((item) => {
      const current = item.effects.find((effect) => effect.type === 'curve') ?? null;
      const next = { ...(curveOf(item) ?? NEUTRAL_CURVE), ...patch };
      return {
        op: 'setClipEffect',
        clipId: item.id,
        effectType: 'curve',
        from: current,
        to: {
          id: current?.id ?? createId('fx'),
          clipId: item.id,
          type: 'curve',
          params: { ...next },
          keyframes: [],
          enabled: true,
          order: 0,
          source: 'ui',
        },
      };
    });
    store.dispatch(ops, '调整曲线');
  }

  /** 开关降噪（R-061）：走 setClipEffect，可撤销。 */
  function toggleDenoise(on: boolean): void {
    if (audibleTargets.length === 0) return;
    const ops: ClipOperation[] = audibleTargets.map((item) => {
      const current = item.effects.find((effect) => effect.type === 'denoise') ?? null;
      return {
        op: 'setClipEffect',
        clipId: item.id,
        effectType: 'denoise',
        from: current,
        to: on
          ? {
              id: current?.id ?? createId('fx'),
              clipId: item.id,
              type: 'denoise',
              params: { ...denoise },
              keyframes: [],
              enabled: true,
              order: 0,
              source: 'ui',
            }
          : null,
      };
    });
    store.dispatch(ops, on ? '开启降噪' : '关闭降噪');
  }

  /** 调降噪参数（拖动结束才提交，避免每个像素一个撤销步）。 */
  function commitDenoise(patch: Partial<DenoiseParams>): void {
    if (audibleTargets.length === 0) return;
    const ops: ClipOperation[] = [];
    for (const item of audibleTargets) {
      const current = item.effects.find((effect) => effect.type === 'denoise') ?? null;
      if (current === null) continue;
      const next = { ...(denoiseOf(item) ?? DEFAULT_DENOISE), ...patch };
      ops.push({
        op: 'setClipEffect',
        clipId: item.id,
        effectType: 'denoise',
        from: current,
        to: { ...current, params: { ...next } },
      });
    }
    if (ops.length > 0) store.dispatch(ops, '调整降噪');
  }

  /** 存当前片段的样式为预设（只存"被改过"的字段，见 core/preset.ts）。预设是主选片段的操作。 */
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

  /** 套用预设：一次 dispatch = 一个撤销步。套到主选片段（预设里含变换/文字等复合字段，不批量猜意图）。 */
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
  const transitionType: 'none' | 'crossDissolve' | 'fadeIn' | 'fadeOut' =
    clip === null
      ? 'none'
      : clip.transitionOut !== null
        ? 'fadeOut'
        : clip.transitionIn !== null
          ? clip.transitionIn.type
          : 'none';

  /** 各分组在该类型下的可见性（条件渲染 = 不支持的分组直接不进 DOM）。 */
  const showGroups = {
    /** 基础变换：视频/图片必显示；混合选择时作为视频侧的通用组显示。 */
    transform: kind === 'video' || isMixed,
    /** 位置变换（文字）：位置 XY + 不透明度（文字没有缩放/旋转/混合）。 */
    textPosition: kind === 'text',
    /** 画面类（调色/曲线/LUT/蒙版/混合）：只有纯视频/图片选中时显示。 */
    picture: kind === 'video',
    /** 文字内容与样式。 */
    text: kind === 'text',
    /** 音频三组：音频片段全显示；视频片段带音轨时显示；混合只显示音量调节。 */
    volume: audibleTargets.length > 0 && (kind === 'audio' || kind === 'video' || isMixed),
    fade: audibleTargets.length > 0 && (kind === 'audio' || kind === 'video'),
    denoise: audibleTargets.length > 0 && (kind === 'audio' || kind === 'video'),
    /** 与类型无关的既有功能：混合多选时不渲染（规格：混合只显示通用基础属性）。 */
    legacy: !disabled && !isMixed,
  };
  const selectionKey = selectedIds.join('|');

  /** 批量显示：位置/速度/淡入淡出 = 脏值优先，其次公共值，不一致显示空。 */
  const posTargets = videoTargets.length > 0 ? videoTargets : textTargets;
  const posMainX = clip?.transform.x ?? 0;
  const posMainY = clip?.transform.y ?? 0;
  const posXShown = batchShown(posX, String(posMainX), allEqual(posTargets, (item) => item.transform.x));
  const posYShown = batchShown(posY, String(posMainY), allEqual(posTargets, (item) => item.transform.y));
  const speedMain = String(Number((((clip?.speedMilli ?? 1000) / 1000)).toFixed(2)));
  const speedShown = batchShown(speed, speedMain, allEqual(targets, (item) => item.speedMilli ?? 1000));
  const fpsForFade = framesPerSecond(store.getDoc().fpsMilli);
  const formatFade = (frames: number): string => String(Number((frames / Math.max(1, fpsForFade)).toFixed(2)));
  const fadeConsistent = (which: 'fadeInFrames' | 'fadeOutFrames'): boolean =>
    allEqual(audibleTargets, (item) => item.audio[which]);
  const fadeInShown = batchShown(fadeIn, clip === null ? '0' : formatFade(clip.audio.fadeInFrames), fadeConsistent('fadeInFrames'));
  const fadeOutShown = batchShown(fadeOut, clip === null ? '0' : formatFade(clip.audio.fadeOutFrames), fadeConsistent('fadeOutFrames'));
  /** 批量失焦保护：没输入（本地值仍等于主选值）且当前不一致时，失焦不算"我要批量改"。 */
  const batchBlur = (local: string, mainFormatted: string, consistent: boolean): boolean =>
    consistent || local !== mainFormatted;

  return (
    <aside
      ref={railRef}
      className="v-rail v-rail--right"
      data-v="inspector-panel"
      data-selection={disabled ? 'none' : 'clip'}
      data-selection-kind={disabled ? 'none' : kind}
      aria-label="属性栏"
    >
      {/*
        基础变换（展开）：缩放 / 旋转翻转 / 位置 / 不透明度。
        未选中时保持既有行为：6 组控件全渲染、`disabled`（R-014，标签保留）。
      */}
      {disabled || showGroups.transform ? (
        <InspectorGroup title="基础变换" testId="inspector-group-transform" defaultOpen selectionKey={selectionKey}>
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
                value={disabled ? posX : posXShown}
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
                value={disabled ? posY : posYShown}
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
        </InspectorGroup>
      ) : null}

      {/*
        混合模式：视频专属。未选中时也渲染（展开、禁用，保持 R-014 原貌）；
        文字 / 音频 / 混合选择时不渲染（规格：无关分组直接不进 DOM）。
      */}
      {!disabled && showGroups.text && clip !== null && clip.text !== null && clip.text !== undefined ? (
        <>
          <InspectorGroup title="文字内容" testId="inspector-group-text-content" defaultOpen selectionKey={selectionKey}>
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
          </InspectorGroup>
          <InspectorGroup title="文字样式" testId="inspector-group-text-style" defaultOpen selectionKey={selectionKey}>
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
          </InspectorGroup>
        </>
      ) : null}

      {/*
        位置变换（文字，折叠）：文字片段的"低频微调"——只有位置与不透明度，
        缩放/旋转/混合这些画面专属参数对文字不渲染。
      */}
      {!disabled && showGroups.textPosition ? (
        <InspectorGroup title="位置变换" testId="inspector-group-text-pos" defaultOpen={false} selectionKey={selectionKey}>
          <div className="v-inspector__group">
            <label className="v-inspector__label" htmlFor="v-inspector-pos">位置</label>
            <div className="v-inspector__pos">
              <input
                id="v-inspector-pos"
                className="v-inspector__control"
                data-v="inspector-x"
                type="text"
                value={posXShown}
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
                value={posYShown}
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
              onChange={(event) => setOpacity(Number(event.target.value))}
              onPointerUp={() => commitOpacity(opacity)}
            />
            <span className="v-inspector__value" data-v="inspector-opacity-value">
              {`${Math.round(opacity * 100)}%`}
            </span>
          </div>
        </InspectorGroup>
      ) : null}

      {/*
        音量调节（展开）：音频片段的核心操作；视频片段带音轨时同样显示（与改造前一致）。
        音量调节走 change 即提交 + mergeKey（见 commitAudio 注释）。
      */}
      {!disabled && showGroups.volume ? (
        <InspectorGroup title="音量调节" testId="inspector-group-volume" defaultOpen selectionKey={selectionKey}>
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
              onChange={(event) => {
                const position = Number(event.target.value);
                setVolume(position);
                // 显示立即跟随；写库 rAF 合帧（同帧多次拖动只提交末值，显示与真实值最多差一帧）
                if (gainFrameRef.current !== null) cancelAnimationFrame(gainFrameRef.current);
                const clipIdForGain = clip?.id ?? '';
                gainFrameRef.current = requestAnimationFrame(() => {
                  gainFrameRef.current = null;
                  commitAudio({ gain: positionToGain(position) }, { mergeKey: `gain:${clipIdForGain}` });
                });
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
        </InspectorGroup>
      ) : null}

      {!disabled && showGroups.fade ? (
        <InspectorGroup title="淡入淡出" testId="inspector-group-fade" defaultOpen selectionKey={selectionKey}>
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
              value={fadeInShown}
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
              value={fadeOutShown}
              onChange={(event) => setFadeOut(event.target.value)}
              onBlur={() => commitAudio({ fadeOut })}
            />
          </div>
        </InspectorGroup>
      ) : null}

      {!disabled && showGroups.denoise ? (
        <InspectorGroup title="音频效果" testId="inspector-group-denoise" defaultOpen={false} selectionKey={selectionKey}>
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
        </InspectorGroup>
      ) : null}


      {/*
        速度：与类型无关的既有功能（音频变速影响时长、视频变速影响画面），保持原样；
        只是不在混合多选时渲染。
      */}




      {!disabled && showGroups.picture ? (
        <InspectorGroup title="画面调节" testId="inspector-section-grade" defaultOpen selectionKey={selectionKey}>
          {([
            ['brightness', '亮度'],
            ['contrast', '对比'],
            ['saturation', '饱和'],
            ['temperature', '色温'],
          ] as Array<[keyof ColorGrade, string]>).map(([key, label]) => (
            <AdjustRow
              key={key}
              label={label}
              testId={`inspector-${key}`}
              layout="stack"
              value={grade[key]}
              min={-100}
              max={100}
              step={1}
              onChange={(next) => setGrade({ ...grade, [key]: next })}
              onCommit={(next) => commitGrade({ [key]: next } as Partial<ColorGrade>)}
            />
          ))}
        </InspectorGroup>
      ) : null}

      {!disabled && showGroups.picture ? (
        <InspectorGroup title="曲线调色" testId="inspector-section-curve" defaultOpen={false} selectionKey={selectionKey}>
          <AdjustRow
            label="暗部"
            testId="inspector-curve-shadow"
            layout="stack"
            value={curve.y1}
            min={0}
            max={100}
            step={1}
            toDisplay={(raw) => Math.round(raw * 100)}
            fromDisplay={(shown) => shown / 100}
            onChange={(next) => setCurve({ ...curve, y1: next })}
            onCommit={(next) => commitCurve({ y1: next })}
          />
          <AdjustRow
            label="亮部"
            testId="inspector-curve-highlight"
            layout="stack"
            value={curve.y2}
            min={0}
            max={100}
            step={1}
            toDisplay={(raw) => Math.round(raw * 100)}
            fromDisplay={(shown) => shown / 100}
            onChange={(next) => setCurve({ ...curve, y2: next })}
            onCommit={(next) => commitCurve({ y2: next })}
          />
        </InspectorGroup>
      ) : null}

      {!disabled && showGroups.picture ? (
        <InspectorGroup title="LUT滤镜" testId="inspector-section-lut" defaultOpen={false} selectionKey={selectionKey}>
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
            <AdjustRow
              label="强度"
              testId="inspector-lut-strength"
              layout="stack"
              value={lutStrength}
              min={0}
              max={100}
              step={5}
              toDisplay={(raw) => Math.round(raw * 100)}
              fromDisplay={(shown) => shown / 100}
              onChange={(next) => setLutStrength(next)}
              onCommit={(next) => commitLutStrength(next)}
            />
          ) : null}
        </InspectorGroup>
      ) : null}

      {!disabled && showGroups.picture ? (
        <InspectorGroup title="蒙版" testId="inspector-section-mask" defaultOpen={false} selectionKey={selectionKey}>
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
                // 内部下限：x/y 从 0、w/h 从 0.02（避免宽高为 0 变成不可见的挖洞）、羽化上限 0.5
                ['x', '左', 0, 100],
                ['y', '上', 0, 100],
                ['w', '宽', 2, 100],
                ['h', '高', 2, 100],
                ['feather', '羽化', 0, 50],
              ] as Array<[keyof MaskParams & ('x' | 'y' | 'w' | 'h' | 'feather'), string, number, number]>).map(
                ([key, label, min, max]) => (
                  <AdjustRow
                    key={key}
                    label={label}
                    testId={`inspector-mask-${key}`}
                    layout="stack"
                    value={mask[key] as number}
                    min={min}
                    max={max}
                    step={1}
                    toDisplay={(raw) => Math.round(raw * 100)}
                    fromDisplay={(shown) => shown / 100}
                    onChange={(next) => setMask({ ...mask, [key]: next })}
                    onCommit={(next) => commitMask({ [key]: next }, '调整蒙版')}
                  />
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
        </InspectorGroup>
      ) : null}

      {(disabled || showGroups.picture) ? (
        <InspectorGroup
          title="混合模式"
          testId="inspector-group-blend"
          // 未选中时展开（保持改造前"控件禁用但都在"的原貌，R-014）；选中时默认折叠
          defaultOpen={disabled}
          selectionKey={selectionKey}
        >
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
        </InspectorGroup>
      ) : null}

      {disabled || showGroups.legacy ? (
        <div className="v-inspector__group">
          <label className="v-inspector__label" htmlFor="v-inspector-speed">速度</label>
          <input
            id="v-inspector-speed"
            className="v-inspector__control"
            data-v="inspector-speed"
            type="text"
            value={disabled ? speed : speedShown}
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
      ) : null}

      {!disabled && showGroups.legacy ? (
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

      {!disabled && showGroups.legacy ? (
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
