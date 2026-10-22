/**
 * T16 时间线控制器纯逻辑单测（不碰 DOM、不碰 React）。
 *
 * 覆盖 task:T16 的 ①–⑤⑦ 逻辑层：
 *   ① resolveMoveTarget：重叠避让（左/右/两侧相等取右）
 *   ② resolveTrim：裁剪最短 1 帧、不越素材边界
 *   ③ 跨轨判定：视频片段不可落音轨（valid=false）
 *   ④ snapFrame + collectSnapCandidates：8px 吸附、Alt 禁用
 *   ⑤ 一次拖拽一个撤销步：controller 状态机 + store 事务（用真 store 验证）
 *   ⑦ clampZoom / zoomScrollX：缩放范围 1–20、播放头锚点不动
 *
 * 运行：`node tests/timeline-controller.test.mjs`
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
const tb = await loadTsModule('src/core/timebase.ts', 'timebase');
const storeModule = await loadTsModule('src/core/store.ts', 'store');
const ctrl = await loadTsModule('src/ui/timelineController.ts', 'ctrl');

const { createProject, createClip, createAsset } = types;
const { createStore } = storeModule;

/* ---------------- 极简断言框架 ---------------- */

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

function truthy(value, label) {
  if (!value) throw new Error(`${label}：期望为真，实际 ${String(value)}`);
}

function deepEq(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
  } catch (error) {
    throw new Error(`${label}：结构不相等 → ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ---------------- 工程构造 ---------------- */

function makeDoc() {
  const doc = createProject({ width: 1280, height: 720, fpsMilli: 30000, zoomLevel: 5 });
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

function findClip(doc, id) {
  for (const t of doc.tracks) {
    const c = t.clips.find((x) => x.id === id);
    if (c) return c;
  }
  return null;
}

/* ---------------- ① resolveMoveTarget：重叠避让 ---------------- */

test('①a 无重叠直接落点', () => {
  const doc = makeDoc();
  addClip(doc, 'c1', 'trk_V1', 0, 100);
  const clip = findClip(doc, 'c1');
  const r = ctrl.resolveMoveTarget(doc, clip, 'trk_V1', 300);
  eq(r.valid, true, 'valid');
  eq(r.startFrame, 300, 'startFrame');
});

test('①b 重叠时向右避让（右侧空间更近）', () => {
  const doc = makeDoc();
  addClip(doc, 'c1', 'trk_V1', 0, 100);     // [0,100)
  addClip(doc, 'c2', 'trk_V1', 200, 100);   // [200,300)
  const clip = findClip(doc, 'c1');
  // 把 c1 移到 90 → [90,190)，与 c2 无重叠但和 c2 之间只有 10 帧，其实不重叠
  // 换个真正重叠的：把 c1 移到 150 → [150,250)，与 c2 [200,300) 重叠
  const r = ctrl.resolveMoveTarget(doc, clip, 'trk_V1', 150);
  // 左候选 = 0（无左侧片段），右候选 = 200 - 100 = 100
  // 左距离 150，右距离 50 → 取右 100
  eq(r.valid, true, 'valid');
  eq(r.startFrame, 100, 'startFrame');
});

test('①c 向左移动与左侧片段重叠时，贴左侧片段右边（左避让）', () => {
  const doc = makeDoc();
  addClip(doc, 'x1', 'trk_V1', 0, 50);        // [0,50)
  addClip(doc, 'x2', 'trk_V1', 250, 50);      // [250,300)
  const moving = addClip(doc, 'x3', 'trk_V1', 100, 50); // 长 50，当前 [100,150)
  // 把 x3 移到 30 → [30,80)，与 x1 [0,50) 重叠
  // 空隙：x1/x2 之间 [50,250) 宽 200 ≥ 50；尾部 [300,∞)
  // 候选：贴 x1 右边 50（距 30 为 20）、贴 x2 左边 200（距 170）、300（距 270）
  // 最近 = 50（左避让，贴 x1 右边）
  const r = ctrl.resolveMoveTarget(doc, moving, 'trk_V1', 30);
  eq(r.valid, true, 'valid');
  eq(r.startFrame, 50, 'startFrame（贴 x1 右边）');
});

test('①d 拖到音轨返回 valid=false', () => {
  const doc = makeDoc();
  addClip(doc, 'c1', 'trk_V1', 0, 100);
  const clip = findClip(doc, 'c1');
  const r = ctrl.resolveMoveTarget(doc, clip, 'trk_A1', 300);
  eq(r.valid, false, 'valid');
});

/* ---------------- ② resolveTrim ---------------- */

test('②a 右裁剪 outFrame 增大、不越素材边界', () => {
  const doc = makeDoc();
  const clip = addClip(doc, 'c1', 'trk_V1', 0, 100); // outFrame=100
  const r = ctrl.resolveTrim(doc, clip, 'right', 30);
  eq(r.outFrame, 130, 'outFrame');
  eq(r.durationFrames, 130, 'durationFrames');
  // 裁到超出素材 240 帧
  const r2 = ctrl.resolveTrim(doc, clip, 'right', 1000);
  eq(r2.outFrame, 240, 'outFrame clamp 到素材末尾');
});

test('②b 左裁剪 inFrame 增大、startFrame 同步、最短 1 帧', () => {
  const doc = makeDoc();
  const clip = addClip(doc, 'c1', 'trk_V1', 100, 50); // inFrame=0 outFrame=50 startFrame=100
  const r = ctrl.resolveTrim(doc, clip, 'left', 20);
  eq(r.inFrame, 20, 'inFrame');
  eq(r.outFrame, 50, 'outFrame');
  eq(r.startFrame, 120, 'startFrame 同步右移');
  eq(r.durationFrames, 30, 'durationFrames');
  // 裁到只剩 1 帧
  const r2 = ctrl.resolveTrim(doc, clip, 'left', 100);
  eq(r2.inFrame, 49, 'inFrame 停在 outFrame-1');
  eq(r2.durationFrames, 1, '最短 1 帧');
});

test('②c 右裁剪最短 1 帧', () => {
  const doc = makeDoc();
  const clip = addClip(doc, 'c1', 'trk_V1', 0, 50);
  const r = ctrl.resolveTrim(doc, clip, 'right', -1000);
  eq(r.outFrame, 1, 'outFrame 停在 inFrame+1');
  eq(r.durationFrames, 1, '最短 1 帧');
});

/* ---------------- ④ 吸附 ---------------- */

test('④a 吸附到片段边缘/播放头/0', () => {
  const doc = makeDoc();
  doc.playheadFrame = 60;
  addClip(doc, 'c1', 'trk_V1', 100, 50);
  const candidates = ctrl.collectSnapCandidates(doc, 'c1');
  // 播放头 60、0、其它片段边缘（这里 c1 是移动对象，只有 0 和播放头）
  truthy(candidates.includes(0), '含 0');
  truthy(candidates.includes(60), '含播放头');
  // 移动对象自身边缘不应算候选
  eq(candidates.includes(100), false, '不含自身 start');
});

test('④b 8px 阈值内吸附、阈值外不吸附、Alt 禁用', () => {
  // zoom=5，8px = 1.6 帧
  const zoom = 5;
  const snap1 = ctrl.snapFrame(101, [100], zoom, false);
  eq(snap1.snapped, true, '101 距 100 是 1 帧 ≤1.6 → 吸附');
  eq(snap1.frame, 100, '吸附到 100');
  const snap2 = ctrl.snapFrame(103, [100], zoom, false);
  eq(snap2.snapped, false, '103 距 100 是 3 帧 >1.6 → 不吸附');
  const snap3 = ctrl.snapFrame(101, [100], zoom, true);
  eq(snap3.snapped, false, 'Alt 禁用吸附');
  eq(snap3.frame, 101, 'Alt 下保持原帧');
});

/* ---------------- ⑦ 缩放 ---------------- */

test('⑦a clampZoom 范围 1–20', () => {
  eq(ctrl.clampZoom(0), 1, '下限 1');
  eq(ctrl.clampZoom(99), 20, '上限 20');
  eq(ctrl.clampZoom(7), 7, '范围内不变');
  eq(ctrl.clampZoom(Number.NaN), 5, 'NaN 回退默认');
});

test('⑦b zoomScrollX 保持锚点帧视口位置不变', () => {
  // anchor 帧 100，在视口 x=200 处；zoom 5→10
  const newScrollX = ctrl.zoomScrollX(100, 200, 10);
  // 缩放后 anchor 帧在视口位置 = 100*10 - newScrollX = 200
  eq(100 * 10 - newScrollX, 200, '锚点帧视口位置不变');
});

/* ---------------- ⑤ 一次拖拽一个撤销步（真 store） ---------------- */

test('⑤ 拖动移动：beginTransaction + upsert + commit = 1 个撤销步', () => {
  const doc = makeDoc();
  addClip(doc, 'c1', 'trk_V1', 0, 100);
  const store = createStore(doc);
  const clip = store.getDoc().tracks.find((t) => t.id === 'trk_V1').clips[0];

  // 模拟一次拖拽：多次 upsert 同一个 mergeKey，最终 commit
  const tx = store.beginTransaction({ mergeKey: 'move:c1', label: '移动片段' });
  tx.upsert(ctrl.buildMoveOperation(clip, 'trk_V1', 0, { trackId: 'trk_V1', startFrame: 10 }));
  tx.upsert(ctrl.buildMoveOperation(clip, 'trk_V1', 0, { trackId: 'trk_V1', startFrame: 20 }));
  tx.upsert(ctrl.buildMoveOperation(clip, 'trk_V1', 0, { trackId: 'trk_V1', startFrame: 30 }));
  const entry = tx.commit();

  truthy(entry !== null, 'commit 返回 entry');
  eq(store.getDoc().tracks.find((t) => t.id === 'trk_V1').clips[0].startFrame, 30, '最终落点 30');

  // 撤销一次应回到 0（证明整次拖拽只入栈一次）
  store.undo();
  eq(store.getDoc().tracks.find((t) => t.id === 'trk_V1').clips[0].startFrame, 0, '撤销一次回到 0');
});

test('⑤ 拖动到音轨：不产生撤销步、回弹', () => {
  const doc = makeDoc();
  addClip(doc, 'c1', 'trk_V1', 0, 100);
  const store = createStore(doc);
  const clip = store.getDoc().tracks.find((t) => t.id === 'trk_V1').clips[0];
  const r = ctrl.resolveMoveTarget(store.getDoc(), clip, 'trk_A1', 50);
  eq(r.valid, false, '音轨不可落');
  eq(store.getDoc().tracks.find((t) => t.id === 'trk_V1').clips[0].startFrame, 0, 'startFrame 不变（未 dispatch）');
});

/* ---------------- ⑧ 手柄命中（不需要先选中） ---------------- */

test('⑧a 片段未选中时，边缘也能命中裁剪手柄', () => {
  // 用户实测反馈："裁剪拖不动" —— 旧实现要求 selectedClipId === clip.id 才算手柄，
  // 于是第一次抓右端拖动命中 clip-body → 变成整体移动。
  const doc = makeDoc();
  addClip(doc, 'c1', 'trk_V1', 0, 100);
  const ephemeral = { selectedClipId: null, hoverClipId: null, drag: null, overlayMarks: [], isPlaying: false, busyLabel: null, errors: [] };
  const zoom = doc.zoomLevel;
  const rightEdge = 100 * zoom;

  eq(ctrl.hitTest(doc, ephemeral, rightEdge - 3, 24 + 56 + 28).zone, 'clip-handle-right', '未选中也能抓右端');
  eq(ctrl.hitTest(doc, ephemeral, 3, 24 + 56 + 28).zone, 'clip-handle-left', '未选中也能抓左端');
  eq(ctrl.hitTest(doc, ephemeral, 50 * zoom, 24 + 56 + 28).zone, 'clip-body', '中间仍是整体移动');
});

test('⑧b 选中后手柄更宽（8px vs 6px）', () => {
  const doc = makeDoc();
  addClip(doc, 'c1', 'trk_V1', 0, 100);
  const zoom = doc.zoomLevel;
  const y = 24 + 56 + 28;
  const unselected = { selectedClipId: null, hoverClipId: null, drag: null, overlayMarks: [], isPlaying: false, busyLabel: null, errors: [] };
  const selected = { ...unselected, selectedClipId: 'c1' };
  const probeX = 100 * zoom - 7; // 距右边缘 7px
  eq(ctrl.hitTest(doc, unselected, probeX, y).zone, 'clip-body', '未选中：6px 外算整体');
  eq(ctrl.hitTest(doc, selected, probeX, y).zone, 'clip-handle-right', '选中：8px 内算手柄');
});

/* ---------------- 汇总 ---------------- */

console.log(`\n✓ 时间线控制器纯逻辑：通过 ${passed} / ${passed + failures.length}`);
if (failures.length > 0) {
  console.log('失败用例：');
  for (const f of failures) console.log(`  - ${f.name} — ${f.message}`);
  process.exitCode = 1;
}
