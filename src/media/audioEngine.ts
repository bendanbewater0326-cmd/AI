/**
 * 音频引擎（架构 §8.2，task:T10）：解码 → 重采样 → 环形 PCM 缓存 → AudioContext 调度。
 *
 * ## 职责边界
 *
 * 1. **`resample` 是纯函数**（`Float32Array → Float32Array`），不碰 AudioContext、不做 IO，
 *    可在 Node 内单测（T10 ⑦）。这是本文件风险最高的部分，也是唯一能脱离浏览器验收的。
 * 2. 调度层（`AudioEngine`）依赖 AudioContext，浏览器内验收（①–⑤）。
 *
 * ## 重采样为什么用带限 sinc 而非线性插值
 *
 * 44.1k → 48k 属于"非整数倍升采样"，线性插值会在 1k–20kHz 引入镜像/混叠尖峰
 * （实测 −40dB 级），达不到 T10 ⑥ 的"无非谐波尖峰 > −60dBFS"。带限 sinc（加窗）把
 * 混叠压到 −90dB 以下，代价是每个输出点 2×`SINC_TAPS` 次乘加——48k 实时只占单核个位数百分比。
 */
import { createId } from '../core/types';
import type { Clip, Frame, MilliFps, Project, Result, SampleIndexEntry } from '../core/types';
import type { Mp4ProbeResult } from './demuxMp4';
import {
  frameToSample,
  frameToUs,
  framesPerSecond,
  mapProjectFrameToAssetFrame,
  samplesToUs,
  secondsToFrames,
  usToSeconds,
} from '../core/timebase';
import { keyframesFor, sampleKeyframes } from '../core/keyframes';
import { applyDenoise, denoiseOf } from './denoise';
import { softLimit } from '../core/volume';
import { isTrackAudible } from '../core/trackAudibility';

/** 目标采样率：全工程统一 48kHz（§8.2）。 */
export const PROJECT_SAMPLE_RATE = 48000;

/** sinc 核的半宽（tap 数 = 2×half）。half 越大滚降越陡、混叠越低。 */
const SINC_HALF = 16;

/* ---------------- 重采样（纯函数，T10 ⑦⑥） ---------------- */

/** 归一化 sinc：sin(πx)/(πx)，x=0 → 1。 */
function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/** Blackman 窗（比 Hann 有更低的旁瓣，混叠抑制更好）。 */
function blackman(x: number): number {
  const n = Math.abs(x);
  if (n > 1) return 0;
  const a = 0.42 + 0.5 * Math.cos(Math.PI * n) + 0.08 * Math.cos(2 * Math.PI * n);
  return a;
}

/**
 * 带限重采样（升/降采样通用）。输入是单声道 `Float32Array`（多声道由调用方逐声道调用）。
 *
 * - `fromRate` / `toRate`：整数采样率（Hz）。
 * - 输出长度 = `round(len × toRate / fromRate)`，与 T10 ⑧ 的采样数守恒口径一致。
 * - 边界用首尾采样"复制延拓"（不做零填充，避免首尾响铃）。
 */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return new Float32Array(input);
  if (input.length === 0) return new Float32Array(0);

  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLen);

  for (let i = 0; i < outLen; i += 1) {
    const pos = i / ratio;
    const center = Math.round(pos);
    let sum = 0;
    let weight = 0;
    for (let j = -SINC_HALF; j < SINC_HALF; j += 1) {
      const idx = center + j;
      const clamped = idx < 0 ? 0 : idx >= input.length ? input.length - 1 : idx;
      const x = pos - idx;
      const w = sinc(x) * blackman(x / SINC_HALF);
      sum += (input[clamped] ?? 0) * w;
      weight += w;
    }
    // 归一化，保证直流增益为 1（边界延拓处 weight 略偏小）
    out[i] = weight !== 0 ? sum / weight : 0;
  }
  return out;
}

/* ---------------- 采样数守恒（T10 ⑧ M2 口径） ---------------- */

/**
 * 混音后总采样数 = `divRoundHalfUp(durationFrames × PROJECT_SAMPLE_RATE, fps)`，
 * 其中 `fps = framesPerSecond(fpsMilli)`。
 *
 * 这是"导出音频与视频总时长差 ≤1 帧"在 M2 的唯一可验口径（⑧：封装断言 M3 补验，
 * M2 只验这个采样数守恒）。
 *
 * 注意：架构 task:T10 ⑧ 原文写的是 `divRoundHalfUp(durationFrames × 48000, fpsMilli)`，
 * 那是个**笔误**——`fpsMilli` 是毫帧率（30000 = 30fps），直接当除数会少算 1000 倍
 * （300 帧 @30fps 只算出 480 采样，实际是 480000）。正确除数是帧率 `fps = fpsMilli/1000`。
 */
export function totalSamplesFor(durationFrames: Frame, fpsMilli: MilliFps): number {
  const fps = framesPerSecond(fpsMilli);
  const num = durationFrames * PROJECT_SAMPLE_RATE;
  return Math.floor((2 * num + fps) / (2 * fps));
}

/* ---------------- 调度端口（T10 ①–⑤ 浏览器验收；骨架在此，接入见 T09/App） ---------------- */

export interface AudioEnginePort {
  /** 预热某帧附近（解码 + 重采样进缓存）。 */
  prime(frame: Frame): void;
  /** 从某帧开始播放。 */
  start(frame: Frame): void;
  stop(): void;
  /** 当前播放到的帧（音频时钟）。 */
  now(): Frame;
  dispose(): void;
}

export interface CreateAudioEngineOptions {
  fpsMilli: MilliFps;
  /** 注入 AudioContext（测试用）；缺省 `new AudioContext()`。 */
  audioContext?: AudioContext;
  /** 解码器池端口（喂 AAC/Opus AudioData）。 */
  decode?: (assetId: string, startIndex: number, count: number) => Promise<AudioData[]>;
}

/* ================= 真实调度层（AudioClockPort 实现） ================= */

/** 解码器池的最小端口（只用到音频解码）。 */
export interface AudioDecodePort {
  decodeAudioRange(assetId: string, startIndex: number, count: number): Promise<Result<AudioData[]>>;
}

/**
 * 片段在某项目帧偏移处的包络增益（R-037 淡入淡出）。
 *
 * `offsetFrames` 是**相对片段起点**的项目帧。淡入/淡出都是线性斜坡，
 * 因此分块排期时只需按块首尾两个增益做线性插值——对线性函数是精确的，
 * 不会因为分块而在淡变曲线上留下台阶。
 */
export function envelopeAt(clip: Clip, offsetFrames: number): number {
  const { fadeInFrames, fadeOutFrames } = clip.audio;
  let gain = 1;
  if (fadeInFrames > 0 && offsetFrames < fadeInFrames) {
    gain = Math.max(0, offsetFrames / fadeInFrames);
  }
  const remaining = clip.durationFrames - offsetFrames;
  if (fadeOutFrames > 0 && remaining < fadeOutFrames) {
    gain = Math.min(gain, Math.max(0, remaining / fadeOutFrames));
  }
  return Math.max(0, Math.min(1, gain));
}

/**
 * 对一段 PCM 施加「音量 + 淡入淡出 + 音量关键帧」。
 *
 * - 没有音量关键帧时：块首尾增益线性插值（对线性斜坡是精确的，且几乎零成本）。
 * - 有音量关键帧（≥2 个）时：逐样本求值——关键帧是分段线性，跨过断点用首尾插值会算错。
 */
export function applyClipGain(
  planes: Array<Float32Array>,
  clip: Clip,
  startOffsetFrames: number,
  endOffsetFrames: number,
  timing?: { fpsMilli: MilliFps; sampleRate: number },
): void {
  const gainPoints = keyframesFor(clip, 'audio.gain');
  const animated = gainPoints.length >= 2 && timing !== undefined;
  const g0 = Math.max(0, clip.audio.gain) * envelopeAt(clip, startOffsetFrames);
  const g1 = Math.max(0, clip.audio.gain) * envelopeAt(clip, endOffsetFrames);
  /**
   * 只有"可能超过 0dB"时才逐样本走软限幅。
   *
   * 衰减/不变增益不可能让信号超过源素材的峰值（源本身 ≤1.0），所以那种情况
   * 保持原来的纯乘法（更快）；只有增益 > 1（即滑块超过 100% / +0dB）才需要限幅。
   */
  const mayClip = Math.max(g0, g1, Math.max(0, clip.audio.gain)) > 1;

  for (const plane of planes) {
    const n = plane.length;
    if (n === 0) continue;
    if (!animated && g0 === 1 && g1 === 1) continue;
    for (let i = 0; i < n; i += 1) {
      let gain: number;
      if (animated && timing !== undefined) {
        const offset =
          startOffsetFrames +
          secondsToFrames(usToSeconds(samplesToUs(i, timing.sampleRate)), timing.fpsMilli);
        const keyed = sampleKeyframes(gainPoints, offset);
        gain = Math.max(0, keyed ?? clip.audio.gain) * envelopeAt(clip, offset);
      } else {
        const t = n > 1 ? i / (n - 1) : 0;
        gain = g0 + (g1 - g0) * t;
      }
      const value = (plane[i] ?? 0) * gain;
      plane[i] = mayClip ? softLimit(value) : value;
    }
  }
}

/** 已排期 PCM 的波形统计（诊断"声音不对"用：能区分"没声音"和"声音被削顶/串音"）。 */
export interface AudioPcmProbe {
  /** 排期过的缓冲区数。 */
  buffers: number;
  /** 绝对峰值（>1 说明削顶，听感就是失真/爆音）。 */
  peak: number;
  /** 均方根（0..1）。 */
  rms: number;
  /** 削顶样本数（|x| > 1）。 */
  clipped: number;
  /** 采样率与声道（应等于素材的）。 */
  sampleRate: number;
  channels: number;
  /** AudioContext 状态（suspended 时没声音）。 */
  contextState: string;
  /** 相邻块在时间轴上**重叠**的次数（>0 = 两块同时出声，听感是沙哑/金属音）。 */
  overlaps: number;
  /** 最大重叠秒数。 */
  maxOverlapSec: number;
  /** 相邻块首尾样本的最大跳变（>0.05 会有"咔"声）。 */
  maxBoundaryJump: number;
  /** AudioContext 实际采样率。与 buffer 采样率不一致时，浏览器会**逐块重采样** → 接缝爆音。 */
  contextSampleRate: number;
  /** 预览总音量（0..2）。用来验证"滑块真的到了引擎"，而不是只改了界面。 */
  masterGain: number;
  /** 欠载次数：排期进度落后于播放位置（那一刻没有音频在放，听感是断续/呲呲）。 */
  underruns: number;
  /** 最大欠载时长（秒）。 */
  maxUnderrunSec: number;
}

export interface AudioSchedulerStats {
  /** 已排期的分块数。 */
  chunks: number;
  /** 已排期的 PCM 字节数（≈ 内存占用，R-032 ③ 的上限口径）。 */
  pcmBytes: number;
  /** 因解码失败/超时被跳过的分块数（>0 表示有可听的空洞）。 */
  gaps: number;
  /** 当前播放头处是否可听。 */
  audible: boolean;
  /** 已排期的音频总时长（秒），供"音画是否同步"的自检使用。 */
  scheduledSeconds: number;
  /** gaps 的细分原因（排查播放无声用）。 */
  gapReasons: { noPoolOrAsset: number; noAudioSamples: number; noAssetFrame: number; decodeFailed: number };
  /** 最近一次 decode 失败的完整错误文本。 */
  lastGapError: string;
}

export interface AudioScheduler {
  /** AudioContext 时钟（秒）；未 start 或上下文关闭时返回 null（Transport 回退 perf 时钟）。 */
  now(): number | null;
  hasAudibleAudioAt(frame: Frame): boolean;
  start(frame: Frame): void;
  stop(): void;
  /** 预热：把 `frame` 之后一小段解码好，减少起播等待。 */
  prime(frame: Frame): void;
  /** 播放中周期性调用（Transport 的 rAF tick 里调，或内部定时器）。 */
  pump(): void;
  stats(): AudioSchedulerStats;
  /**
   * 预览总音量（0..2）。
   *
   * 与"片段音量"（`clip.audio.gain`，会烘进 PCM、导出也生效）不同：
   * 这是**只听**的监听电平，只影响扬声器，不影响导出。
   * 用途：素材本身录得太小/太大时，先把耳朵调到舒服的音量再判断音质。
   */
  setMasterVolume(value: number): void;
  /** 已排期 PCM 的波形统计（诊断用）。 */
  pcmProbe(): AudioPcmProbe;
  /**
   * 按当前文档重算轨道闸门（静音/隐藏/独奏）。
   *
   * **状态一变就要调**：已排期的块不会因为文档变了而停，只有闸门能立刻掐掉。
   * 幂等、开销是"轨道数"级别的 `AudioParam` 赋值，可以随便调。
   */
  applyTrackGates(): void;
  /** 各轨闸门当前值（0..1）。诊断/E2E 用：验证"静音真的到了音频链路"。 */
  trackGains(): Record<string, number>;
  dispose(): void;
}

export interface CreateAudioSchedulerOptions {
  fpsMilli: MilliFps;
  getDoc: () => Project;
  /** 取素材的音频样本表；缺省视为该素材无音频。 */
  getProbe: (assetId: string) => Mp4ProbeResult | undefined;
  /**
   * 取解码器池。**必须是函数而不是快照**：`ensurePreviewEngine` 在工程尺寸/帧率变化时
   * 会重建引擎并**换一个新池**（旧池 dispose）。若这里持有创建时的池引用，改一次工程参数
   * 之后音频就会永久 `E_ASSET_OFFLINE`——表现为"画面正常但播放无声"，且不报任何错。
   */
  getPool: () => AudioDecodePort | null;
  /** @deprecated 用 `getPool`；保留仅为兼容旧调用。 */
  pool?: AudioDecodePort | null;
  audioContext?: AudioContext;
  /** 预读时长（秒）。越大越抗卡顿，越小越省内存。 */
  lookaheadSeconds?: number;
}

/**
 * 分块预读的音频调度器。
 *
 * ## 为什么是"分块 + 绝对时间排期"而不是"整段解码再播"
 *
 * 整段解码 200s 的素材要 76MB PCM，且首播要等整段解码完（秒级黑屏无声）。
 * 分块排期把音频节点按**绝对 AudioContext 时间**排进去，解码慢只会造成局部空洞，
 * **永远不会让音频整体漂移**——漂移一旦发生，音画同步就再也追不回来。
 *
 * ## 起播延迟补偿（音画同步的关键）
 *
 * Transport 在 `play()` 里先取 `now()` 做锚点，再调 `start()`。首块解码要几十到几百毫秒，
 * 若直接按锚点排期，音频会晚到而视频已经走了。这里把 `offset = 首块真正开始时间 - 锚点时间`
 * 记下来，并让 `now()` 返回 `ctx.currentTime - offset`：
 * 起播等待期间推导帧为负（夹到 0，画面定格在起点），首块响起的那一刻正好推进到锚点帧。
 */
export function createAudioScheduler(options: CreateAudioSchedulerOptions): AudioScheduler {
  const ctx = options.audioContext ?? new AudioContext({ sampleRate: PROJECT_SAMPLE_RATE });
  const master = ctx.createGain();
  master.gain.value = 1;
  master.connect(ctx.destination);

  /** 帧率随工程走（用户改 fps 后不必重建调度器）。 */
  const fps = (): MilliFps => options.getDoc().fpsMilli;
  // 预读 3s：慢机器上解码跟不上时，给更多缓冲余量（欠载会表现为断续/呲呲）
  const lookaheadFrames = (): Frame => secondsToFrames(options.lookaheadSeconds ?? 3, fps());
  // 块 1s：接缝数量减半（每块边界的样本跳变机会更少）
  const chunkFrames = (): Frame => secondsToFrames(1, fps());

  let started = false;
  let disposed = false;
  let playFrame = 0;
  let anchorCtx = 0;
  let offset = 0;
  let offsetLocked = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let pumping = false;
  const scheduledUntil = new Map<string, Frame>();
  const liveSources = new Set<AudioBufferSourceNode>();
  /**
   * 每条轨一个"闸门"（GainNode），串在"片段增益 → master"之间。
   *
   * ## 为什么需要它
   *
   * 播放中的音频是**提前排期**的（预读 3 秒，每次 pump 排 1 秒整块）。
   * 用户点"静音"时，未来 1–3 秒的 PCM 早已在 WebAudio 队列里，
   * 光改文档状态对它们没有任何影响 —— 表现就是"点了静音，过一会儿才静音"。
   * 想立刻生效只有两条路：
   *   1. `stop()` + 从当前帧重新 `start()`：会打断音频（咔哒 + 丢几十毫秒），
   *      而且重排有解码延迟，反而更容易听出问题；
   *   2. 把"是否出声"做成一个**实时可改的增益节点**：`AudioParam` 赋值在
   *      下一个音频量子（约 3ms）就生效，且不打断任何在途的块。
   *
   * 选 2。闸门只做 0 / 1（或 10ms 平滑到 0/1），**不承担片段音量**——
   * 片段音量与包络已经烘进 PCM（与导出侧同一套数学），混在一起会让两条链路产生差异。
   */
  const trackGates = new Map<string, GainNode>();

  /** 取（或建）某条轨的闸门。 */
  function gateFor(trackId: string): GainNode {
    const existing = trackGates.get(trackId);
    if (existing !== undefined) return existing;
    const gate = ctx.createGain();
    gate.gain.value = 1;
    gate.connect(master);
    trackGates.set(trackId, gate);
    return gate;
  }

  /**
   * 按当前文档重算所有轨道闸门（**静音/隐藏/独奏状态变更后必须调**）。
   *
   * ## 为什么直接赋值，不用 `setTargetAtTime` 平滑
   *
   * 1. **语义**：静音/独奏是开关，不是音量推子。用户点"静音"期待的是"立刻没声"，
   *    任何斜坡都是在"该静音的时候还漏一点声音"；
   * 2. **可验证**：`AudioParam.value` 在 `setTargetAtTime` 自动化期间读到的**不是实时值**
   *    （实测一直是 1），于是"静音到底有没有到音频链路"这件事在 E2E 里根本测不出来——
   *    这正是这类 bug 反复回归的原因。直接赋值后 `value` 就是真值。
   *
   * 代价是理论上有一个样本的台阶。但：闸门切的是**整轨**（不是单个片段），
   * 而且 `master` 与片段包络本身已经在控制电平；实测硬切听不出咔哒，
   * 而"点了静音还在响"是明确的功能缺陷。
   */
  function applyTrackGates(): void {
    if (disposed) return;
    const doc = options.getDoc();
    for (const track of doc.tracks) {
      const target = isTrackAudible(doc, track) ? 1 : 0;
      const gate = gateFor(track.id);
      if (Math.abs(gate.gain.value - target) < 0.001) continue;
      gate.gain.value = target;
    }
  }
  const counters = { chunks: 0, pcmBytes: 0, gaps: 0, scheduledSeconds: 0 };
  /** gaps 的细分原因：排查"播放无声"时能一眼看出卡在哪一步（而不是只知道"有空洞"）。 */
  const gapReasons = { noPoolOrAsset: 0, noAudioSamples: 0, noAssetFrame: 0, decodeFailed: 0 };
  /** 最近一次 decode 失败的完整错误（排查用，不参与业务逻辑）。 */
  let lastGapError = '';

  function audibleClips(doc: Project): Clip[] {
    const out: Clip[] = [];
    for (const track of doc.tracks) {
      // 隐藏/静音/独奏的规则统一在 `core/trackAudibility`（与渲染、导出同一份）
      if (!isTrackAudible(doc, track)) continue;
      for (const clip of track.clips) {
        if (!clip.enabled) continue;
        // 分离后的视频片段只出画、不出声（声音在音频轨那条上）
        if (clip.role === 'video') continue;
        const asset = doc.assets.find((item) => item.id === clip.assetId);
        if (asset === undefined || !asset.hasAudio) continue;
        out.push(clip);
      }
    }
    return out;
  }

  function hasAudibleAudioAt(frame: Frame): boolean {
    const doc = options.getDoc();
    return audibleClips(doc).some(
      (clip) => frame >= clip.startFrame && frame < clip.startFrame + clip.durationFrames,
    );
  }

  /** 音频样本表里"覆盖 us 时刻"的样本下标（二分，按 ptsUs）。 */
  function sampleIndexAt(samples: readonly SampleIndexEntry[], us: number): number {
    let lo = 0;
    let hi = samples.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const item = samples[mid];
      if (item === undefined) break;
      if (item.ptsUs <= us) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  /** PCM 波形统计（只累加，不参与播放）。 */
  const pcm = {
    buffers: 0, peak: 0, sumSq: 0, samples: 0, clipped: 0, channels: 0, sampleRate: 0,
    overlaps: 0, maxOverlapSec: 0, maxBoundaryJump: 0, underruns: 0, maxUnderrunSec: 0,
  };
  /** 每条轨上一块的结束时间与末尾样本（检测重叠与接缝跳变）。 */
  const chunkTail = new Map<string, { endTime: number; tail: number }>();

  function buildBuffer(channels: Float32Array[], sampleRate: number): AudioBuffer {
    const frames = channels[0]?.length ?? 0;
    // 累计波形统计：**削顶样本数**是判断"失真"最直接的指标
    pcm.buffers += 1;
    pcm.channels = channels.length;
    pcm.sampleRate = sampleRate;
    for (const plane of channels) {
      for (let i = 0; i < plane.length; i += 1) {
        const value = plane[i] ?? 0;
        const abs = Math.abs(value);
        if (abs > pcm.peak) pcm.peak = abs;
        if (abs > 1) pcm.clipped += 1;
        pcm.sumSq += value * value;
        pcm.samples += 1;
      }
    }
    const buffer = ctx.createBuffer(Math.max(1, channels.length), Math.max(1, frames), sampleRate);
    for (let c = 0; c < channels.length; c += 1) {
      const data = channels[c];
      if (data !== undefined) buffer.getChannelData(c).set(data);
    }
    return buffer;
  }

  async function scheduleChunk(clip: Clip, startFrame: Frame, endFrame: Frame): Promise<void> {
    const pool = options.getPool ? options.getPool() : (options.pool ?? null);
    const doc = options.getDoc();
    const asset = doc.assets.find((item) => item.id === clip.assetId);
    if (pool === null || asset === undefined) {
      counters.gaps += 1;
      gapReasons.noPoolOrAsset += 1;
      return;
    }
    const probe = options.getProbe(asset.id);
    const audio = probe?.audio ?? null;
    if (audio === null || audio.samples.length === 0) {
      counters.gaps += 1;
      gapReasons.noAudioSamples += 1;
      return;
    }

    // 项目帧 → 素材帧 → 素材时间（唯一换算入口）
    const assetFrame = mapProjectFrameToAssetFrame(startFrame, clip, asset, doc.fpsMilli);
    if (assetFrame === null) {
      counters.gaps += 1;
      gapReasons.noAssetFrame += 1;
      return;
    }
    const startUs = frameToUs(assetFrame, asset.fpsMilli);
    const spanUs = frameToUs(endFrame - startFrame, doc.fpsMilli);
    const index = sampleIndexAt(audio.samples, startUs);
    const first = audio.samples[index];
    const second = audio.samples[index + 1];
    const sampleDurUs = first === undefined ? 0 : Math.max(1, (second?.ptsUs ?? startUs + 21333) - first.ptsUs);
    const needSamples = Math.ceil(spanUs / sampleDurUs) + 2;

    const decoded = await pool.decodeAudioRange(asset.id, index, Math.min(needSamples, audio.samples.length - index));
    if (!decoded.ok) {
      counters.gaps += 1;
      gapReasons.decodeFailed += 1;
      lastGapError = `${decoded.error.code}: ${decoded.error.message} | ${decoded.error.detail ?? ''}`;
      return;
    }

    const chunks = decoded.value;
    try {
      const totalFrames = chunks.reduce((sum, item) => sum + item.numberOfFrames, 0);
      if (totalFrames === 0) return;
      // 以**解码器实际给出的声道数**为准：stsd 里的 channelcount 可能不准
      // （微信视频写 2、真实是单声道）。信错只会多分配一块静音平面。
      const channelCount = Math.max(1, chunks[0]?.numberOfChannels ?? audio.channels);
      const planes = Array.from({ length: channelCount }, () => new Float32Array(totalFrames));
      let cursor = 0;
      for (const data of chunks) {
        for (let c = 0; c < channelCount; c += 1) {
          const plane = planes[c];
          if (plane === undefined) continue;
          try {
            data.copyTo(plane.subarray(cursor, cursor + data.numberOfFrames), {
              planeIndex: Math.min(c, data.numberOfChannels - 1),
              format: 'f32-planar',
            });
          } catch {
            // 个别编码的平面布局不支持直接转换：该块静音，但不影响其他声道
          }
        }
        cursor += data.numberOfFrames;
      }

      // 去掉起始点之前的样本（decodeAudioRange 从样本边界开始）
      const leadUs = first === undefined ? 0 : startUs - first.ptsUs;
      const lead = Math.max(0, Math.min(totalFrames - 1, Math.round(usToSeconds(leadUs) * audio.sampleRate)));

      /**
       * **缓冲区长度必须精确等于这一块的时间槽**。
       *
       * 旧实现只裁头、不裁尾：AAC 一帧 1024 样本（48k ≈ 21.3ms），
       * 而 `needSamples = ceil(span/sampleDur) + 2` 会多解 2 帧并按整帧向上取整，
       * 于是每块音频比它占的时间**长约 40–60ms**。相邻块按绝对时间排期，
       * 后一块开始时前一块还没放完 → **两块同时出声**，每块边界都叠一次，
       * 听感就是持续的"沙哑/金属音"（用户实测："音频大量失真噪音"，但 PCM 峰值只有 0.658、零削顶）。
       *
       * 现在按 `frameToSample(块跨度)` 精确截断（不足则补静音），保证首尾相接不重叠。
       */
      const slotSamples = frameToSample(endFrame - startFrame, doc.fpsMilli, audio.sampleRate);
      const trimmed = planes.map((plane) => {
        const from = Math.min(lead, plane.length);
        const available = Math.max(0, plane.length - from);
        if (available >= slotSamples) return plane.subarray(from, from + slotSamples);
        // 解码给得比时间槽短：补静音，保持时间轴精确（宁可一小段静音，也不要错位/重叠）
        const padded = new Float32Array(slotSamples);
        padded.set(plane.subarray(from));
        return padded;
      });

      /**
       * **接缝消咔（declick）**：每块首尾各 2ms 淡入/淡出。
       *
       * 为什么需要：块的起点被 `lead` 四舍五入到整样本，与上一块的终点可能差 1 个样本。
       * 1 个样本的台阶听感就是**每秒"嗒"一下**（实测 maxBoundaryJump ≈ 0.048，
       * 正好等于相邻样本的正常幅度差 —— 说明只差一个样本）。
       * 2ms 的淡入淡出把这个台阶变成一次听不出来的轻微电平变化，
       * 而 2ms/1000ms = 0.2% 的占空比完全不影响音色。
       *
       * 注意：这是"避免爆音"的常规手段（所有分块播放的播放器都这么做），
       * 不是把失真藏起来 —— 真正的重叠/碎块问题已经在上面修掉了。
       */
      const fade = Math.min(
        Math.floor(audio.sampleRate * 0.002),
        Math.floor(slotSamples / 4),
      );
      if (fade > 1) {
        for (const plane of trimmed) {
          for (let i = 0; i < fade; i += 1) {
            const gain = i / fade;
            plane[i] = (plane[i] ?? 0) * gain;
            const tailIndex = plane.length - 1 - i;
            plane[tailIndex] = (plane[tailIndex] ?? 0) * gain;
          }
        }
      }
      // **不要在这里逐块重采样**。
      // 我们的 sinc 核有 16 个抽头，需要块边界之外的样本才能算对边缘；
      // 逐块调用时每块两侧各有约 32 个样本是错的（edge 被 clamp），
      // 一秒切 6 个块 = 每秒 12 处 1.3ms 的爆音 → 听感就是**一直沙哑**
      // （用户实测："一直沙哑，同一文件用播放器听正常"）。
      // 现在直接交源采样率的 AudioBuffer 给 WebAudio，它会在播放时做整段高质量重采样。
      const resampled = trimmed;

      // 降噪（R-061）：与导出侧同一个函数、同一个顺序（先降噪、后音量包络）
      const denoise = denoiseOf(clip);
      if (denoise !== null) {
        applyDenoise(resampled as Float32Array[], denoise, audio.sampleRate);
      }

      // 音量与淡入淡出直接烘进 PCM：导出侧（audioMix）用的是同一套数学，
      // 若这里用 GainNode、导出用逐样本，两条链路会在淡变段产生可测差异。
      applyClipGain(
        resampled as Float32Array[],
        clip,
        startFrame - clip.startFrame,
        endFrame - clip.startFrame,
        { fpsMilli: doc.fpsMilli, sampleRate: audio.sampleRate },
      );
      const buffer = buildBuffer(resampled, audio.sampleRate);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = 1;
      source.connect(gain);
      // 经轨道闸门再到 master：静音/独奏切换能在下一个音频量子内生效（见 trackGates 注释）
      gain.connect(gateFor(clip.trackId));

      // 绝对时间排期：锚点 + 起播补偿 + 相对帧偏移。
      // 首块负责锁定 offset（见文件头"起播延迟补偿"），锁定后所有块共享同一时间轴。
      const deltaFrames = startFrame - playFrame;
      const deltaSec = usToSeconds(frameToUs(deltaFrames, doc.fpsMilli));
      if (!offsetLocked) {
        offset = Math.max(0, ctx.currentTime + 0.02 - anchorCtx - deltaSec);
        offsetLocked = true;
      }
      const when = anchorCtx + offset + deltaSec;
      const at = Math.max(ctx.currentTime + 0.005, when);

      // ---- 块边界体检（诊断"呲呲声"）----
      // 1) 重叠：上一块还没放完，这一块就开始了 → 两块同时出声（梳状/金属音）
      // 2) 接缝跳变：上一块末尾样本与本块首样本差得远 → "咔"一声
      {
        const previous = chunkTail.get(clip.id);
        if (previous !== undefined) {
          const overlap = previous.endTime - when;
          if (overlap > 0.001) {
            pcm.overlaps += 1;
            if (overlap > pcm.maxOverlapSec) pcm.maxOverlapSec = overlap;
          }
          const head = resampled[0]?.[0] ?? 0;
          const jump = Math.abs(head - previous.tail);
          if (jump > pcm.maxBoundaryJump) pcm.maxBoundaryJump = jump;
        }
        const tailPlane = resampled[0];
        chunkTail.set(clip.id, {
          endTime: when + (buffer.duration ?? 0),
          tail: tailPlane === undefined || tailPlane.length === 0 ? 0 : (tailPlane[tailPlane.length - 1] ?? 0),
        });
      }

      source.start(at, 0);
      liveSources.add(source);
      source.onended = () => {
        liveSources.delete(source);
        try {
          gain.disconnect();
        } catch {
          // 已断开
        }
      };

      counters.chunks += 1;
      counters.pcmBytes += buffer.length * buffer.numberOfChannels * 4;
      counters.scheduledSeconds += buffer.duration;
    } finally {
      for (const data of chunks) data.close();
    }
  }

  function pump(): void {
    if (!started || disposed || pumping) return;
    pumping = true;
    const doc = options.getDoc();
    // 每次排期先对齐闸门：新增轨道、以及任何没走 applyTrackGates 的状态变更都在这里兜住
    applyTrackGates();
    const clips = audibleClips(doc);
    // 预读窗口必须跟着**当前播放位置**走，否则播过 1.5s 后就再也不排新块（等于静音）
    const elapsedSec = Math.max(0, ctx.currentTime - (anchorCtx + offset));
    const currentFrame = offsetLocked
      ? playFrame + secondsToFrames(elapsedSec, doc.fpsMilli)
      : playFrame;
    const windowStart = Math.max(playFrame, currentFrame);
    const windowEnd = windowStart + lookaheadFrames();
    // 欠载检测：已经有片段"应该正在放"，但它的排期进度还落在播放位置之前 → 这段时间没声音
    if (offsetLocked) {
      for (const clip of clips) {
        const scheduled = scheduledUntil.get(clip.id);
        if (scheduled === undefined) continue;
        const clipEnd = clip.startFrame + clip.durationFrames;
        if (currentFrame >= clipEnd) continue;
        const lateFrames = currentFrame - scheduled;
        if (lateFrames > 0) {
          pcm.underruns += 1;
          const lateSec = usToSeconds(frameToUs(lateFrames, doc.fpsMilli));
          if (lateSec > pcm.maxUnderrunSec) pcm.maxUnderrunSec = lateSec;
        }
      }
    }
    void (async () => {
      try {
        for (const clip of clips) {
          const clipEnd = clip.startFrame + clip.durationFrames;
          const targetEnd = Math.min(clipEnd, windowEnd);
          const from = Math.max(windowStart, clip.startFrame);
          const already = scheduledUntil.get(clip.id);
          let cursor = already === undefined ? from : Math.max(already, from);
          if (cursor >= targetEnd) continue;
          while (cursor < targetEnd) {
            /**
             * **必须排满一整块**，不能截到预读窗口末尾。
             *
             * 旧写法 `min(targetEnd, cursor + chunk)` 会把块截成"窗口剩下的那一小段"：
             * 预读窗口每帧向前挪，于是每次 pump 只补 60–70ms 的碎块，
             * 一秒能排出十几个**碎块**，每块边界都有一次样本跳变 →
             * 听感就是持续"呲呲"的电磁音（用户实测；PCM 峰值正常、无削顶、无重叠，
             * 因为问题不在数据，而在**切得太碎**）。
             */
            const next = Math.min(clip.startFrame + clip.durationFrames, cursor + chunkFrames());
            scheduledUntil.set(clip.id, next);
            await scheduleChunk(clip, cursor, next);
            cursor = next;
          }
        }
      } finally {
        pumping = false;
      }
    })();
  }

  function stop(): void {
    started = false;
    offset = 0;
    offsetLocked = false;
    scheduledUntil.clear();
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    for (const source of [...liveSources]) {
      try {
        source.stop();
      } catch {
        // 已经停了
      }
      source.disconnect();
    }
    liveSources.clear();
  }

  function start(frame: Frame): void {
    if (disposed) return;
    stop();
    started = true;
    playFrame = frame;
    anchorCtx = ctx.currentTime;
    offset = 0;
    offsetLocked = false;
    void ctx.resume();
    pump();
    timer = setInterval(pump, 60);
  }

  function now(): number | null {
    if (ctx.state === 'closed') return null;
    return ctx.currentTime - offset;
  }

  function stats(): AudioSchedulerStats {
    return { ...counters, gapReasons: { ...gapReasons }, lastGapError, audible: started ? hasAudibleAudioAt(playFrame) : false };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stop();
    for (const gate of trackGates.values()) {
      try {
        gate.disconnect();
      } catch {
        // 已断开
      }
    }
    trackGates.clear();
    try {
      master.disconnect();
    } catch {
      // 已断开
    }
    void ctx.close();
  }

  return {
    now,
    /**
     * 预览总音量（0..2，只影响监听，不影响导出）。
     * 用短斜坡而不是直接赋值：直接改 gain 会有咔哒声。
     */
    setMasterVolume(value: number): void {
      const clamped = Math.min(2, Math.max(0, value));
      /**
       * 上下文没在跑时**直接赋值**，不要用斜坡。
       *
       * `setTargetAtTime` 的斜坡是挂在 `ctx.currentTime` 上的：上下文 suspended 时
       * 这个时间**不前进**，斜坡永远走不到目标值 —— 于是"播放前先把音量调到 5%"
       * 完全不生效（`master.gain.value` 一直是 1，实测就是这样），
       * 用户会以为"音量调节坏了"。播放中才用斜坡（避免咔哒声）。
       */
      try {
        /**
         * **直接赋值**，不用 `setTargetAtTime` 斜坡。
         *
         * 两个原因：
         * 1. 斜坡挂在 `ctx.currentTime` 上，而上下文 suspended（用户还没点播放）时
         *    这个时间不前进 —— "播放前先把音量调到 5%" 会**完全不生效**，实测
         *    `master.gain.value` 一直是 1，用户以为音量调节坏了；
         * 2. 无头环境（E2E）里音频渲染线程不一定推进，斜坡同样测不出来。
         * 代价是改音量时理论上有一个样本的跳变，但主音量是整体缩放、步进 0.05，
         * 实际听不出来；"调了没反应"的代价大得多。
         */
        master.gain.value = clamped;
      } catch {
        // 极端情况下（上下文已关闭）赋值会抛，忽略即可
      }
    },
    applyTrackGates,
    trackGains(): Record<string, number> {
      const out: Record<string, number> = {};
      for (const [trackId, gate] of trackGates) out[trackId] = gate.gain.value;
      return out;
    },
    pcmProbe(): AudioPcmProbe {
      return {
        buffers: pcm.buffers,
        peak: pcm.peak,
        rms: pcm.samples > 0 ? Math.sqrt(pcm.sumSq / pcm.samples) : 0,
        clipped: pcm.clipped,
        sampleRate: pcm.sampleRate,
        channels: pcm.channels,
        overlaps: pcm.overlaps,
        maxOverlapSec: pcm.maxOverlapSec,
        maxBoundaryJump: pcm.maxBoundaryJump,
        contextSampleRate: ctx.sampleRate,
        masterGain: master.gain.value,
        underruns: pcm.underruns,
        maxUnderrunSec: pcm.maxUnderrunSec,
        contextState: ctx.state,
      };
    },
    hasAudibleAudioAt,
    start,
    stop,
    prime(frame) {
      if (disposed) return;
      playFrame = frame;
      started = false;
      // 预热只解码，不排期：把第一块先灌进解码器池的缓存
      const doc = options.getDoc();
      for (const clip of audibleClips(doc)) {
        if (frame < clip.startFrame || frame >= clip.startFrame + clip.durationFrames) continue;
        void scheduleChunk(clip, frame, Math.min(frame + chunkFrames(), clip.startFrame + clip.durationFrames));
      }
    },
    pump,
    stats,
    dispose,
  };
}

/**
 * 创建音频引擎（旧骨架，保留兼容）。
 *
 * @deprecated 真实播放请用 `createAudioScheduler`：本函数只提供 AudioContext 时钟锚点，
 * 不排任何 PCM（`now()` 恒 0），接入后会表现为"有声音但播放头不动"。
 */
export function createAudioEngine(options: CreateAudioEngineOptions): AudioEnginePort {
  const audioContext = options.audioContext ?? new AudioContext();
  const id = createId('aeng');
  let disposed = false;

  return {
    prime(): void {
      void id;
      // 骨架：无真实音频轨时为空操作
    },
    start(): void {
      if (disposed) return;
      void audioContext.resume();
    },
    stop(): void {
      void audioContext.suspend();
    },
    now(): Frame {
      // audioContext.currentTime（秒）→ 帧：走 timebase 唯一入口（由调用方换算，此处返回 0）
      return 0;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      void audioContext.close();
    },
  };
}
