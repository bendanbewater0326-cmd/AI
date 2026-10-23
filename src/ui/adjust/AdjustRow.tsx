/**
 * 一行参数控件：**滑块 + 数值输入**双操作。
 *
 * ## 为什么需要它
 *
 * 现有属性栏只有 `range` 滑块 + 只读的 `<span>` 显示值，用户没法直接输入数字
 * （想把亮度精确设成 -20 只能靠拖）。本组件把两者并到一行，且**双向实时同步**。
 *
 * ## 提交时机（决定撤销步数）
 *
 * - **拖滑块**：`onChange` 每帧都调（实时预览），`onCommit` 只在**松手/键盘抬起**时调一次
 *   → 一次拖动 = 一个撤销步（否则拖 40px 会产生几十步，撤销到崩溃）。
 * - **数值框**：输入过程中**不提交**，`Enter` 或失焦才提交；`Esc` 放弃本次输入。
 * - 两边都 clamp 到 `[min, max]`，超范围不报错（静默修正）。
 *
 * ## `testId` 与 `data-v`
 *
 * ET 依赖 `data-v`。本组件生成两个：
 * - `data-v={testId}` —— 滑块（`input[type=range]`）
 * - `data-v={`${testId}-value`}` —— 数值输入框
 *
 * 属性栏与左栏调节面板各自传不同前缀（`inspector-*` / `adjust-*`），互不干扰。
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

export interface AdjustRowProps {
  label: string;
  value: number;
  /** 显示域的**最小值**（滑块与数值框都用它，不是内部值范围）。 */
  min: number;
  /** 显示域的**最大值**。 */
  max: number;
  /** 显示域的步进。 */
  step?: number;
  /** 内部值 → 显示值（默认原样）。如 `0..1` 的内部值显示成 `0..100`。 */
  toDisplay?: (value: number) => number;
  /** 显示值 → 内部值（`toDisplay` 的逆运算）。 */
  fromDisplay?: (display: number) => number;
  /** 拖动/输入过程中（实时预览），**每帧都会调**。 */
  onChange: (value: number) => void;
  /** 提交（一次撤销步）：松手 / Enter / 失焦时调。 */
  onCommit: (value: number) => void;
  disabled?: boolean;
  /** 行尾附加按钮（如关键帧 ◆）。 */
  extra?: ReactNode;
  /** `data-v` 前缀，如 `inspector-brightness` / `adjust-brightness`。 */
  testId: string;
  /**
   * 行布局。
   * - `inline`（默认）：标签 / 滑块 / 数值 **同一行**（左栏调节面板用，紧凑）
   * - `stack`：标签在上、滑块占满、数值右下（**属性栏原样式**，S5 复刻它以保证"用户无感知"）
   */
  layout?: 'inline' | 'stack';
  /** 滑块 aria-label（默认用 label）。 */
  ariaLabel?: string;
}

export function AdjustRow(props: AdjustRowProps): ReactElement {
  const {
    label,
    value,
    min,
    max,
    step = 1,
    toDisplay = (raw: number) => raw,
    fromDisplay = (shown: number) => shown,
    onChange,
    onCommit,
    disabled = false,
    extra,
    testId,
    ariaLabel,
    layout = 'inline',
  } = props;

  /** 输入框里的文本（编辑期间不被外部 value 覆盖）。 */
  const [draft, setDraft] = useState<string>(() => String(toDisplay(value)));
  const [editing, setEditing] = useState(false);
  /** 拖动中的最新值：松手时用它提交，避免闭包拿到旧 value。 */
  const liveRef = useRef<number>(value);

  // 外部值变化（撤销 / 另一侧面板改 / 滑条被拖）→ 同步输入框（编辑时不打断用户打字）
  useEffect(() => {
    liveRef.current = value;
    if (!editing) setDraft(String(toDisplay(value)));
  }, [value, editing, toDisplay]);

  /**
   * 把**显示值**夹到显示域。
   *
   * 注意 `min/max` 现在是显示域（如 `0..100`），不是内部值范围（如 `0..1`）——
   * 滑块与数值框必须用同一个量纲，否则用户拖到 50 会落到内部值 1（实测 ⑩c/⑪c 就这么红的）。
   */
  const clampDisplay = (display: number): number => Math.min(max, Math.max(min, display));

  /**
   * 提交输入框的值。
   *
   * **必须从事件里取最新文本**（`rawText`），不能只读 `draft` state：
   * React 的 `setDraft` 是异步的，用户"输入 → 立刻回车"时 `draft` 还是上一次的值，
   * 会导致这次输入被静默丢弃（实测 E2E ⑥ 就是这么红的）。
   */
  const commitDisplay = (rawText?: string): void => {
    const text = rawText ?? draft;
    const parsed = Number(text);
    if (text.trim() === '' || !Number.isFinite(parsed)) {
      // 非法输入：回退到当前值，不提交
      setDraft(String(toDisplay(liveRef.current)));
      return;
    }
    const next = fromDisplay(clampDisplay(parsed));
    liveRef.current = next;
    setDraft(String(toDisplay(next)));
    // **总是提交**，不在这里判"值没变"：`value` 是 UI 显示值，拖动/输入时已经被
    // `onChange` 改成新值了，拿它比较会永远相等 → 提交被静默跳过（实测 ⑥ 就是这么红的）。
    // "是否真的变了"由数据层判断（`core/adjust.ts` 里与 doc 当前值比），保证只有一个判断点。
    onCommit(next);
  };

  return (
    <div
      className={layout === 'stack' ? 'v-adjust__stack' : 'v-adjust__row'}
      data-v={`${testId}-row`}
    >
      <label className="v-adjust__label" htmlFor={`${testId}-range`}>
        {label}
      </label>
      <input
        id={`${testId}-range`}
        className="v-adjust__range"
        data-v={testId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={toDisplay(value)}
        disabled={disabled}
        aria-label={ariaLabel ?? label}
        onChange={(event) => {
          const next = fromDisplay(clampDisplay(Number(event.target.value)));
          liveRef.current = next;
          onChange(next);
        }}
        onPointerUp={() => onCommit(liveRef.current)}
        onKeyUp={() => onCommit(liveRef.current)}
        onBlur={() => onCommit(liveRef.current)}
      />
      <input
        className="v-adjust__number"
        data-v={`${testId}-value`}
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        disabled={disabled}
        aria-label={`${ariaLabel ?? label}（数值）`}
        onFocus={() => setEditing(true)}
        onChange={(event) => {
          setDraft(event.target.value);
          // 输入过程中也实时预览（合法数字才生效），但不 dispatch
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed)) {
            const next = fromDisplay(clampDisplay(parsed));
            liveRef.current = next;
            onChange(next);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commitDisplay((event.target as HTMLInputElement).value);
            setEditing(false);
            (event.target as HTMLInputElement).blur();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setDraft(String(toDisplay(value)));
            setEditing(false);
            (event.target as HTMLInputElement).blur();
          }
        }}
        onBlur={(event) => {
          setEditing(false);
          commitDisplay((event.target as HTMLInputElement).value);
        }}
      />
      {extra === undefined ? null : <div className="v-adjust__extra">{extra}</div>}
    </div>
  );
}
