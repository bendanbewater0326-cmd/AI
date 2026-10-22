/**
 * 代理媒体（R-052）：给 4K 级素材生成一份低分辨率副本，预览用它、导出用原片。
 *
 * ## 为什么需要"真代理"而不是"画小一点"
 *
 * 预览卡在 4K 上有两个成本：**解码**（4K H.264 一帧 12MB）与**合成**（纹理上传 + 混合）。
 * 只在合成阶段缩小，解码成本一分不少——真卡的时候仍然是卡。
 * 所以这里把整段素材重新编码成 ≤960px 的 MP4，解码和合成一起降下来。
 *
 * ## 三条硬约束
 *
 * 1. **只做视频轨 + 可选 AAC 音频轨**：代理要能替原片承担"预览取帧 + 预览取音频"两件事，
 *    否则换了源之后声音会消失（`decodeAudioRange` 读的就是注册时那份 probe 的音频样本表）。
 * 2. **不烘旋转**：手机竖拍的旋转由 `playbackEngine` 按 `asset.rotation` 统一施加，
 *    代理保持"存储朝向"即可，两边口径一致（烘进去反而会转两次）。
 * 3. **导出永远用原片**：代理是预览用的，分辨率/码率都降过，进成片就是画质事故。
 *    由 `previewSource` 的 `getExportSource/getExportProbe` 保证。
 */
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import type { Frame, MilliFps, Result } from '../core/types';
import { fail, makeError, ok } from '../core/types';
import { frameToUs, framesPerSecond, samplesToUs } from '../core/timebase';
import { createDecoderPool } from './decoderPool';
import type { Mp4ProbeResult } from './demuxMp4';
import { openMp4 } from './demuxMp4';
import type { BlobLike } from './demuxMp4';

/** 代理的最大宽度（高度按比例）。960 ≈ 540p，预览窗口够用且解码便宜。 */
export const PROXY_MAX_WIDTH = 960;
/** 触发代理的最小像素数：4K（3840×2160）的 80%，即 1080p 不触发、4K 触发。 */
export const PROXY_MIN_PIXELS = Math.round(3840 * 2160 * 0.8);

/** 代理视频码率（bps）：960px 宽、预览用，1.5Mbps 足够。 */
const PROXY_VIDEO_BITRATE = 1_500_000;
/** 代理音频码率。 */
const PROXY_AUDIO_BITRATE = 96_000;

/** 是否需要代理（只看显示尺寸，不看文件大小）。 */
export function needsProxy(asset: { width: number; height: number; kind: string }): boolean {
  if (asset.kind !== 'video') return false;
  const pixels = Math.max(0, asset.width) * Math.max(0, asset.height);
  return pixels >= PROXY_MIN_PIXELS;
}

/** 代理目标尺寸（偶数、保持宽高比、不放大）。 */
export function proxyTargetSize(width: number, height: number): { width: number; height: number } {
  const safeWidth = Math.max(2, Math.trunc(width));
  const safeHeight = Math.max(2, Math.trunc(height));
  // 按**长边**压：竖拍素材（存储 2160×3840）如果只按宽度压，会得到 960×1706，
  // 像素量仍是 1080p 级，等于没做代理
  const scale = Math.min(1, PROXY_MAX_WIDTH / Math.max(safeWidth, safeHeight));
  const targetWidth = Math.max(2, Math.round(safeWidth * scale));
  const targetHeight = Math.max(2, Math.round(safeHeight * scale));
  // 偶数尺寸：H.264 的 4:2:0 要求宽高都能被 2 整除
  return {
    width: targetWidth - (targetWidth % 2),
    height: targetHeight - (targetHeight % 2),
  };
}

export interface ProxyRequest {
  assetId: string;
  probe: Mp4ProbeResult;
  source: BlobLike;
  /** 素材帧率（毫帧率）。 */
  fpsMilli: MilliFps;
  /** 素材总帧数。 */
  durationFrames: Frame;
  /** 素材是否含音频（决定要不要转音频轨）。 */
  hasAudio: boolean;
  onProgress?: (ratio: number, stage: string) => void;
  signal?: AbortSignal;
}

export interface ProxyOutput {
  blob: Blob;
  probe: Mp4ProbeResult;
  width: number;
  height: number;
}

/** 挑一个 H.264 配置（代理尺寸小，baseline 就够）。 */
async function pickProxyConfig(width: number, height: number, fps: number): Promise<VideoEncoderConfig | null> {
  for (const codec of ['avc1.42001f', 'avc1.4d001f', 'avc1.64001f']) {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate: PROXY_VIDEO_BITRATE,
      framerate: fps,
      avc: { format: 'avc' },
      latencyMode: 'realtime',
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported === true) return config;
    } catch {
      // 换下一个 codec 字符串
    }
  }
  return null;
}

/**
 * 生成代理文件（视频 + 可选音频），返回可直接注册进解码器池的 Blob 与 probe。
 *
 * 解码用**独立的池**：不能借用预览池——生成期间预览还要正常播放，
 * 共用一个池会让两边互相淘汰帧缓存（本项目 1080p 黑屏就是这么来的）。
 */
export async function generateProxy(request: ProxyRequest): Promise<Result<ProxyOutput>> {
  const { probe, source, assetId } = request;
  const video = probe.video;
  if (video === null) return fail(makeError('E_DECODE_FAILED', '该素材没有视频轨，不需要代理', assetId));
  if (typeof VideoEncoder !== 'function') {
    return fail(makeError('E_DECODE_FAILED', '当前浏览器不支持视频编码，无法生成代理', assetId));
  }

  const target = proxyTargetSize(video.width, video.height);
  const fpsValue = Math.max(1, Math.round(framesPerSecond(request.fpsMilli)));
  const config = await pickProxyConfig(target.width, target.height, fpsValue);
  if (config === null) return fail(makeError('E_DECODE_FAILED', '浏览器没有可用的 H.264 编码器', assetId));

  const pool = createDecoderPool();
  pool.register(assetId, probe, source);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: target.width, height: target.height, frameRate: fpsValue },
    ...(request.hasAudio && probe.audio !== null
      ? { audio: { codec: 'aac' as const, numberOfChannels: 2, sampleRate: 48000 } }
      : {}),
    fastStart: 'in-memory',
  });

  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (error) => {
      throw error;
    },
  });
  encoder.configure(config);

  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (ctx === null) {
    encoder.close();
    await pool.dispose();
    return fail(makeError('E_DECODE_FAILED', '无法创建代理画布', assetId));
  }

  try {
    const frames = Math.max(1, request.durationFrames);
    for (let i = 0; i < frames; i += 1) {
      if (request.signal?.aborted === true) {
        encoder.close();
        return fail(makeError('E_DECODE_FAILED', '代理生成已取消', assetId));
      }
      const decoded = await pool.ensureFrame(assetId, i);
      if (!decoded.ok) {
        // 单帧失败不致命：跳过继续，代理少一帧比整段失败好
        continue;
      }
      const frame = decoded.value.frame;
      if (frame.displayWidth > 0 && frame.displayHeight > 0) {
        ctx.drawImage(frame, 0, 0, target.width, target.height);
        const videoFrame = new VideoFrame(canvas, {
          timestamp: frameToUs(i, request.fpsMilli),
          duration: frameToUs(1, request.fpsMilli),
        });
        encoder.encode(videoFrame, { keyFrame: i % fpsValue === 0 });
        videoFrame.close();
      }
      if (encoder.encodeQueueSize > 8) await new Promise((resolve) => setTimeout(resolve, 0));
      request.onProgress?.(0.05 + ((i + 1) / frames) * 0.75, `转码 ${i + 1}/${frames}`);
    }
    await encoder.flush();
  } catch (error) {
    encoder.close();
    await pool.dispose();
    return fail(
      makeError(
        'E_DECODE_FAILED',
        `代理生成失败：${error instanceof Error ? error.message : String(error)}`,
        assetId,
      ),
    );
  }

  // ---- 音频：整段解一次再按 1024 采样分块编码（与导出的 AAC 路径同口径）----
  const audio = probe.audio;
  if (request.hasAudio && audio !== null && audio.samples.length > 0) {
    request.onProgress?.(0.82, '转码音频');
    try {
      const decoded = await pool.decodeAudioRange(assetId, 0, audio.samples.length);
      if (decoded.ok && decoded.value.length > 0) {
        const audioEncoder = new AudioEncoder({
          output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
          error: (error) => {
            throw error;
          },
        });
        audioEncoder.configure({
          codec: 'mp4a.40.2',
          sampleRate: 48000,
          numberOfChannels: 2,
          bitrate: PROXY_AUDIO_BITRATE,
        });
        // 把 AudioData 拼成连续的立体声平面，再按 1024 采样切片（编码器要求的块大小）
        const total = decoded.value.reduce((sum, item) => sum + item.numberOfFrames, 0);
        const left = new Float32Array(total);
        const right = new Float32Array(total);
        let cursor = 0;
        for (const item of decoded.value) {
          const count = item.numberOfFrames;
          const planar = new Float32Array(count * item.numberOfChannels);
          item.copyTo(planar, { planeIndex: 0, format: 'f32-planar' });
          left.set(planar.subarray(0, count), cursor);
          if (item.numberOfChannels > 1) {
            const second = new Float32Array(count);
            item.copyTo(second, { planeIndex: 1, format: 'f32-planar' });
            right.set(second, cursor);
          } else {
            right.set(planar.subarray(0, count), cursor);
          }
          cursor += count;
          item.close();
        }
        const chunkSamples = 1024;
        for (let offset = 0; offset < total; offset += chunkSamples) {
          const count = Math.min(chunkSamples, total - offset);
          const planar = new Float32Array(count * 2);
          planar.set(left.subarray(offset, offset + count), 0);
          planar.set(right.subarray(offset, offset + count), count);
          const data = new AudioData({
            format: 'f32-planar',
            sampleRate: 48000,
            numberOfFrames: count,
            numberOfChannels: 2,
            timestamp: samplesToUs(offset, 48000),
            data: planar,
          });
          audioEncoder.encode(data);
          data.close();
        }
        await audioEncoder.flush();
        audioEncoder.close();
      }
    } catch {
      // 音频失败不丢视频：代理仍可用，只是预览没声音（比整段失败好）
    }
  }

  request.onProgress?.(0.9, '封装');
  muxer.finalize();
  const buffer = muxer.target.buffer;
  const blob = new Blob([buffer], { type: 'video/mp4' });
  request.onProgress?.(0.93, '释放解码器');
  await pool.dispose();
  request.onProgress?.(0.96, '自检代理文件');

  const probed = await openMp4(blob);
  if (!probed.ok) {
    return fail(makeError('E_DECODE_FAILED', '代理文件自检失败（无法解析）', probed.error.message));
  }
  request.onProgress?.(1, '完成');
  return ok({
    blob,
    probe: probed.value,
    width: target.width,
    height: target.height,
  });
}
