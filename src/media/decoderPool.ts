/**
 * 解码器池（架构 §8.2，task:T06）：`VideoDecoder` 会话复用、epoch 取消、关键帧回退、帧缓存。
 *
 * ## 三条铁律（本文件的全部风险都在这里）
 *
 * **① 所有 `VideoFrame` 都必须 `close()`。** 未 close 的帧会耗尽 Chromium 硬解会话，
 * 用户看到的现象是"播着播着黑屏"，**且不报错**。本文件的 close 调用点见下表，
 * 任何新增丢弃路径都必须配一次 close（`stats().totalCreated - totalClosed === openFrames` 是机器可检的守恒式）：
 *
 * | 调用点 | 触发条件 |
 * |---|---|
 * | `handleVideoFrame`「无请求 / epoch 失效」分支 | 迟到的旧 epoch 帧 |
 * | `handleVideoFrame`「非目标帧」分支 | 解到目标帧之后的多余输出 |
 * | `storeFrame`「同帧号覆盖」 | 同一帧号被重复解码 |
 * | `evictAndClose` | 超出 8MB 预算或单素材 3 帧上限（LRU；配额受"持有 ~9 帧解码器就停摆"实测红线约束） |
 * | `release` / `dispose` | 关闭会话前清空该素材缓存 |
 * | `closeVideoSession` | 会话被 LRU 淘汰前清空该会话名下待决帧 |
 *
 * **② 判定"解到第几帧"只看 presentation index，不比对时间戳。**
 * VFR 素材的 `stts` 会把 PTS 拉成非正常间隔，用"时间戳比较"必然多一帧或少一帧（架构 §8.2）。
 * 输出帧的 `timestamp` 是我们自己写进去的 `ptsUs`，因此可以**反查** presentation index
 * （`indexByPtsUs`），但那是**查表**，不参与任何时间换算或比较。
 *
 * **③ `EncodedVideoChunk.timestamp` 必须填 `ptsUs`，绝不能填 `dtsUs`。**
 * T05 实测 `faststart-bframes.mp4` 首个样本 `dts=-66667µs / pts=0`（elst media_time 重排延迟），
 * dts 可以为负。提交顺序按解码顺序（`dtsUs` 升序），时间戳字段填 PTS。
 *
 * ## 帧所有权
 *
 * 池产出的 `VideoFrame` 归**池的 FrameCache 所有**，调用方**借用**（可以 `drawImage`，**禁止 `close()`**）。
 * 若调用方 close 了借用的帧，FrameCache 会二次 close（抛 InvalidStateError）且守恒式被破坏。
 * 音频走另一条路：`decodeAudioRange()` 返回的 `AudioData[]` 归调用方所有（必须由 T10 负责 close），
 * 因此不进入上面 4 个统计字段。
 *
 * ## 与 T19（webm）的接口约定
 *
 * 本池**不假设"解一帧就上屏一帧"**：`presentationIndex` 只对样本表里的展示帧递增，
 * 判断依据是 demux 的 presentation order，而不是解码回调次数。VP9 的 alt-ref（invisible）帧
 * 将来由 `demuxWebm` 的 Cues 样本表排除，本文件无需改动。
 */

import type { ErrorCode, Frame, Result, SampleIndexEntry, VEditorError } from '../core/types';
import { makeError } from '../core/types';
import type { BlobLike, Mp4ProbeResult } from './demuxMp4';
import { readBlobBytes } from './demuxMp4';

/* ---------- 常量（全部可被 options 覆盖） ---------- */

/**
 * 帧缓存字节预算。
 *
 * **实测红线（2026-10-20，`tests/probe-raw-decoder.mjs` 裸WebCodecs 对照）**：
 * 应用只要**持有（未 `close()`）约 9 个输出帧**，Chromium 的 `VideoDecoder` 就会
 * **彻底停止消费**——不触发 `error`、不再回调 `output`，队列里的样本永远不出帧。
 * 对照数据（sample-720p / 喂 0..60 帧）：
 *
 * | 持有帧数 | 实际吐出 | 队列残留 |
 * |---|---|---|
 * | 0 | 59 | 0 |
 * | 10 | **9** | 46 |
 * | 40 | **9** | 46 |
 *
 * 因此缓存配额必须**远低于**这条线：单素材 3 帧 × 2 个会话 = 6 帧，
 * 再加调用方借走的 1–2 帧，总持有量 ≤ 8，留出安全余量。
 * 旧值 24 帧 / 64MB 会在第一次 seek 之后必然越过红线，表现为"第一次 seek 正常、
 * 之后全部失败"——这是本文件最重要的一条实测约束，改大之前请先重跑上面那个探针。
 */
const DEFAULT_FRAME_CACHE_BUDGET_BYTES = 8 * 1024 * 1024;

/** 单素材帧数上限（受上面的 ~9 帧红线约束，不可调大；T06 ③ 的 openFrames ≤ 24 仍成立）。 */
const DEFAULT_MAX_CACHED_FRAMES_PER_ASSET = 3;

/** 视频会话上限（V2/V1 各一，架构 §8.2）。 */
const DEFAULT_MAX_VIDEO_SESSIONS = 2;

/** 音频会话上限。 */
const DEFAULT_MAX_AUDIO_SESSIONS = 1;

/** 单次 seek 最多因"解码器卡死"重建几次（防重建风暴；1 次足够覆盖瞬时越线）。 */
const MAX_WEDGED_REBUILDS = 1;

/** 回退超过该帧数时通知调用方"定位中"（T06 ⑦）。 */
const DEFAULT_POSITIONING_THRESHOLD_FRAMES = 60;

/** 解码队列高水位：超过就让出主线程（避免一次性灌满解码器）。 */
const DEFAULT_DECODE_QUEUE_HIGH_WATER = 8;

/** 每提交 N 个样本让出一次主线程（T06 ⑥：rAF 间隔不得 > 50ms）。 */
const DEFAULT_YIELD_EVERY_FRAMES = 4;

/**
 * 目标帧之后额外多喂几个样本：B 帧需要后续样本作参考才能输出目标帧。
 *
 * 同时也是"预读缓存"窗口：顺序播放时这些输出会进缓存供下一帧直接命中。
 *
 * **必须 ≤ 单素材帧缓存上限**（`DEFAULT_MAX_CACHED_FRAMES_PER_ASSET`）：预读出来的帧
 * 装不进缓存就会被立刻淘汰，播放请求永远命中不了缓存，于是每帧都退化成"从关键帧重解"。
 * 实测：预读 16 / 缓存 3 时顺序播放 900 帧要喂 82568 个样本、耗时 55 秒，
 * `sequentialFeeds=0`（快路径一次都没走到）。预读 2 / 缓存 3 时两者正好装下。
 */
const SEEK_LOOKAHEAD_SAMPLES = 2;

/** `dequeue` 事件的兜底等待上限（毫秒）。 */
const DEQUEUE_TIMEOUT_MS = 8;

/** `flush()` 的兜底上限：解码器卡死时 flush 可能永不 resolve，绝不能让它挂住调用方。 */
const FLUSH_TIMEOUT_MS = 250;

/** 单次取帧的整体上限：超过就判失败（UI 宁可报错也不能白屏等待）。 */
const SEEK_TIMEOUT_MS = 1500;

/* ---------- 公共类型 ---------- */

/** 被更新请求取消（**不是**解码失败：连按两次 seek 就会发生）。引擎统计要能区分。 */
export const EPOCH_CANCEL_MESSAGE = 'seek 被新的 epoch 取消';

/** 池运行状态（T06 验收 ②③④ 的机器可检指标）。 */
export interface DecoderPoolStats {
  /** 当前打开的会话数（视频 + 音频）。 */
  openSessions: number;
  /** 当前被缓存持有、尚未 close 的 VideoFrame 数。 */
  openFrames: number;
  /** 累计从解码器输出回调收到的 VideoFrame 数（含立即丢弃的）。 */
  totalCreated: number;
  /** 累计 close() 的 VideoFrame 数。守恒式：`totalCreated - totalClosed === openFrames`。 */
  totalClosed: number;
  /**
   * 累计创建的 decoder **会话实例**数（`new VideoDecoder` / `new AudioDecoder` 各算 1）。
   *
   * 注意与 `totalCreated` 的区别：后者是**帧**计数，本字段是**会话**计数。
   * 用途：抓"每次 seek 都重建解码器实例"——那种实现下 `openSessions` 恒为 1、
   * `totalCreated` 也正常，但 `sessionsCreated` 会等于 seek 次数。
   * 与 `diagnostics().fullSeeks` 互补：`fullSeeks` 抓"重解"，本字段抓"重建实例"。
   */
  sessionsCreated: number;
}

/** "定位中"通知（T06 ⑦：回退距离大时告知 UI，不阻塞、不白屏）。 */
export interface PositioningEvent {
  assetId: string;
  targetFrame: Frame;
  /** 需要从 targetFrame - fallbackFrames 的关键帧开始解。 */
  fallbackFrames: number;
  phase: 'start' | 'end';
}

/** 池选项。 */
export interface DecoderPoolOptions {
  frameCacheBudgetBytes?: number;
  maxCachedFramesPerAsset?: number;
  maxVideoSessions?: number;
  maxAudioSessions?: number;
  positioningThresholdFrames?: number;
  decodeQueueHighWater?: number;
  yieldEveryFrames?: number;
  /** "定位中"回调（T09 用于显示 spinner）。 */
  onPositioning?: (event: PositioningEvent) => void;
  /** 让出主线程的实现；默认 `setTimeout(0)`（浏览器里等价于下一轮宏任务）。 */
  yieldToMain?: () => Promise<void>;
}

/** 取帧路径计数（诊断用，不进 4 个核心统计字段）。 */
export interface PoolDiagnostics {
  /** 直接命中缓存。 */
  cacheHits: number;
  /** 已提交但输出在途，短等后命中。 */
  inFlightHits: number;
  /** 从 watermark 继续喂（顺序播放）。 */
  sequentialFeeds: number;
  /** reset + configure + 从关键帧重解。 */
  fullSeeks: number;
  /** 累计提交给解码器的样本数。 */
  samplesFed: number;
  /** 输出时间戳无法反查 presentation index 的次数（正常恒为 0）。 */
  unmappedTimestamps: number;
  /** 当前已知关键帧数（stss ∪ 运行时发现）。 */
  keyframeCount: number;
}

/** 一帧解码结果。`frame` 归池所有，调用方**不得 close()**。 */
export interface DecodedFrame {
  /** 借用帧；所有权属池。 */
  frame: VideoFrame;
  /** 实际呈现的素材帧号（presentation index）。 */
  assetFrame: Frame;
  /** true = 命中缓存，没有重新解码。 */
  fromCache: boolean;
  /** true = 就是请求帧；false = 只能回退到更早的帧（调用方按 holdPrevious 显示）。 */
  exact: boolean;
}

/** 解码器池公共接口（架构 §8.2）。 */
export interface DecoderPool {
  /** 注册素材（把 T05 的探测结果 + 文件源交给池）。重复注册会重置会话与缓存。 */
  register(assetId: string, probe: Mp4ProbeResult, source: BlobLike): void;
  /** 反注册（等价于 release，但保留探测结果？不保留：彻底释放）。 */
  unregister(assetId: string): Promise<void>;
  /** 取素材帧（presentation index == 素材帧号 S）。 */
  ensureFrame(assetId: string, assetFrame: Frame, epoch?: number): Promise<Result<DecodedFrame>>;
  /** 帧精确 seek 的薄封装：返回借用帧（T06 ① 断言 frame.timestamp）。 */
  seek(assetId: string, assetFrame: Frame, epoch?: number): Promise<Result<VideoFrame>>;
  /** 释放单个素材：关闭会话 + 清空缓存帧。 */
  release(assetId: string): Promise<void>;
  /** 释放全部。 */
  dispose(): Promise<void>;
  /** 运行状态。 */
  stats(): DecoderPoolStats;
  /**
   * **同步**查缓存（不解码、不发请求、不改变缓存状态）。
   *
   * 返回的帧是**借用**：所有权仍属池，只在本次 rAF 内有效——下一次 peek 之前池可能因 LRU
   * 淘汰或 epoch 切换把它 close 掉。调用方禁止跨 tick 持有、禁止 close()、禁止存入长期结构。
   * 需要跨 tick 复用画面时，请复用"已上屏的像素"，不要复用 VideoFrame 对象。
   *
   * 未命中返回 null（**不 throw**——播放循环里抛异常会静默杀死渲染循环）。
   */
  peek(assetId: string, assetFrame: Frame): DecodedFrame | null;
  /**
   * **同步**查"最接近且 ≤ target"的缓存帧（scrub 用）。
   *
   * 只向更早查找（`target - d`）：取更晚会显示未来帧，违反 hold-previous
   * （`map(s0 + Lp)` 必须是 null），单向查找让"距离相等取谁"的歧义在定义上不存在。
   *
   * `maxDistance` 是**闭区间**：`target - maxDistance <= k <= target` 都算命中；
   * `maxDistance = 0` 等价于 `peek`。
   *
   * 命中但 `k < target` 时 `exact === false`（调用方按 hold-previous 显示）。
   * 未命中返回 null。
   */
  peekNearest(assetId: string, target: Frame, maxDistance: number): DecodedFrame | null;
  /** 运行时关键帧索引（stss ∪ 实际解析到的 I 帧位置），presentation order 升序。 */
  keyframeIndex(assetId: string): number[];
  /** 上一次 seek 的解码距离（帧）；命中缓存为 0；未 seek 过为 null。 */
  lastFallbackFrames(assetId: string): number | null;
  /** 当前 epoch（调用方可据此丢弃自己的过期结果）。 */
  currentEpoch(assetId: string): number;
  /** 解码器 error 回调上报的最后一句话（诊断用；null = 未报错）。 */
  lastDecoderError(assetId: string): string | null;
  /** 取帧路径计数（诊断用；T09 调参时看"每帧平均解几个样本"）。 */
  diagnostics(assetId: string): PoolDiagnostics;
  /**
   * 解码一段音频压缩帧（T10 的入口）。返回的 `AudioData` **归调用方所有**（必须 close）。
   */
  decodeAudioRange(assetId: string, startIndex: number, count: number): Promise<Result<AudioData[]>>;
}

/* ---------- 内部类型 ---------- */

/** 缓存条目。 */
interface CachedFrame {
  frame: VideoFrame;
  bytes: number;
  /** LRU 计数（单调递增，避免依赖 Date.now）。 */
  usedAt: number;
}

/** 素材的静态索引（与解码会话无关，release 时一并丢弃）。 */
interface RegisteredAsset {
  assetId: string;
  probe: Mp4ProbeResult;
  source: BlobLike;
  /** presentation order 样本（== `probe.samples`）。 */
  presentation: SampleIndexEntry[];
  /** 解码顺序（`dtsUs` 升序；dts 严格递增故顺序稳定）。 */
  decodeOrder: SampleIndexEntry[];
  /** 解码序位置 → presentation index。 */
  presentationOfDecode: Int32Array;
  /** presentation index → 解码序位置。 */
  decodePositionOf: Int32Array;
  /** `ptsUs` → presentation index（输出帧反查用；重复 PTS 取先出现者）。 */
  indexByPtsUs: Map<number, number>;
  /** 关键帧集合（presentation order，升序；stss ∪ 运行时发现）。 */
  keyframes: number[];
  /** 每个 presentation index 是否为已知关键帧（去重用）。 */
  keyframeFlags: Uint8Array;
  /** 视频时间戳无法反查的次数（诊断用：正常应恒为 0）。 */
  unmappedTimestamps: number;
}

/** 一次 seek 的待决状态。 */
interface PendingSeek {
  target: Frame;
  epoch: number;
  settled: boolean;
  /** 最优的"更早帧"（hold previous 兜底）。 */
  bestIndex: Frame | null;
  resolve: (value: DecodedFrame) => void;
  /** 内部失败：`PoolError` 或 `VEditorError` 都可能（都带可读 code/message）。 */
  fail: (failure: unknown) => void;
}

/** 视频会话。 */
interface VideoSession {
  asset: RegisteredAsset;
  decoder: VideoDecoder;
  config: VideoDecoderConfig;
  /** 当前 epoch：每次 seek 自增；迟到的旧 epoch 输出直接 close。 */
  epoch: number;
  /** 下一个要提交的解码序位置。 */
  nextDecodePosition: number;
  pending: PendingSeek | null;
  usedAt: number;
  /** 上次成功交付的 presentation index（用于"顺序播放"快路径）。 */
  lastServedIndex: Frame | null;
  /** 已经输出过的最大 presentation index（判断"在途"还是"已丢"）。 */
  emittedUpTo: Frame;
  /**
   * 预读缓存窗口（presentation index，闭区间）。
   *
   * 为什么用会话级窗口而不是"当前 pending.target"：顺序播放时下一次请求会在上一批
   * 输出还没排空前就到达并替换 pending，若按 pending 判定，这批输出会被当成"多余帧"丢掉，
   * 下一帧又要从关键帧重解（实测 900 帧播放会退化成 614 次全量 seek）。
   */
  windowFrom: Frame;
  windowTo: Frame;
  /** 解码器输出时间戳无法反查时的兜底计数（从 seek 起点开始）。 */
  fallbackCounter: number;
  /**
   * true = 解码器处于"必须从关键帧开始"的状态（刚 `configure()` / 刚 `flush()`）。
   *
   * WebCodecs 规定：`configure()` 或 `flush()` 之后提交的第一个 chunk 必须是 key，
   * 否则抛 `A key frame is required after configure() or flush()`。
   * 顺序播放的递增提交必须依赖这条状态判断，否则播放第二帧就会炸（真机实测，非理论推断）。
   */
  needsKeyframe: boolean;
  /** 解码器 error 回调上报的最后一句话（诊断用；null = 从未报错）。 */
  lastError: string | null;
  /** 输出回调累计次数（判断"解码器是否还在动"）。 */
  outputsSeen: number;
  /** 已因卡死重建过几次（诊断用；>1 说明持有帧数又把解码器逼停了）。 */
  wedgedRebuilds: number;
  /** 诊断计数。 */
  cacheHits: number;
  inFlightHits: number;
  sequentialFeeds: number;
  fullSeeks: number;
  samplesFed: number;
  lastFallbackFrames: number | null;
}

/** 音频会话。 */
interface AudioSession {
  asset: RegisteredAsset;
  decoder: AudioDecoder;
  config: AudioDecoderConfig;
  usedAt: number;
}

/** 内部异常（在 `ensureFrame` 边界转成 `Result`）。 */
class PoolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'PoolError';
  }

  toEditorError(): VEditorError {
    return makeError(this.code, this.message, this.detail);
  }
}

/* ---------- 纯函数辅助 ---------- */

/** `VEditorError` 结构判断（`closeVideoSession` 会直接 reject 一个错误对象）。 */
function isEditorError(value: unknown): value is VEditorError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { code?: unknown; message?: unknown; at?: unknown };
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.message === 'string' &&
    typeof candidate.at === 'number'
  );
}

/** 默认让出主线程：`setTimeout(0)`（宏任务，浏览器会先跑 rAF）。 */
function defaultYieldToMain(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** 估算一帧占用的字节数（用于 64MB 预算）。 */
/** 交付用克隆：clone 只增加底层缓冲引用计数；帧已 close 时退化为原引用（调用方会再校验）。 */
function cloneOrSame(frame: VideoFrame): VideoFrame {
  try {
    return frame.clone();
  } catch {
    return frame;
  }
}

function frameBytesOf(frame: VideoFrame): number {
  const maybeAllocation = (frame as VideoFrame & {
    allocationSize?: (options?: { format?: string }) => number;
  }).allocationSize;
  if (typeof maybeAllocation === 'function') {
    try {
      // **必须显式指定 I420**：`allocationSize()` 缺省按 RGBA 计算，
      // 1920×1080 会算成 7.9MB（实际 I420 只有 3.1MB）。虚高 2.67 倍的后果是
      // 单帧就吃掉 8MB 预算的 99%，缓存几乎存不住任何帧 —— LRU 立刻把它淘汰并 close，
      // 调用方拿到的是已失效的帧（displayWidth=0），预览全黑。
      const size = maybeAllocation.call(frame, { format: 'I420' });
      if (Number.isFinite(size) && size > 0) return size;
    } catch {
      // 某些格式不支持 allocationSize()，退化为按像素估算
    }
  }
  const width = frame.codedWidth > 0 ? frame.codedWidth : frame.displayWidth;
  const height = frame.codedHeight > 0 ? frame.codedHeight : frame.displayHeight;
  // yuv420 的经典估算：w * h * 1.5
  return Math.max(1, Math.round(width * height * 1.5));
}

/** 二分查找 ≤ target 的最近关键帧下标（返回数组下标，无则 -1）。 */
function findKeyframeAtOrBefore(keyframes: number[], target: Frame): number {
  let low = 0;
  let high = keyframes.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const value = keyframes[middle];
    if (value === undefined) break;
    if (value <= target) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/** 从 `avcC` 记录里取 NAL 长度前缀的字节数（1/2/4）。 */
function nalLengthSizeOf(description: Uint8Array | null): number {
  if (description === null || description.length < 5) return 4;
  const size = (description[4] ?? 0) & 0x03;
  return size === 1 || size === 2 ? size : 4;
}

/**
 * 判断样本字节里是否含**同步（随机访问）NAL**：用来建立运行时关键帧索引。
 *
 * 为什么不能只信 `stss`：部分编码器的 `stss` 不完整（架构 §8.5 长 GOP 行），
 * 而多解出来的 I 帧位置能让下一次 seek 的回退距离更短（T06 ⑧）。
 * 解析失败一律返回 false（宁可少记一个关键帧，也不能把 P 帧标成关键帧——那会解出花屏）。
 */
function hasSyncNal(data: Uint8Array, codec: string, nalLengthSize: number): boolean {
  if (codec.startsWith('avc1') || codec.startsWith('avc3')) {
    let offset = 0;
    while (offset + nalLengthSize < data.length) {
      let length = 0;
      for (let i = 0; i < nalLengthSize; i += 1) length = length * 256 + (data[offset + i] ?? 0);
      offset += nalLengthSize;
      if (length <= 0 || offset >= data.length) return false;
      const nalType = (data[offset] ?? 0) & 0x1f;
      if (nalType === 5) return true; // IDR slice
      offset += length;
    }
    return false;
  }
  if (codec.startsWith('hvc1') || codec.startsWith('hev1')) {
    let offset = 0;
    while (offset + 4 < data.length) {
      let length = 0;
      for (let i = 0; i < 4; i += 1) length = length * 256 + (data[offset + i] ?? 0);
      offset += 4;
      if (length <= 0 || offset >= data.length) return false;
      const nalType = ((data[offset] ?? 0) >> 1) & 0x3f;
      // 16=BLA_W_LP … 21=CRA_NUT（HEVC 的随机访问点）
      if (nalType >= 16 && nalType <= 21) return true;
      offset += length;
    }
    return false;
  }
  // VP9/AV1：解封装层没有 NAL 概念，只信样本表
  return false;
}

/* ---------- 帧缓存 ---------- */

/**
 * 帧缓存：全局 64MB 字节预算 + 单素材帧数上限，LRU 淘汰。
 *
 * 注意力集中点：**淘汰必须 close**。`put()` 把被淘汰条目返回给调用方统一 close，
 * 避免缓存层直接碰统计字段（统计的单一写入点在池里）。
 */
class FrameCache {
  private readonly byAsset = new Map<string, Map<number, CachedFrame>>();
  private bytesUsed = 0;
  private frameCount = 0;

  constructor(
    private readonly budgetBytes: number,
    private readonly maxPerAsset: number,
  ) {}

  /** 当前持有的帧数。 */
  count(): number {
    return this.frameCount;
  }

  /** 取（不改变所有权）。 */
  get(assetId: string, assetFrame: number): CachedFrame | undefined {
    const frames = this.byAsset.get(assetId);
    if (frames === undefined) return undefined;
    return frames.get(assetFrame);
  }

  /**
   * 放入一帧，返回被淘汰的条目（**调用方负责 close 它们**）。
   *
   * 同帧号已存在时先移出旧的（也作为淘汰返回），保证同一个帧号不会双份持有。
   */
  put(assetId: string, assetFrame: number, entry: CachedFrame): CachedFrame[] {
    const evicted: CachedFrame[] = [];
    let frames = this.byAsset.get(assetId);
    if (frames === undefined) {
      frames = new Map<number, CachedFrame>();
      this.byAsset.set(assetId, frames);
    }
    const previous = frames.get(assetFrame);
    if (previous !== undefined) {
      frames.delete(assetFrame);
      this.bytesUsed -= previous.bytes;
      this.frameCount -= 1;
      evicted.push(previous);
    }
    frames.set(assetFrame, entry);
    this.bytesUsed += entry.bytes;
    this.frameCount += 1;

    this.evict(assetId, evicted);
    return evicted;
  }

  /** 删除某帧（所有权交回调用方）。 */
  remove(assetId: string, assetFrame: number): CachedFrame | undefined {
    const frames = this.byAsset.get(assetId);
    if (frames === undefined) return undefined;
    const entry = frames.get(assetFrame);
    if (entry === undefined) return undefined;
    frames.delete(assetFrame);
    this.bytesUsed -= entry.bytes;
    this.frameCount -= 1;
    return entry;
  }

  /** 取走某素材的全部缓存帧（所有权交回调用方）。 */
  removeAsset(assetId: string): CachedFrame[] {
    const frames = this.byAsset.get(assetId);
    if (frames === undefined) return [];
    const entries = [...frames.values()];
    for (const entry of entries) {
      this.bytesUsed -= entry.bytes;
      this.frameCount -= 1;
    }
    this.byAsset.delete(assetId);
    return entries;
  }

  /** 取走全部缓存帧。 */
  removeAll(): CachedFrame[] {
    const entries: CachedFrame[] = [];
    for (const assetId of [...this.byAsset.keys()]) entries.push(...this.removeAsset(assetId));
    return entries;
  }

  /** 按预算与单素材上限淘汰（全局 LRU）。 */
  private evict(assetId: string, sink: CachedFrame[]): void {
    const frames = this.byAsset.get(assetId);
    if (frames !== undefined) {
      while (frames.size > this.maxPerAsset) {
        const oldest = this.findOldest(assetId);
        if (oldest === null) break;
        sink.push(this.detach(oldest.assetId, oldest.assetFrame));
      }
    }
    while (this.bytesUsed > this.budgetBytes) {
      // **保底保留 1 帧**：若单帧本身就超预算（4K/8K），淘汰它会让缓存永远为空、
      // 调用方永远拿到失效帧。宁可短暂超预算，也不能一帧都不留。
      if (this.frameCount <= 1) break;
      const oldest = this.findOldest(null);
      if (oldest === null) break;
      sink.push(this.detach(oldest.assetId, oldest.assetFrame));
    }
  }

  /** 找最久未使用的条目；`assetId === null` 表示全局。 */
  private findOldest(assetId: string | null): { assetId: string; assetFrame: number; usedAt: number } | null {
    let best: { assetId: string; assetFrame: number; usedAt: number } | null = null;
    const assetIds = assetId === null ? [...this.byAsset.keys()] : [assetId];
    for (const id of assetIds) {
      const frames = this.byAsset.get(id);
      if (frames === undefined) continue;
      for (const [frameIndex, entry] of frames) {
        if (best === null || entry.usedAt < best.usedAt) {
          best = { assetId: id, assetFrame: frameIndex, usedAt: entry.usedAt };
        }
      }
    }
    return best;
  }

  /** 从表里摘下并扣减计数（所有权交回调用方）。 */
  private detach(assetId: string, assetFrame: number): CachedFrame {
    const frames = this.byAsset.get(assetId);
    const entry = frames?.get(assetFrame);
    if (entry === undefined) {
      throw new Error(`FrameCache: 内部错误，detach 丢失条目 ${assetId}#${assetFrame}`);
    }
    frames?.delete(assetFrame);
    if (frames !== undefined && frames.size === 0) this.byAsset.delete(assetId);
    this.bytesUsed -= entry.bytes;
    this.frameCount -= 1;
    return entry;
  }
}

/* ---------- 池实现 ---------- */

class DecoderPoolImpl implements DecoderPool {
  private readonly assets = new Map<string, RegisteredAsset>();
  private readonly videoSessions = new Map<string, VideoSession>();
  private readonly audioSessions = new Map<string, AudioSession>();
  private readonly cache: FrameCache;

  private readonly maxVideoSessions: number;
  private readonly maxAudioSessions: number;
  private readonly positioningThresholdFrames: number;
  private readonly decodeQueueHighWater: number;
  private readonly yieldEveryFrames: number;
  private readonly onPositioning: ((event: PositioningEvent) => void) | undefined;
  private readonly yieldToMain: () => Promise<void>;

  private totalCreated = 0;
  private totalClosed = 0;
  /** 缓存中命中到已失效帧（displayWidth=0）而被丢弃的次数。 */
  private staleFramesDropped = 0;
  /** 会话实例计数（抓"每次 seek 重建解码器"；与 totalCreated 的帧计数无关）。 */
  private sessionsCreated = 0;
  private lruTick = 0;
  private disposed = false;

  constructor(options: DecoderPoolOptions = {}) {
    this.cache = new FrameCache(
      options.frameCacheBudgetBytes ?? DEFAULT_FRAME_CACHE_BUDGET_BYTES,
      options.maxCachedFramesPerAsset ?? DEFAULT_MAX_CACHED_FRAMES_PER_ASSET,
    );
    this.maxVideoSessions = Math.max(1, options.maxVideoSessions ?? DEFAULT_MAX_VIDEO_SESSIONS);
    this.maxAudioSessions = Math.max(1, options.maxAudioSessions ?? DEFAULT_MAX_AUDIO_SESSIONS);
    this.positioningThresholdFrames = Math.max(
      0,
      options.positioningThresholdFrames ?? DEFAULT_POSITIONING_THRESHOLD_FRAMES,
    );
    this.decodeQueueHighWater = Math.max(1, options.decodeQueueHighWater ?? DEFAULT_DECODE_QUEUE_HIGH_WATER);
    this.yieldEveryFrames = Math.max(1, options.yieldEveryFrames ?? DEFAULT_YIELD_EVERY_FRAMES);
    this.onPositioning = options.onPositioning;
    this.yieldToMain = options.yieldToMain ?? defaultYieldToMain;
  }

  /* ----- 注册 / 释放 ----- */

  register(assetId: string, probe: Mp4ProbeResult, source: BlobLike): void {
    if (this.disposed) {
      throw new PoolError('E_DECODE_FAILED', '解码器池已 dispose', assetId);
    }
    if (probe.hasVideo && probe.video === null) {
      throw new PoolError('E_DECODE_FAILED', '探测结果声明有视频轨但缺少视频配置', assetId);
    }
    /**
     * **覆盖注册**（重链 / 切代理会走到这里）：先把旧会话与帧缓存清掉。
     *
     * 不清的话，切源后取第 N 帧会命中**上一个源**留下的缓存帧，
     * 或者沿用旧会话用旧源解码 —— 表现是"重链了但还是旧画面"，永远不会自愈。
     *
     * 用 `invalidate`（**纯同步**）而不是 `void release(...)`：
     * `release` 是 async，即使把清缓存提到同步段，它启动的 promise 仍会
     * 在调用方的后续 await 之间穿插，实测把导出混音刚缓存的样本清空
     * （症状：**MP4 导出没有音轨**、粗剪找不到停顿）。
     */
    this.invalidate(assetId);
    const asset = this.prepareAsset(assetId, probe, source);
    this.assets.set(assetId, asset);
  }

  /**
   * **同步**让素材立刻不可用（删源 + 清帧缓存），会话关闭留给 `unregister`。
   *
   * 为什么需要同步版：`unregister` 是异步的，调用方 `void` 掉之后立刻重绘，
   * 那一帧仍然能拿到源 —— 表现是"素材已离线，画面却还在动"。
   */
  invalidate(assetId: string): void {
    this.assets.delete(assetId);
    for (const entry of this.cache.removeAsset(assetId)) this.closeFrame(entry.frame);
    /**
     * 会话**同步摘除引用、异步关闭资源**。
     *
     * 为什么同步摘：会话是按 `assetId` 复用的，`ensureFrame` 只看有没有会话、
     * 不看"源换没换"。切源（重链 / 切代理）后若沿用旧会话，会用**旧源**解码 ——
     * 表现是"重链了但画面还是旧的"。
     *
     * 为什么异步关：`VideoDecoder.close()` 前要 flush，那是异步的；
     * 但**引用必须先摘**，否则 `register` 之后新会话会被误关。
     */
    const video = this.videoSessions.get(assetId);
    if (video !== undefined) {
      this.videoSessions.delete(assetId);
      if (video.pending !== null) {
        const pending = video.pending;
        video.pending = null;
        pending.settled = true;
        pending.fail(makeError('E_DECODE_FAILED', 'seek 被会话关闭中断', assetId));
      }
      void this.flushQuietly(video.decoder).then(() => {
        if (video.decoder.state !== 'closed') video.decoder.close();
      });
    }
    const audio = this.audioSessions.get(assetId);
    if (audio !== undefined) {
      this.audioSessions.delete(assetId);
      void this.flushQuietly(audio.decoder).then(() => {
        if (audio.decoder.state !== 'closed') audio.decoder.close();
      });
      for (const data of this.takeAudioOutput(assetId)) data.close();
    }
  }

  async unregister(assetId: string): Promise<void> {
    this.invalidate(assetId);
    await this.release(assetId);
  }

  /**
   * 释放某素材的会话与帧缓存。
   *
   * **缓存清理必须在 `await` 之前（同步段）完成**。
   *
   * 原来的顺序是"先 await 关会话、再清缓存"，于是 `void release(...)` 的
   * 清缓存动作会被推迟到调用方后续逻辑之后 —— `register`（覆盖注册）里
   * `void release` + 紧跟着的 `ensureFrame` 就会出现：
   * 新注册后刚缓存的帧，被上一次 release 的异步段清掉。
   * 实测表现：**MP4 导出没有音轨**（混音时样本被清空 → 全 0）、粗剪找不到停顿。
   */
  async release(assetId: string): Promise<void> {
    const cached = this.cache.removeAsset(assetId);
    await this.closeVideoSession(assetId);
    await this.closeAudioSession(assetId);
    for (const entry of cached) {
      this.closeFrame(entry.frame);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const assetId of [...this.videoSessions.keys()]) await this.closeVideoSession(assetId);
    for (const assetId of [...this.audioSessions.keys()]) await this.closeAudioSession(assetId);
    for (const entry of this.cache.removeAll()) this.closeFrame(entry.frame);
    this.assets.clear();
  }

  /* ----- 统计 ----- */

  stats(): DecoderPoolStats {
    return {
      openSessions: this.videoSessions.size + this.audioSessions.size,
      openFrames: this.cache.count(),
      totalCreated: this.totalCreated,
      totalClosed: this.totalClosed,
      sessionsCreated: this.sessionsCreated,
    };
  }

  /* ----- 同步取帧（T09 播放循环专用，禁止 await） ----- */

  /**
   * 同步查缓存。纯读：不 touch LRU、不 evict、不发起解码。
   *
   * 为什么不 touch：peek 在播放循环里每 tick 调用一次，如果 touch 会不断改写 usedAt，
   * 使"最近被显示过的帧"永远不被淘汰，缓存被少数几帧长期占满。
   * 淘汰只发生在 put 时，peek 不改变缓存状态。
   */
  peek(assetId: string, assetFrame: Frame): DecodedFrame | null {
    const hit = this.cache.get(assetId, assetFrame);
    if (hit === undefined) return null;
    return { frame: hit.frame, assetFrame, fromCache: true, exact: true };
  }

  /**
   * 同步查"最接近且 ≤ target"的缓存帧。
   *
   * 只向更早查找：取更晚会显示未来帧，违反 hold-previous。单向查找也让"距离相等取谁"
   * 的问题在定义上不存在。
   *
   * 注意：本方法**不修改** `lastFallbackFrames`——那是 seek 的诊断量，peek 只是查询，
   * 若它写了该字段，T06 ⑤ 的回退距离断言会被 peek 污染。
   */
  peekNearest(assetId: string, target: Frame, maxDistance: number): DecodedFrame | null {
    for (let d = 0; d <= maxDistance; d += 1) {
      const k = target - d;
      if (k < 0) break;
      const hit = this.cache.get(assetId, k);
      if (hit !== undefined) {
        return { frame: hit.frame, assetFrame: k, fromCache: true, exact: k === target };
      }
    }
    return null;
  }

  keyframeIndex(assetId: string): number[] {
    const asset = this.assets.get(assetId);
    return asset === undefined ? [] : [...asset.keyframes];
  }

  lastFallbackFrames(assetId: string): number | null {
    const session = this.videoSessions.get(assetId);
    return session === undefined ? null : session.lastFallbackFrames;
  }

  currentEpoch(assetId: string): number {
    return this.videoSessions.get(assetId)?.epoch ?? 0;
  }

  lastDecoderError(assetId: string): string | null {
    return this.videoSessions.get(assetId)?.lastError ?? null;
  }

  diagnostics(assetId: string): PoolDiagnostics {
    const session = this.videoSessions.get(assetId);
    if (session === undefined) {
      return {
        cacheHits: 0,
        inFlightHits: 0,
        sequentialFeeds: 0,
        fullSeeks: 0,
        samplesFed: 0,
        unmappedTimestamps: 0,
        keyframeCount: this.assets.get(assetId)?.keyframes.length ?? 0,
      };
    }
    return {
      cacheHits: session.cacheHits,
      inFlightHits: session.inFlightHits,
      sequentialFeeds: session.sequentialFeeds,
      fullSeeks: session.fullSeeks,
      samplesFed: session.samplesFed,
      unmappedTimestamps: session.asset.unmappedTimestamps,
      keyframeCount: session.asset.keyframes.length,
    };
  }

  /* ----- 帧获取 ----- */

  async ensureFrame(assetId: string, assetFrame: Frame, epoch?: number): Promise<Result<DecodedFrame>> {
    const asset = this.assets.get(assetId);
    if (asset === undefined) {
      return {
        ok: false,
        error: makeError('E_ASSET_OFFLINE', '素材未注册到解码器池', assetId),
      };
    }
    if (!asset.probe.hasVideo) {
      return {
        ok: false,
        error: makeError('E_DECODE_FAILED', '素材没有视频轨，无法取帧', assetId),
      };
    }
    const frameCount = asset.presentation.length;
    if (!Number.isInteger(assetFrame) || assetFrame < 0 || assetFrame >= frameCount) {
      return {
        ok: false,
        error: makeError(
          'E_INVALID_TIMECODE',
          '素材帧号越界',
          `assetFrame=${assetFrame} 可用范围 0..${frameCount - 1}（${assetId}）`,
        ),
      };
    }
    if (!Number.isInteger(frameCount) || frameCount === 0) {
      return {
        ok: false,
        error: makeError('E_DECODE_FAILED', '视频样本索引为空', assetId),
      };
    }

    const cached = this.cache.get(assetId, assetFrame);
    // **有效性校验**：缓存里可能是已被 close 的帧（引擎重建 -> pool.dispose、
    // 或 LRU 淘汰与并发取帧的竞态）。close 后 `displayWidth` 归零，直接返回会让
    // 合成器拿到"尺寸 0 的层"，表现为预览黑屏/卡帧。失效即当未命中重解。
    if (cached !== undefined && (cached.frame.displayWidth <= 0 || cached.frame.displayHeight <= 0)) {
      this.cache.remove(assetId, assetFrame);
      this.staleFramesDropped += 1;
    } else if (cached !== undefined) {
      cached.usedAt = this.nextTick();
      const session = this.videoSessions.get(assetId);
      if (session !== undefined) {
        session.cacheHits += 1;
        session.lastFallbackFrames = 0;
        // 命中缓存也要推进"上次交付帧号"，否则顺序播放的快路径永远不成立，
        // 每一帧都会退化成"从关键帧重解"（实测会把 900 帧播放拖到 25 秒）。
        session.lastServedIndex = assetFrame;
      }
      // 统一契约：ensureFrame 交付的帧**归调用方所有**（必须 close），
      // 这样池的 LRU 淘汰就不会让调用方手里的帧变成「已 close 的空帧」。
      return {
        ok: true,
        value: { frame: cloneOrSame(cached.frame), assetFrame, fromCache: true, exact: true },
      };
    }

    const inFlight = this.videoSessions.get(assetId);
    if (
      inFlight !== undefined &&
      (inFlight.pending === null || inFlight.pending.settled) &&
      (asset.decodePositionOf[assetFrame] ?? assetFrame) < inFlight.nextDecodePosition &&
      assetFrame > inFlight.emittedUpTo
    ) {
      // 样本已提交但还没输出过（在途）：等最多 50ms 让它落到缓存。
      // 注意条件里的 `assetFrame > emittedUpTo`：已经输出过又被丢弃的帧等不来，
      // 直接走完整 seek，避免白等（这条判断把 900 帧播放从 3 万次解码降到 3 千次）。
      const arrived = await this.waitForCachedFrame(assetId, assetFrame, 20);
      if (arrived !== null) {
        arrived.usedAt = this.nextTick();
        inFlight.inFlightHits += 1;
        inFlight.lastFallbackFrames = 0;
        inFlight.lastServedIndex = assetFrame;
        return {
          ok: true,
          value: { frame: cloneOrSame(arrived.frame), assetFrame, fromCache: true, exact: true },
        };
      }
    }

    try {
      const value = await this.decodeTo(asset, assetFrame, epoch);
      return { ok: true, value };
    } catch (error) {
      if (error instanceof PoolError) return { ok: false, error: error.toEditorError() };
      if (isEditorError(error)) return { ok: false, error };
      return {
        ok: false,
        error: makeError(
          'E_DECODE_FAILED',
          '解码失败',
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
  }

  async seek(assetId: string, assetFrame: Frame, epoch?: number): Promise<Result<VideoFrame>> {
    const result = await this.ensureFrame(assetId, assetFrame, epoch);
    if (!result.ok) return result;
    // `ensureFrame` 在拿不到目标帧时会回退到"上一帧"（holdPrevious，供 T09 保持画面不黑屏），
    // 但那是 `exact:false`。`seek()` 是帧精确入口（R-008：误差必须 0 帧），
    // 绝不能把别的帧当成功返回——那会让调用方拿到一帧"看起来正常"的错画面。
    if (!result.value.exact) {
      return {
        ok: false,
        error: makeError(
          'E_DECODE_FAILED',
          '未能精确解码到目标帧',
          `请求 ${assetFrame} 帧，实际只有 ${result.value.assetFrame} 帧（${assetId}）`,
        ),
      };
    }
    return { ok: true, value: result.value.frame };
  }

  /* ----- 音频 ----- */

  async decodeAudioRange(assetId: string, startIndex: number, count: number): Promise<Result<AudioData[]>> {
    const asset = this.assets.get(assetId);
    if (asset === undefined) {
      return { ok: false, error: makeError('E_ASSET_OFFLINE', '素材未注册到解码器池', assetId) };
    }
    const audio = asset.probe.audio;
    if (audio === null || asset.probe.hasAudio === false) {
      return { ok: false, error: makeError('E_AUDIO_UNAVAILABLE', '素材没有音频轨', assetId) };
    }
    if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= audio.samples.length) {
      return {
        ok: false,
        error: makeError(
          'E_INVALID_TIMECODE',
          '音频样本下标越界',
          `startIndex=${startIndex} 可用范围 0..${audio.samples.length - 1}`,
        ),
      };
    }
    const safeCount = Math.max(0, Math.min(count, audio.samples.length - startIndex));
    if (safeCount === 0) return { ok: true, value: [] };

    let session: AudioSession;
    try {
      session = this.ensureAudioSession(asset);
    } catch (error) {
      if (error instanceof PoolError) return { ok: false, error: error.toEditorError() };
      throw error;
    }

    const data: AudioData[] = [];
    try {
      for (let i = startIndex; i < startIndex + safeCount; i += 1) {
        const sample = audio.samples[i];
        if (sample === undefined) break;
        const bytes = await readBlobBytes(asset.source, sample.offset, sample.offset + sample.size);
        session.decoder.decode(
          new EncodedAudioChunk({
            type: 'key',
            timestamp: sample.ptsUs,
            data: bytes,
          }),
        );
      }
      await session.decoder.flush();
      // 收尾：flush 完成后再取输出（输出回调在 flush 期间已把 AudioData 推入收集器）
      const collected = this.takeAudioOutput(assetId);
      for (const item of collected) data.push(item);
      return { ok: true, value: data };
    } catch (error) {
      return {
        ok: false,
        error: makeError(
          'E_DECODE_FAILED',
          '音频解码失败',
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
  }

  /** 音频输出暂存（按 assetId 分桶；flush 后一次性取走，所有权交给调用方）。 */
  private readonly audioOut = new Map<string, AudioData[]>();

  private takeAudioOutput(assetId: string): AudioData[] {
    const items = this.audioOut.get(assetId) ?? [];
    this.audioOut.delete(assetId);
    return items;
  }

  /* ----- 内部：素材索引 ----- */

  private prepareAsset(assetId: string, probe: Mp4ProbeResult, source: BlobLike): RegisteredAsset {
    const presentation = probe.samples;
    const decodeOrder: SampleIndexEntry[] = [];
    const decodeOrderOf = new Int32Array(presentation.length);
    const sorted = presentation
      .map((_, index) => index)
      .sort((a, b) => {
        const left = presentation[a];
        const right = presentation[b];
        const dtsDelta = (left?.dtsUs ?? 0) - (right?.dtsUs ?? 0);
        if (dtsDelta !== 0) return dtsDelta;
        return a - b;
      });
    for (let position = 0; position < sorted.length; position += 1) {
      const index = sorted[position] ?? 0;
      const sample = presentation[index];
      if (sample !== undefined) decodeOrder.push(sample);
      decodeOrderOf[index] = position;
    }

    const presentationOfDecode = new Int32Array(decodeOrder.length);
    for (let position = 0; position < decodeOrder.length; position += 1) {
      presentationOfDecode[position] = decodeOrder[position]?.index ?? position;
    }

    const indexByPtsUs = new Map<number, number>();
    for (const sample of presentation) {
      if (!indexByPtsUs.has(sample.ptsUs)) indexByPtsUs.set(sample.ptsUs, sample.index);
    }

    const keyframeFlags = new Uint8Array(presentation.length);
    const keyframes: number[] = [];
    const probeKeyframes = probe.keyframeIndex ?? [];
    for (const index of probeKeyframes) {
      if (index < 0 || index >= presentation.length) continue;
      if (keyframeFlags[index] === 1) continue;
      keyframeFlags[index] = 1;
      keyframes.push(index);
    }
    keyframes.sort((a, b) => a - b);
    // 无 stss（demux 返回全帧关键帧）时 keyframes 就是全部帧号，无需再补
    if (keyframes.length === 0 && presentation.length > 0 && probe.keyframeIndex === null) {
      for (let i = 0; i < presentation.length; i += 1) {
        keyframeFlags[i] = 1;
        keyframes.push(i);
      }
    }

    return {
      assetId,
      probe,
      source,
      presentation,
      decodeOrder,
      presentationOfDecode,
      decodePositionOf: decodeOrderOf,
      indexByPtsUs,
      keyframes,
      keyframeFlags,
      unmappedTimestamps: 0,
    };
  }

  /* ----- 内部：会话管理（LRU close） ----- */

  private nextTick(): number {
    this.lruTick += 1;
    return this.lruTick;
  }

  private ensureVideoSession(asset: RegisteredAsset): VideoSession {
    const existing = this.videoSessions.get(asset.assetId);
    if (existing !== undefined && existing.decoder.state !== 'closed') {
      existing.usedAt = this.nextTick();
      return existing;
    }
    const video = asset.probe.video;
    if (video === null) {
      throw new PoolError('E_DECODE_FAILED', '缺少视频解码配置', asset.assetId);
    }
    const config: VideoDecoderConfig = {
      codec: video.codec,
      codedWidth: video.width,
      codedHeight: video.height,
      optimizeForLatency: true,
    };
    if (video.description !== null) config.description = video.description;

    // 会话实例计数：抓"每次 seek 都重建解码器"。与 totalCreated（帧计数）无关。
    this.sessionsCreated += 1;
    const session: VideoSession = {
      asset,
      decoder: new VideoDecoder({
        output: (frame: VideoFrame) => this.handleVideoFrame(asset.assetId, frame),
        error: (decodeError: DOMException) => this.handleVideoError(asset.assetId, decodeError),
      }),
      config,
      epoch: 0,
      nextDecodePosition: 0,
      pending: null,
      usedAt: this.nextTick(),
      lastServedIndex: null,
      emittedUpTo: -1,
      windowFrom: -1,
      windowTo: -1,
      fallbackCounter: 0,
      lastError: null,
      outputsSeen: 0,
      wedgedRebuilds: 0,
      cacheHits: 0,
      inFlightHits: 0,
      sequentialFeeds: 0,
      fullSeeks: 0,
      samplesFed: 0,
      needsKeyframe: true,
      lastFallbackFrames: null,
    };
    session.decoder.configure(config);
    this.videoSessions.set(asset.assetId, session);
    void this.enforceSessionLimits();
    return session;
  }

  private ensureAudioSession(asset: RegisteredAsset): AudioSession {
    const existing = this.audioSessions.get(asset.assetId);
    if (existing !== undefined && existing.decoder.state !== 'closed') {
      existing.usedAt = this.nextTick();
      return existing;
    }
    const audio = asset.probe.audio;
    if (audio === null) {
      throw new PoolError('E_AUDIO_UNAVAILABLE', '缺少音频解码配置', asset.assetId);
    }
    const config: AudioDecoderConfig = {
      codec: audio.codec,
      sampleRate: audio.sampleRate,
      numberOfChannels: audio.channels,
    };
    if (audio.description !== null) config.description = audio.description;
    const assetId = asset.assetId;
    this.sessionsCreated += 1;
    const session: AudioSession = {
      asset,
      decoder: new AudioDecoder({
        output: (data: AudioData) => {
          const bucket = this.audioOut.get(assetId);
          if (bucket === undefined) this.audioOut.set(assetId, [data]);
          else bucket.push(data);
        },
        error: () => {
          // 音频错误不打断视频：记录到诊断桶，由调用方根据返回结果处理
          this.audioOut.delete(assetId);
        },
      }),
      config,
      usedAt: this.nextTick(),
    };
    session.decoder.configure(config);
    this.audioSessions.set(assetId, session);
    void this.enforceAudioLimits();
    return session;
  }

  /** 视频会话超限：close 最旧者（T06 ④）。 */
  private async enforceSessionLimits(): Promise<void> {
    while (this.videoSessions.size > this.maxVideoSessions) {
      let oldestId: string | null = null;
      let oldestTick = Number.POSITIVE_INFINITY;
      for (const [assetId, session] of this.videoSessions) {
        if (session.usedAt < oldestTick) {
          oldestTick = session.usedAt;
          oldestId = assetId;
        }
      }
      if (oldestId === null) break;
      await this.closeVideoSession(oldestId);
    }
  }

  private async enforceAudioLimits(): Promise<void> {
    while (this.audioSessions.size > this.maxAudioSessions) {
      let oldestId: string | null = null;
      let oldestTick = Number.POSITIVE_INFINITY;
      for (const [assetId, session] of this.audioSessions) {
        if (session.usedAt < oldestTick) {
          oldestTick = session.usedAt;
          oldestId = assetId;
        }
      }
      if (oldestId === null) break;
      await this.closeAudioSession(oldestId);
    }
  }

  /** 关闭视频会话：先 flush（确保无 pending frame）再 close，最后清掉该素材缓存帧。 */
  private async closeVideoSession(assetId: string): Promise<void> {
    const session = this.videoSessions.get(assetId);
    if (session === undefined) return;
    this.videoSessions.delete(assetId);
    if (session.pending !== null) {
      // 会话销毁时未完成的 seek 必须显式失败，不能让调用方挂住
      const pending = session.pending;
      session.pending = null;
      pending.settled = true;
      pending.fail(makeError('E_DECODE_FAILED', 'seek 被会话关闭中断', assetId));
    }
    await this.flushQuietly(session.decoder);
    if (session.decoder.state !== 'closed') session.decoder.close();
    for (const entry of this.cache.removeAsset(assetId)) this.closeFrame(entry.frame);
  }

  private async closeAudioSession(assetId: string): Promise<void> {
    const session = this.audioSessions.get(assetId);
    if (session === undefined) return;
    this.audioSessions.delete(assetId);
    await this.flushQuietly(session.decoder);
    if (session.decoder.state !== 'closed') session.decoder.close();
    // 未取走的 AudioData 必须 close，否则 WebCodecs 会持续占用内存
    for (const data of this.takeAudioOutput(assetId)) data.close();
  }

  /**
   * close 之前必须 flush（架构要求）；失败或超时都静默继续。
   *
   * 为什么必须带超时：解码器进入 error 状态后 `flush()` 可能**永不 resolve**
   * （实测会让整个播放/seek 挂住），这里 250ms 后放弃并继续 close。
   */
  private async flushQuietly(decoder: VideoDecoder | AudioDecoder): Promise<void> {
    if (decoder.state === 'closed') return;
    try {
      await Promise.race([
        decoder.flush(),
        new Promise<void>((resolve) => {
          setTimeout(resolve, FLUSH_TIMEOUT_MS);
        }),
      ]);
    } catch {
      // 解码器已进入 error 状态：flush 必然失败，仍要 close 掉
    }
  }

  /* ----- 内部：解码 ----- */

  /**
   * 解码到目标帧。
   *
   * `sequential` 为 true 时不 reset：调用方在顺序取帧（播放），继续喂下一个样本即可；
   * 否则走完整 seek：reset() → configure() → 从关键帧开始。
   */
  private async decodeTo(asset: RegisteredAsset, target: Frame, epoch?: number): Promise<DecodedFrame> {
    const session = this.ensureVideoSession(asset);
    const decoder = session.decoder;

    const targetPosition = asset.decodePositionOf[target] ?? target;
    // 顺序播放快路径：只能"继续往前喂"。若目标样本已经喂过（position < watermark），
    // 再喂一次会让解码器收到非单调 DTS（Chrome 直接 EncodingError: Decoding error），
    // 因此那种情况必须走完整 seek（从关键帧重解）。
    const pendingIdle = session.pending === null || session.pending.settled;
    // 只要"目标样本还没提交过"，就可以从 watermark 继续往前喂（不必逐帧连续）。
    // 这既覆盖顺序播放，也覆盖播放时偶尔跳几帧的情况，避免每次都从关键帧重解。
    const sequential =
      epoch === undefined &&
      pendingIdle &&
      session.needsKeyframe === false &&
      decoder.state === 'configured' &&
      targetPosition >= session.nextDecodePosition;

    const token = epoch ?? session.epoch + 1;

    // 取消旧 pending（同一素材被新 seek 抢占）
    if (session.pending !== null && session.pending.epoch !== token) {
      const stale = session.pending;
      session.pending = null;
      stale.settled = true;
      stale.fail(makeError('E_DECODE_FAILED', EPOCH_CANCEL_MESSAGE, `${asset.assetId} epoch=${token}`));
    }
    session.epoch = token;

    let startPosition = Math.max(0, targetPosition);
    let fallbackFrames = 0;

    if (sequential === false) {
      const keyframeArrayIndex = findKeyframeAtOrBefore(asset.keyframes, target);
      const keyframeIndex = keyframeArrayIndex < 0 ? 0 : (asset.keyframes[keyframeArrayIndex] ?? 0);
      startPosition = Math.max(0, asset.decodePositionOf[keyframeIndex] ?? 0);
      fallbackFrames = target - keyframeIndex;
      if (decoder.state === 'configured') decoder.reset();
      decoder.configure(session.config);
      session.needsKeyframe = true;
      session.fullSeeks += 1;
      session.fallbackCounter = startPosition;
      if (fallbackFrames > this.positioningThresholdFrames && this.onPositioning !== undefined) {
        this.onPositioning({ assetId: asset.assetId, targetFrame: target, fallbackFrames, phase: 'start' });
      }
    } else {
      // 顺序播放：从 watermark 继续（上面的条件已保证 targetPosition >= watermark）
      startPosition = Math.max(0, session.nextDecodePosition);
      session.sequentialFeeds += 1;
    }
    session.lastFallbackFrames = fallbackFrames;

    const pending: PendingSeek = {
      target,
      epoch: token,
      settled: false,
      bestIndex: null,
      resolve: () => {},
      fail: () => {},
    };
    const promise = new Promise<DecodedFrame>((resolve, reject) => {
      pending.resolve = resolve;
      pending.fail = (failure: unknown) => reject(failure);
    });
    session.pending = pending;

    // 预读：B 帧需要后续样本作参考才能输出目标帧；这些"目标之后"的输出会进缓存
    // （等价于 task:T09 的 preroll，超出 24 帧由 LRU 淘汰），不会丢帧也不会重复喂。
    const lastPosition = Math.min(
      asset.decodeOrder.length - 1,
      Math.max(startPosition, targetPosition) + SEEK_LOOKAHEAD_SAMPLES,
    );
    const outputsBefore = session.outputsSeen;
    await this.feed(asset, session, startPosition, lastPosition, token);

    if (!pending.settled) {
      // 目标帧可能还压在解码器里：先等一次 dequeue（短超时），避免不必要地 flush 掉流水线
      await this.waitForOutput(decoder, DEQUEUE_TIMEOUT_MS);
    }

    if (!pending.settled) {
      // 最后手段：flush 把帧挤出来。flush 后解码器回到"必须从关键帧开始"的状态
      await this.flushQuietly(decoder);
      session.needsKeyframe = true;
    }

    if (!pending.settled) {
      // **卡死检测**：队列里还有样本、一个输出都没有、解码器也没报错 —— 这正是
      // "应用持有过多未 close 的帧"时 Chromium 的静默停摆（实测：持有 ≥9 帧即触发，
      // 见文件头 DEFAULT_FRAME_CACHE_BUDGET_BYTES 的实测表）。此时无论等多久都不会出帧，
      // 唯一出路是丢掉这个解码器重建，再从关键帧重解一次。
      const wedged =
        decoder.decodeQueueSize > 0 &&
        session.outputsSeen === outputsBefore &&
        session.lastError === null &&
        session.wedgedRebuilds < MAX_WEDGED_REBUILDS;
      if (wedged) {
        session.wedgedRebuilds += 1;
        const rebuilt = this.videoSessions.get(asset.assetId);
        if (rebuilt !== undefined && rebuilt === session) {
          await this.closeVideoSession(asset.assetId);
          return this.decodeTo(asset, target, epoch);
        }
      }
    }

    if (!pending.settled) {
      // 兜底：flush 后仍未拿到目标帧 → 用缓冲里最近的更早帧（holdPrevious，不白屏）
      const bestIndex = pending.bestIndex;
      pending.settled = true;
      if (bestIndex !== null) {
        const cached = this.cache.get(asset.assetId, bestIndex);
        if (cached !== undefined) {
          cached.usedAt = this.nextTick();
          pending.resolve({ frame: cached.frame, assetFrame: bestIndex, fromCache: false, exact: false });
        } else {
          pending.fail(new PoolError('E_DECODE_FAILED', '解码未产出目标帧', `${asset.assetId}#${target}`));
        }
      } else {
        pending.fail(new PoolError('E_DECODE_FAILED', '解码未产出目标帧', `${asset.assetId}#${target}`));
      }
    }

    const served = await Promise.race([
      promise,
      new Promise<DecodedFrame>((_resolve, rejectRace) => {
        setTimeout(() => {
          rejectRace(
            new PoolError(
              'E_DECODE_FAILED',
              '取帧超时',
              `${asset.assetId}#${target} 超过 ${SEEK_TIMEOUT_MS}ms 未出帧（lastError=${session.lastError ?? 'none'}）`,
            ),
          );
        }, SEEK_TIMEOUT_MS);
      }),
    ]);
    if (served.exact) {
      session.lastServedIndex = served.assetFrame;
      if (fallbackFrames > this.positioningThresholdFrames && this.onPositioning !== undefined) {
        this.onPositioning({ assetId: asset.assetId, targetFrame: target, fallbackFrames, phase: 'end' });
      }
    }
    return served;
  }

  /**
   * 从 `startPosition` 到 `endPosition`（解码序）提交样本。
   *
   * 让出策略：每 `yieldEveryFrames` 个样本 `await yieldToMain()`，并在解码队列超过高水位时
   * 等 `dequeue` 事件 —— 两条一起保证 239 帧的回退不会把 rAF 卡到 50ms 以上（T06 ⑥）。
   */
  private async feed(
    asset: RegisteredAsset,
    session: VideoSession,
    startPosition: number,
    endPosition: number,
    epoch: number,
  ): Promise<void> {
    const decoder = session.decoder;
    const video = asset.probe.video;
    const nalLengthSize = nalLengthSizeOf(video === null ? null : video.description);
    const codec = video === null ? '' : video.codec;
    let fed = 0;

    for (let position = startPosition; position <= endPosition; position += 1) {
      const pending = session.pending;
      if (pending === null || pending.settled || session.epoch !== epoch) return;
      const sample = asset.decodeOrder[position];
      if (sample === undefined) return;
      if (decoder.state !== 'configured') {
        throw new PoolError('E_DECODE_FAILED', '解码器状态异常（未配置）', String(decoder.state));
      }

      await this.waitForDecodeSlot(decoder);
      if (session.pending === null || session.pending.settled || session.epoch !== epoch) return;

      const bytes = await readBlobBytes(asset.source, sample.offset, sample.offset + sample.size);
      // 运行时关键帧索引：stss 可能不完整（架构 §8.5 长 GOP 行），实际 I 帧位置要自己记
      const sync = sample.isKey || (codec.length > 0 && hasSyncNal(bytes, codec, nalLengthSize));
      if (sync && !sample.isKey) this.registerRuntimeKeyframe(asset, sample.index);
      if (sync) session.needsKeyframe = false;

      // 提交前再确认一次状态：中间有 await（等解码槽 / 读字节），期间解码器可能已 error/close
      if (decoder.state !== 'configured') {
        throw new PoolError(
          'E_DECODE_FAILED',
          '解码器已不可用',
          `state=${decoder.state} position=${position} lastError=${session.lastError ?? 'none'}`,
        );
      }
      try {
        decoder.decode(
          new EncodedVideoChunk({
            // 必须用 PTS：dtsUs 可为负（elst 重排延迟），见文件头铁律 ③
            timestamp: sample.ptsUs,
            type: sync ? 'key' : 'delta',
            data: bytes,
          }),
        );
      } catch (error) {
        throw new PoolError(
          'E_DECODE_FAILED',
          '提交样本失败',
          `${error instanceof Error ? error.message : String(error)}（position=${position} sync=${String(sync)} state=${decoder.state} lastError=${session.lastError ?? 'none'}）`,
        );
      }
      session.nextDecodePosition = position + 1;
      session.samplesFed += 1;
      fed += 1;
      if (fed % this.yieldEveryFrames === 0) await this.yieldToMain();
    }
  }

  /** 轮询等待某个素材帧落进缓存（在途输出的短等待；绝不长阻塞）。 */
  private async waitForCachedFrame(
    assetId: string,
    assetFrame: number,
    timeoutMs: number,
  ): Promise<CachedFrame | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const entry = this.cache.get(assetId, assetFrame);
      if (entry !== undefined) return entry;
      if (Date.now() >= deadline) return null;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1);
      });
    }
  }

  /** 等一次输出排空事件（带超时），避免为了一帧就 flush 掉整条流水线。 */
  private async waitForOutput(decoder: VideoDecoder, timeoutMs: number): Promise<void> {
    if (decoder.decodeQueueSize === 0) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        decoder.removeEventListener('dequeue', finish);
        resolve();
      };
      decoder.addEventListener('dequeue', finish);
      setTimeout(finish, timeoutMs);
    });
  }

  /** 解码队列高水位：超过就等 dequeue（带兜底超时，绝不永久挂起）。 */
  private async waitForDecodeSlot(decoder: VideoDecoder | AudioDecoder): Promise<void> {
    if (decoder.decodeQueueSize < this.decodeQueueHighWater) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        decoder.removeEventListener('dequeue', finish);
        resolve();
      };
      decoder.addEventListener('dequeue', finish);
      setTimeout(finish, DEQUEUE_TIMEOUT_MS);
    });
  }

  /** 记录运行时发现的关键帧（presentation order），并保持升序。 */
  private registerRuntimeKeyframe(asset: RegisteredAsset, index: Frame): void {
    if (index < 0 || index >= asset.keyframeFlags.length) return;
    if (asset.keyframeFlags[index] === 1) return;
    asset.keyframeFlags[index] = 1;
    const position = findKeyframeAtOrBefore(asset.keyframes, index);
    asset.keyframes.splice(position + 1, 0, index);
  }

  /* ----- 内部：输出 ----- */

  /** 视频输出回调：唯一的 VideoFrame 所有权入口。 */
  private handleVideoFrame(assetId: string, frame: VideoFrame): void {
    this.totalCreated += 1;
    const session = this.videoSessions.get(assetId);
    if (session === undefined) {
      this.closeFrame(frame);
      return;
    }
    session.outputsSeen += 1;
    const asset = session.asset;
    const pending = session.pending;

    if (pending === null || pending.epoch !== session.epoch) {
      // 迟到的旧 epoch 帧 / 没有待决请求：必须 close（铁律 ①）
      this.closeFrame(frame);
      return;
    }

    let index = asset.indexByPtsUs.get(frame.timestamp);
    if (index === undefined) {
      // 兜底：按提交顺序计数（正常不会发生；记录诊断计数供排查）
      asset.unmappedTimestamps += 1;
      index = session.fallbackCounter;
      session.fallbackCounter += 1;
    }

    if (index > session.emittedUpTo) session.emittedUpTo = index;

    if (index === pending.target) {
      // **先克隆再入缓存**：入缓存可能触发 LRU 淘汰，而淘汰会 close 原帧。
      // 若把原帧直接 resolve 给调用方，调用方拿到的就是"已 close 的帧"（displayWidth=0）
      // —— 这是 1080p 预览全黑的真正根因（帧大、淘汰频繁，必现；720p 侥幸逃过）。
      // clone 只是增加底层缓冲引用计数，成本极低；交付的 clone 由调用方负责 close。
      let delivered: VideoFrame;
      try {
        delivered = frame.clone();
      } catch {
        delivered = frame;
      }
      this.storeFrame(assetId, index, frame);
      if (pending.settled) return;
      pending.settled = true;
      // 交付成功 → 打开预读窗口 [target, target + LOOKAHEAD]
      session.windowFrom = index;
      session.windowTo = index + SEEK_LOOKAHEAD_SAMPLES;
      pending.resolve({ frame: delivered, assetFrame: index, fromCache: false, exact: true });
      return;
    }

    if (index >= session.windowFrom && index <= session.windowTo) {
      // 预读帧：进缓存供后续 ensureFrame 直接命中（等价 T09 的 preroll）
      this.storeFrame(assetId, index, frame);
      return;
    }

    if (!pending.settled && index < pending.target) {
      // 更早的帧：留作 holdPrevious 兜底，但**不**进缓存（一次 seek 里它们没有复用价值）
      if (pending.bestIndex === null || index > pending.bestIndex) {
        pending.bestIndex = index;
      }
    }
    this.closeFrame(frame);
  }

  /** 视频解码 error 回调：让待决 seek 立刻失败，而不是挂到超时。 */
  private handleVideoError(assetId: string, error: DOMException): void {
    const session = this.videoSessions.get(assetId);
    if (session === undefined) return;
    session.lastError = `${error.name}: ${error.message}`;
    const pending = session.pending;
    session.pending = null;
    if (pending !== null) {
      pending.settled = true;
      pending.fail(
        new PoolError('E_DECODE_FAILED', '视频解码器报错', `${error.name}: ${error.message}`),
      );
    }
  }

  /** 存入缓存；同帧号覆盖与 LRU 淘汰产生的旧帧在此统一 close。 */
  private storeFrame(assetId: string, assetFrame: number, frame: VideoFrame): void {
    const entry: CachedFrame = {
      frame,
      bytes: frameBytesOf(frame),
      usedAt: this.nextTick(),
    };
    const evicted = this.cache.put(assetId, assetFrame, entry);
    for (const item of evicted) this.closeFrame(item.frame);
  }

  /** 唯一 close 封装：保证统计守恒（`totalCreated - totalClosed === openFrames`）。 */
  private closeFrame(frame: VideoFrame): void {
    this.totalClosed += 1;
    try {
      frame.close();
    } catch {
      // 二次 close 属于编程错误，但不允许把异常抛回解码器回调
    }
  }
}

/* ---------- 工厂 ---------- */

/**
 * 创建解码器池（架构 §8.2）。
 *
 * 默认：视频会话 2、音频会话 1、帧缓存 64MB / 单素材 24 帧、回退 > 60 帧通知"定位中"。
 */
export function createDecoderPool(options: DecoderPoolOptions = {}): DecoderPool {
  return new DecoderPoolImpl(options);
}
