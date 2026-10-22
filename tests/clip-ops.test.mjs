/**
 * T17 剪辑接线单测：波纹删除（R-018）、加轨（R-023）、撤销覆盖。
 *
 * 运行：node tests/clip-ops.test.mjs
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
const storeModule = await loadTsModule('src/core/store.ts', 'store');
const keymap = await loadTsModule('src/core/keymap.ts', 'keymap');

const { createProject, createClip, createAsset, createTrack } = types;
const { createStore } = storeModule;

let passed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { failures.push({ name, message: error instanceof Error ? error.message : String(error) }); console.log(`  ✗ ${name}`); console.log(`      ${error instanceof Error ? error.message : String(error)}`); }
}
function eq(a, b, label) { if (!Object.is(a, b)) throw new Error(`${label}：期望 ${String(b)}，实际 ${String(a)}`); }
function truthy(v, label) { if (!v) throw new Error(`${label}：期望为真`); }

function makeDoc() {
  const doc = createProject({ width: 1280, height: 720, fpsMilli: 30000 });
  doc.assets = [createAsset({ id: 'a1', name: 'a.mp4', kind: 'video', width: 1280, height: 720, fpsMilli: 30000, durationFrames: 240, durationSec: 8, hasAudio: true, container: 'mp4' })];
  return doc;
}

function addClip(doc, id, trackId, startFrame, duration) {
  const clip = createClip({ id, assetId: 'a1', trackId, startFrame, inFrame: 0, outFrame: duration, durationFrames: duration });
  const track = doc.tracks.find((t) => t.id === trackId);
  track.clips.push(clip);
  track.clips.sort((a, b) => a.startFrame - b.startFrame);
  return clip;
}

/* ---------------- 波纹删除（R-018） ---------------- */

test('R-018 波纹删除：同轨后续片段左移，其他轨不动', () => {
  const doc = makeDoc();
  addClip(doc, 'c1', 'trk_V1', 0, 100);
  addClip(doc, 'c2', 'trk_V1', 200, 50);
  addClip(doc, 'c3', 'trk_A1', 100, 60); // 音轨片段，不应动
  const store = createStore(doc);
  store.setSelectedClipId('c1');

  keymap.rippleDeleteSelectedClip(store);

  const v1 = store.getDoc().tracks.find((t) => t.id === 'trk_V1');
  const a1 = store.getDoc().tracks.find((t) => t.id === 'trk_A1');
  eq(v1.clips.length, 1, 'V1 剩 1 片段');
  eq(v1.clips[0].id, 'c2', '剩 c2');
  eq(v1.clips[0].startFrame, 100, 'c2 左移 100（200-100）');
  eq(a1.clips[0].startFrame, 100, 'A1 片段不动');

  // 撤销一次完整还原
  store.undo();
  const v1After = store.getDoc().tracks.find((t) => t.id === 'trk_V1');
  eq(v1After.clips.length, 2, '撤销后 V1 恢复 2 片段');
  eq(v1After.clips[0].startFrame, 0, 'c1 startFrame 恢复 0');
});

test('R-018 波纹删除 = 1 个撤销步', () => {
  const doc = makeDoc();
  addClip(doc, 'c1', 'trk_V1', 0, 100);
  addClip(doc, 'c2', 'trk_V1', 200, 50);
  const store = createStore(doc);
  store.setSelectedClipId('c1');
  keymap.rippleDeleteSelectedClip(store);
  keymap.rippleDeleteSelectedClip(store); // 第二次无选中，no-op
  // 只能撤销 1 次（第二次 no-op 不入栈）
  store.undo();
  eq(store.canUndo(), false, '撤销后栈空');
});

/* ---------------- 加轨（R-023） ---------------- */

test('R-023 加轨：addTrack + 撤销', () => {
  const doc = makeDoc();
  const store = createStore(doc);
  const before = store.getDoc().tracks.length;
  const newTrack = createTrack({ id: 'trk_V3', name: 'V3', kind: 'video', order: 2 });
  store.dispatch([{ op: 'addTrack', track: newTrack }], '添加轨道');
  eq(store.getDoc().tracks.length, before + 1, '轨道数 +1');
  eq(store.getDoc().tracks.some((t) => t.id === 'trk_V3'), true, 'V3 存在');

  store.undo();
  eq(store.getDoc().tracks.length, before, '撤销后轨道数还原');
  eq(store.getDoc().tracks.some((t) => t.id === 'trk_V3'), false, 'V3 被移除');
});

/* ---------------- 变速（C3） ---------------- */

test('C3a setClipSpeed：改 speedMilli 并重算 durationFrames', () => {
  const doc = makeDoc();
  addClip(doc, 'c1', 'trk_V1', 0, 240); // 240 帧跨度，1x → 240 项目帧
  const store = createStore(doc);
  const before = store.getDoc().tracks.find((t) => t.id === 'trk_V1').clips[0];
  eq(before.durationFrames, 240, '1x 基线');

  store.dispatch([{ op: 'setClipSpeed', clipId: 'c1', from: 1000, to: 2000 }], '修改速度');

  const after = store.getDoc().tracks.find((t) => t.id === 'trk_V1').clips[0];
  eq(after.speedMilli, 2000, 'speedMilli 变为 2000');
  eq(after.durationFrames, 120, '2x 时长减半');
  // 素材起止点绝不动（与切分守恒同一条纪律）
  eq(after.inFrame, 0, 'inFrame 不变');
  eq(after.outFrame, 240, 'outFrame 不变');
});

test('C3b setClipSpeed 可撤销（回到 1x 与原时长）', () => {
  const doc = makeDoc();
  addClip(doc, 'c1', 'trk_V1', 0, 240);
  const store = createStore(doc);
  store.dispatch([{ op: 'setClipSpeed', clipId: 'c1', from: 1000, to: 500 }], '修改速度');
  eq(store.getDoc().tracks.find((t) => t.id === 'trk_V1').clips[0].durationFrames, 480, '0.5x 时长翻倍');

  store.undo();
  const back = store.getDoc().tracks.find((t) => t.id === 'trk_V1').clips[0];
  eq(back.speedMilli, 1000, '撤销回 1x');
  eq(back.durationFrames, 240, '撤销回原时长');
});

test('C3c setClipSpeed 拒绝非法值（0 / 负数 / 小数）', () => {
  const doc = makeDoc();
  addClip(doc, 'c1', 'trk_V1', 0, 240);
  const store = createStore(doc);
  for (const bad of [0, -1000, 1500.5]) {
    let threw = false;
    try {
      store.dispatch([{ op: 'setClipSpeed', clipId: 'c1', from: 1000, to: bad }], '非法');
    } catch {
      threw = true;
    }
    truthy(threw, `speedMilli=${bad} 应被拒绝`);
  }
});

/* ---------------- 撤销覆盖 8 类操作（R-025 抽查） ---------------- */

test('R-025 撤销覆盖：move/trim/remove/ripple/addTrack/setClipProps', () => {
  const doc = makeDoc();
  addClip(doc, 'c1', 'trk_V1', 0, 100);
  const store = createStore(doc);
  const snap = JSON.parse(JSON.stringify(store.getDoc()));

  // 依次做 6 类操作
  store.dispatch([{ op: 'moveClip', clipId: 'c1', from: { trackId: 'trk_V1', startFrame: 0 }, to: { trackId: 'trk_V1', startFrame: 10 } }], '移动');
  store.dispatch([{ op: 'trimClip', clipId: 'c1', from: { inFrame: 0, outFrame: 100, startFrame: 10, durationFrames: 100 }, to: { inFrame: 0, outFrame: 90, startFrame: 10, durationFrames: 90 } }], '裁剪');
  store.dispatch([{ op: 'setClipProps', clipId: 'c1', path: 'transform.scale', from: 1, to: 1.5 }], '缩放');
  store.dispatch([{ op: 'addTrack', track: createTrack({ id: 'trk_V9', name: 'V9', kind: 'video', order: 9 }) }], '加轨');
  store.dispatch([{ op: 'rippleShift', shifts: [{ clipId: 'c1', from: 10, to: 20 }] }], '波纹');
  store.dispatch([{ op: 'removeClip', clipId: 'c1', removed: store.getDoc().tracks.find((t) => t.id === 'trk_V1').clips[0] }], '删除');

  // 逐步撤销 6 次
  for (let i = 0; i < 6; i += 1) store.undo();
  assert.deepStrictEqual(store.getDoc(), JSON.parse(JSON.stringify(snap)), '6 次撤销后与初始快照深度相等');
});

console.log(`\n✓ 剪辑接线单测：通过 ${passed} / ${passed + failures.length}`);
if (failures.length > 0) {
  console.log('失败用例：');
  for (const f of failures) console.log(`  - ${f.name} — ${f.message}`);
  process.exitCode = 1;
}
