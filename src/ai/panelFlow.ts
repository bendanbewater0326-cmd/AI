/**
 * 面板 AI 入口的共用调用链（complete → parse → compileIntents）。
 *
 * 为什么抽出来：文本「AI 文案」与特效「AI 风格调色」是同一件事的两个入口——
 * 拼 prompt、调通道、编译意图、错误归一。复制两份就会造出"第二个 AI 调用实现"。
 *
 * 职责边界：**不含 dispatch**（store 是 UI 层的事），返回待提交的 ops + summary，
 * 调用方一次 `store.dispatch(ops, summary, 'ai')` = 一个撤销步（与命令栏同规则）。
 */
import type { ClipOperation, Project, Result } from '../core/types';
import { makeError } from '../core/types';
import { buildProjectContext, serializeContext } from './context';
import { getAIProvider } from './registry';
import { compileIntents } from './intents';
import type { AIIntent } from './intents';

export interface PanelAIRequest {
  /** 用户输入（主题/风格描述）。 */
  text: string;
  /** 提示词模板（面板拼接：主题 + 风格 + 能力说明）。 */
  instruction: string;
  doc: Project;
  selectedClipId: string | null;
  playheadFrame: number;
}

export interface PanelAIPlan {
  ops: ClipOperation[];
  summary: string;
  /** 给用户看的话（mock 的"（离线演示）"标注就在这里）。 */
  message: string;
}

/**
 * 跑一条面板 AI 指令：把 instruction 交给当前通道，意图编译成操作。
 *
 * 面板入口只产生**单一种类**的意图（文案 / 调色），但这里不做限制——
 * 编译器白名单与校验是同一道闸门，模型多给了别的意图也会被统一编译/拒绝。
 */
export async function runPanelAI(request: PanelAIRequest): Promise<Result<PanelAIPlan>> {
  const provider = getAIProvider();
  const context = buildProjectContext(request.doc, request.selectedClipId);
  const response = await provider.complete({
    text: request.instruction,
    tone: 'command',
    doc: request.doc,
    selectedClipId: request.selectedClipId,
    playheadFrame: request.playheadFrame,
    contextJson: serializeContext(context),
  });
  if (!response.ok) return response;
  const compiled = compileIntents(request.doc, response.value.intents as AIIntent[]);
  if (!compiled.ok) {
    return {
      ok: false,
      error: makeError('E_DECODE_FAILED', `AI 没有产生可执行的修改：${compiled.error}`),
    };
  }
  return {
    ok: true,
    value: { ops: compiled.ops, summary: compiled.summary, message: response.value.message },
  };
}
