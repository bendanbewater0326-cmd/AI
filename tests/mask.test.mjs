/**
 * 蒙版单测（R-056）：参数求值 + 关键帧覆盖 + 自然语言映射。
 *
 * 蒙版的正确性看三点：
 * 1. **形状内 alpha=1、形状外 alpha=0**（遮对了没有）；
 * 2. **羽化带是过渡**（不能是硬切）；
 * 3. **关键帧能跨帧改变位置**（这是"跟踪"的本地实现方式）。
 *
 * 运行：`node tests/mask.test.mjs`
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

const mask = await load('src/render/mask.ts', 'mask');
const types = await load('src/core/types.ts', 'types');

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
function eq(a, b, m) {
  assert.deepStrictEqual(a, b, m);
}
function near(a, b, tol, m) {
  assert.ok(Math.abs(a - b) <= tol, `${m}：期望 ${b}±${tol}，实际 ${a}`);
}

function clipWithMask(params, keyframes = []) {
  const clip = types.createClip({ assetId: 'a', trackId: 't', startFrame: 0, inFrame: 0, outFrame: 100, durationFrames: 100 });
  clip.effects = [
    { id: 'fx', clipId: clip.id, type: 'mask', params, keyframes, enabled: true, order: 0, source: 'ui' },
  ];
  return clip;
}

console.log('\n[1] maskOf（参数与关键帧）');

test('①a 没有蒙版效果 → null', () => {
  const clip = types.createClip({ assetId: 'a', trackId: 't', startFrame: 0, inFrame: 0, outFrame: 10, durationFrames: 10 });
  eq(mask.maskOf(clip, 0), null);
});

test('①b 静态参数被读取并夹到 0..1', () => {
  const clip = clipWithMask({ shape: 'ellipse', x: -1, y: 2, w: 0.5, h: 0.5, feather: 0.9, invert: 1 });
  const params = mask.maskOf(clip, 0);
  eq(params.shape, 'ellipse');
  eq(params.x, 0);
  eq(params.y, 1);
  eq(params.feather, 0.5);
  eq(params.invert, true);
});

test('①c 关键帧覆盖位置：第 0 帧在左、第 100 帧到右', () => {
  const clip = clipWithMask({ shape: 'rect', x: 0, y: 0, w: 0.4, h: 1, feather: 0.02, invert: 0 }, [
    { frame: 0, property: 'mask.x', value: 0, easing: 'linear' },
    { frame: 100, property: 'mask.x', value: 0.6, easing: 'linear' },
  ]);
  near(mask.maskOf(clip, 0).x, 0, 1e-6, '起点');
  near(mask.maskOf(clip, 50).x, 0.3, 1e-6, '中点（线性插值）');
  near(mask.maskOf(clip, 100).x, 0.6, 1e-6, '终点');
});

console.log('\n[2] maskAlphaAt（形状与羽化）');

const rect = { shape: 'rect', x: 0.25, y: 0.25, w: 0.5, h: 0.5, feather: 0.1, invert: false };
test('②a 矩形：中心 1、外部 0', () => {
  near(mask.maskAlphaAt(0.5, 0.5, rect), 1, 1e-6, '中心');
  near(mask.maskAlphaAt(0.05, 0.5, rect), 0, 1e-6, '左侧外');
  near(mask.maskAlphaAt(0.95, 0.95, rect), 0, 1e-6, '右下外');
});

test('②b 矩形：边缘有过渡（不是硬切）', () => {
  const alpha = mask.maskAlphaAt(0.27, 0.5, rect);
  assert.ok(alpha > 0.05 && alpha < 0.95, `边缘 alpha 应在 0..1 之间，实际 ${alpha}`);
});

test('②c 椭圆：中心 1、四角 0', () => {
  const ellipse = { ...rect, shape: 'ellipse' };
  near(mask.maskAlphaAt(0.5, 0.5, ellipse), 1, 1e-6, '中心');
  near(mask.maskAlphaAt(0.26, 0.26, ellipse), 0, 1e-6, '角落');
});

test('②d invert 反转', () => {
  const inverted = { ...rect, invert: true };
  near(mask.maskAlphaAt(0.5, 0.5, inverted), 0, 1e-6, '中心变 0');
  near(mask.maskAlphaAt(0.05, 0.5, inverted), 1, 1e-6, '外部变 1');
});

console.log('\n[3] maskFromPhrase（自然语言）');

test('③a 方位词映射', () => {
  eq(mask.maskFromPhrase('遮住左边').x, 0);
  eq(mask.maskFromPhrase('遮住左边').w, 0.5);
  eq(mask.maskFromPhrase('只露右边').x, 0.5);
  eq(mask.maskFromPhrase('遮住上半').h, 0.5);
  eq(mask.maskFromPhrase('只露中间').x, 0.25);
});

test('③b 动词决定方向：「遮住X」挖掉 X，「只露X」保留 X', () => {
  // 语义口径：maskAlphaAt 是"区域内保留"，所以"遮住"必须靠 invert 把区域反过来。
  // 2026-10-21 之前一律 invert=false → "遮住左边"实际露出左边（E2E 只看均值，没抓到）。
  eq(mask.maskFromPhrase('遮住左边').invert, true, '遮住 → 挖掉');
  eq(mask.maskFromPhrase('盖住上半').invert, true);
  eq(mask.maskFromPhrase('裁掉右边').invert, true);
  eq(mask.maskFromPhrase('只露左边').invert, false, '只露 → 保留');
  eq(mask.maskFromPhrase('露出中间').invert, false);

  // 关键：同一个区域 + 不同动词 → alpha 在区域中心恰好相反
  const hide = mask.maskFromPhrase('遮住左边');
  const keep = mask.maskFromPhrase('只露左边');
  near(mask.maskAlphaAt(0.25, 0.5, hide), 0, 1e-6, '遮住左边：左侧中心 alpha=0（被遮）');
  near(mask.maskAlphaAt(0.25, 0.5, keep), 1, 1e-6, '只露左边：左侧中心 alpha=1（可见）');
  near(mask.maskAlphaAt(0.75, 0.5, hide), 1, 1e-6, '遮住左边：右侧仍是 1');
  near(mask.maskAlphaAt(0.75, 0.5, keep), 0, 1e-6, '只露左边：右侧被遮');
});

test('③c 没有蒙版词 → null（不瞎猜）', () => {
  eq(mask.maskFromPhrase('把音量调大'), null);
  eq(mask.maskFromPhrase('画面更亮一点'), null);
  // 有蒙版词但没有方位词 → 也不猜（区域未知，交给属性栏手动调）
  eq(mask.maskFromPhrase('加个蒙版'), null);
});

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} 蒙版单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}`);
    console.error(failure.error);
  }
  process.exit(1);
}
