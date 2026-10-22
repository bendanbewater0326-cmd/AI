/**
 * 落轨规则单测（`core/placement`）。
 *
 * 这条规则原来藏在 `AssetPanel.defaultTrackId()` 里，一句话"视频永远 V1"，
 * 于是**播放头落在已有片段上时双击素材 → 同轨重叠**（画面叠着、音量翻倍），
 * 而且用户永远没办法把第二段素材放到第二条轨上（多机位 R-057 因此不可达）。
 *
 * 运行：`node tests/placement.test.mjs`
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

const placement = await load('src/core/placement.ts', 'placement');
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
function eq(a, b, m) {
  assert.deepStrictEqual(a, b, m);
}

/** 造一个工程：默认三条轨（V2/V1/A1），可选塞片段。 */
function docWith(clipsByTrack = {}) {
  const tracks = types.createDefaultTracks().map((track) => ({
    ...track,
    clips: (clipsByTrack[track.id] ?? []).map(([start, duration], index) =>
      types.createClip({
        id: `clp_${track.id}_${index}`,
        assetId: 'ast',
        trackId: track.id,
        startFrame: start,
        inFrame: 0,
        outFrame: duration,
        durationFrames: duration,
      }),
    ),
  }));
  return types.createProject({ tracks });
}

console.log('\n[1] trackRangeFree（左闭右开）');

test('①a 空轨任何区间都空闲', () => {
  const doc = docWith();
  const track = doc.tracks.find((item) => item.id === 'trk_V1');
  eq(placement.trackRangeFree(track, 0, 240), true);
});

test('①b 与已有片段重叠 → 不空闲', () => {
  const doc = docWith({ trk_V1: [[0, 240]] });
  const track = doc.tracks.find((item) => item.id === 'trk_V1');
  eq(placement.trackRangeFree(track, 100, 60), false, '整段落在里面');
  eq(placement.trackRangeFree(track, 200, 100), false, '尾部越界');
  eq(placement.trackRangeFree(track, 0, 240), false, '完全重合');
});

test('①c 相邻不算重叠（前一段结束点 = 后一段起点）', () => {
  const doc = docWith({ trk_V1: [[0, 240]] });
  const track = doc.tracks.find((item) => item.id === 'trk_V1');
  eq(placement.trackRangeFree(track, 240, 60), true, '紧接在后面');
  eq(placement.trackRangeFree(track, -60, 60), true, '紧接在前面（负起点由调用方保证非负）');
});

console.log('\n[2] pickTrackForInsert');

test('②a 全空 → 首选 V1（保持"第一段素材落 V1"的既有预期）', () => {
  eq(placement.pickTrackForInsert(docWith(), 'video', 0, 240), 'trk_V1');
});

test('②b V1 在播放头被占用 → 换 V2（这就是多机位的入口）', () => {
  const doc = docWith({ trk_V1: [[0, 240]] });
  eq(placement.pickTrackForInsert(doc, 'video', 0, 240), 'trk_V2');
});

test('②c V1/V2 都占用 → null（调用方新建轨，而不是硬塞重叠）', () => {
  const doc = docWith({ trk_V1: [[0, 240]], trk_V2: [[0, 240]] });
  eq(placement.pickTrackForInsert(doc, 'video', 0, 240), null);
});

test('②d V1 后半段占用、播放头在空闲处 → 仍回 V1', () => {
  const doc = docWith({ trk_V1: [[120, 120]] });
  eq(placement.pickTrackForInsert(doc, 'video', 0, 120), 'trk_V1', '0-120 是空的');
});

test('②e 隐藏/锁定的轨不参与自动落轨', () => {
  const doc = docWith({ trk_V1: [[0, 240]] });
  doc.tracks = doc.tracks.map((track) =>
    track.id === 'trk_V2' ? { ...track, hidden: true } : track,
  );
  eq(placement.pickTrackForInsert(doc, 'video', 0, 240), null, 'V2 隐藏后没有候选');
});

test('②f 音频优先 A1，占用后没有第二条音频轨 → null', () => {
  eq(placement.pickTrackForInsert(docWith(), 'audio', 0, 240), 'trk_A1');
  const doc = docWith({ trk_A1: [[0, 240]] });
  eq(placement.pickTrackForInsert(doc, 'audio', 0, 240), null, '不会把音频塞进视频轨');
});

console.log('\n[3] nextTrackFor（新建轨的命名/order）');

test('③a 默认工程（V1/V2）→ 新建 V3，order = 2', () => {
  const track = placement.nextTrackFor(docWith(), 'video');
  eq(track.id, 'trk_V3');
  eq(track.name, 'V3');
  eq(track.order, 2, 'order 取同类轨数量（与「＋ 轨道」按钮一致）');
  eq(track.kind, 'video');
});

test('③b 名字里的编号跳跃时取最大 +1（V1/V5 → V6）', () => {
  const doc = docWith();
  doc.tracks = doc.tracks.map((track) =>
    track.id === 'trk_V2' ? { ...track, id: 'trk_V5', name: 'V5' } : track,
  );
  const track = placement.nextTrackFor(doc, 'video');
  eq(track.name, 'V6', '不能生成和现有 V5 重名的轨');
  eq(track.id, 'trk_V6');
});

test('③c 音频轨 → A2', () => {
  const track = placement.nextTrackFor(docWith(), 'audio');
  eq(track.name, 'A2');
  eq(track.id, 'trk_A2');
});

console.log('\n[4] trackRemoveBlockReason（能否删除轨道）');

test('④a 空轨可删（返回 null）', () => {
  const doc = docWith();
  eq(placement.trackRemoveBlockReason(doc, 'trk_V2'), null);
});

test('④b 有内容的轨也可删（撤销能整体回退，拦着反而更麻烦）', () => {
  const doc = docWith({ trk_V1: [[0, 240]] });
  eq(placement.trackRemoveBlockReason(doc, 'trk_V1'), null);
});

test('④c 最后一条视频轨不可删（删光后素材/字幕无处可放）', () => {
  const doc = docWith();
  doc.tracks = doc.tracks.filter((track) => track.id !== 'trk_V2');
  eq(placement.trackRemoveBlockReason(doc, 'trk_V1'), '至少要保留一条视频轨');
  eq(placement.trackRemoveBlockReason(doc, 'trk_A1'), null, '音频轨不受这条限制');
});

test('④d 锁定的轨不可删', () => {
  const doc = docWith();
  doc.tracks = doc.tracks.map((track) =>
    track.id === 'trk_V2' ? { ...track, locked: true } : track,
  );
  assert.match(String(placement.trackRemoveBlockReason(doc, 'trk_V2')), /锁定/);
});

test('④e 不存在的轨给出可读原因', () => {
  eq(placement.trackRemoveBlockReason(docWith(), 'trk_V9'), '轨道不存在');
});

console.log('\n[5] buildPlaceAssetOps（素材上轨的唯一实现）');

/** 造一个素材：视频 30fps / 240 帧（8 秒）。 */
function assetWith(overrides = {}) {
  return types.createAsset({
    id: 'ast',
    name: 'clip.mp4',
    kind: 'video',
    fpsMilli: 30000,
    durationFrames: 240,
    durationSec: 8,
    hasAudio: true,
    ...overrides,
  });
}

test('⑤a 空工程 → 落 V1，一个 addClip（不新建轨）', () => {
  const plan = placement.buildPlaceAssetOps(docWith(), assetWith(), 0);
  assert.ok(!('message' in plan), '不应失败');
  eq(plan.ops.length, 1, '只有 addClip');
  eq(plan.ops[0].op, 'addClip');
  eq(plan.trackId, 'trk_V1');
  eq(plan.newTrackName, null);
  eq(plan.ops[0].clip.durationFrames, 240, '30fps→30fps 原样');
});

test('⑤b 播放头已被占用 → 换 V2（同轨重叠会音量翻倍）', () => {
  const plan = placement.buildPlaceAssetOps(docWith({ trk_V1: [[0, 240]] }), assetWith(), 0);
  assert.ok(!('message' in plan));
  eq(plan.trackId, 'trk_V2');
});

test('⑤c 同类轨全占用 → 同批新建轨（一次撤销能整体回退）', () => {
  const doc = docWith({ trk_V1: [[0, 240]], trk_V2: [[0, 240]] });
  const plan = placement.buildPlaceAssetOps(doc, assetWith(), 0);
  assert.ok(!('message' in plan));
  eq(plan.ops.length, 2, 'addTrack + addClip');
  eq(plan.ops[0].op, 'addTrack');
  eq(plan.newTrackName, 'V3');
  eq(plan.trackId, plan.ops[0].track.id);
});

test('⑤d 指定 kind=audio → 落 A1（"配一段音频"用这条路）', () => {
  const plan = placement.buildPlaceAssetOps(docWith(), assetWith({ kind: 'audio' }), 120, {
    kind: 'audio',
  });
  assert.ok(!('message' in plan));
  eq(plan.trackId, 'trk_A1');
  eq(plan.ops[0].clip.startFrame, 120);
});

test('⑤e 纯音频素材（无视频帧栅格）→ 用秒折算帧', () => {
  const audioAsset = assetWith({ kind: 'audio', durationFrames: null, durationSec: 2 });
  const plan = placement.buildPlaceAssetOps(docWith(), audioAsset, 0);
  assert.ok(!('message' in plan));
  // 2 秒 @30fps = 60 帧
  eq(plan.ops[0].clip.durationFrames, 60);
  eq(plan.ops[0].clip.outFrame, 60);
});

test('⑤f 素材帧率与工程帧率不同 → 走 projectSpanFrames 换算', () => {
  // 素材 24fps / 240 帧 = 10 秒；工程 30fps → 300 帧
  const plan = placement.buildPlaceAssetOps(docWith(), assetWith({ fpsMilli: 24000 }), 0);
  assert.ok(!('message' in plan));
  eq(plan.ops[0].clip.durationFrames, 300);
});

test('⑤g 时长未知 → 可读原因（不抛错）', () => {
  const broken = assetWith({ durationFrames: null, durationSec: 0 });
  const plan = placement.buildPlaceAssetOps(docWith(), broken, 0);
  assert.ok('message' in plan, '应当失败');
  assert.match(plan.message, /时长未知/);
});

console.log('\n[6] 拖拽落点（trackId 指定目标轨）');

test('⑥a 拖到 V2 就落 V2（不再默认回 V1）', () => {
  const plan = placement.buildPlaceAssetOps(docWith(), assetWith(), 60, { trackId: 'trk_V2' });
  assert.ok(!('message' in plan), `不该失败：${plan.message ?? ''}`);
  eq(plan.trackId, 'trk_V2');
  eq(plan.ops[0].clip.startFrame, 60, '落点帧原样');
});

test('⑥b 目标轨那一帧被占用 → 换同类型的空闲轨（不回退 V1）', () => {
  const doc = docWith({ trk_V2: [[0, 240]] });
  const plan = placement.buildPlaceAssetOps(doc, assetWith(), 60, { trackId: 'trk_V2' });
  assert.ok(!('message' in plan));
  eq(plan.trackId, 'trk_V1', 'V2 占用 → 退到另一条视频轨');
});

test('⑥c 视频拖到音频轨 → 拒绝并说人话（不偷偷换轨）', () => {
  const plan = placement.buildPlaceAssetOps(docWith(), assetWith(), 0, { trackId: 'trk_A1' });
  assert.ok('message' in plan, '应当失败');
  assert.match(plan.message, /视频只能放到视频轨/);
});

test('⑥d 音频拖到视频轨 → 拒绝', () => {
  const plan = placement.buildPlaceAssetOps(docWith(), assetWith({ kind: 'audio' }), 0, {
    trackId: 'trk_V1',
  });
  assert.ok('message' in plan);
  assert.match(plan.message, /音频只能放到音频轨/);
});

test('⑥e 锁定的轨不能拖入', () => {
  const doc = docWith();
  doc.tracks = doc.tracks.map((track) => (track.id === 'trk_V2' ? { ...track, locked: true } : track));
  const plan = placement.buildPlaceAssetOps(doc, assetWith(), 0, { trackId: 'trk_V2' });
  assert.ok('message' in plan);
  assert.match(plan.message, /已锁定/);
});

test('⑥f 隐藏的轨不能拖入', () => {
  const doc = docWith();
  doc.tracks = doc.tracks.map((track) => (track.id === 'trk_V1' ? { ...track, hidden: true } : track));
  const plan = placement.buildPlaceAssetOps(doc, assetWith(), 0, { trackId: 'trk_V1' });
  assert.ok('message' in plan);
  assert.match(plan.message, /已隐藏/);
});

test('⑥g 目标轨不存在 → 可读原因', () => {
  const plan = placement.buildPlaceAssetOps(docWith(), assetWith(), 0, { trackId: 'trk_V9' });
  assert.ok('message' in plan);
  assert.match(plan.message, /不存在/);
});

test('⑥h 音频拖到 A1 → 落 A1（不新建轨）', () => {
  const plan = placement.buildPlaceAssetOps(docWith(), assetWith({ kind: 'audio' }), 30, {
    trackId: 'trk_A1',
  });
  assert.ok(!('message' in plan));
  eq(plan.trackId, 'trk_A1');
  eq(plan.newTrackName, null);
});

test('⑥i 不传 trackId → 老行为不变（V1 优先）', () => {
  const plan = placement.buildPlaceAssetOps(docWith(), assetWith(), 0);
  assert.ok(!('message' in plan));
  eq(plan.trackId, 'trk_V1');
});

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} 落轨规则单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}`);
    console.error(failure.error);
  }
  process.exit(1);
}
