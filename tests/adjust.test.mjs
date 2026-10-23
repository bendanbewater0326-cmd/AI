/**
 * 调节写入层单测（`src/core/adjust.ts`）。
 *
 * 为什么测**纯构造函数**而不是 `applyXxx`：
 * `applyXxx` 依赖模块级全局 store，而单测用的是 `createStore()` 的独立实例
 * （无法注入）。所以 `adjust.ts` 把"构造 effect"与"dispatch"分开，
 * 单测直接验证 params 的完整性与三条硬规则，端到端写入交给 E2E。
 *
 * 覆盖：
 *   ① `readGrade/readCurve/readLut/readMask` 的默认值与读回
 *   ② `buildGradeEffect`：4 参数齐全、patch 单字段不影响其它、沿用原 id
 *   ③ `buildCurveEffect`：只改 y 时 x1/x2 保持不变
 *   ④ `buildMaskEffect`：**保留 keyframes**、`invert` 存 1/0、无蒙版时用 DEFAULT_MASK
 *   ⑤ `buildLutStrengthEffect`：无 LUT 返回 null、strength clamp 到 0..1
 *
 * 运行：`node tests/adjust.test.mjs`
 */
import { buildSync } from 'esbuild';
import assert from 'node:assert';
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

const types = await loadTsModule('src/core/types.ts', 'types');
const adjust = await loadTsModule('src/core/adjust.ts', 'adjust');
const curveModule = await loadTsModule('src/render/curve.ts', 'curve');
const maskModule = await loadTsModule('src/render/mask.ts', 'mask');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, message: error instanceof Error ? error.message : String(error) });
    console.log(`  ✗ ${name}`);
    console.log(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}

function eq(actual, expected, label) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${label}：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
}

function deepEq(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
  } catch (error) {
    throw new Error(`${label}：结构不相等 → ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ---------------- 夹具 ---------------- */

/** 最小 clip：只有 id 与空 effects（build 函数只读 id 与 effects）。 */
function makeClip(overrides = {}) {
  return types.createClip({
    id: 'clp_1',
    trackId: 'trk_V1',
    assetId: 'ast_1',
    startFrame: 0,
    inFrame: 0,
    outFrame: 90,
    durationFrames: 90,
    ...overrides,
  });
}

function withEffects(clip, effects) {
  return { ...clip, effects };
}

function makeEffect(type, params, extra = {}) {
  return {
    id: `fx_${type}`,
    clipId: 'clp_1',
    type,
    params,
    keyframes: [],
    enabled: true,
    order: 0,
    source: 'ui',
    ...extra,
  };
}

/* ---------------- ① 读函数默认值 ---------------- */

console.log('① readXxx 默认值');
test('readGrade 无 effect → 全 0', () => {
  deepEq(adjust.readGrade(makeClip()), { brightness: 0, contrast: 0, saturation: 0, temperature: 0 }, '中性调色');
});
test('readGrade 有 effect → 读回值', () => {
  const clip = withEffects(makeClip(), [makeEffect('colorGrade', { brightness: -20, contrast: 12, saturation: 0, temperature: -35 })]);
  deepEq(adjust.readGrade(clip), { brightness: -20, contrast: 12, saturation: 0, temperature: -35 }, '读回调色');
});
test('readCurve 无 effect → 恒等曲线 0.25/0.25/0.75/0.75', () => {
  deepEq(adjust.readCurve(makeClip()), { ...curveModule.NEUTRAL_CURVE }, '中性曲线');
});
test('readLut 无 effect → loaded=false / strength=1', () => {
  const lut = adjust.readLut(makeClip());
  eq(lut.loaded, false, 'loaded');
  eq(lut.strength, 1, 'strength');
});
test('readMask 无 effect → null', () => {
  eq(adjust.readMask(makeClip()), null, 'readMask');
});

/* ---------------- ② buildGradeEffect ---------------- */

console.log('② buildGradeEffect');
test('params 四个参数齐全（缺字段会静默变 0，必须写全）', () => {
  const effect = adjust.buildGradeEffect(makeClip(), { brightness: 10 });
  deepEq(
    effect.params,
    { brightness: 10, contrast: 0, saturation: 0, temperature: 0 },
    '4 参数',
  );
});
test('patch 单字段不影响其它字段', () => {
  const clip = withEffects(makeClip(), [makeEffect('colorGrade', { brightness: -20, contrast: 12, saturation: 5, temperature: -35 })]);
  const effect = adjust.buildGradeEffect(clip, { saturation: 40 });
  deepEq(
    effect.params,
    { brightness: -20, contrast: 12, saturation: 40, temperature: -35 },
    '只改饱和',
  );
});
test('沿用原 effect 的 id（同类型替换，不是新增）', () => {
  const clip = withEffects(makeClip(), [makeEffect('colorGrade', { brightness: 0, contrast: 0, saturation: 0, temperature: 0 })]);
  const effect = adjust.buildGradeEffect(clip, { brightness: 5 });
  eq(effect.id, 'fx_colorGrade', 'id 不变');
});
test('无 effect 时生成新 id', () => {
  const effect = adjust.buildGradeEffect(makeClip(), { brightness: 5 });
  if (typeof effect.id !== 'string' || !effect.id.startsWith('fx_')) {
    throw new Error(`期望新 id 以 fx_ 开头，实际 ${String(effect.id)}`);
  }
});
test('type / enabled / source 正确', () => {
  const effect = adjust.buildGradeEffect(makeClip(), { brightness: 5 });
  eq(effect.type, 'colorGrade', 'type');
  eq(effect.enabled, true, 'enabled');
  eq(effect.source, 'ui', 'source');
});

/* ---------------- ③ buildCurveEffect ---------------- */

console.log('③ buildCurveEffect');
test('只改 y1 时 x1/x2 保持不变', () => {
  const effect = adjust.buildCurveEffect(makeClip(), { y1: 0.1 });
  deepEq(effect.params, { x1: 0.25, y1: 0.1, x2: 0.75, y2: 0.75 }, 'x 固定');
});
test('基于当前曲线叠加（不是从中性重来）', () => {
  const clip = withEffects(makeClip(), [makeEffect('curve', { x1: 0.25, y1: 0.4, x2: 0.75, y2: 0.6 })]);
  const effect = adjust.buildCurveEffect(clip, { y2: 0.9 });
  deepEq(effect.params, { x1: 0.25, y1: 0.4, x2: 0.75, y2: 0.9 }, '保留 y1');
});

/* ---------------- ④ buildMaskEffect ---------------- */

console.log('④ buildMaskEffect');
test('invert=true → params.invert === 1（不是 boolean）', () => {
  const effect = adjust.buildMaskEffect(makeClip(), { invert: true });
  eq(effect.params.invert, 1, 'invert 存 1');
});
test('invert=false → params.invert === 0', () => {
  const effect = adjust.buildMaskEffect(makeClip(), { invert: false });
  eq(effect.params.invert, 0, 'invert 存 0');
});
test('保留已有 keyframes（细调参数不能抹掉手动跟踪的点）', () => {
  const keyframes = [{ frame: 10, property: 'mask.x', value: 0.3, easing: 'linear' }];
  const clip = withEffects(makeClip(), [makeEffect('mask', { shape: 'rect', x: 0.2, y: 0.2, w: 0.6, h: 0.6, feather: 0.05, invert: 0 }, { keyframes })]);
  const effect = adjust.buildMaskEffect(clip, { x: 0.3 });
  deepEq(effect.keyframes, keyframes, 'keyframes 保留');
});
test('无蒙版时用 DEFAULT_MASK 兜底', () => {
  const effect = adjust.buildMaskEffect(makeClip(), {});
  deepEq(
    effect.params,
    {
      shape: maskModule.DEFAULT_MASK.shape,
      x: maskModule.DEFAULT_MASK.x,
      y: maskModule.DEFAULT_MASK.y,
      w: maskModule.DEFAULT_MASK.w,
      h: maskModule.DEFAULT_MASK.h,
      feather: maskModule.DEFAULT_MASK.feather,
      invert: 0,
    },
    '默认蒙版',
  );
});
test('shape 支持 ellipse', () => {
  const effect = adjust.buildMaskEffect(makeClip(), { shape: 'ellipse' });
  eq(effect.params.shape, 'ellipse', 'shape');
});

/* ---------------- ⑤ buildLutStrengthEffect ---------------- */

console.log('⑤ buildLutStrengthEffect');
test('无 LUT → null（不能凭空造一个没有 cube 的 LUT 效果）', () => {
  eq(adjust.buildLutStrengthEffect(makeClip(), 0.5), null, 'null');
});
test('有 LUT → 保留 cube 原文，只改 strength', () => {
  const clip = withEffects(makeClip(), [makeEffect('lut', { cube: 'LUT_3D_SIZE 2\n...', strength: 1, title: '电影感' })]);
  const effect = adjust.buildLutStrengthEffect(clip, 0.4);
  eq(effect.params.cube, 'LUT_3D_SIZE 2\n...', 'cube 保留');
  eq(effect.params.strength, 0.4, 'strength');
  eq(effect.params.title, '电影感', 'title 保留');
});
test('strength 超范围 clamp 到 0..1', () => {
  const clip = withEffects(makeClip(), [makeEffect('lut', { cube: 'x', strength: 1 })]);
  eq(adjust.buildLutStrengthEffect(clip, 5).params.strength, 1, '上限');
  eq(adjust.buildLutStrengthEffect(clip, -3).params.strength, 0, '下限');
});
test('同名效果的其它 params 不被丢弃', () => {
  const clip = withEffects(makeClip(), [makeEffect('lut', { cube: 'x', strength: 1, title: 'A', extra: 7 })]);
  const effect = adjust.buildLutStrengthEffect(clip, 0.2);
  eq(effect.params.extra, 7, '额外字段保留');
});

/* ---------------- 汇总 ---------------- */

console.log('');
if (failures.length === 0) {
  console.log(`✓ 调节写入层单测：通过 ${passed} / ${passed}`);
  process.exit(0);
} else {
  console.log(`✗ 调节写入层单测：${failures.length} 项失败`);
  for (const item of failures) console.log(`  - ${item.name}：${item.message}`);
  process.exit(1);
}
