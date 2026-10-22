/**
 * 重链匹配与指纹的单测。
 *
 * ## 为什么这些必须有单测
 *
 * 重链的失败方式是**静默链错文件**：画面能出来，但出来的是另一段素材，
 * 用户可能到导出后才发现。所以"打分规则"必须钉死：
 * - 指纹一致 → 100（唯一可以无条件链的情况）；
 * - 名字 + 大小 + 时长三项全对 → 100（自动链门槛 95）；
 * - 只有名字相同 → 40（**绝不能自动链**，重名文件太常见）。
 *
 * 运行：`node tests/relink.test.mjs`
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

const relink = await load('src/media/relink.ts', 'relink');
const hash = await load('src/media/fileHash.ts', 'fileHash');

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function testAsync(name, fn) {
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

/** 一个"标准"的离线素材：名字 a.mp4、大小 1000、时长 10s、有指纹。 */
function makeAsset(overrides = {}) {
  return {
    id: 'ast_1',
    name: 'a.mp4',
    kind: 'video',
    handleRef: null,
    sourceMode: 'memory',
    status: 'offline',
    fpsMilli: 30000,
    durationFrames: 300,
    durationSec: 10,
    sampleRate: 48000,
    channels: 2,
    width: 1920,
    height: 1080,
    hasAudio: true,
    thumbnailRef: null,
    container: 'mp4',
    codecVideo: 'avc1.640028',
    codecAudio: 'mp4a.40.2',
    rotation: 0,
    exactSeek: true,
    hashKey: 'a.mp4|1000|1700000000000',
    contentHash: 'sha256:deadbeef',
    ...overrides,
  };
}

console.log('[1] 匹配打分');

test('①a 指纹一致 → 100 分，且标记 hashMatched', () => {
  const score = relink.scoreCandidate(makeAsset(), { name: '完全不同的名字.mp4', size: 999999 }, {
    contentHash: 'sha256:deadbeef',
  });
  eq(score.score, 100);
  eq(score.hashMatched, true);
  eq(score.reasons, ['内容指纹一致']);
});

test('①b 名字 + 大小 + 时长三项全对 → 100（达到自动链门槛）', () => {
  const score = relink.scoreCandidate(
    makeAsset({ contentHash: null }),
    { name: 'a.mp4', size: 1000 },
    { durationSec: 10 },
  );
  eq(score.score, 100);
  eq(score.hashMatched, false);
  ok(score.score >= relink.AUTO_LINK_SCORE, '应当达到自动链门槛');
});

test('①c 只有名字相同 → 40，**不该自动链**（重名文件太常见）', () => {
  const score = relink.scoreCandidate(
    makeAsset({ contentHash: null }),
    { name: 'a.mp4', size: 50000 },
    { durationSec: 99 },
  );
  eq(score.score, 40);
  ok(score.score < relink.AUTO_LINK_SCORE, '40 分不该自动链');
});

test('①d 名字不同但大小与时长一致 → 60（用户重命名过，需人工确认）', () => {
  const score = relink.scoreCandidate(
    makeAsset({ contentHash: null }),
    { name: '片头.mp4', size: 1000 },
    { durationSec: 10 },
  );
  eq(score.score, 60);
  ok(score.score < relink.AUTO_LINK_SCORE);
});

test('①e 扩展名变了但主名相同 → 名字只给一半分', () => {
  const score = relink.scoreCandidate(
    makeAsset({ name: 'a.mp4', contentHash: null }),
    { name: 'a.mov', size: 1000 },
    { durationSec: 10 },
  );
  // 主名 20 + 大小 30 + 时长 30 = 80
  eq(score.score, 80);
  ok(score.reasons.includes('主文件名相同（扩展名不同）'));
});

test('①f 大小相差 <1% 给 20 分（而不是 30）', () => {
  const score = relink.scoreCandidate(
    makeAsset({ contentHash: null }),
    { name: 'a.mp4', size: 1005 },
    { durationSec: 10 },
  );
  eq(score.score, 90);
  ok(score.reasons.includes('文件大小相差 <1%'));
});

test('①g 指纹算法不同（sha256 vs fnv）不算一致', () => {
  const score = relink.scoreCandidate(makeAsset(), { name: 'a.mp4', size: 1000 }, {
    contentHash: 'fnv:deadbeef',
  });
  eq(score.hashMatched, false);
});

test('①h 旧工程没有 contentHash → 不崩，降级到名字+大小+时长', () => {
  const legacy = makeAsset({ contentHash: undefined });
  const score = relink.scoreCandidate(legacy, { name: 'a.mp4', size: 1000 }, { durationSec: 10 });
  eq(score.score, 100);
  eq(score.hashMatched, false);
});

test('①i 大小从 hashKey 反解；坏数据返回 null 不抛', () => {
  eq(relink.sizeFromHashKey('a.mp4|1234|1700'), 1234);
  eq(relink.sizeFromHashKey('a.mp4'), null);
  eq(relink.sizeFromHashKey('a.mp4|abc|1700'), null);
  eq(relink.sizeFromHashKey('a.mp4|0|1700'), null);
});

console.log('\n[2] 媒体扩展名过滤');

test('②a 常见音视频都认', () => {
  for (const name of ['a.mp4', 'b.MOV', 'c.webm', 'd.mkv', 'e.mp3', 'f.wav', 'g.m4a']) {
    eq(relink.isMediaFileName(name), true, name);
  }
});

test('②b 非媒体与无扩展名不认', () => {
  for (const name of ['readme.txt', 'a.jpg', 'noext', '.gitignore']) {
    eq(relink.isMediaFileName(name), false, name);
  }
});

console.log('\n[3] 内容指纹');

await testAsync('③a 同一个 Blob 两次哈希一致', async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3, 4, 5])]);
  const first = await hash.hashFileHead(blob);
  const second = await hash.hashFileHead(blob);
  eq(first, second);
  ok(first.startsWith('sha256:') || first.startsWith('fnv:'), `前缀异常：${first}`);
});

await testAsync('③b 内容不同 → 指纹不同', async () => {
  const left = await hash.hashFileHead(new Blob([new Uint8Array([1, 2, 3])]));
  const right = await hash.hashFileHead(new Blob([new Uint8Array([1, 2, 4])]));
  ok(left !== right, '不同内容算出了同一个指纹');
});

await testAsync('③c 只读前 1MB：尾部不同不影响指纹（这是"快速校验"的代价，已写进注释）', async () => {
  const head = new Uint8Array(1024 * 1024).fill(7);
  const left = new Blob([head, new Uint8Array([1])]);
  const right = new Blob([head, new Uint8Array([2])]);
  eq(await hash.hashFileHead(left), await hash.hashFileHead(right));
});

await testAsync('③d 空文件也能算（不抛）', async () => {
  const value = await hash.hashFileHead(new Blob([]));
  ok(value.length > 0, '空文件没有指纹');
});

test('③e 指纹可比性判断（不同算法不可比）', () => {
  eq(hash.hashComparable('sha256:aa', 'sha256:bb'), true);
  eq(hash.hashComparable('sha256:aa', 'fnv:aa'), false);
  eq(hash.hashComparable(null, 'sha256:aa'), false);
  eq(hash.hashComparable('', ''), false);
});

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} 重链匹配单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}`);
    console.error(failure.error);
  }
  process.exit(1);
}
