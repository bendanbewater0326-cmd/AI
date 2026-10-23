/**
 * 特效预设单测：`core/effectPresets` + `core/effectTarget` + `render/grade`。
 *
 * 守五条规则（都是"错了界面上看不出来"的那种）：
 * 1. **预设数据合法**：id 唯一、名字全中文、四个参数齐全且在 -100..100；
 * 2. **原片 = 移除 effect**，不是"写四个 0 的 effect"（后者会在 `effects` 里留空记录）；
 * 3. **同类型单例**：参数已经一样时返回空数组（不发无用撤销步），换了预设是替换；
 * 4. **落点**：选中优先 → 播放头 → 都没有给提示；文字/音频片段要拒绝；
 * 5. **像素公式与 `GRADE_GLSL` 一致**：中性不动、黑白三通道相等、暖色加红减蓝。
 *
 * 运行：`node tests/effect-presets.test.mjs`
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

const presets = await load('src/core/effectPresets.ts', 'effectPresets');
const target = await load('src/core/effectTarget.ts', 'effectTarget');
const grade = await load('src/render/grade.ts', 'grade');
const types = await load('src/core/types.ts', 'types');

const {
  EFFECT_PRESETS,
  EFFECT_CATEGORIES,
  ORIGINAL_PRESET,
  effectPresetById,
  effectPresetsIn,
  isOriginalPreset,
} = presets;
const { appliedPresetId, buildEffectOps, currentGrade, gradeEquals, resolveEffectTarget } = target;
const { applyGradeToPixels, applyGradeToRgb, gradeUniforms, isNeutral } = grade;
const { createClip, createTextContent, createTrack } = types;

const FPS = 30000;

const clip = (id, start, duration, extra = {}) =>
  createClip({
    id,
    assetId: 'ast',
    trackId: 'trk_V1',
    startFrame: start,
    inFrame: 0,
    outFrame: duration,
    durationFrames: duration,
    ...extra,
  });

const makeDoc = (tracks) => ({
  id: 'p', name: 't', fpsMilli: FPS, width: 1280, height: 720,
  sampleRate: 48000, frameMapPolicy: 'holdPrevious', durationRounding: 'halfUp',
  tracks, assets: [], playheadFrame: 0, zoomLevel: 5, schemaVersion: 1, createdAt: 0, updatedAt: 0,
});

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`      ${error.message}`);
  }
}

console.log('特效预设：数据合法性');

test('① 14 个预设，id 唯一', () => {
  assert.equal(EFFECT_PRESETS.length, 14);
  const ids = new Set(EFFECT_PRESETS.map((item) => item.id));
  assert.equal(ids.size, 14);
});

test('② 名字全中文（界面上不出现英文）', () => {
  for (const preset of EFFECT_PRESETS) {
    assert.ok(/^[\u4e00-\u9fa5]+$/.test(preset.name), `${preset.id} 的名字不是纯中文：${preset.name}`);
  }
});

test('③ 四个参数齐全，都在 -100..100', () => {
  for (const preset of EFFECT_PRESETS) {
    for (const key of ['brightness', 'contrast', 'saturation', 'temperature']) {
      const value = preset.params[key];
      assert.equal(typeof value, 'number', `${preset.id}.${key} 不是数字`);
      assert.ok(value >= -100 && value <= 100, `${preset.id}.${key} 越界：${value}`);
    }
  }
});

test('④ 分类齐全：三个分类都有预设，且分类 key 与 chip 一一对应', () => {
  const chips = EFFECT_CATEGORIES.map((item) => item.key);
  assert.deepEqual(chips, ['all', 'basic', 'tone', 'style']);
  for (const key of ['basic', 'tone', 'style']) {
    const list = EFFECT_PRESETS.filter((item) => item.category === key);
    assert.ok(list.length >= 3, `${key} 只有 ${list.length} 个预设，太少了`);
  }
});

test('⑤ 原片固定第一条，且四个参数全 0', () => {
  assert.equal(EFFECT_PRESETS[0].id, ORIGINAL_PRESET.id);
  assert.ok(isOriginalPreset(EFFECT_PRESETS[0]));
  assert.ok(isNeutral(ORIGINAL_PRESET.params));
});

test('⑥ 每个非原片预设至少有一个维度与邻居明显不同（>= 6）', () => {
  const others = EFFECT_PRESETS.filter((item) => !isOriginalPreset(item));
  for (const preset of others) {
    const maxDelta = Math.max(
      Math.abs(preset.params.brightness),
      Math.abs(preset.params.contrast),
      Math.abs(preset.params.saturation),
      Math.abs(preset.params.temperature),
    );
    assert.ok(maxDelta >= 6, `${preset.name} 变化太小（${maxDelta}），卡片会看不出区别`);
  }
});

test('⑦ 分类筛选：原片永远排第一（切到风格也能一键取消特效）', () => {
  assert.equal(effectPresetsIn('all').length, 14);
  for (const key of ['basic', 'tone', 'style']) {
    const list = effectPresetsIn(key);
    assert.equal(list[0].id, ORIGINAL_PRESET.id, `${key} 分类里原片不在第一位`);
    // 原片只出现一次
    assert.equal(list.filter((item) => isOriginalPreset(item)).length, 1);
    // 其余都属于该分类
    for (const preset of list.slice(1)) assert.equal(preset.category, key);
  }
});

test('⑧ effectPresetById：命中与未命中', () => {
  assert.equal(effectPresetById('fx-mono')?.name, '黑白');
  assert.equal(effectPresetById('nope'), null);
});

console.log('特效预设：已应用判定');

test('⑨ 没有调色 → 原片高亮', () => {
  assert.equal(appliedPresetId(null), ORIGINAL_PRESET.id);
});

test('⑩ 参数等于某预设 → 该预设高亮', () => {
  const mono = effectPresetById('fx-mono');
  assert.equal(appliedPresetId({ ...mono.params }), 'fx-mono');
});

test('⑪ 手调参数（不属于任何预设）→ 不高亮任何卡', () => {
  assert.equal(appliedPresetId({ brightness: 3, contrast: -7, saturation: 11, temperature: 2 }), '');
});

test('⑫ gradeEquals 是四个参数全等（不是"看起来差不多"）', () => {
  const a = { brightness: 1, contrast: 2, saturation: 3, temperature: 4 };
  assert.ok(gradeEquals(a, { ...a }));
  assert.ok(!gradeEquals(a, { ...a, temperature: 5 }));
});

console.log('特效预设：落点');

test('⑬ 选中片段优先于播放头', () => {
  const doc = makeDoc([
    createTrack({
      id: 'trk_V1',
      kind: 'video',
      clips: [clip('c1', 0, 100), clip('c2', 100, 100)],
    }),
  ]);
  const hit = resolveEffectTarget(doc, 'c2', 10);
  assert.equal(hit.clip.id, 'c2');
});

test('⑭ 没选中 → 播放头所在片段（半开区间：终点属于下一段）', () => {
  const doc = makeDoc([
    createTrack({ id: 'trk_V1', kind: 'video', clips: [clip('c1', 0, 100), clip('c2', 100, 100)] }),
  ]);
  assert.equal(resolveEffectTarget(doc, null, 99).clip.id, 'c1');
  assert.equal(resolveEffectTarget(doc, null, 100).clip.id, 'c2');
});

test('⑮ 文字片段拒绝（属性栏没有调色控件，加了也去不掉）', () => {
  const doc = makeDoc([
    createTrack({ id: 'trk_T1', kind: 'text', clips: [clip('t1', 0, 100, { text: createTextContent() })] }),
  ]);
  const hit = resolveEffectTarget(doc, 't1', 10);
  assert.ok('message' in hit && hit.message.includes('文字片段'));
});

test('⑯ 音频片段拒绝（选中了分离出来的音频片段）', () => {
  const doc = makeDoc([
    createTrack({ id: 'trk_A1', kind: 'audio', clips: [clip('a1', 0, 100, { role: 'audio' })] }),
  ]);
  const hit = resolveEffectTarget(doc, 'a1', 10);
  assert.ok('message' in hit && hit.message.includes('音频片段'));
});

test('⑰ 什么都没有 → 可读提示（不静默失败）', () => {
  const doc = makeDoc([createTrack({ id: 'trk_V1', kind: 'video', clips: [] })]);
  const hit = resolveEffectTarget(doc, null, 0);
  assert.ok('message' in hit);
});

test('⑱ 音频轨不参与播放头落点', () => {
  const doc = makeDoc([
    createTrack({ id: 'trk_A1', kind: 'audio', clips: [clip('a1', 0, 100)] }),
    createTrack({ id: 'trk_V1', kind: 'video', clips: [] }),
  ]);
  const hit = resolveEffectTarget(doc, null, 10);
  assert.ok('message' in hit, '不该落到音频轨上');
});

test('⑱b 播放头下有字幕压着视频 → 跳过字幕落到视频（不是直接报"文字片段不支持"）', () => {
  const doc = makeDoc([
    createTrack({ id: 'trk_V1', kind: 'video', clips: [clip('v1', 0, 100)] }),
    createTrack({ id: 'trk_T1', kind: 'text', clips: [clip('t1', 0, 100, { text: createTextContent() })] }),
  ]);
  const hit = resolveEffectTarget(doc, null, 10);
  assert.equal(hit.clip.id, 'v1');
});

test('⑱c 播放头下**只有**字幕 → 说出具体原因（比"先选中一个片段"有用）', () => {
  const doc = makeDoc([
    createTrack({ id: 'trk_T1', kind: 'text', clips: [clip('t1', 0, 100, { text: createTextContent() })] }),
  ]);
  const hit = resolveEffectTarget(doc, null, 10);
  assert.ok('message' in hit && hit.message.includes('文字片段'));
});

console.log('特效预设：操作构造');

test('⑲ 点原片 + 本来没有特效 → 空数组（不发无用撤销步）', () => {
  const ops = buildEffectOps(clip('c1', 0, 100), ORIGINAL_PRESET);
  assert.deepEqual(ops, []);
});

test('⑳ 点原片 + 有特效 → 一条 setClipEffect(to: null)，effectType 是 colorGrade', () => {
  const base = clip('c1', 0, 100);
  const applied = buildEffectOps(base, effectPresetById('fx-mono'))[0].to;
  const withEffect = { ...base, effects: [{ ...applied, clipId: base.id }] };
  const ops = buildEffectOps(withEffect, ORIGINAL_PRESET);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, 'setClipEffect');
  assert.equal(ops[0].effectType, 'colorGrade');
  assert.equal(ops[0].to, null);
  assert.equal(ops[0].from.id, applied.id);
});

test('㉑ 重复点同一个预设 → 空数组', () => {
  const base = clip('c1', 0, 100);
  const preset = effectPresetById('fx-vivid');
  const applied = buildEffectOps(base, preset)[0].to;
  const withEffect = { ...base, effects: [{ ...applied, clipId: base.id }] };
  assert.deepEqual(buildEffectOps(withEffect, preset), []);
});

test('㉒ 换一个预设 → 替换（仍只有一条 op，且复用原 id）', () => {
  const base = clip('c1', 0, 100);
  const first = buildEffectOps(base, effectPresetById('fx-warm'))[0].to;
  const withEffect = { ...base, effects: [{ ...first, clipId: base.id }] };
  const ops = buildEffectOps(withEffect, effectPresetById('fx-cool'));
  assert.equal(ops.length, 1);
  assert.equal(ops[0].to.id, first.id, '复用 id，否则关键帧/属性栏会跟丢');
  assert.equal(ops[0].to.params.temperature, -34);
  assert.equal(ops[0].from.params.temperature, 34);
});

test('㉓ currentGrade：只认 enabled 的 colorGrade，缺参数补 0', () => {
  const base = clip('c1', 0, 100);
  assert.equal(currentGrade(base), null);
  const withDisabled = {
    ...base,
    effects: [{ id: 'fx1', clipId: base.id, type: 'colorGrade', params: { brightness: 5 }, keyframes: [], enabled: false, order: 0, source: 'ui' }],
  };
  assert.equal(currentGrade(withDisabled), null, '禁用的效果不该生效');
  const withEnabled = {
    ...base,
    effects: [{ ...withDisabled.effects[0], enabled: true }],
  };
  assert.deepEqual(currentGrade(withEnabled), { brightness: 5, contrast: 0, saturation: 0, temperature: 0 });
});

console.log('特效预设：像素公式（与 GRADE_GLSL 一致）');

/** 造一块纯色像素。 */
const solid = (r, g, b) => new Uint8ClampedArray([r, g, b, 255]);

test('㉔ 中性参数不动一个像素', () => {
  const data = solid(40, 120, 200);
  applyGradeToPixels(data, { brightness: 0, contrast: 0, saturation: 0, temperature: 0 });
  assert.deepEqual([...data], [40, 120, 200, 255]);
});

test('㉕ 黑白（饱和度 -100）→ 三通道相等', () => {
  const data = solid(40, 120, 200);
  applyGradeToPixels(data, effectPresetById('fx-mono').params);
  assert.equal(data[0], data[1]);
  assert.equal(data[1], data[2]);
});

test('㉖ 提亮让每个通道都变大（加法语义，不是 CSS 的乘法）', () => {
  const before = solid(10, 60, 200);
  const after = solid(10, 60, 200);
  applyGradeToPixels(after, { brightness: 18, contrast: 0, saturation: 0, temperature: 0 });
  for (let i = 0; i < 3; i += 1) assert.ok(after[i] > before[i], `通道 ${i} 没变亮`);
  // +18 → +0.09 → 至少 +20 字节（10 会到 33 左右）
  assert.ok(after[0] - before[0] >= 20, `暗部提亮幅度不对：${before[0]} → ${after[0]}`);
});

test('㉗ 色温：暖色加红减蓝，绿不动', () => {
  const warm = solid(100, 100, 100);
  applyGradeToPixels(warm, { brightness: 0, contrast: 0, saturation: 0, temperature: 100 });
  assert.ok(warm[0] > 100, '红没加');
  assert.ok(warm[2] < 100, '蓝没减');
  assert.equal(warm[1], 100, '绿不该动');
});

test('㉘ 对比度围绕 0.5 拉伸：暗的更暗、亮的更亮', () => {
  const dark = solid(60, 60, 60);
  const bright = solid(200, 200, 200);
  const params = { brightness: 0, contrast: 50, saturation: 0, temperature: 0 };
  applyGradeToPixels(dark, params);
  applyGradeToPixels(bright, params);
  assert.ok(dark[0] < 60);
  assert.ok(bright[0] > 200);
});

test('㉙ 输出永远在 0..255（中间过程不夹、最后夹）', () => {
  const uniforms = gradeUniforms({ brightness: 100, contrast: 100, saturation: 100, temperature: 100 });
  const [r, g, b] = applyGradeToRgb(1, 1, 1, uniforms);
  assert.ok(r <= 1 && g <= 1 && b <= 1);
  const [r2, g2, b2] = applyGradeToRgb(0, 0, 0, uniforms);
  assert.ok(r2 >= 0 && g2 >= 0 && b2 >= 0);
});

test('㉚ gradeUniforms 与 compositor 的四行换算一致', () => {
  const u = gradeUniforms({ brightness: 100, contrast: 0, saturation: 0, temperature: 100 });
  assert.equal(u.brightness, 0.5);
  assert.equal(u.contrast, 1);
  assert.equal(u.saturation, 1);
  assert.equal(u.temperature, 1);
});

console.log('');
console.log(`通过 ${passed} / ${passed + failed}`);
if (failed > 0) process.exit(1);
