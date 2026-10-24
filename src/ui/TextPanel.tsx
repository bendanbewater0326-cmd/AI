/**
 * 左栏「文本」面板（模板库 + 我的预设）。
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
 * ## 「我的预设」为什么不新建一套存储
 *
 * R-053 的预设系统（`core/preset` + `persist/presets`）已经能存文字样式：
 * `capturePreset` 抓 `payload.textStyle`，`buildPresetOps` 套用，存在 settings 里
 * （跨工程保留）。这里**只做筛选与展示**：`payload.textStyle !== undefined` 的就是文字预设。
 * 另起一套的话，属性栏存的预设在这里看不到，用户会以为"存丢了"。
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { createTextContent, makeError } from '../core/types';
import { buildNewTextOps } from './textClip';
import type { TextContent } from '../core/types';
import { TEXT_CATEGORIES, TEXT_PRESETS, presetToText, textPresetsIn } from '../core/textPresets';
import type { TextCategory, TextPreset } from '../core/textPresets';
import { MAX_PRESET_NAME, buildPresetOps, capturePreset, createPreset } from '../core/preset';
import type { Preset } from '../core/preset';
import { PRESETS_CHANGED, addPreset, loadPresets, removePreset } from '../persist/presets';
import { store, useDoc, useSelection } from '../core/store';
import { clearDraggingText, setTextDrag } from './dnd';

/**
 * 缩略图放大倍数。
 *
 * 1:1 缩放（88px 标题 → 6px）在 136px 宽的卡片里几乎看不清；
 * 剪映/OpenCut 的模板缩略图也是把字放大着画的。1.8 倍 + 6px 下限，
 * 既保住"大标题明显比字幕大"的相对关系，又保证最小号（日期 28px）也读得出来。
 * 位置（x/y）保持 1:1，否则「左上角标」会被放大到卡片外面去。
 */
const PREVIEW_ZOOM = 1.8;

/** 我的预设卡片上的示意文字（预设不存内容，见 `capturePreset`）。 */
const USER_PREVIEW_TEXT = '示例文字';

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

  /** 选中的片段是不是文字片段（决定「存为预设」能不能点）。 */
  const selectedId = useSelection();
  const isTextSelected = useDoc((doc) => {
    if (selectedId === null) return false;
    for (const track of doc.tracks) {
      const hit = track.clips.find((clip) => clip.id === selectedId);
      if (hit !== undefined) return hit.text !== null && hit.text !== undefined;
    }
    return false;
  });

  const [presets, setPresets] = useState<Preset[]>([]);
  const [saving, setSaving] = useState(false);
  const [presetName, setPresetName] = useState('');

  // 预设存在 settings（IDB），跨工程保留；这里只取"带文字样式"的那些。
  // 订阅变更广播：属性栏那边也可能存/删预设，两边要同步（否则"存了但这边没出现"）
  useEffect(() => {
    let cancelled = false;
    const reload = (): void => {
      void loadPresets().then((list) => {
        if (!cancelled) setPresets(list);
      });
    };
    reload();
    window.addEventListener(PRESETS_CHANGED, reload);
    return () => {
      cancelled = true;
      window.removeEventListener(PRESETS_CHANGED, reload);
    };
  }, []);
  const userPresets = presets.filter((preset) => preset.payload.textStyle !== undefined);

  /** 在播放头新建一段文字（落文字轨；建轨与落片同批提交 = 一个撤销步）。 */
  function createText(text: TextContent, label: string): void {
    const plan = buildNewTextOps(store.getDoc(), store.getPlayheadFrame(), text);
    store.dispatch(plan.ops, label);
    // 立刻选中：右侧属性栏会切到文字控件，用户可以马上改内容
    store.setSelectedClipId(plan.clipId);
  }

  /** 点系统模板：选中的是文字片段就套样式（保留内容），否则新建。 */
  function applyPreset(preset: TextPreset): void {
    const clip = selectedClip();
    const doc = store.getDoc();
    if (clip === null || clip.text === null || clip.text === undefined) {
      // 模板里的字号/位置是 1080p 参考值，必须按当前工程分辨率换算
      createText(presetToText(preset, undefined, { width: doc.width, height: doc.height }), `添加文字（${preset.name}）`);
      return;
    }
    const next: TextContent = presetToText(preset, clip.text.content, { width: doc.width, height: doc.height });
    store.dispatch(
      [{ op: 'setClipText', clipId: clip.id, from: clip.text, to: next }],
      `套用文字样式（${preset.name}）`,
    );
  }

  /** 点我的预设：套到选中的文字片段；没选中文字就用这套样式新建一段。 */
  function applyUserPreset(preset: Preset): void {
    const clip = selectedClip();
    if (clip !== null && clip.text !== null && clip.text !== undefined) {
      // 复用 R-053 的操作构造：一个撤销步，且只改预设里有的字段
      const ops = buildPresetOps(clip, preset);
      if (ops.length === 0) return;
      store.dispatch(ops, `套用我的预设（${preset.name}）`);
      return;
    }
    createText(createTextContent({ ...(preset.payload.textStyle ?? {}) }), `添加文字（${preset.name}）`);
  }

  /** 打开"存为预设"：默认名取当前文字内容（比"我的样式 3"好认）。 */
  function openSave(): void {
    const clip = selectedClip();
    const fallback = clip?.text?.content.trim().slice(0, 12) ?? '';
    setPresetName(fallback === '' ? '我的样式' : fallback);
    setSaving(true);
  }

  function saveUserPreset(): void {
    const clip = selectedClip();
    if (clip === null) return;
    const payload = capturePreset(clip);
    if (payload === null || payload.textStyle === undefined) {
      store.pushError(makeError('E_INVALID_PROJECT', '当前片段没有可保存的文字样式'));
      return;
    }
    const preset = createPreset(presetName, payload);
    void addPreset(preset).then((result) => {
      if (!result.ok) {
        store.pushError(result.error);
        return;
      }
      setPresets(result.value);
      setSaving(false);
      setPresetName('');
    });
  }

  function deleteUserPreset(id: string): void {
    void removePreset(id).then((result) => {
      if (!result.ok) {
        store.pushError(result.error);
        return;
      }
      setPresets(result.value);
    });
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

      <div className="v-textpanel__body" data-v="text-body">
        {/* ---------- 我的预设（顶部，与系统预设明确分区） ---------- */}
        <div className="v-textpanel__head">
          <span className="v-textpanel__title">我的预设</span>
          <button
            type="button"
            className="v-textpanel__save"
            data-v="text-save-preset"
            disabled={!isTextSelected || saving}
            title={isTextSelected ? '把当前文字样式存成我的预设' : '先选中一段文字'}
            onClick={openSave}
          >
            存为预设
          </button>
        </div>
        {saving ? (
          <div className="v-textpanel__saverow" data-v="text-save-row">
            <input
              className="v-textpanel__nameinput"
              data-v="text-preset-name"
              value={presetName}
              maxLength={MAX_PRESET_NAME}
              aria-label="预设名称"
              autoFocus
              onChange={(event) => setPresetName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') saveUserPreset();
                if (event.key === 'Escape') setSaving(false);
              }}
            />
            <button type="button" className="v-textpanel__ok" data-v="text-preset-confirm" onClick={saveUserPreset}>
              保存
            </button>
            <button type="button" data-v="text-preset-cancel" onClick={() => setSaving(false)}>
              取消
            </button>
          </div>
        ) : null}
        {userPresets.length > 0 ? (
          <div className="v-textpanel__grid" data-v="text-user-grid" data-count={userPresets.length}>
            {userPresets.map((preset) => (
              <div className="v-textcard-wrap" key={preset.id}>
                <button
                  type="button"
                  className="v-textcard v-textcard--mine"
                  data-v="text-user-preset"
                  data-preset-id={preset.id}
                  data-mine="true"
                  aria-label={`${preset.name}（我的预设，点击应用）`}
                  title={`${preset.name}（我的预设）`}
                  onClick={() => applyUserPreset(preset)}
                >
                  <span className="v-textcard__stage" data-bg="dark">
                    <span className="v-textcard__text" style={previewStyle(preset.payload.textStyle ?? {})}>
                      {USER_PREVIEW_TEXT}
                    </span>
                  </span>
                  <span className="v-textcard__name">{preset.name}</span>
                </button>
                {/* 删除只出现在**我的预设**上；系统预设没有这个按钮（不是禁用它，是根本不给） */}
                <button
                  type="button"
                  className="v-textcard__del"
                  data-v="text-user-preset-del"
                  aria-label={`删除预设 ${preset.name}`}
                  title="删除这个预设"
                  onClick={() => deleteUserPreset(preset.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {/* ---------- 系统预设 ---------- */}
        <div className="v-textpanel__head">
          <span className="v-textpanel__title">系统预设</span>
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
              aria-label={`${preset.name}（点击应用，或拖到时间线）`}
              title={`${preset.name}（点击应用，或拖到时间线）`}
              onClick={() => applyPreset(preset)}
              /**
               * 可拖到时间线（第二步）。
               *
               * 用**独立 MIME**（`application/x-veditor-text`）而不是复用素材那个：
               * 文字的落点语义是"永远落文字轨、只有帧号听用户的"，和素材的
               * "按目标轨 + 占用避让"完全是两套规则。
               */
              draggable
              onDragStart={(event) => setTextDrag(event.dataTransfer, preset.id)}
              onDragEnd={clearDraggingText}
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
      </div>

      <button
        type="button"
        className="v-textpanel__add"
        data-v="text-add"
        onClick={() => createText(createTextContent(), '添加文字')}
        title="在播放头位置添加一段空白文字"
      >
        ＋ 添加文字
      </button>
    </div>
  );
}

/** 供测试断言：模板总数（避免测试自己写死 10）。 */
export const TEXT_PRESET_COUNT = TEXT_PRESETS.length;
