/**
 * 工程历史备份单测：`persist/backup.ts`（写入 / 列表 / 滚动清理 / 内容跳过 / 回退前与退出前强制写 / 到期判定）。
 *
 * 用**内存版假 VeditorDb**（Map 实现 get/put/delete/keys，与 db.ts 的接口子集一致）——
 * 既有测试没有假 IDB 先例，这里建一个最小实现（50 行），只实现 backup.ts 用到的方法。
 *
 * 运行：`node tests/backup.test.mjs`
 */
import { buildSync } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..');
const TMP_DIR = path.join(HERE, '.tmp');

function loadTsModule(relativeEntry, name) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const outfile = path.join(TMP_DIR, `${name}.mjs`);
  buildSync({
    absWorkingDir: ROOT,
    entryPoints: [relativeEntry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
  });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

const backup = await loadTsModule('src/persist/backup.ts', 'backup');

/** 内存版假 VeditorDb（backup.ts 只用 get/put/delete/keys）。 */
function fakeDb() {
  const stores = new Map();
  const storeOf = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  return {
    async get(store, key) {
      return { ok: true, value: storeOf(store).has(key) ? structuredClone(storeOf(store).get(key)) : undefined };
    },
    async put(store, key, value) {
      storeOf(store).set(key, structuredClone(value));
      return { ok: true, value: undefined };
    },
    async delete(store, key) {
      storeOf(store).delete(key);
      return { ok: true, value: undefined };
    },
    async clear(store) {
      storeOf(store).clear();
      return { ok: true, value: undefined };
    },
    async keys(store) {
      return { ok: true, value: [...storeOf(store).keys()] };
    },
  };
}

/** 造一份最小工程（updatedAt 是"内容变化"的判据）。 */
function makeProject(id, updatedAt, patch = {}) {
  return {
    id,
    schemaVersion: 1,
    width: 1920,
    height: 1080,
    fpsMilli: 30000,
    zoomLevel: 1,
    playheadFrame: 0,
    updatedAt,
    tracks: [],
    assets: [],
    ...patch,
  };
}

let passed = 0;
const failures = [];
const queue = [];
const section = (title) => queue.push({ title });
const test = (name, fn) => queue.push({ name, fn });
const eq = (actual, expected, label) => {
  if (!Object.is(actual, expected)) {
    throw new Error(`${label}：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
};

/* ---------------- ① 写入与列表 ---------------- */

section('① 写入与列表');

test('写入后能按新→旧列出', async () => {
  const db = fakeDb();
  await backup.writeBackup(makeProject('p1', 100), 'auto', db, { now: 1000 });
  await backup.writeBackup(makeProject('p1', 200), 'auto', db, { now: 2000 });
  const list = await backup.listBackups('p1', db);
  eq(list.ok, true, 'list ok');
  eq(list.value.length, 2, '数量');
  eq(list.value[0].project.updatedAt, 200, '最新在前');
  eq(list.value[1].project.updatedAt, 100, '最旧在后');
  eq(list.value[0].reason, 'auto', '原因');
});

test('不同工程的备份互不可见（键前缀隔离）', async () => {
  const db = fakeDb();
  await backup.writeBackup(makeProject('p1', 100), 'auto', db, { now: 1000 });
  await backup.writeBackup(makeProject('p2', 200), 'auto', db, { now: 2000 });
  eq((await backup.listBackups('p1', db)).value.length, 1, 'p1');
  eq((await backup.listBackups('p2', db)).value.length, 1, 'p2');
});

/* ---------------- ② 内容跳过与强制写 ---------------- */

section('② 内容跳过与强制写');

test('auto：内容无变化（updatedAt 相同）跳过', async () => {
  const db = fakeDb();
  const first = await backup.writeBackup(makeProject('p1', 100), 'auto', db, { now: 1000 });
  eq(first.value === null, false, '首份必写');
  const second = await backup.writeBackup(makeProject('p1', 100), 'auto', db);
  eq(second.value, null, '重复跳过');
  eq((await backup.listBackups('p1', db)).value.length, 1, '仍 1 份');
});

test('before-exit / before-restore：即使内容相同也强制写', async () => {
  const db = fakeDb();
  await backup.writeBackup(makeProject('p1', 100), 'before-exit', db, { now: 1000 });
  const again = await backup.writeBackup(makeProject('p1', 100), 'before-exit', db, { now: 2000 });
  eq(again.value === null, false, '强制写');
  eq((await backup.listBackups('p1', db)).value.length, 2, '两份都在');
  eq((await backup.listBackups('p1', db)).value[0].reason, 'before-exit', '原因记录');
});

/* ---------------- ③ 滚动清理 ---------------- */

section('③ 滚动清理');

test('超过 20 份删最旧（注入时间戳保证键不撞）', async () => {
  const db = fakeDb();
  for (let index = 0; index < 23; index += 1) {
    const result = await backup.writeBackup(
      makeProject('p1', 1000 + index),
      'auto',
      db,
      { now: 1_000_000 + index },
    );
    if (!result.ok) throw new Error(`写入失败：${result.error?.message}`);
  }
  const list = await backup.listBackups('p1', db);
  eq(list.value.length, 20, '滚动上限 20');
  // 最旧的 3 份（updatedAt 1000–1002）应被删掉
  eq(list.value[list.value.length - 1].project.updatedAt, 1003, '最旧幸存者');
  eq(list.value[0].project.updatedAt, 1022, '最新幸存者');
});

test('清理只动自己工程的备份', async () => {
  const db = fakeDb();
  await backup.writeBackup(makeProject('p2', 1), 'auto', db, { now: 5000 });
  for (let index = 0; index < 22; index += 1) {
    await backup.writeBackup(makeProject('p1', 100 + index), 'auto', db, { now: 10000 + index });
  }
  eq((await backup.listBackups('p2', db)).value.length, 1, 'p2 不被清理');
});

/* ---------------- ④ 到期判定（纯函数） ---------------- */

section('④ 到期判定');

test('无备份 → 到期', () => {
  eq(backup.isBackupDue(null, makeProject('p1', 100), 999999), true, 'null');
});

test('距上次超过间隔且内容有变化 → 到期', () => {
  const latest = { key: 'p1|1', projectId: 'p1', savedAt: 1000, reason: 'auto', project: makeProject('p1', 100) };
  eq(backup.isBackupDue(latest, makeProject('p1', 200), 1000 + backup.BACKUP_INTERVAL_MS), true, '到期');
});

test('间隔未到 / 内容没变 → 不到期', () => {
  const latest = { key: 'p1|1', projectId: 'p1', savedAt: 1000, reason: 'auto', project: makeProject('p1', 100) };
  eq(backup.isBackupDue(latest, makeProject('p1', 200), 1000 + backup.BACKUP_INTERVAL_MS - 1), false, '间隔未到');
  eq(
    backup.isBackupDue(latest, makeProject('p1', 100), 1000 + backup.BACKUP_INTERVAL_MS + 5),
    false,
    '内容没变',
  );
});

/* ---------------- ⑤ 读回与清空 ---------------- */

section('⑤ 读回与清空');

test('loadBackup 返回工程快照（schema 已校正）', async () => {
  const db = fakeDb();
  const written = await backup.writeBackup(makeProject('p1', 100), 'before-restore', db);
  const project = await backup.loadBackup(written.value.key, db);
  eq(project.value.updatedAt, 100, 'updatedAt');
  eq(project.value.schemaVersion, 1, 'schemaVersion');
});

test('clearBackups 清空本工程全部备份', async () => {
  const db = fakeDb();
  await backup.writeBackup(makeProject('p1', 100), 'auto', db, { now: 1000 });
  await backup.writeBackup(makeProject('p1', 200), 'auto', db, { now: 2000 });
  await backup.clearBackups('p1', db);
  eq((await backup.listBackups('p1', db)).value.length, 0, '清空');
});

/* ---------------- 顺序执行 + 汇总 ---------------- */

for (const item of queue) {
  if (item.title !== undefined) {
    console.log(item.title);
    continue;
  }
  try {
    await item.fn();
    passed += 1;
    console.log(`  ✓ ${item.name}`);
  } catch (error) {
    failures.push({ name: item.name, message: error instanceof Error ? error.message : String(error) });
    console.log(`  ✗ ${item.name}`);
    console.log(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log('');
if (failures.length === 0) {
  console.log(`✓ 工程备份单测：通过 ${passed} / ${passed}`);
  process.exit(0);
} else {
  console.log(`✗ 工程备份单测：${failures.length} 项失败`);
  for (const item of failures) console.log(`  - ${item.name}：${item.message}`);
  process.exit(1);
}
