/**
 * 「清空本地数据」的**唯一实现**（设置面板「关于」组用）。
 *
 * ## 清哪三份数据
 *
 * | 位置 | 里面有什么 | 清掉后的表现 |
 * |---|---|---|
 * | `localStorage`（`veditor:` 前缀）| 偏好、上次停留的 Tab、折叠态、字幕视图 | 回到出厂默认 |
 * | IndexedDB（库名 `veditor`）| 工程草稿、素材句柄、缩略图、代理媒体、主题 | 工程回到空白 |
 * | OPFS 缓存池 | 导入素材的本地副本 | 素材要重新从磁盘导入 |
 *
 * **源文件永远不动**：这里清的全是应用自己复制的副本。所以文案必须说清
 * "素材原文件不受影响，重新导入即可"—— 否则用户会以为素材被删了。
 *
 * ## 为什么不用 `localStorage.clear()`
 *
 * `clear()` 会连**其它应用/调试脚本**在同一 origin 下写的东西一起清掉。
 * 只删 `veditor:` 前缀的键，范围可解释、可测。
 *
 * ## 为什么删完要立刻刷新
 *
 * 内存里的 store / 解码器池 / 缓存后端仍持有旧状态（删库后它们的句柄是废的）。
 * 刷新是最可靠的重置方式，比逐个 `resetXxx()` 少一半出错机会。
 */
import { DB_NAME, db } from '../../persist/db';
import { clearCachePool, isCacheAvailable } from '../../media/draftCache';

/** 本应用写进 localStorage 的键前缀（`veditor:leftTab` / `veditor:prefs` …）。 */
export const LOCAL_KEY_PREFIX = 'veditor:';

export interface ClearResult {
  /** 清掉的 localStorage 键数量。 */
  storageKeys: number;
  /** IndexedDB 库是否删除成功（被其它标签页占用时可能为 false）。 */
  idb: boolean;
  /** OPFS 缓存池是否清空（环境不支持缓存时为 false）。 */
  cache: boolean;
}

/** 当前会被清掉的 localStorage 键（面板上要**如实列出数量**，不能只说"清空数据"）。 */
export function localDataKeys(): string[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key !== null && key.startsWith(LOCAL_KEY_PREFIX)) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}

function removeLocalKeys(): number {
  const keys = localDataKeys();
  try {
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // 隐私模式 / 配额异常：删不掉也不该拦住后面的步骤
  }
  return keys.length;
}

/** 删除整个 IndexedDB 库（先关连接，否则 `deleteDatabase` 会一直被 block）。 */
async function deleteDatabase(): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  try {
    db.close();
  } catch {
    // 连接已经坏了：继续删库
  }
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => finish(true);
      request.onerror = () => finish(false);
      // 其它标签页还开着 → 会被 block。不无限等：3 秒后按"未清干净"返回，
      // 让面板如实提示"请关闭其它编辑窗口"，而不是假装成功。
      request.onblocked = () => finish(false);
      setTimeout(() => finish(false), 3000);
    } catch {
      finish(false);
    }
  });
}

/**
 * 清空三类本地数据。**任何一步失败都不抛**（返回 false 由界面如实说明）。
 */
export async function clearLocalData(): Promise<ClearResult> {
  const storageKeys = removeLocalKeys();
  const idb = await deleteDatabase();
  let cache = false;
  if (isCacheAvailable()) {
    try {
      await clearCachePool();
      cache = true;
    } catch {
      cache = false;
    }
  }
  return { storageKeys, idb, cache };
}
