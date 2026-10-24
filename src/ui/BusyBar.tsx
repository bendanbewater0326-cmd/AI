/**
 * 顶部全局 busy 条（体验打磨批 1，2026-10-25）。
 *
 * ## 为什么现在才有的
 *
 * `store.setBusy(label)` 从上线起就有 33 处调用（素材导入/音频导出/工程包/重链…），
 * 但 `busyLabel` 从未被任何 UI 渲染——所有异步操作的"进行中"状态一直不可见
 * （又一处"数据层有、界面没接"，同 S4 悬停态）。本组件只做渲染，业务调用零改动。
 *
 * ## 形态
 *
 * - 视觉对齐错误条（`v-errorbar`）同一套体系，放顶栏下方；无任务时**不占空间**（null 不渲染）。
 * - 单值语义：`busyLabel` 是"最后一个 set 的值"，并发场景显示最后设置的任务
 * （不做队列——用户拍板保持简洁）。
 * - 带进度的文案（「正在导出音频… 37%」）由调用方拼好字符串，这里原样展示。
 */
import type { ReactElement } from 'react';
import { useBusyLabel } from '../core/store';

export function BusyBar(): ReactElement | null {
  const label = useBusyLabel();
  if (label === null) return null;
  return (
    <div className="v-busybar" data-v="busybar" role="status" aria-live="polite" aria-busy="true">
      <span className="v-busybar__spinner" aria-hidden="true" />
      <span className="v-busybar__label" data-v="busy-label">{label}</span>
    </div>
  );
}
