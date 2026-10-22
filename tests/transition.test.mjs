/**
 * 转场编排单测（R-033）。
 *
 * `planTransitions` 是纯函数，但它是"在片段边界之外还要画一帧"的地方——
 * 越界素材帧、窗口前后一帧、无前序片段这些边界全靠这里守。
 *
 * 运行：`node tests/transition.test.mjs`
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

const plan = await load('src/media/transitionPlan.ts', 'transitionPlan');
const types = await load('src/core/types.ts', 'types2');

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

function approx(actual, expected, tol, label) {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${label}：期望 ${expected}±${tol}，实际 ${actual}`);
  }
}

/** 两个首尾相接的片段：A [0,120) + B [120,240)。 */
function makeDoc(patch = {}) {
  const project = types.createProject({ width: 1280, height: 720, fpsMilli: 30000 });
  const asset = types.createAsset({
    id: 'a1',
    name: 'sample.mp4',
    kind: 'video',
    fpsMilli: 30000,
    durationFrames: 600,
    durationSec: 20,
    width: 1280,
    height: 720,
    hasAudio: true,
    container: 'mp4',
  });
  const clipA = {
    ...types.createClip({
      id: 'A',
      assetId: 'a1',
      trackId: 'trk_V1',
      startFrame: 0,
      inFrame: 0,
      outFrame: 120,
      durationFrames: 120,
    }),
    ...(patch.A ?? {}),
  };
  const clipB = {
    ...types.createClip({
      id: 'B',
      assetId: 'a1',
      trackId: 'trk_V1',
      startFrame: 120,
      inFrame: 120,
      outFrame: 240,
      durationFrames: 120,
    }),
    ...(patch.B ?? {}),
  };
  const tracks = project.tracks.map((track) =>
    track.id === 'trk_V1' ? { ...track, clips: [clipA, clipB] } : track,
  );
  return { ...project, assets: [asset], tracks };
}

/* ---------------- 用例 ---------------- */

test('T1 没有转场时计划为空', () => {
  const doc = makeDoc();
  assert.strictEqual(plan.planTransitions(doc, 120).size, 0, '应无覆盖');
});

test('T2 交叉溶解：窗口以接缝为中心，两侧不透明度互补', () => {
  const doc = makeDoc({ B: { transitionIn: { type: 'crossDissolve', durationFrames: 10 } } });
  // D=10 → 窗口 [115,125)
  const before = plan.planTransitions(doc, 114);
  assert.strictEqual(before.size, 0, 'T2a 窗口前不应生效');

  const start = plan.planTransitions(doc, 115);
  approx(start.get('B')?.opacity ?? -1, 0, 1e-9, 'T2b B 起点不透明度');
  approx(start.get('A')?.opacity ?? -1, 1, 1e-9, 'T2c A 起点不透明度');
  assert.strictEqual(start.get('B')?.frozenFrame, 120, 'T2d B 在起点之前冻在首帧');

  const mid = plan.planTransitions(doc, 120);
  approx(mid.get('B')?.opacity ?? -1, 0.5, 1e-9, 'T2e B 中点');
  approx(mid.get('A')?.opacity ?? -1, 0.5, 1e-9, 'T2f A 中点');
  assert.strictEqual(mid.get('B')?.frozenFrame, null, 'T2g B 已进入自己的区间，正常映射');
  assert.strictEqual(mid.get('A')?.frozenFrame, 119, 'T2h A 已过终点，冻在末帧');

  const end = plan.planTransitions(doc, 124);
  approx(end.get('B')?.opacity ?? -1, 0.9, 1e-9, 'T2i B 接近完成');

  assert.strictEqual(plan.planTransitions(doc, 125).size, 0, 'T2j 窗口后不应生效');
});

test('T3 淡入：只影响自己，起点前冻首帧', () => {
  const doc = makeDoc({ B: { transitionIn: { type: 'fadeIn', durationFrames: 10 } } });
  const state = plan.planTransitions(doc, 117);
  approx(state.get('B')?.opacity ?? -1, 0.2, 1e-9, 'T3a 进度');
  assert.strictEqual(state.get('A'), undefined, 'T3b 淡入不影响前一个片段');
  assert.strictEqual(state.get('B')?.frozenFrame, 120, 'T3c 冻首帧');
});

test('T4 淡出：末段线性压到 0，不冻帧', () => {
  const doc = makeDoc({ A: { transitionOut: { type: 'fadeOut', durationFrames: 10 } } });
  const start = plan.planTransitions(doc, 110);
  approx(start.get('A')?.opacity ?? -1, 1, 1e-9, 'T4a 起点');
  const mid = plan.planTransitions(doc, 115);
  approx(mid.get('A')?.opacity ?? -1, 0.5, 1e-9, 'T4b 中点');
  const near = plan.planTransitions(doc, 119);
  approx(near.get('A')?.opacity ?? -1, 0.1, 1e-9, 'T4c 末帧前一帧');
  assert.strictEqual(plan.planTransitions(doc, 120).size, 0, 'T4d 结束后不再生效');
});

test('T5 交叉溶解但前面没有片段：只淡入自己', () => {
  const doc = makeDoc({ B: { transitionIn: { type: 'crossDissolve', durationFrames: 10 } } });
  const noPrev = {
    ...doc,
    tracks: doc.tracks.map((track) =>
      track.id === 'trk_V1' ? { ...track, clips: track.clips.filter((clip) => clip.id !== 'A') } : track,
    ),
  };
  const state = plan.planTransitions(noPrev, 120);
  approx(state.get('B')?.opacity ?? -1, 0.5, 1e-9, 'T5a B 仍淡入');
  assert.strictEqual(state.size, 1, 'T5b 只有 B 一条覆盖');
});

test('T6 需要额外绘制的片段：窗口内、自身区间外', () => {
  const doc = makeDoc({ B: { transitionIn: { type: 'crossDissolve', durationFrames: 10 } } });
  const early = plan.planTransitions(doc, 117);
  const extraEarly = plan.clipsNeedingExtraDraw(doc, 117, early).map((clip) => clip.id);
  assert.deepStrictEqual(extraEarly, ['B'], 'T6a 第 117 帧 B 还没开始，需要额外画');

  const late = plan.planTransitions(doc, 122);
  const extraLate = plan.clipsNeedingExtraDraw(doc, 122, late).map((clip) => clip.id);
  assert.deepStrictEqual(extraLate, ['A'], 'T6b 第 122 帧 A 已结束，需要额外画');

  // 接缝这一帧：B 已进入自己的区间（120 是它的起点），A 已结束 → 只有 A 需要额外画（冻末帧）
  const atCut = plan.planTransitions(doc, 120);
  assert.deepStrictEqual(
    plan.clipsNeedingExtraDraw(doc, 120, atCut).map((clip) => clip.id),
    ['A'],
    'T6c 接缝处 A 已结束，需要冻末帧补画',
  );
});

test('T7 隐藏轨不参与转场', () => {
  const doc = makeDoc({ B: { transitionIn: { type: 'crossDissolve', durationFrames: 10 } } });
  const hidden = {
    ...doc,
    tracks: doc.tracks.map((track) => (track.id === 'trk_V1' ? { ...track, hidden: true } : track)),
  };
  assert.strictEqual(plan.planTransitions(hidden, 120).size, 0, '隐藏轨不应有覆盖');
});

test('T8 转场时长上限 = 片段一半（超了就夹住，否则永远半透明）', () => {
  // 120 帧的片段：上限 60
  assert.strictEqual(types.maxTransitionFrames({ durationFrames: 120 }), 60);
  assert.strictEqual(types.maxTransitionFrames({ durationFrames: 1 }), 1, '极短片段至少 1 帧');
  assert.strictEqual(types.maxTransitionFrames({ durationFrames: 3 }), 1, '向下取整');

  // 故意送一个"比片段还长"的转场（工程文件/宿主通道都可能送来）
  const doc = makeDoc({ B: { transitionIn: { type: 'crossDissolve', durationFrames: 600 } } });
  // 夹到 60 后窗口是 [90, 150)：片段 B 在 120 处开始
  const atStart = plan.planTransitions(doc, 120).get('B');
  approx(atStart.opacity, 0.5, 0.01, '窗口中点应当正好 0.5');
  // 关键断言：片段**结束时**必须已经完全显示（不夹的话这里只有 0.2 左右，画面永远发灰）
  const atEnd = plan.planTransitions(doc, 239).get('B');
  assert.strictEqual(atEnd, undefined, '片段末尾不应再有转场覆盖');
});

test('T9 进出转场都设成上限时，中间仍有完全不透明的一段', () => {
  const doc = makeDoc({
    B: {
      transitionIn: { type: 'crossDissolve', durationFrames: 60 },
      transitionOut: { type: 'fadeOut', durationFrames: 60 },
    },
  });
  // B 是 [120,240)，D=60：淡入窗口 [90,150)、淡出窗口 [180,240) → 中间 [150,180) 完全透明不介入
  assert.strictEqual(plan.planTransitions(doc, 165).get('B'), undefined, '第 165 帧（正中空隙）不应被转场覆盖');
  const fadeOutStart = plan.planTransitions(doc, 180).get('B');
  approx(fadeOutStart.opacity, 1, 0.001, '淡出起点不透明度仍是 1（从全亮开始淡）');
  // 这也解释了"上限取一半"的意义：两段窗口各占一半，中间必留一整段不透明画面
});

/* ---------------- 汇总 ---------------- */

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} 转场编排单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  console.log('失败用例：');
  for (const failure of failures) console.log(`  - ${failure.name}: ${failure.message}`);
  process.exit(1);
}
