/**
 * 时间线几何与轨道可听性的单测（S1 收敛的核心）。
 *
 * ## 为什么这两块必须有单测
 *
 * ① `trackLayout` 是**所有 y 坐标的唯一来源**（轨道绘制、命中测试、拖放落点、
 *    轨道头定位）。它算错，表现是"点这条轨落到那条轨"，而肉眼极难发现。
 * ② `isTrackVisible/isTrackAudible` 是**渲染、预览音频、导出混音共用的判断**。
 *    三处各写一遍时出过"预览有声音、导出没声音"这种最难查的 bug。
 *
 * 运行：`node tests/track-layout.test.mjs`
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
const layoutModule = await load('src/core/trackLayout.ts', 'trackLayout');
const audibility = await load('src/core/trackAudibility.ts', 'trackAudibility');
const engine = await load('src/media/playbackEngine.ts', 'playbackEngine');

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

/** 默认三条轨（V2/V1/A1）的工程。 */
function makeDoc(extra = []) {
  return types.createProject({ tracks: [...types.createDefaultTracks(), ...extra] });
}

console.log('\n[1] 轨道高度按类型');

test('①a 视频 60 / 音频 50 / 字幕 32', () => {
  const doc = makeDoc([types.createTrack({ id: 'trk_T1', kind: 'text', name: 'T1', order: 0 })]);
  const layout = layoutModule.trackLayout(doc);
  const heights = Object.fromEntries(layout.rows.map((row) => [row.kind, row.height]));
  eq(heights.video, 60);
  eq(heights.audio, 50);
  eq(heights.text, 32);
});

test('①b 自定义高度夹在 24–120', () => {
  const doc = types.createProject({
    tracks: [
      types.createTrack({ id: 'a', kind: 'video', name: 'V1', order: 0, height: 10 }),
      types.createTrack({ id: 'b', kind: 'video', name: 'V2', order: 1, height: 999 }),
      types.createTrack({ id: 'c', kind: 'video', name: 'V3', order: 2, height: 80 }),
    ],
  });
  const rows = layoutModule.trackLayout(doc).rows;
  const byId = Object.fromEntries(rows.map((row) => [row.trackId, row.height]));
  eq(byId.a, 24, '低于下限夹到 24');
  eq(byId.b, 120, '高于上限夹到 120');
  eq(byId.c, 80, '合法值原样');
});

console.log('\n[2] 顺序与累计坐标');

test('②a 屏幕顺序：字幕在最上、视频按 order 降序、音频垫底', () => {
  const doc = makeDoc([types.createTrack({ id: 'trk_T1', kind: 'text', name: 'T1', order: 0 })]);
  const names = layoutModule.trackLayout(doc).rows.map((row) => row.name);
  eq(names, ['T1', 'V2', 'V1', 'A1']);
});

test('②b top 逐行累加，第一行从标尺下方开始', () => {
  const doc = makeDoc();
  const layout = layoutModule.trackLayout(doc);
  eq(layout.rows[0].top, layoutModule.RULER_HEIGHT, '第一行紧跟标尺');
  eq(layout.rows[1].top, layout.rows[0].top + layout.rows[0].height);
  eq(layout.rows[2].top, layout.rows[1].top + layout.rows[1].height);
  eq(layout.totalHeight, layout.rows[2].top + layout.rows[2].height);
});

test('②c 轨道头宽 130（规范 §2.1）', () => {
  eq(layoutModule.trackLayout(makeDoc()).headerWidth, 130);
});

console.log('\n[3] y → 行（命中测试的基础）');

test('③a 标尺区返回 null', () => {
  const layout = layoutModule.trackLayout(makeDoc());
  eq(layoutModule.trackRowAtY(layout, 0), null);
  eq(layoutModule.trackRowAtY(layout, layoutModule.RULER_HEIGHT - 1), null);
});

test('③b 行首像素命中该行，行尾像素归下一行（左闭右开）', () => {
  const layout = layoutModule.trackLayout(makeDoc());
  const first = layout.rows[0];
  const second = layout.rows[1];
  eq(layoutModule.trackRowAtY(layout, first.top)?.trackId, first.trackId);
  eq(layoutModule.trackRowAtY(layout, first.top + first.height - 1)?.trackId, first.trackId);
  eq(layoutModule.trackRowAtY(layout, first.top + first.height)?.trackId, second.trackId);
});

test('③c 超出末尾返回 null（下面是空白，不是最后一条轨）', () => {
  const layout = layoutModule.trackLayout(makeDoc());
  eq(layoutModule.trackRowAtY(layout, layout.totalHeight), null);
  eq(layoutModule.trackRowAtY(layout, layout.totalHeight + 100), null);
});

test('③d trackRowOf 按 id 取行', () => {
  const layout = layoutModule.trackLayout(makeDoc());
  eq(layoutModule.trackRowOf(layout, 'trk_V1')?.name, 'V1');
  eq(layoutModule.trackRowOf(layout, 'nope'), null);
});

console.log('\n[4] 出画 / 出声（三处共用的判断）');

test('④a 默认全部参与', () => {
  const doc = makeDoc();
  for (const track of doc.tracks) {
    eq(layoutModule.trackHeightOf(track) > 0, true);
    eq(audibility.isTrackVisible(doc, track), true);
    eq(audibility.isTrackAudible(doc, track), true);
  }
});

test('④b 隐藏 → 不出画也不出声', () => {
  const doc = makeDoc();
  const track = { ...doc.tracks[0], hidden: true };
  eq(audibility.isTrackVisible(doc, track), false);
  eq(audibility.isTrackAudible(doc, track), false);
});

test('④c 静音 → **只**不出声，画面照常（这是最容易写错的一条）', () => {
  const doc = makeDoc();
  const track = { ...doc.tracks[1], muted: true };
  eq(audibility.isTrackVisible(doc, track), true, '静音不该吃掉画面');
  eq(audibility.isTrackAudible(doc, track), false);
});

test('④d 独奏 → 只有 solo 轨参与，其它轨整体让位', () => {
  const doc = makeDoc();
  const soloDoc = {
    ...doc,
    tracks: doc.tracks.map((track) => (track.id === 'trk_V1' ? { ...track, solo: true } : track)),
  };
  eq(audibility.hasSoloTrack(soloDoc), true);
  for (const track of soloDoc.tracks) {
    const expected = track.id === 'trk_V1';
    eq(audibility.isTrackVisible(soloDoc, track), expected, `${track.name} 出画`);
    eq(audibility.isTrackAudible(soloDoc, track), expected, `${track.name} 出声`);
  }
});

test('④e 独奏轨自己静音 → 仍不出声（但出画）', () => {
  const doc = makeDoc();
  const soloDoc = {
    ...doc,
    tracks: doc.tracks.map((track) =>
      track.id === 'trk_V1' ? { ...track, solo: true, muted: true } : track,
    ),
  };
  const soloTrack = soloDoc.tracks.find((track) => track.id === 'trk_V1');
  eq(audibility.isTrackVisible(soloDoc, soloTrack), true);
  eq(audibility.isTrackAudible(soloDoc, soloTrack), false);
});

console.log('\n[5] 渲染层的"本帧有没有内容"（花屏的直接输入）');

/** 造一个片段挂到某条轨上。 */
function withClip(doc, trackId, clipId, start = 0, duration = 60) {
  return {
    ...doc,
    tracks: doc.tracks.map((track) =>
      track.id === trackId
        ? { ...track, clips: [types.createClip({ id: clipId, assetId: 'ast_1', trackId, startFrame: start, inFrame: 0, outFrame: duration, durationFrames: duration })] }
        : track,
    ),
  };
}

test('⑤a 正常 → 可见片段 1 个', () => {
  const doc = withClip(makeDoc(), 'trk_V1', 'clp_1');
  eq(engine.collectVisibleClips(doc, 10).length, 1);
});

test('⑤b 轨道隐藏 → 可见片段 0 个（渲染层必须"空"，才能走清屏分支）', () => {
  const base = withClip(makeDoc(), 'trk_V1', 'clp_1');
  const doc = {
    ...base,
    tracks: base.tracks.map((track) => (track.id === 'trk_V1' ? { ...track, hidden: true } : track)),
  };
  eq(engine.collectVisibleClips(doc, 10).length, 0);
});

test('⑤c 独奏别的轨 → 本轨也让位（0 个）', () => {
  const base = withClip(makeDoc(), 'trk_V1', 'clp_1');
  const doc = {
    ...base,
    tracks: base.tracks.map((track) => (track.id === 'trk_V2' ? { ...track, solo: true } : track)),
  };
  eq(engine.collectVisibleClips(doc, 10).length, 0);
});

test('⑤d 播放头在片段之外 → 0 个（空隙要清屏，不是画上一帧）', () => {
  const doc = withClip(makeDoc(), 'trk_V1', 'clp_1', 120, 60);
  eq(engine.collectVisibleClips(doc, 0).length, 0);
  eq(engine.collectVisibleClips(doc, 180).length, 0, '末尾右开');
});

test('⑤e 静音**不影响**出画（只影响出声）', () => {
  const base = withClip(makeDoc(), 'trk_V1', 'clp_1');
  const doc = {
    ...base,
    tracks: base.tracks.map((track) => (track.id === 'trk_V1' ? { ...track, muted: true } : track)),
  };
  eq(engine.collectVisibleClips(doc, 10).length, 1);
});

test('⑤f 可听片段：静音/隐藏/独奏让位都要让出 0 个', () => {
  const base = withClip(makeDoc(), 'trk_A1', 'clp_a');
  eq(engine.collectAudibleClips(base, 10).length, 1, '默认可听');
  for (const patch of [{ muted: true }, { hidden: true }]) {
    const doc = {
      ...base,
      tracks: base.tracks.map((track) => (track.id === 'trk_A1' ? { ...track, ...patch } : track)),
    };
    eq(engine.collectAudibleClips(doc, 10).length, 0, JSON.stringify(patch));
  }
  const soloElsewhere = {
    ...base,
    tracks: base.tracks.map((track) => (track.id === 'trk_V1' ? { ...track, solo: true } : track)),
  };
  eq(engine.collectAudibleClips(soloElsewhere, 10).length, 0, '别的轨独奏 → 本轨让位');
});

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} 时间线几何单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}`);
    console.error(failure.error);
  }
  process.exit(1);
}
