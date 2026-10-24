/**
 * 素材导入管线：**探测 → 落 `Asset` → 注册预览源 → 缩略图**。
 *
 * ## 为什么单独抽出来
 *
 * 这条流程原来只写在 `ui/AssetPanel` 里（拖放 / 选文件两条入口共用）。
 * 一旦第二个地方也要导入文件（"给片段配一段音频"、"在播放头处插入音频"），
 * 就有两种做法：
 *
 * 1. 在那边再抄一遍 —— 抄漏一步就是**只有一处能用**：漏了 `registerPreviewSource`
 *    表现为"素材卡片有缩略图、上轨后黑屏"；漏了缩略图表现为"卡片永远是占位图"。
 * 2. 抽成一处 —— 两条入口天然一致。
 *
 * 选 2。这也是 2026-10-21 那条教训的延伸：**两个入口各写一份，迟早只有一份是对的**。
 *
 * ## 边界
 *
 * - 只做"文件 → 可用的 `Asset`"，**不碰 store、不进撤销栈**（导入不该被 Ctrl+Z 撤销，
 *   否则用户第一次撤销撤掉的是"导入"）；
 * - 缩略图失败**不影响素材可用性**（返回 `null`，卡片显示占位）；
 * - 持久化（`putHandle` / `putThumbnail`）留给调用方：那属于"素材栏的职责"，
 *   不是"导入一个文件"的职责。
 */
import type { Asset, Result, VEditorError } from '../core/types';
import { makeError } from '../core/types';
import type { FileHandlePort } from '../persist/autosave';
import { THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH, probeAsset } from './mediaProbe';
import { hashFileHead } from './fileHash';
import { registerPreviewSource } from './previewSource';

export interface ImportedMedia {
  asset: Asset;
  /** 缩略图 data URL（立刻显示用，不必等 IDB 写入）。 */
  thumbnailDataUrl: string | null;
  /** 缩略图 PNG（调用方决定是否写 IDB）。 */
  thumbnailBlob: Blob | null;
}

/** ImageBitmap → 指定尺寸的 canvas（缩略图两种产物的共同步骤）。 */
function thumbnailCanvas(bitmap: ImageBitmap): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas');
  canvas.width = THUMBNAIL_WIDTH;
  canvas.height = THUMBNAIL_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(bitmap, 0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
  return canvas;
}

/** ImageBitmap → 90×51 PNG Blob（写 IDB 用）。 */
export async function thumbnailToBlob(bitmap: ImageBitmap): Promise<Blob | null> {
  const canvas = thumbnailCanvas(bitmap);
  if (canvas === null) return null;
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
}

/** ImageBitmap → data URL（用于立刻显示）。 */
export function thumbnailToDataUrl(bitmap: ImageBitmap): string | null {
  return thumbnailCanvas(bitmap)?.toDataURL('image/png') ?? null;
}

/** 导入失败 → 可读错误（webm 与"变体不支持"分开说）。 */
export function mapImportError(error: VEditorError, fileName: string): VEditorError {
  if (error.code === 'E_UNSUPPORTED_CONTAINER') {
    // demuxWav 的非 PCM 拒绝文案是**给用户看的成品**（用户拍板），原样透传；
    // 其余容器错误才做"请转 mp4"的通用转述。
    if ((error.detail ?? '').includes('压缩格式') || error.message.includes('压缩格式')) {
      return makeError('E_UNSUPPORTED_CONTAINER', error.message, `${fileName}：${error.detail ?? ''}`);
    }
    const isWebm = (error.detail ?? '').includes('WebM');
    return makeError(
      'E_UNSUPPORTED_CONTAINER',
      isWebm ? '暂不支持该格式（WebM 将在 T19 提供），请转为 mp4' : '暂不支持该格式，请转为 mp4',
      `${fileName}：${error.detail ?? ''}`,
    );
  }
  if (error.code === 'E_UNSUPPORTED_VARIANT') {
    return makeError('E_UNSUPPORTED_VARIANT', '不支持该 MP4 变体', `${fileName}：${error.detail ?? ''}`);
  }
  return error;
}

/**
 * 探测一个文件并登记成可用的素材（含预览源注册）。
 *
 * 失败时**不留半个条目**：只有 `probeAsset` 成功才会返回 `ok`。
 */
export async function probeMediaFile(
  file: File,
  handle: FileHandlePort | null,
  /**
   * 指定素材 id（**重链**用）。
   *
   * 重链必须绑回**同一个** assetId：所有片段的 `assetId` 都指向它，
   * 换一个新 id 等于"工程里多了一个素材、旧片段还指着离线的那份"。
   */
  reuseAssetId?: string,
  /** 源路径（Electron 宿主 / 文件夹批量重链能提供）。 */
  sourcePath?: string | null,
): Promise<Result<ImportedMedia>> {
  const result = await probeAsset(file, reuseAssetId === undefined ? {} : { id: reuseAssetId });
  if (!result.ok) return { ok: false, error: mapImportError(result.error, file.name) };

  const probed = result.value;
  const assetId = probed.asset.id;
  /**
   * 内容指纹（前 1MB）。算不出来**不阻断导入**：老浏览器没有 `crypto.subtle` 时
   * 会退化成 FNV；两者都失败只意味着"批量重链少一个判据"，不该让导入失败。
   */
  const contentHash = await hashFileHead(file).catch(() => null);
  const asset: Asset = {
    ...probed.asset,
    // 有句柄才落 fs 模式；否则内存模式（关闭页面即失效，靠常驻警告条提示）
    handleRef: handle === null ? null : assetId,
    sourceMode: handle === null ? 'memory' : 'fs',
    status: handle === null ? 'memory' : 'ok',
    thumbnailRef: probed.thumbnail === null ? null : assetId,
    ...(contentHash === null ? {} : { contentHash }),
    ...(sourcePath === undefined || sourcePath === null ? {} : { sourcePath }),
  };
  // 登记预览源：让播放引擎能按样本索引解码出帧（不持久化，刷新后由 relink 重建）
  registerPreviewSource(assetId, file, probed.probe);

  let thumbnailDataUrl: string | null = null;
  let thumbnailBlob: Blob | null = null;
  if (probed.thumbnail !== null) {
    thumbnailDataUrl = thumbnailToDataUrl(probed.thumbnail);
    thumbnailBlob = await thumbnailToBlob(probed.thumbnail);
    probed.thumbnail.close();
  }
  return { ok: true, value: { asset, thumbnailDataUrl, thumbnailBlob } };
}
