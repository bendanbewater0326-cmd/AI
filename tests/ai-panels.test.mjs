/**
 * AI 面板场景化单测（P1）：`addTextClip` / `setGrade` 两个新意图的
 * normalize（形状校验）与 compile（落地规则、越界 clamp、边界拒绝）。
 *
 * 覆盖：
 *   ① normalize：addTextClip/setGrade 的形状校验与坏字段丢弃
 *   ② addTextClip 编译：落文字轨、时长=偏好默认、建轨+落片一个撤销步、空/超长拒绝
 *   ③ setGrade 编译：写 colorGrade（复用 buildEffectOps）、参数 clamp −100..100、
 *      目标解析（选中优先→播放头视频）、文字片段拒绝、参数未变跳过
 *   ④ mock provider：文案请求回演示文案（4 风格）、调色请求回风格参数
 *
 * 运行：`node tests/ai-panels.test.mjs`
 */
import { buildSync } from 'esbuild';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..');
const TMP_DIR = path.join(HERE, '.tmp');

function loadEntry(name, lines) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const entry = path.join(TMP_DIR, `${name}-entry.ts`);
  fs.writeFileSync(entry, lines.join('\n'), 'utf8');
  const outfile = path.join(TMP_DIR, `${name}-entry.mjs`);
  buildSync({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
  });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

const mod = await loadEntry('ai-panels', [
  "export { compileIntents, MAX_AI_TEXT_LENGTH } from '../../src/ai/intents';",
  "export { normalizeIntents, createMockProvider } from '../../src/ai/provider';",
  "export { applyOperation } from '../../src/core/operations';",
  "export { createProject, createAsset, createClip, createTrack } from '../../src/core/types';",
  "export { DEFAULT_PREFS } from '../../src/core/prefs';",
]);

let passed = 0;
const failures = [];
const queue = [];
const section = (title) => queue.push({ title });
const test = (name, fn) => queue.push({ name, fn });
const eq = (actual, expected, label) => {
  assert.deepStrictEqual(actual, expected, `${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
};

/** V1 上一段 240 帧视频 + 工程默认三轨。 */
function makeDoc() {
  const project = mod.createProject({ width: 1280, height: 720, fpsMilli: 30000 });
  const asset = mod.createAsset({
    id: 'a1', name: 'sample.mp4', kind: 'video', fpsMilli: 30000,
    durationFrames: 240, durationSec: 8, width: 1280, height: 720,
    hasAudio: true, container: 'mp4',
  });
  const clip = mod.createClip({
    id: 'c1', assetId: 'a1', trackId: 'trk_V1',
    startFrame: 0, inFrame: 0, outFrame: 240, durationFrames: 240,
  });
  const tracks = project.tracks.map((track) =>
    track.id === 'trk_V1' ? { ...track, clips: [clip] } : track,
  );
  return { ...project, assets: [asset], tracks };
}

/* ---------------- ① normalize ---------------- */

section('① normalize 形状校验');

test('addTextClip：content 通过、空/非串丢弃', () => {
  const result = mod.normalizeIntents([
    { kind: 'addTextClip', content: '好物就该这样拍' },
    { kind: 'addTextClip', content: '   ' },
    { kind: 'addTextClip', content: 42 },
  ]);
  eq(result.intents, [{ kind: 'addTextClip', content: '好物就该这样拍' }], '合法保留');
  eq(result.dropped.length, 2, '两条坏字段被丢');
});

test('setGrade：grade 对象通过、缺 grade 丢弃、非数值字段归 0', () => {
  const result = mod.normalizeIntents([
    { kind: 'setGrade', clipId: 'c1', grade: { brightness: -30, contrast: '20', saturation: null, temperature: 999 } },
    { kind: 'setGrade', clipId: 'c1' },
  ]);
  eq(result.intents, [
    {
      kind: 'setGrade', clipId: 'c1',
      grade: { brightness: -30, contrast: 20, saturation: 0, temperature: 999 },
    },
  ], '形状归一（越界数值留给编译器 clamp）');
  eq(result.dropped.length, 1, '缺 grade 被丢');
});

/* ---------------- ② addTextClip 编译 ---------------- */

section('② addTextClip 编译');

test('落文字轨：无文字轨时建 T1 + 落片（一个撤销步的 ops 序列）', () => {
  const doc = makeDoc();
  const result = mod.compileIntents(doc, [{ kind: 'addTextClip', content: '注意看，接下来出乎意料' }]);
  eq(result.ok, true, '编译成功');
  if (!result.ok) return;
  eq(result.ops.length, 2, '建轨 + 落片两条 op（一次 dispatch = 一个撤销步）');
  eq(result.ops[0].op, 'addTrack', '先建轨');
  eq(result.ops[1].op, 'addClip', '再落片');
  const added = result.ops[1].clip;
  eq(added.trackId, result.ops[0].track.id, '片段落在新建文字轨');
  eq(added.text.content, '注意看，接下来出乎意料', '文案内容');
  // 时长 = 偏好默认（Node 无 localStorage → DEFAULT_PREFS.defaultClipSeconds = 3s @30fps = 90 帧）
  eq(added.durationFrames, Math.round(mod.DEFAULT_PREFS.defaultClipSeconds * 30), '时长走偏好默认');
});

test('已有文字轨且落点空闲时不重复建轨', () => {
  const doc = makeDoc();
  const first = mod.compileIntents(doc, [{ kind: 'addTextClip', content: '第一条' }]);
  if (!first.ok) throw new Error('前置失败');
  let sim = doc;
  for (const op of first.ops) sim = mod.applyOperation(sim, op);
  // 播放头挪到第一条之后（同位置会触发占用避让新建轨——那是正确行为，不是本用例）
  const firstEnd = first.ops[1].clip.startFrame + first.ops[1].clip.durationFrames;
  sim = { ...sim, playheadFrame: firstEnd };
  const second = mod.compileIntents(sim, [{ kind: 'addTextClip', content: '第二条' }]);
  eq(second.ok, true, '编译成功');
  if (!second.ok) return;
  eq(second.ops.length, 1, '只落片不建轨');
  eq(second.ops[0].op, 'addClip', 'op 类型');
});

test('空文案 / 超长文案拒绝（不截断）', () => {
  const doc = makeDoc();
  const empty = mod.compileIntents(doc, [{ kind: 'addTextClip', content: '   ' }]);
  eq(empty.ok, false, '空拒绝');
  const tooLong = '长'.repeat(mod.MAX_AI_TEXT_LENGTH + 1);
  const over = mod.compileIntents(doc, [{ kind: 'addTextClip', content: tooLong }]);
  eq(over.ok, false, '超长拒绝');
  if (over.ok) return;
  eq(over.error.includes('文案过长'), true, '可读错误');
});

/* ---------------- ③ setGrade 编译 ---------------- */

section('③ setGrade 编译');

test('写 colorGrade（复用 buildEffectOps 的 effect 构造）', () => {
  const doc = makeDoc();
  const result = mod.compileIntents(doc, [{ kind: 'setGrade', clipId: 'c1', grade: { brightness: -8, contrast: 18, saturation: -14, temperature: 26 } }]);
  eq(result.ok, true, '编译成功');
  if (!result.ok) return;
  eq(result.ops.length, 1, '一条 setClipEffect');
  const op = result.ops[0];
  eq(op.op, 'setClipEffect', 'op 类型');
  eq(op.effectType, 'colorGrade', '调色 effect');
  eq(op.to.params, { brightness: -8, contrast: 18, saturation: -14, temperature: 26 }, '参数');
});

test('越界参数 clamp 到 −100..100（与手动滑块同一规则）', () => {
  const doc = makeDoc();
  const result = mod.compileIntents(doc, [{ kind: 'setGrade', clipId: 'c1', grade: { brightness: -500, contrast: 999, saturation: 33.7, temperature: NaN } }]);
  eq(result.ok, true, '编译成功');
  if (!result.ok) return;
  eq(result.ops[0].to.params, { brightness: -100, contrast: 100, saturation: 34, temperature: 0 }, 'clamp + 取整 + NaN→0');
});

test('目标解析：不传 clipId 时取视频片段（跳过文字）', () => {
  const doc = makeDoc();
  const noId = mod.compileIntents(doc, [{ kind: 'setGrade', grade: { brightness: 5, contrast: 0, saturation: 0, temperature: 0 } }]);
  eq(noId.ok, true, '无 clipId 也能落到视频片段');
  if (!noId.ok) return;
  eq(noId.ops[0].clipId, 'c1', '落到 c1');
});

test('显式指定文字片段 → 拒绝（文字不能调色）', () => {
  const doc = makeDoc();
  const first = mod.compileIntents(doc, [{ kind: 'addTextClip', content: '文案' }]);
  if (!first.ok) throw new Error('前置失败');
  let sim = doc;
  for (const op of first.ops) sim = mod.applyOperation(sim, op);
  const textClipId = first.ops[first.ops.length - 1].clip.id;
  const result = mod.compileIntents(sim, [
    { kind: 'setGrade', clipId: textClipId, grade: { brightness: 5, contrast: 0, saturation: 0, temperature: 0 } },
  ]);
  eq(result.ok, false, '文字片段调色被拒');
  if (result.ok) return;
  eq(result.error.includes('文字片段不能调色'), true, '可读错误');
});

test('参数与现状相同 → 不产生撤销步（等值跳过）', () => {
  const doc = makeDoc();
  const first = mod.compileIntents(doc, [{ kind: 'setGrade', clipId: 'c1', grade: { brightness: 10, contrast: 0, saturation: 0, temperature: 0 } }]);
  if (!first.ok) throw new Error('前置失败');
  let sim = doc;
  for (const op of first.ops) sim = mod.applyOperation(sim, op);
  const again = mod.compileIntents(sim, [{ kind: 'setGrade', clipId: 'c1', grade: { brightness: 10, contrast: 0, saturation: 0, temperature: 0 } }]);
  eq(again.ok, false, '无变化 → 编译失败（不产生修改）');
});

/* ---------------- ④ mock provider ---------------- */

section('④ mock provider 演示规则');

test('文案请求回固定演示文案（四种风格 + 通用兜底）', async () => {
  const provider = mod.createMockProvider();
  const doc = makeDoc();
  const request = (text) => ({ text, tone: 'command', doc, selectedClipId: 'c1', playheadFrame: 0 });
  const anli = await provider.complete(request('生成一条种草风格的文案'));
  eq(anli.ok, true, '种草 ok');
  if (anli.ok) {
    eq(anli.value.intents[0].kind, 'addTextClip', '意图类型');
    eq(anli.value.intents[0].content.includes('种草') || anli.value.intents[0].content.includes('好物'), true, '演示文案内容匹配风格');
  }
  const generic = await provider.complete(request('帮我写一句文案'));
  eq(generic.ok, true, '通用 ok');
  if (generic.ok) eq(generic.value.intents[0].content.startsWith('（离线演示）'), true, '带演示前缀（E2E 可断言）');
});

test('调色请求回风格参数（复古胶片 / 电影感冷色）', async () => {
  const provider = mod.createMockProvider();
  const doc = makeDoc();
  const request = (text) => ({ text, tone: 'command', doc, selectedClipId: 'c1', playheadFrame: 0 });
  const film = await provider.complete(request('调成复古胶片感'));
  eq(film.ok, true, '复古 ok');
  if (film.ok) {
    const intent = film.value.intents[0];
    eq(intent.kind, 'setGrade', '意图类型');
    eq(intent.grade.temperature > 0, true, '复古 = 暖调');
  }
  const cold = await provider.complete(request('来点电影感冷色'));
  eq(cold.ok, true, '冷色 ok');
  if (cold.ok) eq(cold.value.intents[0].grade.temperature < 0, true, '电影感 = 冷调');
});

/* ---------------- 顺序执行 + 汇总 ---------------- */

for (const item of queue) {
  if (item.title !== undefined) {
    console.log(item.title);
    continue;
  }
  try {
    await item.fn();
    passed += 1;
    console.log(`  ✓ ${item.name}`);
  } catch (error) {
    failures.push({ name: item.name, message: error instanceof Error ? error.message : String(error) });
    console.log(`  ✗ ${item.name}`);
    console.log(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log('');
if (failures.length === 0) {
  console.log(`✓ AI 面板意图单测：通过 ${passed} / ${passed}`);
  process.exit(0);
} else {
  console.log(`✗ AI 面板意图单测：${failures.length} 项失败`);
  for (const item of failures) console.log(`  - ${item.name}：${item.message}`);
  process.exit(1);
}
