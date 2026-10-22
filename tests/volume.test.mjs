/**
 * 音量映射与峰值保护单测（`core/volume`）。
 *
 * ## 钉住的三件事
 *
 * ① **锚点**：滑块 0% = 静音、100% = 0dB（原始音量）、200% = +12dB。
 *    这三个点是产品规格，改了就是改了手感，必须让测试先叫。
 * ② **单调 + 单调到顶**：位置越大声音越大，且 +12dB 处正好是上限（不能偷偷给到 +20dB）。
 * ③ **软限幅**：0.9 以下恒等（不染色），超过之后仍然 < 1.0（不削波），且曲线连续（无台阶）。
 *
 * 运行：`node tests/volume.test.mjs`
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

const v = await load('src/core/volume.ts', 'volume');

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
const eq = (a, b, m) => assert.deepStrictEqual(a, b, m);
const close = (a, b, tol, m) =>
  assert.ok(Math.abs(a - b) <= tol, `${m ?? ''} 期望 ${b}±${tol}，实际 ${a}`);

console.log('\n[1] 三个锚点（产品规格）');

test('①a 0% = 静音（-∞ dB，振幅 0）', () => {
  eq(v.positionToDb(0), Number.NEGATIVE_INFINITY);
  eq(v.positionToGain(0), 0);
});

test('①b 100% = 0dB = 振幅 1（原始音量，不放大不衰减）', () => {
  eq(v.positionToDb(1), 0);
  close(v.positionToGain(1), 1, 1e-12);
});

test('①c 200% = +12dB ≈ 3.98 倍振幅', () => {
  eq(v.positionToDb(2), 12);
  close(v.positionToGain(2), 3.98107, 1e-4);
});

test('①d 超过 200% 不会继续加（夹在 +12dB）', () => {
  eq(v.positionToDb(3), 12);
  close(v.positionToGain(5), 3.98107, 1e-4);
});

console.log('\n[2] 手感：全程按 dB 线性');

test('②a 下半段每 1% 走 0.6dB（0.5 → -30dB，而不是旧实现的 -6dB）', () => {
  close(v.positionToDb(0.5), -30, 1e-9);
  // 旧实现 gain = 0.5 → -6dB：上半段几乎没变化，这就是"手感不均匀"的来源
  close(v.gainToDb(0.5), -6.0206, 1e-3);
});

test('②b 上半段每 1% 走 0.12dB（1.5 → +6dB）', () => {
  close(v.positionToDb(1.5), 6, 1e-9);
});

test('②c 单调递增（整条滑块没有回头路）', () => {
  let previous = v.positionToDb(0.01);
  for (let p = 0.02; p <= 2.0001; p += 0.01) {
    const current = v.positionToDb(p);
    assert.ok(current > previous, `位置 ${p.toFixed(2)} 的 dB 没有比前一步大`);
    previous = current;
  }
});

test('②d 位置 → dB → 位置 往返一致', () => {
  for (const p of [0.05, 0.25, 0.5, 0.75, 1, 1.2, 1.6, 2]) {
    close(v.dbToPosition(v.positionToDb(p)), p, 1e-9, `位置 ${p}`);
  }
});

test('②e 振幅 → 位置：老工程的 gain 也能落到正确位置', () => {
  close(v.gainToPosition(1), 1, 1e-9, '0dB 在 100%');
  // 0.5 倍振幅 = -6.02dB → 位置 89.97%（不是整 90%，因为 -6dB 只是近似）
  close(v.gainToPosition(0.5), 0.8997, 1e-3, '-6dB 在 90% 附近');
  close(v.gainToPosition(0), 0, 1e-9, '静音在 0%');
});

console.log('\n[3] 峰值保护（软限幅）');

test('③a 拐点以下**完全不动**（不染色正常素材）', () => {
  for (const x of [0, 0.1, 0.5, 0.89, 0.9, -0.5, -0.9]) {
    eq(v.softLimit(x), x);
  }
});

test('③b 超过 0dB 的样本被压到 1.0 以下（不削波）', () => {
  for (const x of [0.95, 1, 1.5, 3.98, 10]) {
    const y = v.softLimit(x);
    assert.ok(y < 1, `${x} 限幅后是 ${y}，应当 < 1`);
      assert.ok(y > 0.9, `${x} 限幅后是 ${y}，压得太狠`);
  }
});

test('③c 曲线连续（拐点处没有台阶，否则会有"咔"声）', () => {
  const below = v.softLimit(0.9 - 1e-6);
  const above = v.softLimit(0.9 + 1e-6);
  close(above, below, 1e-5, '拐点两侧');
});

test('③d 奇函数 + 单调不减（不会引入直流偏移，也不会把波形折回去）', () => {
  for (const x of [0.3, 1.2, 4]) {
    close(v.softLimit(-x), -v.softLimit(x), 1e-12, `±${x}`);
  }
  // 限幅器的天然行为是**渐近**到天花板：极大输入处相等（不再增加），但绝不能回头
  let previous = v.softLimit(0);
  for (let x = 0.05; x <= 6; x += 0.05) {
    const current = v.softLimit(x);
    assert.ok(current >= previous, `x=${x.toFixed(2)} 处回头了`);
    previous = current;
  }
  assert.ok(previous <= 0.999 + 1e-12, `天花板应当 ≤ 0.999，实际 ${previous}`);
});

test('③e +12dB 的满幅素材：限幅后仍 < 1.0（这就是"防爆音"）', () => {
  const boosted = 1 * v.positionToGain(2);
  const limited = v.softLimit(boosted);
  assert.ok(limited < 1, `限幅后 ${limited}`);
});

console.log('\n[4] 文案');

test('④a dB 文案带符号与单位', () => {
  eq(v.formatDb(0), '0.0 dB');
  eq(v.formatDb(-6.02), '-6.0 dB');
  eq(v.formatDb(12), '+12.0 dB');
  eq(v.formatDb(Number.NEGATIVE_INFINITY), '-∞ dB');
});

test('④b 百分比文案', () => {
  eq(v.formatPercent(1), '100%');
  eq(v.formatPercent(0.5), '50%');
  eq(v.formatPercent(2), '200%');
});

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} 音量映射单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}`);
    console.error(failure.error);
  }
  process.exit(1);
}
