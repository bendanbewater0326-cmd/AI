/**
 * 「素材缓存」设置面板（本地草稿缓存池的管理入口）。
 *
 * ## 为什么必须给用户一个可见的入口
 *
 * 缓存池会**悄悄占用磁盘**（一份 2GB 素材就是 2GB）。没有管理入口的自动缓存
 * 迟早变成"用户发现 C 盘满了却不知道为什么"—— 那是比"刷新丢素材"更糟的体验。
 *
 * 所以这个面板只做四件事，一件都不多：
 * 1. 说清缓存放在哪（OPFS / 宿主目录）、占了多少、几个文件；
 * 2. **开关**（关掉后新导入不再缓存，行为与旧版本一致）；
 * 3. 清理"当前工程没引用"的；
 * 4. 清空全部（二次确认）。
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { store } from '../core/store';
import {
  cacheStats,
  clearCachePool,
  currentBackend,
  inUseCacheNames,
  isAutoCacheEnabled,
  isCacheAvailable,
  removeCachedAsset,
  setAutoCacheEnabled,
  unusedEntries,
} from '../media/draftCache';
import type { CacheStats } from '../media/draftCache';

export interface CacheDialogProps {
  open: boolean;
  onClose: () => void;
}

/** 字节数 → 人能读的大小。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function CacheDialog({ open, onClose }: CacheDialogProps): ReactElement | null {
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const available = isCacheAvailable();
  const backendKind = currentBackend()?.kind ?? null;

  async function refresh(): Promise<void> {
    setStats(await cacheStats());
  }

  useEffect(() => {
    if (!open) return;
    setEnabled(isAutoCacheEnabled());
    setConfirmClear(false);
    setMessage('');
    void refresh();
  }, [open]);

  if (!open) return null;

  async function cleanUnused(): Promise<void> {
    setBusy(true);
    try {
      const current = await cacheStats();
      const inUse = inUseCacheNames(store.getDoc().assets);
      const dead = unusedEntries(current.entries, inUse);
      for (const entry of dead) await removeCachedAsset(entry.name);
      setMessage(`已清理 ${dead.length} 个未被当前工程引用的缓存（${formatBytes(dead.reduce((sum, item) => sum + item.size, 0))}）`);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function clearAll(): Promise<void> {
    setBusy(true);
    try {
      await clearCachePool();
      setMessage('缓存已清空。已导入的素材不受影响，只是下次刷新要靠原文件恢复。');
      setConfirmClear(false);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="v-dialog" role="dialog" aria-modal="true" aria-label="素材缓存" data-v="cache-dialog">
      <div className="v-dialog__title">素材缓存</div>

        {!available ? (
          <p className="v-dialog__hint" data-v="cache-unavailable">
            当前环境不支持本地缓存（浏览器没有 OPFS、宿主也没有提供缓存接口）。
            素材恢复会走"文件句柄 / 授权目录"的老路径，其余功能不受影响。
          </p>
        ) : (
          <>
            <p className="v-dialog__hint" data-v="cache-location">
              缓存位置：{backendKind === 'host' ? '应用数据目录 drafts/assets' : '浏览器私有存储（OPFS）'}
              。导入过的素材会复制一份到这里，<strong>刷新后不再依赖源文件是否还在原地</strong>。
            </p>

            <div className="v-dialog__stats" data-v="cache-stats">
              <span data-v="cache-count">文件 {stats?.count ?? 0} 个</span>
              <span data-v="cache-size">占用 {formatBytes(stats?.bytes ?? 0)}</span>
            </div>

            <label className="v-dialog__field v-dialog__field--row">
              <input
                type="checkbox"
                data-v="cache-auto-toggle"
                checked={enabled}
                onChange={(event) => {
                  setEnabled(event.target.checked);
                  setAutoCacheEnabled(event.target.checked);
                  setMessage(
                    event.target.checked
                      ? '已开启：新导入的素材会在后台复制一份到缓存'
                      : '已关闭：新导入的素材不再缓存（已有缓存保留，可用下面按钮清理）',
                  );
                }}
              />
              <span>自动缓存新导入的素材</span>
            </label>

            <div className="v-dialog__actions v-dialog__actions--wrap">
              <button
                type="button"
                data-v="cache-clean-unused"
                disabled={busy}
                onClick={() => void cleanUnused()}
              >
                清理未使用素材
              </button>
              {confirmClear ? (
                <>
                  <button type="button" className="v-dialog__danger" data-v="cache-clear-confirm" disabled={busy} onClick={() => void clearAll()}>
                    确认清空全部
                  </button>
                  <button type="button" disabled={busy} onClick={() => setConfirmClear(false)}>
                    取消
                  </button>
                </>
              ) : (
                <button type="button" data-v="cache-clear" disabled={busy} onClick={() => setConfirmClear(true)}>
                  清空全部缓存
                </button>
              )}
            </div>
          </>
        )}

        {message === '' ? null : (
          <p className="v-dialog__hint" data-v="cache-message">
            {message}
          </p>
        )}

      <div className="v-dialog__actions">
        <button type="button" data-v="cache-close" onClick={onClose}>
          关闭
        </button>
      </div>
    </div>
  );
}
