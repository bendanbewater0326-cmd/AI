/**
 * 曲线调色单测（R-055）。
 *
 * 曲线的正确性只有三条：
 * 1. **恒等曲线 = 不变**（0.25/0.25/0.75/0.75 必须逐点等于 y=x）；
 * 2. **单调**（亮度不能因为加曲线出现反转）；
 * 3. **端点固定**（0→0、1→1，黑不能变灰、白不能变灰）。
 *
 * 运行：`node tests/curve.test.mjs`
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

const curve = await load('src/render/curve.ts', 'curve');
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

console.log('\n[1] 恒等曲线');
test('①a isNeutralCurve 认出恒等', () => {
  eq(curve.isNeutralCurve(curve.NEUTRAL_CURVE), true);
  eq(curve.isNeutralCurve({ x1: 0.25, y1: 0.3, x2: 0.75, y2: 0.75 }), false);
});
test('①b 恒等曲线逐点等于 y = x', () => {
  for (const v of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
    near(curve.applyCurveValue(v, curve.NEUTRAL_CURVE), v, 1e-9, `v=${v}`);
  }
});
test('①c 端点固定：0→0、1→1', () => {
  const s = { x1: 0.25, y1: 0.16, x2: 0.75, y2: 0.84 };
  near(curve.applyCurveValue(0, s), 0, 1e-9, '黑');
  near(curve.applyCurveValue(1, s), 1, 1e-9, '白');
});

console.log('\n[2] 对比度曲线');
test('②a 提对比：暗部压暗、亮部提亮、中点不动', () => {
  const s = { x1: 0.25, y1: 0.16, x2: 0.75, y2: 0.84 };
  assert.ok(curve.applyCurveValue(0.25, s) < 0.25, '暗部应更暗');
  assert.ok(curve.applyCurveValue(0.75, s) > 0.75, '亮部应更亮');
  near(curve.applyCurveValue(0.5, s), 0.5, 1e-9, '中点');
});
test('②b 全程单调递增', () => {
  const s = { x1: 0.25, y1: 0.16, x2: 0.75, y2: 0.84 };
  let prev = -1;
  for (let i = 0; i <= 100; i += 1) {
    const y = curve.applyCurveValue(i / 100, s);
    assert.ok(y >= prev - 1e-9, `在 ${i / 100} 处反转：${prev} → ${y}`);
    prev = y;
  }
});

console.log('\n[3] 参数读取与兜底');
test('③a 没有效果 → null', () => {
  const clip = types.createClip({ assetId: 'a', trackId: 't', startFrame: 0, inFrame: 0, outFrame: 10, durationFrames: 10 });
  eq(curve.curveOf(clip), null);
});
test('③b 脏数据：x 逆序被修正、越界值被夹住', () => {
  const clip = types.createClip({ assetId: 'a', trackId: 't', startFrame: 0, inFrame: 0, outFrame: 10, durationFrames: 10 });
  clip.effects = [
    { id: 'fx', clipId: clip.id, type: 'curve', params: { x1: 0.9, y1: 5, x2: 0.2, y2: -3 }, keyframes: [], enabled: true, order: 0, source: 'ui' },
  ];
  const params = curve.curveOf(clip);
  assert.ok(params.x2 > params.x1, `x 必须递增：${params.x1} / ${params.x2}`);
  eq(params.y1, 1);
  eq(params.y2, 0);
});

console.log('\n[4] 自然语言映射');
test('④a "对比更强" → 提对比参数', () => {
  eq(curve.curveFromPhrase('对比更强一点'), { x1: 0.25, y1: 0.16, x2: 0.75, y2: 0.84 });
});
test('④b "更亮" → 抬暗部', () => {
  const params = curve.curveFromPhrase('画面更亮一些');
  assert.ok(params !== null && params.y1 > 0.25, '暗部应被抬起');
});
test('④c "更暗" → 压暗部与亮部', () => {
  const params = curve.curveFromPhrase('整体压暗');
  assert.ok(params !== null && params.y1 < 0.25 && params.y2 < 0.75);
});
test('④d 无关说法 → null', () => {
  eq(curve.curveFromPhrase('把音量调大'), null);
  eq(curve.curveFromPhrase('去掉开头 3 秒'), null);
});

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} 曲线调色单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}`);
    console.error(failure.error);
  }
  process.exit(1);
}
