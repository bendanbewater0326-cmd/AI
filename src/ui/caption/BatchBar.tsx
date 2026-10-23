/**
 * 批量操作条（多选 ≥2 条时出现在状态栏下方）。
 *
 * ## 为什么用"两行"而不是一行
 *
 * 左栏约 340px（25% × 1440 − 44 图标条 − padding），五个中文按钮一行放不下
 * （每个 48–56px）。拆成两行：第一行「已选 N 条 + 取消」，第二行四个操作按钮。
 * 总高约 52px，列表从一屏 10 条降到 8 条 —— 仍在用户要求的 8–10 条区间内。
 *
 * ## 平移 / 样式为什么是"展开行"而不是弹窗
 *
 * 左栏窄，弹窗会挡住预览。展开行在面板内，用户能边看画面边调数值。
 * 展开状态是本地 state，不写 localStorage（临时操作，下次进面板不该还记得）。
 *
 * ## 删除不做二次确认
 *
 * 有撤销（一次 batch = 一个撤销步），再加确认弹窗是双重打扰。
 * 但按钮用危险色（红），让"手滑"之前先看到。
 */
import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { store } from '../../core/store';
import type { Clip } from '../../core/types';
import { secondsToFrames } from '../../core/timebase';
import { batchDelete, batchMerge, batchShift, batchStyle, batchTemplate } from './batchActions';
import { textPresetsIn } from '../../core/textPresets';
import type { TextPreset } from '../../core/textPresets';

/** 平移的单位。 */
type ShiftUnit = 'second' | 'frame';

export interface BatchBarProps {
  /** 选中的所有字幕片段（已按列表顺序）。 */
  clips: Clip[];
  /** 主选（合并时以它为准；也为"同主选样式"提供源）。 */
  primary: Clip | null;
  /** 清空多选。 */
  onClear: () => void;
  /** 显示一行反馈（复用面板的 notice）。 */
  onNotice: (text: string) => void;
}

export function BatchBar(props: BatchBarProps): ReactElement {
  const { clips, primary, onClear, onNotice } = props;
  const [expanded, setExpanded] = useState<'none' | 'shift' | 'style'>('none');
  const [shiftValue, setShiftValue] = useState('0.5');
  const [shiftUnit, setShiftUnit] = useState<ShiftUnit>('second');

  // 选择集变化时收起展开行（避免"换了一批还挂着上一批的输入值"）
  const clipIdsKey = clips.map((clip) => clip.id).join(',');
  useEffect(() => {
    setExpanded('none');
  }, [clipIdsKey]);

  const doDelete = useCallback(() => {
    const result = batchDelete(clips);
    onNotice(result.message);
  }, [clips, onNotice]);

  const doMerge = useCallback(() => {
    const result = batchMerge(clips);
    onNotice(result.message);
  }, [clips, onNotice]);

  /**
   * 平移：数值 + 方向按钮。
   *
   * 方向由按钮决定（不靠正负号）—— 用户输 `-5` 又点"前移"时不该有歧义。
   * 秒 → 帧的换算走 `secondsToFrames`（时基唯一换算点）。
   */
  const doShift = useCallback(
    (forward: boolean) => {
      const value = Number(shiftValue);
      if (!Number.isFinite(value) || value <= 0) {
        onNotice('请输入大于 0 的数值');
        return;
      }
      const fpsMilli = store.getDoc().fpsMilli;
      const frames = shiftUnit === 'second' ? secondsToFrames(value, fpsMilli) : Math.round(value);
      if (frames <= 0) {
        onNotice(shiftUnit === 'second' ? '换算后不足 1 帧，请加大数值' : '请输入至少 1 帧');
        return;
      }
      const result = batchShift(clips, forward ? -frames : frames);
      onNotice(result.message);
    },
    [clips, shiftValue, shiftUnit, onNotice],
  );

  const size = { width: store.getDoc().width, height: store.getDoc().height };

  /** 模板按分类列出（与文本面板同一份数据）。 */
  const templates = textPresetsIn('all');

  return (
    <div className="v-batchbar" data-v="batch-bar">
      {/* 第一行：数量 + 取消 */}
      <div className="v-batchbar__head">
        <span className="v-batchbar__count" data-v="batch-count">
          已选 {clips.length} 条
        </span>
        <span className="v-batchbar__spacer" />
        <button type="button" className="v-batchbar__link" data-v="batch-clear" onClick={onClear}>
          取消选择
        </button>
      </div>

      {/* 第二行：四个操作 */}
      <div className="v-batchbar__actions">
        <button
          type="button"
          className="v-batchbar__btn v-batchbar__btn--danger"
          data-v="batch-delete"
          title="删除选中的字幕（可撤销）"
          onClick={doDelete}
        >
          删除
        </button>
        <button
          type="button"
          className="v-batchbar__btn"
          data-v="batch-merge"
          disabled={clips.length < 2}
          title={clips.length < 2 ? '至少选两条才能合并' : '把选中的字幕合并成一条'}
          onClick={doMerge}
        >
          合并
        </button>
        <button
          type="button"
          className="v-batchbar__btn"
          data-v="batch-shift"
          data-active={expanded === 'shift' ? 'true' : 'false'}
          title="整体前移或后移"
          onClick={() => setExpanded((current) => (current === 'shift' ? 'none' : 'shift'))}
        >
          平移
        </button>
        <button
          type="button"
          className="v-batchbar__btn"
          data-v="batch-style"
          data-active={expanded === 'style' ? 'true' : 'false'}
          title="统一字号、颜色、预设样式"
          onClick={() => setExpanded((current) => (current === 'style' ? 'none' : 'style'))}
        >
          样式
        </button>
      </div>

      {/* 平移展开行 */}
      {expanded === 'shift' ? (
        <div className="v-batchbar__panel" data-v="batch-shift-panel">
          <div className="v-batchbar__row">
            <input
              className="v-batchbar__input"
              data-v="batch-shift-value"
              type="number"
              min={0}
              step={shiftUnit === 'second' ? 0.1 : 1}
              value={shiftValue}
              onChange={(event) => setShiftValue(event.target.value)}
              aria-label="平移数值"
            />
            <select
              className="v-batchbar__select"
              data-v="batch-shift-unit"
              value={shiftUnit}
              onChange={(event) => setShiftUnit(event.target.value as ShiftUnit)}
              aria-label="平移单位"
            >
              <option value="second">秒</option>
              <option value="frame">帧</option>
            </select>
          </div>
          <div className="v-batchbar__row">
            <button
              type="button"
              className="v-batchbar__btn"
              data-v="batch-shift-back"
              onClick={() => doShift(true)}
            >
              ← 前移
            </button>
            <button
              type="button"
              className="v-batchbar__btn"
              data-v="batch-shift-forward"
              onClick={() => doShift(false)}
            >
              后移 →
            </button>
          </div>
        </div>
      ) : null}

      {/* 样式展开行 */}
      {expanded === 'style' ? (
        <div className="v-batchbar__panel" data-v="batch-style-panel">
          <div className="v-batchbar__label">套用模板</div>
          <div className="v-batchbar__chips">
            {templates.map((preset: TextPreset) => (
              <button
                key={preset.id}
                type="button"
                className="v-batchbar__chip"
                data-v="batch-template"
                data-preset-id={preset.id}
                onClick={() => {
                  const result = batchTemplate(clips, preset, size);
                  onNotice(result.message);
                }}
              >
                {preset.name}
              </button>
            ))}
          </div>

          <div className="v-batchbar__label">快捷调整</div>
          <div className="v-batchbar__row">
            <button
              type="button"
              className="v-batchbar__btn"
              data-v="batch-size-down"
              title="字号 −4"
              onClick={() => {
                // 以主选字号为基准，统一改（各条原本字号可能不同）
                const base = primary?.text?.fontSize ?? 64;
                const result = batchStyle(clips, { fontSize: Math.max(8, base - 4) });
                onNotice(result.message);
              }}
            >
              字号 −
            </button>
            <button
              type="button"
              className="v-batchbar__btn"
              data-v="batch-size-up"
              title="字号 +4"
              onClick={() => {
                const base = primary?.text?.fontSize ?? 64;
                const result = batchStyle(clips, { fontSize: Math.min(400, base + 4) });
                onNotice(result.message);
              }}
            >
              字号 ＋
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
