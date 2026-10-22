/**
 * 轨道结构操作（复制 / 上移下移 / 拖拽排序 / 高度）的单测。
 *
 * ## 为什么这些必须有单测
 *
 * 它们的失败方式都**不是报错，而是"看起来对、其实错"**：
 * - 复制轨道漏字段 → 复制出来的轨少一个效果，只有对比才发现；
 * - 排序 order 撞号 → 显示顺序退化成按 id 排，用户看到"拖了但没动"；
 * - 高度不夹取 → 存盘写进 5000px，重开工程时整条时间线是空的。
 *
 * 运行：`node tests/track-ops.test.mjs`
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

const types = await load('src/core/types.ts', 'types');
const ops = await load('src/core/operations.ts', 'operations');
const trackOps = await load('src/core/trackOps.ts', 'trackOps');
const layout = await load('src/core/trackLayout.ts', 'trackLayout');

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
const ok = (value, m) => assert.ok(value, m);

/** 应用一批 op（模拟一次 dispatch）。 */
function applyAll(doc, operations) {
  return operations.reduce((current, op) => ops.applyOperation(current, op), doc);
}

/** 默认三条轨（V2/V1/A1）+ 一条视频轨上有 2 个片段。 */
function makeDoc() {
  const base = types.createProject({ tracks: types.createDefaultTracks() });
  return {
    ...base,
    tracks: base.tracks.map((track) =>
      track.id === 'trk_V1'
        ? {
            ...track,
            clips: [
              types.createClip({
                id: 'clp_a',
                assetId: 'ast_1',
                trackId: 'trk_V1',
                startFrame: 0,
                inFrame: 0,
                outFrame: 90,
                durationFrames: 90,
                speedMilli: 500,
                role: 'video',
                freeze: true,
              }),
              types.createClip({
                id: 'clp_b',
                assetId: 'ast_1',
                trackId: 'trk_V1',
                startFrame: 120,
                inFrame: 90,
                outFrame: 180,
                durationFrames: 90,
                reversed: true,
              }),
            ],
          }
        : track,
    ),
  };
}

/** 显示顺序的轨道名列表（上 → 下）。 */
const names = (doc) => types.trackDisplayOrder(doc.tracks).map((track) => track.name);
/** 显示顺序的 id 列表（上 → 下）。 */
const ids = (doc) => types.trackDisplayOrder(doc.tracks).map((track) => track.id);

console.log('[1] 复制轨道');

test('①a 轨数 +1，名字是「X 副本」，插在原轨**上方**', () => {
  const doc = makeDoc();
  const plan = trackOps.buildDuplicateTrackOps(doc, 'trk_V1');
  ok(!('message' in plan), plan.message ?? '');
  const after = applyAll(doc, plan.ops);
  eq(after.tracks.length, doc.tracks.length + 1);
  const order = names(after);
  // 默认 V2/V1/A1 → 复制 V1 后应是 V2 / V1 副本 / V1 / A1
  eq(order, ['V2', 'V1 副本', 'V1', 'A1']);
});

test('①b 片段全部复制，且 id 不同、其余字段逐字一致', () => {
  const doc = makeDoc();
  const plan = trackOps.buildDuplicateTrackOps(doc, 'trk_V1');
  const after = applyAll(doc, plan.ops);
  const source = doc.tracks.find((track) => track.id === 'trk_V1');
  const copy = after.tracks.find((track) => track.id === plan.trackId);
  ok(copy !== undefined, '找不到复制出来的轨');
  eq(copy.clips.length, source.clips.length);
  for (const [index, clip] of copy.clips.entries()) {
    const original = source.clips[index];
    ok(clip.id !== original.id, `片段 ${index} 的 id 没换`);
    eq(clip.trackId, plan.trackId, `片段 ${index} 的 trackId 没换`);
    // 除 id/trackId 外必须逐字一致（speedMilli / role / freeze / reversed 这些最容易漏）
    eq(
      { ...clip, id: 'x', trackId: 'y' },
      { ...original, id: 'x', trackId: 'y' },
      `片段 ${index} 的字段被改了`,
    );
  }
});

test('①c 复制是**深拷贝**：改副本的 effects 不影响原轨', () => {
  const doc = makeDoc();
  const plan = trackOps.buildDuplicateTrackOps(doc, 'trk_V1');
  const after = applyAll(doc, plan.ops);
  const copy = after.tracks.find((track) => track.id === plan.trackId);
  const source = after.tracks.find((track) => track.id === 'trk_V1');
  ok(copy.clips[0].effects !== source.clips[0].effects, 'effects 数组被共享了');
  ok(copy.clips[0].transform !== source.clips[0].transform, 'transform 被共享了');
});

test('①d 锁定/静音/隐藏/独奏/高度全部继承', () => {
  const base = makeDoc();
  const doc = {
    ...base,
    tracks: base.tracks.map((track) =>
      track.id === 'trk_V1' ? { ...track, muted: true, hidden: true, height: 88, solo: true } : track,
    ),
  };
  const plan = trackOps.buildDuplicateTrackOps(doc, 'trk_V1');
  const after = applyAll(doc, plan.ops);
  const copy = after.tracks.find((track) => track.id === plan.trackId);
  eq({ muted: copy.muted, hidden: copy.hidden, height: copy.height, solo: copy.solo }, {
    muted: true,
    hidden: true,
    height: 88,
    solo: true,
  });
});

test('①e 名字重复时自动加序号', () => {
  const doc = makeDoc();
  const first = applyAll(doc, trackOps.buildDuplicateTrackOps(doc, 'trk_V1').ops);
  const second = applyAll(first, trackOps.buildDuplicateTrackOps(first, 'trk_V1').ops);
  /**
   * 第二次复制插在 **V1 正上方**（`order = 原轨 + 1`），于是把第一次的副本顶上去了。
   * 这个顺序是刻意的：连续复制同一条轨，最新的那份紧贴原轨，用户"复制完接着调"不用找。
   */
  eq(names(second), ['V2', 'V1 副本', 'V1 副本 2', 'V1', 'A1']);
});

test('①f 复制出的轨 order 不与他人撞号（整组仍是 0..n-1）', () => {
  const doc = makeDoc();
  const after = applyAll(doc, trackOps.buildDuplicateTrackOps(doc, 'trk_V1').ops);
  const videoOrders = after.tracks
    .filter((track) => track.kind === 'video')
    .map((track) => track.order)
    .sort((a, b) => a - b);
  eq(videoOrders, [0, 1, 2], '视频组的 order 必须是连续的 0..n-1');
});

console.log('\n[2] 上移 / 下移');

test('②a 上移交换显示顺序，order 仍连续', () => {
  const doc = makeDoc();
  eq(names(doc), ['V2', 'V1', 'A1']);
  const plan = trackOps.buildShiftTrackOps(doc, 'trk_V1', -1);
  ok(!('message' in plan), plan.message ?? '');
  const after = applyAll(doc, plan.ops);
  eq(names(after), ['V1', 'V2', 'A1']);
  eq(
    after.tracks.filter((t) => t.kind === 'video').map((t) => t.order).sort((a, b) => a - b),
    [0, 1],
  );
});

test('②b 已在最上面 → 可读原因', () => {
  const doc = makeDoc();
  const plan = trackOps.buildShiftTrackOps(doc, 'trk_V2', -1);
  ok('message' in plan);
  eq(plan.message, '已经在最上面');
});

test('②c 已在最下面 → 可读原因', () => {
  const doc = makeDoc();
  const plan = trackOps.buildShiftTrackOps(doc, 'trk_A1', 1);
  ok('message' in plan);
  eq(plan.message, '已经在最下面');
});

test('②d **不跨类型**：视频轨的下移不会跑到音频轨下面', () => {
  const doc = makeDoc();
  // V1 是视频组里最下面的一条 → 下移应当被拒（而不是插到 A1 之后）
  const plan = trackOps.buildShiftTrackOps(doc, 'trk_V1', 1);
  ok('message' in plan, '视频轨不该能移到音频轨下面');
  eq(plan.message, '已经在最下面');
});

test('②e 撤销一步回到原顺序', () => {
  const doc = makeDoc();
  const plan = trackOps.buildShiftTrackOps(doc, 'trk_V1', -1);
  const after = applyAll(doc, plan.ops);
  const inverses = plan.ops.flatMap((op) => ops.invertOperation(op, after));
  const back = applyAll(after, inverses);
  eq(names(back), names(doc));
});

console.log('\n[3] 拖拽排序（目标下标 → order）');

test('③a 把最上面的 V2 拖到最下面', () => {
  const doc = makeDoc();
  // 组内顺序 [V2, V1]，把 V2 放到下标 1
  const plan = trackOps.buildMoveTrackOps(doc, 'trk_V2', 1);
  ok(!('message' in plan), plan.message ?? '');
  const after = applyAll(doc, plan.ops);
  eq(names(after), ['V1', 'V2', 'A1']);
});

test('③b 目标下标越界 → 夹到组内范围', () => {
  const doc = makeDoc();
  const plan = trackOps.buildMoveTrackOps(doc, 'trk_V2', 99);
  ok(!('message' in plan));
  const after = applyAll(doc, plan.ops);
  eq(names(after), ['V1', 'V2', 'A1']);
});

test('③c 位置没变 → 空 ops（不产生撤销步）', () => {
  const doc = makeDoc();
  const plan = trackOps.buildMoveTrackOps(doc, 'trk_V2', 0);
  ok(!('message' in plan));
  eq(plan.ops.length, 0);
});

test('③d 三条视频轨里把中间那条拖到最上面', () => {
  const base = makeDoc();
  const doc = types.createProject({
    tracks: [...base.tracks, types.createTrack({ id: 'trk_V3', kind: 'video', name: 'V3', order: 2 })],
  });
  eq(names(doc), ['V3', 'V2', 'V1', 'A1']);
  const plan = trackOps.buildMoveTrackOps(doc, 'trk_V2', 0);
  const after = applyAll(doc, plan.ops);
  eq(names(after), ['V2', 'V3', 'V1', 'A1']);
});

test('③e 拖拽落点：指针在第二行中线上方 → 插到该行之前', () => {
  const doc = makeDoc();
  const model = layout.trackLayout(doc);
  const rows = model.rows;
  // rows[0] = V2, rows[1] = V1, rows[2] = A1
  const aboveMiddle = trackOps.trackDropTarget(model, doc, 'trk_V1', rows[1].top + 1);
  eq(aboveMiddle.targetIndex, 1, '指针在 V1 上半 → 插到下标 1');
  const belowMiddle = trackOps.trackDropTarget(model, doc, 'trk_V1', rows[1].top + rows[1].height - 1);
  eq(belowMiddle.targetIndex, 2, '指针在 V1 下半 → 插到下标 2');
});

test('③f 拖拽落点：超出组末尾 → 插到最后（指示线画在最后一行底部）', () => {
  const doc = makeDoc();
  const model = layout.trackLayout(doc);
  const target = trackOps.trackDropTarget(model, doc, 'trk_V1', model.totalHeight + 50);
  eq(target.targetIndex, 2);
  const lastVideoRow = model.rows.filter((row) => row.kind === 'video').at(-1);
  eq(target.indicatorTop, lastVideoRow.top + lastVideoRow.height);
});

console.log('\n[4] 轨道高度');

test('④a 24–120 之外被夹住', () => {
  const doc = makeDoc();
  const low = applyAll(doc, [{ op: 'setTrackHeight', trackId: 'trk_V1', from: 60, to: 5 }]);
  eq(low.tracks.find((t) => t.id === 'trk_V1').height, 24);
  const high = applyAll(doc, [{ op: 'setTrackHeight', trackId: 'trk_V1', from: 60, to: 5000 }]);
  eq(high.tracks.find((t) => t.id === 'trk_V1').height, 120);
});

test('④b 高度真的影响布局（下一行的 top 跟着动）', () => {
  const doc = makeDoc();
  const before = layout.trackLayout(doc);
  const after = applyAll(doc, [{ op: 'setTrackHeight', trackId: 'trk_V2', from: 60, to: 120 }]);
  const afterLayout = layout.trackLayout(after);
  eq(afterLayout.rows[0].height, 120);
  eq(afterLayout.rows[1].top, before.rows[1].top + 60);
});

test('④c 撤销回到原高度', () => {
  const doc = makeDoc();
  const op = { op: 'setTrackHeight', trackId: 'trk_V1', from: 60, to: 100 };
  const after = applyAll(doc, [op]);
  const back = applyAll(after, ops.invertOperation(op, after));
  eq(back.tracks.find((t) => t.id === 'trk_V1').height, 60);
});

test('④d 拖拽换算：起点 + 位移，且夹取', () => {
  eq(trackOps.heightFromDrag(60, 20), 80);
  eq(trackOps.heightFromDrag(60, -100), 24);
  eq(trackOps.heightFromDrag(60, 500), 120);
});

console.log('\n[5] 操作描述（撤销 toast 文案）');

test('⑤a 三个新 op 都有中文描述', () => {
  eq(ops.describeOperation({ op: 'setTrackHeight', trackId: 'x', from: 60, to: 80 }), '调整轨道高度');
  eq(
    ops.describeOperation({ op: 'reorderTracks', changes: [{ trackId: 'x', from: 0, to: 1 }] }),
    '调整轨道顺序',
  );
  eq(
    ops.describeOperation({ op: 'setTrackFlag', trackId: 'x', flag: 'solo', from: false, to: true }),
    '独奏轨道',
  );
});

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} 轨道结构操作单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}`);
    console.error(failure.error);
  }
  process.exit(1);
}
