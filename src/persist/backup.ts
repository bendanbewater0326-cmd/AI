/**
 * 工程**历史备份**（每 5 分钟一份 + 回退前/退出前强制一份，滚动保留 20 份）。
 *
 * ## 与自动保存的分工（两条线互不替代）
 *
 * 自动保存（`persist/autosave.ts`）是 500ms 防抖的**单槽覆盖写**——只保"现在"，
 * 崩溃/误操作之前的版本永远找不回来。本模块是旁路的**历史线**：
 * 同一份工程 JSON 按时间留档，供「工程 → 历史版本…」回退。
 *
 * ## 为什么只存工程 JSON
 *
 * 备份不含素材字节（素材走既有五层恢复链路：草稿缓存/句柄/重链）。
 * 快照恢复后若素材离线，走既有的"素材离线"提示——那套链路已经把这件事处理好了。
 *
 * ## 键设计
 *
 * `projectId|savedAt(14 位零填充)`：同一工程的所有备份共享前缀（按工程清理方便），
 * 字典序即时间序（排序不需要解析时间戳）。
 */
import type { Project, Result } from '../core/types';
import { ok } from '../core/types';
import type { VeditorDb } from './db';
import { STORE_PROJECT_BACKUPS } from './db';
import { SCHEMA_VERSION } from './autosave';

/** 自动备份间隔（用户拍板：5 分钟）。 */
export const BACKUP_INTERVAL_MS = 5 * 60 * 1000;
/** 每个工程滚动保留的份数（用户拍板：20 份）。 */
export const BACKUPS_KEEP_PER_PROJECT = 20;

export type BackupReason = 'auto' | 'before-restore' | 'before-exit';

export interface BackupEntry {
  projectId: string;
  /** `projectId|savedAt`。 */
  key: string;
  savedAt: number;
  reason: BackupReason;
  project: Project;
}

interface BackupValue {
  projectId: string;
  savedAt: number;
  reason: BackupReason;
  project: Project;
}

function backupKey(projectId: string, savedAt: number): string {
  return `${projectId}|${String(savedAt).padStart(14, '0')}`;
}

function backupPrefix(projectId: string): string {
  return `${projectId}|`;
}

function asEntry(key: string, value: unknown): BackupEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<BackupValue>;
  if (
    typeof candidate.projectId !== 'string' ||
    typeof candidate.savedAt !== 'number' ||
    typeof candidate.reason !== 'string' ||
    typeof candidate.project !== 'object' ||
    candidate.project === null
  ) {
    return null;
  }
  const reason = candidate.reason as BackupReason;
  if (reason !== 'auto' && reason !== 'before-restore' && reason !== 'before-exit') return null;
  return { key, projectId: candidate.projectId, savedAt: candidate.savedAt, reason, project: candidate.project };
}

/**
 * 列出某工程的全部备份（新 → 旧）。坏条目静默跳过（不让一条坏数据把列表带崩）。
 */
export async function listBackups(
  projectId: string,
  database: VeditorDb,
): Promise<Result<BackupEntry[]>> {
  const keys = await database.keys(STORE_PROJECT_BACKUPS);
  if (!keys.ok) return keys;
  const prefix = backupPrefix(projectId);
  const own = (keys.value as string[])
    .filter((key) => key.startsWith(prefix))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const entries: BackupEntry[] = [];
  for (const key of own) {
    const stored = await database.get<BackupValue>(STORE_PROJECT_BACKUPS, key);
    if (!stored.ok) return stored;
    const entry = asEntry(key, stored.value);
    if (entry !== null) entries.push(entry);
  }
  return ok(entries);
}

/** 读一份备份的工程快照（键来自 `listBackups`）。 */
export async function loadBackup(
  key: string,
  database: VeditorDb,
): Promise<Result<Project | null>> {
  const stored = await database.get<BackupValue>(STORE_PROJECT_BACKUPS, key);
  if (!stored.ok) return stored;
  const entry = asEntry(key, stored.value);
  return ok(entry === null ? null : entry.project);
}

/**
 * 内容比对：**JSON 全文相等**。
 *
 * ⚠️ 不能用 `doc.updatedAt` 判断"内容变没变"——内存 doc 的 `updatedAt` 只在
 * `createProject` 时打一次，store 的任何 dispatch 都不更新它（只有 `saveProject`
 * 写 IDB 时才另盖一份）。拿它当"内容版本号"会让 auto 备份在首份之后永远跳过。
 */
function sameContent(a: Project, b: Project): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 写一份备份。
 *
 * - `auto`：**内容无变化跳过**（与最新一份备份 JSON 全文比对）——
 *   5 分钟一次的定时器在没有编辑的会话里不该产生重复快照；
 * - `before-restore` / `before-exit`：**强制写**（这两个时机的意义就是"无论变没变都留档"）。
 *
 * 写完滚动清理：每工程只留最近 `BACKUPS_KEEP_PER_PROJECT` 份（删最旧）。
 */
export async function writeBackup(
  project: Project,
  reason: BackupReason,
  database: VeditorDb,
  options: { now?: number; keep?: number } = {},
): Promise<Result<BackupEntry | null>> {
  if (reason === 'auto') {
    const latest = await latestBackup(project.id, database);
    if (!latest.ok) return latest;
    if (latest.value !== null && sameContent(latest.value.project, project)) {
      return ok(null); // 内容没变，不产生重复快照
    }
  }
  const savedAt = options.now ?? Date.now();
  const value: BackupValue = {
    projectId: project.id,
    savedAt,
    reason,
    project: { ...project, schemaVersion: SCHEMA_VERSION },
  };
  const put = await database.put(STORE_PROJECT_BACKUPS, backupKey(project.id, savedAt), value);
  if (!put.ok) return put;
  const pruned = await pruneBackups(project.id, options.keep ?? BACKUPS_KEEP_PER_PROJECT, database);
  if (!pruned.ok) return pruned;
  return ok({ projectId: project.id, key: backupKey(project.id, savedAt), savedAt, reason, project: value.project });
}

/** 最新一份备份（没有则 null）。 */
export async function latestBackup(
  projectId: string,
  database: VeditorDb,
): Promise<Result<BackupEntry | null>> {
  const list = await listBackups(projectId, database);
  if (!list.ok) return list;
  return ok(list.value[0] ?? null);
}

/**
 * 定时器到点该不该备份（纯函数，B2 的定时接线用）：
 * 距上一份备份超过间隔 **且** 内容有变化（JSON 全文比对，见 `sameContent`）。
 */
export function isBackupDue(
  latest: BackupEntry | null,
  project: Project,
  now: number,
  intervalMs: number = BACKUP_INTERVAL_MS,
): boolean {
  if (latest === null) return true;
  if (sameContent(latest.project, project)) return false;
  return now - latest.savedAt >= intervalMs;
}

/**
 * 滚动清理：每工程只留最近 `keep` 份。
 */
export async function pruneBackups(
  projectId: string,
  keep: number = BACKUPS_KEEP_PER_PROJECT,
  database: VeditorDb,
): Promise<Result<number>> {
  const list = await listBackups(projectId, database);
  if (!list.ok) return list;
  let removed = 0;
  for (const entry of list.value.slice(keep)) {
    const deleted = await database.delete(STORE_PROJECT_BACKUPS, entry.key);
    if (!deleted.ok) return deleted;
    removed += 1;
  }
  return ok(removed);
}

/**
 * 退出前备份（用户补充拍板的边界场景）：`pagehide`/关闭前调用，尽力写一份。
 *
 * **如实说明可靠性边界**：浏览器不保证卸载路径上的 IndexedDB 事务一定落盘
 * （Chrome/Edge 的 pagehide 里通常能完成，但这是"尽力而为"不是契约）——
 * 所以它是"降低丢失概率"的兜底，不能替代 5 分钟定时备份。
 * 写失败**静默**：卸载路径上没有 UI 可以呈现错误。
 */
export async function writeExitBackup(project: Project, database: VeditorDb): Promise<void> {
  try {
    const result = await writeBackup(project, 'before-exit', database);
    if (!result.ok) return; // 卸载路径：静默
  } catch {
    // 同上
  }
}

/** 供测试/管理界面使用的清空（按工程）。 */
export async function clearBackups(projectId: string, database: VeditorDb): Promise<Result<void>> {
  const list = await listBackups(projectId, database);
  if (!list.ok) return list;
  for (const entry of list.value) {
    const deleted = await database.delete(STORE_PROJECT_BACKUPS, entry.key);
    if (!deleted.ok) return deleted;
  }
  return ok(undefined);
}
