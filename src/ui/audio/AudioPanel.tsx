/**
 * 左栏「音频」面板（音频面板 A2，docs/audio-panel-plan.md §3）。
 *
 * 轻量版 = **内置音效库**：分类 chips + 卡片网格，与文本/特效面板同一套手感。
 * - 点击卡片 = 添加到音频轨播放头处（走 `ensureSfxAsset` → `buildPlaceAssetOps`，
 *   与素材落轨同一套规则；建轨与落片同批 = 一个撤销步）。
 * - 卡片上的 ▶ = 试听（`sfxLibrary.toggleSfxPreview`，独立 `<audio>`，不碰音频引擎、不进 doc）。
 * - 拖拽（SFX_MIME + ghost）在 A3。
 *
 * 明确不做：音量/淡入淡出/降噪在**属性栏**已有（同一条规则只写一份），音乐库按 PRD 不做。
 */

import { useState } from 'react';
import type { ReactElement } from 'react';
import { makeError } from '../../core/types';
import { buildPlaceAssetOps } from '../../core/placement';
import { store } from '../../core/store';
import {
  SFX_CATEGORIES,
  SFX_PRESETS,
  ensureSfxAsset,
  sfxPreviewId,
  toggleSfxPreview,
} from './sfxLibrary';
import type { SfxCategory, SfxPreset } from './sfxLibrary';

type CategoryFilter = SfxCategory | 'all';

/** 卡片角标时长：全中文（2.5秒），与面板其它文案同一口径。 */
function formatSeconds(seconds: number): string {
  return `${seconds}秒`;
}

/** 试听按钮的图形（SVG 而不是 ▶ 字形：不同字体渲染差异大，TabIcon 同一条经验）。 */
function PreviewGlyph({ playing }: { playing: boolean }): ReactElement {
  if (playing) {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <rect x="1.5" y="1.5" width="7" height="7" rx="1" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2.5 1.2l6 3.8-6 3.8z" fill="currentColor" />
    </svg>
  );
}

export function AudioPanel(): ReactElement {
  const [category, setCategory] = useState<CategoryFilter>('all');
  /** 正在试听的预设 id（点卡片/停止后同步一次，渲染只看本地 state）。 */
  const [previewingId, setPreviewingId] = useState<string | null>(() => sfxPreviewId());
  /** 异步导入进行中的预设名（文件很小，通常一闪而过，但要给 busy 提示不静默）。 */
  const [addingName, setAddingName] = useState<string | null>(null);

  const visible =
    category === 'all' ? SFX_PRESETS : SFX_PRESETS.filter((preset) => preset.category === category);

  function togglePreview(preset: SfxPreset): void {
    toggleSfxPreview(preset);
    setPreviewingId(sfxPreviewId());
  }

  /** 点击卡片：确保音效已成为资产 → 落到音频轨播放头处 → 选中（与文本面板点击应用同套路）。 */
  async function applyPreset(preset: SfxPreset): Promise<void> {
    if (addingName !== null) return;
    setAddingName(preset.name);
    store.setBusy('正在添加音效…');
    try {
      const ensured = await ensureSfxAsset(preset);
      if (!ensured.ok) {
        store.pushError(ensured.error);
        return;
      }
      const doc = store.getDoc();
      const asset = doc.assets.find((item) => item.id === ensured.value.assetId);
      if (asset === undefined) {
        store.pushError(makeError('E_INVALID_PROJECT', '音效导入后找不到资产', preset.fileName));
        return;
      }
      // 复用素材落轨的全套规则：音轨自动挑选/不够建轨/占用避让，一个撤销步
      const plan = buildPlaceAssetOps(doc, asset, store.getPlayheadFrame(), { kind: 'audio' });
      if ('message' in plan) {
        store.pushError(makeError('E_INVALID_PROJECT', plan.message));
        return;
      }
      store.dispatch(plan.ops, `添加音效（${preset.name}）`);
      store.setSelectedClipId(plan.clipId);
    } finally {
      store.setBusy(null);
      setAddingName(null);
    }
  }

  return (
    <div className="v-sfxpanel" data-v="sfx-panel">
      {/* 分类筛选：只影响本地筛选状态（同文本面板，不写 localStorage） */}
      <div className="v-sfxpanel__cats" role="group" aria-label="音效分类" data-v="sfx-categories">
        {SFX_CATEGORIES.map((item) => (
          <button
            key={item.key}
            type="button"
            className="v-sfxpanel__cat"
            data-v={`sfx-cat-${item.key}`}
            data-active={item.key === category}
            aria-pressed={item.key === category}
            onClick={() => setCategory(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="v-sfxpanel__body" data-v="sfx-body">
        <div className="v-sfxpanel__grid" data-v="sfx-grid" data-count={visible.length}>
          {visible.map((preset) => {
            const playing = previewingId === preset.id;
            return (
              // 按钮不能嵌按钮（试听是独立命中区）：外面套一层放试听键，同文本卡的 wrap 套路
              <div className="v-sfxcard-wrap" key={preset.id}>
                <button
                  type="button"
                  className="v-sfxcard"
                  data-v="sfx-preset"
                  data-preset-id={preset.id}
                  data-category={preset.category}
                  aria-label={`${preset.name}（点击添加到音频轨）`}
                  title={`${preset.name}（点击添加到音频轨播放头处）`}
                  disabled={addingName !== null}
                  onClick={() => void applyPreset(preset)}
                >
                  <span className="v-sfxcard__stage" data-v="sfx-preset-stage" data-playing={playing}>
                    {/* 波形装饰（纯 CSS，静态）：表达"这是声音"而不是用缩略图 */}
                    <span className="v-sfxcard__wave" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                    </span>
                    <span className="v-sfxcard__dur">{formatSeconds(preset.seconds)}</span>
                  </span>
                  <span className="v-sfxcard__name">{preset.name}</span>
                </button>
                <button
                  type="button"
                  className="v-sfxcard__play"
                  data-v="sfx-preview"
                  data-preset-id={preset.id}
                  data-playing={playing}
                  aria-label={playing ? `停止试听 ${preset.name}` : `试听 ${preset.name}`}
                  title={playing ? '停止试听' : '试听'}
                  onClick={() => togglePreview(preset)}
                >
                  <PreviewGlyph playing={playing} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="v-sfxpanel__hint" data-v="sfx-hint">
        点卡片添加到音频轨播放头处；▶ 试听（同一时间只播一个）。
      </div>
    </div>
  );
}

/** 供测试断言：音效总数（避免测试自己写死 10）。 */
export const SFX_PRESET_COUNT = SFX_PRESETS.length;
