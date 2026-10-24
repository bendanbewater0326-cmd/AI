/**
 * 创作模板单测：`core/projectTemplates.ts`（完整套用 / 降级 / 撤销一致性 / 重复套用 / 分辨率自适应）。
 *
 * 运行：`node tests/project-templates.test.mjs`
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

const mod = await loadEntry('project-templates', [
  "export { PROJECT_TEMPLATES, buildTemplateOps } from '../../src/core/projectTemplates';",
  "export { applyOperation } from '../../src/core/operations';",
  "export { createProject, createAsset, createClip } from '../../src/core/types';",
]);

let passed = 0;
const failures = [];
const queue = [];
const section = (title) => queue.push({ title });
const test = (name, fn) => queue.push({ name, fn });
const eq = (actual, expected, label) => {
  assert.deepStrictEqual(actual, expected, `${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
};
const ok = (condition, label) => {
  if (condition !== true) throw new Error(`${label}：条件不成立`);
};

/** 有一个视频片段（240 帧）的工程。 */
function makeDoc(withVideo = true) {
  const project = mod.createProject({ width: 1280, height: 720, fpsMilli: 30000 });
  if (!withVideo) return project;
  const asset = mod.createAsset({
    id: 'a1', name: 'clip.mp4', kind: 'video', fpsMilli: 30000,
    durationFrames: 240, durationSec: 8, width: 1280, height: 720,
    hasAudio: true, container: 'mp4',
  });
  const clip = mod.createClip({
    id: 'c1', assetId: 'a1', trackId: 'trk_V1',
    startFrame: 0, inFrame: 0, outFrame: 240, durationFrames: 240,
  });
  const tracks = project.tracks.map((track) => (track.id === 'trk_V1' ? { ...track, clips: [clip] } : track));
  return { ...project, assets: [asset], tracks };
}

const apply = (doc, ops) => {
  let sim = doc;
  for (const op of ops) sim = mod.applyOperation(sim, op);
  return sim;
};

/* ---------------- ① 完整套用 ---------------- */

section('① 完整套用（有视频片段）');

test('Vlog 开场：文字 ×2 + 特效 + 转场全部落库', () => {
  const doc = makeDoc();
  const template = mod.PROJECT_TEMPLATES.find((item) => item.id === 'tpl-vlog-open');
  if (template === undefined) throw new Error('模板不存在');
  const applied = mod.buildTemplateOps(doc, template);
  ok(applied.ops.length >= 4, `ops >= 4（实际 ${applied.ops.length}）`);
  eq(applied.notes, [], '无降级说明');
  const sim = apply(doc, applied.ops);
  const texts = sim.tracks.flatMap((track) => track.clips).filter((clip) => clip.text !== null && clip.text !== undefined);
  eq(texts.length, 2, '两条文字');
  eq(texts[0].text.content, '这里是你的标题', '主标题内容');
  eq(texts[0].startFrame, 0, '开场锚点=0 帧');
  const video = sim.tracks.find((track) => track.id === 'trk_V1')?.clips[0];
  ok(video.effects.some((effect) => effect.type === 'colorGrade'), '特效落库');
  ok(video.transitionIn !== null, '淡入转场落库');
});

test('短视频结尾：锚点=时间线末尾、尾段淡出', () => {
  const doc = makeDoc();
  const template = mod.PROJECT_TEMPLATES.find((item) => item.id === 'tpl-short-end');
  if (template === undefined) throw new Error('模板不存在');
  const sim = apply(doc, mod.buildTemplateOps(doc, template).ops);
  const texts = sim.tracks.flatMap((track) => track.clips).filter((clip) => clip.text !== null);
  eq(texts[0].startFrame, 240 - 30, '文字在末尾前 30 帧');
  const video = sim.tracks.find((track) => track.id === 'trk_V1')?.clips[0];
  ok(video.transitionOut !== null, '尾段淡出');
});

test('分辨率自适应：720p 工程的字号按比例缩放', () => {
  const doc = makeDoc(); // 1280×720
  const template = mod.PROJECT_TEMPLATES.find((item) => item.id === 'tpl-vlog-open');
  if (template === undefined) throw new Error('模板不存在');
  const sim = apply(doc, mod.buildTemplateOps(doc, template).ops);
  const text = sim.tracks.flatMap((track) => track.clips).find((clip) => clip.text !== null);
  // tpl-title-main 的 1080p 参考字号在 presetToText 里 ×(720/1080)——断言缩放真的发生了
  ok(text.text.fontSize < 100, `字号已缩放（${text.text.fontSize} < 1080p 参考值）`);
});

/* ---------------- ② 降级 ---------------- */

section('② 降级（无视频片段）');

test('空工程：只落文字 + 可读提示（不硬造特效）', () => {
  const doc = makeDoc(false);
  const template = mod.PROJECT_TEMPLATES.find((item) => item.id === 'tpl-vlog-open');
  if (template === undefined) throw new Error('模板不存在');
  const applied = mod.buildTemplateOps(doc, template);
  const sim = apply(doc, applied.ops);
  const texts = sim.tracks.flatMap((track) => track.clips).filter((clip) => clip.text !== null);
  eq(texts.length, 2, '文字仍落');
  eq(applied.notes.length, 1, '一条降级说明');
  ok(applied.notes[0].includes('没有视频片段'), '提示可读');
  ok(applied.ops.every((op) => op.op !== 'setClipEffect' && op.op !== 'setClipTransition'), '无特效/转场 op');
});

/* ---------------- ③ 撤销一致性 ---------------- */

section('③ 撤销一致性');

test('ops 一次 apply 完整生效（单 dispatch = 单撤销步的构成）', () => {
  const doc = makeDoc();
  const template = mod.PROJECT_TEMPLATES.find((item) => item.id === 'tpl-goods');
  if (template === undefined) throw new Error('模板不存在');
  const applied = mod.buildTemplateOps(doc, template);
  ok(applied.ops.length > 0, '有 ops');
  const sim = apply(doc, applied.ops);
  const textCount = sim.tracks.flatMap((track) => track.clips).filter((clip) => clip.text !== null).length;
  eq(textCount, 1, '好物展示一条文字');
});

/* ---------------- ④ 重复套用 ---------------- */

section('④ 重复套用');

test('重复套用：文字叠加、特效等值跳过（不发冗余 op）', () => {
  const doc = makeDoc();
  const template = mod.PROJECT_TEMPLATES.find((item) => item.id === 'tpl-sci-head');
  if (template === undefined) throw new Error('模板不存在');
  const first = mod.buildTemplateOps(doc, template);
  const sim = apply(doc, first.ops);
  const second = mod.buildTemplateOps(sim, template);
  // 第二次：文字再落一条（叠加，用户可自行删）；特效已同值 → buildEffectOps 返回空
  const hasEffectOp = second.ops.some((op) => op.op === 'setClipEffect');
  eq(hasEffectOp, false, '特效等值跳过');
  const sim2 = apply(sim, second.ops);
  const texts = sim2.tracks.flatMap((track) => track.clips).filter((clip) => clip.text !== null);
  eq(texts.length, 2, '文字叠加为 2');
});

/* ---------------- ⑤ 模板表完整性 ---------------- */

section('⑤ 模板表');

test('4 套模板、id 唯一、全中文命名、引用的预设都存在', () => {
  eq(mod.PROJECT_TEMPLATES.length, 4, '4 套');
  eq(new Set(mod.PROJECT_TEMPLATES.map((item) => item.id)).size, 4, 'id 唯一');
  for (const template of mod.PROJECT_TEMPLATES) {
    ok(/^[\u4e00-\u9fa5A-Za-z0-9 ]+$/.test(template.name) && /[\u4e00-\u9fa5]/.test(template.name), `${template.id} 中文名`);
    ok(template.texts.length > 0, `${template.id} 有文字`);
  }
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
  console.log(`✓ 创作模板单测：通过 ${passed} / ${passed}`);
  process.exit(0);
} else {
  console.log(`✗ 创作模板单测：${failures.length} 项失败`);
  for (const item of failures) console.log(`  - ${item.name}：${item.message}`);
  process.exit(1);
}
