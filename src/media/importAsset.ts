/**
 * 素材导入的唯一实现（R-002 / R-054）。
 *
 * 三条路径共用：`?src=` 自动导入、素材栏拖拽/选择、工程文件迁入后的**素材重连**。
 *
 * 为什么必须只有一份：这段逻辑里有四个容易漏的步骤——
 * ① R-001 首个素材跟随参数、② 自动上 V1、③ 缩略图落 IDB 并 notify、④ 重连时不新建素材。
 * 任何一条路径单独实现都会漏掉其中几步（历史上 `?src=` 就漏过 ①③，表现为"参数没跟随/缩略图空白"）。
 */
import type { Result } from '../core/types';
import { createClip, ok } from '../core/types';
import { projectSpanFrames, secondsToFrames } from '../core/timebase';
import { store } from '../core/store';
import { applyFirstAssetParams } from '../core/operations';
import { THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH, probeAsset } from './mediaProbe';
import { registerPreviewSource } from './previewSource';
import { putThumbnail } from '../persist/autosave';
import { hashFileHead } from './fileHash';
import { cacheFileName, enqueueCacheWrite } from './draftCache';

/* ---------------- 导入素材（?src= 与 loadSource 共用） ---------------- */

/**
 * 导入一份素材；`assetId` 非空 = **重连**（R-054）。
 *
 * 重连语义：把字节绑回**已有**素材 id（工程 JSON 里只有元数据、没有字节），
 * 不新建素材、不自动上轨——时间线上本来就有片段引用它，新建会得到一份孤立副本。
 */
export async function importAssetFile(file: File, assetId?: string): Promise<Result<string>> {
  /**
   * **重连**（`assetId` 非空）走 `relink`，不要在这里再写一遍。
   *
   * 两条路径的差别是实打实的：这里写 `sourceMode: 'memory'` + `handleRef: null`，
   * 于是"重连成功 → 刷新 → 又离线"。`relinkAssetFromFile` 会保留/写入句柄、
   * 写缩略图、清解码缓存并立刻重绘 —— 一份实现，宿主注入与素材栏行为一致。
   */
  if (assetId !== undefined) {
    const { relinkAssetFromFile } = await import('./relink');
    const relinked = await relinkAssetFromFile({ assetId, file, handle: null });
    return relinked.ok ? ok(assetId) : relinked;
  }
  const result = await probeAsset(file, {});
  if (!result.ok) return result;
  const probed = result.value;
  const id = probed.asset.id;
  const asset = {
    ...probed.asset,
    handleRef: null,
    sourceMode: 'memory' as const,
    status: 'memory' as const,
    thumbnailRef: probed.thumbnail ? id : null,
  };
  const reconnect = store.getDoc().assets.some((candidate) => candidate.id === id);
  if (reconnect) {
    store.updateAsset(id, asset);
  } else {
    // R-001：?src= 路径同样要跟随首个素材参数（早期只有素材栏实现，两条导入路径行为不一致）
    applyFirstAssetParams(store, asset);
    store.addAsset(asset);
  }
  registerPreviewSource(id, file, probed.probe);

  // 自动上 V1（startFrame=0）：复用 AssetPanel.addToTimeline 的换算口径。
  // 重连场景跳过：工程里已经有引用这个素材的片段了。
  const doc = store.getDoc();
  const v1 = doc.tracks.find((track) => track.id === 'trk_V1');
  if (!reconnect && v1 !== undefined && probed.asset.kind !== 'audio') {
    const span = probed.asset.durationFrames ?? secondsToFrames(probed.asset.durationSec, probed.asset.fpsMilli);
    if (Number.isFinite(span) && span >= 1) {
      const clip = createClip({
        assetId: id,
        trackId: v1.id,
        startFrame: 0,
        inFrame: 0,
        outFrame: span,
        durationFrames: projectSpanFrames(span, probed.asset.fpsMilli, doc.fpsMilli),
      });
      store.dispatch([{ op: 'addClip', clip }], '导入素材');
    }
  }

  /**
   * 后台写入本地草稿缓存（与素材栏导入走同一条路）。
   *
   * `?src=` 也是"导入过一次"，理应享受同样的保命能力；
   * 但它是 URL 来的，没有源路径 → 宿主后端写不了，OPFS 后端可以。
   * 失败不报错（缓存是锦上添花）。
   */
  {
    const contentHash = await hashFileHead(file).catch(() => null);
    if (contentHash !== null) {
      store.updateAsset(id, { contentHash });
      enqueueCacheWrite(file, contentHash, file.name, (ok) => {
        if (ok) store.updateAsset(id, { cacheKey: cacheFileName(contentHash, file.name) });
      });
    }
  }

  // 缩略图落 IDB：素材栏的懒加载只认 IDB，不落盘就会显示"…"占位
  // （素材栏导入路径有这一步，?src= 路径曾经漏掉，表现为"用 ?src= 打开时缩略图空白"）
  if (probed.thumbnail) {
    const canvas = document.createElement('canvas');
    canvas.width = THUMBNAIL_WIDTH;
    canvas.height = THUMBNAIL_HEIGHT;
    const ctx = canvas.getContext('2d');
    if (ctx !== null) {
      ctx.drawImage(probed.thumbnail, 0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
      canvas.toBlob((blob) => {
        if (blob === null) return;
        // 写完后 notify 一次：素材栏的懒加载只在 doc 变化时重试，
        // 不 notify 会停在"…"占位（?src= 路径的经典时序坑）
        void putThumbnail(id, blob).then(() => {
          store.updateAsset(id, { thumbnailRef: id });
        });
      }, 'image/png');
    }
    probed.thumbnail.close();
  }
  return ok(id);
}

