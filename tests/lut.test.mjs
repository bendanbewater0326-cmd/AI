/**
 * 3D LUT 单测（R-058）：解析 .cube、缓存、参数读取。
 *
 * 着色器那一半由 E2E 用像素验证；这里守的是"文件读对没有"——
 * 格点顺序（R 变化最快）、尺寸校验、脏行容错，错一个颜色就整体偏。
 *
 * 运行：`node tests/lut.test.mjs`
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

const lut = await load('src/render/lut.ts', 'lut');
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

console.log('\n[1] parseCube（恒等 LUT）');

const identity = lut.parseCube(lut.identityCube(2));
test('①a 尺寸与数据量正确（2³ × 3 = 24）', () => {
  assert.ok(identity.ok);
  eq(identity.value.size, 2);
  eq(identity.value.data.length, 24);
  eq(identity.value.title, 'identity');
});

test('①b 格点顺序：第一个是 (0,0,0)、最后一个是 (1,1,1)', () => {
  assert.ok(identity.ok);
  const d = identity.value.data;
  near(d[0], 0, 1e-6, '首格 R');
  near(d[1], 0, 1e-6, '首格 G');
  near(d[2], 0, 1e-6, '首格 B');
  near(d[21], 1, 1e-6, '末格 R');
  near(d[22], 1, 1e-6, '末格 G');
  near(d[23], 1, 1e-6, '末格 B');
});

test('①c R 变化最快（第 2 个格点 R=1、G/B 仍为 0）', () => {
  assert.ok(identity.ok);
  near(identity.value.data[3], 1, 1e-6, '第 2 格 R');
  near(identity.value.data[4], 0, 1e-6, '第 2 格 G');
});

console.log('\n[2] 拒绝路径');

test('②a 1D LUT 明确拒绝', () => {
  const parsed = lut.parseCube('LUT_1D_SIZE 16\n0 0 0\n');
  eq(parsed.ok, false);
  assert.match(parsed.error.message, /只支持 3D/);
});

test('②b 尺寸越界 / 未声明', () => {
  eq(lut.parseCube('LUT_3D_SIZE 1\n0 0 0\n').ok, false);
  eq(lut.parseCube('LUT_3D_SIZE 200\n').ok, false);
  eq(lut.parseCube('0 0 0\n').ok, false);
});

test('②c 数据量不符 → 可读错误', () => {
  const parsed = lut.parseCube('LUT_3D_SIZE 2\n0 0 0\n1 1 1\n');
  eq(parsed.ok, false);
  assert.match(parsed.error.message, /数据量不符/);
});

test('②d 注释与空行被忽略', () => {
  const text = `# 注释
TITLE "t"

LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;
  const parsed = lut.parseCube(text);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error.message);
  eq(parsed.value.data.length, 24);
});

console.log('\n[3] 缓存与参数');

test('③a 同一份文本解析两次返回同一对象（不重复解析）', () => {
  const text = lut.identityCube(2);
  const first = lut.parseCubeCached(text);
  const second = lut.parseCubeCached(text);
  assert.ok(first !== null && second !== null);
  assert.strictEqual(first, second);
});

test('③b lutOf：没有效果 → null；强度被夹到 0..1', () => {
  const clip = types.createClip({ assetId: 'a', trackId: 't', startFrame: 0, inFrame: 0, outFrame: 10, durationFrames: 10 });
  eq(lut.lutOf(clip), null);
  clip.effects = [
    { id: 'fx', clipId: clip.id, type: 'lut', params: { cube: 'LUT_3D_SIZE 2\n', strength: 5 }, keyframes: [], enabled: true, order: 0, source: 'ui' },
  ];
  eq(lut.lutOf(clip).strength, 1);
  clip.effects[0].enabled = false;
  eq(lut.lutOf(clip), null);
});

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} LUT 单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}`);
    console.error(failure.error);
  }
  process.exit(1);
}
