/**
 * 一次性提示（M4 / R-046）：AI 改完只留一条 4 秒可撤销提示，不留聊天记录。
 *
 * 为什么不做"操作历史面板"：P1 要求默认界面里 AI 元素 ≤ 1 个，
 * 聊天记录/历史列表会让剪辑器变成聊天工具。撤销需求由这一条 toast + Ctrl+Z 覆盖。
 */
import { useEffect } from 'react';
import type { ReactElement } from 'react';

export interface ToastPayload {
  /** 每次新提示换一个 id，用于重置计时器（同一条连续触发也能重新计时）。 */
  id: number;
  label: string;
}

interface ToastProps {
  toast: ToastPayload | null;
  onUndo: () => void;
  onDismiss: () => void;
}

const TOAST_MS = 4000;

export function Toast({ toast, onUndo, onDismiss }: ToastProps): ReactElement | null {
  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(onDismiss, TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  if (toast === null) return null;
  return (
    <div className="v-toast" data-v="toast" role="status" aria-live="polite">
      <span className="v-toast__label">{toast.label}</span>
      <button type="button" className="v-toast__undo" data-v="toast-undo" onClick={onUndo}>
        撤销
      </button>
    </div>
  );
}
