/**
 * 预设的持久化（R-053）：存在 `settings` store 的 `presets` 键下。
 *
 * 为什么放 settings 而不是新建 store：预设是**用户偏好**，不是工程内容——
 * 换工程也应该还在。settings 是键值表，加一个键不需要动 DB 版本。
 *
 * 读取时必须逐个 `normalizePreset`：旧版本存的字段可能已经变了，
 * 一条坏数据不能把整份预设列表带崩。
 */
import type { Result } from '../core/types';
import { fail, ok } from '../core/types';
import { normalizePreset } from '../core/preset';
import type { Preset } from '../core/preset';
import { MAX_PRESETS } from '../core/preset';
import { STORE_SETTINGS, db as defaultDb } from './db';
import type { VeditorDb } from './db';

export const PRESETS_KEY = 'presets';

/**
 * 预设变更广播。
 *
 * 属性栏与左栏「文本」面板**各有一份列表**，都只在挂载时读一次 ——
 * 在一处新增/删除后，另一处会一直显示旧列表（用户会以为存了但没生效）。
 * 写入成功后广播一次，两边都重新读。
 */
export const PRESETS_CHANGED = 'veditor:presets-changed';

function announcePresetsChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PRESETS_CHANGED));
}
const PRESETS_VERSION = 1;

interface StoredPresets {
  version: number;
  presets: unknown[];
}

/** 读全部预设（坏数据被丢弃，不会抛）。 */
export async function loadPresets(database: VeditorDb = defaultDb): Promise<Preset[]> {
  const stored = await database.get<StoredPresets>(STORE_SETTINGS, PRESETS_KEY);
  if (!stored.ok || stored.value === undefined || stored.value === null) return [];
  const list = Array.isArray(stored.value.presets) ? stored.value.presets : [];
  const presets: Preset[] = [];
  for (const item of list) {
    const preset = normalizePreset(item);
    if (preset !== null) presets.push(preset);
  }
  return presets;
}

async function write(presets: Preset[], database: VeditorDb): Promise<Result<void>> {
  const payload: StoredPresets = { version: PRESETS_VERSION, presets };
  return database.put(STORE_SETTINGS, PRESETS_KEY, payload);
}

/** 新增一条（超出上限时丢弃最旧的）。返回写入后的完整列表。 */
export async function addPreset(
  preset: Preset,
  database: VeditorDb = defaultDb,
): Promise<Result<Preset[]>> {
  const current = await loadPresets(database);
  const next = [preset, ...current.filter((item) => item.id !== preset.id)].slice(0, MAX_PRESETS);
  const written = await write(next, database);
  if (!written.ok) return fail(written.error);
  announcePresetsChanged();
  return ok(next);
}

/** 删除一条，返回写入后的列表。 */
export async function removePreset(
  id: string,
  database: VeditorDb = defaultDb,
): Promise<Result<Preset[]>> {
  const current = await loadPresets(database);
  const next = current.filter((item) => item.id !== id);
  const written = await write(next, database);
  if (!written.ok) return fail(written.error);
  announcePresetsChanged();
  return ok(next);
}
