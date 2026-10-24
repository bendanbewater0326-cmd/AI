/**
 * 左栏「特效」面板（第一步：点击应用；拖拽在第二步）。
 *
 * ## 一句话说清它是什么
 *
 * 「特效」= **一键调色预设**（`colorGrade` 的参数组合）。渲染层能真实表达的
 * 画面效果只有调色 / 曲线 / LUT / 蒙版四种，其中只有调色适合做成"点一下换风格"；
 * 曲线只有 2 个控制点、LUT 要外部 .cube 文件、蒙版是空间挖洞 —— 都不适合做预设卡。
 *
 * 分工：**特效 = 选风格，调节 = 调数值**，两者写的是同一份 `clip.effects`，
 * 所以在面板里点完，右侧属性栏的 4 条滑块会立刻跟着变（反过来也成立）。
 *
 * ## 缩略图：真画面 + 复算着色器公式
 *
 * 纯色块分不清「复古胶片」和「冷调」—— 必须用真画面。源图取工程里视频素材的
 * IDB 缩略图（没有就画一张内置测试图），再**逐像素套用 `GRADE_GLSL` 的同一套公式**
 * （`render/grade.ts`）。
 *
 * 不能用 CSS `filter: brightness()` 省事：CSS 是乘法，着色器是加法，
 * `+18` 在两者下完全不是一个效果 —— 缩略图会"说谎"。
 *
 * ## 同类型单例
 *
 * `setClipEffect` 会先删掉同类型的旧 effect 再写新的，所以**应用第二个特效是替换**，
 * 不是叠加。UI 必须让这件事可见：`data-applied` 只可能出现在一张卡上，
 * 底部提示也直说"会替换"。
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { makeError } from '../core/types';
import type { Project } from '../core/types';
import {
  EFFECT_CATEGORIES,
  effectPresetsIn,
  isOriginalPreset,
} from '../core/effectPresets';
import type { EffectCategory, EffectPreset } from '../core/effectPresets';
import { appliedPresetId, buildEffectOps, currentGrade, resolveEffectTarget } from '../core/effectTarget';
import { store, useDoc, useSelection } from '../core/store';
import { applyGradeToPixels } from '../render/grade';
import { getThumbnail } from '../persist/autosave';
import { clearDraggingEffect, setEffectDrag } from './dnd';
import { runPanelAI } from '../ai/panelFlow';
import { isAIUsable } from '../ai/registry';

/** 缩略图分辨率（16:9）。14 张卡 × 96×54 一共 7 万像素，逐像素调色毫无压力。 */
const THUMB_W = 96;
const THUMB_H = 54;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 内置测试图（工程里没有素材时用）。
 *
 * 刻意画成"天空 / 肤色块 / 红块 / 地面 / 5 级灰阶"：
 * - 灰阶台阶看**亮度与对比**（提亮/压暗/高对比一眼能看出来）；
 * - 肤色块与红块看**色温与饱和**（暖阳/冷调/黑白一眼能看出来）。
 * 纯色块或渐变都做不到这一点。
 */
let fallbackCache: ImageData | null = null;
function fallbackPixels(): ImageData {
  if (fallbackCache !== null) return fallbackCache;
  const canvas = document.createElement('canvas');
  canvas.width = THUMB_W;
  canvas.height = THUMB_H;
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    fallbackCache = new ImageData(THUMB_W, THUMB_H);
    return fallbackCache;
  }
  ctx.fillStyle = '#5d7f9e';
  ctx.fillRect(0, 0, THUMB_W, THUMB_H * 0.45);
  ctx.fillStyle = '#4b5a3c';
  ctx.fillRect(0, THUMB_H * 0.45, THUMB_W, THUMB_H * 0.55);
  ctx.fillStyle = '#c99a6b';
  ctx.fillRect(THUMB_W * 0.07, THUMB_H * 0.12, THUMB_W * 0.24, THUMB_H * 0.3);
  ctx.fillStyle = '#8f4a3c';
  ctx.fillRect(THUMB_W * 0.36, THUMB_H * 0.18, THUMB_W * 0.15, THUMB_H * 0.24);
  // 5 级灰阶（0 / 25% / 50% / 75% / 100%）
  for (let step = 0; step < 5; step += 1) {
    const value = Math.round((255 * step) / 4);
    ctx.fillStyle = `rgb(${value},${value},${value})`;
    ctx.fillRect(THUMB_W * (0.6 + step * 0.078), THUMB_H * 0.62, THUMB_W * 0.078, THUMB_H * 0.3);
  }
  fallbackCache = ctx.getImageData(0, 0, THUMB_W, THUMB_H);
  return fallbackCache;
}

/**
 * 缩略图的源图用哪个素材：**选中片段自己的素材**优先（用户当下在看的东西），
 * 否则工程里第一个有缩略图的素材。返回空串 = 用内置测试图。
 */
function pickSourceAssetId(doc: Project, selectedClipId: string | null): string {
  if (selectedClipId !== null) {
    for (const track of doc.tracks) {
      const clip = track.clips.find((item) => item.id === selectedClipId);
      if (clip === undefined || clip.assetId === '') continue;
      const asset = doc.assets.find((item) => item.id === clip.assetId);
      if (asset !== undefined && asset.thumbnailRef !== null) return asset.id;
    }
  }
  const first = doc.assets.find((item) => item.thumbnailRef !== null);
  return first?.id ?? '';
}

/** 读素材缩略图 → 96×54 的像素（cover 裁切，不拉伸变形）。 */
async function loadThumbPixels(assetId: string): Promise<ImageData | null> {
  if (assetId === '') return null;
  const stored = await getThumbnail(assetId);
  if (!stored.ok || stored.value === null) return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(stored.value);
  } catch {
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = THUMB_W;
  canvas.height = THUMB_H;
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    bitmap.close();
    return null;
  }
  const scale = Math.max(THUMB_W / bitmap.width, THUMB_H / bitmap.height);
  const sourceW = THUMB_W / scale;
  const sourceH = THUMB_H / scale;
  ctx.drawImage(
    bitmap,
    (bitmap.width - sourceW) / 2,
    (bitmap.height - sourceH) / 2,
    sourceW,
    sourceH,
    0,
    0,
    THUMB_W,
    THUMB_H,
  );
  bitmap.close();
  return ctx.getImageData(0, 0, THUMB_W, THUMB_H);
}

/** 一张卡的缩略图：源图拷贝一份 → 套预设 → 画进自己的 canvas。 */
function Thumb({ source, preset }: { source: ImageData; preset: EffectPreset }): ReactElement {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    // **必须拷贝**：source 是所有卡片共享的缓存，就地调色会把别的卡也改了
    const pixels = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
    applyGradeToPixels(pixels.data, preset.params);
    ctx.putImageData(pixels, 0, 0);
  }, [source, preset]);
  return (
    <canvas
      ref={ref}
      className="v-fxcard__thumb"
      data-v="effect-thumb"
      width={THUMB_W}
      height={THUMB_H}
    />
  );
}

export function EffectPanel(): ReactElement {
  const [category, setCategory] = useState<EffectCategory | 'all'>('all');
  const visible = effectPresetsIn(category);
  const selectedId = useSelection();

  /**
   * 当前落点片段对应的预设 id（卡片高亮）。
   *
   * 返回**字符串**而不是对象：`useDoc` 用 `Object.is` 比快照，
   * 每次返回新对象会让 `useSyncExternalStore` 认为"一直在变"（无限重渲染）。
   * 空串 = 没有可落的片段，或者参数是用户在属性栏手调的（不属于任何预设）。
   */
  const appliedKey = useDoc((doc) => {
    const target = resolveEffectTarget(doc, selectedId, doc.playheadFrame);
    if ('message' in target) return '';
    return appliedPresetId(currentGrade(target.clip));
  });

  /** 缩略图源：素材 id 变化时才重新解一次（切片段/换工程）。 */
  const sourceAssetId = useDoc((doc) => pickSourceAssetId(doc, selectedId));
  const [source, setSource] = useState<ImageData>(() => fallbackPixels());
  useEffect(() => {
    let cancelled = false;
    /**
     * **要重试**：`thumbnailRef` 在导入时同步就填好了，但缩略图 blob 是
     * `putThumbnail` **异步**写进 IDB 的。面板是常驻挂载的，很可能在 blob 落库前
     * 就来读了一次 —— 读不到就永久停在兜底图（`sourceAssetId` 不会再变，effect 不会重跑）。
     * 症状很隐蔽：卡片一直显示内置测试图，看起来"正常"，只是和素材无关。
     */
    const load = async (): Promise<void> => {
      if (sourceAssetId === '') {
        setSource(fallbackPixels());
        return;
      }
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const pixels = await loadThumbPixels(sourceAssetId);
        if (cancelled) return;
        if (pixels !== null) {
          setSource(pixels);
          return;
        }
        await sleep(400);
      }
      if (!cancelled) setSource(fallbackPixels());
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [sourceAssetId]);

  function applyPreset(preset: EffectPreset): void {
    const doc = store.getDoc();
    const target = resolveEffectTarget(doc, store.getSelectedClipId(), doc.playheadFrame);
    if ('message' in target) {
      store.pushError(makeError('E_INVALID_PROJECT', target.message));
      return;
    }
    const ops = buildEffectOps(target.clip, preset);
    // 空数组 = 已经是这个预设 / 本来就没有特效却点了原片，不发无用撤销步
    if (ops.length === 0) return;
    store.dispatch(ops, isOriginalPreset(preset) ? '移除画面特效' : `应用画面特效（${preset.name}）`);
  }

  /* ---------- AI 风格调色（2026-10-24 面板场景化）：模型按文字描述给调色参数，
   * 落地走 setGrade 意图编译（与手动调色同一套 effect 构造与 clamp）。
   * 诚实边界：基于文字描述生成参数，不上传画面内容。 ---------- */
  const [aiOpen, setAiOpen] = useState(false);
  const [aiStyle, setAiStyle] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const aiUsable = isAIUsable();

  async function applyAIGrade(): Promise<void> {
    const style = aiStyle.trim();
    if (style === '' || aiBusy) return;
    setAiBusy(true);
    try {
      const doc = store.getDoc();
      const plan = await runPanelAI({
        text: style,
        instruction: `按风格描述调色：${style}（目标：选中的视频片段，参数范围 −100..100）`,
        doc,
        selectedClipId: store.getSelectedClipId(),
        playheadFrame: doc.playheadFrame,
      });
      if (!plan.ok) {
        store.pushError(plan.error);
        return;
      }
      store.dispatch(plan.value.ops, plan.value.summary, 'ai');
      // 选中落点片段：「已应用」高亮跟着选中走（与点击应用同一套表现）
      const op = plan.value.ops.find((item) => item.op === 'setClipEffect');
      if (op !== undefined && op.op === 'setClipEffect') store.setSelectedClipId(op.clipId);
      setAiOpen(false);
      setAiStyle('');
    } finally {
      setAiBusy(false);
    }
  }

  return (
    <div className="v-effectpanel" data-v="effect-panel">
      {/* 分类筛选：只影响本地状态，不写 localStorage（免得"上次选了风格、这次找不到原片"） */}
      <div className="v-effectpanel__cats" role="group" aria-label="特效分类" data-v="effect-categories">
        {EFFECT_CATEGORIES.map((item) => (
          <button
            key={item.key}
            type="button"
            className="v-effectpanel__cat"
            data-v={`effect-cat-${item.key}`}
            data-active={item.key === category}
            aria-pressed={item.key === category}
            onClick={() => setCategory(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/*
        AI 风格调色（面板场景化入口）：基于文字描述生成调色参数，不上传画面内容；
        无模型时禁用并说明（对齐字幕面板的转写禁用先例）。
      */}
      <div className="v-effectpanel__airow" data-v="effect-ai-row">
        {aiOpen ? (
          <>
            <input
              className="v-effectpanel__aiinput"
              data-v="effect-ai-style"
              placeholder="风格描述，例如：复古胶片 / 清爽夏日 / 电影感冷色"
              value={aiStyle}
              maxLength={40}
              autoFocus
              aria-label="调色风格描述"
              onChange={(event) => setAiStyle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void applyAIGrade();
                if (event.key === 'Escape') setAiOpen(false);
              }}
            />
            <button
              type="button"
              className="v-effectpanel__aigo"
              data-v="effect-ai-apply"
              disabled={aiBusy || aiStyle.trim() === ''}
              onClick={() => void applyAIGrade()}
            >
              {aiBusy ? '应用中…' : '应用'}
            </button>
            <button
              type="button"
              className="v-effectpanel__aicancel"
              data-v="effect-ai-cancel"
              onClick={() => setAiOpen(false)}
              aria-label="收起 AI 调色"
            >
              收起
            </button>
          </>
        ) : (
          <button
            type="button"
            className="v-effectpanel__aibtn"
            data-v="effect-ai-open"
            disabled={!aiUsable}
            title={aiUsable
              ? '基于文字描述生成调色参数，不上传画面内容'
              : '当前客户端未提供模型'}
            onClick={() => setAiOpen(true)}
          >
            ✦ AI 风格调色
          </button>
        )}
      </div>

      <div className="v-effectpanel__grid" data-v="effect-grid" data-count={visible.length}>
        {visible.map((preset) => {
          const applied = appliedKey !== '' && appliedKey === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              className="v-fxcard"
              data-v="effect-preset"
              data-preset-id={preset.id}
              data-category={preset.category}
              data-applied={applied}
              data-pinned={isOriginalPreset(preset)}
              aria-pressed={applied}
              aria-label={`${preset.name}（点击应用，或拖到片段上）`}
              title={`${preset.hint}｜也可以拖到时间线的片段上`}
              onClick={() => applyPreset(preset)}
              /* 拖到时间线：第四个独立 MIME，落点是「鼠标下那一整块片段」 */
              draggable
              onDragStart={(event) => setEffectDrag(event.dataTransfer, preset.id)}
              onDragEnd={clearDraggingEffect}
            >
              <span className="v-fxcard__stage">
                <Thumb source={source} preset={preset} />
                {/* 「已应用」角标：同类型只有一个，所以最多只有一张卡有它 */}
                {applied ? (
                  <span className="v-fxcard__badge" data-v="effect-applied" aria-hidden="true">
                    ✓
                  </span>
                ) : null}
              </span>
              <span className="v-fxcard__name">{preset.name}</span>
            </button>
          );
        })}
      </div>

      <p className="v-effectpanel__hint" data-v="effect-hint">
        选中片段后点击应用，或拖到片段上（再点另一个会替换，不会叠加）
      </p>
    </div>
  );
}

