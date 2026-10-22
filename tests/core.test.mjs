/**
 * 核心层单测：operations（apply / invert / describe + 重算）与 store（事务合并 / 撤销栈）。
 *
 * 覆盖架构 §12 T03 验收：
 *   ① apply → invert → 再 apply 后 doc 深度相等（move / trim / remove / rippleShift / split）
 *   ② 连续 3 次同 mergeKey upsert 后 commit → past.length === 1
 *   ③ 60 次编辑后 past.length === 50（上限），撤销 60 次后 past 为空、future 50
 *   ④ 新操作后 future.length === 0
 *   ⑤ 100 片段工程，undo() 100 次后 doc 与初始快照深度相等
 *
 * 运行：`node tests/core.test.mjs`（esbuild 先把 TS 转译成 ESM 再 import）
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

/** 转译并加载一个 TS 模块（bundle 掉本地依赖与 react）。 */
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
const ops = await loadTsModule('src/core/operations.ts', 'operations');
const storeModule = await loadTsModule('src/core/store.ts', 'store');

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

function deepEq(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
  } catch (error) {
    throw new Error(
      `${label}：结构不相等 → ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function truthy(value, label) {
  if (!value) throw new Error(`${label}：期望为真，实际 ${String(value)}`);
}

function throws(fn, label) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(`${label}：期望抛异常，实际没有抛`);
}

/* ---------------- 夹具 ---------------- */

/** fixture 素材：tests/fixtures/sample-720p.mp4 = 1280×720 / 30fps / 240 帧（见 tech-preflight.md）。 */
function fixtureAsset() {
  return types.createAsset({
    id: 'ast_fixture',
    name: 'sample-720p.mp4',
    kind: 'video',
    fpsMilli: 30000,
    durationFrames: 240,
    durationSec: 8,
    width: 1280,
    height: 720,
    hasAudio: true,
    sampleRate: 48000,
    channels: 2,
    container: 'mp4',
    codecVideo: 'avc1.64001f',
    codecAudio: 'mp4a.40.2',
    exactSeek: true,
    hashKey: 'sample-720p.mp4|fixture',
  });
}

/**
 * 30fps 工程 + 3 条轨道（V2 / V1 / A1），无片段。
 * 轨道数组按规范顺序（order 升序，同 order 按 id）排列：A1(0) → V1(0) → V2(1)。
 */
function makeDoc() {
  return types.createProject({
    id: 'prj_test',
    name: '测试工程',
    fpsMilli: 30000,
    width: 1280,
    height: 720,
    assets: [fixtureAsset()],
    tracks: [
      types.createTrack({ id: 'trk_A1', kind: 'audio', name: 'A1', order: 0 }),
      types.createTrack({ id: 'trk_V1', kind: 'video', name: 'V1', order: 0 }),
      types.createTrack({ id: 'trk_V2', kind: 'video', name: 'V2', order: 1 }),
    ],
  });
}

/** 按 id 取轨道（避免依赖数组下标）。 */
function trackOf(doc, trackId) {
  const track = doc.tracks.find((candidate) => candidate.id === trackId);
  if (!track) throw new Error(`轨道不存在：${trackId}`);
  return track;
}

/** 30fps 素材 + 30fps 工程 → durationFrames === outFrame - inFrame。 */
function makeClip(id, options = {}) {
  const startFrame = options.startFrame ?? 0;
  const inFrame = options.inFrame ?? 0;
  const outFrame = options.outFrame ?? 240;
  const trackId = options.trackId ?? 'trk_V1';
  return types.createClip({
    id,
    assetId: 'ast_fixture',
    trackId,
    startFrame,
    inFrame,
    outFrame,
    durationFrames: tb.projectSpanFrames(outFrame - inFrame, 30000, 30000),
  });
}

/** 往 doc 里塞片段（返回新 doc）。 */
function withClips(doc, clips) {
  return clips.reduce((current, clip) => ops.applyOperation(current, { op: 'addClip', clip }), doc);
}

/** 应用一组逆向操作。 */
function applyAll(doc, list) {
  return list.reduce((current, op) => ops.applyOperation(current, op), doc);
}

const BASE = makeDoc();

/* ---------------- ① apply → invert → 再 apply ---------------- */

console.log('\n[1] apply → invert → 再 apply 后 doc 深度相等');

test('moveClip（跨轨）往返', () => {
  const doc0 = withClips(BASE, [makeClip('clp_1')]);
  const snapshot = JSON.parse(JSON.stringify(doc0));
  const op = {
    op: 'moveClip',
    clipId: 'clp_1',
    from: { trackId: 'trk_V1', startFrame: 0 },
    to: { trackId: 'trk_V2', startFrame: 30 },
  };
  const doc1 = ops.applyOperation(doc0, op);
  eq(trackOf(doc1, 'trk_V2').clips[0].startFrame, 30, '跨轨后起点');
  eq(trackOf(doc1, 'trk_V2').clips[0].trackId, 'trk_V2', '跨轨后轨道');
  eq(trackOf(doc1, 'trk_V1').clips.length, 0, '源轨已空');
  deepEq(doc0, snapshot, 'apply 不修改入参');

  const doc2 = applyAll(doc1, ops.invertOperation(op, doc1));
  deepEq(doc2, doc0, '逆向后回到 doc0');

  const doc3 = ops.applyOperation(doc2, op);
  deepEq(doc3, doc1, '再 apply 回到 doc1');
});

test('trimClip 往返（左裁 10 帧）', () => {
  const doc0 = withClips(BASE, [makeClip('clp_1')]);
  const op = {
    op: 'trimClip',
    clipId: 'clp_1',
    from: { inFrame: 0, outFrame: 240, startFrame: 0, durationFrames: 240 },
    to: { inFrame: 10, outFrame: 240, startFrame: 0, durationFrames: 230 },
  };
  const doc1 = ops.applyOperation(doc0, op);
  eq(trackOf(doc1, 'trk_V1').clips[0].inFrame, 10, 'inFrame');
  eq(trackOf(doc1, 'trk_V1').clips[0].durationFrames, 230, 'durationFrames');
  const doc2 = applyAll(doc1, ops.invertOperation(op, doc1));
  deepEq(doc2, doc0, '逆向后回到 doc0');
  deepEq(ops.applyOperation(doc2, op), doc1, '再 apply 回到 doc1');
});

test('removeClip → addClip 往返', () => {
  const doc0 = withClips(BASE, [makeClip('clp_1')]);
  const removed = trackOf(doc0, 'trk_V1').clips[0];
  const op = { op: 'removeClip', clipId: 'clp_1', removed };
  const doc1 = ops.applyOperation(doc0, op);
  eq(trackOf(doc1, 'trk_V1').clips.length, 0, '删除后轨道为空');
  const doc2 = applyAll(doc1, ops.invertOperation(op, doc1));
  deepEq(doc2, doc0, '逆向后回到 doc0');
  deepEq(ops.applyOperation(doc2, op), doc1, '再 apply 回到 doc1');
});

test('rippleShift 往返（波纹删除：后两段整体前移）', () => {
  const doc0 = withClips(BASE, [
    makeClip('clp_1', { startFrame: 0, outFrame: 240 }),
    makeClip('clp_2', { startFrame: 240, inFrame: 0, outFrame: 120 }),
    makeClip('clp_3', { startFrame: 360, inFrame: 0, outFrame: 120 }),
  ]);
  // 先删掉 clp_2，再把 clp_3 前移到 clp_2 的原位置
  const removedDoc = ops.applyOperation(doc0, {
    op: 'removeClip',
    clipId: 'clp_2',
    removed: trackOf(doc0, 'trk_V1').clips[1],
  });
  const op = { op: 'rippleShift', shifts: [{ clipId: 'clp_3', from: 360, to: 240 }] };
  const doc1 = ops.applyOperation(removedDoc, op);
  eq(trackOf(doc1, 'trk_V1').clips.length, 2, '波纹后剩 2 段');
  eq(trackOf(doc1, 'trk_V1').clips[1].id, 'clp_3', 'clp_3 排到第二位');
  eq(trackOf(doc1, 'trk_V1').clips[1].startFrame, 240, 'clp_3 前移到 240');
  const doc2 = applyAll(doc1, ops.invertOperation(op, doc1));
  deepEq(doc2, removedDoc, '逆向后回到波纹前');
  deepEq(ops.applyOperation(doc2, op), doc1, '再 apply 回到 doc1');
});

test('splitClip 往返（帧数守恒 R-016，逆操作需 2 条）', () => {
  const doc0 = withClips(BASE, [makeClip('clp_1', { outFrame: 240, startFrame: 0 })]);
  const op = {
    op: 'splitClip',
    clipId: 'clp_1',
    atProjectFrame: 120,
    left: { inFrame: 0, outFrame: 120, startFrame: 0, durationFrames: 120 },
    right: { inFrame: 120, outFrame: 240, startFrame: 120, durationFrames: 120 },
    newClipId: 'clp_1_right',
  };
  const doc1 = ops.applyOperation(doc0, op);
  const clips = trackOf(doc1, 'trk_V1').clips;
  eq(clips.length, 2, '切分后 2 个片段');
  eq(clips[0].durationFrames + clips[1].durationFrames, 240, '帧数守恒');
  eq(clips[0].outFrame, clips[1].inFrame, '左出点 = 右入点');

  const inverses = ops.invertOperation(op, doc1);
  eq(inverses.length, 2, 'splitClip 的逆操作是 2 条');
  const doc2 = applyAll(doc1, inverses);
  deepEq(doc2, doc0, '逆向后回到 doc0');

  const doc3 = ops.applyOperation(doc2, op);
  deepEq(doc3, doc1, '再 apply 回到 doc1');

  throws(() => ops.invertOperation(op), '缺少 doc 上下文时必须抛错');
});

test('setClipProps 往返（transform.scale）', () => {
  const doc0 = withClips(BASE, [makeClip('clp_1')]);
  const op = { op: 'setClipProps', clipId: 'clp_1', path: 'transform.scale', from: 1, to: 2.5 };
  const doc1 = ops.applyOperation(doc0, op);
  eq(trackOf(doc1, 'trk_V1').clips[0].transform.scale, 2.5, '缩放已写入');
  eq(trackOf(doc0, 'trk_V1').clips[0].transform.scale, 1, '入参未被修改');
  const doc2 = applyAll(doc1, ops.invertOperation(op, doc1));
  deepEq(doc2, doc0, '逆向后回到 doc0');
});

test('addTrack / removeTrack / renameTrack 往返', () => {
  const doc0 = withClips(BASE, [makeClip('clp_1')]);
  const track = types.createTrack({ id: 'trk_V3', kind: 'video', name: 'V3', order: 2 });
  const opAdd = { op: 'addTrack', track };
  const doc1 = ops.applyOperation(doc0, opAdd);
  eq(doc1.tracks.length, 4, '加轨后 4 轨');
  deepEq(applyAll(doc1, ops.invertOperation(opAdd, doc1)), doc0, '加轨逆向后回到 doc0');

  const opRemove = {
    op: 'removeTrack',
    trackId: 'trk_V2',
    removed: trackOf(doc0, 'trk_V2'),
  };
  const doc2 = ops.applyOperation(doc0, opRemove);
  eq(doc2.tracks.length, 2, '删轨后 2 轨');
  deepEq(applyAll(doc2, ops.invertOperation(opRemove, doc2)), doc0, '删轨逆向后回到 doc0');

  const opRename = { op: 'renameTrack', trackId: 'trk_V1', from: 'V1', to: '主视频' };
  const doc3 = ops.applyOperation(doc0, opRename);
  eq(trackOf(doc3, 'trk_V1').name, '主视频', '重命名生效');
  deepEq(applyAll(doc3, ops.invertOperation(opRename, doc3)), doc0, '重命名逆向后回到 doc0');
});

console.log('\n[2] 事务合并（一次拖拽 = 1 个撤销步）');

test('连续 3 次同 mergeKey upsert → past.length === 1 且保留最初 from', () => {
  const store = storeModule.createStore(withClips(BASE, [makeClip('clp_1')]));
  const tx = store.beginTransaction({ mergeKey: 'move:clp_1', label: '移动片段' });
  for (const startFrame of [5, 10, 15]) {
    tx.upsert({
      op: 'moveClip',
      clipId: 'clp_1',
      from: { trackId: 'trk_V1', startFrame: 0 },
      to: { trackId: 'trk_V1', startFrame },
    });
  }
  const entry = tx.commit();
  truthy(entry, 'commit 应返回撤销条目');
  eq(store.getState().undo.past.length, 1, 'past 长度');
  eq(entry.ops.length, 1, '只有 1 条 op');
  eq(entry.ops[0].to.startFrame, 15, '落地为最后一次值');
  eq(entry.ops[0].from.startFrame, 0, 'from 保留最初值');
  eq(entry.label, '移动片段', 'label');
  eq(trackOf(store.getDoc(), 'trk_V1').clips[0].startFrame, 15, 'doc 已更新');

  const result = store.undo();
  eq(result.opCount, 1, '撤销 1 条 op');
  eq(trackOf(store.getDoc(), 'trk_V1').clips[0].startFrame, 0, '撤销回到起点');
});

test('拖回原位 → commit 返回 null（空转不入栈）', () => {
  const store = storeModule.createStore(withClips(BASE, [makeClip('clp_1')]));
  const tx = store.beginTransaction({ mergeKey: 'move:clp_1', label: '移动片段' });
  tx.upsert({
    op: 'moveClip',
    clipId: 'clp_1',
    from: { trackId: 'trk_V1', startFrame: 0 },
    to: { trackId: 'trk_V1', startFrame: 0 },
  });
  eq(tx.commit(), null, '空转 commit');
  eq(store.getState().undo.past.length, 0, 'past 仍为空');
});

test('cancel 丢弃草稿且不改 doc、不入栈', () => {
  const store = storeModule.createStore(withClips(BASE, [makeClip('clp_1')]));
  const before = JSON.stringify(store.getDoc());
  const tx = store.beginTransaction({ mergeKey: 'move:clp_1', label: '移动片段' });
  tx.upsert({
    op: 'moveClip',
    clipId: 'clp_1',
    from: { trackId: 'trk_V1', startFrame: 0 },
    to: { trackId: 'trk_V1', startFrame: 99 },
  });
  tx.cancel();
  eq(JSON.stringify(store.getDoc()), before, 'doc 未变');
  eq(store.getState().undo.past.length, 0, '未入栈');
  throws(
    () => tx.upsert({ op: 'removeClip', clipId: 'clp_1', removed: makeClip('clp_1') }),
    '结束后 upsert',
  );
});

test('事务 setDraft 只写 ephemeral，不触发 doc 通知', () => {
  const store = storeModule.createStore(withClips(BASE, [makeClip('clp_1')]));
  let notifications = 0;
  const unsubscribe = store.subscribe(() => {
    notifications += 1;
  });
  const tx = store.beginTransaction({ mergeKey: 'move:clp_1', label: '移动片段' });
  tx.setDraft({
    kind: 'move',
    clipId: 'clp_1',
    trackId: 'trk_V1',
    startFrame: 42,
    inFrame: 0,
    outFrame: 240,
    durationFrames: 240,
    snapLineFrame: null,
    valid: true,
  });
  eq(notifications, 0, '拖动期间不通知 React');
  eq(store.getEphemeral().drag.startFrame, 42, 'draft 已写入 ephemeral');
  tx.cancel();
  eq(store.getEphemeral().drag, null, 'cancel 清空 draft');
  unsubscribe();
});

console.log('\n[3] 撤销栈上限与 future 清空');

test('60 次编辑后 past.length === 50；撤销 60 次后 past=0 / future=50', () => {
  const store = storeModule.createStore(withClips(BASE, [makeClip('clp_1')]));
  for (let index = 0; index < 60; index += 1) {
    store.dispatch(
      [
        {
          op: 'setClipProps',
          clipId: 'clp_1',
          path: 'transform.opacity',
          from: index / 100,
          to: (index + 1) / 100,
        },
      ],
      '修改不透明度',
    );
  }
  eq(store.getState().undo.past.length, 50, '上限 50 生效');
  eq(store.getState().undo.future.length, 0, 'future 为空');

  for (let index = 0; index < 60; index += 1) store.undo();
  eq(store.getState().undo.past.length, 0, '全部撤销后 past 为空');
  eq(store.getState().undo.future.length, 50, 'future 累积 50（同样有上限）');

  for (let index = 0; index < 60; index += 1) store.redo();
  eq(store.getState().undo.past.length, 50, '重做后 past 回到上限 50');
  eq(store.getState().undo.future.length, 0, 'future 清空');
});

test('新操作后 future 清空（R-025）', () => {
  const store = storeModule.createStore(withClips(BASE, [makeClip('clp_1')]));
  store.dispatch(
    [{ op: 'setClipProps', clipId: 'clp_1', path: 'enabled', from: true, to: false }],
    '禁用片段',
  );
  store.undo();
  eq(store.getState().undo.future.length, 1, '撤销后 future 有 1 条');
  store.dispatch(
    [{ op: 'setClipProps', clipId: 'clp_1', path: 'enabled', from: true, to: false }],
    '禁用片段',
  );
  eq(store.getState().undo.future.length, 0, '新操作后 future 清空');
});

test('100 片段工程：undo() 100 次后与初始快照深度相等', () => {
  const store = storeModule.createStore(makeDoc());
  const snapshot = JSON.parse(JSON.stringify(store.getDoc()));
  const clips = [];
  for (let index = 0; index < 100; index += 1) {
    clips.push(makeClip(`clp_bulk_${index}`, { startFrame: index * 240, outFrame: 240 }));
  }
  store.dispatch(
    clips.map((clip) => ({ op: 'addClip', clip })),
    '批量添加片段',
  );
  eq(store.getState().undo.past.length, 1, '批量添加 = 1 个撤销步');
  eq(trackOf(store.getDoc(), 'trk_V1').clips.length, 100, '100 个片段');

  for (let index = 0; index < 100; index += 1) store.undo();
  eq(store.getState().undo.past.length, 0, 'past 为空');
  deepEq(store.getDoc(), snapshot, '回到初始快照');
});

console.log('\n[4] 工程参数重算（§7.6）');

test('30000 → 24000：素材跨度不变、startFrame 比例映射、playhead 映射并 clamp', () => {
  const doc0 = withClips(BASE, [
    makeClip('clp_1', { startFrame: 0, outFrame: 240 }),
    makeClip('clp_2', { startFrame: 240, outFrame: 240 }),
  ]);
  const docWithPlayhead = { ...doc0, playheadFrame: 100 };
  const { doc: doc1, ops: batch } = ops.recomputeProject(docWithPlayhead, {
    fpsMilli: 24000,
    width: 1280,
    height: 720,
  });

  eq(doc1.fpsMilli, 24000, 'fps 已改');
  for (const track of doc1.tracks) {
    for (const clip of track.clips) {
      eq(clip.outFrame - clip.inFrame, 240, '素材跨度不变（不丢帧）');
      eq(clip.durationFrames, 192, '项目时长 = 240×24000/30000');
    }
  }
  eq(trackOf(doc1, 'trk_V1').clips[0].startFrame, 0, '片段 1 起点');
  eq(trackOf(doc1, 'trk_V1').clips[1].startFrame, 192, '片段 2 起点按比例映射');
  eq(doc1.playheadFrame, 80, 'playhead 100 → 80');
  truthy(batch.length >= 1, '返回等价操作序列');
  eq(batch[0].op, 'setProjectParams', '首条为重算 op');

  const again = ops.recomputeProject(doc1, { fpsMilli: 24000, width: 1280, height: 720 });
  deepEq(again.doc, doc1, '重算幂等');

  const store = storeModule.createStore(docWithPlayhead);
  store.dispatch(
    [
      {
        op: 'setProjectParams',
        from: { fpsMilli: 30000, width: 1280, height: 720 },
        to: { fpsMilli: 24000, width: 1280, height: 720 },
      },
    ],
    '修改工程参数',
  );
  eq(store.getDoc().fpsMilli, 24000, 'store 应用后 fps');
  eq(store.getState().undo.past.length, 1, '整批 = 1 个撤销步');
  store.undo();
  deepEq(store.getDoc(), docWithPlayhead, '撤销回到重算前');
});

test('30000 → 15000：时长按比例翻倍、同轨不重叠', () => {
  const doc0 = withClips(BASE, [
    makeClip('clp_1', { startFrame: 0, outFrame: 240 }),
    makeClip('clp_2', { startFrame: 240, outFrame: 240 }),
  ]);
  const { doc: doc1 } = ops.recomputeProject(doc0, { fpsMilli: 15000, width: 1280, height: 720 });
  const clips = trackOf(doc1, 'trk_V1').clips;
  eq(clips.length, 2, '不丢片段');
  eq(clips[0].durationFrames, 120, '240 素材帧 @15fps = 120 项目帧');
  truthy(clips[0].startFrame + clips[0].durationFrames <= clips[1].startFrame, '同轨不重叠');
  eq(ops.computeDurationFrames(doc1), 240, '总时长 = 2×120');
});

test('改 fps 再改回：所有 startFrame 完全相等（保间隙，不级联）', () => {
  // 两段之间有 60 帧间隙（= 2 秒 @30fps），改帧率后间隙必须仍在
  const doc0 = withClips(BASE, [
    makeClip('clp_1', { startFrame: 0, outFrame: 240 }),
    makeClip('clp_2', { startFrame: 300, outFrame: 240 }),
  ]);
  const to24 = ops.recomputeProject(doc0, { fpsMilli: 24000, width: 1280, height: 720 }).doc;
  eq(trackOf(to24, 'trk_V1').clips[0].startFrame, 0, '30→24：片段 1 起点');
  eq(trackOf(to24, 'trk_V1').clips[1].startFrame, 240, '30→24：片段 2 → 240（10 秒 @24fps）');
  eq(trackOf(to24, 'trk_V1').clips[1].durationFrames, 192, '30→24：时长 192');
  eq(
    trackOf(to24, 'trk_V1').clips[1].startFrame -
      (trackOf(to24, 'trk_V1').clips[0].startFrame + trackOf(to24, 'trk_V1').clips[0].durationFrames),
    48,
    '间隙仍在（60 帧 @30fps = 48 帧 @24fps = 2 秒）',
  );

  const backTo30 = ops.recomputeProject(to24, {
    fpsMilli: 30000,
    width: 1280,
    height: 720,
  }).doc;

  const before = trackOf(doc0, 'trk_V1').clips;
  const after = trackOf(backTo30, 'trk_V1').clips;
  eq(after.length, before.length, '片段数不变');
  for (let index = 0; index < before.length; index += 1) {
    eq(after[index].startFrame, before[index].startFrame, `片段 ${index + 1} startFrame 完全相等`);
    eq(after[index].durationFrames, before[index].durationFrames, `片段 ${index + 1} durationFrames 完全相等`);
    eq(after[index].inFrame, before[index].inFrame, `片段 ${index + 1} inFrame 不变（不重采样）`);
    eq(after[index].outFrame, before[index].outFrame, `片段 ${index + 1} outFrame 不变（不丢帧）`);
  }
  eq(backTo30.fpsMilli, 30000, '帧率回到 30000');
});

test('重算后绝对时间偏差 ≤ 1 帧（整数断言，不碰浮点）', () => {
  const doc0 = withClips(BASE, [
    makeClip('clp_1', { startFrame: 0, outFrame: 240 }),
    makeClip('clp_2', { startFrame: 300, outFrame: 240 }),
    makeClip('clp_3', { startFrame: 601, outFrame: 120 }),
  ]);
  for (const fpsMilli of [24000, 25000, 29970, 23976, 60000]) {
    const next = ops.recomputeProject(doc0, { fpsMilli, width: 1280, height: 720 }).doc;
    const oldClips = trackOf(doc0, 'trk_V1').clips;
    const newClips = trackOf(next, 'trk_V1').clips;
    eq(newClips.length, oldClips.length, `fps=${fpsMilli} 片段数不变`);
    for (let index = 0; index < oldClips.length; index += 1) {
      const drift = Math.abs(newClips[index].startFrame * 30000 - oldClips[index].startFrame * fpsMilli);
      if (drift > fpsMilli) {
        throw new Error(`fps=${fpsMilli} 片段 ${index + 1} 绝对时间偏差超 1 帧：drift=${drift}`);
      }
      eq(newClips[index].outFrame - newClips[index].inFrame, oldClips[index].outFrame - oldClips[index].inFrame, '素材跨度不变');
    }
  }
});

test('previewRecompute：给出受影响片段数与最大位移（R-015 二次确认用）', () => {
  const doc0 = withClips(BASE, [
    makeClip('clp_1', { startFrame: 0, outFrame: 240 }),
    makeClip('clp_2', { startFrame: 300, outFrame: 240 }),
  ]);
  const preview = ops.previewRecompute(doc0, { fpsMilli: 24000, width: 1280, height: 720 });
  eq(preview.affectedClipCount, 2, '两个片段都受影响');
  eq(preview.maxShiftFrames, 60, '最大位移 60 帧（300 → 240）');
  truthy(preview.ops.length >= 1, '返回等价操作序列');
  deepEq(trackOf(doc0, 'trk_V1').clips[1].startFrame, 300, '预演不改入参');
  eq(preview.doc.fpsMilli, 24000, '预演结果 fps');
});

test('createProject 默认带 V2/V1/A1 三条空轨（四区骨架与双击上轨依赖）', () => {
  const project = types.createProject();
  eq(project.tracks.length, 3, '三条轨');
  eq(project.tracks.map((track) => track.name).join(','), 'A1,V1,V2', '规范顺序 A1→V1→V2');
  eq(trackOf(project, 'trk_V1').kind, 'video', 'V1 是视频轨');
  eq(trackOf(project, 'trk_A1').kind, 'audio', 'A1 是音频轨');
  eq(trackOf(project, 'trk_V2').order, 1, 'V2 覆盖 V1（order 更大）');
  eq(trackOf(project, 'trk_V1').clips.length, 0, '默认空轨');
});

console.log('\n[5] 描述 / 选择态 / 播放头 / 错误条');

test('describeOperation 覆盖全部操作类型且非空', () => {
  const clip = makeClip('clp_1');
  const sampleOps = [
    { op: 'addClip', clip },
    { op: 'removeClip', clipId: 'clp_1', removed: clip },
    {
      op: 'moveClip',
      clipId: 'clp_1',
      from: { trackId: 'trk_V1', startFrame: 0 },
      to: { trackId: 'trk_V2', startFrame: 5 },
    },
    {
      op: 'trimClip',
      clipId: 'clp_1',
      from: { inFrame: 0, outFrame: 240, startFrame: 0, durationFrames: 240 },
      to: { inFrame: 1, outFrame: 240, startFrame: 0, durationFrames: 239 },
    },
    {
      op: 'splitClip',
      clipId: 'clp_1',
      atProjectFrame: 120,
      left: { inFrame: 0, outFrame: 120, startFrame: 0, durationFrames: 120 },
      right: { inFrame: 120, outFrame: 240, startFrame: 120, durationFrames: 120 },
      newClipId: 'clp_1r',
    },
    { op: 'setClipProps', clipId: 'clp_1', path: 'transform.scale', from: 1, to: 2 },
    { op: 'addTrack', track: types.createTrack({ id: 'trk_V3' }) },
    { op: 'removeTrack', trackId: 'trk_V3', removed: types.createTrack({ id: 'trk_V3' }) },
    { op: 'renameTrack', trackId: 'trk_V1', from: 'V1', to: 'V1x' },
    { op: 'rippleShift', shifts: [{ clipId: 'clp_1', from: 0, to: 10 }] },
    {
      op: 'setProjectParams',
      from: { fpsMilli: 30000, width: 1280, height: 720 },
      to: { fpsMilli: 24000, width: 1280, height: 720 },
    },
  ];
  for (const op of sampleOps) {
    const label = ops.describeOperation(op);
    truthy(typeof label === 'string' && label.length > 0, `describe(${op.op})`);
  }
});

test('播放头：写入 doc + 发总线，但不产生撤销步', () => {
  const store = storeModule.createStore(withClips(BASE, [makeClip('clp_1')]));
  const seen = [];
  const unsubscribe = store.playheadBus.subscribe((frame) => seen.push(frame));
  store.setPlayheadFrame(50);
  eq(store.getDoc().playheadFrame, 50, 'doc.playheadFrame');
  eq(store.playheadBus.get(), 50, '总线值');
  deepEq(seen, [50], '总线收到一次');
  eq(store.getState().undo.past.length, 0, '不进撤销栈');
  store.setPlayheadFrame(10);
  eq(store.getDoc().playheadFrame, 10, '可回退');
  unsubscribe();
});

test('选择态：选中/取消选中，进入 ephemeral 但不进撤销', () => {
  const store = storeModule.createStore(withClips(BASE, [makeClip('clp_1')]));
  store.setSelectedClipId('clp_1');
  eq(store.getSelectedClipId(), 'clp_1', '已选中');
  eq(store.getState().undo.past.length, 0, '不进撤销栈');
  store.setSelectedClipId('clp_not_exist');
  eq(store.getSelectedClipId(), 'clp_1', '不存在的 id 被忽略');
  store.setSelectedClipId(null);
  eq(store.getSelectedClipId(), null, '已取消选中');
});

test('错误条：push 保留最近 3 条，clear 清空', () => {
  const store = storeModule.createStore(makeDoc());
  for (let index = 0; index < 5; index += 1) {
    store.pushError(types.makeError('E_IDB_QUOTA', `配额错误 ${index}`));
  }
  eq(store.getEphemeral().errors.length, 3, '最多 3 条');
  eq(store.getEphemeral().errors[2].message, '配额错误 4', '保留最新');
  store.clearErrors();
  eq(store.getEphemeral().errors.length, 0, '已清空');
});

test('派生值：时长 / 片段数 / 轨道数 / 离线素材', () => {
  const doc = withClips(BASE, [
    makeClip('clp_1', { startFrame: 0, outFrame: 240 }),
    makeClip('clp_2', { startFrame: 300, outFrame: 100 }),
  ]);
  const derived = storeModule.computeProjectDerived(doc);
  eq(derived.clipCount, 2, 'clipCount');
  eq(derived.durationFrames, 400, 'durationFrames');
  eq(derived.trackCounts.video, 2, 'video 轨数');
  eq(derived.trackCounts.audio, 1, 'audio 轨数');
  deepEq(derived.offlineAssetIds, [], '无离线素材');
});

console.log('\n[6] 快捷键匹配与切分操作（T11）');

const keymap = await loadTsModule('src/core/keymap.ts', 'keymap');

/** 构造一个只含快捷键判断所需字段的事件对象。 */
function fakeKeyEvent(key, extra = {}) {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...extra,
  };
}

test('matchesKey：win 用 Ctrl、mac 用 Cmd（primary 归一）', () => {
  const split = keymap.KEY_BINDINGS.find((binding) => binding.id === 'splitAtPlayhead');
  truthy(split, '存在切分绑定');
  eq(keymap.matchesKey(fakeKeyEvent('b', { ctrlKey: true }), split, 'other'), true, 'win + Ctrl+B');
  eq(keymap.matchesKey(fakeKeyEvent('b', { metaKey: true }), split, 'other'), false, 'win 不认 Cmd');
  eq(keymap.matchesKey(fakeKeyEvent('b', { metaKey: true }), split, 'mac'), true, 'mac + Cmd+B');
  eq(keymap.matchesKey(fakeKeyEvent('b', { ctrlKey: true }), split, 'mac'), false, 'mac 不认 Ctrl');
  eq(keymap.matchesKey(fakeKeyEvent('b'), split, 'other'), false, '无修饰键不触发');
});

test('matchesKey：Shift+← 与 ← 不互相误命中', () => {
  const stepBack = keymap.KEY_BINDINGS.find((binding) => binding.id === 'stepBack');
  const stepBack10 = keymap.KEY_BINDINGS.find((binding) => binding.id === 'stepBack10');
  truthy(stepBack && stepBack10, '存在逐帧绑定');
  eq(keymap.matchesKey(fakeKeyEvent('ArrowLeft'), stepBack, 'other'), true, '←');
  eq(keymap.matchesKey(fakeKeyEvent('ArrowLeft', { shiftKey: true }), stepBack, 'other'), false, 'Shift+← 不命中 ←');
  eq(keymap.matchesKey(fakeKeyEvent('ArrowLeft', { shiftKey: true }), stepBack10, 'other'), true, 'Shift+←');
  eq(keymap.matchesKey(fakeKeyEvent('ArrowLeft'), stepBack10, 'other'), false, '← 不命中 Shift+←');
});

test('matchesKey：Ctrl+Z 与 Ctrl+Shift+Z 区分（撤销 vs 重做）', () => {
  const undo = keymap.KEY_BINDINGS.find((binding) => binding.id === 'undo');
  const redo = keymap.KEY_BINDINGS.find((binding) => binding.id === 'redo');
  truthy(undo && redo, '存在撤销/重做绑定');
  eq(keymap.matchesKey(fakeKeyEvent('z', { ctrlKey: true }), undo, 'other'), true, 'Ctrl+Z');
  eq(keymap.matchesKey(fakeKeyEvent('z', { ctrlKey: true, shiftKey: true }), redo, 'other'), true, 'Ctrl+Shift+Z');
  eq(keymap.matchesKey(fakeKeyEvent('z', { ctrlKey: true, shiftKey: true }), undo, 'other'), false, 'Shift 未声明时不命中');
});

test('isEditableTarget：输入框/文本域/下拉/可编辑区', () => {
  eq(keymap.isEditableTarget({ tagName: 'INPUT' }), true, 'INPUT');
  eq(keymap.isEditableTarget({ tagName: 'TEXTAREA' }), true, 'TEXTAREA');
  eq(keymap.isEditableTarget({ tagName: 'SELECT' }), true, 'SELECT');
  eq(keymap.isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true, 'contenteditable');
  eq(keymap.isEditableTarget({ tagName: 'DIV' }), false, '普通 DIV');
  eq(keymap.isEditableTarget(null), false, 'null');
});

test('buildSplitOperations：播放头切分帧数守恒且右半 inFrame = 左半 outFrame', () => {
  const doc = withClips(BASE, [makeClip('clp_1', { startFrame: 0, outFrame: 240 })]);
  const operations = keymap.buildSplitOperations(doc, 120, null);
  eq(operations.length, 1, '切出一个片段');
  const op = operations[0];
  eq(op.op, 'splitClip', 'op 类型');
  eq(op.left.durationFrames + op.right.durationFrames, 240, '帧数守恒（R-016）');
  eq(op.right.inFrame, op.left.outFrame, '右入点 = 左出点');
  eq(op.right.inFrame, 120, '30fps 同帧率下素材切点 = 120');
  eq(op.atProjectFrame, 120, '切点 = 播放头帧');
  // 边界：切点等于片段首/尾时不产生操作
  eq(keymap.buildSplitOperations(doc, 0, null).length, 0, '首帧不切');
  eq(keymap.buildSplitOperations(doc, 240, null).length, 0, '末帧不切');
  // 选中过滤：选中别的片段时不切它
  eq(keymap.buildSplitOperations(doc, 120, 'clp_other').length, 0, '选中其它片段');
});

test('splitAtPlayhead：一次 dispatch = 1 个撤销步，且未选中时切所有片段', () => {
  const doc = withClips(BASE, [
    makeClip('clp_1', { startFrame: 0, outFrame: 240 }),
    makeClip('clp_2', { startFrame: 60, outFrame: 240, trackId: 'trk_V2' }),
  ]);
  const store = storeModule.createStore(doc);
  store.setPlayheadFrame(120);
  const count = keymap.splitAtPlayhead(store);
  eq(count, 2, '两条轨上的片段都被切开');
  eq(store.getState().undo.past.length, 1, '整批 = 1 个撤销步');
  eq(trackOf(store.getDoc(), 'trk_V1').clips.length, 2, 'V1 变成两段');
  eq(trackOf(store.getDoc(), 'trk_V2').clips.length, 2, 'V2 变成两段');
  store.undo();
  eq(trackOf(store.getDoc(), 'trk_V1').clips.length, 1, '撤销后恢复一段');
});

test('removeSelectedClip：删除选中片段并清空选择，不进 doc 版本混乱', () => {
  const doc = withClips(BASE, [makeClip('clp_1', { startFrame: 0, outFrame: 240 })]);
  const store = storeModule.createStore(doc);
  store.setSelectedClipId('clp_1');
  eq(keymap.removeSelectedClip(store), true, '删除成功');
  eq(trackOf(store.getDoc(), 'trk_V1').clips.length, 0, '片段已删除');
  eq(store.getSelectedClipId(), null, '选择已清空');
  eq(store.getState().undo.past.length, 1, '1 个撤销步');
  eq(keymap.removeSelectedClip(store), false, '未选中时为 no-op');
});


/* ---------------- C 批：文字与调色效果（R-034 / R-035） ---------------- */

test('setClipEffect：写入调色 → 撤销后完全移除', () => {
  const doc0 = withClips(BASE, [makeClip('clp_1')]);
  const clip0 = trackOf(doc0, 'trk_V1').clips[0];
  const effect = {
    id: 'fx_1',
    clipId: 'clp_1',
    type: 'colorGrade',
    params: { brightness: 20, contrast: -10, saturation: 30, temperature: 5 },
    keyframes: [],
    enabled: true,
    order: 0,
    source: 'ui',
  };
  const op = { op: 'setClipEffect', clipId: 'clp_1', effectType: 'colorGrade', from: null, to: effect };
  const doc1 = ops.applyOperation(doc0, op);
  eq(trackOf(doc1, 'trk_V1').clips[0].effects.length, 1, '写入 1 个效果');
  eq(trackOf(doc1, 'trk_V1').clips[0].effects[0].params.brightness, 20, '参数正确');

  // 同类型再写一次是替换而不是叠加（调色是一组参数，不是滤镜链）
  const op2 = { op: 'setClipEffect', clipId: 'clp_1', effectType: 'colorGrade', from: effect, to: { ...effect, params: { ...effect.params, brightness: 40 } } };
  const doc2 = ops.applyOperation(doc1, op2);
  eq(trackOf(doc2, 'trk_V1').clips[0].effects.length, 1, '替换而非叠加');
  eq(trackOf(doc2, 'trk_V1').clips[0].effects[0].params.brightness, 40, '新参数生效');

  const inverse = ops.invertOperation(op, doc0);
  const back = ops.applyOperation(doc1, inverse[0]);
  eq(trackOf(back, 'trk_V1').clips[0].effects.length, 0, '撤销后效果被移除');
  void clip0;
});

test('setClipEffect：to=null 删除效果，撤销可恢复', () => {
  const doc0 = withClips(BASE, [makeClip('clp_1')]);
  const effect = {
    id: 'fx_1',
    clipId: 'clp_1',
    type: 'colorGrade',
    params: { brightness: 10 },
    keyframes: [],
    enabled: true,
    order: 0,
    source: 'ui',
  };
  const withEffect = ops.applyOperation(doc0, { op: 'setClipEffect', clipId: 'clp_1', effectType: 'colorGrade', from: null, to: effect });
  const removed = ops.applyOperation(withEffect, { op: 'setClipEffect', clipId: 'clp_1', effectType: 'colorGrade', from: effect, to: null });
  eq(trackOf(removed, 'trk_V1').clips[0].effects.length, 0, '效果已删除');
  const restored = ops.applyOperation(removed, ops.invertOperation({ op: 'setClipEffect', clipId: 'clp_1', effectType: 'colorGrade', from: effect, to: null })[0]);
  eq(trackOf(restored, 'trk_V1').clips[0].effects.length, 1, '撤销后恢复');
});

test('setClipText：文本片段可写入/撤销，且文本片段没有素材也能建', () => {
  const doc0 = withClips(BASE, []);
  const textClip = types.createClip({
    id: 'txt_1',
    assetId: '',
    trackId: 'trk_V2',
    startFrame: 30,
    inFrame: 0,
    outFrame: 90,
    durationFrames: 90,
    text: types.createTextContent({ content: '你好' }),
  });
  const doc1 = ops.applyOperation(doc0, { op: 'addClip', clip: textClip });
  eq(trackOf(doc1, 'trk_V2').clips.length, 1, '文本片段已加入');
  eq(trackOf(doc1, 'trk_V2').clips[0].text.content, '你好', '文本内容正确');
  eq(trackOf(doc1, 'trk_V2').clips[0].assetId, '', '文本片段不引用素材');

  const next = types.createTextContent({ content: '改过了', fontSize: 96 });
  const op = { op: 'setClipText', clipId: 'txt_1', from: textClip.text, to: next };
  const doc2 = ops.applyOperation(doc1, op);
  eq(trackOf(doc2, 'trk_V2').clips[0].text.content, '改过了', '内容已更新');
  eq(trackOf(doc2, 'trk_V2').clips[0].text.fontSize, 96, '字号已更新');
  const back = ops.applyOperation(doc2, ops.invertOperation(op, doc1)[0]);
  eq(trackOf(back, 'trk_V2').clips[0].text.content, '你好', '撤销回原文');
});

/* ---------------- [7] 轨道开关与锁定守卫 ---------------- */

console.log('\n[7] 轨道开关（muted/hidden/locked）与锁定守卫');

/** 一份带一个片段的工程（每条用例自己造，避免互相污染）。 */
function doc0() {
  return withClips(BASE, [makeClip('clp_1')]);
}

test('⑦a setTrackFlag 三个开关都能改，且逆操作能精确还原', () => {
  for (const flag of ['muted', 'hidden', 'locked']) {
    const before = doc0();
    const op = { op: 'setTrackFlag', trackId: 'trk_V1', flag, from: false, to: true };
    const after = ops.applyOperation(before, op);
    eq(trackOf(after, 'trk_V1')[flag], true, `${flag} 已置位`);
    const back = ops.applyOperation(after, ops.invertOperation(op, before)[0]);
    eq(trackOf(back, 'trk_V1')[flag], false, `${flag} 已还原`);
    // 其它两个开关不受影响（三个是独立字段，别写成一个位图）
    for (const other of ['muted', 'hidden', 'locked']) {
      if (other === flag) continue;
      eq(trackOf(after, 'trk_V1')[other], false, `${flag} 不影响 ${other}`);
    }
  }
});

test('⑦b 锁定轨上的片段不许改（moveClip / trimClip / removeClip 都抛）', () => {
  const locked = ops.applyOperation(doc0(), {
    op: 'setTrackFlag', trackId: 'trk_V1', flag: 'locked', from: false, to: true,
  });
  const clipId = trackOf(locked, 'trk_V1').clips[0].id;
  for (const op of [
    { op: 'removeClip', clipId, removed: trackOf(locked, 'trk_V1').clips[0] },
    { op: 'trimClip', clipId, from: { inFrame: 0, outFrame: 240 }, to: { inFrame: 10, outFrame: 240 } },
    { op: 'moveClip', clipId, from: { trackId: 'trk_V1', startFrame: 0 }, to: { trackId: 'trk_V1', startFrame: 60 } },
  ]) {
    let threw = false;
    try {
      ops.applyOperation(locked, op);
    } catch (error) {
      threw = /已锁定/.test(String(error instanceof Error ? error.message : error));
    }
    assert.ok(threw, `${op.op} 应当因为轨道锁定而抛错`);
  }
});

test('⑦c 锁定轨仍然可以解锁 / 改名（否则锁上就解不开了）', () => {
  const locked = ops.applyOperation(doc0(), {
    op: 'setTrackFlag', trackId: 'trk_V1', flag: 'locked', from: false, to: true,
  });
  const unlocked = ops.applyOperation(locked, {
    op: 'setTrackFlag', trackId: 'trk_V1', flag: 'locked', from: true, to: false,
  });
  eq(trackOf(unlocked, 'trk_V1').locked, false, '能解锁');
  const renamed = ops.applyOperation(locked, {
    op: 'renameTrack', trackId: 'trk_V1', from: 'V1', to: '主轨',
  });
  eq(trackOf(renamed, 'trk_V1').name, '主轨', '锁定不影响改名');
});

test('⑦d 往锁定轨上放片段也不行（addClip 同样被守卫拦住）', () => {
  const locked = ops.applyOperation(doc0(), {
    op: 'setTrackFlag', trackId: 'trk_V2', flag: 'locked', from: false, to: true,
  });
  const clip = types.createClip({
    id: 'clp_new', assetId: 'ast', trackId: 'trk_V2', startFrame: 0, inFrame: 0, outFrame: 30, durationFrames: 30,
  });
  let threw = false;
  try {
    ops.applyOperation(locked, { op: 'addClip', clip });
  } catch (error) {
    threw = /已锁定/.test(String(error instanceof Error ? error.message : error));
  }
  assert.ok(threw, 'addClip 到锁定轨应当抛错');
});

/* ---------------- [8] 删除素材（连同片段） ---------------- */

console.log('\n[8] removeAsset / restoreAsset');

test('⑨a 删除素材：素材与引用它的片段一起消失', () => {
  const doc = withClips(BASE, [makeClip('c1'), makeClip('c2', { startFrame: 240 })]);
  const removedClips = doc.tracks.flatMap((track) => track.clips);
  const asset = doc.assets[0];
  const after = ops.applyOperation(doc, {
    op: 'removeAsset',
    assetId: asset.id,
    removed: asset,
    removedClips,
  });
  eq(after.assets.length, 0, '素材已移除');
  eq(after.tracks.reduce((sum, track) => sum + track.clips.length, 0), 0, '片段也清空');
});

test('⑨b 逆操作把素材与片段原样放回（位置不变）', () => {
  const doc = withClips(BASE, [makeClip('c1'), makeClip('c2', { startFrame: 240 })]);
  const removedClips = doc.tracks.flatMap((track) => track.clips);
  const asset = doc.assets[0];
  const op = { op: 'removeAsset', assetId: asset.id, removed: asset, removedClips };
  const after = ops.applyOperation(doc, op);
  const back = applyAll(after, ops.invertOperation(op, after));
  eq(back.assets.length, 1, '素材回来了');
  const starts = back.tracks.flatMap((track) => track.clips.map((clip) => clip.startFrame));
  deepEq(starts, [0, 240], '片段位置不变');
});

test('⑨c 删除"没被使用的素材"也能撤销（没有片段可带）', () => {
  const doc = doc0();
  const asset = doc.assets[0];
  const op = { op: 'removeAsset', assetId: asset.id, removed: asset, removedClips: [] };
  const after = ops.applyOperation(doc, op);
  eq(after.assets.length, 0);
  const back = applyAll(after, ops.invertOperation(op, after));
  eq(back.assets.length, 1);
  eq(back.assets[0].id, asset.id);
});

/* ---------------- 汇总 ---------------- */

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} 核心层单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  console.log('失败用例：');
  for (const failure of failures) console.log(`  - ${failure.name}: ${failure.message}`);
  process.exit(1);
}
