/**
 * AI 通道注册表（M4）：宿主注入优先，其次离线规则，最后显式降级。
 *
 * 为什么不把 provider 塞进 React context：`mountVeditor` 是唯一挂载入口，
 * 宿主在**挂载前**就要决定有没有模型；用模块级注册表和 `store` 同模式，
 * 避免 App 里出现"先渲染再注入"的时序问题。
 */
import { createMockProvider, createNullProvider } from './provider';
import type { AIProvider } from './provider';

let current: AIProvider | null = null;

/** 宿主注入（`mountVeditor({ aiModel })` 或未来的云 LLM 适配器）。 */
export function setAIProvider(provider: AIProvider | null): void {
  current = provider;
}

/**
 * 取当前通道。
 *
 * 默认给**离线规则引擎**：它走同一套意图协议，能在没有模型时把整条链路跑通
 * （命令栏 → 意图 → 编译 → 撤销栈 → toast）。`?ai=off` 用于验收 R-048 的降级态。
 */
export function getAIProvider(): AIProvider {
  if (current !== null) return current;
  if (typeof window !== 'undefined') {
    const flag = new URLSearchParams(window.location.search).get('ai');
    if (flag === 'off') {
      current = createNullProvider();
      return current;
    }
  }
  current = createMockProvider();
  return current;
}

/** 是否真的能用（`null` provider 视为不可用，`✦` 置灰）。 */
export function isAIUsable(): boolean {
  return getAIProvider().id !== 'null';
}

/** 测试用：重置为"未注入"。 */
export function resetAIProvider(): void {
  current = null;
}
