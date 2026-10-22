/**
 * 预览源注册表 + 预览引擎单例（T13 预览渲染链路）。
 *
 * ## 为什么需要这个模块
 *
 * 导入素材（`AssetPanel`）与渲染上屏（`App`）是两个组件，靠 React 树传递
 * `Mp4ProbeResult` / `Blob` 会很绕。本项目其余状态用模块级 `store` 单例，
 * 这里照同样模式：**素材源注册表 + 播放引擎单例**，两侧通过本模块通信。
 *
 * ## 生命周期
 *
 * - `App` mount 时调用 `ensurePreviewEngine(canvas)` 创建引擎（惰性）；
 * - `AssetPanel` 导入成功后调用 `registerPreviewSource(assetId, file, probe)`，
 *   把源与探测结果登记进注册表，并立刻喂给解码器池；
 * - `App` 的 `transport.onFrame` 里 `renderPreviewFrame(doc, frame)` 上屏；
 * - 刷新后：素材只剩 `FileHandle` 引用，源字节没了，需 `relink`（T18）重新
 *   `getFile()` + `probeAsset` 再 `registerPreviewSource`——本模块对"未登记源"
 *   的素材渲染为缺帧（不崩溃），顶部错误条由 T18 提示。
 */
import { createDecoderPool } from './decoderPool';
import { generateProxy, needsProxy } from './proxy';
import { getProxy, putProxy } from '../persist/autosave';
import { openMp4 } from './demuxMp4';
import { createPlaybackEngine } from './playbackEngine';
import type { PlaybackEngine } from './playbackEngine';
import type { BlobLike, Mp4ProbeResult } from './demuxMp4';
import type { MediaProbeResult } from '../core/types';
import { store } from '../core/store';

interface RegisteredSource {
  source: BlobLike;
  probe: MediaProbeResult;
}

const sources = new Map<string, RegisteredSource>();
/**
 * 代理源（R-052）：assetId → 低分辨率 MP4。
 *
 * **与 `sources` 分开存**，而不是直接覆盖：导出必须拿到原片
 * （`getExportSource`），只有预览路径才允许看代理。
 */
const proxies = new Map<string, RegisteredSource>();
/** 预览是否优先用代理（默认开；关掉只是慢，不会错）。 */
let preferProxy = true;

export type ProxyStatus = 'none' | 'pending' | 'ready' | 'failed';
export interface ProxyState {
  status: ProxyStatus;
  /** 0–1（仅 pending 有意义）。 */
  ratio: number;
  /** 代理分辨率（ready 时有值）。 */
  width: number;
  height: number;
  /** 失败原因（failed 时有值）。 */
  message: string;
}
const proxyStates = new Map<string, ProxyState>();
const proxyListeners = new Set<() => void>();

function setProxyState(assetId: string, patch: Partial<ProxyState>): void {
  const current = proxyStates.get(assetId) ?? {
    status: 'none' as ProxyStatus,
    ratio: 0,
    width: 0,
    height: 0,
    message: '',
  };
  proxyStates.set(assetId, { ...current, ...patch });
  for (const listener of proxyListeners) listener();
}

/** 订阅代理状态变化（素材卡片用它显示"代理 45%"）。 */
export function subscribeProxyState(listener: () => void): () => void {
  proxyListeners.add(listener);
  return () => {
    proxyListeners.delete(listener);
  };
}

export function getProxyState(assetId: string): ProxyState {
  return (
    proxyStates.get(assetId) ?? { status: 'none', ratio: 0, width: 0, height: 0, message: '' }
  );
}

export function isPreferProxy(): boolean {
  return preferProxy;
}

let engine: PlaybackEngine | null = null;
let engineKey = '';
let pool: ReturnType<typeof createDecoderPool> | null = null;

export interface PreviewEngineOptions {
  canvas?: HTMLCanvasElement;
  width?: number;
  height?: number;
  fpsMilli?: number;
}

/**
 * 确保预览引擎已创建（惰性）。
 *
 * **工程参数变化时必须重建**：合成器的画布尺寸在创建时固定，若一直用 1280×720 的引擎
 * 去渲染 1080×1920 的工程，预览与导出就会是两套画面（"预览正常、导出变形"的经典坑）。
 * 这里用 `width×height@fps` 做 key，变了就 dispose 重建，源注册表会重新灌进新引擎。
 */
export function ensurePreviewEngine(options: PreviewEngineOptions = {}): PlaybackEngine {
  const width = options.width ?? 1280;
  const height = options.height ?? 720;
  const fpsMilli = options.fpsMilli ?? 30000;
  const key = `${width}x${height}@${fpsMilli}`;
  if (engine !== null && engineKey === key) return engine;
  if (engine !== null) {
    void engine.dispose();
    engine = null;
  }
  engineKey = key;
  const nextPool = createDecoderPool();
  pool = nextPool;
  engine = createPlaybackEngine({
    width,
    height,
    fpsMilli,
    decoderPool: nextPool,
    ...(options.canvas === undefined ? {} : { canvas: options.canvas }),
  });
  // 重建后把已登记的素材重新喂给新引擎（否则刷新/改参数后预览全黑）
  for (const [assetId, entry] of sources) {
    if (entry.probe.container !== 'mp4' && entry.probe.container !== 'webm') continue;
    engine.registerAsset(assetId, entry.source, entry.probe as Mp4ProbeResult);
  }
  return engine;
}

/** 预览引擎（可能为 null，尚未创建）。 */
export function peekPreviewEngine(): PlaybackEngine | null {
  return engine;
}

/** 预览引擎的解码器池（音频调度复用同一池，避免两套解码会话抢资源）。 */
export function peekDecoderPool(): ReturnType<typeof createDecoderPool> | null {
  return pool;
}

/**
 * 登记素材源 + 探测结果，并立即喂给解码器池。
 *
 * `mp4` 与 `webm` 都会注册进解码器池（T19 起 webm 是帧精确源）；其它容器只登记源、
 * 不注册（避免把不支持的容器喂给解码器池）。
 */
export function registerPreviewSource(
  assetId: string,
  source: BlobLike,
  probe: MediaProbeResult,
): void {
  sources.set(assetId, { source, probe });
  if (engine === null) return;
  // mp4 与 webm 都进池（T19 起 webm 也是帧精确实时源）。
  //
  // 类型断言说明：解码器池只读 `video`(codec/width/height/description)、`samples`、
  // `keyframeIndex`、`audio.samples` —— 这些字段 `WebmProbeResult` 与 `Mp4ProbeResult`
  // **完全同构**（T19 就是为此复用同一结构）；池不读 `timescale`/`durationTicks` 等
  // mp4 独有的元数据，所以断言在运行时安全。
  if (probe.container !== 'mp4' && probe.container !== 'webm') return;
  /**
   * 注册（**覆盖**语义）。
   *
   * 池的 `register` 自己会先 `release` 掉旧会话与帧缓存（见 `decoderPool.register`），
   * 所以这里**不要**再调 `engine.unregisterAsset`：
   * 那个方法内部是 `void pool.unregister(...)`（**异步**彻底删除），
   * 会和紧跟着的同步 `register` 打架 —— 实测把刚注册的源删掉，
   * 表现是"重链成功但画面永远黑"。
   */
  engine.registerAsset(assetId, source, probe as Mp4ProbeResult);
  // 注册后立刻补画一帧。
  // 为什么必须补：导入流程是「先 addAsset（触发一次 doc 通知 → 渲染）→ 再 registerPreviewSource」，
  // 那次渲染发生时源还没注册，取帧失败 → 合成器只清了屏，画面停在黑屏，
  // 而且**不会再有下一次通知**来救它（后续 updateAsset 若值未变会被判为 no-op）。
  // 症状：用 ?src= 打开时预览全黑，随便点一下才出画。
  void renderPreviewFrame(store.getDoc(), store.getPlayheadFrame());
  // R-052：4K 级素材在后台生成代理（1080p 及以下直接返回，不产生任何开销）
  void ensureProxyFor(assetId);
}

/**
 * 清空全部素材源与代理（换工程时调用）。
 *
 * 不清的话旧素材的字节还挂在引擎里：新工程的片段引用的是新 id，画不出来是小事，
 * 但旧源的解码会话与帧缓存会一直占着内存，而且"看起来能播"会误导排查。
 */
export function resetPreviewSources(): void {
  for (const assetId of [...sources.keys(), ...proxies.keys()]) {
    engine?.unregisterAsset(assetId);
  }
  sources.clear();
  proxies.clear();
  proxyStates.clear();
  for (const listener of proxyListeners) listener();
}

/** 注销素材（从工程移除时调用）。 */
export function unregisterPreviewSource(assetId: string): void {
  sources.delete(assetId);
  proxies.delete(assetId);
  proxyStates.delete(assetId);
  engine?.unregisterAsset(assetId);
}

/**
 * 当前**预览**应使用的源：代理优先（R-052），没有代理就是原片。
 *
 * 注意：这是"预览路径"的取源。导出必须用 `getExportSource`——
 * 代理是降过分辨率的，进了成片就是画质事故。
 */
export function getPreviewSource(assetId: string): RegisteredSource | undefined {
  return currentEntry(assetId);
}

/** 当前预览应使用的探测结果（音频调度需要 `probe.audio.samples` 时间戳表）。 */
export function getPreviewProbe(assetId: string): MediaProbeResult | undefined {
  return currentEntry(assetId)?.probe;
}

/** **导出**专用：永远返回原片（代理只服务预览）。 */
export function getExportSource(assetId: string): RegisteredSource | undefined {
  return sources.get(assetId);
}

/** **导出**专用探测结果（与原片一一对应）。 */
export function getExportProbe(assetId: string): MediaProbeResult | undefined {
  return sources.get(assetId)?.probe;
}

function currentEntry(assetId: string): RegisteredSource | undefined {
  if (preferProxy) {
    const proxy = proxies.get(assetId);
    if (proxy !== undefined) return proxy;
  }
  return sources.get(assetId);
}

/**
 * 切源后先**预热一帧**再重绘。
 *
 * 为什么要预热：`register` 重置了该素材的解码会话，紧接着的重绘会在"会话刚重建"的窗口里
 * 拿到失败结果（层被跳过 → 只清屏）。而 `renderPreviewFrame` 的重试预算只有 5 次（约 1.8 秒），
 * 窗口更长时就永久黑屏了。这里显式 `await` 一次取帧，把"会话就绪"变成可控的前置条件。
 */
async function warmThenRefresh(assetId: string): Promise<void> {
  const current = pool;
  if (current !== null) {
    try {
      await current.ensureFrame(assetId, 0);
    } catch {
      // 预热失败不致命：后面的重绘仍会重试
    }
  }
  // 关键：**等到"真的画了一帧"为止**。
  // `renderFrame` 会把并发请求合并成一次（返回 `decoded:false` 表示"这次没画，交给在途的那次"），
  // 切源瞬间往往正好有一次在途渲染——直接 `void renderPreviewFrame()` 会全部被吞掉，
  // 结果就是"切了源但画面没重绘"，而之后没有任何事件会再来画（黑屏卡住）。
  if (engine !== null) {
    // 两轮：第一轮等"真的画了一帧"，第二轮保证画的是**解码就绪之后**的帧
    // （刚 configure 的解码器第一帧可能只是占位黑帧）。
    for (let pass = 0; pass < 2; pass += 1) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const result = await engine.renderFrame(store.getDoc(), store.getPlayheadFrame());
        if (result.ok && result.value.decoded) break;
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }
}

/** 把某个素材当前的源灌进引擎（切换代理/原片时调用）。 */
function applySourceToEngine(assetId: string): void {
  if (engine === null) return;
  const entry = currentEntry(assetId);
  if (entry === undefined) return;
  if (entry.probe.container !== 'mp4' && entry.probe.container !== 'webm') return;
  /**
   * **只 register**（覆盖语义）：池的 `register` 自己会先 `release` 掉旧会话与帧缓存。
   *
   * 这里**不能**再显式 `unregisterAsset`：那个方法内部是 `void pool.unregister(...)`
   * （异步彻底删除），会在后面把**刚注册的新源**删掉 ——
   * 表现为"切了代理之后画面黑 / 导出没有音轨"（实测 m3-export 的
   * "音频流 undefined、均值 -999dB" 就是它）。
   */
  engine.registerAsset(assetId, entry.source, entry.probe as Mp4ProbeResult);
}

/**
 * 开关"预览用代理"。
 *
 * 关掉只是变慢（回到原片），不会出错；导出永远走原片，与这个开关无关。
 */
export function setPreferProxy(on: boolean): void {
  if (preferProxy === on) return;
  preferProxy = on;
  const touched = [...new Set([...sources.keys(), ...proxies.keys()])];
  for (const assetId of touched) applySourceToEngine(assetId);
  void (async () => {
    for (const assetId of touched) await warmThenRefresh(assetId);
  })();
}

/**
 * 登记代理源并（在开启时）立刻切过去。
 *
 * 切源必须走 `registerAsset`（池内会重置会话与缓存）：代理和原片的样本表不同，
 * 沿用旧会话会按错误的关键帧索引去 seek，表现为"预览花屏/黑屏"。
 */
export function registerProxySource(assetId: string, blob: Blob, probe: MediaProbeResult): void {
  proxies.set(assetId, { source: blob, probe });
  setProxyState(assetId, {
    status: 'ready',
    ratio: 1,
    width: probe.width ?? 0,
    height: probe.height ?? 0,
    message: '',
  });
  if (preferProxy) {
    applySourceToEngine(assetId);
    void warmThenRefresh(assetId);
  }
}

/** 正在生成代理的素材（避免同一素材被并发转两次）。 */
const proxyJobs = new Set<string>();

/**
 * 确保某个素材有代理（R-052）。
 *
 * 顺序：**IDB 缓存 → 现转**。缓存命中时不必重转——刷新页面、重开工程都能直接复用。
 * 只在 `needsProxy`（4K 级）时才会走到这里，1080p 素材零开销。
 */
export async function ensureProxyFor(assetId: string): Promise<void> {
  const asset = store.getDoc().assets.find((item) => item.id === assetId);
  if (asset === undefined) return;
  if (!needsProxy(asset)) return;
  if (proxies.has(assetId) || proxyJobs.has(assetId)) return;
  const original = sources.get(assetId);
  if (original === undefined) return;
  const probe = original.probe;
  if (probe.container !== 'mp4' || probe.hasVideo !== true) return;
  if (typeof VideoEncoder !== 'function') {
    setProxyState(assetId, { status: 'failed', message: '浏览器不支持视频编码，无法生成代理' });
    return;
  }

  proxyJobs.add(assetId);
  setProxyState(assetId, { status: 'pending', ratio: 0, message: '' });
  try {
    const cached = await getProxy(assetId);
    if (cached.ok && cached.value !== null) {
      const probed = await openMp4(cached.value);
      if (probed.ok) {
        registerProxySource(assetId, cached.value, probed.value);
        return;
      }
    }

    const result = await generateProxy({
      assetId,
      probe: probe as Mp4ProbeResult,
      source: original.source,
      fpsMilli: asset.fpsMilli,
      durationFrames: asset.durationFrames ?? probe.durationFrames ?? 0,
      hasAudio: asset.hasAudio,
      onProgress: (ratio) => setProxyState(assetId, { status: 'pending', ratio }),
    });
    if (!result.ok) {
      setProxyState(assetId, { status: 'failed', message: result.error.message });
      return;
    }
    void putProxy(assetId, result.value.blob);
    registerProxySource(assetId, result.value.blob, result.value.probe);
  } finally {
    proxyJobs.delete(assetId);
  }
}

/**
 * 渲染一帧到预览画布（`transport.onFrame` 与 doc 订阅调用）。
 *
 * **失败自动重试（有上限）**：起播/刚导入时解码会话可能还没建好，
 * 这一帧会"缺层"——合成器已经清屏，于是留下黑屏，而不会再有下一次通知来救它。
 * 早期症状是"用 ?src= 打开全黑，随便点一下才出画"。
 * 这里对"非精确帧"在下一帧重试，最多 5 次，够覆盖会话建立，又不会在真坏素材上死循环。
 */
let retryBudget = 0;

/** 最近一次渲染异常的文本（`void renderPreviewFrame()` 会吞掉异常，必须自己记）。 */
let lastRenderError = '';

export function getLastRenderError(): string {
  return lastRenderError;
}

/** 工程总时长（帧）：所有片段 end 的最大值；空工程为 0。 */
function projectDurationFrames(doc: import('../core/types').Project): number {
  let total = 0;
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      const end = clip.startFrame + clip.durationFrames;
      if (end > total) total = end;
    }
  }
  return total;
}

export async function renderPreviewFrame(
  doc: import('../core/types').Project,
  frame: number,
): Promise<void> {
  if (engine === null) return;
  // 播放头允许停在"末尾点"（frame === 总时长），那里没有实际内容：
  // 用最后一帧渲染，避免末尾画面突然变黑（也让追加片段后不重叠）。
  const total = projectDurationFrames(doc);
  const renderAt = total > 0 && frame >= total ? total - 1 : frame;
  let result;
  try {
    result = await engine.renderFrame(doc, renderAt);
  } catch (error) {
    // 关键：调用方都是 `void renderPreviewFrame(...)`，异常一旦逃逸就成了未处理的
    // Promise rejection —— 画面上表现为"预览永远停在黑屏，且没有任何提示"。
    lastRenderError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return;
  }
  lastRenderError = '';
  /**
   * 三个"不需要重试"的出口，顺序有意义：
   *
   * 1. `exact`：每一层都画上了它自己的那一帧；
   * 2. `empty`：本帧**本来就没有内容**（空工程 / 空隙 / 轨道全隐藏）——
   *    此时画面是一张干净的背景，已经是对的。旧代码不认这一条，会拿 `exactSeek`
   *    去判（element 模式恒 false），于是把预算耗在"重画一张本来就该全黑的画面"上，
   *    预算一满就再也不会自动重绘 —— 用户看到的就是"切回显示轨道也不刷新"。
   * 3. `decoded === false`：这次请求被合并进在途渲染了，那次会画，不必再加一次。
   */
  if (result.ok && (result.value.exact || result.value.empty === true)) {
    retryBudget = 0;
    return;
  }
  if (result.ok && result.value.decoded === false) {
    // 在途渲染会画这一帧：不算失败，也不消耗预算
    return;
  }
  // 退避重试：解码会话建立 + 首个关键帧解码实测要 100–800ms，
  // 用 rAF（≈16ms）重试会全部打完还没解出来，反而永远黑屏。
  if (retryBudget >= 5) return;
  const delay = 60 * 2 ** retryBudget;
  retryBudget += 1;
  setTimeout(() => {
    void renderPreviewFrame(store.getDoc(), store.getPlayheadFrame());
  }, delay);
}

/**
 * **强制重绘当前帧**（无视重试预算）。
 *
 * 用途：轨道状态变更（隐藏/显示/静音/独奏）之后必须"立刻看到效果"。
 * 为什么不能只靠 `renderPreviewFrame`：
 * - 它有重试预算，预算耗尽时直接返回，**一帧都不画**；
 * - 它把并发请求合并，状态刚变的那一次可能被在途渲染吞掉。
 *
 * 这个函数把预算清零、重新发起一次，保证"改了就一定重画"。
 * 暂停状态下也有效（`renderFrame` 不依赖播放时钟）。
 */
export function repaintPreview(): void {
  retryBudget = 0;
  void renderPreviewFrame(store.getDoc(), store.getPlayheadFrame());
}

/**
 * 读回预览画面像素统计（E2E 验收用）。
 *
 * **必须走 `compositor.captureFrame()`**（合成器自己的 FBO 读回路径）——
 * 直接 `drawImage(webglCanvas)` 会因 `preserveDrawingBuffer:false` 读到空 buffer，
 * 症状是"画面明明正常、测出来全黑"。
 */
/**
 * 只统计画面的一块（0..1 相对坐标）。
 *
 * 为什么需要：蒙版这类"遮一半"的效果，全画面均值在"遮左边"和"遮右边"下**完全一样**，
 * 拿均值断言等于没断言（2026-10-21 就是这样放过了一个方向反了的 bug）。分区域量才有意义。
 */
export interface PreviewRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export async function capturePreviewStats(region?: PreviewRegion): Promise<{
  nonBlack: number;
  total: number;
  maxLuma: number;
  /** 平均亮度：调色这类"整体变化"只能靠它判定（最大亮度会被画面里的纯白字顶住）。 */
  meanLuma: number;
} | null> {
  if (engine === null) return null;
  const bitmap = await engine.compositor.captureFrame();
  /**
   * 尺寸校验：`ImageBitmap` 的宽高为 0 时（合成器刚 resize / 上下文丢失重建中）
   * 下面 `canvas.width = 0` 会让 `getImageData` 直接抛 `IndexSizeError`，
   * 而调用方（自检、E2E）拿到的是异常而不是"这一帧还没准备好"。
   */
  if (bitmap.width <= 0 || bitmap.height <= 0) {
    bitmap.close();
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    bitmap.close();
    return null;
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  // 区域裁剪：四舍五入到像素并夹在画布内（区域可能因为浮点误差越界 1px）
  const px = region === undefined ? 0 : Math.min(canvas.width - 1, Math.max(0, Math.round(region.x * canvas.width)));
  const py = region === undefined ? 0 : Math.min(canvas.height - 1, Math.max(0, Math.round(region.y * canvas.height)));
  const pw = region === undefined ? canvas.width : Math.max(1, Math.min(canvas.width - px, Math.round(region.w * canvas.width)));
  const ph = region === undefined ? canvas.height : Math.max(1, Math.min(canvas.height - py, Math.round(region.h * canvas.height)));
  const data = ctx.getImageData(px, py, pw, ph).data;
  let nonBlack = 0;
  let maxLuma = 0;
  let sumLuma = 0;
  const pixels = data.length / 4;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    if (luma > maxLuma) maxLuma = luma;
    sumLuma += luma;
    if (luma > 24) nonBlack += 1;
  }
  return { nonBlack, total: pixels, maxLuma, meanLuma: pixels > 0 ? sumLuma / pixels : 0 };
}

/** 释放引擎（App 卸载 / 测试清理）。 */
export async function disposePreviewEngine(): Promise<void> {
  if (engine === null) return;
  await engine.dispose();
  engine = null;
  sources.clear();
}
