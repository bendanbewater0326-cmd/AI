/**
 * 导出（M3）：把时间线渲染成可发布的成片。
 *
 * ## 支持格式（用户可选）
 *
 * | 格式 | 视频 | 音频 | 说明 |
 * |---|---|---|---|
 * | `mp4` | H.264（WebCodecs `VideoEncoder`） | AAC 48kHz 立体声 | 默认，体积/兼容性最好 |
 * | `gif` | 调色板 GIF（gifenc） | 无 | 可选帧率 10/15/24、宽度 ≤1080 |
 * | `wav` | 无 | 16bit PCM 48kHz | 纯音频，给播客/口播用 |
 * | `png` | RGBA PNG 序列 + ZIP | 无 | 透明通道（R-062）；**不产出可直接播放的透明视频** |
 *
 * ## 为什么导出要独立一套引擎
 *
 * 预览引擎的画布尺寸、解码器缓存与播放状态都属于"正在看的那一帧"；导出是长任务，
 * 若共用会让预览卡住甚至把导出帧画到屏幕上。这里用独立的 `DecoderPool` + `PlaybackEngine`，
 * 只共享素材源注册表（`previewSource`），导出结束后整体释放。
 *
 * ## 正确性口径
 *
 * - 帧号：导出第 i 帧 == 时间线第 `startFrame + i` 帧，走同一个 `renderFrame`；
 * - 时间戳：`frameToUs(i, fpsMilli)`，不允许在导出侧另算一遍；
 * - 音频：`mixTimelineAudio` 按 `totalSamplesFor` 守恒，与视频总时长差 ≤ 1 帧。
 */
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import type { Frame, Project, Result } from '../core/types';
import { makeError } from '../core/types';
import { frameToUs, framesPerSecond, samplesToUs } from '../core/timebase';
import { createDecoderPool } from '../media/decoderPool';
import { registerProjectSources } from '../media/sourceRegistry';
import type { DecoderPool } from '../media/decoderPool';
import { createPlaybackEngine } from '../media/playbackEngine';
import type { PlaybackEngine } from '../media/playbackEngine';
import type { Mp4ProbeResult } from '../media/demuxMp4';
import { PROJECT_SAMPLE_RATE } from '../media/audioEngine';
import { getExportProbe, getExportSource } from '../media/previewSource';
import { encodeWav, mixTimelineAudio } from './audioMix';
import { createZip } from './zip';
import type { ZipEntry } from './zip';

export type ExportFormat = 'mp4' | 'gif' | 'wav' | 'png';

export interface ExportRequest {
  doc: Project;
  format: ExportFormat;
  /** 导出区间（项目帧，`endFrame` exclusive）。 */
  startFrame: Frame;
  endFrame: Frame;
  /** GIF 专用：输出宽度（默认 480）与帧率（默认 15）。 */
  gifWidth?: number;
  gifFps?: number;
  /**
   * 只导这一个片段（目前仅 `wav` 用：右键"导出这段的音频"）。
   *
   * 调用方要把 `startFrame`/`endFrame` 设成**这个片段自己的区间**；
   * 本字段只决定"别的片段不参与混音"。
   */
  onlyClipId?: string;
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
}

export interface ExportProgress {
  ratio: number;
  stage: string;
}

export interface ExportOutput {
  blob: Blob;
  filename: string;
  /** 实际编码的帧数（GIF 会抽帧，故可能小于区间帧数）。 */
  frames: number;
  /** 是否含音轨。 */
  hasAudio: boolean;
}

/** 把工程名变成安全的文件名。 */
function safeName(doc: Project, ext: string): string {
  const base = doc.name.trim().replace(/[\\/:*?"<>|]+/g, '_') || 'veditor';
  return `${base}.${ext}`;
}

/** 单片段音频导出用文件名：`素材名-音频.wav`（工程名 + 片段序号会撞车，素材名更好认）。 */
function safeClipAudioName(doc: Project, clipId: string): string {
  const clip = doc.tracks.flatMap((track) => track.clips).find((item) => item.id === clipId);
  const asset = clip === undefined ? undefined : doc.assets.find((item) => item.id === clip.assetId);
  const raw = (asset?.name ?? doc.name).replace(/\.[^.]+$/, '');
  const base = raw.trim().replace(/[\\/:*?"<>|]+/g, '_') || 'audio';
  return `${base}-音频.wav`;
}

function abortError(): Result<never> {
  return { ok: false, error: makeError('E_DECODE_FAILED', '导出已取消', 'exportProject') };
}

/** 挑一个浏览器支持的 H.264 配置（1080p 用 Level 4.0，小分辨率降级到 3.1）。 */
async function pickAvcConfig(width: number, height: number, fps: number): Promise<VideoEncoderConfig | null> {
  const candidates = [
    'avc1.640028',
    'avc1.4d0028',
    'avc1.42001f',
    'avc1.42001e',
  ];
  for (const codec of candidates) {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate: Math.max(1_048_576, Math.round(width * height * fps * 0.1)),
      framerate: fps,
      avc: { format: 'avc' },
      latencyMode: 'quality',
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported === true) return config;
    } catch {
      // 该 codec 字符串不被识别，继续下一个
    }
  }
  return null;
}

/** 渲染器：独立引擎，逐帧出图。 */
class FrameRenderer {
  private readonly engine: PlaybackEngine;
  private readonly pool: DecoderPool;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;

  constructor(doc: Project, assets: string[], transparent = false) {
    this.width = Math.max(2, doc.width - (doc.width % 2));
    this.height = Math.max(2, doc.height - (doc.height % 2));
    this.pool = createDecoderPool();
    this.engine = createPlaybackEngine({
      width: this.width,
      height: this.height,
      fpsMilli: doc.fpsMilli,
      decoderPool: this.pool,
      // 只有 PNG 序列需要 alpha；MP4/GIF 传 false（编码器不保留 alpha，会变黑底）
      ...(transparent ? { alpha: true } : {}),
    });
    for (const assetId of assets) {
      // 导出永远用原片（R-052：代理只服务预览）
      const source = getExportSource(assetId);
      const probe = getExportProbe(assetId);
      if (source === undefined || probe === undefined) continue;
      // mp4 与 webm 都要注册：T19 起 webm 是帧精确源，若在这里按 container 过滤，
      // 会出现"webm 能剪能预览、导出时画面与声音一起消失"的静默失败。
      if (probe.container !== 'mp4' && probe.container !== 'webm') continue;
      this.engine.registerAsset(assetId, source.source, probe as Mp4ProbeResult);
    }
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (ctx === null) throw new Error('导出：无法创建 2D 画布');
    this.ctx = ctx;
  }

  /** 渲染一帧到 2D 画布，返回该画布（复用同一个，避免每帧分配）。 */
  async renderFrame(doc: Project, frame: Frame): Promise<HTMLCanvasElement> {
    await this.engine.renderFrame(doc, frame);
    const bitmap = await this.engine.compositor.captureFrame();
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.ctx.drawImage(bitmap, 0, 0, this.width, this.height);
    bitmap.close();
    return this.canvas;
  }

  async dispose(): Promise<void> {
    await this.engine.dispose();
  }
}


/* ---------------- MP4 ---------------- */

async function exportMp4(request: ExportRequest): Promise<Result<ExportOutput>> {
  const { doc, startFrame, endFrame } = request;
  const fps = doc.fpsMilli;
  const fpsValue = Math.max(1, Math.round(fps / 1000)); // timebase-allow: 仅用于编码器 framerate 字段
  const frames = Math.max(0, endFrame - startFrame);
  const width = Math.max(2, doc.width - (doc.width % 2));
  const height = Math.max(2, doc.height - (doc.height % 2));

  if (typeof VideoEncoder !== 'function') {
    return { ok: false, error: makeError('E_DECODE_FAILED', '当前浏览器不支持视频编码（需要 Chrome/Edge 111+）', 'exportMp4') };
  }
  const videoConfig = await pickAvcConfig(width, height, fpsValue);
  if (videoConfig === null) {
    return { ok: false, error: makeError('E_DECODE_FAILED', '浏览器没有可用的 H.264 编码器', 'exportMp4') };
  }

  // ---- 1. 先混音频：失败不影响视频，只是静音 ----
  const assets = [...new Set(doc.tracks.flatMap((track) => track.clips.map((clip) => clip.assetId)))];
  const pool = createDecoderPool();
  registerProjectSources(pool, doc);
  request.onProgress?.({ ratio: 0.02, stage: '混合音频' });
  const mixed = await mixTimelineAudio({
    doc,
    startFrame,
    endFrame,
    pool,
    getProbe: (assetId) => getExportProbe(assetId) as Mp4ProbeResult | undefined,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    onProgress: (ratio) => request.onProgress?.({ ratio: 0.02 + ratio * 0.08, stage: '混合音频' }),
  });
  const audio = mixed.ok ? mixed.value : null;
  const hasAudio = audio !== null && audio.channels.some((plane) => plane.some((value) => value !== 0));

  // ---- 2. 封装器 ----
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height, frameRate: fpsValue },
    ...(hasAudio
      ? { audio: { codec: 'aac' as const, numberOfChannels: 2, sampleRate: PROJECT_SAMPLE_RATE } }
      : {}),
    fastStart: 'in-memory',
  });

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (error) => {
      throw error;
    },
  });
  videoEncoder.configure(videoConfig);

  const renderer = new FrameRenderer(doc, assets);
  try {
    const keyEvery = Math.max(1, fpsValue);
    for (let i = 0; i < frames; i += 1) {
      if (request.signal?.aborted === true) {
        videoEncoder.close();
        return abortError();
      }
      const canvas = await renderer.renderFrame(doc, startFrame + i);
      const videoFrame = new VideoFrame(canvas, {
        timestamp: frameToUs(i, fps),
        duration: frameToUs(1, fps),
      });
      videoEncoder.encode(videoFrame, { keyFrame: i % keyEvery === 0 });
      videoFrame.close();
      if (videoEncoder.encodeQueueSize > 8) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      request.onProgress?.({ ratio: 0.1 + (i / Math.max(1, frames)) * 0.78, stage: `编码视频 ${i + 1}/${frames}` });
    }
    await videoEncoder.flush();
  } catch (error) {
    videoEncoder.close();
    return {
      ok: false,
      error: makeError('E_DECODE_FAILED', `编码失败：${error instanceof Error ? error.message : String(error)}`, 'exportMp4'),
    };
  } finally {
    await renderer.dispose();
    await pool.dispose();
  }

  // ---- 3. 音频编码 ----
  if (hasAudio && audio !== null) {
    request.onProgress?.({ ratio: 0.9, stage: '编码音频' });
    try {
      const audioEncoder = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (error) => {
          throw error;
        },
      });
      audioEncoder.configure({
        codec: 'mp4a.40.2',
        sampleRate: PROJECT_SAMPLE_RATE,
        numberOfChannels: 2,
        bitrate: 128_000,
      });
      const chunkSamples = 1024;
      for (let offset = 0; offset < audio.length; offset += chunkSamples) {
        const count = Math.min(chunkSamples, audio.length - offset);
        const planar = new Float32Array(count * 2);
        const left = audio.channels[0];
        const right = audio.channels[1] ?? audio.channels[0];
        for (let i = 0; i < count; i += 1) {
          planar[i] = left?.[offset + i] ?? 0;
          planar[count + i] = right?.[offset + i] ?? 0;
        }
        const data = new AudioData({
          format: 'f32-planar',
          sampleRate: PROJECT_SAMPLE_RATE,
          numberOfFrames: count,
          numberOfChannels: 2,
          timestamp: samplesToUs(offset, PROJECT_SAMPLE_RATE),
          data: planar,
        });
        audioEncoder.encode(data);
        data.close();
      }
      await audioEncoder.flush();
      audioEncoder.close();
    } catch (error) {
      // 音频失败不丢视频：已封装的视频照常输出，由 UI 提示"本次导出无音轨"
      void error;
    }
  }

  muxer.finalize();
  const buffer = muxer.target.buffer;
  return {
    ok: true,
    value: {
      blob: new Blob([buffer], { type: 'video/mp4' }),
      filename: safeName(doc, 'mp4'),
      frames,
      hasAudio,
    },
  };
}

/* ---------------- GIF ---------------- */

async function exportGif(request: ExportRequest): Promise<Result<ExportOutput>> {
  const { doc, startFrame, endFrame } = request;
  const total = Math.max(0, endFrame - startFrame);
  const gifFps = Math.min(24, Math.max(1, request.gifFps ?? 15));
  const targetWidth = Math.min(1080, Math.max(64, request.gifWidth ?? 480));
  const scale = targetWidth / doc.width;
  const targetHeight = Math.max(2, Math.round(doc.height * scale));
  const step = Math.max(1, Math.round(doc.fpsMilli / 1000 / gifFps)); // timebase-allow: 仅算抽帧步长（每 N 帧取 1 帧）
  const frameCount = Math.max(1, Math.floor(total / step));
  const assets = [...new Set(doc.tracks.flatMap((track) => track.clips.map((clip) => clip.assetId)))];

  const renderer = new FrameRenderer(doc, assets);
  const gif = GIFEncoder();
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) {
    await renderer.dispose();
    return { ok: false, error: makeError('E_DECODE_FAILED', '导出：无法创建 GIF 画布', 'exportGif') };
  }
  // timebase-allow: GIF 帧延迟是播放器元数据（毫秒/帧），不参与任何帧号换算
  const delay = Math.round(1000 / gifFps);

  try {
    for (let i = 0; i < frameCount; i += 1) {
      if (request.signal?.aborted === true) return abortError();
      const source = await renderer.renderFrame(doc, startFrame + i * step);
      ctx.drawImage(source, 0, 0, targetWidth, targetHeight);
      const image = ctx.getImageData(0, 0, targetWidth, targetHeight);
      const palette = quantize(image.data, 256, { format: 'rgb565' });
      const index = applyPalette(image.data, palette, 'rgb565');
      gif.writeFrame(index, targetWidth, targetHeight, {
        palette,
        delay,
        ...(i === 0 ? { repeat: 0 } : {}),
      });
      request.onProgress?.({ ratio: 0.05 + ((i + 1) / frameCount) * 0.9, stage: `渲染 GIF ${i + 1}/${frameCount}` });
    }
    gif.finish();
    return {
      ok: true,
      value: {
        blob: new Blob([new Uint8Array(gif.bytes())], { type: 'image/gif' }),
        filename: safeName(doc, 'gif'),
        frames: frameCount,
        hasAudio: false,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: makeError('E_DECODE_FAILED', `GIF 导出失败：${error instanceof Error ? error.message : String(error)}`, 'exportGif'),
    };
  } finally {
    await renderer.dispose();
  }
}

/* ---------------- PNG 序列（R-062） ---------------- */

/**
 * 一次最多导出多少帧。
 *
 * 为什么要有上限：PNG 序列是**无损 RGBA**，1080p 单帧约 1–2MB，全部攒在内存里再打包。
 * 不做限制的话，一段 10 分钟的视频会直接把标签页打爆（而且是"导出到 90% 才崩"）。
 * 600 帧 ≈ 20 秒 @30fps，足够覆盖"透明叠加层"的典型用途；更长就分段导。
 */
const MAX_PNG_FRAMES = 600;
/** 像素预算：600 帧 1080p 约 12 亿像素，太接近内存红线，再加一道闸。 */
const MAX_PNG_PIXELS = 400_000_000;

/**
 * 透明通道导出（R-062）：RGBA PNG 序列 + ZIP。
 *
 * 三个必须做对的点：
 * 1. **合成器要开 alpha**（`alpha: true`）：否则清屏 alpha=1，PNG 全是不透明黑，等于没做；
 * 2. **文件名从 `frame_000001.png` 起连续编号**（PRD 明确要求），补零到 6 位保证字典序 == 帧序；
 * 3. **必须附 `frames.json`**：记录帧率与起止帧，否则下游不知道该按几帧/秒回放。
 *
 * 明确**不产出可直接播放的透明视频**——浏览器编码器不开放 alpha（见 tech-preflight），
 * 这条写在 PRD 与 UI 提示里，不做"假装支持"。
 */
async function exportPngSequence(request: ExportRequest): Promise<Result<ExportOutput>> {
  const { doc, startFrame, endFrame } = request;
  const frames = Math.max(0, endFrame - startFrame);
  const width = Math.max(2, doc.width - (doc.width % 2));
  const height = Math.max(2, doc.height - (doc.height % 2));

  if (frames > MAX_PNG_FRAMES || frames * width * height > MAX_PNG_PIXELS) {
    const fps = Math.max(1, framesPerSecond(doc.fpsMilli));
    return {
      ok: false,
      error: makeError(
        'E_DECODE_FAILED',
        `PNG 序列一次最多 ${MAX_PNG_FRAMES} 帧（约 ${Math.floor(MAX_PNG_FRAMES / fps)} 秒），当前 ${frames} 帧`,
        '本次选择的是无损 RGBA 序列，体积很大；请分段导出，或改用 MP4',
      ),
    };
  }

  const assets = [...new Set(doc.tracks.flatMap((track) => track.clips.map((clip) => clip.assetId)))];
  const renderer = new FrameRenderer(doc, assets, true);
  const entries: ZipEntry[] = [];

  try {
    for (let i = 0; i < frames; i += 1) {
      if (request.signal?.aborted === true) return abortError();
      const canvas = await renderer.renderFrame(doc, startFrame + i);
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((value) => resolve(value), 'image/png');
      });
      if (blob === null) throw new Error('PNG 编码失败（toBlob 返回 null）');
      const data = new Uint8Array(await blob.arrayBuffer());
      entries.push({ name: `frame_${String(i + 1).padStart(6, '0')}.png`, data });
      request.onProgress?.({
        ratio: 0.05 + ((i + 1) / Math.max(1, frames)) * 0.9,
        stage: `渲染 PNG ${i + 1}/${frames}`,
      });
    }

    const manifest = {
      // 清单给人/下游看：帧/秒走 timebase 的换算函数，不在这里写除法
      fps: framesPerSecond(doc.fpsMilli),
      fpsMilli: doc.fpsMilli,
      width,
      height,
      startFrame,
      endFrame,
      frameCount: frames,
      firstFile: 'frame_000001.png',
      lastFile: `frame_${String(frames).padStart(6, '0')}.png`,
      numbering: '第 N 个文件（从 1 起）= 时间线第 startFrame + N - 1 帧',
      alpha: 'RGBA，未预乘；空白处 alpha = 0',
    };
    entries.push({
      name: 'frames.json',
      data: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
    });

    request.onProgress?.({ ratio: 0.98, stage: '打包 ZIP' });
    const zip = createZip(entries);
    return {
      ok: true,
      value: {
        blob: new Blob([zip], { type: 'application/zip' }),
        filename: safeName(doc, 'zip'),
        frames,
        hasAudio: false,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: makeError(
        'E_DECODE_FAILED',
        `PNG 序列导出失败：${error instanceof Error ? error.message : String(error)}`,
        'exportPngSequence',
      ),
    };
  } finally {
    await renderer.dispose();
  }
}

/* ---------------- WAV ---------------- */

async function exportWav(request: ExportRequest): Promise<Result<ExportOutput>> {
  const { doc, startFrame, endFrame } = request;
  const pool = createDecoderPool();
  registerProjectSources(pool, doc);
  try {
    const mixed = await mixTimelineAudio({
      doc,
      startFrame,
      endFrame,
      pool,
      getProbe: (assetId) => getExportProbe(assetId) as Mp4ProbeResult | undefined,
      ...(request.onlyClipId === undefined ? {} : { onlyClipId: request.onlyClipId }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      onProgress: (ratio) => request.onProgress?.({ ratio: 0.05 + ratio * 0.9, stage: '混合音频' }),
    });
    if (!mixed.ok) return mixed;
    request.onProgress?.({ ratio: 0.98, stage: '写入 WAV' });
    return {
      ok: true,
      value: {
        blob: encodeWav(mixed.value),
        filename:
          request.onlyClipId === undefined
            ? safeName(doc, 'wav')
            : safeClipAudioName(doc, request.onlyClipId),
        frames: endFrame - startFrame,
        hasAudio: true,
      },
    };
  } finally {
    await pool.dispose();
  }
}

/** 导出入口。 */
export async function exportProject(request: ExportRequest): Promise<Result<ExportOutput>> {
  const frames = request.endFrame - request.startFrame;
  if (!Number.isInteger(request.startFrame) || !Number.isInteger(request.endFrame) || frames <= 0) {
    return { ok: false, error: makeError('E_DECODE_FAILED', '导出区间不合法', 'exportProject') };
  }
  request.onProgress?.({ ratio: 0, stage: '准备' });
  if (request.format === 'mp4') return exportMp4(request);
  if (request.format === 'gif') return exportGif(request);
  if (request.format === 'png') return exportPngSequence(request);
  return exportWav(request);
}

/** 触发浏览器下载（导出完成后调用）。 */
export function downloadExport(output: ExportOutput): void {
  const url = URL.createObjectURL(output.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = output.filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
