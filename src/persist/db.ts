/**
 * IndexedDB 封装（架构 §10.1）：DB 名 `veditor`，version 4，七个 object store：
 *
 *   | store      | key         | value                  |
 *   |------------|-------------|------------------------|
 *   | `projects` | projectId   | Project（JSON 可序列化）|
 *   | `handles`  | assetId     | FileSystemFileHandle   |  ← 结构化克隆，Chromium 原生支持
 *   | `thumbs`   | assetId     | Blob                   |
 *   | `proxies`  | assetId     | Blob（代理 MP4）        |
 *   | `settings` | key         | unknown                |
   | `projectBackups` | `projectId\|时间戳` | 工程历史备份（backup.ts）|
 *
 * 只做 `get / put / delete / clear / keys`（原生 50 行足够，不引入 `idb`）。
 * 所有可预期失败返回 `Result<T>`；配额异常映射为 `E_QUOTA_EXCEEDED`、环境不可用映射为 `E_IDB_UNAVAILABLE`（均为可读中文原因）。
 *
 * 依赖方向：`persist → core(types)`（不含 DOM 逻辑进 core）。
 */
import type { Result, VEditorError } from '../core/types';
import { fail, makeError, ok } from '../core/types';

export const DB_NAME = 'veditor';
export const DB_VERSION = 4;

export const STORE_PROJECTS = 'projects';
export const STORE_HANDLES = 'handles';
export const STORE_THUMBS = 'thumbs';
/** 代理媒体（R-052）：assetId → 低分辨率 MP4 Blob。 */
export const STORE_PROXIES = 'proxies';
export const STORE_SETTINGS = 'settings';
/**
 * 用户授权过的**素材目录**句柄（`dirId` → FileSystemDirectoryHandle）。
 *
 * 为什么需要：浏览器里拿不到"某个文件的父目录"（安全限制），
 * 所以"文件被移动/改名后自动扫描同级目录"这件事**只有用户显式授权过目录才做得到**。
 * 用户点过"批量重链…"选了文件夹，就等于授权了 —— 存下来，下次刷新可以静默扫描。
 */
export const STORE_DIRECTORIES = 'directories';
/**
 * 工程**历史备份**（键 = `projectId|时间戳`，值 = 快照 + 原因）。
 *
 * 与 `projects` 的区别：那边是"现在"（单槽覆盖写），这边是"历史"（滚动保留 N 份）。
 * 见 `persist/backup.ts`。
 */
export const STORE_PROJECT_BACKUPS = 'projectBackups';

export type ObjectStoreName =
  | 'projects'
  | 'handles'
  | 'thumbs'
  | 'proxies'
  | 'settings'
  | 'directories'
  | 'projectBackups';

/** 建库时创建的 store 列表（**每次升级都会补齐缺失的 store**，所以加 store 只需往这里加 + bump version）。 */
export const OBJECT_STORES: readonly ObjectStoreName[] = [
  STORE_PROJECTS,
  STORE_HANDLES,
  STORE_THUMBS,
  STORE_PROXIES,
  STORE_SETTINGS,
  STORE_DIRECTORIES,
  STORE_PROJECT_BACKUPS,
];

/** 是否 DOMException（Node 环境下 `DOMException` 可能存在也可能不存在）。 */
function isDomException(error: unknown): error is DOMException {
  return typeof DOMException !== 'undefined' && error instanceof DOMException;
}

/** 错误可读化（detail 用，不进 UI 主文案）。 */
function describeError(error: unknown): string {
  if (isDomException(error)) return `${error.name}: ${error.message}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * IndexedDB 异常 → 可读错误（架构 §14.3：每个 E_* 只在一个模块产生）。
 *
 * **两类失败必须分开**（用户该做的事完全不同）：
 * - `QuotaExceededError` → `E_QUOTA_EXCEEDED`：空间不够，可"清理旧缩略图"后重试；
 * - 没有 IndexedDB / 版本冲突 / 被占用 → `E_IDB_UNAVAILABLE`：清理与重试都无效，只能换环境。
 * - `NotAllowedError` / `SecurityError` → `E_PERMISSION_DENIED`。
 */
export function mapIdbError(error: unknown): VEditorError {
  if (isDomException(error)) {
    if (error.name === 'QuotaExceededError') {
      return makeError(
        'E_QUOTA_EXCEEDED',
        '存储空间不足：工程未能保存（可清理旧缩略图后重试）',
        describeError(error),
      );
    }
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return makeError('E_PERMISSION_DENIED', '浏览器拒绝本地存储访问，工程无法自动保存', describeError(error));
    }
    if (error.name === 'VersionError') {
      return makeError(
        'E_IDB_UNAVAILABLE',
        '本地工程数据库版本冲突，请关闭其他编辑窗口后刷新',
        describeError(error),
      );
    }
  }
  return makeError('E_IDB_UNAVAILABLE', '本地存储不可用，工程未能保存', describeError(error));
}

/** IDBRequest → Promise。 */
function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'));
  });
}

/** 事务完成 → Promise（保证写入真正落盘后才 resolve）。 */
function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB 事务失败'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 事务被中止'));
  });
}

export interface VeditorDb {
  readonly name: string;
  readonly version: number;
  open(): Promise<Result<IDBDatabase>>;
  get<T>(store: ObjectStoreName, key: IDBValidKey): Promise<Result<T | undefined>>;
  put(store: ObjectStoreName, key: IDBValidKey, value: unknown): Promise<Result<void>>;
  delete(store: ObjectStoreName, key: IDBValidKey): Promise<Result<void>>;
  clear(store: ObjectStoreName): Promise<Result<void>>;
  keys(store: ObjectStoreName): Promise<Result<IDBValidKey[]>>;
  close(): void;
}

/**
 * 创建 DB 句柄（同一实例复用一条连接；失败后下次调用自动重试）。
 *
 * @param name 数据库名（测试可传独立名字隔离）。
 */
export function createDb(name: string = DB_NAME): VeditorDb {
  let connection: IDBDatabase | null = null;
  let opening: Promise<Result<IDBDatabase>> | null = null;

  function open(): Promise<Result<IDBDatabase>> {
    if (connection) return Promise.resolve(ok(connection));
    if (opening) return opening;

    if (typeof indexedDB === 'undefined') {
      return Promise.resolve(
        fail(makeError('E_IDB_UNAVAILABLE', '当前环境不支持 IndexedDB，工程无法自动保存')),
      );
    }

    opening = new Promise<Result<IDBDatabase>>((resolve) => {
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(name, DB_VERSION);
      } catch (error) {
        opening = null;
        resolve(fail(mapIdbError(error)));
        return;
      }

      request.onupgradeneeded = () => {
        const database = request.result;
        for (const store of OBJECT_STORES) {
          // version 1 一次性建齐 4 个 store（out-of-line key，key 与 value 分离）
          if (!database.objectStoreNames.contains(store)) {
            database.createObjectStore(store);
          }
        }
      };

      request.onsuccess = () => {
        connection = request.result;
        // 连接被其他标签页的升级打断时，下次 open 重新建连
        connection.onversionchange = () => {
          connection?.close();
          connection = null;
          opening = null;
        };
        opening = null;
        resolve(ok(connection));
      };

      request.onerror = () => {
        opening = null;
        resolve(fail(mapIdbError(request.error)));
      };

      request.onblocked = () => {
        opening = null;
        resolve(
          fail(
            makeError(
              'E_IDB_UNAVAILABLE',
              '本地数据库被其他标签页占用，请关闭其他编辑窗口后重试',
            ),
          ),
        );
      };
    });

    return opening;
  }

  async function withStore<T>(
    storeName: ObjectStoreName,
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => Promise<T>,
  ): Promise<Result<T>> {
    const opened = await open();
    if (!opened.ok) return fail(opened.error);
    try {
      const transaction = opened.value.transaction(storeName, mode);
      const result = await action(transaction.objectStore(storeName));
      await transactionDone(transaction);
      return ok(result);
    } catch (error) {
      return fail(mapIdbError(error));
    }
  }

  return {
    name,
    version: DB_VERSION,
    open,
    get<T>(storeName: ObjectStoreName, key: IDBValidKey): Promise<Result<T | undefined>> {
      return withStore(storeName, 'readonly', async (store) =>
        (await requestToPromise(store.get(key))) as T | undefined,
      );
    },
    put(storeName: ObjectStoreName, key: IDBValidKey, value: unknown): Promise<Result<void>> {
      return withStore(storeName, 'readwrite', async (store) => {
        await requestToPromise(store.put(value, key));
      });
    },
    delete(storeName: ObjectStoreName, key: IDBValidKey): Promise<Result<void>> {
      return withStore(storeName, 'readwrite', async (store) => {
        await requestToPromise(store.delete(key));
      });
    },
    clear(storeName: ObjectStoreName): Promise<Result<void>> {
      return withStore(storeName, 'readwrite', async (store) => {
        await requestToPromise(store.clear());
      });
    },
    keys(storeName: ObjectStoreName): Promise<Result<IDBValidKey[]>> {
      return withStore(storeName, 'readonly', async (store) =>
        (await requestToPromise(store.getAllKeys())) as IDBValidKey[],
      );
    },
    close(): void {
      connection?.close();
      connection = null;
      opening = null;
    },
  };
}

/** 应用单例（persist 层唯一入口）。 */
export const db: VeditorDb = createDb();
