/**
 * 多机位单测（R-057）：切换序列生成 + 可见性分布 + 指令识别。
 *
 * 多机位的正确性只有一条硬指标：**任意一帧最多只有一个机位可见**。
 * 两条都开着会重影，两条都关着会黑屏——所以这里逐帧扫。
 *
 * 运行：`node tests/multicam.test.mjs`
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

const multicam = await load('src/ai/multicam.ts', 'multicam');
const types = await load('src/core/types.ts', 'types');
const operations = await load('src/core/operations.ts', 'operations');

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
async function testAsync(name, fn) {
  try {
    await fn();
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

const FPS = 30000;

/** 两个机位：V1 / V2 各一段 0–120 帧。 */
function twoAngleDoc() {
  const asset = types.createAsset({
    id: 'ast_1', name: 'cam.mp4', fpsMilli: FPS, durationFrames: 120, durationSec: 4,
    width: 640, height: 360, hasAudio: true, container: 'mp4', exactSeek: true,
  });
  const clipA = types.createClip({ id: 'clp_a', assetId: 'ast_1', trackId: 'trk_V1', startFrame: 0, inFrame: 0, outFrame: 120, durationFrames: 120 });
  const clipB = types.createClip({ id: 'clp_b', assetId: 'ast_1', trackId: 'trk_V2', startFrame: 0, inFrame: 0, outFrame: 120, durationFrames: 120 });
  return {
    id: 'prj', name: '双机位', fpsMilli: FPS, width: 640, height: 360,
    sampleRate: 48000, frameMapPolicy: 'holdPrevious', durationRounding: 'halfUp',
    tracks: [
      types.createTrack({ id: 'trk_V2', kind: 'video', name: '机位B', order: 1, clips: [clipB] }),
      types.createTrack({ id: 'trk_V1', kind: 'video', name: '机位A', order: 0, clips: [clipA] }),
    ],
    assets: [asset], playheadFrame: 0, zoomLevel: 5, schemaVersion: 1, createdAt: 0, updatedAt: 0,
  };
}

function applyAll(doc, ops) {
  let sim = doc;
  for (const op of ops) sim = operations.applyOperation(sim, op);
  return sim;
}

/** 某帧上"可见的视频片段"（enabled 且覆盖该帧）。 */
function visibleAt(doc, frame) {
  const ids = [];
  for (const track of doc.tracks) {
    if (track.kind !== 'video') continue;
    for (const clip of track.clips) {
      if (!clip.enabled) continue;
      if (frame < clip.startFrame || frame >= clip.startFrame + clip.durationFrames) continue;
      ids.push(`${track.id}:${clip.id}`);
    }
  }
  return ids;
}

console.log('\n[1] angleTracks');

test('①a 只认有内容的视频轨，按屏幕顺序（上→下）', () => {
  const doc = twoAngleDoc();
  const angles = multicam.angleTracks(doc);
  eq(angles.map((track) => track.id), ['trk_V2', 'trk_V1']);
});

test('①b 只有一条机位时给出可读错误', async () => {
  const doc = twoAngleDoc();
  doc.tracks = [doc.tracks[0]];
  const plan = await multicam.planMulticam({ doc });
  eq(plan.ok, false);
  assert.match(plan.error.message, /至少 2 条/);
});

console.log('\n[2] planMulticam（固定间隔）');

await testAsync('②a 2 秒切换：4 秒素材切成 2 段、产生 1 次切换', async () => {
  const doc = twoAngleDoc();
  const plan = await multicam.planMulticam({ doc, switchSeconds: 2 });
  assert.ok(plan.ok, plan.ok ? '' : plan.error.message);
  eq(plan.value.switches, 1);
  eq(plan.value.angles.length, 2);
  assert.ok(plan.value.ops.some((op) => op.op === 'splitClip'), '应当有切分操作');
  assert.ok(plan.value.ops.some((op) => op.op === 'setClipProps' && op.path === 'enabled'), '应当有开关操作');
});

await testAsync('②b 任意一帧恰好一个机位可见（不重影也不黑屏）', async () => {
  const doc = twoAngleDoc();
  const plan = await multicam.planMulticam({ doc, switchSeconds: 2 });
  assert.ok(plan.ok);
  const after = applyAll(doc, plan.value.ops);
  for (let frame = 0; frame < 120; frame += 5) {
    const visible = visibleAt(after, frame);
    assert.strictEqual(visible.length, 1, `第 ${frame} 帧可见 ${visible.length} 个机位：${JSON.stringify(visible)}`);
  }
});

await testAsync('②c 前后两段用的是不同机位（真的切了）', async () => {
  const doc = twoAngleDoc();
  const plan = await multicam.planMulticam({ doc, switchSeconds: 2 });
  assert.ok(plan.ok);
  const after = applyAll(doc, plan.value.ops);
  const first = visibleAt(after, 30)[0];
  const second = visibleAt(after, 90)[0];
  assert.notStrictEqual(first.split(':')[0], second.split(':')[0], `两段都是 ${first}`);
});

await testAsync('②d 片段总时长不变（切分不丢帧）', async () => {
  const doc = twoAngleDoc();
  const plan = await multicam.planMulticam({ doc, switchSeconds: 2 });
  assert.ok(plan.ok);
  const after = applyAll(doc, plan.value.ops);
  for (const track of after.tracks) {
    const total = track.clips.reduce((sum, clip) => sum + clip.durationFrames, 0);
    eq(total, 120, `${track.id} 总时长`);
  }
});

await testAsync('②e 机位不足/时间太短时给出可读错误', async () => {
  const doc = twoAngleDoc();
  // 把两条轨的片段都缩到 1 帧 → 没有切换点
  for (const track of doc.tracks) {
    track.clips[0].durationFrames = 1;
  }
  const plan = await multicam.planMulticam({ doc, switchSeconds: 2 });
  eq(plan.ok, false);
  assert.match(plan.error.message, /没有产生任何切换/);
});

console.log('\n[3] parseMulticamRequest');

test('③a "多机位跟说话人" → 音频能量模式', () => {
  const parsed = multicam.parseMulticamRequest('多机位跟说话人');
  eq(parsed.followAudio, true);
});

test('③b "多机位每 3 秒切一次" → 固定 3 秒', () => {
  const parsed = multicam.parseMulticamRequest('多机位每 3 秒切一次');
  eq(parsed.followAudio, false);
  eq(parsed.switchSeconds, 3);
});

test('③c 没有机位词 → null', () => {
  eq(multicam.parseMulticamRequest('把音量调大'), null);
});

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} 多机位单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}`);
    console.error(failure.error);
  }
  process.exit(1);
}
