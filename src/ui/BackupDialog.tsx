/**
 * 「历史版本」面板（工程自动备份的回退入口）。
 *
 * ## 交互语义（用户拍板）
 *
 * - 列出当前工程的备份（新 → 旧，滚动保留 20 份）；
 * - 「恢复此版本」：**先给当前状态拍一份「回退前快照」再载入备份**——所以回退
 *   永远可以反悔（误点了也能从列表里找回"回退前"那份），不需要二次确认弹窗；
 * - 恢复走**现有的工程载入路径**（`resetPreviewSources` + `store.replaceDoc`，与
 *   打开 .vedproj 文件同一条链路），不新写载入逻辑；
 * - 备份只含工程 JSON：恢复后素材若离线，走既有的"素材离线"提示（列表下方写明）。
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { makeError } from '../core/types';
import { store } from '../core/store';
import { db } from '../persist/db';
import { listBackups, loadBackup, writeBackup } from '../persist/backup';
import type { BackupEntry } from '../persist/backup';
import { resetPreviewSources } from '../media/previewSource';

export interface BackupDialogProps {
  open: boolean;
  onClose: () => void;
}

const REASON_LABELS: Record<BackupEntry['reason'], string> = {
  auto: '自动备份',
  'before-restore': '回退前快照',
  'before-exit': '退出前备份',
};

function formatTime(savedAt: number): string {
  const date = new Date(savedAt);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function BackupDialog({ open, onClose }: BackupDialogProps): ReactElement | null {
  const [entries, setEntries] = useState<BackupEntry[] | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setEntries(null);
    setMessage(null);
    void listBackups(store.getDoc().id, db).then((result) => {
      if (result.ok) setEntries(result.value);
      else {
        setEntries([]);
        setMessage(result.error.message);
      }
    });
  }, [open]);

  if (!open) return null;

  /** 恢复：回退前先拍当前快照（永远可反悔），再载入备份。 */
  function restore(entry: BackupEntry): void {
    if (restoring !== null) return;
    setRestoring(entry.key);
    void (async () => {
      const current = store.getDoc();
      // **无条件**先拍"回退前快照"（回退永远可反悔）。
      // 不要试图用 doc.updatedAt 判断"内容变没变"来省这一份——内存 doc 的
      // updatedAt 只在创建时打一次（store 不更新它），拿它比较永远相等。
      await writeBackup(current, 'before-restore', db);
      const loaded = await loadBackup(entry.key, db);
      if (!loaded.ok) {
        store.pushError(loaded.error);
        setRestoring(null);
        return;
      }
      if (loaded.value === null) {
        store.pushError(makeError('E_INVALID_PROJECT', '这份备份读不出来了', entry.key));
        setRestoring(null);
        return;
      }
      resetPreviewSources();
      store.replaceDoc(loaded.value);
      setRestoring(null);
      onClose();
    })();
  }

  return (
    <div className="v-dialog" role="dialog" aria-modal="true" aria-label="历史版本" data-v="backup-dialog">
      <div className="v-dialog__title">历史版本</div>
      <p className="v-dialog__hint" data-v="backup-hint">
        每 5 分钟自动留一份（滚动保留 20 份），恢复前会先给当前状态拍一份快照，可随时再找回。
        备份不含素材文件本身：恢复后若素材离线，按提示重新链接即可。
      </p>
      {entries === null ? (
        <div className="v-dialog__hint" data-v="backup-loading">正在读取历史版本…</div>
      ) : entries.length === 0 ? (
        <div className="v-dialog__hint" data-v="backup-empty">
          还没有历史版本。继续剪辑 5 分钟后会自动出现第一份。
        </div>
      ) : (
        <div className="v-backup__list" data-v="backup-list">
          {entries.map((entry, index) => (
            <div className="v-backup__row" data-v="backup-item" key={entry.key}>
              <span className="v-backup__time">{formatTime(entry.savedAt)}</span>
              <span className="v-backup__reason">
                {REASON_LABELS[entry.reason]}
                {index === 0 ? ' · 最新' : ''}
              </span>
              <button
                type="button"
                className="v-dialog__primary v-backup__restore"
                data-v="backup-restore"
                disabled={restoring !== null}
                onClick={() => restore(entry)}
              >
                {restoring === entry.key ? '恢复中…' : '恢复此版本'}
              </button>
            </div>
          ))}
        </div>
      )}
      {message !== null ? (
        <div className="v-export__message v-export__message--error" data-v="backup-error">{message}</div>
      ) : null}
      <div className="v-dialog__actions">
        <button type="button" onClick={onClose} data-v="backup-close">关闭</button>
      </div>
    </div>
  );
}
