/**
 * 多机位（R-057）：把 N 条视频轨当"机位"，按规则生成切换序列。
 *
 * ## 能力边界（先说实话）
 *
 * **没有说话人识别**。"跟说话人"是用**每个机位的音频能量**近似：哪条轨这一段更响，
 * 就认为谁在说话。这在"一人一个麦克风"的访谈里很好用；在"共享一个房间麦"的场景里
 * 会退化成"谁离麦近切谁"。真正的说话人分离要模型，本地没有。
 *
 * ## 为什么用"切分 + 开关片段"而不是新建片段
 *
 * 多机位切换在语义上是"这一刻显示哪个机位"，不是"重新排一遍时间线"。所以：
 * 1. 在切换点把各机位轨切开（`splitClip`，素材入出点连续，不丢帧）；
 * 2. 每个区间只让选中的机位 `enabled = true`，其余 `false`。
 * 渲染层本来就跳过 `enabled === false` 的片段（`collectVisibleClips`），所以不用改渲染。
 *
 * **一次 dispatch = 一个撤销步**：切分与开关都在同一批操作里。
 */
import type { Clip, ClipOperation, Frame, Project, Result, Track } from '../core/types';
import { fail, ok, makeError } from '../core/types';
import { buildSplitOperations } from '../core/keymap';
import { applyOperation } from '../core/operations';
import { computeProjectDerived } from '../core/store';
import { frameToUs, secondsToFrames, usToSeconds } from '../core/timebase';
import { createDecoderPool } from '../media/decoderPool';
import { mixTimelineAudio } from '../export/audioMix';
import { getExportProbe } from '../media/previewSource';
import { registerProjectSources } from '../media/sourceRegistry';
import type { Mp4ProbeResult } from '../media/demuxMp4';

/** 默认切换间隔（秒）：没有音频分析时按固定节奏切。 */
export const DEFAULT_SWITCH_SECONDS = 2;
/** 最多支持几个机位（再多切换序列会碎得没法看）。 */
export const MAX_ANGLES = 6;

export interface MulticamOptions {
  doc: Project;
  /** 固定间隔（秒）。`followAudio` 为真时只作为"最小切换间隔"。 */
  switchSeconds?: number;
  /** true = 按每个机位的音频能量选（近似"跟说话人"）。 */
  followAudio?: boolean;
  onStage?: (stage: string) => void;
}

export interface MulticamPlan {
  ops: ClipOperation[];
  summary: string;
  /** 参与切换的机位（轨道名）。 */
  angles: string[];
  /** 实际切换次数（区间数 - 1）。 */
  switches: number;
  notes: string[];
}

/** 有内容的视频轨（= 机位），按屏幕顺序（自上而下）。 */
export function angleTracks(doc: Project): Track[] {
  return doc.tracks
    .filter((track) => track.kind === 'video' && !track.hidden && track.clips.length > 0)
    .sort((left, right) => right.order - left.order);
}

/** 取该轨在某帧处的片段。 */
function clipAt(track: Track, frame: Frame): Clip | null {
  for (const clip of track.clips) {
    if (clip.startFrame <= frame && frame < clip.startFrame + clip.durationFrames) return clip;
  }
  return null;
}

/**
 * 生成多机位切换方案。
 *
 * 步骤：算切换点 → 各机位轨在切换点切分 → 每个区间只开一个机位。
 * 全程在 `sim` 上模拟，返回的操作序列自洽（一次 dispatch 就能落地）。
 */
export async function planMulticam(options: MulticamOptions): Promise<Result<MulticamPlan>> {
  const { doc } = options;
  const angles = angleTracks(doc);
  if (angles.length < 2) {
    return fail(
      makeError(
        'E_DECODE_FAILED',
        `多机位需要至少 2 条有内容的视频轨（当前 ${angles.length} 条）`,
        '把其他机位素材拖到新的视频轨上再试',
      ),
    );
  }
  if (angles.length > MAX_ANGLES) {
    return fail(makeError('E_DECODE_FAILED', `最多支持 ${MAX_ANGLES} 个机位`, `当前 ${angles.length}`));
  }

  const duration = computeProjectDerived(doc).durationFrames;
  const switchFrames = Math.max(
    1,
    secondsToFrames(options.switchSeconds ?? DEFAULT_SWITCH_SECONDS, doc.fpsMilli),
  );
  const notes: string[] = [];

  // 1) 切换点：0 起，每 switchFrames 一个，末尾补上终点
  const cuts: Frame[] = [];
  for (let frame = switchFrames; frame < duration; frame += switchFrames) cuts.push(frame);

  // 2) 每个区间的机位选择
  const segments: Array<{ start: Frame; end: Frame }> = [];
  let cursor = 0;
  for (const cut of cuts) {
    segments.push({ start: cursor, end: cut });
    cursor = cut;
  }
  if (cursor < duration) segments.push({ start: cursor, end: duration });

  // 只有一段 = 一次切换都没有。这时"多机位"退化成"挑一个机位全程用"，
  // 不是用户要的东西，直接给可读错误（而不是产出一堆关轨操作让用户以为生效了）。
  if (segments.length <= 1) {
    const totalSeconds = usToSeconds(frameToUs(Math.max(0, duration), doc.fpsMilli));
    const stepSeconds = usToSeconds(frameToUs(switchFrames, doc.fpsMilli));
    return fail(
      makeError(
        'E_DECODE_FAILED',
        `时间线只有 ${totalSeconds.toFixed(1)} 秒，没有产生任何切换（当前切换间隔 ${stepSeconds.toFixed(1)} 秒）`,
        `把切换间隔改小，例如"多机位每 1 秒切一次"`,
      ),
    );
  }

  const chosen: string[] = [];
  if (options.followAudio === true) {
    options.onStage?.('分析各机位音量');
    const pool = createDecoderPool();
    try {
      registerProjectSources(pool, doc);
      for (const segment of segments) {
        let bestId = angles[0]?.id ?? '';
        let bestEnergy = -1;
        for (const angle of angles) {
          // 只混这一条轨：把 doc 换成单轨副本，复用现有混音
          const mixed = await mixTimelineAudio({
            doc: { ...doc, tracks: [angle] },
            startFrame: segment.start,
            endFrame: segment.end,
            pool,
            getProbe: (assetId) => getExportProbe(assetId) as Mp4ProbeResult | undefined,
          });
          if (!mixed.ok) continue;
          const energy = mixed.value.channels.reduce((sum, plane) => {
            let acc = 0;
            for (let i = 0; i < plane.length; i += 1) acc += Math.abs(plane[i] ?? 0);
            return sum + acc;
          }, 0);
          if (energy > bestEnergy) {
            bestEnergy = energy;
            bestId = angle.id;
          }
        }
        chosen.push(bestId);
      }
    } finally {
      await pool.dispose();
    }
    notes.push('按音频能量选机位（近似"跟说话人"，不是说话人识别）');
  } else {
    // 轮流切换：保证每个机位都有出镜，避免"只看一个机位"
    for (let index = 0; index < segments.length; index += 1) {
      chosen.push(angles[index % angles.length]?.id ?? '');
    }
  }

  // 3) 在各切换点切分所有机位轨
  let sim = doc;
  const ops: ClipOperation[] = [];
  for (const cut of cuts) {
    for (const angle of angles) {
      const track = sim.tracks.find((item) => item.id === angle.id);
      if (track === undefined) continue;
      const clip = clipAt(track, cut);
      if (clip === null) continue;
      const split = buildSplitOperations(sim, cut, clip.id);
      if (split.length === 0) continue;
      for (const op of split) sim = applyOperation(sim, op);
      ops.push(...split);
    }
  }

  // 4) 每个区间只开选中的机位
  for (const [index, segment] of segments.entries()) {
    const winner = chosen[index] ?? '';
    for (const angle of angles) {
      const track = sim.tracks.find((item) => item.id === angle.id);
      if (track === undefined) continue;
      const clip = clipAt(track, segment.start);
      if (clip === null) continue;
      const want = angle.id === winner;
      if (clip.enabled === want) continue;
      const op: ClipOperation = {
        op: 'setClipProps',
        clipId: clip.id,
        path: 'enabled',
        from: clip.enabled,
        to: want,
      };
      sim = applyOperation(sim, op);
      ops.push(op);
    }
  }

  if (ops.length === 0) {
    return fail(makeError('E_DECODE_FAILED', '没有产生任何切换（时间线太短或机位轨没有内容）'));
  }

  return ok({
    ops,
    summary: `多机位切换：${angles.length} 个机位 / ${Math.max(0, segments.length - 1)} 次切换`,
    angles: angles.map((angle) => angle.name),
    switches: Math.max(0, segments.length - 1),
    notes,
  });
}

/**
 * 识别"多机位"指令。
 *
 * "跟说话人"→ 音频能量模式；"每 N 秒"→ 固定间隔。
 */
export function parseMulticamRequest(text: string): { followAudio: boolean; switchSeconds?: number } | null {
  if (!/(多机位|机位|切机位|切镜头)/.test(text)) return null;
  const followAudio = /(跟说话|说话人|谁说话|自动)/.test(text);
  const match = /(\d+(?:\.\d+)?)\s*秒/.exec(text);
  const switchSeconds = match === null ? undefined : Number(match[1]);
  return {
    followAudio,
    ...(switchSeconds === undefined || !Number.isFinite(switchSeconds) ? {} : { switchSeconds }),
  };
}
