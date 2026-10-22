/**
 * 智能粗剪单测（R-060）：静音检测 + 波纹删除 + 指令识别。
 *
 * 三块都是纯逻辑，用**合成 PCM** 和**构造的工程**验证，不依赖浏览器与真实素材：
 * - 检测：3s 音 + 2s 静音 + 3s 音，必须只报中间那一段，且帧号对得上；
 * - 删除：单段/开头/结尾/整段/跨接缝 五种形态，结果必须"内容接上来、不留洞"；
 * - 识别："去掉超过 1 秒的停顿" 要能命中，"这段停顿怎么处理"（提问）不能命中。
 *
 * 运行：`node tests/roughcut.test.mjs`
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

const silence = await load('src/media/silence.ts', 'silence');
const ripple = await load('src/core/rippleDelete.ts', 'rippleDelete');
const roughCut = await load('src/ai/roughCut.ts', 'roughCut');
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

function eq(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message);
}

function near(actual, expected, tolerance, message) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}：期望 ${expected}±${tolerance}，实际 ${actual}`,
  );
}

/* ---------------- 合成 PCM ---------------- */

const SAMPLE_RATE = 48000;
const FPS_MILLI = 30000;

/** 3s 音 + 2s 静音 + 3s 音（8 秒，双声道同相）。 */
function speechPauseSpeech() {
  const seconds = 8;
  const total = SAMPLE_RATE * seconds;
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  for (let i = 0; i < total; i += 1) {
    const t = i / SAMPLE_RATE;
    const speaking = t < 3 || t >= 5;
    const value = speaking ? 0.3 * Math.sin(2 * Math.PI * 440 * t) : 0;
    left[i] = value;
    right[i] = value;
  }
  return { channels: [left, right], length: total };
}

/* ---------------- 1. 静音检测 ---------------- */

console.log('\n[1] detectSilenceRanges（3s 音 + 2s 静音 + 3s 音 @30fps）');

const pcm = speechPauseSpeech();
const baseOptions = {
  sampleRate: SAMPLE_RATE,
  fpsMilli: FPS_MILLI,
  minSilenceFrames: 30,
  paddingFrames: 0,
};

test('①a 只报中间那一段，帧号对齐 90–150', () => {
  const result = silence.detectSilenceRanges(pcm.channels, pcm.length, baseOptions);
  eq(result.ranges.length, 1);
  near(result.ranges[0].startFrame, 90, 1, '起点');
  near(result.ranges[0].endFrame, 150, 1, '终点');
});

test('①b 短于 minSilenceFrames 的停顿不返回（阈值 3 秒）', () => {
  const result = silence.detectSilenceRanges(pcm.channels, pcm.length, {
    ...baseOptions,
    minSilenceFrames: 90,
  });
  eq(result.ranges.length, 0);
});

test('①c paddingFrames 往回收（两端各留 3 帧）', () => {
  const result = silence.detectSilenceRanges(pcm.channels, pcm.length, {
    ...baseOptions,
    paddingFrames: 3,
  });
  eq(result.ranges.length, 1);
  near(result.ranges[0].startFrame, 93, 1, '起点 +3');
  near(result.ranges[0].endFrame, 147, 1, '终点 -3');
});

test('①d 全静音 → 一段覆盖整条（交给上层决定是否拒绝）', () => {
  const total = SAMPLE_RATE * 2;
  const zeros = [new Float32Array(total), new Float32Array(total)];
  const result = silence.detectSilenceRanges(zeros, total, { ...baseOptions, minSilenceFrames: 1 });
  eq(result.ranges.length, 1);
  near(result.ranges[0].startFrame, 0, 1, '起点');
  near(result.ranges[0].endFrame, 60, 1, '终点（2s @30fps）');
});

test('①e 低于阈值的"底噪"算静音，高于阈值的不算', () => {
  const total = SAMPLE_RATE;
  const quiet = new Float32Array(total);
  const loud = new Float32Array(total);
  for (let i = 0; i < total; i += 1) {
    quiet[i] = 0.0005 * Math.sin((2 * Math.PI * 200 * i) / SAMPLE_RATE); // ≈ -66dBFS
    loud[i] = 0.5 * Math.sin((2 * Math.PI * 200 * i) / SAMPLE_RATE); // ≈ -6dBFS
  }
  const quietResult = silence.detectSilenceRanges([quiet], total, {
    ...baseOptions,
    minSilenceFrames: 10,
  });
  eq(quietResult.ranges.length, 1, '底噪应判静音');
  const loudResult = silence.detectSilenceRanges([loud], total, {
    ...baseOptions,
    minSilenceFrames: 10,
  });
  eq(loudResult.ranges.length, 0, '正常音量不应判静音');
});

test('①f 长度不足一个窗口时返回空（不崩）', () => {
  const result = silence.detectSilenceRanges([new Float32Array(10)], 10, baseOptions);
  eq(result.ranges.length, 0);
});

/* ---------------- 2. 波纹删除 ---------------- */

console.log('\n[2] buildRippleDeleteOps');

function makeAsset(id = 'ast_1') {
  return types.createAsset({
    id,
    name: `${id}.mp4`,
    fpsMilli: FPS_MILLI,
    durationFrames: 600,
    durationSec: 20,
    width: 640,
    height: 360,
    hasAudio: true,
    container: 'mp4',
    exactSeek: true,
  });
}

function makeDoc(clips, assetIds = ['ast_1']) {
  const track = types.createTrack({ id: 'trk_V1', kind: 'video', name: 'V1', order: 0, clips });
  return {
    id: 'prj_test',
    name: '测试工程',
    fpsMilli: FPS_MILLI,
    width: 640,
    height: 360,
    sampleRate: 48000,
    frameMapPolicy: 'holdPrevious',
    durationRounding: 'halfUp',
    tracks: [track],
    assets: assetIds.map((id) => makeAsset(id)),
    playheadFrame: 0,
    zoomLevel: 5,
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeClip(id, startFrame, durationFrames, inFrame = startFrame) {
  return types.createClip({
    id,
    assetId: 'ast_1',
    trackId: 'trk_V1',
    startFrame,
    inFrame,
    outFrame: inFrame + durationFrames,
    durationFrames,
  });
}

function applyAll(doc, ops) {
  let next = doc;
  for (const op of ops) next = operations.applyOperation(next, op);
  return next;
}

function layout(doc) {
  return doc.tracks[0].clips.map((clip) => ({
    start: clip.startFrame,
    duration: clip.durationFrames,
    inFrame: clip.inFrame,
    outFrame: clip.outFrame,
  }));
}

test('②a 片段中段：切两刀 + 删中间 + 左移，结果首尾相接', () => {
  const doc = makeDoc([makeClip('clp_1', 0, 300)]);
  const ops = ripple.buildRippleDeleteOps(doc, 'trk_V1', 100, 200);
  assert.ok(ops.length >= 4, `ops 应含两次切分+删除+左移，实际 ${ops.length}`);
  const after = applyAll(doc, ops);
  eq(layout(after), [
    { start: 0, duration: 100, inFrame: 0, outFrame: 100 },
    { start: 100, duration: 100, inFrame: 200, outFrame: 300 },
  ]);
});

test('②b 片段开头：删掉头段，内容前移到 0', () => {
  const doc = makeDoc([makeClip('clp_1', 0, 300)]);
  const after = applyAll(doc, ripple.buildRippleDeleteOps(doc, 'trk_V1', 0, 60));
  eq(layout(after), [{ start: 0, duration: 240, inFrame: 60, outFrame: 300 }]);
});

test('②c 片段结尾：只留前段', () => {
  const doc = makeDoc([makeClip('clp_1', 0, 300)]);
  const after = applyAll(doc, ripple.buildRippleDeleteOps(doc, 'trk_V1', 240, 300));
  eq(layout(after), [{ start: 0, duration: 240, inFrame: 0, outFrame: 240 }]);
});

test('②d 整段删光', () => {
  const doc = makeDoc([makeClip('clp_1', 0, 300)]);
  const after = applyAll(doc, ripple.buildRippleDeleteOps(doc, 'trk_V1', 0, 300));
  eq(layout(after), []);
});

test('②e 停顿跨两个相邻片段：接缝合拢，不留洞', () => {
  const doc = makeDoc([makeClip('clp_1', 0, 100), makeClip('clp_2', 100, 100, 100)]);
  const after = applyAll(doc, ripple.buildRippleDeleteOps(doc, 'trk_V1', 80, 140));
  const result = layout(after);
  eq(result.length, 2);
  eq(result[0].start, 0);
  eq(result[0].duration, 80);
  eq(result[1].start, 80, '后段必须紧接前段（没有洞）');
  eq(result[1].duration, 60);
});

test('②f 区间落在空白处 → 空操作（不报错）', () => {
  const doc = makeDoc([makeClip('clp_1', 0, 100), makeClip('clp_2', 200, 100, 200)]);
  eq(ripple.buildRippleDeleteOps(doc, 'trk_V1', 120, 180), []);
});

test('②g 非法参数 → 空操作', () => {
  const doc = makeDoc([makeClip('clp_1', 0, 300)]);
  eq(ripple.buildRippleDeleteOps(doc, 'trk_V1', 100, 100), []);
  eq(ripple.buildRippleDeleteOps(doc, 'trk_V1', 200, 100), []);
  eq(ripple.buildRippleDeleteOps(doc, 'nope', 0, 100), []);
});

test('②h 多段从后往前处理，帧号不会互相打乱', () => {
  const doc = makeDoc([makeClip('clp_1', 0, 300)]);
  // 两段静音：60–90 与 180–240（倒序处理）
  let sim = doc;
  const allOps = [];
  for (const range of [
    { startFrame: 180, endFrame: 240 },
    { startFrame: 60, endFrame: 90 },
  ]) {
    const ops = ripple.buildRippleDeleteOps(sim, 'trk_V1', range.startFrame, range.endFrame);
    sim = applyAll(sim, ops);
    allOps.push(...ops);
  }
  const result = layout(sim);
  eq(result.length, 3);
  // 第二段删除会把"之后的所有片段"都左移 30 帧——包括上一次已经补好的尾段，
  // 所以是 [0, 60, 150] 而不是 [0, 30, 120]（第一版期望值算错了）
  eq(result.map((clip) => clip.start), [0, 60, 150]);
  eq(result.reduce((sum, clip) => sum + clip.duration, 0), 210);
  // 一次性回放（模拟 dispatch）结果一致
  const replay = applyAll(doc, allOps);
  eq(layout(replay), result);
});

/* ---------------- 3. 指令识别 ---------------- */

console.log('\n[3] parseSilenceRequest');

test('③a "去掉超过 1 秒的停顿" → 1 秒', () => {
  eq(roughCut.parseSilenceRequest('去掉超过 1 秒的停顿'), { minSilenceSeconds: 1 });
});

test('③b 带小数点 → 2.5 秒', () => {
  eq(roughCut.parseSilenceRequest('把超过 2.5 秒的静音都删掉'), { minSilenceSeconds: 2.5 });
});

test('③c 没说时长 → 默认 1 秒', () => {
  eq(roughCut.parseSilenceRequest('帮我删掉静音'), { minSilenceSeconds: 1 });
});

test('③d 提问式不命中（没有剪类动词）', () => {
  eq(roughCut.parseSilenceRequest('这段停顿怎么处理'), null);
});

test('③e 与停顿无关的指令不命中', () => {
  eq(roughCut.parseSilenceRequest('去掉开头 3 秒'), null);
  eq(roughCut.parseSilenceRequest('把音量调大一点'), null);
});

test('③f 上限 30 秒（防止一句话删掉整片）', () => {
  eq(roughCut.parseSilenceRequest('去掉超过 600 秒的停顿'), { minSilenceSeconds: 30 });
});

/* ---------------- 汇总 ---------------- */

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} 智能粗剪单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}`);
    console.error(failure.error);
  }
  process.exit(1);
}
