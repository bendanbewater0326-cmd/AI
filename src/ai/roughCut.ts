/**
 * AI 智能粗剪（R-060）：一句话去掉长停顿。
 *
 * ## 为什么必须在本地算
 *
 * "哪里是停顿"是**音频能量问题**，不是语言问题。模型看不到波形，也没有素材字节；
 * 让它"猜"停顿位置，结果一定是编造的帧号。所以这里的分工是：
 * **模型负责听懂意图（要不要剪、多长的停顿算长），本地负责找位置并落地操作**。
 *
 * ## 一次输入 = 一个撤销步
 *
 * 所有区间按**从后往前**处理（前面的帧号才不会被后面的左移搞乱），
 * 每段生成的 ops 依次在模拟态上校验，最后合成一批 `dispatch`。
 *
 * ## 已知边界（写在文档里，不做假装）
 *
 * - 只处理**一条轨**（选中片段所在轨；否则取片段最多的视频轨）——
 *   多轨同时剪会让"哪条轨的节奏为准"变得没有答案；
 * - 分析区间上限 5 分钟（内存里要攒整段 PCM）；
 * - 整条时间线几乎全是静音时**拒绝执行**（多半是无声素材或音量过低，
 *   直接剪会把内容全删掉）。
 */
import type { ClipOperation, Frame, MilliFps, Project, Result, Track } from '../core/types';
import { fail, makeError, ok } from '../core/types';
import { frameToUs, framesPerSecond, secondsToFrames, usToSeconds } from '../core/timebase';
import { computeProjectDerived } from '../core/store';
import { applyOperation } from '../core/operations';
import { buildRippleDeleteOps } from '../core/rippleDelete';
import { createDecoderPool } from '../media/decoderPool';
import { mixTimelineAudio } from '../export/audioMix';
import { getExportProbe } from '../media/previewSource';
import { registerProjectSources } from '../media/sourceRegistry';
import { detectSilenceRanges } from '../media/silence';
import type { SilenceRange } from '../media/silence';
import type { Mp4ProbeResult } from '../media/demuxMp4';

/** 分析上限：内存里要攒整段 48k 立体声 PCM，5 分钟约 115MB。 */
export const MAX_ANALYZE_FRAMES = 9000;
/** 低于该电平算静音（dBFS）。 */
export const DEFAULT_THRESHOLD_DB = -40;
/** 静音两端保留的余量（秒）：削掉字头会很难听。 */
export const DEFAULT_PADDING_SECONDS = 0.1;
/** 静音占比超过这个值就拒绝执行（多半是无声素材）。 */
const MAX_SILENT_RATIO = 0.9;

export interface SilenceRequest {
  /** 多长的停顿算"该剪"（秒）。 */
  minSilenceSeconds: number;
}

/**
 * 识别"去掉停顿"类指令。
 *
 * 为什么用规则而不是让模型判：这条指令**必须**在调用模型之前拦下来——
 * 模型给不出帧号，走模型只会多一次网络往返再失败。规则也足够窄，误判风险低。
 *
 * 必须同时出现"剪"类动词 + "静音"类名词，避免"这段停顿怎么处理"（提问）被当成命令
 * （提问由 `classifyTone` 先挡一层，这里是第二层）。
 */
export function parseSilenceRequest(text: string): SilenceRequest | null {
  const hasSilenceWord = /(停顿|静音|无声|没声音|空白段|silence)/i.test(text);
  const hasCutVerb = /(去掉|删除|剪掉|去除|清理|干掉|切掉|剪去|删掉)/.test(text);
  if (!hasSilenceWord || !hasCutVerb) return null;
  const match = /(\d+(?:\.\d+)?)\s*(?:秒|s\b)/i.exec(text);
  const seconds = match === null ? 1 : Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return { minSilenceSeconds: 1 };
  return { minSilenceSeconds: Math.min(30, seconds) };
}

export interface RoughCutOptions {
  doc: Project;
  /** 多长的停顿算"该剪"（秒）。 */
  minSilenceSeconds: number;
  /** 优先在这条轨上操作（通常是当前选中的片段所在轨）。 */
  selectedClipId?: string | null;
  thresholdDb?: number;
  paddingSeconds?: number;
  onStage?: (stage: string) => void;
}

export interface RoughCutPlan {
  /** 命中的静音区间（项目帧）。 */
  ranges: SilenceRange[];
  /** 一次 dispatch 就能落地的操作序列。 */
  ops: ClipOperation[];
  /** toast 用的一句话。 */
  summary: string;
  /** 被跳过的区间说明（不致命）。 */
  notes: string[];
  /** 实际处理的轨道名（让用户知道改的是哪条轨）。 */
  trackName: string;
  analyzedFrames: Frame;
  removedFrames: Frame;
}

/** 选一条"主轨"：优先选中片段所在轨，否则片段最多的视频轨（并列取更靠上的）。 */
function primaryTrack(doc: Project, selectedClipId?: string | null): Track | null {
  if (typeof selectedClipId === 'string' && selectedClipId !== '') {
    const owner = doc.tracks.find((track) => track.clips.some((clip) => clip.id === selectedClipId));
    if (owner !== undefined) return owner;
  }
  const withClips = doc.tracks.filter((track) => track.clips.length > 0);
  if (withClips.length === 0) return null;
  const videos = withClips.filter((track) => track.kind === 'video');
  const pool = videos.length > 0 ? videos : withClips;
  return [...pool].sort((left, right) => {
    if (right.clips.length !== left.clips.length) return right.clips.length - left.clips.length;
    return right.order - left.order;
  })[0] ?? null;
}

function secondsText(frames: Frame, fpsMilli: MilliFps): string {
  return usToSeconds(frameToUs(frames, fpsMilli)).toFixed(1);
}

/**
 * 分析音频并生成粗剪方案。
 *
 * 返回 `Result`：任何"分析不了"的情况都给可读原因（没有音频 / 太长 / 几乎全是静音），
 * 而不是返回空操作让 UI 显示"成功但什么都没变"。
 */
export async function planSilenceRemoval(options: RoughCutOptions): Promise<Result<RoughCutPlan>> {
  const { doc } = options;
  const fps = doc.fpsMilli;
  const track = primaryTrack(doc, options.selectedClipId);
  if (track === null) {
    return fail(makeError('E_DECODE_FAILED', '时间线上还没有片段，没东西可剪', 'roughCut'));
  }

  const analyzedFrames = computeProjectDerived(doc).durationFrames;
  if (analyzedFrames <= 0) {
    return fail(makeError('E_DECODE_FAILED', '时间线是空的', 'roughCut'));
  }
  if (analyzedFrames > MAX_ANALYZE_FRAMES) {
    const limit = Math.floor(MAX_ANALYZE_FRAMES / Math.max(1, framesPerSecond(fps)));
    return fail(
      makeError(
        'E_DECODE_FAILED',
        `音频分析一次最多 ${limit} 秒，当前 ${secondsText(analyzedFrames, fps)} 秒`,
        '先用 I / O 标记一段区间，或分段处理',
      ),
    );
  }

  options.onStage?.('分析音频');
  const pool = createDecoderPool();
  let mixed;
  try {
    registerProjectSources(pool, doc);
    mixed = await mixTimelineAudio({
      doc,
      startFrame: 0,
      endFrame: analyzedFrames,
      pool,
      // 分析用原片：代理音频是重编码过的，静音包络会有损
      getProbe: (assetId) => getExportProbe(assetId) as Mp4ProbeResult | undefined,
    });
  } finally {
    await pool.dispose();
  }
  if (!mixed.ok) {
    return fail(makeError('E_DECODE_FAILED', `读取音频失败：${mixed.error.message}`, 'roughCut'));
  }

  const audio = mixed.value;
  const hasSignal = audio.channels.some((plane) => plane.some((value) => value !== 0));
  if (!hasSignal) {
    return fail(
      makeError('E_DECODE_FAILED', '这条时间线没有声音，无法按停顿粗剪', '素材是无声的，或轨道被静音'),
    );
  }

  const minSilenceFrames = Math.max(1, secondsToFrames(options.minSilenceSeconds, fps));
  const paddingFrames = secondsToFrames(options.paddingSeconds ?? DEFAULT_PADDING_SECONDS, fps);
  const detection = detectSilenceRanges(audio.channels, audio.length, {
    sampleRate: audio.sampleRate,
    fpsMilli: fps,
    minSilenceFrames,
    paddingFrames,
    thresholdDb: options.thresholdDb ?? DEFAULT_THRESHOLD_DB,
  });

  if (detection.ranges.length === 0) {
    return fail(
      makeError(
        'E_DECODE_FAILED',
        `没有找到超过 ${options.minSilenceSeconds} 秒的停顿`,
        `阈值 ${options.thresholdDb ?? DEFAULT_THRESHOLD_DB}dBFS`,
      ),
    );
  }
  if (detection.silentFrames > analyzedFrames * MAX_SILENT_RATIO) {
    return fail(
      makeError(
        'E_DECODE_FAILED',
        '几乎整条时间线都是静音，已放弃（避免把内容全剪掉）',
        `静音占 ${Math.round((detection.silentFrames / analyzedFrames) * 100)}%`,
      ),
    );
  }

  // 从后往前处理：前面的帧号不会被后面的左移打乱
  const descending = [...detection.ranges].sort((left, right) => right.startFrame - left.startFrame);
  const notes: string[] = [];
  const ops: ClipOperation[] = [];
  let sim = doc;
  let removedFrames = 0;
  let applied = 0;

  for (const range of descending) {
    const rangeOps = buildRippleDeleteOps(sim, track.id, range.startFrame, range.endFrame);
    if (rangeOps.length === 0) {
      notes.push(`第 ${range.startFrame}–${range.endFrame} 帧的停顿落在空白或片段接缝，已跳过`);
      continue;
    }
    try {
      for (const op of rangeOps) sim = applyOperation(sim, op);
    } catch (error) {
      notes.push(
        `第 ${range.startFrame}–${range.endFrame} 帧处理失败：${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    ops.push(...rangeOps);
    removedFrames += range.endFrame - range.startFrame;
    applied += 1;
  }

  if (ops.length === 0) {
    return fail(
      makeError('E_DECODE_FAILED', '找到了停顿，但都落在片段之间的空白处，没有可剪的内容', 'roughCut'),
    );
  }

  return ok({
    ranges: detection.ranges,
    ops,
    summary: `去掉 ${applied} 段停顿（共 ${secondsText(removedFrames, fps)} 秒）`,
    notes,
    trackName: track.name,
    analyzedFrames,
    removedFrames,
  });
}
