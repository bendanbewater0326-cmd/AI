/**
 * 左栏「调节」面板：**精细调参数**（与「特效」面板的"选风格"配对）。
 *
 * ## 与特效面板的分工
 *
 * | 面板 | 做什么 | 写什么 |
 * |---|---|---|
 * | 特效 | 点卡片套用 14 个调色预设 | `colorGrade` 的 params |
 * | **调节** | 拖滑块 / 输数值，逐参数微调 | 同一份 `clip.effects` |
 *
 * 两者指向**同一个数据源**，所以天然双向同步：在调节里改一个滑块，特效面板的
 * "已应用"高亮会消失（参数不再等于任何预设）；在特效里点一张卡，这里的滑块立刻变。
 *
 * ## 组结构与默认态（用户指定）
 *
 * 基础调色（默认展开）→ 曲线 → LUT → 蒙版（后三组默认折叠）。
 *
 * ## 目标片段：不要求先选中
 *
 * 很多用户会直接拖滑块，所以规则是「**选中优先，否则播放头所在片段**」
 * （`resolveEffectTarget`，与特效面板的拖拽落点共用同一份实现）。
 * 都没有时面板禁用并给一句具体原因，而不是留一堆"看起来能点但没用"的控件。
 *
 * ## 拖动时的显示值：本地 draft
 *
 * 滑块 `value` 来自 doc，但拖动过程中 doc 还没变 —— 如果只用 doc 值，滑块会"回弹"。
 * 所以用 `live*` 本地状态承接拖动中的值，**松手（onCommit）才 dispatch**（一次拖动 = 一个撤销步，
 * 与属性栏的既有行为一致）。
 */
import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useDoc, useSelection } from '../../core/store';
import { resolveEffectTarget } from '../../core/effectTarget';
import {
  NEUTRAL_GRADE,
  addMask,
  applyCurve,
  applyGrade,
  applyLutStrength,
  applyMask,
  readCurve,
  readGrade,
  readLut,
  readMask,
  removeLut,
  removeMask,
  resetCurve,
  resetGrade,
} from '../../core/adjust';
import type { ColorGrade } from '../../render/compositor';
import type { CurveParams } from '../../render/curve';
import type { MaskParams, MaskShape } from '../../render/mask';
import { AdjustRow } from './AdjustRow';
import { CollapsibleSection } from './CollapsibleSection';

/** 调色的 4 个参数（中文名按国内剪辑习惯）。 */
const GRADE_ROWS: Array<{ key: keyof ColorGrade; label: string }> = [
  { key: 'brightness', label: '亮度' },
  { key: 'contrast', label: '对比' },
  { key: 'saturation', label: '饱和' },
  { key: 'temperature', label: '色温' },
];

export function AdjustPanel(): ReactElement {
  const selectedId = useSelection();

  /**
   * 目标片段的**标识字符串**（不是对象）。
   *
   * `useDoc` 用 `Object.is` 比快照，返回新对象会无限重渲染；返回字符串则只有
   * "目标真的换了"（选中变了 / 播放头跨片段）才重渲染。这也是 EffectPanel 的处理方式。
   */
  const targetKey = useDoc((doc) => {
    const target = resolveEffectTarget(doc, selectedId, doc.playheadFrame);
    return 'clip' in target ? `clip:${target.clip.id}` : `msg:${target.message}`;
  });

  /** 目标 clip 本体（doc 不变时引用稳定，不会触发多余重渲染）。 */
  const clip = useDoc((doc) => {
    if (!targetKey.startsWith('clip:')) return null;
    const id = targetKey.slice(5);
    for (const track of doc.tracks) {
      const found = track.clips.find((candidate) => candidate.id === id);
      if (found !== undefined) return found;
    }
    return null;
  });

  // ---- 显示值：doc 派生 + 拖动中的临时值 ----
  const [liveGrade, setLiveGrade] = useState<ColorGrade | null>(null);
  const [liveCurve, setLiveCurve] = useState<CurveParams | null>(null);
  const [liveStrength, setLiveStrength] = useState<number | null>(null);
  const [liveMask, setLiveMask] = useState<MaskParams | null>(null);

  // 切换目标片段时清掉临时值，否则会拿上一个片段拖动中的值去显示
  const clipId = clip?.id ?? null;
  useEffect(() => {
    setLiveGrade(null);
    setLiveCurve(null);
    setLiveStrength(null);
    setLiveMask(null);
  }, [clipId]);

  const grade = liveGrade ?? (clip === null ? { ...NEUTRAL_GRADE } : readGrade(clip));
  const curve = liveCurve ?? (clip === null ? null : readCurve(clip));
  const lut = clip === null ? { title: '', strength: 1, loaded: false } : readLut(clip);
  const strength = liveStrength ?? lut.strength;
  const mask = liveMask ?? (clip === null ? null : readMask(clip));

  const disabled = clip === null;

  const commitGrade = useCallback(
    (patch: Partial<ColorGrade>, label: string): void => {
      if (clipId === null) return;
      applyGrade(clipId, patch, label);
      setLiveGrade(null);
    },
    [clipId],
  );

  const commitCurve = useCallback(
    (patch: Partial<CurveParams>): void => {
      if (clipId === null) return;
      applyCurve(clipId, patch);
      setLiveCurve(null);
    },
    [clipId],
  );

  // ---- 无目标时的提示 ----
  if (disabled) {
    const message = targetKey.startsWith('msg:') ? targetKey.slice(4) : '先选中一个片段，或把播放头移到片段上';
    return (
      <div className="v-adjust-panel" data-v="adjust-panel" data-disabled="true">
        <div className="v-adjust__hint" data-tone="warn" data-v="adjust-hint">
          {message}
        </div>
        <div className="v-adjust__empty">选中片段后，这里可以调亮度、对比、曲线、LUT 与蒙版。</div>
      </div>
    );
  }

  return (
    <div className="v-adjust-panel" data-v="adjust-panel">
      <div className="v-adjust__hint" data-v="adjust-target">
        正在调节：<strong>{clip === null ? '' : describeClip(clip)}</strong>
      </div>

      {/* ---------- 基础调色（默认展开） ---------- */}
      <CollapsibleSection
        title="基础调色"
        groupKey="adjust:grade"
        defaultOpen
        testId="adjust-group-grade"
        actions={
          <button
            type="button"
            className="v-adjust__mini"
            data-v="adjust-grade-reset"
            disabled={clip !== null && readGrade(clip).brightness === 0 && readGrade(clip).contrast === 0 && readGrade(clip).saturation === 0 && readGrade(clip).temperature === 0}
            onClick={() => {
              if (clipId !== null) {
                resetGrade(clipId);
                setLiveGrade(null);
              }
            }}
          >
            重置
          </button>
        }
      >
        {GRADE_ROWS.map(({ key, label }) => (
          <AdjustRow
            key={key}
            label={label}
            testId={`adjust-${key}`}
            value={grade[key]}
            min={-100}
            max={100}
            step={1}
            disabled={disabled}
            onChange={(next) => setLiveGrade({ ...grade, [key]: next })}
            onCommit={(next) => commitGrade({ [key]: next } as Partial<ColorGrade>, `调整${label}`)}
          />
        ))}
      </CollapsibleSection>

      {/* ---------- 曲线（默认折叠） ---------- */}
      <CollapsibleSection
        title="曲线"
        groupKey="adjust:curve"
        testId="adjust-group-curve"
        actions={
          <button
            type="button"
            className="v-adjust__mini"
            data-v="adjust-curve-reset"
            disabled={clip === null || readCurve(clip).y1 === 0.25 && readCurve(clip).y2 === 0.75}
            onClick={() => {
              if (clipId !== null) {
                resetCurve(clipId);
                setLiveCurve(null);
              }
            }}
          >
            重置
          </button>
        }
      >
        <AdjustRow
          label="暗部"
          testId="adjust-curve-shadow"
          value={curve === null ? 0.25 : curve.y1}
          min={0}
          max={100}
          step={1}
          toDisplay={(raw) => Math.round(raw * 100)}
          fromDisplay={(shown) => shown / 100}
          disabled={disabled}
          onChange={(next) => setLiveCurve({ ...(curve ?? { x1: 0.25, y1: 0.25, x2: 0.75, y2: 0.75 }), y1: next })}
          onCommit={(next) => commitCurve({ y1: next })}
        />
        <AdjustRow
          label="亮部"
          testId="adjust-curve-highlight"
          value={curve === null ? 0.75 : curve.y2}
          min={0}
          max={100}
          step={1}
          toDisplay={(raw) => Math.round(raw * 100)}
          fromDisplay={(shown) => shown / 100}
          disabled={disabled}
          onChange={(next) => setLiveCurve({ ...(curve ?? { x1: 0.25, y1: 0.25, x2: 0.75, y2: 0.75 }), y2: next })}
          onCommit={(next) => commitCurve({ y2: next })}
        />
      </CollapsibleSection>

      {/* ---------- LUT（默认折叠；载入入口仍在属性栏） ---------- */}
      <CollapsibleSection
        title="LUT"
        groupKey="adjust:lut"
        testId="adjust-group-lut"
        actions={
          <button
            type="button"
            className="v-adjust__mini"
            data-v="adjust-lut-remove"
            disabled={!lut.loaded}
            onClick={() => {
              if (clipId !== null) {
                removeLut(clipId);
                setLiveStrength(null);
              }
            }}
          >
            移除
          </button>
        }
      >
        {lut.loaded ? (
          <>
            <div className="v-adjust__empty" data-v="adjust-lut-title" style={{ textAlign: 'left', padding: '2px 0' }}>
              已载入：{lut.title}
            </div>
            <AdjustRow
              label="强度"
              testId="adjust-lut-strength"
              value={strength}
              min={0}
              max={100}
              step={1}
              toDisplay={(raw) => Math.round(raw * 100)}
              fromDisplay={(shown) => shown / 100}
              disabled={disabled}
              onChange={(next) => setLiveStrength(next)}
              onCommit={(next) => {
                if (clipId !== null) {
                  applyLutStrength(clipId, next);
                  setLiveStrength(null);
                }
              }}
            />
          </>
        ) : (
          <div className="v-adjust__empty" data-v="adjust-lut-empty">
            还没有载入 LUT。请在右侧属性栏「LUT」组选择一个 .cube 文件。
          </div>
        )}
      </CollapsibleSection>

      {/* ---------- 蒙版（默认折叠；关键帧仍在属性栏） ---------- */}
      <CollapsibleSection
        title="蒙版"
        groupKey="adjust:mask"
        testId="adjust-group-mask"
        actions={
          mask === null ? null : (
            <button
              type="button"
              className="v-adjust__mini"
              data-v="adjust-mask-remove"
              onClick={() => {
                if (clipId !== null) {
                  removeMask(clipId);
                  setLiveMask(null);
                }
              }}
            >
              移除
            </button>
          )
        }
      >
        {mask === null ? (
          <>
            <div className="v-adjust__empty" data-v="adjust-mask-empty">
              这个片段还没有蒙版。
            </div>
            <button
              type="button"
              className="v-adjust__mini"
              data-v="adjust-mask-add"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => {
                if (clipId !== null) addMask(clipId);
              }}
            >
              ＋ 添加蒙版
            </button>
          </>
        ) : (
          <>
            <div className="v-adjust__select-row">
              <label className="v-adjust__label" htmlFor="adjust-mask-shape">
                形状
              </label>
              <select
                id="adjust-mask-shape"
                className="v-adjust__select"
                data-v="adjust-mask-shape"
                value={mask.shape}
                onChange={(event) => {
                  const shape = event.target.value as MaskShape;
                  setLiveMask({ ...mask, shape });
                  if (clipId !== null) applyMask(clipId, { shape }, '修改蒙版形状');
                }}
              >
                <option value="rect">矩形</option>
                <option value="ellipse">椭圆</option>
              </select>
            </div>
            {([
              // 与属性栏的 5 个参数一一对应（**羽化不能少**：属性栏有，这里没有就是功能缺失）
              // w/h 的内部下限是 0.02（避免宽高为 0 变成不可见的挖洞），见属性栏同一张表
              ['x', '左右', mask.x, 0, 100],
              ['y', '上下', mask.y, 0, 100],
              ['w', '宽度', mask.w, 2, 100],
              ['h', '高度', mask.h, 2, 100],
              ['feather', '羽化', mask.feather, 0, 50],
            ] as Array<['x' | 'y' | 'w' | 'h' | 'feather', string, number, number, number]>).map(
              ([key, label, current, min, max]) => (
              <AdjustRow
                key={key}
                label={label}
                testId={`adjust-mask-${key}`}
                value={current}
                min={min}
                max={max}
                step={1}
                toDisplay={(raw) => Math.round(raw * 100)}
                fromDisplay={(shown) => shown / 100}
                disabled={disabled}
                onChange={(next) => setLiveMask({ ...mask, [key]: next })}
                onCommit={(next) => {
                  if (clipId !== null) {
                    applyMask(clipId, { [key]: next } as Partial<MaskParams>, `调整蒙版${label}`);
                    setLiveMask(null);
                  }
                }}
              />
            ),
            )}
            <div className="v-adjust__switch-row">
              <input
                id="adjust-mask-invert"
                data-v="adjust-mask-invert"
                type="checkbox"
                checked={mask.invert}
                onChange={(event) => {
                  const invert = event.target.checked;
                  setLiveMask({ ...mask, invert });
                  if (clipId !== null) applyMask(clipId, { invert }, invert ? '蒙版改为保留外部' : '蒙版改为保留内部');
                }}
              />
              <label htmlFor="adjust-mask-invert">反转（保留区域外）</label>
            </div>
            <div className="v-adjust__empty" style={{ textAlign: 'left', padding: '2px 0' }}>
              关键帧打点请在右侧属性栏「蒙版」组操作。
            </div>
          </>
        )}
      </CollapsibleSection>
    </div>
  );
}

/** 提示条上的一句话描述（不暴露内部 id）。 */
function describeClip(clip: { id: string; text?: unknown; role?: string }): string {
  if (clip.text !== null && clip.text !== undefined) return '文字片段';
  if (clip.role === 'audio') return '音频片段';
  return '当前视频片段';
}
