/**
 * 自动恢复（第二层：静默扫描授权目录）的单测。
 *
 * ## 为什么这块必须单测
 *
 * "扫描目录"是唯一一处**在没有用户确认的情况下决定链哪个文件**的代码。
 * 扫错一个文件 = 画面换成另一段素材，用户可能到导出后才发现。
 * 所以它的三个约束必须钉死：
 * 1. 只收**音视频扩展名**（不能把 `.DS_Store` 当候选）；
 * 2. 只递归到**一层**（深扫一个几万文件的目录会把页面卡死）；
 * 3. 单个文件读失败**不影响其它**（一个坏文件不能中断整次扫描）。
 *
 * 运行：`node tests/auto-restore.test.mjs`
 */
import { buildSync } from 'esbuild';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..');
const TMP_DIR = path.join(HERE, '.tmp');

function load(relativeEntry, name) {
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

const auto = await load('src/media/autoRestore.ts', 'autoRestore');
const hostFiles = await load('src/media/hostFiles.ts', 'hostFiles');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}
const eq = (a, b, m) => assert.deepStrictEqual(a, b, m);
const ok = (value, m) => assert.ok(value, m);

/**
 * 造一个假的目录句柄。
 *
 * `entries` 是 `{ name, kind, file?, throwOnGet? }`；目录项递归构造。
 */
function fakeDirectory(name, entries) {
  return {
    name,
    kind: 'directory',
    async *values() {
      for (const entry of entries) {
        if (entry.kind === 'directory') {
          yield fakeDirectory(entry.name, entry.entries ?? []);
          continue;
        }
        yield {
          name: entry.name,
          kind: 'file',
          getFile: async () => {
            if (entry.throwOnGet === true) throw new Error('读不了');
            return new Blob([entry.name], { type: 'video/mp4' });
          },
        };
      }
    },
  };
}

console.log('[1] 目录扫描');

await test('①a 只收音视频扩展名', async () => {
  const dir = fakeDirectory('素材', [
    { name: 'a.mp4', kind: 'file' },
    { name: 'b.MOV', kind: 'file' },
    { name: 'notes.txt', kind: 'file' },
    { name: '.DS_Store', kind: 'file' },
    { name: 'cover.jpg', kind: 'file' },
  ]);
  const found = await auto.scanDirectoryHandle(dir, 0);
  eq(found.map((item) => item.path).sort(), ['a.mp4', 'b.MOV'].sort());
});

await test('①b 递归一层，但不超过', async () => {
  const dir = fakeDirectory('素材', [
    { name: 'top.mp4', kind: 'file' },
    {
      name: 'sub',
      kind: 'directory',
      entries: [
        { name: 'inner.mp4', kind: 'file' },
        {
          name: 'deep',
          kind: 'directory',
          entries: [{ name: 'too-deep.mp4', kind: 'file' }],
        },
      ],
    },
  ]);
  const found = await auto.scanDirectoryHandle(dir, 1);
  const paths = found.map((item) => item.path).sort();
  eq(paths, ['sub/inner.mp4', 'top.mp4']);
  ok(!paths.includes('sub/deep/too-deep.mp4'), '不该扫到第三层');
});

await test('①c 每个候选都带句柄（批量重链后不落 memory 模式）', async () => {
  const dir = fakeDirectory('素材', [{ name: 'a.mp4', kind: 'file' }]);
  const found = await auto.scanDirectoryHandle(dir, 0);
  eq(found.length, 1);
  ok(found[0].handle !== null && found[0].handle !== undefined, '候选必须带句柄');
  ok(typeof found[0].handle.getFile === 'function');
});

await test('①d 单个文件读失败不影响其它', async () => {
  const dir = fakeDirectory('素材', [
    { name: 'bad.mp4', kind: 'file', throwOnGet: true },
    { name: 'good.mp4', kind: 'file' },
  ]);
  const found = await auto.scanDirectoryHandle(dir, 0);
  eq(found.map((item) => item.path), ['good.mp4']);
});

await test('①e 没有 values() 的句柄 → 返回空（不抛）', async () => {
  const found = await auto.scanDirectoryHandle({ name: 'x', kind: 'directory' }, 0);
  eq(found, []);
});

await test('①f 候选数量有上限（防止选了巨大目录卡死）', async () => {
  const many = Array.from({ length: 900 }, (_, index) => ({ name: `clip-${index}.mp4`, kind: 'file' }));
  const dir = fakeDirectory('海量', many);
  const found = await auto.scanDirectoryHandle(dir, 0);
  ok(found.length > 0, '应该扫到一些');
  ok(found.length <= 400, `候选数应有上限，实际 ${found.length}`);
});

console.log('\n[2] 编排的边界');

await test('②a 没有离线素材 → 直接返回空报告，不去扫目录', async () => {
  let scannedCalled = false;
  const dir = {
    name: '素材',
    kind: 'directory',
    async *values() {
      scannedCalled = true;
    },
  };
  const report = await auto.autoRestoreFromDirectories({ offline: [], directories: [{ name: '素材', handle: dir }] });
  eq(report.restored, []);
  eq(report.needsManual, []);
  eq(report.scanned, 0);
  eq(scannedCalled, false, '没有离线素材时不该扫目录');
});

await test('②b 没有授权目录 → 第二层跳过（scanned=0，不假装扫过）', async () => {
  const offline = [
    { id: 'ast_1', name: 'a.mp4', hashKey: 'a.mp4|100|0', durationSec: 10 },
  ];
  const report = await auto.autoRestoreFromDirectories({ offline, directories: [] });
  eq(report.scanned, 0);
  eq(report.restored, []);
  eq(report.needsManual, ['ast_1'], '没有目录时所有离线素材都应进"需手动"');
});

await test('②c 目录权限不是 granted → 记为 deniedDirectories，不扫', async () => {
  const dir = {
    name: '素材',
    kind: 'directory',
    queryPermission: async () => 'prompt',
    async *values() {
      throw new Error('不该被调用');
    },
  };
  const report = await auto.autoRestoreFromDirectories({
    offline: [{ id: 'ast_1', name: 'a.mp4', hashKey: 'a.mp4|100|0', durationSec: 10 }],
    directories: [{ name: '素材', handle: dir }],
  });
  eq(report.deniedDirectories, ['素材']);
  eq(report.scanned, 0);
  eq(report.restored, []);
});

console.log('\n[3] 宿主路径（Electron）');

await test('③a 绝对路径被识别（POSIX / Windows 盘符）', async () => {
  eq(hostFiles.hostPathOf({ sourcePath: '/Users/me/素材/a.mp4' }), '/Users/me/素材/a.mp4');
  eq(hostFiles.hostPathOf({ sourcePath: 'D:////素材////a.mp4' }), 'D:////素材////a.mp4');
});

await test('③b 相对路径与空值不认（浏览器 webkitRelativePath 对宿主没意义）', async () => {
  eq(hostFiles.hostPathOf({ sourcePath: '素材/a.mp4' }), null);
  eq(hostFiles.hostPathOf({ sourcePath: '' }), null);
  eq(hostFiles.hostPathOf({ sourcePath: null }), null);
  eq(hostFiles.hostPathOf({}), null);
});

await test('③c 没有宿主 bridge → hasHostFileAccess 为 false（浏览器路径）', async () => {
  eq(hostFiles.hasHostFileAccess(), false);
});

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} 自动恢复单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}`);
    console.error(failure.error);
  }
  process.exit(1);
}
