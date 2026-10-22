/**
 * 转场落点单测：`core/transitionTarget` 的四个纯函数。
 *
 * 守四条规则（都是"差一帧就错、错了还看不出来"的那种）：
 * 1. **片段命中用半开区间** `[start, end)`：终点那一帧属于下一段；
 * 2. **"左侧紧邻"是严格相等**：有 1 帧缝隙就不算（渲染层找左邻用的是同一判据）；
 * 3. **两侧互斥**：设一侧必须清另一侧，否则两条斜坡叠加 → 转场看起来特别弱；
 * 4. **时长夹到片段一半**：超过一半的话进出转场互相覆盖，中间永远到不了不透明。
 *
 * 运行：`node tests/transition-target.test.mjs`
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

const target = await load('src/core/transitionTarget.ts', 'transitionTarget');
const presets = await load('src/core/transitionPresets.ts', 'transitionPresets');
const types = await load('src/core/types.ts', 'types');

const { clipAtFrame, previousAdjacent, resolveDuration, resolveTransitionTarget, buildTransitionOps, currentTransition, findClipById } = target;
const { TRANSITION_PRESETS, TRANSITION_DURATIONS, transitionPresetById } = presets;
const { createClip, createTrack } = types;

const FPS = 30000;
const dissolve = transitionPresetById('trs-dissolve');
const fadeIn = transitionPresetById('trs-fade-in');
const fadeOut = transitionPresetById('trs-fade-out');

/** 造一个片段：`[start, start+duration)`。 */
const clip = (id, start, duration) =>
  createClip({
    id,
    assetId: 'ast',
    trackId: 'trk_V1',
    startFrame: start,
    inFrame: 0,
    outFrame: duration,
    durationFrames: duration,
  });

const makeDoc = (tracks) => ({
  id: 'p', name: 't', fpsMilli: FPS, width: 1280, height: 720,
  sampleRate: 48000, frameMapPolicy: 'holdPrevious', durationRounding: 'halfUp',
  tracks, assets: [], playheadFrame: 0, zoomLevel: 5, schemaVersion: 1, createdAt: 0, updatedAt: 0,
});

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}
const eq = (actual, expected, message) => assert.deepStrictEqual(actual, expected, message ?? undefined);
const ok = (value, message) => assert.ok(value, message);

/* ---------------- ① 清单 ---------------- */

test('① 三个预设：叠化/淡入/淡出，名称全中文、side 与渲染规则一致', () => {
  eq(TRANSITION_PRESETS.map((p) => p.name), ['叠化', '淡入', '淡出']);
  eq(TRANSITION_PRESETS.map((p) => p.side), ['in', 'in', 'out']);
  eq(dissolve.needsPrevious, true, '叠化需要左邻');
  eq(fadeIn.needsPrevious, false);
  eq(fadeOut.needsPrevious, false);
  for (const preset of TRANSITION_PRESETS) ok(!/[A-Za-z]/.test(preset.name), `${preset.id} 名称含英文`);
});

test('①b 时长档位 0.3 / 0.5 / 1.0', () => {
  eq([...TRANSITION_DURATIONS], [0.3, 0.5, 1.0]);
});

/* ---------------- ② 片段命中：半开区间 ---------------- */

test('② clipAtFrame 半开区间：起点算、终点不算', () => {
  const track = createTrack({ id: 'trk_V1', kind: 'video', order: 0, clips: [clip('a', 0, 30), clip('b', 30, 30)] });
  eq(clipAtFrame(track, 0)?.id, 'a');
  eq(clipAtFrame(track, 29)?.id, 'a');
  eq(clipAtFrame(track, 30)?.id, 'b', '接缝那一帧属于右边那段');
  eq(clipAtFrame(track, 60), null, '末尾之外没有片段');
});

/* ---------------- ③ 左邻：严格相等 ---------------- */

test('③ previousAdjacent 严格相等才算（差 1 帧不算）', () => {
  const adjacent = createTrack({ id: 'trk_V1', kind: 'video', order: 0, clips: [clip('a', 0, 30), clip('b', 30, 30)] });
  eq(previousAdjacent(adjacent, adjacent.clips[1])?.id, 'a');

  const gap = createTrack({ id: 'trk_V1', kind: 'video', order: 0, clips: [clip('a', 0, 29), clip('b', 30, 30)] });
  eq(previousAdjacent(gap, gap.clips[1]), null, '中间有 1 帧缝隙就不算紧邻');

  const first = createTrack({ id: 'trk_V1', kind: 'video', order: 0, clips: [clip('a', 0, 30)] });
  eq(previousAdjacent(first, first.clips[0]), null, '首片段没有左邻');
});

/* ---------------- ④ 落点解析 ---------------- */

test('④ 叠化 + 有左邻 → 挂在右侧片段的 in 侧', () => {
  const track = createTrack({ id: 'trk_V1', kind: 'video', order: 0, clips: [clip('a', 0, 30), clip('b', 30, 30)] });
  const doc = makeDoc([track]);
  const resolved = resolveTransitionTarget(doc, track, 30, dissolve, 0.5);
  eq(resolved.clipId, 'b');
  eq(resolved.side, 'in');
  eq(resolved.durationFrames, 15);
});

test('④b 叠化 + 没有左邻 → 给可读原因，不产目标', () => {
  const track = createTrack({ id: 'trk_V1', kind: 'video', order: 0, clips: [clip('b', 30, 30)] });
  const doc = makeDoc([track]);
  const resolved = resolveTransitionTarget(doc, track, 30, dissolve, 0.5);
  ok(typeof resolved.message === 'string', '应当返回 message');
  ok(resolved.message.includes('左侧'), `提示要说明原因：${resolved.message}`);
  eq(resolved.clipId, undefined, '不能给出落点');
});

test('④c 淡入不需要左邻；淡出挂 out 侧', () => {
  const track = createTrack({ id: 'trk_V1', kind: 'video', order: 0, clips: [clip('b', 30, 30)] });
  const doc = makeDoc([track]);
  eq(resolveTransitionTarget(doc, track, 30, fadeIn, 0.5).side, 'in');
  eq(resolveTransitionTarget(doc, track, 30, fadeOut, 0.5).side, 'out');
});

test('④d 落在空白处 → 可读原因', () => {
  const track = createTrack({ id: 'trk_V1', kind: 'video', order: 0, clips: [clip('a', 0, 30)] });
  const doc = makeDoc([track]);
  const resolved = resolveTransitionTarget(doc, track, 100, fadeIn, 0.5);
  ok(typeof resolved.message === 'string' && resolved.message.includes('没有片段'), resolved.message);
});

/* ---------------- ⑤ 时长 ---------------- */

test('⑤ 三档时长换算（30fps：0.3→9 / 0.5→15 / 1.0→30）', () => {
  const c = clip('a', 0, 120);
  eq(resolveDuration(0.3, c, FPS), 9);
  eq(resolveDuration(0.5, c, FPS), 15);
  eq(resolveDuration(1.0, c, FPS), 30);
});

test('⑤b 夹到片段时长的一半（4 帧的片段最多 2 帧）', () => {
  const short = clip('a', 0, 4);
  eq(resolveDuration(1.0, short, FPS), 2);
});

/* ---------------- ⑥ 两侧互斥 ---------------- */

test('⑥ 设 out 会清掉已有的 in（同一次返回，一个撤销步）', () => {
  const withIn = {
    ...clip('a', 0, 60),
    transitionIn: { type: 'fadeIn', durationFrames: 10 },
  };
  const ops = buildTransitionOps(withIn, 'out', { type: 'fadeOut', durationFrames: 12 });
  eq(ops.length, 2);
  eq(ops[0].side, 'in');
  eq(ops[0].to, null, '先清 in');
  eq(ops[1].side, 'out');
  eq(ops[1].to?.type, 'fadeOut');
});

test('⑥b 已经是要设的值且另一侧为空 → 不产操作（不发无用撤销步）', () => {
  const applied = {
    ...clip('a', 0, 60),
    transitionIn: { type: 'crossDissolve', durationFrames: 15 },
  };
  eq(buildTransitionOps(applied, 'in', { type: 'crossDissolve', durationFrames: 15 }), []);
});

test('⑥c next=null → 清掉两侧', () => {
  const both = {
    ...clip('a', 0, 60),
    transitionIn: { type: 'fadeIn', durationFrames: 8 },
    transitionOut: { type: 'fadeOut', durationFrames: 8 },
  };
  const ops = buildTransitionOps(both, 'in', null);
  eq(ops.length, 2);
  eq(ops.map((op) => op.side), ['in', 'out']);
  eq(ops.every((op) => op.to === null), true);
});

/* ---------------- ⑦ 状态读取 ---------------- */

test('⑦ currentTransition 优先返回 in；findClipById 能跨轨找', () => {
  const c = { ...clip('a', 0, 60), transitionIn: { type: 'fadeIn', durationFrames: 8 } };
  eq(currentTransition(c)?.side, 'in');
  eq(currentTransition(clip('b', 0, 60)), null);

  const v = createTrack({ id: 'trk_V1', kind: 'video', order: 0, clips: [c] });
  const t = createTrack({ id: 'trk_T1', kind: 'text', order: 0, clips: [clip('x', 0, 10)] });
  const doc = makeDoc([v, t]);
  eq(findClipById(doc, 'x')?.track.id, 'trk_T1');
  eq(findClipById(doc, 'nope'), null);
});

console.log(`\n${failed === 0 ? '✓' : '✗'} 转场落点单测：通过 ${passed} / ${passed + failed}`);
process.exitCode = failed === 0 ? 0 : 1;
