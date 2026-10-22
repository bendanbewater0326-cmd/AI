/**
 * 定格帧 + 倒放的单测（`core/freeze` + `core/timebase` 的映射分支）。
 *
 * 这两条都不是"新建一种素材"，而是**改映射规则**：
 * - 定格：`freeze = true` → 永远返回 `inFrame`；
 * - 倒放：`reversed = true` → 返回 `outFrame - 1 - offset`。
 *
 * 所以测试的重点是**不变量**：
 *   ① 定格片段的素材跨度只有 1 帧，但项目时长 3 秒；
 *   ② 插入后同轨不重叠、跨轨不错位（波纹后移所有轨）；
 *   ③ 倒放的映射结果必须始终落在 `[inFrame, outFrame)` 内（否则 timebase 会抛）；
 *   ④ 两条都能一次撤销回退。
 *
 * 运行：`node tests/freeze.test.mjs`
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
const timebase = await load('src/core/timebase.ts', 'timebase');
const freeze = await load('src/core/freeze.ts', 'freeze');

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

/** 工程：V1 上一段 0..300 的视频（素材 300 帧），A1 上一段配乐 0..300。 */
function makeDoc() {
  const asset = types.createAsset({
    id: 'ast',
    name: 'a.mp4',
    kind: 'video',
    fpsMilli: 30000,
    durationFrames: 300,
    durationSec: 10,
    width: 1280,
    height: 720,
    hasAudio: true,
  });
  const music = types.createAsset({
    id: 'ast_music',
    name: 'm.mp3',
    kind: 'audio',
    fpsMilli: 30000,
    durationFrames: 300,
    durationSec: 10,
    hasAudio: true,
  });
  const video = types.createClip({
    id: 'clp_v',
    assetId: 'ast',
    trackId: 'trk_V1',
    startFrame: 0,
    inFrame: 0,
    outFrame: 300,
    durationFrames: 300,
  });
  const bgm = types.createClip({
    id: 'clp_m',
    assetId: 'ast_music',
    trackId: 'trk_A1',
    startFrame: 0,
    inFrame: 0,
    outFrame: 300,
    durationFrames: 300,
  });
  return types.createProject({
    assets: [asset, music],
    tracks: [
      types.createTrack({ id: 'trk_V1', kind: 'video', name: 'V1', order: 0, clips: [video] }),
      types.createTrack({ id: 'trk_A1', kind: 'audio', name: 'A1', order: 0, clips: [bgm] }),
    ],
  });
}

const applyAll = (doc, list) => list.reduce((current, op) => ops.applyOperation(current, op), doc);
const allClips = (doc) => doc.tracks.flatMap((track) => track.clips);
const clipById = (doc, id) => allClips(doc).find((clip) => clip.id === id);

console.log('\n[1] buildFreezeOps');

test('①a 播放头在片段中间 → 切一刀 + 波纹后移 + 插入 3 秒定格', () => {
  const doc = makeDoc();
  const plan = freeze.buildFreezeOps(doc, 'clp_v', 120);
  assert.ok(!('message' in plan), `不该失败：${plan.message ?? ''}`);
  eq(plan.durationFrames, 90, '30fps 下 3 秒 = 90 帧');
  const after = applyAll(doc, plan.ops);

  const frozen = clipById(after, plan.clipId);
  eq(frozen.freeze, true);
  eq(frozen.role, 'video', '定格只出画、不出声');
  eq([frozen.startFrame, frozen.durationFrames], [120, 90]);
  eq(frozen.outFrame - frozen.inFrame, 1, '素材只取 1 帧');
  eq(frozen.inFrame, 120, '冻的是播放头那一帧');
});

test('①b 同轨不重叠：前半段 0..120、定格 120..210、后半段 210..390', () => {
  const doc = makeDoc();
  const plan = freeze.buildFreezeOps(doc, 'clp_v', 120);
  const after = applyAll(doc, plan.ops);
  const onV1 = after.tracks.find((track) => track.id === 'trk_V1').clips
    .slice()
    .sort((a, b) => a.startFrame - b.startFrame);
  eq(onV1.length, 3);
  eq(onV1[0].startFrame, 0);
  eq(onV1[0].startFrame + onV1[0].durationFrames, 120, '前半段到 120 结束');
  eq(onV1[1].startFrame, 120, '定格紧接前半段');
  eq(onV1[2].startFrame, 210, '后半段被推到 210');
  for (let i = 1; i < onV1.length; i += 1) {
    const prev = onV1[i - 1];
    assert.ok(
      prev.startFrame + prev.durationFrames <= onV1[i].startFrame,
      `第 ${i} 段与前一段重叠了`,
    );
  }
});

test('①c 跨轨同步：配乐也一起后移（只推本轨会让音画全散）', () => {
  const doc = makeDoc();
  const plan = freeze.buildFreezeOps(doc, 'clp_v', 120);
  const after = applyAll(doc, plan.ops);
  // 配乐整段都在 120 之后？不——它从 0 开始，所以它不该被推。
  // 这里断言的是"插入点之后的片段会被推"，用一个从 150 开始的配乐片段来验。
  const doc2 = makeDoc();
  const later = types.createClip({
    id: 'clp_late',
    assetId: 'ast_music',
    trackId: 'trk_A1',
    startFrame: 150,
    inFrame: 150,
    outFrame: 250,
    durationFrames: 100,
  });
  const withLate = ops.applyOperation(doc2, { op: 'addClip', clip: later });
  const plan2 = freeze.buildFreezeOps(withLate, 'clp_v', 120);
  const after2 = applyAll(withLate, plan2.ops);
  eq(clipById(after2, 'clp_late').startFrame, 240, '插入点之后的片段 +90');
  eq(clipById(after, 'clp_m').startFrame, 0, '插入点之前的片段不动');
});

test('①d 播放头在片段开头 → 不切，直接插在前面', () => {
  const doc = makeDoc();
  const plan = freeze.buildFreezeOps(doc, 'clp_v', 0);
  assert.ok(!('message' in plan));
  const after = applyAll(doc, plan.ops);
  const onV1 = after.tracks.find((track) => track.id === 'trk_V1').clips;
  eq(onV1.length, 2, '只多了一个定格片段，没有切分');
  eq(clipById(after, 'clp_v').startFrame, 90, '原片段被整体推到 90');
});

test('①e 一次撤销整批回退（片段数回到 2）', () => {
  const doc = makeDoc();
  const plan = freeze.buildFreezeOps(doc, 'clp_v', 120);
  const after = applyAll(doc, plan.ops);
  eq(allClips(after).length, 4);
  const inverses = plan.ops
    .map((op) => ops.invertOperation(op, after))
    .flat()
    .reverse();
  const back = applyAll(after, inverses);
  eq(allClips(back).length, 2);
  eq(clipById(back, 'clp_v').startFrame, 0);
  eq(clipById(back, 'clp_v').durationFrames, 300, '切分也一起还原');
});

console.log('\n[2] 拒绝路径');

test('②a 播放头不在片段上 → 可读原因', () => {
  const doc = makeDoc();
  const plan = freeze.buildFreezeOps(doc, 'clp_v', 999);
  assert.ok('message' in plan);
  assert.match(plan.message, /播放头/);
});

test('②b 定格片段自己 → 拒绝（不叠定格）', () => {
  const doc = makeDoc();
  const first = freeze.buildFreezeOps(doc, 'clp_v', 120);
  const after = applyAll(doc, first.ops);
  const again = freeze.buildFreezeOps(after, first.clipId, 130);
  assert.ok('message' in again);
  assert.match(again.message, /已经是定格/);
});

console.log('\n[3] timebase 映射：定格与倒放');

test('③a 定格：整段都映射到 inFrame', () => {
  const doc = makeDoc();
  const plan = freeze.buildFreezeOps(doc, 'clp_v', 120);
  const after = applyAll(doc, plan.ops);
  const frozen = clipById(after, plan.clipId);
  const asset = after.assets.find((item) => item.id === 'ast');
  for (const offset of [0, 1, 45, 89]) {
    const frame = frozen.startFrame + offset;
    eq(
      timebase.mapProjectFrameToAssetFrame(frame, frozen, asset, after.fpsMilli),
      120,
      `偏移 ${offset} 应仍然显示第 120 帧`,
    );
  }
});

test('③b 倒放：首帧取素材末帧，末帧取素材首帧', () => {
  const doc = makeDoc();
  const reversed = applyAll(doc, [
    { op: 'setClipProps', clipId: 'clp_v', path: 'reversed', from: false, to: true },
  ]);
  const clip = clipById(reversed, 'clp_v');
  const asset = reversed.assets.find((item) => item.id === 'ast');
  eq(timebase.mapProjectFrameToAssetFrame(0, clip, asset, reversed.fpsMilli), 299, '第一帧 = 素材最后一帧');
  eq(timebase.mapProjectFrameToAssetFrame(299, clip, asset, reversed.fpsMilli), 0, '最后一帧 = 素材第一帧');
  eq(timebase.mapProjectFrameToAssetFrame(150, clip, asset, reversed.fpsMilli), 149, '中间对称');
});

test('③c 倒放不破坏"不越过 outFrame"的不变量（全帧扫一遍）', () => {
  const doc = makeDoc();
  const reversed = applyAll(doc, [
    { op: 'setClipProps', clipId: 'clp_v', path: 'reversed', from: false, to: true },
  ]);
  const clip = clipById(reversed, 'clp_v');
  const asset = reversed.assets.find((item) => item.id === 'ast');
  for (let frame = 0; frame < 300; frame += 1) {
    const mapped = timebase.mapProjectFrameToAssetFrame(frame, clip, asset, reversed.fpsMilli);
    assert.ok(
      mapped !== null && mapped >= clip.inFrame && mapped < clip.outFrame,
      `第 ${frame} 帧映射到 ${mapped}，越界了`,
    );
  }
});

test('③d 倒放 + 变速仍然落在区间内', () => {
  const doc = makeDoc();
  const clip = { ...clipById(doc, 'clp_v'), reversed: true, speedMilli: 2000 };
  const asset = doc.assets.find((item) => item.id === 'ast');
  const mapped = timebase.mapProjectFrameToAssetFrame(clip.startFrame, clip, asset, doc.fpsMilli);
  eq(mapped, 299, '起点仍是素材末帧');
  const mid = timebase.mapProjectFrameToAssetFrame(clip.startFrame + 74, clip, asset, doc.fpsMilli);
  assert.ok(mid !== null && mid >= 0 && mid < 300, `变速倒放映射越界：${mid}`);
});

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} 定格/倒放单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}`);
    console.error(failure.error);
  }
  process.exit(1);
}
