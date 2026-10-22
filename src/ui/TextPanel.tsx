/**
 * 左栏「文本」面板（第一批：模板库 + 点击应用）。
 *
 * ## 交互规则（三种情况，一条都不能含糊）
 *
 * ```
 * 选中了「文字片段」        → 套样式，**保留用户写的字**（一条 setClipText）
 * 选中了「非文字片段」/没选 → 播放头新建 3 秒文字（一条 addClip），并自动选中
 * ```
 *
 * 为什么"套样式"要保留内容：用户先在片段里打了自己的文案，再点模板是为了换样子，
 * 不是为了把文案冲掉。反过来，新建时当然要用模板自带的示例文字。
 *
 * ## 为什么缩略图用 DOM 画、不用 canvas
 *
 * 1. 渲染层已经有 `renderTextLayer`，但它是"项目分辨率整张画布"，塞进 140px 卡片
 *    要么缩得看不清、要么每张卡片一张离屏 canvas（10 张就是 10 次全画布绘制）；
 * 2. DOM 版本能被 E2E 用 DOM 断言（`fontSize`/`color`/`background` 都能读），
 *    canvas 版本只能读像素，测试成本高一个量级；
 * 3. 卡片是"看个大概"，不需要和成片逐像素一致。
 *
 * 缩放用**容器查询单位**（`cqw`/`cqh`）：卡片宽度是弹性的（左栏可拖 15%–40%），
 * 用 cqw 才能让"1080p 下的 88px"在任何卡片宽度下都保持同一比例。
 *
 * ## 本批**不做**拖拽
 *
 * 拖拽要同时改 `dnd.ts` 的 MIME 与 `TimelineView` 的 onDrop，属于第二步。
 * 这里先不加 `draggable` —— 加了却没人接，是"看起来能拖、拖了没反应"的死交互。
 */
import { useState } from 'react';
import type { ReactElement } from 'react';
import { createClip, createTextContent } from '../core/types';
import type { TextContent } from '../core/types';
import { ensureTextTrackOps } from '../core/placement';
import { TEXT_CATEGORIES, TEXT_PRESETS, presetToText, textPresetsIn } from '../core/textPresets';
import type { TextCategory, TextPreset } from '../core/textPresets';
import { store } from '../core/store';
import { secondsToFrames } from '../core/timebase';

/** 新建文字片段的默认时长（与时间线工具栏的「文字」按钮一致）。 */
const DEFAULT_TEXT_SECONDS = 3;

/**
 * 缩略图放大倍数。
 *
 * 1:1 缩放（88px 标题 → 6px）在 136px 宽的卡片里几乎看不清；
 * 剪映/OpenCut 的模板缩略图也是把字放大着画的。1.8 倍 + 6px 下限，
 * 既保住"大标题明显比字幕大"的相对关系，又保证最小号（日期 28px）也读得出来。
 * 位置（x/y）保持 1:1，否则「左上角标」会被放大到卡片外面去。
 */
const PREVIEW_ZOOM = 1.8;

/** 把 1080p 的绝对像素换算成卡片里的容器查询单位。 */
function previewStyle(style: TextPreset['style']): Record<string, string> {
  const fontSize = style.fontSize ?? 72;
  const x = style.x ?? 0;
  const y = style.y ?? 0;
  const out: Record<string, string> = {
    // 1920 宽 → 100cqw，所以 1px = 100/1920 cqw
    fontSize: `max(${(fontSize / 1920) * 100 * PREVIEW_ZOOM}cqw, 6px)`,
    color: style.color ?? '#ffffff',
    // 位置：先落到画面中心，再按 x/y 平移（y 用 cqh：1080 高 → 100cqh）
    transform: `translate(calc(-50% + ${(x / 1920) * 100}cqw), calc(-50% + ${(y / 1080) * 100}cqh))`,
  };
  if (style.bold === true) out.fontWeight = '700';
  if (style.background !== undefined && style.background !== '') {
    out.background = style.background;
    // 底衬的内边距按字号比例给（与渲染层的 0.45 / 0.28 字号一致）
    out.padding = '0.14em 0.42em';
    out.borderRadius = '0.16em';
  }
  if (style.stroke !== null && style.stroke !== undefined && style.stroke.width > 0) {
    // 与渲染层一致：可见粗细 = width，这里直接用 cqw 表达
    out.WebkitTextStroke = `${(style.stroke.width / 1920) * 100}cqw ${style.stroke.color}`;
  }
  return out;
}

/** 当前选中的片段（没有就是 null）。 */
function selectedClip() {
  const id = store.getEphemeral().selectedClipId;
  if (id === null || id === undefined) return null;
  for (const track of store.getDoc().tracks) {
    const hit = track.clips.find((clip) => clip.id === id);
    if (hit !== undefined) return hit;
  }
  return null;
}

export function TextPanel(): ReactElement {
  const [category, setCategory] = useState<TextCategory | 'all'>('all');
  const visible = textPresetsIn(category);

  /** 在播放头新建一段文字（落文字轨；建轨与落片同批提交 = 一个撤销步）。 */
  function createText(preset: TextPreset | null): void {
    const doc = store.getDoc();
    const startFrame = store.getPlayheadFrame();
    const durationFrames = Math.max(1, secondsToFrames(DEFAULT_TEXT_SECONDS, doc.fpsMilli));
    const { ops, trackId } = ensureTextTrackOps(doc, startFrame, durationFrames);
    const clip = createClip({
      assetId: '',
      trackId,
      startFrame,
      inFrame: 0,
      outFrame: durationFrames,
      durationFrames,
      // 模板里的字号/位置是 1080p 参考值，必须按当前工程分辨率换算
      text:
        preset === null
          ? createTextContent()
          : presetToText(preset, undefined, { width: doc.width, height: doc.height }),
    });
    store.dispatch([...ops, { op: 'addClip', clip }], preset === null ? '添加文字' : `添加文字（${preset.name}）`);
    // 立刻选中：右侧属性栏会切到文字控件，用户可以马上改内容
    store.setSelectedClipId(clip.id);
  }

  /** 点模板：选中的是文字片段就套样式（保留内容），否则新建。 */
  function applyPreset(preset: TextPreset): void {
    const clip = selectedClip();
    if (clip === null || clip.text === null || clip.text === undefined) {
      createText(preset);
      return;
    }
    const doc = store.getDoc();
    const next: TextContent = presetToText(preset, clip.text.content, { width: doc.width, height: doc.height });
    store.dispatch(
      [{ op: 'setClipText', clipId: clip.id, from: clip.text, to: next }],
      `套用文字样式（${preset.name}）`,
    );
  }

  return (
    <div className="v-textpanel" data-v="text-panel">
      {/* 分类筛选：只影响本地筛选状态，不写 localStorage（免得"上次选了字幕、这次找不到主标题"） */}
      <div className="v-textpanel__cats" role="group" aria-label="文字分类" data-v="text-categories">
        {TEXT_CATEGORIES.map((item) => (
          <button
            key={item.key}
            type="button"
            className="v-textpanel__cat"
            data-v={`text-cat-${item.key}`}
            data-active={item.key === category}
            aria-pressed={item.key === category}
            onClick={() => setCategory(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="v-textpanel__grid" data-v="text-grid" data-count={visible.length}>
        {visible.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="v-textcard"
            data-v="text-preset"
            data-preset-id={preset.id}
            data-category={preset.category}
            aria-label={`${preset.name}（点击应用）`}
            title={`${preset.name}（点击应用）`}
            onClick={() => applyPreset(preset)}
          >
            <span className="v-textcard__stage" data-v="text-preset-preview" data-bg={preset.previewBg}>
              <span className="v-textcard__text" style={previewStyle(preset.style)}>
                {preset.content}
              </span>
            </span>
            <span className="v-textcard__name">{preset.name}</span>
          </button>
        ))}
      </div>

      <button
        type="button"
        className="v-textpanel__add"
        data-v="text-add"
        onClick={() => createText(null)}
        title="在播放头位置添加一段空白文字"
      >
        ＋ 添加文字
      </button>
    </div>
  );
}

/** 供测试断言：模板总数（避免测试自己写死 10）。 */
export const TEXT_PRESET_COUNT = TEXT_PRESETS.length;
