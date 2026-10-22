/**
 * 代理媒体纯逻辑单测（R-052）。
 *
 * 只测"要不要转"和"转多大"——这两条决定了**会不会误伤**：
 * - 阈值太松：1080p 也被转一遍，导入变慢、IDB 多存一份；
 * - 阈值太紧：4K 不转，预览继续卡。
 *
 * 运行：`node tests/proxy.test.mjs`
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

const proxy = await load('src/media/proxy.ts', 'proxy');

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

function eq(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message);
}

console.log('\n[1] needsProxy（只有 4K 级才转）');

test('①a 3840×2160 → 需要代理', () => {
  eq(proxy.needsProxy({ width: 3840, height: 2160, kind: 'video' }), true);
});

test('①b 1920×1080 / 2560×1440 → 不需要（别误伤常见素材）', () => {
  eq(proxy.needsProxy({ width: 1920, height: 1080, kind: 'video' }), false);
  eq(proxy.needsProxy({ width: 2560, height: 1440, kind: 'video' }), false);
});

test('①c 纯音频 → 不需要', () => {
  eq(proxy.needsProxy({ width: 0, height: 0, kind: 'audio' }), false);
});

test('①d 8K → 需要', () => {
  eq(proxy.needsProxy({ width: 7680, height: 4320, kind: 'video' }), true);
});

console.log('\n[2] proxyTargetSize');

test('②a 4K → 960×540（长边压到 960）', () => {
  eq(proxy.proxyTargetSize(3840, 2160), { width: 960, height: 540 });
});

test('②b 1080p → 960×540（同比例，不放大）', () => {
  eq(proxy.proxyTargetSize(1920, 1080), { width: 960, height: 540 });
});

test('②c 小于 960 宽 → 原尺寸（不放大）', () => {
  eq(proxy.proxyTargetSize(640, 360), { width: 640, height: 360 });
});

test('②d 竖拍 2160×3840 → 540×960', () => {
  eq(proxy.proxyTargetSize(2160, 3840), { width: 540, height: 960 });
});

test('②e 奇数尺寸被修成偶数（H.264 4:2:0 要求）', () => {
  const size = proxy.proxyTargetSize(3841, 2161);
  eq(size.width % 2, 0);
  eq(size.height % 2, 0);
});

test('②f 极端窄条不出现 0 尺寸', () => {
  const size = proxy.proxyTargetSize(10000, 3);
  assert.ok(size.width >= 2 && size.height >= 2, `实际 ${size.width}×${size.height}`);
});

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} 代理媒体单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}`);
    console.error(failure.error);
  }
  process.exit(1);
}
