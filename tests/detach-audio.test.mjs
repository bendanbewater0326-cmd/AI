/**
 * 分离音频单测（剪映/PR 的"分离音频"）。
 *
 * 硬指标：分离后**音画必须仍然同步**——原片段只出画、新片段只出声，
 * 两者的区间/入出点/速度完全一致；撤销一次要能整批回退。
 *
 * 运行：`node tests/detach-audio.test.mjs`
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

const detach = await load('src/core/detachAudio.ts', 'detachAudio');
const types = await load('src/core/types.ts', 'types');
const ops = await load('src/core/operations.ts', 'operations');

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
function eq(a, b, m) {
  assert.deepStrictEqual(a, b, m);
}

/** 一条视频轨（V1）+ 一条音频轨（A1），视频片段 0..120。 */
function makeDoc({ hasAudio = true, videoClip = [0, 120] } = {}) {
  const asset = types.createAsset({
    id: 'ast',
    name: 'a.mp4',
    kind: 'video',
    fpsMilli: 30000,
    durationFrames: 240,
    durationSec: 8,
    width: 1280,
    height: 720,
    hasAudio,
    container: 'mp4',
  });
  const clip = types.createClip({
    id: 'clp_v',
    assetId: 'ast',
    trackId: 'trk_V1',
    startFrame: videoClip[0],
    inFrame: 0,
    outFrame: videoClip[1],
    durationFrames: videoClip[1] - videoClip[0],
  });
  return types.createProject({
    assets: [asset],
    tracks: [
      types.createTrack({ id: 'trk_V1', kind: 'video', name: 'V1', order: 0, clips: [clip] }),
      types.createTrack({ id: 'trk_A1', kind: 'audio', name: 'A1', order: 0 }),
    ],
  });
}

function applyAll(doc, list) {
  return list.reduce((current, op) => ops.applyOperation(current, op), doc);
}

const allClips = (doc) => doc.tracks.flatMap((track) => track.clips);
const clipById = (doc, id) => allClips(doc).find((clip) => clip.id === id);

console.log('\n[1] buildDetachAudioOps');

test('①a 分离出 3 条操作（改 role + 加片段；已有空闲音频轨就不建轨）', () => {
  const doc = makeDoc();
  const plan = detach.buildDetachAudioOps(doc, 'clp_v');
  assert.ok(!('message' in plan), '不应失败');
  eq(plan.ops.length, 2, '不新建轨时是 2 条操作');
  eq(plan.trackId, 'trk_A1', '复用已有音频轨');
});

test('①b 应用后：原片段只出画，音频轨上多一条只出声的片段', () => {
  const doc = makeDoc();
  const plan = detach.buildDetachAudioOps(doc, 'clp_v');
  const after = applyAll(doc, plan.ops);

  const video = clipById(after, 'clp_v');
  eq(video.role, 'video', '原片段只出画');
  const audio = clipById(after, plan.audioClipId);
  eq(audio.role, 'audio', '新片段只出声');
  eq(audio.trackId, 'trk_A1');
  // 音画同步的硬指标：区间/入出点/速度完全一致
  eq(
    [audio.startFrame, audio.inFrame, audio.outFrame, audio.durationFrames, audio.speedMilli],
    [video.startFrame, video.inFrame, video.outFrame, video.durationFrames, video.speedMilli],
    '音画区间与速度必须一致',
  );
});

test('①c 一次撤销整批回退（片段数回到 1，role 回到未设置）', () => {
  const doc = makeDoc();
  const plan = detach.buildDetachAudioOps(doc, 'clp_v');
  const after = applyAll(doc, plan.ops);
  eq(allClips(after).length, 2);

  const inverses = plan.ops
    .map((op) => ops.invertOperation(op, after))
    .flat()
    .reverse();
  const back = applyAll(after, inverses);
  eq(allClips(back).length, 1, '片段数回到 1');
  eq(clipById(back, 'clp_v').role, undefined, 'role 回到未设置');
});

console.log('\n[2] 拒绝路径（要说人话）');

test('②a 没有音频的素材 → 可读原因', () => {
  const doc = makeDoc({ hasAudio: false });
  const plan = detach.buildDetachAudioOps(doc, 'clp_v');
  assert.ok('message' in plan);
  assert.match(plan.message, /没有音频/);
});

test('②b 声音还在时间线上 → 拒绝（否则会叠出第二份）', () => {
  const doc = makeDoc();
  const plan = detach.buildDetachAudioOps(doc, 'clp_v');
  const after = applyAll(doc, plan.ops);
  const again = detach.buildDetachAudioOps(after, 'clp_v');
  assert.ok('message' in again);
  assert.match(again.message, /声音已经在/);
  assert.match(again.message, /删掉它/, '要告诉用户怎么恢复');
});

test('②d 把分离出的音频**删掉**后 → 能重新分离（功能不是一次性的）', () => {
  const doc = makeDoc();
  const plan = detach.buildDetachAudioOps(doc, 'clp_v');
  const detached = applyAll(doc, plan.ops);

  // 用户把音频片段删了（画面片段仍是 role='video'）
  const audioClip = clipById(detached, plan.audioClipId);
  const withoutAudio = applyAll(detached, [
    { op: 'removeClip', clipId: audioClip.id, removed: audioClip },
  ]);
  eq(clipById(withoutAudio, 'clp_v').role, 'video', '画面片段仍只出画');
  eq(detach.detachAudioBlockReason(withoutAudio, clipById(withoutAudio, 'clp_v')), null, '应当允许再分离');

  const again = detach.buildDetachAudioOps(withoutAudio, 'clp_v');
  assert.ok(!('message' in again), `不该失败：${again.message ?? ''}`);
  // role 已经是 video，不需要再写一次（否则撤销栈多一步空状态）
  eq(again.ops.filter((op) => op.op === 'setClipProps').length, 0, '不重复改 role');
  const restored = applyAll(withoutAudio, again.ops);
  eq(allClips(restored).length, 2, '声音回来了');
  eq(clipById(restored, again.audioClipId).role, 'audio');
});

test('②e 音频片段被**裁短**但同源 → 仍然算"声音还在"（防叠出第二份）', () => {
  const doc = makeDoc();
  const plan = detach.buildDetachAudioOps(doc, 'clp_v');
  const detached = applyAll(doc, plan.ops);
  const trimmed = applyAll(detached, [
    { op: 'setClipProps', clipId: plan.audioClipId, path: 'durationFrames', from: 120, to: 60 },
  ]);
  assert.match(String(detach.detachAudioBlockReason(trimmed, clipById(trimmed, 'clp_v'))), /声音已经在/);
});

test('②f 音频片段被**拖到别处**仍同源 → 仍然算"声音还在"', () => {
  const doc = makeDoc();
  const plan = detach.buildDetachAudioOps(doc, 'clp_v');
  const detached = applyAll(doc, plan.ops);
  const moved = applyAll(detached, [
    { op: 'setClipProps', clipId: plan.audioClipId, path: 'startFrame', from: 0, to: 400 },
  ]);
  assert.match(String(detach.detachAudioBlockReason(moved, clipById(moved, 'clp_v'))), /声音已经在/);
});

test('②g 换一段素材（不同 assetId）的音频片段不算数', () => {
  const doc = makeDoc();
  const other = types.createClip({
    id: 'clp_other_audio',
    assetId: 'ast_other',
    trackId: 'trk_A1',
    startFrame: 0,
    inFrame: 0,
    outFrame: 120,
    durationFrames: 120,
    role: 'audio',
  });
  const withOther = ops.applyOperation(doc, { op: 'addClip', clip: other });
  eq(detach.detachAudioBlockReason(withOther, clipById(withOther, 'clp_v')), null);
});

test('②h 删除音频（只留画面）之后也能重新分离', () => {
  // 这条路径：普通片段 → 右键"删除音频"（role=video，但从未生成过音频片段）
  const doc = makeDoc();
  const muted = applyAll(doc, [
    { op: 'setClipProps', clipId: 'clp_v', path: 'role', from: undefined, to: 'video' },
  ]);
  eq(detach.detachAudioBlockReason(muted, clipById(muted, 'clp_v')), null);
  const plan = detach.buildDetachAudioOps(muted, 'clp_v');
  assert.ok(!('message' in plan));
});

test('②c 音频片段自己 → 可读原因', () => {
  const doc = makeDoc();
  const plan = detach.buildDetachAudioOps(doc, 'clp_v');
  const after = applyAll(doc, plan.ops);
  const onAudio = detach.buildDetachAudioOps(after, plan.audioClipId);
  assert.ok('message' in onAudio);
  assert.match(onAudio.message, /已经是音频/);
});

console.log('\n[3] 轨道选择');

test('③a 音频轨被占用 → 新建一条音频轨（不重叠）', () => {
  const doc = makeDoc();
  // 先把 A1 用别的片段占满同一区间
  const blocker = types.createClip({
    id: 'clp_block',
    assetId: 'ast',
    trackId: 'trk_A1',
    startFrame: 0,
    inFrame: 0,
    outFrame: 120,
    durationFrames: 120,
  });
  const occupied = ops.applyOperation(doc, { op: 'addClip', clip: blocker });
  const plan = detach.buildDetachAudioOps(occupied, 'clp_v');
  assert.ok(!('message' in plan));
  eq(plan.ops[0].op, 'addTrack', '第一条操作是建轨');
  eq(plan.trackId, 'trk_A2');
  const after = applyAll(occupied, plan.ops);
  eq(after.tracks.filter((track) => track.kind === 'audio').length, 2);
});

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} 分离音频单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}`);
    console.error(failure.error);
  }
  process.exit(1);
}
