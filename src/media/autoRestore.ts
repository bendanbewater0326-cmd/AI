/**
 * 自动恢复编排（"刷新后用户零操作"）。
 *
 * ## 三层策略
 *
 * ```
 * 第一层：句柄还在、权限 granted  → 直接 getFile 重建（restoreSession 已经做了）
 * 第二层：句柄失效 / 文件被移走    → 静默扫描"授权过的目录"重新匹配（本文件）
 * 第三层：以上都失败              → 才显示顶部离线条，给手动入口
 * ```
 *
 * ## 一个必须说清的浏览器限制
 *
 * **浏览器里拿不到"某个文件的父目录"**（安全限制），所以"文件改名后扫描同级目录"
 * 这件事只有在**用户显式授权过那个目录**时才做得到 —— 也就是他点过
 * 「批量重链…」选过文件夹。没有授权时第二层直接跳过，**不假装扫过**。
 *
 * Electron 侧不同：宿主能给绝对路径，`host.readFile(path)` 可以直接读，
 * 那条路是 100% 自动的（见 `electronScan`）。
 *
 * ## 为什么"扫描"放在恢复流程里而不是启动时无条件跑
 *
 * 扫描目录要遍历文件系统 + 对每个候选算前 1MB 指纹，10 个文件约 100ms–1s。
 * 只在**确实有离线素材**时才跑，正常刷新（全部 granted）一次都不扫。
 */
import type { Asset } from '../core/types';
import type { FileHandlePort } from '../persist/autosave';
import { getDirectoryHandles, queryAssetPermission } from '../persist/autosave';
import type { RelinkCandidateFile } from './relink';
import { isMediaFileName, relinkAssetFromFile, relinkFromFiles } from './relink';
import { hasHostFileAccess, hostPathOf, readFileViaHost } from './hostFiles';
import { readCachedAsset } from './draftCache';

/** 目录扫描的最大深度（0 = 只扫这一层）。 */
const SCAN_DEPTH = 1;
/** 单次扫描的候选上限：防止用户选了一个几万文件的目录把页面卡死。 */
const MAX_CANDIDATES = 400;

export interface AutoRestoreReport {
  /** 自动重链成功的素材 id。 */
  restored: string[];
  /** 自动方式全失败、需要用户手动处理的素材 id。 */
  needsManual: string[];
  /** 扫过的候选文件数（诊断用：0 表示"没有授权目录，第二层跳过了"）。 */
  scanned: number;
  /** 扫过但权限不够的目录名（提示用户重新授权）。 */
  deniedDirectories: string[];
}

/** 从 IDB 读用户授权过的目录（读失败 = 没有，不阻断恢复）。 */
async function readStoredDirectories(): Promise<Array<{ name: string; handle: FileHandlePort }>> {
  const result = await getDirectoryHandles();
  return result.ok ? result.value : [];
}

/**
 * 扫描一个目录句柄（递归 `SCAN_DEPTH` 层）。
 *
 * 只收音视频扩展名的文件；`path` 用相对路径（`子目录/文件名`），
 * 与 `webkitRelativePath` 的口径一致，方便和工程里记的 `sourcePath` 对比。
 */
export async function scanDirectoryHandle(
  handle: FileHandlePort,
  depth: number = SCAN_DEPTH,
  prefix = '',
  collected: RelinkCandidateFile[] = [],
): Promise<RelinkCandidateFile[]> {
  if (collected.length >= MAX_CANDIDATES) return collected;
  if (typeof handle.values !== 'function') return collected;
  try {
    for await (const entry of handle.values()) {
      if (collected.length >= MAX_CANDIDATES) break;
      if (entry.kind === 'directory') {
        if (depth > 0) {
          await scanDirectoryHandle(entry, depth - 1, `${prefix}${entry.name}/`, collected);
        }
        continue;
      }
      if (!isMediaFileName(entry.name)) continue;
      if (typeof entry.getFile !== 'function') continue;
      try {
        const file = await entry.getFile();
        collected.push({ file, path: `${prefix}${entry.name}`, handle: entry });
      } catch {
        // 单个文件读不了（权限/被占用）不影响其它
      }
    }
  } catch {
    // 目录读到一半失败：保留已收集的
  }
  return collected;
}

/**
 * **最优先层：本地草稿缓存池**。
 *
 * 命中缓存意味着"字节就在我们自己的存储里"，与源文件是否还在、权限是否有效
 * **完全无关** —— 这是唯一一条不受外部条件影响的恢复路径，所以排在最前面。
 *
 * 命中后**不动原句柄记录**（`handle` 传 `undefined`）：缓存只是多一条保命路径，
 * 原句柄没坏就该留着，下次还能走更快的句柄层。
 */
export async function restoreFromCache(assets: Asset[]): Promise<string[]> {
  const restored: string[] = [];
  for (const asset of assets) {
    const key = asset.cacheKey;
    if (typeof key !== 'string' || key === '') continue;
    const file = await readCachedAsset(key, asset.name).catch(() => null);
    if (file === null) continue;
    const result = await relinkAssetFromFile({ assetId: asset.id, file });
    if (result.ok) restored.push(asset.id);
  }
  return restored;
}

/**
 * **Electron 优先层**：宿主能按绝对路径读文件时，直接读 —— 不走句柄、不查权限。
 *
 * 为什么放在最前面：桌面端文件就在磁盘上，`readFileByPath` 是同步语义的
 * （主进程读盘），既不会"权限过期"，也不需要用户点任何东西。
 * 只有它失败了（文件被删/改名）才落到目录扫描。
 *
 * 返回成功重链的素材 id。
 */
export async function restoreFromHostPaths(offline: Asset[]): Promise<string[]> {
  if (!hasHostFileAccess()) return [];
  const restored: string[] = [];
  for (const asset of offline) {
    const path = hostPathOf(asset);
    if (path === null) continue;
    const file = await readFileViaHost(path);
    if (file === null) continue;
    const result = await relinkAssetFromFile({ assetId: asset.id, file, handle: null, sourcePath: path });
    if (result.ok) restored.push(asset.id);
  }
  return restored;
}

export interface AutoRestoreOptions {
  /** 待恢复的离线素材（id + 元数据）。 */
  offline: Asset[];
  /**
   * 用户授权过的目录句柄。缺省时自己从 IDB 读 ——
   * 传进来是为了让单测能注入假目录。
   */
  directories?: Array<{ name: string; handle: FileHandlePort }>;
  /** 进度回调（UI 可以显示"正在自动恢复 2/5"）。 */
  onProgress?: (done: number, total: number) => void;
}

/**
 * 第二层：静默扫描授权过的目录，尽量把离线素材自动链回去。
 *
 * 匹配规则完全复用 `relinkFromFiles`（指纹 100 / 三项全对 100 / >=95 才自动链），
 * 所以"自动恢复"与"批量重链"不会出现两套判据。
 */
export async function autoRestoreFromDirectories(
  options: AutoRestoreOptions,
): Promise<AutoRestoreReport> {
  const report: AutoRestoreReport = {
    restored: [],
    needsManual: options.offline.map((asset) => asset.id),
    scanned: 0,
    deniedDirectories: [],
  };
  if (options.offline.length === 0) return report;

  const directories = options.directories ?? (await readStoredDirectories());
  const usable: Array<{ name: string; handle: FileHandlePort }> = [];
  for (const entry of directories) {
    const permission = await queryAssetPermission(entry.handle);
    if (permission === 'granted') usable.push(entry);
    else report.deniedDirectories.push(entry.name);
  }
  if (usable.length === 0) return report;

  const candidates: RelinkCandidateFile[] = [];
  for (const entry of usable) {
    await scanDirectoryHandle(entry.handle, SCAN_DEPTH, '', candidates);
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  report.scanned = candidates.length;
  if (candidates.length === 0) return report;

  options.onProgress?.(0, options.offline.length);
  const batch = await relinkFromFiles(
    options.offline.map((asset) => asset.id),
    candidates,
  );
  report.restored = batch.linked;
  report.needsManual = options.offline
    .map((asset) => asset.id)
    .filter((id) => !batch.linked.includes(id));
  options.onProgress?.(batch.linked.length, options.offline.length);
  return report;
}
