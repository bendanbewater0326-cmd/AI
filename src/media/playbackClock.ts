/**
 * Transport：播放时钟与状态机（T08 / 架构 §8.1）。
 *
 * **职责边界**：本文件只负责"现在该显示第几帧"和播放状态机，**不做任何解码编排**
 * （解码由 T09 的 playbackEngine 负责）。帧准备好的通知通过 `onFrame` 注入点回调，
 * Transport 不知道 decoderPool 的存在。
 *
 * 时钟选型（§8.1，不可协商）：
 * - 播放头处有可听音频 → `AudioContext.currentTime` 为主时钟（视频跟音频）；
 * - 无音频 / 静音 / 音频上下文不可用 → `performance.now()` 为主时钟；
 * - **rAF 只作出帧触发器，绝不参与计时**；禁止用 `dt` 累加推进播放头
 *   （只允许 `secondsToFrames(now - anchor.time)` 一次性换算）。
 *
 * seek 三模式（PM 硬要求，缺一不可）：
 * | 模式      | 行为 |
 * |-----------|------|
 * | `scrub`   | 拖动中：允许近似帧，但**绝不黑屏**（宁可显示上一帧）；同一 tick 内多次 seek 只提交 1 次 |
 * | `preview` | 松手瞬间：立即提交最接近的缓存帧（`exact=false`） |
 * | `exact`   | 必须收敛到目标帧（≤800ms 由渲染方保证），**不允许停在近似帧** |
 *
 * 其余：`document.hidden` 自动暂停；逐帧 ±1/±10 在首尾停住；时钟源切换不跳帧。
 */
import type { Frame, MilliFps } from '../core/types';
import { secondsToFrames } from '../core/timebase';

/** 主时钟来源。 */
export type ClockSource = 'audio' | 'perf';

/** seek 模式。 */
export type SeekMode = 'scrub' | 'preview' | 'exact';

/** 一帧被提交时的上下文（渲染方据此决定是否 await 解码）。 */
export interface FrameCommitInfo {
  frame: Frame;
  /** `play` = 播放循环推进；其余为 seek 模式。 */
  mode: SeekMode | 'play';
  /** 本次提交是否保证"画面就是这个帧"（scrub/preview 为 false）。 */
  exact: boolean;
}

/**
 * 音频主时钟注入点（T10 的 AudioEngine 实现）。
 *
 * Transport 只问三件事：现在几点、这里有没有可听音频、开始/停止调度。
 */
export interface AudioClockPort {
  /** 音频上下文的当前时间（秒）；不可用时返回 null。 */
  now(): number | null;
  /** 播放头处是否存在可听音频（决定是否用 audio 作主时钟）。 */
  hasAudibleAudioAt(frame: Frame): boolean;
  start(frame: Frame): void;
  stop(): void;
  /** 音频丢失/欠载时的上报回调由 AudioEngine 调用 `transport.notifyAudioLost()`。 */
}

export interface TransportOptions {
  fpsMilli: MilliFps;
  /** 时间线总时长（项目帧，exclusive）；空时间线返回 0。 */
  durationFrames: () => Frame;
  audioClock?: AudioClockPort | null;
  /** 帧提交回调：T09 在这里渲染；返回值是 Promise 时只有 `exact` 模式会 await。 */
  onFrame?: (frame: Frame, info: FrameCommitInfo) => void | Promise<void>;
  onPlayingChange?: (playing: boolean) => void;
  onClockSourceChange?: (source: ClockSource) => void;
  /** 依赖注入（测试用；生产默认 performance.now / rAF / document）。 */
  now?: () => number;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
  isHidden?: () => boolean;
}

export interface TransportStats {
  /** 提交给渲染方的帧次数（scrub 合并后的真实提交数）。 */
  commitCount: number;
  /** 被合并丢弃的 scrub 请求数。 */
  coalescedSeeks: number;
  source: ClockSource;
  playing: boolean;
  anchorFrame: Frame;
  lastCommittedFrame: Frame;
}

export interface Transport {
  readonly playing: boolean;
  readonly source: ClockSource;
  play(): void;
  pause(): void;
  toggle(): void;
  /** 当前帧（播放中由主时钟实时推导，暂停时是最后提交的帧）。 */
  currentFrame(): Frame;
  seekTo(frame: Frame, mode: SeekMode): Frame;
  /** 逐帧步进（会先暂停）；返回落点帧。 */
  step(delta: Frame): Frame;
  /** 音频丢失时切回 perf 时钟（不跳帧）。 */
  notifyAudioLost(): void;
  /** 运行期换音频时钟（null = 无音频）。正在播放时会重新锚定，不跳帧。 */
  setAudioClock(audioClock: AudioClockPort | null): void;
  /** 等待最近一次 exact 提交完成（测试用）。 */
  whenIdle(): Promise<void>;
  stats(): TransportStats;
  setFpsMilli(fpsMilli: MilliFps): void;
  dispose(): void;
}

/** 默认 rAF 触发器（Node 环境下退化为 setTimeout，仅测试注入时才用不到）。 */
function defaultRequestFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(() => callback());
  }
  return setTimeout(callback, 16) as unknown as number;
}

function defaultCancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(handle);
    return;
  }
  clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}

function defaultNow(): number {
  return performance.now() / 1000;
}

function defaultIsHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden === true;
}

interface Anchor {
  frame: Frame;
  time: number;
}

/**
 * 创建 Transport。
 *
 * @param options 见 `TransportOptions`；`durationFrames` 是**函数**，这样工程被编辑后
 *                无需重建 Transport（时长是派生值，随时会变）。
 */
export function createTransport(options: TransportOptions): Transport {
  let fpsMilli = options.fpsMilli;
  const audioClockRef: { current: AudioClockPort | null } = { current: options.audioClock ?? null };
  const now = options.now ?? defaultNow;
  const requestFrame = options.requestFrame ?? defaultRequestFrame;
  const cancelFrame = options.cancelFrame ?? defaultCancelFrame;
  const isHidden = options.isHidden ?? defaultIsHidden;

  let playing = false;
  let source: ClockSource = 'perf';
  let frameValue: Frame = 0;
  let anchor: Anchor = { frame: 0, time: 0 };
  let rafHandle: number | null = null;
  let disposed = false;
  let commitCount = 0;
  let coalescedSeeks = 0;
  let lastCommittedFrame: Frame = 0;
  let exactEpoch = 0;
  let pendingExact: Promise<void> | null = null;
  const scrubState: { pending: Frame | null; scheduled: boolean } = {
    pending: null,
    scheduled: false,
  };

  /** 时间线最大可显示帧（空时间线为 0）。 */
  /**
   * 播放头上限 = **总时长本身**（不是 duration - 1）。
   *
   * 为什么允许多停一帧：这是时间线的"末尾点"。用户想在片尾接下一个片段时，
   * 必须能把播放头放到末尾；若上限是 duration-1（最后一帧的 index），
   * 在片尾双击素材会让新片段从最后一帧开始 —— **与前一段重叠 1 帧**。
   * 末尾点没有实际内容，预览侧会用最后一帧兜底（见 previewSource.renderPreviewFrame）。
   */
  function maxFrame(): Frame {
    const duration = options.durationFrames();
    if (!Number.isFinite(duration) || duration <= 0) return 0;
    return Math.max(0, Math.floor(duration));
  }

  function clampFrame(frame: Frame): Frame {
    const rounded = Math.round(frame);
    if (rounded < 0) return 0;
    const max = maxFrame();
    return rounded > max ? max : rounded;
  }

  /** 当前时刻的主时钟读数（秒）；audio 不可用时回退 perf。 */
  function clockNow(kind: ClockSource): number {
    if (kind === 'audio') {
      const audioNow = audioClockRef.current?.now() ?? null;
      // 只判 null：0 是合法的音频时间起点
      if (audioNow === null) return now();
      return audioNow;
    }
    return now();
  }

  /** 按主时钟推导当前帧（不累加 dt）。 */
  function derivedFrame(): Frame {
    const elapsed = clockNow(source) - anchor.time;
    const offset = elapsed > 0 ? secondsToFrames(elapsed, fpsMilli) : 0;
    return clampFrame(anchor.frame + offset);
  }

  function emitChange(playingNext: boolean): void {
    if (playingNext === playing) return;
    playing = playingNext;
    options.onPlayingChange?.(playing);
  }

  function stopLoop(): void {
    if (rafHandle !== null) {
      cancelFrame(rafHandle);
      rafHandle = null;
    }
  }

  /** 重新锚定（时钟源切换 / seek 后恢复），保证帧号不跳变。 */
  function reanchor(kind: ClockSource): void {
    source = kind;
    anchor = { frame: frameValue, time: clockNow(kind) };
    options.onClockSourceChange?.(kind);
  }

  async function commit(frame: Frame, mode: SeekMode | 'play'): Promise<void> {
    frameValue = frame;
    lastCommittedFrame = frame;
    commitCount += 1;
    const info: FrameCommitInfo = {
      frame,
      mode,
      exact: mode === 'exact',
    };
    const result = options.onFrame?.(frame, info);
    if (result instanceof Promise) {
      const epochAtCommit = exactEpoch;
      const wait = result.then(() => undefined).catch(() => undefined);
      if (mode === 'exact') {
        pendingExact = wait.then(() => {
          // 期间又发生了新的 seek：本次结果作废，不覆盖帧号
          if (epochAtCommit !== exactEpoch) return;
        });
        await pendingExact;
      }
      return;
    }
  }

  /** scrub 合并提交：同一 tick 内多次 seek 只真正提交最后一次。 */
  function scheduleScrubCommit(): void {
    if (scrubState.scheduled) {
      coalescedSeeks += 1;
      return;
    }
    scrubState.scheduled = true;
    queueMicrotask(() => {
      scrubState.scheduled = false;
      const target = scrubState.pending;
      scrubState.pending = null;
      // 只判 null：0 是合法帧号
      if (target === null) return;
      void commit(target, 'scrub');
    });
  }

  function tick(): void {
    if (!playing || disposed) return;
    const frame = derivedFrame();
    if (frame !== lastCommittedFrame) {
      void commit(frame, 'play');
    }
    if (isHidden()) {
      pause();
      return;
    }
    if (maxFrame() === 0) {
      pause();
      return;
    }
    if (frame >= maxFrame()) {
      // R-007：播到末尾暂停，不回绕
      pause();
      return;
    }
    rafHandle = requestFrame(tick);
  }

  function play(): void {
    if (disposed || playing) return;
    if (maxFrame() === 0) return;
    if (frameValue >= maxFrame()) {
      // 已在末帧再按播放 → **回到开头重播**。
      // R-007 说的是"逐帧步进到首尾不回绕"（←/→），不是"按播放也不回绕"——
      // 旧实现把两者混为一谈，导致播完按空格毫无反应（实测：playhead 240 → 240）。
      seekTo(0, 'exact');
    }
    const audio = audioClockRef.current;
    const audioUsable = audio !== null && audio.now() !== null && audio.hasAudibleAudioAt(frameValue);
    source = audioUsable ? 'audio' : 'perf';
    anchor = { frame: frameValue, time: clockNow(source) };
    options.onClockSourceChange?.(source);
    if (audioUsable && audio) audio.start(frameValue);
    emitChange(true);
    rafHandle = requestFrame(tick);
  }

  function pause(): void {
    if (disposed) return;
    stopLoop();
    if (playing) {
      frameValue = derivedFrame();
      audioClockRef.current?.stop();
      emitChange(false);
    }
  }

  function toggle(): void {
    if (playing) pause();
    else play();
  }

  function currentFrame(): Frame {
    if (!playing) return frameValue;
    return derivedFrame();
  }

  function seekTo(frame: Frame, mode: SeekMode): Frame {
    if (disposed) return frameValue;
    // 任何 seek 都先停表：拖动期间不能让播放继续推进（§8.1 seek 与播放互斥）
    if (playing) pause();
    const target = clampFrame(frame);
    // 返回的帧必须立即"可显示"：scrub 也返回目标帧号（渲染方会用最近缓存帧兜底）
    frameValue = target;
    if (mode === 'scrub') {
      scrubState.pending = target;
      scheduleScrubCommit();
      return target;
    }
    exactEpoch += 1;
    void commit(target, mode);
    return target;
  }

  function step(delta: Frame): Frame {
    if (disposed) return frameValue;
    if (playing) pause();
    const target = clampFrame(frameValue + delta);
    exactEpoch += 1;
    void commit(target, 'exact');
    return target;
  }

  function notifyAudioLost(): void {
    if (disposed) return;
    if (!playing) {
      audioClockRef.current = null;
      return;
    }
    // 先取当前帧，再换源重锚 → 帧号连续（差值 ≤ 1）
    const frame = derivedFrame();
    frameValue = frame;
    audioClockRef.current?.stop();
    audioClockRef.current = null;
    reanchor('perf');
  }

  function setAudioClock(audioClock: AudioClockPort | null): void {
    if (disposed) return;
    if (!playing) {
      audioClockRef.current = audioClock;
      return;
    }
    const frame = derivedFrame();
    // 先用旧时钟停表，再换源重新锚定 → 帧号连续
    pause();
    frameValue = frame;
    audioClockRef.current = audioClock;
    play();
  }

  function waitForIdle(): Promise<void> {
    if (pendingExact) return pendingExact.then(() => undefined);
    return Promise.resolve();
  }

  const onVisibilityChange = (): void => {
    if (isHidden()) pause();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  return {
    get playing(): boolean {
      return playing;
    },
    get source(): ClockSource {
      return source;
    },
    play,
    pause,
    toggle,
    currentFrame,
    seekTo,
    step,
    notifyAudioLost,
    setAudioClock,
    whenIdle: waitForIdle,
    stats(): TransportStats {
      return {
        commitCount,
        coalescedSeeks,
        source,
        playing,
        anchorFrame: anchor.frame,
        lastCommittedFrame,
      };
    },
    setFpsMilli(nextFpsMilli: MilliFps): void {
      if (!Number.isInteger(nextFpsMilli) || nextFpsMilli <= 0) {
        throw new Error(`transport: fpsMilli 必须是正整数，收到 ${nextFpsMilli}`);
      }
      if (nextFpsMilli === fpsMilli) return;
      const frame = currentFrame();
      fpsMilli = nextFpsMilli;
      frameValue = clampFrame(frame);
      if (playing) reanchor(source);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      stopLoop();
      audioClockRef.current?.stop();
      emitChange(false);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    },
  };
}
