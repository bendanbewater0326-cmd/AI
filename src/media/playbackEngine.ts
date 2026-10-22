/**
 * 播放引擎（架构 §8.2，task:T09）：把「项目帧」编排成「上屏画面」。
 *
 * ## 职责边界
 *
 * 本文件只做编排，**不做任何时基换算**——项目帧 → 素材帧一律走
 * `mapProjectFrameToAssetFrame`（`core/timebase` 唯一入口），帧 → 微秒走 `frameToUs`。
 *
 * ## 两种实现
 *
 * | mode | 何时用 | 取帧方式 |帧精确 |
 * |---|---|---|---|
 * | `webcodecs` | 默认（有 WebCodecs） | `decoderPool.ensureFrame` | 是 |
 * | `element` | 浏览器整体无 WebCodecs | `<video>` + `currentTime` + `drawImage` | 否（`exactSeek=false`） |
 *
 * 降级是**全局**的（不是单素材）：任一素材 `exactSeek === false` 即整体切 `element`，
 * 与架构 §8.5 降级表一致；顶部错误条提示「兼容模式：seek 不保证帧精确」。
 *
 * ## 帧所有权（三条铁律，与 decoderPool 一致）
 *
 * ① **本文件不 `close()` 从 `decoderPool` 借来的 `VideoFrame`** —— 那些帧归池的
 * `FrameCache` 所有，借用只用于 `drawLayer`。重复 close 会破坏池的守恒式
 * `totalCreated - totalClosed === openFrames`。
 * ② `ElementEngine` 内部的 `<video>` 不是 `VideoFrame`，不参与该守恒式。
 * ③ `dispose()` 必须释放本文件自己创建的对象（`ImageBitmap` / `<video>` / rAF）。
 *
 * ## 为什么这里不做"播放游标"
 *
 * 直觉上应该在本层维护一个连续游标来避免逐帧 seek，但那样**必然画出错帧**：
 * 手上只有第 N 帧，却要画第 N+1 帧，症状是"画面慢一帧但一切正常"，几乎无法归因。
 * 帧复用的正确位置是 `decoderPool` 的帧缓存——它命中时返回的 `DecodedFrame.frame`
 * 就是目标帧本身。所以本文件对每一帧都老实调 `ensureFrame`，由池子决定命中还是重解。
 *
 * 逐帧播放确实偏慢（实测 900 帧触发 461 次全量 seek），根因是预读窗口把
 * `nextDecodePosition` 推到下一个目标**之后**，`sequential` 判定几乎恒为 false。
 * 这是解码器池的调度策略债，不是本文件能靠缓存掩盖的——留给 T10/T16 联调时专项处理。
 */
import { frameToUs, mapProjectFrameToAssetFrame, usToSeconds } from '../core/timebase';
import type { Clip, Frame, MilliFps, Project, Result, TextContent, Transform, VEditorError } from '../core/types';
import { makeError, trackCompositeOrder } from '../core/types';
import type { ColorGrade } from '../render/compositor';
import type { Compositor, LayerPlacement } from '../render/compositor';
import { createCompositor } from '../render/compositor';
import type { BlobLike, Mp4ProbeResult } from './demuxMp4';
import { EPOCH_CANCEL_MESSAGE } from './decoderPool';
import type { DecodedFrame } from './decoderPool';
import { renderTextLayer } from '../render/textLayer';
import { clipsNeedingExtraDraw, planTransitions } from './transitionPlan';
import { animatedValuesAt } from '../core/keyframes';
import { isTrackAudible, isTrackVisible } from '../core/trackAudibility';
import { curveOf } from '../render/curve';
import type { CurveParams } from '../render/curve';
import { lutOf, parseCubeCached } from '../render/lut';
import { maskOf } from '../render/mask';
import type { MaskParams } from '../render/mask';
import type { LutLayer } from '../render/compositor';

export type PlaybackEngineMode = 'webcodecs' | 'element';

/** 一次 `renderFrame` 的结果。 */
export interface FrameResult {
  /** 实际展示的素材帧号（`exact=false` 时可能小于请求帧）。 */
  assetFrame: Frame;
  /** 是否精确命中请求帧。`false` 表示画面来自更早的一帧（兼容模式或解码兜底）。 */
  exact: boolean;
  /** 命中的片段 id 列表（同一帧可能命中多条轨道）。 */
  clipIds: string[];
  /** 本次是否触发了新的解码（false = 复用游标）。 */
  decoded: boolean;
  /**
   * 本帧**没有任何可见层**（空工程 / 播放头在空隙 / 轨道被隐藏）。
   *
   * 与 `decoded` 的区别：`decoded=false` 可能是"被合并到在途渲染"，
   * 而 `empty=true` 明确表示"这里本来就该是背景色"。上层据此可以：
   * 不重试、不报"兼容模式"、并且**放心地认为是干净的**。
   */
  empty?: boolean;
}

/**
 * 源是否"能画"（尺寸有效）。
 *
 * 与 `compositor.sourceSize` 同一判据，但**必须在引擎侧也判一次**：
 * 合成器那边只是"跳过这一层"，引擎这边还要把它计入 `missing`（影响 `exact`）。
 * 两处判据写在一起会引入循环依赖（compositor 不该被 media 反向 import），
 * 所以各留一份，注释互指。
 */
function isDrawableSource(source: VideoFrame | HTMLVideoElement | HTMLCanvasElement): boolean {
  if (typeof VideoFrame !== 'undefined' && source instanceof VideoFrame) {
    return source.displayWidth > 0 && source.displayHeight > 0;
  }
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    return source.videoWidth > 0 && source.videoHeight > 0;
  }
  const sized = source as { width?: number; height?: number };
  return (sized.width ?? 0) > 0 && (sized.height ?? 0) > 0;
}

/* ---------------- 显示旋转（手机竖拍视频） ---------------- */

interface RotateSurface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}
/** 按"输出尺寸"缓存旋转画布：每帧复用，避免 30fps 下频繁分配 1080p canvas。 */
const rotateSurfaces = new Map<string, RotateSurface>();

function rotateSurfaceFor(width: number, height: number): RotateSurface | null {
  const key = `${width}x${height}`;
  const existing = rotateSurfaces.get(key);
  if (existing !== undefined) return existing;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (ctx === null) return null;
  const made: RotateSurface = { canvas, ctx };
  // 只保留最近几种尺寸，防止反复改工程参数时无限增长
  if (rotateSurfaces.size > 4) rotateSurfaces.clear();
  rotateSurfaces.set(key, made);
  return made;
}

/**
 * 把解码帧按顺时针 `rotation` 度画到离屏 canvas。
 *
 * **为什么走 CPU 而不是着色器**：旋转只影响"少数手机视频"，而着色器要改 UV + 交换
 * 尺寸 + 处理 4 种角度，出错面大。1080p 一次 drawImage 旋转约 5–10ms，30fps 预算 33ms 够用。
 * 缩放/位置/不透明度仍由合成器统一处理（它看到的是旋转后的 canvas 尺寸）。
 */
function rotateSourceToCanvas(
  source: CanvasImageSource,
  srcWidth: number,
  srcHeight: number,
  rotation: number,
): HTMLCanvasElement | null {
  if (srcWidth <= 0 || srcHeight <= 0) return null;
  const swap = rotation === 90 || rotation === 270;
  const surface = rotateSurfaceFor(swap ? srcHeight : srcWidth, swap ? srcWidth : srcHeight);
  if (surface === null) return null;
  const { canvas, ctx } = surface;
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(source, -srcWidth / 2, -srcHeight / 2);
  ctx.restore();
  return canvas;
}

function rotateFrameToCanvas(frame: VideoFrame, rotation: number): HTMLCanvasElement | null {
  return rotateSourceToCanvas(frame, frame.displayWidth, frame.displayHeight, rotation);
}

/** 已经摊平到 canvas 的帧再旋转（HEVC 路径）。 */
function rotateCanvas(canvas: HTMLCanvasElement, rotation: number): HTMLCanvasElement | null {
  return rotateSourceToCanvas(canvas, canvas.width, canvas.height, rotation);
}

/**
 * 把 VideoFrame **摊平**到一张 2D canvas 再交给合成器。
 *
 * ## 为什么需要（2026-10-22 用户实测）
 *
 * 微信的 HEVC 素材在本机预览出现**横条纹噪声 + 整个预览卡死**，同一文件用无头 Chrome
 * 渲染却正常。这类现象是"硬件解码帧直接上传成 WebGL 纹理"的典型故障：
 * 硬件帧的 coded 尺寸带对齐填充（如 1280×736），可见区域只有 1280×720；
 * 直接把 VideoFrame 交给 `texImage2D`，部分驱动会把填充区当画面 → 条纹/错位，
 * 严重时驱动阻塞主线程（预览冻结，删光片段也不刷新）。
 *
 * `drawImage` 会**按 visibleRect 正确展开**（浏览器内部走稳定路径），
 * 再上传这张 canvas 就与硬件帧格式无关了。代价是每帧一次 2D 拷贝，720p 可接受。
 *
 * 所有权：本函数**会 close 传入的 frame**（调用方不再持有）。
 */
function flattenFrameToCanvas(frame: VideoFrame): HTMLCanvasElement | null {
  const width = frame.displayWidth;
  const height = frame.displayHeight;
  if (width <= 0 || height <= 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  try {
    ctx.drawImage(frame, 0, 0, width, height);
  } catch {
    return null;
  }
  return canvas;
}

/** HEVC（H.265）素材：硬件解码帧要走 canvas 中转（见 `flattenFrameToCanvas`）。 */
function isHevcCodec(codec: string | null): boolean {
  return codec !== null && /^(hvc1|hev1|hvcC)/i.test(codec);
}

/** 参与合成的层（已由本文件从 doc 里解析出来，合成器不反查 doc）。 */
export interface RenderLayer {
  clipId: string;
  assetId: string;
  assetFrame: Frame;
  transform: Transform;
  placement: LayerPlacement;
  /** 非空 = 文本层（不走素材解码，直接画到离屏 canvas）。 */
  text?: TextContent;
  /** 调色（来自 clip.effects 里的 colorGrade）。 */
  grade?: ColorGrade;
  /** 曲线（来自 clip.effects 里的 curve，R-055）。 */
  curve?: CurveParams;
  /** 3D LUT（来自 clip.effects 里的 lut，R-058）。 */
  lut?: LutLayer;
  /** 蒙版（来自 clip.effects 里的 mask，R-056）：按帧取关键帧值。 */
  mask?: MaskParams;
}

export interface PlaybackEngineStats {
  renderCount: number;
  decodeFailures: number;
  inexactCount: number;
  /** 连续 `exact=false` 的最长长度（验收 ② 的判据）。 */
  maxInexactRun: number;
  /** 空内容帧数（没有任何可见层 → 只清屏）。用来确认"花屏场景真的走了清屏路径"。 */
  emptyFrames: number;
}

export interface PlaybackEngine {
  readonly mode: PlaybackEngineMode;
  /** 精确 seek 能力：`element` 模式恒为 false。 */
  readonly exactSeek: boolean;
  readonly compositor: Compositor;
  /** 注册素材来源与探测结果（导入或恢复工程后调用；重复注册同一 assetId 会覆盖）。 */
  registerAsset(assetId: string, source: BlobLike, probe: Mp4ProbeResult): void;
  unregisterAsset(assetId: string): void;
  /** 渲染并上屏一个项目帧。 */
  renderFrame(doc: Project, frame: Frame): Promise<Result<FrameResult>>;
  /** 预热：把 `frame` 附近解码好（播放前调用，避免第一帧卡顿）。 */
  preroll(doc: Project, frame: Frame): Promise<void>;
  stats(): PlaybackEngineStats;
  dispose(): Promise<void>;
}

/** 解码器池依赖的最小接口（测试可注入假实现）。 */
export interface DecoderPoolPort {
  register(assetId: string, probe: Mp4ProbeResult, source: BlobLike): void;
  /**
   * **彻底**移除素材（关会话 + 删源 + 清帧缓存）。
   *
   * 与 `release` 的区别：`release` 只关解码会话，**源还在 `assets` 里** ——
   * 下一次 `ensureFrame` 会重新建会话并成功解码。于是"素材已注销"之后预览
   * 仍然能出画，`unregisterPreviewSource` 的语义（"这个素材不该再有画面"）落空。
   */
  unregister?(assetId: string): Promise<void>;
  /** **同步**让素材立刻不可用（删源 + 清缓存），会话关闭交给 `unregister`。 */
  invalidate?(assetId: string): void;
  ensureFrame(assetId: string, assetFrame: Frame, epoch?: number): Promise<Result<DecodedFrame>>;
  release(assetId: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface CreatePlaybackEngineOptions {
  width: number;
  height: number;
  fpsMilli: MilliFps;
  decoderPool: DecoderPoolPort;
  /** 注入 canvas（预览窗宿主）；缺省自建。 */
  canvas?: HTMLCanvasElement;
  /** 强制实现（测试用）。缺省：有 WebCodecs 走 webcodecs。 */
  mode?: PlaybackEngineMode;
  /** `element` 模式的宿主文档（测试可注入替身）。 */
  document?: Document;
  /**
   * 透明背景（R-062）：仅 PNG 序列导出用。
   *
   * 默认不透明 —— 预览与 MP4/GIF 都不能带 alpha（编码器不保留，会变成黑底）。
   */
  alpha?: boolean;
}

/** 从 clip.effects 里取调色参数（没有则 null = 不设 uniform，走中性值）。 */
export function gradeOf(clip: Clip): ColorGrade | null {
  const effect = clip.effects.find((item) => item.type === 'colorGrade' && item.enabled);
  if (effect === undefined) return null;
  const num = (key: string): number => {
    const raw = effect.params[key];
    const value = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(value) ? value : 0;
  };
  return {
    brightness: num('brightness'),
    contrast: num('contrast'),
    saturation: num('saturation'),
    temperature: num('temperature'),
  };
}

/** 文本层画布（带缓存）。 */
function textCanvasFor(text: TextContent, width: number, height: number): HTMLCanvasElement {
  return renderTextLayer(text, width, height);
}

/* ---------------- doc → 层列表 ---------------- */

/**
 * 找出在 `frame` 处可见的所有片段。
 *
 * 可见判定：`enabled` + 轨道可见（`core/trackAudibility.isTrackVisible`：
 * 隐藏 / 独奏让位），且 `frame ∈ [startFrame, startFrame + durationFrames)`。
 * 轨道顺序按 `order` 升序返回（合成器自己按`order` 决定压盖）。
 */
export function collectVisibleClips(doc: Project, frame: Frame): Clip[] {
  const layers: Clip[] = [];
  for (const track of doc.tracks) {
    // 隐藏/独奏的规则统一在 `core/trackAudibility`（静音不影响画面）
    if (!isTrackVisible(doc, track)) continue;
    // 字幕轨也要参与合成：文字是"贴在画面上的东西"，不能因为它不在视频轨上就不画
    if (track.kind === 'audio') continue;
    for (const clip of track.clips) {
      if (!clip.enabled) continue;
      // 分离出来的音频片段只出声、不出画
      if (clip.role === 'audio') continue;
      if (frame < clip.startFrame) continue;
      if (frame >= clip.startFrame + clip.durationFrames) continue;
      layers.push(clip);
    }
  }
  return layers;
}

/** 音频片段（供 T10 调度用；本文件只做查询，不做混音）。 */
export function collectAudibleClips(doc: Project, frame: Frame): Clip[] {
  const audible: Clip[] = [];
  for (const track of doc.tracks) {
    // **必须走收敛后的判断**：`muted || hidden` 漏了独奏（solo 时其它轨应当让位），
    // 表现为"点了独奏，别的轨还在响"。
    if (!isTrackAudible(doc, track)) continue;
    for (const clip of track.clips) {
      if (!clip.enabled) continue;
      // 分离后的视频片段只出画、不出声
      if (clip.role === 'video') continue;
      if (frame < clip.startFrame) continue;
      if (frame >= clip.startFrame + clip.durationFrames) continue;
      audible.push(clip);
    }
  }
  return audible;
}

/** 单个片段在项目帧 `frame` 处对应的素材帧（越界返回 null）。 */
export function assetFrameOfClip(
  doc: Project,
  clip: Clip,
  frame: Frame,
  projectMilliFps: MilliFps,
): Frame | null {
  const asset = doc.assets.find((item) => item.id === clip.assetId);
  if (asset === undefined) return null;
  // 第 4 参 `projectMilliFps` 不可省：漏了会被迫用 `clip.durationFrames` 反推比例，
  // 造成 13.5% 的系统性相位错（T02 实测，见 frame-clock-spec）。
  return mapProjectFrameToAssetFrame(frame, clip, asset, projectMilliFps);
}

/* ---------------- Element 兜底实现 ---------------- */

/**
 * 兼容模式：`<video>` + `currentTime` + `drawImage`。
 *
 * **为什么不帧精确**：浏览器 `<video>` 的 seek 只保证"跳到最近的关键帧附近"，
 * 实际呈现帧由内部管线决定，拿不到 `VideoFrame.timestamp`。因此本实现一律标 `exact=false`。
 *
 * 同一 assetId 复用同一个 `<video>`，避免每次渲染都新建媒体元素。
 */
class ElementEngine {
  private readonly videos = new Map<string, HTMLVideoElement>();
  private readonly ready = new Map<string, Promise<void>>();
  private readonly doc: Document;

  constructor(doc: Document) {
    this.doc = doc;
  }

  /**
   * 注册来源；重复注册先销毁旧元素，避免内存泄漏。
   *
   * `<video>` 只能吃真正的 `Blob`（要生成 object URL），而解码器池用的是更宽松的
   * `BlobLike`。传不到真Blob 时直接跳过注册：该素材在兼容模式下不出画，
   * 由调用方按"该层缺帧"处理——**不能**抛异常中断整个渲染循环。
   */
  register(assetId: string, source: BlobLike): void {
    this.drop(assetId);
    if (!(source instanceof Blob)) return;
    const video = this.doc.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = URL.createObjectURL(source);
    this.videos.set(assetId, video);
    const ready = new Promise<void>((resolve) => {
      const settle = (): void => {
        video.removeEventListener('loadeddata', settle);
        video.removeEventListener('error', settle);
        resolve();
      };
      if (video.readyState >= 2) {
        resolve();
        return;
      }
      video.addEventListener('loadeddata', settle);
      video.addEventListener('error', settle);
    });
    this.ready.set(assetId, ready);
  }

  unregister(assetId: string): void {
    this.drop(assetId);
  }

  /** 取到该帧画面；`<video>` 不可用时返回 null（调用方按"该层缺帧"处理）。 */
  async frameAt(assetId: string, assetFrame: Frame, fpsMilli: MilliFps): Promise<HTMLVideoElement | null> {
    const video = this.videos.get(assetId);
    if (video === undefined) return null;
    const ready = this.ready.get(assetId);
    if (ready !== undefined) await ready;
    // 帧 → 秒必须走 timebase 的唯一入口（`frameToSeconds`），禁止在本文件出现裸换算。
    const seconds = usToSeconds(frameToUs(assetFrame, fpsMilli));
    // 关键：浏览器只在**差值超过半个关键帧间隔**时才真的跳转，
    // 逐帧播放时必须容忍抖动，否则每帧都会触发一次 seek 卡顿。
    if (Math.abs(video.currentTime - seconds) > 1 / 120) {
      video.currentTime = Math.max(0, seconds);
    }
    return video;
  }

  private drop(assetId: string): void {
    const video = this.videos.get(assetId);
    if (video === undefined) return;
    this.videos.delete(assetId);
    this.ready.delete(assetId);
    if (video.src.startsWith('blob:')) URL.revokeObjectURL(video.src);
    video.removeAttribute('src');
    video.load();
  }

  dispose(): void {
    for (const assetId of [...this.videos.keys()]) this.drop(assetId);
  }
}

/* ---------------- 主实现 ---------------- */

class PlaybackEngineImpl implements PlaybackEngine {
  readonly mode: PlaybackEngineMode;
  readonly compositor: Compositor;
  private readonly pool: DecoderPoolPort;
  private readonly elements: ElementEngine | null;
  /** HEVC 帧走 canvas 中转的次数（诊断用：>0 说明这台机器的 HEVC 走了兜底路径）。 */
  private hevcFlattened = 0;
  private readonly fpsMilli: MilliFps;
  private readonly width: number;
  private readonly height: number;

  private readonly counters = {
    renderCount: 0,
    decodeFailures: 0,
    inexactCount: 0,
    maxInexactRun: 0,
    emptyFrames: 0,
  };
  private currentInexactRun = 0;
  private disposed = false;
  /**
   * 渲染串行化。
   *
   * **为什么必须串行**：多个 `renderFrame` 并发时共享同一个池的 LRU 帧缓存——
   * 帧 A 被 render1 取到、尚未 `endFrame` 绘制，render2 的 `ensureFrame` 触发缓存淘汰
   * 把 A `close()` 了；render1 随后拿到的 `VideoFrame.displayWidth` 变成 0，
   * 合成器抛 "层源尺寸为 0" → 画面黑且异常被 `void` 吞掉。
   * 1080p 帧更大、缓存能存的帧数更少，所以更容易触发（720p 常常侥幸不触发）。
   *
   * 并发请求**合并**为最新一帧（预览只需最终画面，中间帧丢弃无损失）。
   */
  private pendingRender: { doc: Project; frame: Frame } | null = null;
  private diagLastFrame = -1;
  private diagLastVisible = -1;
  private diagLastDocClips = -1;
  private diagLastDecodeError = '';
  private renderLoopRunning = false;

  constructor(options: CreatePlaybackEngineOptions) {
    this.mode = options.mode ?? (typeof VideoDecoder === 'function' ? 'webcodecs' : 'element');
    this.pool = options.decoderPool;
    this.fpsMilli = options.fpsMilli;
    this.width = options.width;
    this.height = options.height;
    this.compositor = createCompositor({
      width: options.width,
      height: options.height,
      ...(options.canvas === undefined ? {} : { canvas: options.canvas }),
      ...(options.alpha === true ? { alpha: true } : {}),
    });
    this.elements =
      this.mode === 'element' ? new ElementEngine(options.document ?? globalThis.document) : null;
  }

  get exactSeek(): boolean {
    return this.mode === 'webcodecs';
  }

  registerAsset(assetId: string, source: BlobLike, probe: Mp4ProbeResult): void {
    if (this.disposed) return;
    if (this.elements !== null) {
      this.elements.register(assetId, source);
      return;
    }
    this.pool.register(assetId, probe, source);
  }

  unregisterAsset(assetId: string): void {
    if (this.elements !== null) {
      this.elements.unregister(assetId);
      return;
    }
    /**
     * **彻底移除**（不是 `release`）。
     *
     * `release` 只关解码会话、保留源，于是下一次取帧会重新建会话并成功解码 ——
     * "注销"等于没注销。刷新后新引擎的池是空的，所以线上表现不出来；
     * 但"删素材/换工程/重链失败后标记离线"这些路径都会踩到：
     * 用户看到"素材已离线"，画面却还在动。
     */
    /**
     * **先同步失效，再异步关会话**。
     *
     * 只 `void unregister(...)` 的话，调用方紧接着的那次重绘仍然能拿到源
     * （`unregister` 的第一个 `await` 之前只做了同步的 get/delete 会话，
     * `assets` 要到后面才删）—— 实测"素材已离线，画面还在动"。
     */
    this.pool.invalidate?.(assetId);
    if (typeof this.pool.unregister === 'function') {
      void this.pool.unregister(assetId);
    } else {
      void this.pool.release(assetId);
    }
  }

  async renderFrame(doc: Project, frame: Frame): Promise<Result<FrameResult>> {
    if (this.disposed) {
      return { ok: false, error: makeError('E_DECODE_FAILED', '播放引擎已释放', 'renderFrame') };
    }
    // 串行化 + 合并：正在渲染时只记录最新请求，由渲染循环接手（见 pendingRender 注释）
    this.pendingRender = { doc, frame };
    if (this.renderLoopRunning) {
      return { ok: true, value: { assetFrame: frame, exact: false, clipIds: [], decoded: false } };
    }
    this.renderLoopRunning = true;
    let last: Result<FrameResult> = {
      ok: true,
      value: { assetFrame: frame, exact: false, clipIds: [], decoded: false },
    };
    try {
      while (this.pendingRender !== null && !this.disposed) {
        const request = this.pendingRender;
        this.pendingRender = null;
        last = await this.renderOne(request.doc, request.frame);
      }
    } finally {
      this.renderLoopRunning = false;
    }
    return last;
  }

  /** 真正渲染一帧（串行执行，同一时刻只有一个）。 */
  private async renderOne(doc: Project, frame: Frame): Promise<Result<FrameResult>> {
    this.counters.renderCount += 1;

    // ---- 1. 解析可见层（含转场窗口内"边界之外"的片段） ----
    const plan = planTransitions(doc, frame);
    const visible = [...collectVisibleClips(doc, frame), ...clipsNeedingExtraDraw(doc, frame, plan)];
    this.diagLastFrame = frame;
    this.diagLastVisible = visible.length;
    this.diagLastDocClips = doc.tracks.reduce((sum, track) => sum + track.clips.length, 0);
    const layers: RenderLayer[] = [];
    const failures: VEditorError[] = [];

    for (const clip of visible) {
      const track = doc.tracks.find((item) => item.id === clip.trackId);
      const placement = {
        // 合成顺序与屏幕顺序不同：文字轨必须盖在视频轨之上（见 trackCompositeOrder）
        order: track === undefined ? 0 : trackCompositeOrder(track),
        startFrame: clip.startFrame,
        index: track ? track.clips.indexOf(clip) : 0,
      };
      const grade = gradeOf(clip);
      const curve = curveOf(clip);
      // LUT 解析带缓存：33³ 是 35937 行，逐帧解析会卡死
      const lutEffect = lutOf(clip);
      const lutData = lutEffect === null ? null : parseCubeCached(lutEffect.cube);
      const lut: LutLayer | null =
        lutEffect === null || lutData === null
          ? null
          : {
              size: lutData.size,
              key: `${lutData.size}:${lutEffect.cube.length}`,
              data: lutData.data,
              strength: lutEffect.strength,
            };
      // 蒙版按帧求值：关键帧相对片段起点
      const mask = maskOf(clip, Math.max(0, frame - clip.startFrame));
      const transition = plan.get(clip.id);
      // 关键帧先覆盖静态值，再乘转场的不透明度系数（两者是不同维度，不能互相覆盖）
      const anim = animatedValuesAt(clip, frame);
      const base = clip.transform;
      const animated = {
        ...base,
        ...(anim.scale === undefined ? {} : { scale: anim.scale }),
        ...(anim.x === undefined ? {} : { x: anim.x }),
        ...(anim.y === undefined ? {} : { y: anim.y }),
        ...(anim.opacity === undefined ? {} : { opacity: anim.opacity }),
      };
      const transform =
        transition === undefined || transition.opacity === 1
          ? animated
          : { ...animated, opacity: animated.opacity * Math.max(0, Math.min(1, transition.opacity)) };

      // 文本层：没有素材、没有素材帧，直接按项目分辨率画一张透明底图
      if (clip.text !== undefined && clip.text !== null) {
        layers.push({
          clipId: clip.id,
          assetId: '',
          assetFrame: 0,
          transform,
          placement,
          text: clip.text,
          ...(grade === null ? {} : { grade }),
          ...(curve === null ? {} : { curve }),
          ...(lut === null ? {} : { lut }),
          ...(mask === null ? {} : { mask }),
        });
        continue;
      }

      const assetFrame =
        transition?.frozenFrame ?? assetFrameOfClip(doc, clip, frame, doc.fpsMilli);
      if (assetFrame === null) {
        failures.push(makeError('E_ASSET_OFFLINE', '片段对应的素材不在工程里', clip.id));
        continue;
      }
      layers.push({
        clipId: clip.id,
        assetId: clip.assetId,
        assetFrame,
        transform,
        placement,
        ...(grade === null ? {} : { grade }),
        ...(curve === null ? {} : { curve }),
        ...(lut === null ? {} : { lut }),
        ...(mask === null ? {} : { mask }),
      });
    }

    // 引擎已被重建/释放：立刻退出，不要再碰 compositor 与池（池的帧可能已 close）
    if (this.disposed) {
      return { ok: true, value: { assetFrame: frame, exact: false, clipIds: [], decoded: false } };
    }

    /**
     * ---- 2a. **空内容短路**：本帧没有任何可见层 ----
     *
     * 空工程、播放头落在片段之间的空隙、所有视频轨被隐藏 —— 这些情况下
     * 正确的画面就是"一张干净的背景"。
     *
     * 必须**显式走一次 beginFrame + endFrame**（而不是直接 return）：
     * WebGL 上下文是 `preserveDrawingBuffer: false`，**不绘制就等于把 canvas 交给
     * 浏览器去显示未定义内容** —— 那正是"黑白噪点、横向条纹"的来源。
     * 清一次屏（0.05ms 级）就能彻底消除这一类花屏。
     *
     * 同时把 `exact` 定为 true：空内容本来就是精确的，不该让上层去重试
     * （旧逻辑在这里耗掉重试预算，然后"切回显示轨道也不刷新"）。
     */
    if (visible.length === 0) {
      this.compositor.beginFrame(frame, true);
      this.compositor.endFrame();
      this.currentInexactRun = 0;
      this.counters.emptyFrames += 1;
      return {
        ok: true,
        value: { assetFrame: frame, exact: true, clipIds: [], decoded: true, empty: true },
      };
    }

    // ---- 2b. 逐层取画面 ----
    this.compositor.beginFrame(frame, true);
    let missing = 0;
    /** 本帧用到的 clone 帧：endFrame 之后统一 close（所有权在 renderOne 手里）。 */
    const owned: Array<VideoFrame | HTMLVideoElement | HTMLCanvasElement> = [];

    for (const layer of layers) {
      if (this.disposed) break;
      const source = await this.sourceFor(layer, doc);
      if (source === null) {
        missing += 1;
        continue;
      }
      /**
       * **无效帧拦截**：尺寸为 0 的源一律丢弃，不提交绘制。
       *
       * 这是"解码器吐出空帧/不完整帧"的唯一可靠判据：`VideoFrame` 被 close 后
       * `displayWidth/Height` 变 0，`HTMLVideoElement` 未拿到 metadata 时 `videoWidth` 是 0。
       * 若交给合成器，`drawOne` 虽然也会跳过，但 **`missing` 不会增加** →
       * `exact` 被判成 true → 上层不再重试 → 预览永久停在"清过屏的黑帧"，
       * 而用户会以为"这段素材本身是黑的"。
       */
      if (!isDrawableSource(source)) {
        missing += 1;
        if (typeof VideoFrame !== 'undefined' && source instanceof VideoFrame) {
          try { source.close(); } catch { /* 已关闭 */ }
        }
        continue;
      }
      owned.push(source);
      this.compositor.drawLayer(
        source,
        layer.transform,
        layer.placement,
        layer.grade,
        layer.curve ?? null,
        layer.lut ?? null,
        layer.mask ?? null,
      );
    }

    this.compositor.endFrame();
    // 绘制完成即可释放 clone（合成器在 endFrame 里已经把像素画进 FBO）
    for (const item of owned) {
      if (typeof VideoFrame !== 'undefined' && item instanceof VideoFrame) {
        try { item.close(); } catch { /* 已关闭 */ }
      }
    }

    // **帧精确口径**：`exact` 为真 = 本帧**每一个**可见层都画上了它自己的那一帧。
    // 只要有一层没取到画面就必须是 false——上层（T13 预览窗）据此决定是否提示
    // "兼容模式"，把它算成 true 等于把错画面当正确画面放出去（T06 教训）。
    // **0 层不等于精确**：如果本来有可见片段（visible>0）却一层都没画出来
    // （layers=0，全部取帧失败），这恰恰是最不精确的情况。
    // 旧判据 `layers.length === 0 || missing === 0` 会把它判成 exact=true，
    // 上层（renderPreviewFrame）据此认定"画好了"而不再重试 —— 预览就永久停在黑屏。
    // 只有「本来就没内容」（visible=0，如空工程/播放头落在空隙）才算真空真。
    const hasVisible = visible.length > 0;
    const exact = this.exactSeek && missing === 0 && (!hasVisible || layers.length > 0);
    if (!exact) {
      this.counters.inexactCount += 1;
      this.currentInexactRun += 1;
      if (this.currentInexactRun > this.counters.maxInexactRun) {
        this.counters.maxInexactRun = this.currentInexactRun;
      }
    } else {
      this.currentInexactRun = 0;
    }

    const error = failures[0];
    if (error !== undefined && layers.length === 0) return { ok: false, error };
    if (error !== undefined) this.counters.decodeFailures += 1;

    return {
      ok: true,
      value: {
        assetFrame: layers[0]?.assetFrame ?? frame,
        exact,
        clipIds: layers.map((layer) => layer.clipId),
        decoded: true,
      },
    };
  }

  /**
   * 取一层的画面源；失败返回 null（该层这一帧不画）。
   *
   * **不做游标复用**：解码器池自己的帧缓存已经承担了复用（命中时返回的
   * `DecodedFrame.frame` 就是目标帧本身）。引擎侧再缓存一份必然出错——
   * 拿第 N 帧去画第 N+1 帧，症状是"播放画面慢一帧但一切正常"，极难归因。
   */
  private async sourceFor(
    layer: RenderLayer,
    doc: Project,
  ): Promise<VideoFrame | HTMLVideoElement | HTMLCanvasElement | null> {
    // ---- 文本层：按项目分辨率渲染到离屏 canvas（缓存，内容不变不重画） ----
    if (layer.text !== undefined) {
      return textCanvasFor(layer.text, this.width, this.height);
    }

    // ---- element 兜底 ----
    if (this.elements !== null) {
      const asset = doc.assets.find((item) => item.id === layer.assetId);
      const fpsMilli = asset?.fpsMilli ?? this.fpsMilli;
      return this.elements.frameAt(layer.assetId, layer.assetFrame, fpsMilli);
    }

    // ---- WebCodecs 主路径 ----
    const result = await this.pool.ensureFrame(layer.assetId, layer.assetFrame);
    if (!result.ok) {
      // **epoch 取消不算解码失败**：连按两次 seek / 播放中跳转都会让旧请求被新请求取代，
      // 那是正常的（新请求会重画这一帧）。算成失败会让 `decodeFailures` 在负载下永远非 0，
      // 诊断指标变成"狼来了"（实测：全量 E2E 连跑时 verify-realworld 的 4K 用例被它坑红）。
      if (result.error.message !== EPOCH_CANCEL_MESSAGE) this.counters.decodeFailures += 1;
      this.diagLastDecodeError = `${result.error.code}: ${result.error.message} | ${result.error.detail ?? ''}`;
      return null;
    }
    // `ensureFrame` 交付的帧是**池克隆出来的独立引用**（归调用方所有），
    // 池的 LRU 淘汰不会影响它；renderOne 在 endFrame 之后负责 close。
    let frame = result.value.frame;
    // 帧在交付后仍可能失效（池的 LRU 淘汰 / 引擎重建的 dispose 竞态）：
    // close 后 displayWidth 归零，合成器只能跳过该层 -> 画面黑。
    // 这里再要一次；池会因缓存项失效而走完整解码路径。
    if (frame.displayWidth <= 0 || frame.displayHeight <= 0) {
      const retry = await this.pool.ensureFrame(layer.assetId, layer.assetFrame);
      if (!retry.ok || retry.value.frame.displayWidth <= 0 || retry.value.frame.displayHeight <= 0) {
        this.counters.decodeFailures += 1;
        this.diagLastDecodeError = retry.ok
          ? `帧失效 display=${retry.value.frame.displayWidth}x${retry.value.frame.displayHeight}`
          : `${retry.error.code}: ${retry.error.message} | ${retry.error.detail ?? ''}`;
        return null;
      }
      frame = retry.value.frame;
    }
    const asset = doc.assets.find((item) => item.id === layer.assetId);

    // HEVC：先把硬件帧摊平到 2D canvas（避免驱动把对齐填充当画面 → 条纹噪声/卡死）
    if (isHevcCodec(asset?.codecVideo ?? null)) {
      const flat = flattenFrameToCanvas(frame);
      try {
        frame.close();
      } catch {
        // 已关闭
      }
      if (flat !== null) {
        this.hevcFlattened += 1;
        // 摊平后仍要处理旋转
        const rotation = (asset?.rotation ?? 0) % 360;
        if (rotation === 90 || rotation === 180 || rotation === 270) {
          const rotated = rotateCanvas(flat, rotation);
          if (rotated !== null) return rotated;
        }
        return flat;
      }
      // 摊平失败：退回原帧（但帧已被 close，只能返回 null 让上层重试）
      return null;
    }

    // 显示旋转：手机竖拍视频存储是横的，靠 tkhd 矩阵转正（WebCodecs 不解旋转）
    const rotation = (asset?.rotation ?? 0) % 360;
    if (rotation === 90 || rotation === 180 || rotation === 270) {
      const rotated = rotateFrameToCanvas(frame, rotation);
      if (rotated !== null) return rotated;
    }
    return frame;
  }

  async preroll(doc: Project, frame: Frame): Promise<void> {
    if (this.disposed || this.mode !== 'webcodecs') return;
    const layers = collectVisibleClips(doc, frame);
    for (const clip of layers) {
      const assetFrame = assetFrameOfClip(doc, clip, frame, doc.fpsMilli);
      if (assetFrame === null) continue;
      await this.pool.ensureFrame(clip.assetId, assetFrame);
    }
  }

  stats(): PlaybackEngineStats {
    return { ...this.counters, diag: { frame: this.diagLastFrame, visible: this.diagLastVisible, docClips: this.diagLastDocClips, decodeError: this.diagLastDecodeError, hevcFlattened: this.hevcFlattened } } as PlaybackEngineStats;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.elements?.dispose();
    this.compositor.dispose();
    await this.pool.dispose();
  }
}

/** 创建播放引擎。 */
export function createPlaybackEngine(options: CreatePlaybackEngineOptions): PlaybackEngine {
  return new PlaybackEngineImpl(options);
}