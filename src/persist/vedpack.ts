/**
 * `.vedpack` 工程打包（2026-10-24）：工程 JSON + **素材字节** → 单文件 ZIP（store）。
 *
 * ## 与 `.vedproj` 的分工（并行不替代）
 *
 * `.vedproj`：纯元数据，轻、可 diff、素材待重连（R-054 的定位不变）。
 * `.vedpack`：自包含——跨设备迁移/分享场景，拖入即完整恢复。
 *
 * ## 链路复用（不新增第二套素材规则）
 *
 * - 字节收集：与自动恢复同序——内存源 → 草稿缓存池 → 句柄（`readCachedAsset` /
 *   `handleRef.getFile`）；
 * - 恢复：包内 `project.json` 走 `.vedproj` 的 `parseProjectFile`；素材字节走
 *   `relinkAssetFromFile({ assetId, file })`（与 `restoreFromCache` 同一条路）。
 *
 * ## 缺失降级（用户拍板）
 *
 * 三个来源都拿不到字节的素材**不进包**（清单标 `missing: true`），包永远可导出；
 * 导入后这些素材走既有五层恢复 + 手动重链。
 *
 * ## 规模边界（用户拍板）
 *
 * store ZIP 全内存组装：导出前算总大小，**>500MB 调用方弹确认，>4GB 可读拒绝**
 * （ZIP64 不做）。数值常量在这里，UI 层引用同一份。
 */
import type { Asset, Project, Result } from '../core/types';
import { fail, makeError, ok } from '../core/types';
import { createZip, unzipStore } from '../export/zip';
import { serializeProjectFile } from './projectFile';
import { readCachedAsset } from '../media/draftCache';

/** 导出前弹确认的阈值（字节）。 */
export const VEDPACK_CONFIRM_BYTES = 500 * 1024 * 1024;
/** 硬上限（store ZIP 无 ZIP64 的 4GB 物理边界）。 */
export const VEDPACK_MAX_BYTES = 4 * 1024 * 1024 * 1024;

export const VEDPACK_FORMAT = 'veditor-pack';
export const VEDPACK_VERSION = 1;
export const VEDPACK_EXT = 'vedpack';

/** 包内清单。 */
export interface VedpackManifest {
  format: typeof VEDPACK_FORMAT;
  version: number;
  exportedAt: number;
  /** assetId → 包内路径与状态。 */
  entries: Record<string, { path: string; name: string; size: number; missing?: boolean }>;
}

/* ---------------- 字节收集（三层来源，与自动恢复同序） ---------------- */

/** 素材字节的三层来源端口（可注入，Node 单测用）。 */
export interface AssetBytesSource {
  /** 内存源（previewSource 注册的 Blob/File）。 */
  readMemory?: (assetId: string) => Promise<Blob | null>;
  /** 草稿缓存池。 */
  readCache?: (assetId: string, cacheKey: string | null | undefined, name: string) => Promise<File | null>;
  /** 文件句柄（FileSystemFileHandle.getFile()）。 */
  readHandle?: (assetId: string) => Promise<File | null>;
}

/** 默认实现：接真实的 previewSource / draftCache / IDB 句柄（动态 import，Node 测试不拉起）。 */
export function defaultAssetBytesSource(): AssetBytesSource {
  return {
    async readMemory(assetId) {
      const { getPreviewSource } = await import('../media/previewSource');
      const entry = getPreviewSource(assetId);
      if (entry === undefined) return null;
      // BlobLike 的 slice 足够构 File；内存源大多是 File 本身
      const source = entry.source;
      return new File([source as BlobPart], 'source', { type: 'application/octet-stream' });
    },
    async readCache(assetId, cacheKey, name) {
      void assetId;
      if (cacheKey === null || cacheKey === undefined || cacheKey === '') return null;
      return readCachedAsset(cacheKey, name).catch(() => null);
    },
    async readHandle(assetId) {
      const { getHandle } = await import('../persist/autosave');
      const stored = await getHandle(assetId).catch(() => null);
      const handle = stored !== null && stored.ok ? stored.value : null;
      if (handle === null || typeof (handle as { getFile?: unknown }).getFile !== 'function') return null;
      return (handle as FileSystemFileHandle).getFile().catch(() => null);
    },
  };
}

export interface CollectedAsset {
  assetId: string;
  name: string;
  file: File | null;
  size: number;
}

/** 逐素材收集字节（三层来源按序尝试）；返回每个素材的字节（或 null = 缺失）。 */
export async function collectAssetBytes(
  assets: readonly Asset[],
  source: AssetBytesSource = defaultAssetBytesSource(),
): Promise<CollectedAsset[]> {
  const out: CollectedAsset[] = [];
  for (const asset of assets) {
    let file: File | null = null;
    try {
      const memory = await source.readMemory?.(asset.id);
      if (memory !== null && memory !== undefined) {
        file = new File([memory], asset.name, { type: memory.type });
      }
    } catch {
      file = null;
    }
    if (file === null) {
      try {
        file = (await source.readCache?.(asset.id, asset.cacheKey, asset.name)) ?? null;
      } catch {
        file = null;
      }
    }
    if (file === null) {
      try {
        file = (await source.readHandle?.(asset.id)) ?? null;
      } catch {
        file = null;
      }
    }
    out.push({ assetId: asset.id, name: asset.name, file, size: file === null ? 0 : file.size });
  }
  return out;
}

/* ---------------- 打包 ---------------- */

export interface BuildVedpackOptions {
  now?: number;
  /** 字节来源（默认三层）。 */
  source?: AssetBytesSource;
}

export interface VedpackBuild {
  blob: Blob;
  manifest: VedpackManifest;
  /** 缺失素材的名字（提示用）。 */
  missingNames: string[];
  totalBytes: number;
}

/** 工程名 → 包文件名。 */
export function vedpackFileName(doc: Project): string {
  const base = doc.name.trim().replace(/[\\\\/:*?"<>|]+/g, '_') || 'veditor';
  return `${base}.${VEDPACK_EXT}`;
}

/**
 * 组装 .vedpack（store ZIP）。**不下载**——Blob 交给调用方（UI 决定下载/确认）。
 * 超过 `VEDPACK_MAX_BYTES` 可读拒绝（ZIP64 不做）。
 */
export async function buildVedpack(doc: Project, options: BuildVedpackOptions = {}): Promise<Result<VedpackBuild>> {
  const now = options.now ?? Date.now();
  const collected = await collectAssetBytes(doc.assets, options.source);

  let totalBytes = 0;
  const missingNames: string[] = [];
  const manifest: VedpackManifest = { format: VEDPACK_FORMAT, version: VEDPACK_VERSION, exportedAt: now, entries: {} };

  for (const item of collected) {
    if (item.file === null) {
      manifest.entries[item.assetId] = { path: '', name: item.name, size: 0, missing: true };
      missingNames.push(item.name);
      continue;
    }
    const path = `assets/${item.assetId}/${item.name}`;
    manifest.entries[item.assetId] = { path, name: item.name, size: item.size };
    totalBytes += item.size;
  }
  if (totalBytes > VEDPACK_MAX_BYTES) {
    return fail(
      makeError(
        'E_QUOTA_EXCEEDED',
        `工程素材合计 ${(totalBytes / 1024 / 1024 / 1024).toFixed(1)}GB，超过单包 4GB 上限`,
        '建议拆分工程，或使用「导出工程文件」（不含素材）',
      ),
    );
  }

  // 素材字节进内存（store ZIP 的物理现实：createZip 一次性分配）
  const encoder = new TextEncoder();
  const assetEntries: Array<{ name: string; data: Uint8Array }> = [];
  for (const item of collected) {
    if (item.file === null) continue;
    const buffer = await item.file.arrayBuffer();
    assetEntries.push({
      name: manifest.entries[item.assetId]?.path ?? `assets/${item.assetId}/${item.name}`,
      data: new Uint8Array(buffer),
    });
  }

  const zip = createZip(
    [
      { name: 'pack.json', data: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`) },
      { name: 'project.json', data: encoder.encode(serializeProjectFile(doc, now)) },
      ...assetEntries,
    ],
    { date: new Date(now) },
  );
  return ok({
    blob: new Blob([zip as BlobPart], { type: 'application/octet-stream' }),
    manifest,
    missingNames,
    totalBytes,
  });
}

/* ---------------- 解包与恢复 ---------------- */

export interface OpenedVedpack {
  manifest: VedpackManifest;
  /** 包内素材字节（assetId → File；缺失素材不在 Map 里）。 */
  files: Map<string, File>;
}

/** 解包 + 校验（不触 store；恢复由调用方编排，方便 UI 做进度与提示）。 */
export async function openVedpack(file: Blob): Promise<Result<OpenedVedpack>> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const unzipped = unzipStore(bytes);
  if (!unzipped.ok) {
    // 用户拍板的中文提示（不抛技术术语）：not-zip / unsupported / corrupt 统一收敛
    return fail(
      makeError(
        'E_UNSUPPORTED_CONTAINER',
        '该文件不是 veditor 工程包，请选择正确的 .vedpack 文件',
        unzipped.message,
      ),
    );
  }
  const decoder = new TextDecoder();
  const packRaw = unzipped.entries.get('pack.json');
  const projectRaw = unzipped.entries.get('project.json');
  if (packRaw === undefined || projectRaw === undefined) {
    return fail(
      makeError('E_UNSUPPORTED_CONTAINER', '该文件不是 veditor 工程包，请选择正确的 .vedpack 文件', '缺 pack.json/project.json'),
    );
  }
  let manifest: VedpackManifest;
  try {
    const parsed: unknown = JSON.parse(decoder.decode(packRaw));
    if (typeof parsed !== 'object' || parsed === null || (parsed as { format?: unknown }).format !== VEDPACK_FORMAT) {
      throw new Error('format 不对');
    }
    manifest = parsed as VedpackManifest;
  } catch {
    return fail(makeError('E_UNSUPPORTED_CONTAINER', '工程包清单损坏，无法打开'));
  }
  if (manifest.version > VEDPACK_VERSION) {
    return fail(makeError('E_UNSUPPORTED_CONTAINER', `工程包版本过新（v${manifest.version}），请升级应用后再打开`));
  }

  const files = new Map<string, File>();
  for (const [assetId, entry] of Object.entries(manifest.entries)) {
    if (entry.missing === true) continue;
    const data = unzipped.entries.get(entry.path);
    if (data === undefined) continue; // 单个缺失降级，不整体失败
    files.set(assetId, new File([data as BlobPart], entry.name, { type: 'application/octet-stream' }));
  }
  return ok({ manifest, files });
}

/** 工程文本（`project.json` 原文）——调用方走 `parseProjectFile`（与 .vedproj 同一条校验路）。 */
export async function vedpackProjectText(file: Blob): Promise<Result<string>> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const unzipped = unzipStore(bytes);
  if (!unzipped.ok) {
    return fail(makeError('E_UNSUPPORTED_CONTAINER', '该文件不是 veditor 工程包，请选择正确的 .vedpack 文件', unzipped.message));
  }
  const projectRaw = unzipped.entries.get('project.json');
  if (projectRaw === undefined) {
    return fail(makeError('E_UNSUPPORTED_CONTAINER', '该文件不是 veditor 工程包，请选择正确的 .vedpack 文件', '缺 project.json'));
  }
  return ok(new TextDecoder().decode(projectRaw));
}
