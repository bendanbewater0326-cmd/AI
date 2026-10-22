/**
 * 左栏「转场」面板（第一步：点击应用；拖拽在第二步）。
 *
 * ## 三种转场落的地方不一样
 *
 * ```
 * ┌──────────┬──────────┐
 * │   片段 A  │   片段 B  │   接缝 = A 末尾 == B 开头（严格相等）
 * └──────────┴──────────┘
 *      叠化 → B 的 in（窗口跨接缝，A 被一起拉进来淡出）← 需要左邻
 *      淡入 → B 的 in（只淡 B，不需要 A）
 *      淡出 → A 的 out（在 A 内部淡出，不需要 B）
 * ```
 *
 * `side` 写在 `core/transitionPresets.ts` 的数据里，不在这里写 if ——
 * 以后补类型只加一条数据，面板与拖拽两条链路都不用动。
 *
 * ## 两侧互斥
 *
 * 同一个片段同时有 in/out 时，渲染层取 `min(opacity)`，表现是"转场看起来很弱"。
 * 所以设一侧就清另一侧，且**同一次 dispatch**（一个撤销步）。
 * 这条规则收在 `buildTransitionOps`，右侧属性栏也调它，不各写一份。
 */
import { useState } from 'react';
import type { ReactElement } from 'react';
import { makeError } from '../core/types';
import type { Project } from '../core/types';
import {
  DEFAULT_TRANSITION_SECONDS,
  TRANSITION_DURATIONS,
  TRANSITION_PRESETS,
} from '../core/transitionPresets';
import type { TransitionPreset } from '../core/transitionPresets';
import {
  buildTransitionOps,
  clipAtFrame,
  currentTransition,
  findClipById,
  resolveTransitionTarget,
} from '../core/transitionTarget';
import type { TransitionTarget } from '../core/transitionTarget';
import { store, useDoc, useSelection } from '../core/store';

/** 缩略图：纯 DOM 画（不用 canvas、不用渐变 —— 渐变会破坏"极简无渐变"的既有约束）。 */
function Preview({ kind }: { kind: TransitionPreset['preview'] }): ReactElement {
  if (kind === 'overlap') {
    // 叠化：两块半透明方块叠着
    return (
      <span className="v-trscard__stage" aria-hidden="true">
        <span className="v-trscard__block v-trscard__block--a" />
        <span className="v-trscard__block v-trscard__block--b" />
      </span>
    );
  }
  // 淡入/淡出：5 条竖条的不透明度递变（不用渐变，用台阶表达"渐渐"）
  const steps = kind === 'fadeInBars' ? [0.12, 0.3, 0.5, 0.72, 1] : [1, 0.72, 0.5, 0.3, 0.12];
  return (
    <span className="v-trscard__stage" aria-hidden="true">
      {steps.map((opacity, index) => (
        <span key={index} className="v-trscard__bar" style={{ opacity }} />
      ))}
    </span>
  );
}

export function TransitionPanel(): ReactElement {
  const [seconds, setSeconds] = useState<number>(DEFAULT_TRANSITION_SECONDS);
  const selectedId = useSelection();

  /**
   * 当前片段生效中的转场（卡片高亮 + 「移除」可用性）。
   *
   * 返回**字符串**而不是对象：`useDoc` 用 `Object.is` 比较快照，
   * 每次返回新对象会让 `useSyncExternalStore` 认为"一直在变"（无限重渲染）。
   */
  const currentKey = useDoc((doc) => {
    if (selectedId === null) return '';
    const found = findClipById(doc, selectedId);
    if (found === null) return '';
    const current = currentTransition(found.clip);
    return current === null ? '' : `${current.side}:${current.transition.type}:${current.transition.durationFrames}`;
  });

  /**
   * 落点：选中片段优先；没选中就用播放头所在的片段。
   * 两种情况都交给 `resolveTransitionTarget` 判"有没有片段 / 能不能叠化"。
   */
  function locateFor(
    doc: Project,
    preset: TransitionPreset,
  ): TransitionTarget | { message: string } {
    if (selectedId !== null) {
      const found = findClipById(doc, selectedId);
      if (found !== null) {
        // 用片段自己的起点当落点帧：`clipAtFrame` 会命中它自己（半开区间）
        return resolveTransitionTarget(doc, found.track, found.clip.startFrame, preset, seconds);
      }
    }
    const frame = store.getPlayheadFrame();
    for (const track of doc.tracks) {
      // 音频轨没有画面转场
      if (track.kind === 'audio') continue;
      if (clipAtFrame(track, frame) !== null) {
        return resolveTransitionTarget(doc, track, frame, preset, seconds);
      }
    }
    return { message: '先选中一个片段，或把播放头移到某个片段上' };
  }

  function applyPreset(preset: TransitionPreset): void {
    const doc = store.getDoc();
    const target = locateFor(doc, preset);
    if ('message' in target) {
      store.pushError(makeError('E_INVALID_PROJECT', target.message));
      return;
    }
    const found = findClipById(doc, target.clipId);
    if (found === null) return;
    const ops = buildTransitionOps(found.clip, target.side, {
      type: preset.type,
      durationFrames: target.durationFrames,
    });
    // 空数组 = 已经是这个转场了，不发无用撤销步
    if (ops.length === 0) return;
    store.dispatch(ops, `设置转场（${preset.name}）`);
  }

  function removeTransition(): void {
    const doc = store.getDoc();
    const id = selectedId ?? null;
    if (id === null) return;
    const found = findClipById(doc, id);
    if (found === null) return;
    const ops = buildTransitionOps(found.clip, 'in', null);
    if (ops.length === 0) return;
    store.dispatch(ops, '移除转场');
  }

  const activeType = currentKey === '' ? null : currentKey.split(':')[1];
  const hasTransition = currentKey !== '';

  return (
    <div className="v-transitionpanel" data-v="transition-panel">
      <div className="v-transitionpanel__row">
        <span className="v-transitionpanel__label">时长</span>
        <div className="v-transitionpanel__durations" role="group" aria-label="转场时长">
          {TRANSITION_DURATIONS.map((value) => (
            <button
              key={value}
              type="button"
              className="v-transitionpanel__duration"
              data-v={`transition-duration-${value}`}
              data-active={value === seconds}
              aria-pressed={value === seconds}
              title={`新加的转场用 ${value} 秒`}
              onClick={() => setSeconds(value)}
            >
              {value}s
            </button>
          ))}
        </div>
        <button
          type="button"
          className="v-transitionpanel__remove"
          data-v="transition-remove"
          disabled={!hasTransition}
          title={hasTransition ? '移除这个片段的转场' : '当前片段没有转场'}
          onClick={removeTransition}
        >
          移除
        </button>
      </div>

      <div className="v-transitionpanel__grid" data-v="transition-grid" data-count={TRANSITION_PRESETS.length}>
        {TRANSITION_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="v-trscard"
            data-v="transition-preset"
            data-preset-id={preset.id}
            data-active={preset.type === activeType}
            aria-pressed={preset.type === activeType}
            aria-label={`${preset.name}（点击应用）`}
            title={preset.hint}
            onClick={() => applyPreset(preset)}
          >
            <Preview kind={preset.preview} />
            <span className="v-trscard__name">{preset.name}</span>
          </button>
        ))}
      </div>

      <p className="v-transitionpanel__hint" data-v="transition-hint">
        选中片段后点击应用（叠化需要左边紧挨着一段素材）
      </p>
    </div>
  );
}
