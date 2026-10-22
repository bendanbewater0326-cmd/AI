/**
 * 模型通道（M4）：把"一句话"变成意图数组。
 *
 * ## 三个实现，同一个端口
 *
 * | 实现 | 用途 | 是否需要网络 |
 * |---|---|---|
 * | `createHostProvider` | 宿主注入的模型（任意 agent 都能接，符合 Q11） | 取决于宿主 |
 * | `createMockProvider` | 无模型时的离线演示 + E2E 测试（规则式中文解析） | 否 |
 * | `createNullProvider` | 客户端不提供模型时的显式降级（R-048） | 否 |
 *
 * 云 LLM（WorkBuddy 云服务 `/.cloud/llm/chat/completions`）走的是 `createHostProvider`：
 * 把云调用包成 `AIModelPort` 即可，AI 层不需要知道通道是什么。
 *
 * ## 为什么模型只输出"意图"而不是操作
 *
 * 见 `intents.ts` 文件头：操作带载荷，模型编不出来也不该编。这里只做
 * "文本 → 意图数组"的解析与白名单过滤，编译与校验交给 `compileIntents`。
 */
import type { Project, Result, TranscribeRequest, Transcript } from '../core/types';
import { makeError, ok, fail } from '../core/types';
import { secondsToFrames } from '../core/timebase';
import type { AIModelPort } from '../host/host';
import type { AIIntent, AIPropertyPath } from './intents';
import type { Tone } from './tone';

export interface AIRequest {
  text: string;
  tone: Tone;
  doc: Project;
  selectedClipId: string | null;
  playheadFrame: number;
  /** 已序列化的工程上下文（由调用方用 `serializeContext` 生成，避免重复计算）。 */
  contextJson?: string;
}

export interface AIResponse {
  /** 给用户看的话（建议模式下就是建议正文）。 */
  message: string;
  /** 结构化意图；建议模式下通常为空（只有 suggestCut）。 */
  intents: AIIntent[];
}

export interface AIProvider {
  readonly id: string;
  readonly label: string;
  complete(request: AIRequest): Promise<Result<AIResponse>>;
  /**
   * 语音识别（R-059）：**只有宿主提供了转写通道才有**。
   *
   * 故意不在这里兜底成"返回空数组"——那会让用户以为"识别完成了，只是没说话"，
   * 而真相是"这台客户端根本没有识别能力"。没有就 `undefined`，命令栏据此给可读拒绝。
   */
  transcribe?(request: TranscribeRequest): Promise<Transcript>;
}

/* ---------------- 系统提示词 ---------------- */

/**
 * 系统提示词：约束输出为 JSON，且只允许白名单意图。
 *
 * 注意措辞——**不要**说"你可以修改时间线"，否则模型会开始编造 clip 对象；
 * 要说"你只能提交意图，执行由客户端完成"。
 */
export const SYSTEM_PROMPT = `你是视频剪辑助手，把用户的一句话翻译成剪辑意图（JSON），不写解释性代码。

规则：
1. 只输出 JSON，形如 {"message":"给用户看的一句话","intents":[...]}，不要 markdown 代码块。
2. 时间一律用**整数项目帧**，不要用秒（上下文里给了 fps，可自行换算）。
3. 可用意图（kind 必须是其中之一）：
   - {"kind":"removeClip","clipId":"..."}
   - {"kind":"removeRange","clipId":"...","startFrame":0,"endFrame":30}
   - {"kind":"splitAt","frame":120,"clipId":"可选"}
   - {"kind":"moveClip","clipId":"...","startFrame":0,"trackId":"可选"}
   - {"kind":"trimClip","clipId":"...","inFrame":0,"outFrame":240}
   - {"kind":"setProperty","clipId":"...","path":"transform.scale|transform.x|transform.y|transform.opacity|transform.blendMode|audio.gain","value":1}
   - {"kind":"addTrack","trackKind":"video|audio","name":"可选"}
   - {"kind":"muteTrack","trackId":"...","muted":true}
   - {"kind":"suggestCut","frame":120,"label":"建议理由"}
4. 只能引用上下文里真实存在的 clipId / trackId，不得编造。
5. 如果用户是在提问（为什么/怎么/建议），intents 里只放 suggestCut 或不放，message 给出理由。
6. 如果无法完成，intents 为空数组，message 说明原因。`;

/** 组装完整 prompt（宿主模型通常只吃一个字符串）。 */
export function buildPrompt(request: AIRequest, contextJson: string): string {
  return [
    SYSTEM_PROMPT,
    '',
    `工程上下文：${contextJson}`,
    `播放头：第 ${request.playheadFrame} 帧`,
    `选中片段：${request.selectedClipId ?? '无'}`,
    `用户原话：${request.text}`,
  ].join('\n');
}

/* ---------------- 解析（模型输出 → 意图） ---------------- */

const INTENT_KINDS = new Set([
  'removeClip',
  'removeRange',
  'splitAt',
  'moveClip',
  'trimClip',
  'setProperty',
  'addTrack',
  'muteTrack',
  'suggestCut',
]);

const PROPERTY_PATHS = new Set<AIPropertyPath>([
  'transform.scale',
  'transform.x',
  'transform.y',
  'transform.opacity',
  'transform.blendMode',
  'audio.gain',
]);

/** 从模型输出里抠出 JSON（容忍 ```json 围栏与前后废话）。 */
export function extractJson(text: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 校验并归一化意图。
 *
 * 这里只做**形状**校验（kind/字段类型/白名单），合法性（片段是否存在、是否越界）
 * 由 `compileIntents` 用 doc 判定——两层分开，才能分别单测。
 */
export function normalizeIntents(raw: unknown): { intents: AIIntent[]; dropped: string[] } {
  const dropped: string[] = [];
  if (!Array.isArray(raw)) return { intents: [], dropped: ['intents 不是数组'] };
  const intents: AIIntent[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      dropped.push('非对象意图');
      continue;
    }
    const value = item as Record<string, unknown>;
    const kind = String(value['kind'] ?? '');
    if (!INTENT_KINDS.has(kind)) {
      dropped.push(`未知意图 ${kind}`);
      continue;
    }
    const clipId = value['clipId'] === undefined ? undefined : String(value['clipId']);
    const num = (key: string): number | undefined => {
      const raw = value[key];
      if (raw === undefined || raw === null) return undefined;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : undefined;
    };

    switch (kind) {
      case 'removeClip':
        if (clipId === undefined) dropped.push('removeClip 缺少 clipId');
        else intents.push({ kind: 'removeClip', clipId });
        break;
      case 'removeRange': {
        const startFrame = num('startFrame');
        const endFrame = num('endFrame');
        if (clipId === undefined || startFrame === undefined || endFrame === undefined) {
          dropped.push('removeRange 字段不全');
        } else intents.push({ kind: 'removeRange', clipId, startFrame, endFrame });
        break;
      }
      case 'splitAt': {
        const frame = num('frame');
        if (frame === undefined) dropped.push('splitAt 缺少 frame');
        else intents.push({ kind: 'splitAt', frame, ...(clipId === undefined ? {} : { clipId }) });
        break;
      }
      case 'moveClip': {
        const startFrame = num('startFrame');
        if (clipId === undefined || startFrame === undefined) dropped.push('moveClip 字段不全');
        else
          intents.push({
            kind: 'moveClip',
            clipId,
            startFrame,
            ...(value['trackId'] === undefined ? {} : { trackId: String(value['trackId']) }),
          });
        break;
      }
      case 'trimClip': {
        const inFrame = num('inFrame');
        const outFrame = num('outFrame');
        if (clipId === undefined) dropped.push('trimClip 缺少 clipId');
        else
          intents.push({
            kind: 'trimClip',
            clipId,
            ...(inFrame === undefined ? {} : { inFrame }),
            ...(outFrame === undefined ? {} : { outFrame }),
          });
        break;
      }
      case 'setProperty': {
        const path = String(value['path'] ?? '');
        if (clipId === undefined || !PROPERTY_PATHS.has(path as AIPropertyPath)) {
          dropped.push('setProperty 路径不在白名单');
        } else {
          const raw = value['value'];
          const normalized = typeof raw === 'string' ? raw : Number(raw);
          intents.push({
            kind: 'setProperty',
            clipId,
            path: path as AIPropertyPath,
            value: normalized,
          });
        }
        break;
      }
      case 'addTrack': {
        const trackKind = String(value['trackKind'] ?? 'video');
        if (trackKind !== 'video' && trackKind !== 'audio') dropped.push('addTrack 轨道类型非法');
        else
          intents.push({
            kind: 'addTrack',
            trackKind,
            ...(value['name'] === undefined ? {} : { name: String(value['name']) }),
          });
        break;
      }
      case 'muteTrack': {
        const trackId = value['trackId'] === undefined ? undefined : String(value['trackId']);
        if (trackId === undefined) dropped.push('muteTrack 缺少 trackId');
        else intents.push({ kind: 'muteTrack', trackId, muted: value['muted'] !== false });
        break;
      }
      case 'suggestCut': {
        const frame = num('frame');
        if (frame === undefined) dropped.push('suggestCut 缺少 frame');
        else
          intents.push({
            kind: 'suggestCut',
            frame,
            label: String(value['label'] ?? '建议切点'),
          });
        break;
      }
      default:
        dropped.push(`未处理意图 ${kind}`);
    }
  }
  return { intents, dropped };
}

/** 解析模型文本 → AIResponse。 */
export function parseAIResponse(text: string): Result<AIResponse> {
  const json = extractJson(text);
  if (json === null || typeof json !== 'object') {
    return fail(makeError('E_DECODE_FAILED', '模型没有返回可解析的 JSON', text.slice(0, 200)));
  }
  const record = json as Record<string, unknown>;
  const message = typeof record['message'] === 'string' ? record['message'] : '';
  const { intents, dropped } = normalizeIntents(record['intents'] ?? []);
  if (intents.length === 0 && message === '') {
    return fail(makeError('E_DECODE_FAILED', '模型返回空结果', dropped.join('；')));
  }
  return ok({ message, intents });
}

/* ---------------- 宿主模型 ---------------- */

/**
 * 把宿主注入的模型包成 provider。
 *
 * 宿主可以两种方式回应：
 * ① 直接给 `operations`（`ClipOperation[]`）——本项目**不使用**，因为无法校验载荷；
 * ② 给文本 JSON —— 走本文件的解析 + 白名单，安全。
 */
export function createHostProvider(port: AIModelPort, label = '宿主模型'): AIProvider {
  const provider: AIProvider = {
    id: 'host',
    label,
    async complete(request: AIRequest): Promise<Result<AIResponse>> {
      const prompt = buildPrompt(request, request.contextJson ?? '{}');
      try {
        const response = await port.complete({ prompt, context: request.contextJson ?? null });
        return parseAIResponse(response.text);
      } catch (error) {
        return fail(
          makeError('E_DECODE_FAILED', '模型调用失败', error instanceof Error ? error.message : String(error)),
        );
      }
    },
  };
  // 转写通道按需透传：宿主没实现就不挂这个方法（挂一个空实现等于假装有能力）
  if (port.transcribe !== undefined) {
    provider.transcribe = (request: TranscribeRequest) => port.transcribe!(request);
  }
  return provider;
}

/* ---------------- 离线规则引擎（mock） ---------------- */

function firstEditableClip(doc: Project, selectedClipId: string | null) {
  if (selectedClipId !== null) {
    for (const track of doc.tracks) {
      const clip = track.clips.find((candidate) => candidate.id === selectedClipId);
      if (clip !== undefined) return clip;
    }
  }
  for (const track of doc.tracks) {
    if (track.kind !== 'video') continue;
    const clip = track.clips[0];
    if (clip !== undefined) return clip;
  }
  for (const track of doc.tracks) {
    const clip = track.clips[0];
    if (clip !== undefined) return clip;
  }
  return null;
}

function secondsPattern(text: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*(?:秒|s\b)/i.exec(text);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * 离线规则引擎。
 *
 * 它不是"假 AI"——它是**同一套意图协议**的确定性实现，用来在没有模型时
 * 验证整条链路（命令栏 → 意图 → 编译 → 撤销栈 → toast），也是 E2E 的夹具。
 * 接上真模型后它自动退居"无模型降级"位置。
 */
export function createMockProvider(): AIProvider {
  return {
    id: 'mock',
    label: '离线规则（演示）',
    async complete(request: AIRequest): Promise<Result<AIResponse>> {
      const text = request.text.trim();
      const doc = request.doc;
      const fps = doc.fpsMilli;
      const clip = firstEditableClip(doc, request.selectedClipId);
      const toFrames = (sec: number): number => secondsToFrames(sec, fps);

      // ---- 建议模式：只给理由 + 建议切点 ----
      if (request.tone === 'question') {
        const marks: AIIntent[] = [];
        const at = request.playheadFrame;
        const inside = doc.tracks.some((track) =>
          track.clips.some((c) => at > c.startFrame && at < c.startFrame + c.durationFrames),
        );
        if (inside) marks.push({ kind: 'suggestCut', frame: at, label: '播放头处' });
        const reason = clip === null
          ? '时间线上还没有片段，先把素材拖上轨道，我再看切点。'
          : `这个位置在第 ${at} 帧。判断要不要切，看三件事：画面主体是否完成一次动作、台词是否说完一个意思、` +
            `以及这一段和下一段的景别是否重复。当前片段共 ${clip.durationFrames} 帧（第 ${clip.startFrame}–${clip.startFrame + clip.durationFrames} 帧），` +
            `如果这之后还有新信息，就在这里切；只是同一句话的换气，建议保留。`;
        return ok({ message: reason, intents: marks });
      }

      // ---- 执行模式 ----
      if (clip === null) {
        return fail(makeError('E_DECODE_FAILED', '时间线上还没有片段，先导入素材', 'mock'));
      }
      const clipEnd = clip.startFrame + clip.durationFrames;

      // 静音某条轨道
      const muteMatch = /(静音|取消静音)\s*(V\d+|A\d+|视频轨|音轨)/i.exec(text);
      if (muteMatch !== null) {
        const name = muteMatch[2] ?? '';
        const track = doc.tracks.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
        if (track === undefined) return fail(makeError('E_DECODE_FAILED', `找不到轨道 ${name}`, 'mock'));
        return ok({
          message: `${muteMatch[1]}${track.name}`,
          intents: [{ kind: 'muteTrack', trackId: track.id, muted: muteMatch[1] === '静音' }],
        });
      }

      // 新增轨道
      if (/新增|添加|新建/.test(text) && /(视频轨|音轨|轨道)/.test(text)) {
        const kind = /音轨|音频轨/.test(text) ? 'audio' : 'video';
        return ok({ message: `新增一条${kind === 'audio' ? '音频' : '视频'}轨`, intents: [{ kind: 'addTrack', trackKind: kind }] });
      }

      // 第 A 秒到第 B 秒
      const rangeMatch = /第?\s*(\d+(?:\.\d+)?)\s*秒?\s*(?:到|至|-|~)\s*第?\s*(\d+(?:\.\d+)?)\s*秒/.exec(text);
      if (rangeMatch !== null && /删|去掉|去除|剪/.test(text)) {
        const start = toFrames(Number(rangeMatch[1]));
        const end = toFrames(Number(rangeMatch[2]));
        return ok({
          message: `剪掉第 ${rangeMatch[1]}–${rangeMatch[2]} 秒`,
          intents: [{ kind: 'removeRange', clipId: clip.id, startFrame: clip.startFrame + start, endFrame: clip.startFrame + end }],
        });
      }

      // 开头 / 结尾 N 秒
      const seconds = secondsPattern(text);
      if (seconds !== null && /删|去掉|去除|剪/.test(text)) {
        const span = toFrames(seconds);
        if (/开头|前|开始/.test(text)) {
          return ok({
            message: `剪掉开头 ${seconds} 秒`,
            intents: [{ kind: 'removeRange', clipId: clip.id, startFrame: clip.startFrame, endFrame: clip.startFrame + span }],
          });
        }
        if (/结尾|最后|末尾/.test(text)) {
          return ok({
            message: `剪掉结尾 ${seconds} 秒`,
            intents: [{ kind: 'removeRange', clipId: clip.id, startFrame: Math.max(clip.startFrame, clipEnd - span), endFrame: clipEnd }],
          });
        }
      }

      // 切一刀
      if (/(切|剪)一?刀|切分|切开/.test(text)) {
        return ok({ message: `在第 ${request.playheadFrame} 帧切分`, intents: [{ kind: 'splitAt', frame: request.playheadFrame }] });
      }

      // 删除选中/这段
      if (/删掉|删除|去掉/.test(text) && /(选中|这段|这个片段|当前片段)/.test(text)) {
        return ok({ message: '删掉选中的片段', intents: [{ kind: 'removeClip', clipId: clip.id }] });
      }

      // 缩放 / 不透明度
      const percent = /(\d+(?:\.\d+)?)\s*%/.exec(text);
      if (percent !== null) {
        const value = Number(percent[1]);
        const path: AIPropertyPath | null = /不透明|透明度/.test(text)
          ? 'transform.opacity'
          : /放大|缩小|缩放/.test(text)
            ? 'transform.scale'
            : null;
        if (path !== null) {
          return ok({
            message: `把${path === 'transform.opacity' ? '不透明度' : '缩放'}设为 ${value}%`,
            intents: [{ kind: 'setProperty', clipId: clip.id, path, value: value / 100 }],
          });
        }
      }

      return fail(
        makeError(
          'E_DECODE_FAILED',
          '没听懂这条指令',
          '离线模式支持：剪掉开头/结尾 N 秒、剪掉第 A–B 秒、在播放头切一刀、删掉选中片段、缩放/不透明度 N%、静音 V1、新增视频轨。接上模型后可理解任意说法。',
        ),
      );
    },
  };
}

/** 无模型时的显式降级（R-048）：不假装能干活。 */
export function createNullProvider(): AIProvider {
  return {
    id: 'null',
    label: '未提供模型',
    async complete(): Promise<Result<AIResponse>> {
      return fail(makeError('E_DECODE_FAILED', '当前客户端未提供模型', 'R-048'));
    },
  };
}
