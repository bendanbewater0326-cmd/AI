/**
 * 自动保存 + 句柄恢复（架构 §10.2 / §10.3 / §10.4）。
 *
 * 三条硬约束：
 *   1. **500ms 防抖**（R-013 要求 1 秒内落盘；`Cmd/Ctrl+S` 走 `flushSave()` 立即写）。
 *   2. `FileSystemFileHandle` 直接**结构化克隆**进 IDB；恢复时只 `queryPermission`，
 *      **绝不自动 `requestPermission`**（Chrome 会拒绝非手势调用）——必须由"恢复条"在
 *      用户手势内调用 `requestAssetPermission()`。
 *   3. 权限 `denied` / 文件离线 / 无 FS Access → 只改 `asset.status`，
 *      **不删片段、不改任何 Clip、不抛未捕获异常**（素材离线仍可剪辑）。
 *
 * 配额/存储失败一律映射为可读 `E_IDB_QUOTA`，通过 `onError` 交给顶部错误条。
 */
import type { Asset, Project, Result, VEditorError } from '../core/types';
import { fail, makeError, ok } from '../core/types';
import {
  STORE_DIRECTORIES,
  STORE_HANDLES,
  STORE_PROJECTS,
  STORE_PROXIES,
  STORE_SETTINGS,
  STORE_THUMBS,
  db as defaultDb,
} from './db';
import type { VeditorDb } from './db';

/** 防抖窗口（PRD：1 秒内落盘）。 */
export const AUTOSAVE_DEBOUNCE_MS = 500;

/** `settings` store 中记录"上次打开的工程"。 */
export const LAST_PROJECT_ID_KEY = 'lastProjectId';

/** 当前 schema 版本（写入时校正）。 */
export const SCHEMA_VERSION = 1;

/**
 * 只取需要的文件句柄能力（避免依赖不同 TS 版本对 FS Access 权限方法的不同声明）。
 * 真实对象是 `FileSystemFileHandle`（结构化克隆后依然是）。
 */
export interface FileHandlePort {
  readonly name: string;
  /** `'file'` / `'directory'`（目录句柄才有 `values`）。 */
  readonly kind?: string;
  getFile?(): Promise<File>;
  /**
   * 目录句柄的条目迭代器（`FileSystemDirectoryHandle.values()`）。
   *
   * 只有用户**显式授权过目录**（`showDirectoryPicker`）才拿得到，
   * 也正因为如此，"文件被移动后自动扫描同级目录"只能在有授权时做 ——
   * 浏览器不允许凭空遍历磁盘。
   */
  values?(): AsyncIterable<FileHandlePort>;
  queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

/** 扩展 Window 上的 FS Access 入口（Safari/Firefox 不存在）。 */
declare global {
  interface Window {
    showOpenFilePicker?: (options?: {
      multiple?: boolean;
      excludeAcceptAllOption?: boolean;
      types?: Array<{ description?: string; accept: Record<string, string[]> }>;
    }) => Promise<FileSystemFileHandle[]>;
  }
}

/** 当前环境是否有 File System Access（R-004 的降级判据）。 */
export function hasFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function';
}

/** 内存模式（无 FS Access）下的固定警告文案（UI 常驻警告条直接用）。 */
export const MEMORY_MODE_WARNING = '当前浏览器不支持文件句柄访问：关闭页面后工程会丢失';

/** 错误可读化。 */
function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/* ---------------- 工程读写 ---------------- */

/** 写一份工程（自动补 schemaVersion / updatedAt；不写 ephemeral）。 */
export async function saveProject(
  project: Project,
  database: VeditorDb = defaultDb,
): Promise<Result<void>> {
  const snapshot: Project = {
    ...project,
    schemaVersion: SCHEMA_VERSION,
    updatedAt: Date.now(),
  };
  const projectWrite = await database.put(STORE_PROJECTS, snapshot.id, snapshot);
  if (!projectWrite.ok) return projectWrite;
  const settingWrite = await database.put(STORE_SETTINGS, LAST_PROJECT_ID_KEY, snapshot.id);
  if (!settingWrite.ok) return settingWrite;
  return ok(undefined);
}

/** 读一份工程（不存在返回 null，不视为错误）。 */
export async function loadProject(
  projectId: string,
  database: VeditorDb = defaultDb,
): Promise<Result<Project | null>> {
  const stored = await database.get<Project>(STORE_PROJECTS, projectId);
  if (!stored.ok) return fail(stored.error);
  if (!stored.value || typeof stored.value !== 'object') return ok(null);
  return ok(stored.value);
}

/** 上次打开的工程 id（无则 null）。 */
export async function loadLastProjectId(
  database: VeditorDb = defaultDb,
): Promise<Result<string | null>> {
  const stored = await database.get<string>(STORE_SETTINGS, LAST_PROJECT_ID_KEY);
  if (!stored.ok) return fail(stored.error);
  const value = stored.value;
  return ok(typeof value === 'string' && value.length > 0 ? value : null);
}

/* ---------------- 句柄与缩略图 ---------------- */

/** 把文件句柄结构化克隆进 IDB（Chromium 支持；其他浏览器本身就没有句柄）。 */
export async function putHandle(
  assetId: string,
  handle: FileHandlePort,
  database: VeditorDb = defaultDb,
): Promise<Result<void>> {
  return database.put(STORE_HANDLES, assetId, handle);
}

/** 取出文件句柄（不存在返回 null）。 */
export async function getHandle(
  assetId: string,
  database: VeditorDb = defaultDb,
): Promise<Result<FileHandlePort | null>> {
  const stored = await database.get<FileHandlePort>(STORE_HANDLES, assetId);
  if (!stored.ok) return fail(stored.error);
  return ok(stored.value ?? null);
}

/** 存缩略图 Blob。 */
/* ---------------- 目录句柄（自动扫描重链用） ---------------- */

/** 目录句柄在 IDB 里的主键：`dir:<name>`（同名目录视为同一个，重复授权只更新）。 */
export function directoryKey(name: string): string {
  return `dir:${name}`;
}

/** 记住一个用户授权过的素材目录（批量重链选过的文件夹）。 */
export async function putDirectoryHandle(
  name: string,
  handle: FileHandlePort,
  database: VeditorDb = defaultDb,
): Promise<Result<void>> {
  return database.put(STORE_DIRECTORIES, directoryKey(name), handle);
}

/** 取出所有记住的目录句柄（**不查权限**，调用方自己查）。 */
export async function getDirectoryHandles(
  database: VeditorDb = defaultDb,
): Promise<Result<Array<{ name: string; handle: FileHandlePort }>>> {
  const keysResult = await database.keys(STORE_DIRECTORIES);
  if (!keysResult.ok) return fail(keysResult.error);
  const out: Array<{ name: string; handle: FileHandlePort }> = [];
  for (const key of keysResult.value) {
    const value = await database.get<FileHandlePort>(STORE_DIRECTORIES, key);
    if (!value.ok || value.value === undefined) continue;
    out.push({ name: String(key).replace(/^dir:/, ''), handle: value.value });
  }
  return ok(out);
}

/** 忘掉某个目录（权限彻底失效时清理，避免每次刷新都白扫一遍）。 */
export async function deleteDirectoryHandle(
  name: string,
  database: VeditorDb = defaultDb,
): Promise<Result<void>> {
  return database.delete(STORE_DIRECTORIES, directoryKey(name));
}

export async function putThumbnail(
  assetId: string,
  blob: Blob,
  database: VeditorDb = defaultDb,
): Promise<Result<void>> {
  return database.put(STORE_THUMBS, assetId, blob);
}

/** 取缩略图 Blob（不存在返回 null）。 */
export async function getThumbnail(
  assetId: string,
  database: VeditorDb = defaultDb,
): Promise<Result<Blob | null>> {
  const stored = await database.get<Blob>(STORE_THUMBS, assetId);
  if (!stored.ok) return fail(stored.error);
  return ok(stored.value ?? null);
}

/** 存代理媒体（R-052）。 */
export async function putProxy(
  assetId: string,
  blob: Blob,
  database: VeditorDb = defaultDb,
): Promise<Result<void>> {
  return database.put(STORE_PROXIES, assetId, blob);
}

/** 取代理媒体（没有返回 null）。 */
export async function getProxy(
  assetId: string,
  database: VeditorDb = defaultDb,
): Promise<Result<Blob | null>> {
  const stored = await database.get<Blob>(STORE_PROXIES, assetId);
  if (!stored.ok) return fail(stored.error);
  return ok(stored.value ?? null);
}

/** 删代理（素材被移除 / 代理失效时）。 */
export async function deleteProxy(
  assetId: string,
  database: VeditorDb = defaultDb,
): Promise<Result<void>> {
  return database.delete(STORE_PROXIES, assetId);
}

/** 清空缩略图（quota 超限时的"隐藏动作"，§10.4）。 */
export async function clearThumbnails(database: VeditorDb = defaultDb): Promise<Result<void>> {
  return database.clear(STORE_THUMBS);
}

/* ---------------- 权限 ---------------- */

/** 只查询权限（恢复流程专用，**绝不触发弹窗**）。 */
export async function queryAssetPermission(
  handle: FileHandlePort,
): Promise<PermissionState | 'unsupported'> {
  if (typeof handle.queryPermission !== 'function') return 'unsupported';
  try {
    return await handle.queryPermission({ mode: 'read' });
  } catch {
    return 'denied';
  }
}

/**
 * 请求权限（**必须在用户手势内同步调用栈中调用**，例如"恢复素材访问"按钮的 click 处理器）。
 * 页面加载阶段不得调用（Chrome 会静默失败）。
 */
export async function requestAssetPermission(
  handle: FileHandlePort,
): Promise<Result<boolean>> {
  if (typeof handle.requestPermission !== 'function') {
    return fail(
      makeError('E_PERMISSION_DENIED', '当前浏览器不支持重新授权文件访问，请重新导入素材'),
    );
  }
  try {
    const state = await handle.requestPermission({ mode: 'read' });
    if (state === 'granted') return ok(true);
    return fail(
      makeError(
        'E_PERMISSION_DENIED',
        state === 'denied' ? '文件访问被拒绝，可点击"重新链接"选择文件' : '尚未授予文件访问权限',
      ),
    );
  } catch (error) {
    return fail(makeError('E_PERMISSION_DENIED', '重新授权失败', describeError(error)));
  }
}

/* ---------------- 会话恢复 ---------------- */

export interface SessionSnapshot {
  project: Project;
  /** 需要重新授权（queryPermission === 'prompt'）的素材：必须由用户手势恢复。 */
  pendingGestureAssetIds: string[];
  /** 权限 denied 或句柄丢失 / 文件不存在 → 只能走"重新链接"。 */
  offlineAssetIds: string[];
  /** 内存模式素材（关闭页面即失效）。 */
  memoryAssetIds: string[];
  /**
   * **可以直接用的文件**（权限 granted 的素材）。
   *
   * 为什么要把 `File` 带出来：刷新后 `previewSource` 里的源是空的
   * （那是内存态），光把 `asset.status` 标成 `ok` **不会让画面回来**——
   * 预览引擎仍然没有字节可解，用户看到的就是"状态是好的但黑屏"。
   * 调用方拿到这些文件后要逐个 `registerPreviewSource`（见 App 的恢复流程）。
   */
  restorableFiles: Array<{ assetId: string; file: File }>;
  /** 工程级素材来源模式：无 FS Access 或全部素材内存模式时为 'memory'。 */
  sourceMode: 'fs' | 'memory';
  /** 无 FS Access 时必须常驻警告条（R-004）。 */
  warnMemoryMode: boolean;
}

/**
 * 启动恢复（§10.2）：
 *   open db → settings.lastProjectId → projects[id]
 *   → 逐素材：无 handle / memory → 'memory'
 *              queryPermission: granted → 'ok'；prompt → 'offline' + pendingGesture；denied → 'offline'
 *   → 渲染工程（离线素材的 clip 数据完整保留）
 */
export async function restoreSession(
  database: VeditorDb = defaultDb,
): Promise<Result<SessionSnapshot | null>> {
  const lastIdResult = await loadLastProjectId(database);
  if (!lastIdResult.ok) return fail(lastIdResult.error);
  const projectId = lastIdResult.value;
  if (!projectId) return ok(null);

  const projectResult = await loadProject(projectId, database);
  if (!projectResult.ok) return fail(projectResult.error);
  const project = projectResult.value;
  if (!project) return ok(null);

  const fsAccess = hasFileSystemAccess();

  /**
   * **并行**逐素材恢复（用户要求"10 个素材不超过 1 秒"）。
   *
   * 每个素材要串三步：读句柄（IDB）→ 查权限（FS API）→ 取文件（FS API）。
   * 串行时 10 个素材是 30 次 await 排队，实测 1.5–3 秒；
   * 三步之间没有数据依赖，可以整体并行。
   *
   * `Promise.all` 而不是"限并发 4"：这些都是轻量调用（IDB 读 + 权限查询），
   * 真正的重活（demux/解码）在调用方的 `probeMediaFile` 里，那边才是需要限流的。
   */
  const results = await Promise.all(
    project.assets.map(async (asset) => {
      if (!fsAccess || asset.sourceMode === 'memory' || asset.handleRef === null) {
        return { asset: { ...asset, status: 'memory' as const }, kind: 'memory' as const };
      }

      const handleResult = await getHandle(asset.handleRef, database);
      if (!handleResult.ok || !handleResult.value) {
        // 读句柄失败/句柄丢了不阻断整个工程：该素材降级为离线
        return { asset: { ...asset, status: 'offline' as const }, kind: 'offline' as const };
      }
      const handle = handleResult.value;
      const permission = await queryAssetPermission(handle);
      if (permission !== 'granted') {
        /**
         * `prompt` 与 `denied` 都算"需要用户动作"，但**含义不同**：
         * - `prompt`：句柄还在，只差一次授权（「恢复访问」按钮能修好）；
         * - `denied`：彻底没戏（只能重新选文件）。
         * 两者都进离线列表，但分开记，顶栏文案才能说清"能一键恢复"还是"必须选文件"。
         */
        return {
          asset: { ...asset, status: 'offline' as const },
          kind: permission === 'prompt' ? ('pendingGesture' as const) : ('offline' as const),
        };
      }

      /**
       * 权限已授予 → 立刻取文件，供调用方重建预览源。
       *
       * `getFile()` 失败（文件被移走/改名）说明"权限还在、文件没了"——
       * 这恰恰是最常见的离线场景（用户整理过素材文件夹），
       * 必须降级成 offline 并进"重新链接/自动扫描"队列，而不是标 ok 然后黑屏。
       */
      try {
        if (typeof handle.getFile !== 'function') throw new Error('no getFile');
        const file = await handle.getFile();
        return {
          asset: { ...asset, status: 'ok' as const, name: file.name },
          kind: 'restorable' as const,
          file,
        };
      } catch {
        return { asset: { ...asset, status: 'offline' as const }, kind: 'offline' as const };
      }
    }),
  );

  const pendingGestureAssetIds: string[] = [];
  const offlineAssetIds: string[] = [];
  const memoryAssetIds: string[] = [];
  const restorableFiles: Array<{ assetId: string; file: File }> = [];
  const assets: Asset[] = [];
  for (const result of results) {
    assets.push(result.asset);
    if (result.kind === 'memory') memoryAssetIds.push(result.asset.id);
    else if (result.kind === 'pendingGesture') pendingGestureAssetIds.push(result.asset.id);
    else if (result.kind === 'restorable') {
      if (result.file !== undefined) restorableFiles.push({ assetId: result.asset.id, file: result.file });
    } else offlineAssetIds.push(result.asset.id);
  }

  const restoredProject: Project = { ...project, assets };
  const allMemory =
    project.assets.length > 0 && memoryAssetIds.length === project.assets.length;
  const sourceMode: 'fs' | 'memory' = !fsAccess || allMemory ? 'memory' : 'fs';

  return ok({
    project: restoredProject,
    pendingGestureAssetIds,
    offlineAssetIds,
    memoryAssetIds,
    restorableFiles,
    sourceMode,
    warnMemoryMode: !fsAccess,
  });
}

/**
 * 重新链接素材（§10.3）：校验 `name` 相同、`size` 偏差 ≤ 1%。
 * 时长偏差 ≤ 1 帧的校验需要 demuxer（T05 的 mediaProbe），此处只做文件级校验。
 *
 * `Asset.hashKey` 的格式是 `${name}|${size}|${lastModified}`，size 从这里反解，
 * 免去在 doc 里多存一个只用于校验的字段。
 */
export async function relinkAsset(
  handle: FileHandlePort,
  asset: Asset,
): Promise<Result<boolean>> {
  if (typeof handle.getFile !== 'function') {
    return fail(makeError('E_ASSET_OFFLINE', '无法读取所选文件'));
  }
  try {
    const file = await handle.getFile();
    if (file.name !== asset.name) {
      return fail(
        makeError(
          'E_ASSET_OFFLINE',
          '文件与工程记录不匹配：文件名不同',
          `期望 ${asset.name}，实际 ${file.name}`,
        ),
      );
    }
    const sizeText = asset.hashKey.split('|')[1];
    const expectedSize = Number(sizeText);
    if (Number.isFinite(expectedSize) && expectedSize > 0) {
      const tolerance = Math.max(1, Math.round(expectedSize * 0.01));
      if (Math.abs(file.size - expectedSize) > tolerance) {
        return fail(
          makeError(
            'E_ASSET_OFFLINE',
            '文件与工程记录不匹配：文件大小差异超过 1%',
            `期望 ${expectedSize} 字节，实际 ${file.size} 字节`,
          ),
        );
      }
    }
    return ok(true);
  } catch (error) {
    return fail(
      makeError('E_ASSET_OFFLINE', '文件不可访问（可能已被移动或删除）', describeError(error)),
    );
  }
}

/* ---------------- 自动保存句柄 ---------------- */

export interface AutosaveOptions {
  debounceMs?: number;
  onError?: (error: VEditorError) => void;
  onSaved?: (project: Project) => void;
}

export interface AutosaveHandle {
  /** 防抖保存（500ms 内的多次调用只写最后一次快照）。 */
  scheduleSave(project: Project): void;
  /** 立即写入（Cmd/Ctrl+S、页面隐藏、卸载前）。 */
  flushSave(): Promise<Result<void>>;
  hasPending(): boolean;
  /** 取消未落盘的挂起写入（不写盘）。 */
  cancel(): void;
  dispose(): void;
}

/** 创建 autosave 句柄（可注入 db 以便测试/多工程）。 */
export function createAutosave(
  options: AutosaveOptions = {},
  database: VeditorDb = defaultDb,
): AutosaveHandle {
  const debounceMs = options.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Project | null = null;
  let inFlight: Promise<Result<void>> | null = null;
  let disposed = false;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  async function write(project: Project): Promise<Result<void>> {
    const result = await saveProject(project, database);
    if (result.ok) {
      options.onSaved?.(project);
    } else {
      options.onError?.(result.error);
    }
    return result;
  }

  function armTimer(): void {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      const project = pending;
      pending = null;
      if (!project) return;
      inFlight = write(project).finally(() => {
        inFlight = null;
      });
    }, debounceMs);
  }

  return {
    scheduleSave(project: Project): void {
      if (disposed) return;
      pending = project;
      armTimer();
    },
    async flushSave(): Promise<Result<void>> {
      clearTimer();
      if (inFlight) await inFlight;
      const project = pending;
      pending = null;
      if (!project) return ok(undefined);
      inFlight = write(project).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    hasPending(): boolean {
      return pending !== null || timer !== null;
    },
    cancel(): void {
      clearTimer();
      pending = null;
    },
    dispose(): void {
      disposed = true;
      clearTimer();
      pending = null;
    },
  };
}

/** 应用单例（debounceMs = 500）。 */
export const autosave: AutosaveHandle = createAutosave();

/** store 侧最小端口（避免 persist 反向依赖 core/store 的具体类型）。 */
export interface AutosaveStorePort {
  getDoc(): Project;
  subscribe(listener: () => void): () => void;
}

/**
 * 把 store 的 doc 变更接到自动保存上（架构 L1 的 `STORE --> DB` 落地方式：
 * persist 订阅 core，core 不知道 persist 的存在）。
 *
 * @returns 解绑函数（`destroy()` 时调用，同时 flush 未落盘内容）。
 */
export function attachAutosave(
  storePort: AutosaveStorePort,
  handle: AutosaveHandle = autosave,
): () => void {
  let lastDoc = storePort.getDoc();
  const unsubscribe = storePort.subscribe(() => {
    const doc = storePort.getDoc();
    // 引用不变说明没有可见变更（播放头走高频总线，不触发订阅）
    if (doc === lastDoc) return;
    lastDoc = doc;
    handle.scheduleSave(doc);
  });

  return () => {
    unsubscribe();
    void handle.flushSave();
    handle.dispose();
  };
}
