/**
 * 本地草稿缓存池的单测。
 *
 * ## 为什么这块必须有单测
 *
 * 缓存的失败方式是**静默占空间**：用户看不到、也不该看到过程，
 * 一旦"同一素材存了 3 份"或者"并发没限住把磁盘打满"，
 * 表现是"软件越用越卡、C 盘莫名其妙满了"，极难归因。
 *
 * 所以钉四件事：键的规范化（Windows 文件名安全）、去重（同名只存一份）、
 * 并发上限（2）、以及"没有后端时安静地什么都不做"。
 *
 * 运行：`node tests/draft-cache.test.mjs`
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

const cache = await load('src/media/draftCache.ts', 'draftCache');

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

/** 内存版后端：记录 put 次数与并发峰值。 */
function memoryBackend() {
  const files = new Map();
  let inFlight = 0;
  let peak = 0;
  const puts = [];
  return {
    kind: 'opfs',
    files,
    puts,
    get peak() {
      return peak;
    },
    async put(_key, name, blob) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      puts.push(name);
      await new Promise((resolve) => setTimeout(resolve, 15));
      files.set(name, blob);
      inFlight -= 1;
      return true;
    },
    async get(name) {
      const blob = files.get(name);
      if (blob === undefined) return null;
      return new File([blob], name, { type: 'video/mp4' });
    },
    async has(name) {
      return files.has(name);
    },
    async list() {
      return [...files.entries()].map(([name, blob]) => ({
        key: name.replace(/\.[^.]+$/, ''),
        name,
        size: blob.size,
        lastModified: 0,
      }));
    },
    async remove(name) {
      files.delete(name);
    },
    async clear() {
      files.clear();
    },
  };
}

console.log('[1] 缓存键规范化');

await test('①a 指纹里的冒号被替换（Windows 文件名不允许冒号）', async () => {
  eq(cache.cacheKeyOf('sha256:ab12cd'), 'sha256-ab12cd');
  ok(!cache.cacheKeyOf('sha256:ab12cd').includes(':'), '不能有冒号');
});

await test('①b 文件名保留原扩展名（人肉看目录能认出格式）', async () => {
  eq(cache.cacheFileName('sha256:ab12', '片头.MP4'), 'sha256-ab12.mp4');
  eq(cache.cacheFileName('sha256:ab12', 'music.m4a'), 'sha256-ab12.m4a');
});

await test('①c 没有扩展名时退回 .bin（不产生非法文件名）', async () => {
  eq(cache.cacheFileName('sha256:ab12', 'noext'), 'sha256-ab12.bin');
});

console.log('[2] 写入与去重');

await test('②a 同一指纹写三次 → 缓存里只有一份', async () => {
  const backend = memoryBackend();
  cache.setCacheBackendForTest(backend);
  const hash = 'sha256:same';
  const file = new Blob(['x'.repeat(64)], { type: 'video/mp4' });
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => {
      cache.enqueueCacheWrite(new File([file], 'a.mp4'), hash, 'a.mp4', () => resolve());
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 80));
  eq(backend.files.size, 1, `缓存里应当只有 1 份，实际 ${backend.files.size}`);
  ok(backend.puts.length >= 1, '应当至少写过一次');
});

await test('②b 不同指纹 → 各存一份', async () => {
  const backend = memoryBackend();
  cache.setCacheBackendForTest(backend);
  for (const hash of ['sha256:aaa', 'sha256:bbb']) {
    await new Promise((resolve) => {
      cache.enqueueCacheWrite(new File([hash], 'a.mp4'), hash, 'a.mp4', () => resolve());
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 80));
  eq(backend.files.size, 2);
});

console.log('[3] 并发上限');

await test('③a 一次排 6 个任务，峰值并发不超过 2', async () => {
  const backend = memoryBackend();
  cache.setCacheBackendForTest(backend);
  for (let index = 0; index < 6; index += 1) {
    cache.enqueueCacheWrite(new File([`p${index}`], 'a.mp4'), `sha256:p${index}`, 'a.mp4', () => {});
  }
  // 等到队列清空
  const deadline = Date.now() + 3000;
  while (cache.pendingCacheJobs() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  ok(backend.peak <= 2, `并发峰值应当 ≤2，实际 ${backend.peak}`);
  eq(backend.files.size, 6, '6 个任务应当全部落盘');
});

console.log('[4] 开关与降级');

await test('④a 关闭自动缓存 → 不写、回调 false', async () => {
  const backend = memoryBackend();
  cache.setCacheBackendForTest(backend);
  cache.setAutoCacheEnabled(false);
  const result = await new Promise((resolve) => {
    cache.enqueueCacheWrite(new File(['x'], 'a.mp4'), 'sha256:off', 'a.mp4', resolve);
  });
  cache.setAutoCacheEnabled(true);
  eq(result, false);
  eq(backend.files.size, 0);
});

await test('④b 没有后端 → isCacheAvailable false，且 enqueue 立即回调 false（不抛）', async () => {
  cache.setCacheBackendForTest(null);
  eq(cache.isCacheAvailable(), false);
  const result = await new Promise((resolve) => {
    cache.enqueueCacheWrite(new File(['x'], 'a.mp4'), 'sha256:none', 'a.mp4', resolve);
  });
  eq(result, false);
  eq(await cache.readCachedAsset('sha256-none.mp4', 'a.mp4'), null);
  eq((await cache.cacheStats()).count, 0);
});

console.log('[5] 统计与清理');

await test('⑤a cacheStats 汇总数量与字节', async () => {
  const backend = memoryBackend();
  cache.setCacheBackendForTest(backend);
  await backend.put('k1', 'k1.mp4', new Blob(['12345']));
  await backend.put('k2', 'k2.mp4', new Blob(['123']));
  const stats = await cache.cacheStats();
  eq(stats.count, 2);
  eq(stats.bytes, 8);
});

await test('⑤b unusedEntries 只挑出"没被任何素材引用"的', async () => {
  const entries = [
    { key: 'a', name: 'a.mp4', size: 1, lastModified: 0 },
    { key: 'b', name: 'b.mp4', size: 1, lastModified: 0 },
  ];
  const dead = cache.unusedEntries(entries, new Set(['a.mp4']));
  eq(dead.map((item) => item.name), ['b.mp4']);
});

await test('⑤c inUseCacheNames 忽略空值', async () => {
  const names = cache.inUseCacheNames([
    { cacheKey: 'a.mp4' },
    { cacheKey: null },
    { cacheKey: '' },
    {},
  ]);
  eq([...names], ['a.mp4']);
});

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} 草稿缓存单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}`);
    console.error(failure.error);
  }
  process.exit(1);
}
