/**
 * 语音识别生成字幕（R-059 的"自动字幕"）。
 *
 * ## 能力边界（先说清楚，别假装）
 *
 * **客户端不做 ASR**。纯前端没有可用的本地语音识别模型（Whisper 级别的最小模型
 * 也有几十 MB，且要 WASM/WebGPU 推理，启动成本与"极简编辑器"定位冲突）。
 * 所以这里的定位是：**把链路做通，把识别交给宿主**——
 *
 *   时间线 → 抽音频（`media/asrAudio`）→ 宿主 `transcribe()` → 片段 → 字幕轨
 *
 * 宿主不提供 `transcribe` 时，命令栏给可读拒绝（"当前客户端未提供语音识别通道"），
 * **不会**返回一份空字幕让用户以为"识别完成但没说话"。
 *
 * ## 为什么识别结果要"清洗"一遍
 *
 * 宿主模型的输出是不可信输入（与 AI 意图同理）：可能 `endSec <= startSec`、
 * 可能时间戳乱序、可能两段重叠、可能是空白文本。这里全部过滤/纠正，
 * 因为**一个坏片段会让整条字幕轨错位**（后续片段按错位时间叠上去，用户只能全删）。
 */
import type { ClipOperation, Frame, Project, Result, TranscriptSegment } from '../core/types';
import { fail, makeError, ok } from '../core/types';
import { secondsToMs } from '../core/timebase';
import type { AIProvider } from './provider';
import { buildSubtitleReplaceOps } from '../subtitle/srt';
import { resolveCueOverlaps } from '../subtitle/srt';
import type { SubtitleCue } from '../subtitle/srt';
import { extractAsrAudio } from '../media/asrAudio';

/** 低于这个 RMS 视为"整段没声音"（约 -80dBFS）。 */
const SILENT_RMS = 1e-4;

export interface TranscribeRequestOptions {
  /** 语言提示：`zh` / `en` / `auto`。 */
  language: string;
}

/**
 * 识别"自动生成字幕"类指令。
 *
 * 只认"字幕/转写/听写/语音识别"这几个明确说法——"这段说了什么"属于提问，
 * 由 `classifyTone` 挡在前面（它不含动词，会被判成提问）。
 */
export function parseTranscribeRequest(text: string): TranscribeRequestOptions | null {
  const wantsSubtitle = /(字幕|转写|听写|语音识别|语音转文字|speech|transcri)/i.test(text);
  if (!wantsSubtitle) return null;
  // "字幕怎么导入"这类提问不在这里处理（交给模型/建议模式）
  if (/(怎么|如何|为什么|能不能|可以吗)/.test(text)) return null;
  const language = /(英文|英语|english)/i.test(text) ? 'en' : 'zh';
  return { language };
}

export interface CueBuildResult {
  cues: SubtitleCue[];
  /** 被丢弃的坏片段数（时间戳非法 / 空文本 / 重叠后归零）。 */
  dropped: number;
}

/**
 * 宿主回传的片段 → 字幕 cue。
 *
 * 清洗规则（顺序不可换）：
 * 1. 非有限数值、`end <= start`、空白文本 → 丢弃；
 * 2. 起点 < 0 → 夹到 0（负时间是"相对开头之前"，等价于开头）；
 * 3. 按起点排序（宿主可能乱序）；
 * 4. 相邻重叠 → **前一条的终点收到后一条的起点**（字幕不能同时出现两条）；
 * 5. 收完不足 `MIN_CUE_MS` → 丢弃（说明这条被后一条挤没了）。
 */
export function segmentsToCues(segments: readonly TranscriptSegment[]): CueBuildResult {
  const valid: SubtitleCue[] = [];
  let invalid = 0;
  for (const segment of segments) {
    const text = typeof segment.text === 'string' ? segment.text.trim() : '';
    const startSec = Number(segment.startSec);
    const endSec = Number(segment.endSec);
    if (text === '' || !Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
      invalid += 1;
      continue;
    }
    valid.push({
      startMs: secondsToMs(Math.max(0, startSec)),
      endMs: secondsToMs(Math.max(0, endSec)),
      text,
    });
  }
  // 排序 / 消重叠 / 最短时长 全部交给 `srt.resolveCueOverlaps`：
  // SRT 导入走的是同一条路，两处各写一遍迟早口径不一致。
  const resolved = resolveCueOverlaps(valid);
  return { cues: resolved.cues, dropped: invalid + resolved.dropped };
}

export interface TranscribeOutcome {
  cues: SubtitleCue[];
  /** 一次 dispatch 就能落地的操作（整段替换旧字幕）。 */
  ops: ClipOperation[];
  language: string;
  /** 实际送去识别的音频时长（秒）。 */
  durationSec: number;
  dropped: number;
  /** 被替换掉的旧字幕片段数。 */
  replaced: number;
}

export interface TranscribeTimelineOptions {
  doc: Project;
  /** 宿主的转写通道；`undefined` = 没有这个能力（给可读拒绝）。 */
  transcribe: AIProvider['transcribe'];
  language?: string;
  startFrame?: Frame;
  endFrame?: Frame;
  onStage?: (stage: string) => void;
}

/**
 * 时间线 → 字幕（抽音频 → 宿主转写 → 清洗 → 操作序列）。
 *
 * 返回的 `ops` 是**一批**：旧字幕整段移除 + 新字幕逐条添加，
 * 所以用户在 toast 上点一次撤销就能整体回退。
 */
export async function transcribeTimeline(
  options: TranscribeTimelineOptions,
): Promise<Result<TranscribeOutcome>> {
  const { doc, transcribe } = options;
  if (transcribe === undefined) {
    return fail(
      makeError(
        'E_UNSUPPORTED_COMMAND',
        '当前客户端未提供语音识别通道，无法自动生成字幕',
        '宿主可注入 transcribe()；或先用外部工具生成 SRT 再导入',
      ),
    );
  }

  options.onStage?.('抽取音频');
  const extracted = await extractAsrAudio({
    doc,
    ...(options.startFrame === undefined ? {} : { startFrame: options.startFrame }),
    ...(options.endFrame === undefined ? {} : { endFrame: options.endFrame }),
    ...(options.onStage === undefined ? {} : { onStage: options.onStage }),
  });
  if (!extracted.ok) return fail(extracted.error);
  const audio = extracted.value;
  if (audio.rms < SILENT_RMS) {
    return fail(
      makeError(
        'E_DECODE_FAILED',
        '这段音频是静音，没有可识别的语音',
        `电平 ${audio.rms.toExponential(1)}（低于 ${SILENT_RMS.toExponential(1)}）`,
      ),
    );
  }

  options.onStage?.('识别语音');
  let transcript;
  try {
    transcript = await transcribe({
      audio: audio.audio,
      sampleRate: audio.sampleRate,
      language: options.language ?? 'zh',
      onProgress: (ratio) => options.onStage?.(`识别语音 ${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`),
    });
  } catch (error) {
    return fail(
      makeError(
        'E_DECODE_FAILED',
        '语音识别失败',
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  const segments = Array.isArray(transcript?.segments) ? transcript.segments : [];
  const { cues, dropped } = segmentsToCues(segments);
  if (cues.length === 0) {
    return fail(
      makeError(
        'E_DECODE_FAILED',
        '没有识别出任何语音',
        dropped > 0 ? `${dropped} 个片段时间戳或文本不可用` : '宿主返回了空结果',
      ),
    );
  }

  const plan = buildSubtitleReplaceOps(cues, doc);

  return ok({
    cues,
    ops: plan.ops,
    language: transcript?.language ?? options.language ?? 'zh',
    durationSec: audio.durationSec,
    dropped,
    replaced: plan.removed,
  });
}
