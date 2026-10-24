/**
 * 素材探测 + 首帧缩略图 + 容器判定（架构 §3 文件 17 / §5.7 / §8.5，task:T05）。
 *
 * 职责边界：
 *   - **容器判定**：按文件头识别 mp4 / webm / 其它；webm 只识别不解析（T19 才解析）。
 *   - **探测**：mp4 交给 `demuxMp4.openMp4`，把 `MediaProbeResult` 落成 doc 内的 `Asset`。
 *   - **缩略图**：**从解码后的首帧生成**（禁止占位色块），`VideoFrame` → `OffscreenCanvas`
 *     → 90×51 → `transferToImageBitmap()` → `close()` 释放。
 *
 * 两条设计约束：
 *   1. 缩略图解码器**可注入**（`ThumbnailDecoder`）：`demuxMp4` 与 `probeAsset` 的元信息部分
 *      必须能在 Node 单测里跑（Node 无 WebCodecs）；只有默认实现触碰 `VideoDecoder`。
 *   2. 缩略图失败**不影响素材可用性**：捕获后返回 `null`，由 UI 显示占位图（不是半成品素材）。
 *
 * 本模块不做任何帧↔时间换算：时长来自 `openMp4` 的 `durationSec`（容器 timescale），
 * 帧数来自样本索引长度（架构 §5.7 / 时基唯一换算点 `core/timebase.ts`）。
 */

import type {
  Asset,
  AssetKind,
  Frame,
  MediaProbeResult,
  MilliFps,
  Result,
} from '../core/types';
import { createAsset, DEFAULT_FPS_MILLI, makeError } from '../core/types';
import { framesPerSecond } from '../core/timebase';
import type { BlobLike, Mp4ProbeResult } from './demuxMp4';
import { openMp4, readBlobBytes, readSample } from './demuxMp4';
import type { WebmProbeResult } from './demuxWebm';
import { openMp3 } from './demuxMp3';
import { openWav } from './demuxWav';
import { openWebm } from './demuxWebm';

/** 素材卡片缩略图尺寸（架构 §3 `ui/AssetPanel` 素材网格 90×51）。 */
export const THUMBNAIL_WIDTH = 90;
export const THUMBNAIL_HEIGHT = 51;

/** 探测输入：`File` 的结构化子集（Node 单测可注入分块读实现）。 */
export interface ProbeFile extends BlobLike {
  readonly name: string;
  /** 内存模式无 mtime 时为 0。 */
  readonly lastModified?: number;
}

/** 容器判定结果。 */
export type ContainerKind = 'mp4' | 'webm' | 'wav' | 'mp3' | 'unknown';

/** 缩略图解码输入：首样本 + 解码器配置。 */
export interface ThumbnailDecodeInput {
  /** RFC 6381 codec（`avc1.640028` / `hvc1.1.6.L93.B0`）。 */
  codec: string;
  /** `avcC` / `hvcC` 记录字节。 */
  description: Uint8Array | null;
  codedWidth: number;
  codedHeight: number;
  /** 首样本原始字节（AVCC 长度前缀格式）。 */
  data: Uint8Array;
  timestampUs: number;
  /** 次样本与其 PTS 差；只有一个样本时为 null。 */
  durationUs: number | null;
}

/**
 * 缩略图解码器端口。
 *
 * 默认实现走 `WebCodecs`；测试可注入假实现（返回手工 `ImageBitmap` 或 null）。
 * `available === false` 时调用方直接跳过缩略图，不去尝试解码。
 */
export interface ThumbnailDecoder {
  readonly available: boolean;
  decode(input: ThumbnailDecodeInput): Promise<ImageBitmap | null>;
}

/** 探测产出：可直接写入 doc 的 `Asset` + 缩略图 + 原始探测结果。 */
export interface ProbedAsset {
  /** 已填好全部探测字段；`thumbnailRef` 由调用方在写 IDB 后回填。 */
  asset: Asset;
  /** 90×51 首帧缩略图；解码不可用或失败时为 null（**不是**色块占位）。 */
  thumbnail: ImageBitmap | null;
  probe: MediaProbeResult;
  /** 校验用时长（秒），不参与剪辑运算。 */
  durationSec: number;
}

/** 探测选项。 */
export interface ProbeOptions {
  /** 缩略图解码器；`null` = 跳过缩略图（批量后台预探测）。默认 WebCodecs 实现。 */
  thumbnailDecoder?: ThumbnailDecoder | null;
  /** 指定素材 id（默认自动生成）。 */
  id?: string;
}

/** 嗅探所需的最大头长度。 */
const SNIFF_BYTES = 16;

/** EBML 魔数（webm / mkv 共用）。 */
function isEbml(head: Uint8Array): boolean {
  return head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
}

/** 左上角 fourcc 是否为给定值。 */
function textAt(head: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let index = offset; index < offset + length && index < head.byteLength; index += 1) {
    out += String.fromCharCode(head[index] ?? 0);
  }
  return out;
}

function hasFourccAt(head: Uint8Array, offset: number, text: string): boolean {
  if (head.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (head[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * 容器嗅探（只读前 16 字节）。
 *
 * webm 的判定依据是 EBML 魔数 `1A 45 DF A3`；mp4 依据 `ftyp` / `moov` / `mdat` 四cc。
 */
export async function sniffContainer(source: BlobLike): Promise<ContainerKind> {
  const head = await readBlobBytes(source, 0, Math.min(source.size, SNIFF_BYTES));
  if (isEbml(head)) return 'webm';
  // WAV：RIFF + WAVE（8/12 字节）
  if (head.byteLength >= 12 && textAt(head, 0, 4) === 'RIFF' && textAt(head, 8, 4) === 'WAVE') return 'wav';
  // MP3：ID3v2 头 或 MPEG 帧同步字（0xFFE）
  if (head.byteLength >= 3 && textAt(head, 0, 3) === 'ID3') return 'mp3';
  if (head.byteLength >= 2 && (head[0] ?? 0) === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0) return 'mp3';
  if (hasFourccAt(head, 4, 'ftyp') || hasFourccAt(head, 4, 'styp')) return 'mp4';
  if (hasFourccAt(head, 4, 'moov') || hasFourccAt(head, 4, 'mdat') || hasFourccAt(head, 4, 'free')) return 'mp4';
  return 'unknown';
}

/** 把 `bytes` 画到 90×51 的 OffscreenCanvas 并产出 ImageBitmap（所有权立即转移给调用方）。 */
function rasterizeThumbnail(frame: VideoFrame): ImageBitmap | null {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const canvas = new OffscreenCanvas(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
  const context = canvas.getContext('2d');
  if (context === null) return null;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  // 直接绘制到 90×51：等价于 area 平均缩放，与 `ref_000.png` 的比对口径一致
  context.drawImage(frame, 0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
  return canvas.transferToImageBitmap();
}

/**
 * 默认缩略图解码器（WebCodecs）。
 *
 * 只解码**首样本**（首帧必须是关键帧，否则单帧解码不可能成立，直接返回 null 而不是猜帧）。
 * 任何异常 / 不支持的配置都返回 null —— 探测流程不允许因缩略图失败而整体失败。
 */
export function createWebCodecsThumbnailDecoder(): ThumbnailDecoder {
  const supported =
    typeof VideoDecoder !== 'undefined' && typeof OffscreenCanvas !== 'undefined';

  return {
    available: supported,
    async decode(input: ThumbnailDecodeInput): Promise<ImageBitmap | null> {
      if (!supported) return null;
      if (input.codec.length === 0) return null;

      const config: VideoDecoderConfig = {
        codec: input.codec,
        codedWidth: input.codedWidth,
        codedHeight: input.codedHeight,
        optimizeForLatency: true,
      };
      if (input.description !== null) config.description = input.description;

      const support = await VideoDecoder.isConfigSupported(config);
      if (support.supported !== true) return null;

      let decoder: VideoDecoder | null = null;
      try {
        const firstFrame = await new Promise<VideoFrame | null>((resolve, rejectDecode) => {
          let settled = false;
          decoder = new VideoDecoder({
            output: (frame: VideoFrame) => {
              if (settled) {
                frame.close();
                return;
              }
              settled = true;
              resolve(frame);
            },
            error: (decodeError: DOMException) => {
              if (settled) return;
              settled = true;
              rejectDecode(decodeError);
            },
          });
          decoder.configure(config);
          const chunkInit: EncodedVideoChunkInit = {
            type: 'key',
            timestamp: input.timestampUs,
            data: input.data,
          };
          if (input.durationUs !== null) chunkInit.duration = input.durationUs;
          decoder.decode(new EncodedVideoChunk(chunkInit));
          // 没有输出帧（例如样本损坏）时收尾，避免 Promise 永久挂起
          void decoder
            .flush()
            .then(() => {
              if (settled) return;
              settled = true;
              resolve(null);
            })
            .catch(() => {
              if (settled) return;
              settled = true;
              resolve(null);
            });
        });
        if (firstFrame === null) return null;
        try {
          return rasterizeThumbnail(firstFrame);
        } finally {
          firstFrame.close();
        }
      } catch {
        return null;
      } finally {
        if (decoder !== null) {
          const session: VideoDecoder = decoder;
          if (session.state !== 'closed') session.close();
        }
      }
    },
  };
}

/** 进程级默认解码器（WebCodecs 不可用时 `available === false`）。 */
export const webCodecsThumbnailDecoder: ThumbnailDecoder = createWebCodecsThumbnailDecoder();

/** 取首样本字节并交给解码器（只 slice 该样本，不整片读）。 */
async function decodeFirstFrame(
  file: BlobLike,
  probe: Mp4ProbeResult | WebmProbeResult,
  decoder: ThumbnailDecoder,
): Promise<ImageBitmap | null> {
  const first = probe.samples[0];
  if (first === undefined) return null;
  // 首样本不是关键帧 ⇒ 无法单帧解码（正常 mp4 不会出现，防御性返回 null）
  if (!first.isKey) return null;
  const data = await readSample(file, first);
  const second = probe.samples[1];
  const durationUs = second === undefined ? null : Math.max(0, second.ptsUs - first.ptsUs);
  return decoder.decode({
    codec: probe.videoCodec ?? '',
    description: probe.video === null ? null : probe.video.description,
    codedWidth: probe.width ?? 0,
    codedHeight: probe.height ?? 0,
    data,
    timestampUs: first.ptsUs,
    durationUs,
  });
}

/**
 * 探测素材（架构 §6.1 步骤 4）。
 *
 * - mp4：完整解析 + 首帧缩略图；
 * - webm：**识别容器但不解析**，返回 `E_UNSUPPORTED_CONTAINER`（detail 指明 T19）。
 *   注意：这里**不返回** `exactSeek: false` —— webm 最终必须帧精确，旧口径已废除。
 * - 其它容器：`E_UNSUPPORTED_CONTAINER`。
 *
 * 本函数不检查去重（R-003 的 hashKey 只在这里生成，查重由调用方 `AssetPanel` 做）。
 */
export async function probeAsset(file: ProbeFile, options: ProbeOptions = {}): Promise<Result<ProbedAsset>> {
  if (file.size <= 0) {
    return {
      ok: false,
      error: makeError('E_UNSUPPORTED_CONTAINER', '无法识别的容器', `文件为空: ${file.name}`),
    };
  }

  const container = await sniffContainer(file);
  if (container === 'webm') {
    // T19：webm 走独立 demuxer，但输出契约与 mp4 完全一致（container:'webm'）
    const openedWebm = await openWebm(file);
    if (!openedWebm.ok) return { ok: false, error: openedWebm.error };
    const webmProbe = openedWebm.value;
    const webmDecoder =
      options.thumbnailDecoder === undefined ? webCodecsThumbnailDecoder : options.thumbnailDecoder;
    let webmThumb: ImageBitmap | null = null;
    if (webmDecoder !== null && webmDecoder.available && webmProbe.hasVideo && webmProbe.samples.length > 0) {
      try {
        webmThumb = await decodeFirstFrame(file, webmProbe, webmDecoder);
      } catch {
        webmThumb = null;
      }
    }
    const webmFps = webmProbe.fpsMilli === null ? DEFAULT_FPS_MILLI : webmProbe.fpsMilli;
    // durationSec：优先 Info/Duration（毫秒），否则用帧数 ÷ 帧率
    const webmDurationSec =
      webmProbe.durationMs !== null
        ? webmProbe.durationMs / 1000
        : (webmProbe.durationFrames ?? 0) / Math.max(1, framesPerSecond(webmFps));
    const webmAsset = createAsset({
      ...(options.id === undefined ? {} : { id: options.id }),
      name: file.name,
      kind: webmProbe.hasVideo ? 'video' : 'audio',
      handleRef: null,
      sourceMode: 'memory',
      status: 'memory',
      fpsMilli: webmFps,
      durationFrames: webmProbe.durationFrames,
      durationSec: webmDurationSec,
      ...(webmProbe.sampleRate === null ? {} : { sampleRate: webmProbe.sampleRate }),
      ...(webmProbe.channels === null ? {} : { channels: webmProbe.channels }),
      width: webmProbe.width ?? 0,
      height: webmProbe.height ?? 0,
      hasAudio: webmProbe.hasAudio,
      thumbnailRef: null,
      container: 'webm',
      codecVideo: webmProbe.videoCodec,
      codecAudio: webmProbe.audioCodec,
      rotation: 0,
      exactSeek: true,
      hashKey: `${file.name}|${file.size}|${file.lastModified ?? 0}`,
    });
    return {
      ok: true,
      value: {
        asset: webmAsset,
        thumbnail: webmThumb,
        probe: webmProbe,
        durationSec: webmDurationSec,
      },
    };
  }
  if (container === 'mp3') {
    const opened = await openMp3(file);
    if (!opened.ok) return { ok: false, error: opened.error };
    // 与 WAV 同款收窄（container 'mp3' 不在 MediaProbeResult 联合里，core/types 零改动）
    const mp3Probe = opened.value as unknown as Mp4ProbeResult;
    const mp3Fps: MilliFps = mp3Probe.fpsMilli === null ? DEFAULT_FPS_MILLI : mp3Probe.fpsMilli;
    const asset = createAsset({
      ...(options.id === undefined ? {} : { id: options.id }),
      name: file.name,
      kind: 'audio',
      handleRef: null,
      sourceMode: 'memory',
      status: 'memory',
      fpsMilli: mp3Fps,
      durationFrames: mp3Probe.durationFrames,
      durationSec: mp3Probe.durationSec,
      ...(mp3Probe.sampleRate === null ? {} : { sampleRate: mp3Probe.sampleRate }),
      ...(mp3Probe.channels === null ? {} : { channels: mp3Probe.channels }),
      width: 0,
      height: 0,
      hasAudio: true,
      thumbnailRef: null,
      container: 'unknown',
      codecVideo: null,
      codecAudio: mp3Probe.audioCodec,
      rotation: 0,
      exactSeek: true,
      hashKey: `${file.name}|${file.size}|${file.lastModified ?? 0}`,
    });
    return {
      ok: true,
      value: { asset, thumbnail: null, probe: mp3Probe, durationSec: mp3Probe.durationSec },
    };
  }
  if (container === 'wav') {
    const opened = await openWav(file);
    if (!opened.ok) return { ok: false, error: opened.error };
    // 契约说明：WAV probe 与 mp4/webm probe 同构，但 container 不在 MediaProbeResult
    // 的字面量联合里（core/types 零改动的边界决策）——在此收窄为既有类型
    //（previewSource/decoderPool 的边界本来就有同款 `as Mp4ProbeResult` 转型先例）。
    const wavProbe = opened.value as unknown as Mp4ProbeResult;
    const wavFps: MilliFps = wavProbe.fpsMilli === null ? DEFAULT_FPS_MILLI : wavProbe.fpsMilli;
    const asset = createAsset({
      ...(options.id === undefined ? {} : { id: options.id }),
      name: file.name,
      kind: 'audio',
      handleRef: null,
      sourceMode: 'memory',
      status: 'memory',
      fpsMilli: wavFps,
      durationFrames: wavProbe.durationFrames,
      durationSec: wavProbe.durationSec,
      ...(wavProbe.sampleRate === null ? {} : { sampleRate: wavProbe.sampleRate }),
      ...(wavProbe.channels === null ? {} : { channels: wavProbe.channels }),
      width: 0,
      height: 0,
      hasAudio: true,
      thumbnailRef: null,
      // 'unknown' = 非 mp4/webm 容器（Asset.container 联合里已有的值，零 core 改动）
      container: 'unknown',
      codecVideo: null,
      codecAudio: wavProbe.audioCodec,
      rotation: 0,
      exactSeek: true,
      hashKey: `${file.name}|${file.size}|${file.lastModified ?? 0}`,
    });
    return {
      ok: true,
      value: { asset, thumbnail: null, probe: wavProbe, durationSec: wavProbe.durationSec },
    };
  }
  if (container === 'unknown') {
    return {
      ok: false,
      error: makeError(
        'E_UNSUPPORTED_CONTAINER',
        '暂不支持该容器，请转为 mp4 或 webm',
        `文件: ${file.name}`,
      ),
    };
  }

  const opened = await openMp4(file);
  if (!opened.ok) {
    return { ok: false, error: opened.error };
  }
  const probe: Mp4ProbeResult = opened.value;

  // 缩略图：只有真能解码时才做，失败静默降级为 null（不产生半成品素材）
  const decoder =
    options.thumbnailDecoder === undefined ? webCodecsThumbnailDecoder : options.thumbnailDecoder;
  let thumbnail: ImageBitmap | null = null;
  if (decoder !== null && decoder.available && probe.hasVideo && probe.samples.length > 0) {
    try {
      thumbnail = await decodeFirstFrame(file, probe, decoder);
    } catch {
      thumbnail = null;
    }
  }

  const kind: AssetKind = probe.hasVideo ? 'video' : 'audio';
  const displayRotation = probe.video?.rotation ?? 0;
  const rotation90 = displayRotation === 90 || displayRotation === 270;
  const fpsMilli: MilliFps = probe.fpsMilli === null ? DEFAULT_FPS_MILLI : probe.fpsMilli;
  const durationFrames: Frame | null = probe.durationFrames;

  const asset = createAsset({
    ...(options.id === undefined ? {} : { id: options.id }),
    name: file.name,
    kind,
    handleRef: null,
    sourceMode: 'memory',
    status: 'memory',
    fpsMilli,
    durationFrames,
    durationSec: probe.durationSec,
    ...(probe.sampleRate === null ? {} : { sampleRate: probe.sampleRate }),
    ...(probe.channels === null ? {} : { channels: probe.channels }),
    // Asset 的 width/height 是**显示尺寸**：旋转 90/270 时宽高要交换
    // （编码尺寸在 probe.video.width/height，那个绝不能动——解码器按它配置）
    ...(rotation90 ? { width: probe.height ?? 0, height: probe.width ?? 0 } : { width: probe.width ?? 0, height: probe.height ?? 0 }),
    hasAudio: probe.hasAudio,
    thumbnailRef: null,
    container: 'mp4',
    codecVideo: probe.videoCodec,
    codecAudio: probe.audioCodec,
    // 手机竖拍：tkhd 矩阵要求显示时旋转。存进 Asset 供渲染层应用（WebCodecs 不解旋转）
    rotation: displayRotation,
    exactSeek: probe.exactSeek,
    hashKey: `${file.name}|${file.size}|${file.lastModified ?? 0}`,
  });

  return {
    ok: true,
    value: {
      asset,
      thumbnail,
      probe,
      durationSec: probe.durationSec,
    },
  };
}
