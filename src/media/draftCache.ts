/**
 * 本地草稿素材缓存池（"导入过一次，就永远能恢复"）。
 *
 * ## 为什么需要它
 *
 * 前面四层恢复都依赖**外部条件**：宿主路径、文件句柄权限、授权目录。
 * 任何一条断了（用户挪了文件、清了站点数据、换了浏览器、内嵌面板不给权限），
 * 素材就恢复不了。缓存池把"字节"复制进软件自己的存储 ——
 * **从此不再依赖源文件是否还在原地**。
 *
 * ## 两个后端
 *
 * | 环境 | 后端 | 特点 |
 * |---|---|---|
 * | Electron 外壳 | 宿主 `veditorHost.*`（用户数据目录 `drafts/assets/`） | 最可靠，不受浏览器存储配额影响 |
 * | 浏览器 | **OPFS**（`navigator.storage.getDirectory()`） | 持久、刷新不丢、**不需要任何授权** |
 * | 都没有 | 无（`kind: 'none'`） | 自动跳过，行为与旧版本完全一致 |
 *
 * ## 为什么 OPFS 是关键
 *
 * 它和 IndexedDB 一样是"源私有"的，但能**流式写大文件**（`createWritable`），
 * 不必把 2GB 整个读进内存 —— 而 IndexedDB 存 2GB Blob 会让标签页直接崩。
 * 而且 OPFS **不需要用户授权**，刷新后照样能读。
 *
 * ## 命名即去重
 *
 * 缓存文件名 = 内容指纹（前 1MB 的 SHA-256）。同一份素材导入三次，
 * 三次都算出同一个指纹 → 落到同一个文件 → **天然去重，不重复占空间**。
 */
import type { Asset } from '../core/types';

/** 缓存里的一个文件。 */
export interface CacheEntry {
  /** 缓存键（指纹安全化后的文件名，不含扩展名）。 */
  key: string;
  /** 完整文件名（含扩展名）。 */
  name: string;
  size: number;
  lastModified: number;
}

/** 缓存后端接口（OPFS / 宿主各实现一份）。 */
export interface CacheBackend {
  readonly kind: 'opfs' | 'host';
  put(key: string, name: string, file: Blob): Promise<boolean>;
  get(name: string): Promise<File | null>;
  has(name: string): Promise<boolean>;
  list(): Promise<CacheEntry[]>;
  remove(name: string): Promise<void>;
  clear(): Promise<void>;
}

/* ---------------- 键的规范化 ---------------- */

/**
 * 指纹 → 缓存键（文件名安全）。
 *
 * `sha256:ab12…` → `sha256-ab12…`：冒号在 Windows 文件名里非法，
 * 而缓存目录在 Electron 侧就是真实文件系统。保留算法前缀，换算法时不会撞名。
 */
export function cacheKeyOf(contentHash: string): string {
  return contentHash.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

/** 缓存文件名 = 键 + 原扩展名（保留扩展名，人肉看目录时能认出是什么格式）。 */
export function cacheFileName(contentHash: string, originalName: string): string {
  const dot = originalName.lastIndexOf('.');
  const ext = dot > 0 ? originalName.slice(dot + 1).toLowerCase() : 'bin';
  return `${cacheKeyOf(contentHash)}.${ext}`;
}

/* ---------------- OPFS 后端 ---------------- */

/** OPFS 根目录下的子目录名（与 Electron 的 `drafts/assets` 对齐）。 */
const OPFS_DIR = 'drafts-assets';

interface OpfsPort {
  getDirectory(): Promise<{
    getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<unknown>;
  }>;
}

function opfsSupport(): OpfsPort | null {
  if (typeof navigator === 'undefined') return null;
  const storage = (navigator as unknown as { storage?: { getDirectory?: () => Promise<unknown> } }).storage;
  if (storage === undefined || typeof storage.getDirectory !== 'function') return null;
  return {
    getDirectory: () => (storage.getDirectory as () => Promise<never>)(),
  };
}

/** 取（或创建）缓存目录句柄。 */
async function opfsDir(): Promise<{
  getFileHandle(name: string, options?: { create?: boolean }): Promise<{
    getFile(): Promise<File>;
    createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
  }>;
  removeEntry(name: string): Promise<void>;
  values(): AsyncIterable<{
    name: string;
    kind: string;
    getFile(): Promise<File>;
  }>;
} | null> {
  const support = opfsSupport();
  if (support === null) return null;
  try {
    const root = (await support.getDirectory()) as {
      getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<never>;
    };
    return (await root.getDirectoryHandle(OPFS_DIR, { create: true })) as never;
  } catch {
    return null;
  }
}

/** OPFS 后端（浏览器）。 */
export function createOpfsBackend(): CacheBackend | null {
  if (opfsSupport() === null) return null;
  return {
    kind: 'opfs',
    async put(_key, name, file) {
      const dir = await opfsDir();
      if (dir === null) return false;
      try {
        const handle = await dir.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        // 流式写：2GB 素材也不会把内存打满（这是选 OPFS 而不是 IndexedDB 的原因）
        await writable.write(file);
        await writable.close();
        return true;
      } catch {
        return false;
      }
    },
    async get(name) {
      const dir = await opfsDir();
      if (dir === null) return null;
      try {
        const handle = await dir.getFileHandle(name);
        return await handle.getFile();
      } catch {
        return null;
      }
    },
    async has(name) {
      return (await this.get(name)) !== null;
    },
    async list() {
      const dir = await opfsDir();
      if (dir === null) return [];
      const out: CacheEntry[] = [];
      try {
        for await (const entry of dir.values()) {
          if (entry.kind !== 'file') continue;
          try {
            const file = await entry.getFile();
            out.push({
              key: entry.name.replace(/\.[^.]+$/, ''),
              name: entry.name,
              size: file.size,
              lastModified: file.lastModified,
            });
          } catch {
            // 单个文件读不了不影响列表
          }
        }
      } catch {
        // 目录读到一半失败：返回已收集的
      }
      return out;
    },
    async remove(name) {
      const dir = await opfsDir();
      if (dir === null) return;
      try {
        await dir.removeEntry(name);
      } catch {
        // 不存在就算了
      }
    },
    async clear() {
      const dir = await opfsDir();
      if (dir === null) return;
      try {
        const names: string[] = [];
        for await (const entry of dir.values()) {
          if (entry.kind === 'file') names.push(entry.name);
        }
        for (const name of names) await dir.removeEntry(name);
      } catch {
        // 清不干净也不报错（下次还能清）
      }
    },
  };
}

/* ---------------- 宿主后端（Electron） ---------------- */

/** 宿主需要实现的缓存能力（全部可选，缺哪个就降级到"不支持"）。 */
export interface HostCacheBridge {
  copyAssetToCache?: (sourcePath: string, cacheHash: string) => Promise<string | null>;
  getCacheAssetPath?: (cacheHash: string) => Promise<string | null>;
  readCacheFile?: (cacheHash: string) => Promise<Blob | null>;
  listCache?: () => Promise<Array<{ name: string; size: number; lastModified: number }>>;
  deleteCacheFile?: (cacheHash: string) => Promise<void>;
  clearCache?: () => Promise<void>;
}

function hostCacheBridge(): HostCacheBridge | null {
  if (typeof window === 'undefined') return null;
  const host = (window as unknown as { veditorHost?: HostCacheBridge }).veditorHost;
  return host !== null && host !== undefined ? host : null;
}

/** 宿主缓存后端（Electron）。 */
export function createHostBackend(): CacheBackend | null {
  const bridge = hostCacheBridge();
  if (bridge === null) return null;
  // 至少要能"读回"，否则缓存写了也恢复不了
  if (typeof bridge.readCacheFile !== 'function' && typeof bridge.getCacheAssetPath !== 'function') {
    return null;
  }
  return {
    kind: 'host',
    async put(_key, name, file) {
      /**
       * 宿主侧需要**源路径**才能拷贝（主进程用 fs.copyFile，比把 2GB 读进渲染进程快得多）。
       * 调用方把路径塞在 `file` 的自定义属性上（见 `enqueueCacheWrite`），
       * 拿不到就退回"渲染进程读出来再交给宿主写"——慢但能用。
       */
      const sourcePath = (file as File & { sourcePath?: string }).sourcePath;
      if (typeof bridge.copyAssetToCache === 'function' && typeof sourcePath === 'string' && sourcePath !== '') {
        try {
          return (await bridge.copyAssetToCache(sourcePath, name)) !== null;
        } catch {
          return false;
        }
      }
      return false;
    },
    async get(name) {
      try {
        if (typeof bridge.readCacheFile === 'function') {
          const blob = await bridge.readCacheFile(name);
          if (blob === null) return null;
          return new File([blob], name, { type: blob.type || 'video/mp4' });
        }
        if (typeof bridge.getCacheAssetPath === 'function') {
          const path = await bridge.getCacheAssetPath(name);
          if (path === null) return null;
          const hostFiles = await import('./hostFiles');
          return await hostFiles.readFileViaHost(path);
        }
        return null;
      } catch {
        return null;
      }
    },
    async has(name) {
      return (await this.get(name)) !== null;
    },
    async list() {
      if (typeof bridge.listCache !== 'function') return [];
      try {
        return (await bridge.listCache()).map((item) => ({
          key: item.name.replace(/\.[^.]+$/, ''),
          name: item.name,
          size: item.size,
          lastModified: item.lastModified,
        }));
      } catch {
        return [];
      }
    },
    async remove(name) {
      if (typeof bridge.deleteCacheFile !== 'function') return;
      try {
        await bridge.deleteCacheFile(name);
      } catch {
        // 忽略
      }
    },
    async clear() {
      if (typeof bridge.clearCache !== 'function') return;
      try {
        await bridge.clearCache();
      } catch {
        // 忽略
      }
    },
  };
}

/* ---------------- 后端选择与开关 ---------------- */

let override: CacheBackend | null | undefined;

/** 测试注入（`null` = 强制禁用）。 */
export function setCacheBackendForTest(backend: CacheBackend | null | undefined): void {
  override = backend;
}

/** 当前可用后端（宿主优先：桌面端比浏览器存储更可靠）。 */
export function currentBackend(): CacheBackend | null {
  if (override !== undefined) return override;
  const host = createHostBackend();
  if (host !== null) return host;
  return createOpfsBackend();
}

/** 缓存功能是否可用（不可用就整条跳过，不影响旧行为）。 */
export function isCacheAvailable(): boolean {
  return currentBackend() !== null;
}

/* ---------------- 自动缓存开关 ---------------- */

const AUTO_CACHE_KEY = 'veditor:autoCache';

/**
 * 本次会话的开关值（**内存兜底**）。
 *
 * 为什么需要：隐私模式 / 受限 iframe 里 `localStorage` 可能不可写，
 * 只依赖它就会出现"用户把开关关了，下一个导入还是写了缓存"——
 * 用户会认为开关是坏的。内存里记一份，本次会话一定生效。
 */
let autoCacheMemo: boolean | null = null;

/** 是否自动缓存新导入的素材（默认开）。 */
export function isAutoCacheEnabled(): boolean {
  if (autoCacheMemo !== null) return autoCacheMemo;
  try {
    const raw = globalThis.localStorage?.getItem(AUTO_CACHE_KEY);
    if (raw === '0') return false;
    if (raw === '1') return true;
  } catch {
    // 读不到就用默认值
  }
  return true;
}

export function setAutoCacheEnabled(enabled: boolean): void {
  autoCacheMemo = enabled;
  try {
    globalThis.localStorage?.setItem(AUTO_CACHE_KEY, enabled ? '1' : '0');
  } catch {
    // 写不进去也不影响本次会话（上面已经记在内存里）
  }
}

/* ---------------- 并发队列（限 2） ---------------- */

interface QueueItem {
  file: File;
  name: string;
  sourcePath: string | null;
  onDone: (ok: boolean) => void;
}

const queue: QueueItem[] = [];
let running = 0;
/** 并发 2：拷 2GB 文件时磁盘 IO 已经接近打满，再高会让预览解码卡顿。 */
const MAX_CONCURRENCY = 2;

function pump(): void {
  while (running < MAX_CONCURRENCY) {
    const item = queue.shift();
    if (item === undefined) return;
    running += 1;
    void (async () => {
      const backend = currentBackend();
      let ok = false;
      if (backend !== null) {
        try {
          ok = await backend.put(cacheKeyOf(item.name), item.name, item.file);
        } catch {
          ok = false;
        }
      }
      running -= 1;
      item.onDone(ok);
      pump();
    })();
  }
}

/**
 * 后台把素材写入缓存池（**不阻塞导入**）。
 *
 * 调用方在导入成功、用户已经能剪辑之后调用；`onDone` 用来把 `cacheKey` 写回素材。
 * 失败**不报错**：缓存是"锦上添花"，失败就退回原来的句柄/路径恢复。
 */
export function enqueueCacheWrite(
  file: File,
  contentHash: string,
  originalName: string,
  onDone: (ok: boolean) => void,
  sourcePath: string | null = null,
): void {
  if (!isAutoCacheEnabled()) {
    onDone(false);
    return;
  }
  if (currentBackend() === null) {
    onDone(false);
    return;
  }
  const name = cacheFileName(contentHash, originalName);
  // 带源路径（宿主侧可以直接 fs.copyFile，不用把字节读进渲染进程）
  const tagged = Object.assign(file, { sourcePath });
  queue.push({ file: tagged, name, sourcePath, onDone });
  pump();
}

/** 队列里还有多少待拷（诊断 / 测试用）。 */
export function pendingCacheJobs(): number {
  return queue.length + running;
}

/* ---------------- 读 / 统计 / 清理 ---------------- */

/**
 * 从缓存池读素材。
 *
 * `cacheKey` 是素材上记的**文件名**（含扩展名）；读不到返回 null，
 * 调用方继续走下一层恢复。
 */
export async function readCachedAsset(cacheKey: string, originalName: string): Promise<File | null> {
  const backend = currentBackend();
  if (backend === null) return null;
  // 兼容两种写法：存的是完整文件名，或只有键（老数据）
  const name = /\.[a-z0-9]+$/i.test(cacheKey) ? cacheKey : cacheFileName(cacheKey, originalName);
  return backend.get(name);
}

/** 缓存池里有没有这个素材（按文件名）。 */
export async function hasCachedAsset(cacheKey: string, originalName: string): Promise<boolean> {
  const backend = currentBackend();
  if (backend === null) return false;
  const name = /\.[a-z0-9]+$/i.test(cacheKey) ? cacheKey : cacheFileName(cacheKey, originalName);
  return backend.has(name);
}

export interface CacheStats {
  count: number;
  bytes: number;
  entries: CacheEntry[];
}

/** 缓存池统计（设置页展示）。 */
export async function cacheStats(): Promise<CacheStats> {
  const backend = currentBackend();
  if (backend === null) return { count: 0, bytes: 0, entries: [] };
  const entries = await backend.list();
  return {
    count: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    entries: entries.sort((left, right) => right.lastModified - left.lastModified),
  };
}

/** 删单个缓存文件（按文件名）。 */
export async function removeCachedAsset(name: string): Promise<void> {
  await currentBackend()?.remove(name);
}

/** 清空整个缓存池。 */
export async function clearCachePool(): Promise<void> {
  await currentBackend()?.clear();
}

/**
 * 清理"没有任何工程引用"的缓存文件。
 *
 * 判据是**当前工程 + 所有工程**的 `asset.cacheKey` 集合 —— 但浏览器里只能看到
 * 当前工程（多工程存在 IDB 的 `projects`，可以读出来）。
 * 这里只接受调用方传进来的"在用集合"，保持纯逻辑、可单测。
 */
export function unusedEntries(entries: readonly CacheEntry[], inUse: ReadonlySet<string>): CacheEntry[] {
  return entries.filter((entry) => !inUse.has(entry.name));
}

/** 从素材列表里收集"在用的缓存文件名"。 */
export function inUseCacheNames(assets: readonly Asset[]): Set<string> {
  const names = new Set<string>();
  for (const asset of assets) {
    const key = asset.cacheKey;
    if (typeof key !== 'string' || key === '') continue;
    names.add(key);
  }
  return names;
}
