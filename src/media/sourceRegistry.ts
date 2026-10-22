/**
 * 把工程里用到的素材源注册进解码器池。
 *
 * ## 为什么单独一个文件
 *
 * 导出（`export/exporter.ts`）与粗剪分析（`ai/roughCut.ts`）都要"新开一个池、再把素材灌进去"。
 * 这段逻辑之前是 exporter 的私有函数，粗剪要用就得抄一遍——而**漏掉注册的表现是静默失败**：
 * `decodeAudioRange` 一路返回 `E_ASSET_OFFLINE`，导出成片"视频正常、没有音轨"，
 * 粗剪则"分析出全是静音，把整条时间线剪没了"。同一个坑不能有两个入口。
 */
import type { Project } from '../core/types';
import type { DecoderPool } from './decoderPool';
import type { Mp4ProbeResult } from './demuxMp4';
import { getExportProbe, getExportSource } from './previewSource';

/**
 * 注册工程内所有可用素材源，返回成功注册的数量。
 *
 * mp4 与 webm 都要注册：T19 起 webm 是帧精确源，若在这里按 container 过滤，
 * 会出现"webm 能剪能预览、导出时画面与声音一起消失"的静默失败。
 */
export function registerProjectSources(pool: DecoderPool, doc: Project): number {
  let count = 0;
  for (const asset of doc.assets) {
    // **必须用原片**：代理是降分辨率的，进了成片就是画质事故（R-052）
    const source = getExportSource(asset.id);
    const probe = getExportProbe(asset.id);
    if (source === undefined || probe === undefined) continue;
    if (probe.container !== 'mp4' && probe.container !== 'webm') continue;
    pool.register(asset.id, probe as Mp4ProbeResult, source.source);
    count += 1;
  }
  return count;
}
