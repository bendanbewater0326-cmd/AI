/**
 * 预设单测（R-053）：抓取、生成操作、规范化。
 *
 * 三条容易错的规则，都在这里守：
 * 1. **只存被改过的字段**——把默认值也存进去，预设会把目标片段"重置"成默认；
 * 2. **套用要能撤销**——每个字段一条 `setClipProps` 且带 `from`；
 * 3. **文字样式只对文字片段生效**——套到普通视频片段上不该凭空造出文字。
 *
 * 运行：`node tests/preset.test.mjs`
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

const preset = await load('src/core/preset.ts', 'preset');
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

function eq(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message);
}

function makeClip(overrides = {}) {
  const clip = types.createClip({
    id: 'clp_1',
    assetId: 'ast_1',
    trackId: 'trk_V1',
    startFrame: 0,
    inFrame: 0,
    outFrame: 120,
    durationFrames: 120,
    ...overrides,
  });
  return clip;
}

console.log('\n[1] capturePreset（只存被改过的字段）');

test('①a 默认片段 → null（没有可存的样式）', () => {
  eq(preset.capturePreset(makeClip()), null);
});

test('①b 改过的变换/调色/音量都被抓到，默认值不写', () => {
  const clip = makeClip({ transform: { scale: 1.5, opacity: 0.5 }, audio: { gain: 0.5 } });
  clip.effects = [
    {
      id: 'fx_1',
      clipId: clip.id,
      type: 'colorGrade',
      params: { brightness: -100, contrast: 0 },
      keyframes: [],
      enabled: true,
      order: 0,
      source: 'ui',
    },
  ];
  const payload = preset.capturePreset(clip);
  eq(payload.transform, { scale: 1.5, opacity: 0.5 });
  eq(payload.audio, { gain: 0.5 });
  // 0 是默认值，不该写进预设
  eq(payload.colorGrade, { brightness: -100 });
  eq(payload.textStyle, undefined);
});

test('①c 文字片段抓到样式、但不抓内容', () => {
  const clip = makeClip({ assetId: '', text: types.createTextContent({ content: '标题', fontSize: 96 }) });
  const payload = preset.capturePreset(clip);
  assert.ok(payload.textStyle !== undefined);
  eq(payload.textStyle.fontSize, 96);
  eq(Object.hasOwn(payload.textStyle, 'content'), false, '预设不该包含文字内容');
});

test('①d 只有淡入淡出、没有改音量时也能存', () => {
  const clip = makeClip({ audio: { fadeInFrames: 12 } });
  eq(preset.capturePreset(clip).audio, { fadeInFrames: 12 });
});

console.log('\n[2] buildPresetOps（可撤销、只改有差异的字段）');

const source = makeClip({ transform: { scale: 1.5, opacity: 0.5 }, audio: { gain: 0.5 } });
source.effects = [
  {
    id: 'fx_1',
    clipId: source.id,
    type: 'colorGrade',
    params: { brightness: -100 },
    keyframes: [],
    enabled: true,
    order: 0,
    source: 'ui',
  },
];
const captured = preset.capturePreset(source);
const saved = preset.createPreset('测试预设', captured, 1700000000000);

test('②a 每个改动字段一条 setClipProps，带 from/to', () => {
  const target = makeClip({ id: 'clp_2' });
  const ops = preset.buildPresetOps(target, saved);
  const props = ops.filter((op) => op.op === 'setClipProps');
  eq(props.length, 3, 'scale / opacity / audio.gain 三条');
  const scaleOp = props.find((op) => op.path === 'transform.scale');
  eq(scaleOp.from, 1);
  eq(scaleOp.to, 1.5);
  const gainOp = props.find((op) => op.path === 'audio.gain');
  eq(gainOp.from, 1);
  eq(gainOp.to, 0.5);
});

test('②b 调色是一条 setClipEffect（整组替换，from=null 表示原本没有）', () => {
  const target = makeClip({ id: 'clp_2' });
  const ops = preset.buildPresetOps(target, saved);
  const effectOps = ops.filter((op) => op.op === 'setClipEffect');
  eq(effectOps.length, 1);
  eq(effectOps[0].from, null);
  eq(effectOps[0].to.params.brightness, -100);
});

test('②c 目标片段已经一样时 → 不产生操作（不会白占一个撤销步）', () => {
  const same = makeClip({ id: 'clp_3', transform: { scale: 1.5, opacity: 0.5 }, audio: { gain: 0.5 } });
  same.effects = [
    {
      id: 'fx_2',
      clipId: same.id,
      type: 'colorGrade',
      params: { brightness: -100 },
      keyframes: [],
      enabled: true,
      order: 0,
      source: 'ui',
    },
  ];
  const ops = preset.buildPresetOps(same, saved);
  eq(ops.filter((op) => op.op === 'setClipProps').length, 0);
});

test('②d 文字样式只套到文字片段（普通片段不凭空造文字）', () => {
  const textPreset = preset.createPreset('标题样式', { textStyle: { fontSize: 120, color: '#ff0000' } });
  const video = makeClip({ id: 'clp_v' });
  eq(preset.buildPresetOps(video, textPreset).length, 0);
  const textClip = makeClip({ id: 'clp_t', assetId: '', text: types.createTextContent() });
  const ops = preset.buildPresetOps(textClip, textPreset);
  eq(ops.length, 1);
  eq(ops[0].op, 'setClipText');
  eq(ops[0].to.fontSize, 120);
  eq(ops[0].to.content, '点击编辑文字', '内容必须保留');
});

test('②e 预设名清洗（空名给默认值、超长截断）', () => {
  eq(preset.createPreset('   ', { transform: { scale: 2 } }).name, '未命名预设');
  eq(preset.createPreset('x'.repeat(80), { transform: { scale: 2 } }).name.length, preset.MAX_PRESET_NAME);
});

console.log('\n[3] normalizePreset（旧数据/脏数据）');

test('③a 非对象 / 缺 id / 空 payload → null', () => {
  eq(preset.normalizePreset(null), null);
  eq(preset.normalizePreset({ payload: { transform: { scale: 2 } } }), null);
  eq(preset.normalizePreset({ id: 'pst_1', payload: {} }), null);
});

test('③b 越界值被夹住（opacity 5 → 1、scale -2 → 0）', () => {
  const normalized = preset.normalizePreset({
    id: 'pst_1',
    name: 'x',
    payload: { transform: { opacity: 5, scale: -2, blendMode: 'weird' } },
  });
  assert.ok(normalized !== null);
  eq(normalized.payload.transform.opacity, 1);
  eq(normalized.payload.transform.scale, 0);
  eq(normalized.payload.transform.blendMode, undefined);
});

test('③c 非数字字段被丢弃，不污染参数', () => {
  const normalized = preset.normalizePreset({
    id: 'pst_1',
    payload: { colorGrade: { brightness: 20, contrast: 'x' } },
  });
  assert.ok(normalized !== null);
  eq(normalized.payload.colorGrade, { brightness: 20 });
});

test('③d presetAppliesTo：文字样式对普通片段不适用', () => {
  const textOnly = preset.createPreset('t', { textStyle: { fontSize: 96 } });
  eq(preset.presetAppliesTo(textOnly, makeClip({ id: 'clp_v' })), false);
  eq(preset.presetAppliesTo(textOnly, makeClip({ id: 'clp_t', assetId: '', text: types.createTextContent() })), true);
  eq(preset.presetAppliesTo(saved, makeClip({ id: 'clp_v' })), true);
});

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} 预设单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}`);
    console.error(failure.error);
  }
  process.exit(1);
}
