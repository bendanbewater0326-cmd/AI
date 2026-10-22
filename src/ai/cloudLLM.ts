/**
 * 云 LLM 通道（M4 的"接真模型"路径）。
 *
 * ## 为什么用 fetch 而不是 SDK
 *
 * 项目定案是"最小依赖"（`package.json` 只有 react / mp4-muxer / gifenc）。
 * WorkBuddy 云服务的 LLM 模块本质上是一个 HTTP API（`/.cloud/llm/chat/completions`），
 * 用 fetch 即可，不必为此引入 `@tencent-ai/workbuddy-cloud-sdk`。
 * 真要 SSE 流式输出时再考虑 SDK（当前离线规则与宿主注入都是一次性返回，够用）。
 *
 * ## 前提
 *
 * 需要**已开通的云服务环境**（`endpoint` + `publishableKey` 来自 `publicConfig`）。
 * 开通会在 WorkBuddy UI 里弹确认框。**没有开通时 `complete()` 会失败**，
 * 调用方（`createHostProvider`）会捕获并走降级路径，不会崩。
 *
 * ## 用法
 *
 * ```ts
 * import { mountVeditor } from './host/host';
 * import { createCloudLLMModel } from './ai/cloudLLM';
 *
 * mountVeditor(el, {
 *   aiModel: createCloudLLMModel({
 *     endpoint: 'https://xxx.workbuddy.cn',
 *     publishableKey: 'wb_pk_...',
 *     model: 'gpt-4o-mini',          // 可选，不传用云端默认
 *   }),
 * });
 * ```
 *
 * ## 安全
 *
 * - `publishableKey` 是**可公开**的 key（仅限客户端，写进前端代码无风险）
 * - 请求只带 prompt + 结构化工程上下文（帧号/轨道/片段属性），**不带素材字节**
 * - 隐私行已在 UI 常驻提示（"将发送：指令文本 + 帧率/时长/轨道结构 · 不上传素材"）
 */
import type { AIModelPort } from '../host/host';

export interface CloudLLMConfig {
  /** 云服务 endpoint（例如 `https://xxx.workbuddy.cn`） */
  endpoint: string;
  /** WorkBuddy publishable key（`wb_pk_...`，可公开） */
  publishableKey: string;
  /** 模型 id（可选，不传用云端默认） */
  model?: string;
  /** 系统提示词（可选，默认用 AI 层通用系统提示词） */
  systemPrompt?: string;
  /** 请求超时（ms，默认 30s） */
  timeoutMs?: number;
  /** 401/403 时的回调（用于 UI 提示"云环境未开通"） */
  onUnauthorized?: () => void;
  /** 非 2xx 时的回调（用于日志/Toast） */
  onError?: (status: number, message: string) => void;
}

/** 默认系统提示词：与 `provider.ts` 里的保持一致（模型只输出意图，不输出操作）。 */
const DEFAULT_SYSTEM_PROMPT = `你是视频剪辑助手。根据用户的中文指令，输出 JSON：
{
  "message": "给用户看的一句话",
  "intents": [ ... ]
}

intents 里的每项是 { "type": "...", ... }，type 取值由剪辑器的意图白名单决定。
不要输出多余的解释文字，只输出 JSON。`;

/**
 * 云 LLM 模型（实现 `AIModelPort`）。
 *
 * 失败时抛 Error（调用方 `createHostProvider` 会 catch 并走降级）。
 */
export function createCloudLLMModel(config: CloudLLMConfig): AIModelPort {
  const endpoint = config.endpoint.replace(/\/$/, '');

  return {
    async complete(req: { prompt: string; context: unknown }): Promise<{ text: string }> {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        config.timeoutMs ?? 30_000,
      );

      try {
        const response = await fetch(`${endpoint}/.cloud/llm/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.publishableKey}`,
          },
          signal: controller.signal,
          body: JSON.stringify({
            ...(config.model === undefined ? {} : { model: config.model }),
            stream: false,
            messages: [
              { role: 'system', content: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
              {
                role: 'user',
                content: `${req.prompt}\n\n<project-context>${JSON.stringify(req.context ?? {})}</project-context>`,
              },
            ],
          }),
        });

        if (response.status === 401 || response.status === 403) {
          config.onUnauthorized?.();
          throw new Error(`云 LLM 未授权（${response.status}）：云环境可能未开通`);
        }
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          config.onError?.(response.status, detail);
          throw new Error(`云 LLM 调用失败（${response.status}）：${detail.slice(0, 200)}`);
        }

        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const text = data.choices?.[0]?.message?.content ?? '';
        if (text === '') {
          throw new Error('云 LLM 返回空文本');
        }
        return { text };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
