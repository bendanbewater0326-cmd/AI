/**
 * 时基规格单测（R-031）。
 *
 * 覆盖：
 *   - `docs/frame-clock-spec.md` §6 的 T1–T10（权威期望值，不得改动）
 *   - 架构 §5.6 的 S1–S9（S8 ≡ D1；S9 是 floor vs round 判别）
 *   - **D1–D5：`hardline-test-spec.md` 的权威非整除判别集（验收单引用源，数值一字不改）**
 *   - X1–X5：自补补充用例（不占用验收编号）
 *   - 性质测试：随机 200 组帧率/跨度，逐帧对齐 spec 公式 + 单调性 + 区间不变量
 *   - 架构 §5.4 的 hold-previous 四条不变量
 *   - 额外边界：N=0 & s0=0、Lp=1 单帧片段、裁剪后重算 Lp、反向映射、asset.durationFrames=null
 *
 * 运行：`node tests/timebase.test.mjs`（先用 esbuild 把 timebase.ts 转译成 ESM 再 import）
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

/** 用 esbuild 把 TS 模块转译成可 import 的 ESM（bundle 掉类型导入）。 */
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

const tb = await loadTsModule('src/core/timebase.ts', 'timebase');
const types = await loadTsModule('src/core/types.ts', 'types');

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

function isNull(actual, label) {
  if (actual !== null) throw new Error(`${label}：期望 null，实际 ${String(actual)}`);
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

/* ---------------- 数据构造 ---------------- */

/** 构造一个通过校验的 Asset。`durationFrames` 可显式传 null（时长不可知）。 */
function makeAsset(overrides = {}) {
  return {
    id: 'ast_1',
    name: 'sample-720p.mp4',
    kind: 'video',
    handleRef: null,
    sourceMode: 'memory',
    status: 'memory',
    fpsMilli: 30000,
    durationFrames: 240,
    durationSec: 8,
    sampleRate: 48000,
    channels: 2,
    width: 1280,
    height: 720,
    hasAudio: true,
    thumbnailRef: null,
    container: 'mp4',
    codecVideo: 'avc1.64001f',
    codecAudio: 'mp4a.40.2',
    exactSeek: true,
    hashKey: 'sample-720p.mp4|1|1',
    ...overrides,
  };
}

/** 构造一个 Clip；durationFrames 显式给出（模拟"建片段时算定并缓存"）。 */
function makeClip(overrides = {}) {
  return {
    id: 'clp_1',
    assetId: 'ast_1',
    trackId: 'trk_V1',
    startFrame: 0,
    inFrame: 0,
    outFrame: 240,
    durationFrames: 300,
    speedMilli: 1000,
    enabled: true,
    transform: { scale: 1, x: 0, y: 0, opacity: 1, blendMode: 'normal' },
    audio: { gain: 1, fadeInFrames: 0, fadeOutFrames: 0 },
    effects: [],
    transitionIn: null,
    transitionOut: null,
    source: 'ui',
    ...overrides,
  };
}

/**
 * 建片段：素材跨度 + 两套毫帧率 → Lp（half-up，下限 1）。
 * 返回 `projectMilliFps`，调用方必须把它显式传给映射函数（这正是本次修复的核心）。
 */
function buildClip({
  assetFpsMilli,
  projectFpsMilli,
  trackId = 'trk_V1',
  startFrame = 0,
  inFrame = 0,
  outFrame,
  durationFrames,
  assetDuration,
}) {
  const span = outFrame - inFrame;
  return {
    clip: makeClip({
      trackId,
      startFrame,
      inFrame,
      outFrame,
      durationFrames:
        durationFrames ?? tb.projectSpanFrames(span, assetFpsMilli, projectFpsMilli),
    }),
    asset: makeAsset({
      fpsMilli: assetFpsMilli,
      durationFrames: assetDuration === undefined ? Math.max(outFrame, 240) : assetDuration,
    }),
    projectMilliFps: projectFpsMilli,
  };
}

/** 项目帧 → 素材帧（显式传 fp）。 */
function mapAt(context, projectFrame) {
  return tb.mapProjectFrameToAssetFrame(
    projectFrame,
    context.clip,
    context.asset,
    context.projectMilliFps,
  );
}

/** 素材帧 → 项目帧（显式传 fp）。 */
function inverseAt(context, assetFrame) {
  return tb.assetFrameToProjectFrame(
    assetFrame,
    context.clip,
    context.asset,
    context.projectMilliFps,
  );
}

/** 规格参考实现（BigInt 精确版）：`S = i + divFloor(N * fs, fp)`。 */
function specMap(context, projectFrame) {
  const { clip, asset, projectMilliFps } = context;
  const offset = (BigInt(projectFrame) * BigInt(asset.fpsMilli)) / BigInt(projectMilliFps);
  return clip.inFrame + Number(offset);
}

/* ---------------- 用例 ---------------- */

console.log('\n[1] spec §6 · T1–T10');

test('T1 24→30：fs=24000 fp=30000 s0=0 i=0 o=240 N=10 → S=8', () => {
  const context = buildClip({ assetFpsMilli: 24000, projectFpsMilli: 30000, outFrame: 240 });
  eq(context.clip.durationFrames, 300, 'T1 Lp');
  eq(mapAt(context, 10), 8, 'T1 S');
});

test('T2 30→24：fs=30000 fp=24000 s0=0 i=0 o=240 N=5 → S=6', () => {
  const context = buildClip({ assetFpsMilli: 30000, projectFpsMilli: 24000, outFrame: 240 });
  eq(context.clip.durationFrames, 192, 'T2 Lp');
  eq(mapAt(context, 5), 6, 'T2 S');
});

test('T3 60→30：fs=60000 fp=30000 s0=0 i=0 o=600 N=7 → S=14', () => {
  const context = buildClip({ assetFpsMilli: 60000, projectFpsMilli: 30000, outFrame: 600 });
  eq(context.clip.durationFrames, 300, 'T3 Lp');
  eq(mapAt(context, 7), 14, 'T3 S');
});

test('T4 25→30：fs=25000 fp=30000 s0=0 i=0 o=250 N=4 → S=3', () => {
  const context = buildClip({ assetFpsMilli: 25000, projectFpsMilli: 30000, outFrame: 250 });
  eq(mapAt(context, 4), 3, 'T4 S');
});

test('T5 同帧率恒等：fs=fp=30000 s0=50 i=100 o=400 N=60 → S=110', () => {
  const context = buildClip({
    assetFpsMilli: 30000,
    projectFpsMilli: 30000,
    startFrame: 50,
    inFrame: 100,
    outFrame: 400,
  });
  eq(context.clip.durationFrames, 300, 'T5 Lp');
  eq(mapAt(context, 60), 110, 'T5 S');
});

test('T6 边界首帧：fs=24000 fp=30000 s0=20 i=48 o=288 N=20 → S=48', () => {
  const context = buildClip({
    assetFpsMilli: 24000,
    projectFpsMilli: 30000,
    startFrame: 20,
    inFrame: 48,
    outFrame: 288,
  });
  eq(context.clip.durationFrames, 300, 'T6 Lp');
  eq(mapAt(context, 20), 48, 'T6 S');
});

test('T7 边界末帧：N=319 → S=287（= o-1）', () => {
  const context = buildClip({
    assetFpsMilli: 24000,
    projectFpsMilli: 30000,
    startFrame: 20,
    inFrame: 48,
    outFrame: 288,
  });
  eq(mapAt(context, 319), 287, 'T7 S');
  eq(mapAt(context, 319), context.clip.outFrame - 1, 'T7 末帧 = o-1');
});

test('T8 跨 outFrame：N=320 → null', () => {
  const context = buildClip({
    assetFpsMilli: 24000,
    projectFpsMilli: 30000,
    startFrame: 20,
    inFrame: 48,
    outFrame: 288,
  });
  isNull(mapAt(context, 320), 'T8');
});

test('T9 startFrame 之前：N=19 → null', () => {
  const context = buildClip({
    assetFpsMilli: 24000,
    projectFpsMilli: 30000,
    startFrame: 20,
    inFrame: 48,
    outFrame: 288,
  });
  isNull(mapAt(context, 19), 'T9');
});

test('T10 分数帧率：fs=23976 fp=29970 s0=0 i=0 o=23976 N=100 → S=80', () => {
  const context = buildClip({
    assetFpsMilli: 23976,
    projectFpsMilli: 29970,
    outFrame: 23976,
  });
  eq(context.clip.durationFrames, 29970, 'T10 Lp');
  eq(mapAt(context, 100), 80, 'T10 S');
});

console.log('\n[2] 架构 §5.6 · S1–S7');

test('S1 R-031 验收口径：24fps×10s → 300 项目帧', () => {
  const context = buildClip({ assetFpsMilli: 24000, projectFpsMilli: 30000, outFrame: 240 });
  eq(context.clip.durationFrames, 300, 'S1 Lp');
});

test('S2 单帧素材下限：24→30，1 帧素材 → Lp=1（1.25 half-up）', () => {
  eq(tb.projectSpanFrames(1, 24000, 30000), 1, 'S2');
});

test('S3 慢素材下限：60→30，1 帧素材 → Lp=1（0.5 half-up，不为 0）', () => {
  eq(tb.projectSpanFrames(1, 60000, 30000), 1, 'S3');
});

test('S4 裁剪后重锚：i=1,o=240 → Lp=299；map(0)=1；map(298)=239', () => {
  const context = buildClip({
    assetFpsMilli: 24000,
    projectFpsMilli: 30000,
    inFrame: 1,
    outFrame: 240,
  });
  eq(context.clip.durationFrames, 299, 'S4 Lp');
  eq(mapAt(context, 0), 1, 'S4 map(0)');
  eq(mapAt(context, 298), 239, 'S4 map(298)');
  eq(mapAt(context, 298), context.clip.outFrame - 1, 'S4 末帧 = o-1');
  isNull(mapAt(context, 299), 'S4 map(299)');
});

test('S5 无漂移回环（CI 口径 7200 帧 = 4 分钟 @30fps）', () => {
  for (let frame = 0; frame < 7200; frame += 1) {
    const roundTrip = tb.usToFrame(tb.frameToUs(frame, 30000), 30000);
    if (roundTrip !== frame) {
      throw new Error(`S5 回环漂移：frame=${frame} → ${roundTrip}`);
    }
  }
});

test('S5b 29.97 回环：f∈[0,100000) @29970 + frameToUs 定点值', () => {
  for (let frame = 0; frame < 100000; frame += 1) {
    const roundTrip = tb.usToFrame(tb.frameToUs(frame, 29970), 29970);
    if (roundTrip !== frame) {
      throw new Error(`S5b 回环漂移：frame=${frame} → ${roundTrip}`);
    }
  }
  eq(tb.frameToUs(107999, 30000), 3599966666, 'S5b frameToUs 定点值');
});

test('S5c 2 小时慢速回环（本地 slow 用例，216000 帧 @30000）', () => {
  for (let frame = 0; frame < 216000; frame += 1) {
    const roundTrip = tb.usToFrame(tb.frameToUs(frame, 30000), 30000);
    if (roundTrip !== frame) {
      throw new Error(`S5c 回环漂移：frame=${frame} → ${roundTrip}`);
    }
  }
});

test('S6 毫帧率精度：fs=23976 fp=29970 N=100 → 80（不引入浮点误差）', () => {
  const context = buildClip({
    assetFpsMilli: 23976,
    projectFpsMilli: 29970,
    outFrame: 23976,
  });
  eq(mapAt(context, 100), 80, 'S6');
});

test('S7 null 区间：map(-1) 断言失败；map(300)/map(301) null；map(299)=239', () => {
  const context = buildClip({ assetFpsMilli: 24000, projectFpsMilli: 30000, outFrame: 240 });
  throws(() => mapAt(context, -1), 'S7 map(-1)');
  isNull(mapAt(context, 300), 'S7 map(300)');
  isNull(mapAt(context, 301), 'S7 map(301)');
  eq(mapAt(context, 299), 239, 'S7 map(299)');
});

test('S8 非整除（防"用 durationFrames 反推"回归）≡ D1：map(1)=2、map(2)=4、map(12)=24', () => {
  const context = buildClip({ assetFpsMilli: 60000, projectFpsMilli: 30000, outFrame: 25 });
  eq(context.clip.durationFrames, 13, 'S8 Lp=13');
  eq(mapAt(context, 1), 2, 'S8 map(1)【反推给 1】');
  eq(mapAt(context, 2), 4, 'S8 map(2)【反推给 3】');
  eq(mapAt(context, 12), 24, 'S8 map(12)【反推给 23】');
});

test('S9 floor vs round 判别：T2 条件 N=7 → 8（四舍五入会给 9）', () => {
  const context = buildClip({ assetFpsMilli: 30000, projectFpsMilli: 24000, outFrame: 240 });
  // 7 × 30000 / 24000 = 8.75 → floor 8、round 9
  eq(mapAt(context, 7), 8, 'S9 map(7) 必须是 floor');
});

console.log('\n[3] D1–D5（hardline-test-spec 权威用例，反推实现会在 5 条里错 7 处）');

// 本组编号与数值**严格对齐 docs/hardline-test-spec.md 的 D1–D5**（验收单引用源），不得改期望值。
// 每条的注释都写明「反推比例（durationFrames 反推）会得到什么」，谁想删这几条都要先解释为什么反推不会错。

test('D1 fs=60000 fp=30000 o=25（Lp=13）：隔帧取 —— map(1)=2、map(2)=4、map(12)=24、map(13)=null', () => {
  const context = buildClip({ assetFpsMilli: 60000, projectFpsMilli: 30000, outFrame: 25 });
  eq(context.clip.durationFrames, 13, 'D1 Lp=13（25×30000/60000=12.5，half-up）');
  eq(mapAt(context, 1), 2, 'D1 map(1)【反推比例 25/13 会给 1】');
  eq(mapAt(context, 2), 4, 'D1 map(2)【反推给 3】');
  eq(mapAt(context, 12), 24, 'D1 map(12)=o-1【反推给 23】');
  isNull(mapAt(context, 13), 'D1 map(13)=null（=s0+Lp）');
});

test('D2 fs=24000 fp=30000 o=6（Lp=8）：map(4)=3、map(5)=4、map(7)=5、map(8)=null', () => {
  const context = buildClip({ assetFpsMilli: 24000, projectFpsMilli: 30000, outFrame: 6 });
  eq(context.clip.durationFrames, 8, 'D2 Lp=8（6×30000/24000=7.5，half-up）');
  eq(mapAt(context, 4), 3, 'D2 map(4)');
  eq(mapAt(context, 5), 4, 'D2 map(5)【反推 6/8=0.75 会给 3】');
  eq(mapAt(context, 7), 5, 'D2 map(7)=o-1');
  isNull(mapAt(context, 8), 'D2 map(8)=null');
});

test('D3 fs=30000 fp=24000 o=6（Lp=5）：map(3)=3、map(4)=5、map(5)=null', () => {
  const context = buildClip({ assetFpsMilli: 30000, projectFpsMilli: 24000, outFrame: 6 });
  eq(context.clip.durationFrames, 5, 'D3 Lp=5（6×24000/30000=4.8，half-up）');
  eq(mapAt(context, 3), 3, 'D3 map(3)【这一帧两种实现相同，只看它会漏】');
  eq(mapAt(context, 4), 5, 'D3 map(4)=o-1【反推 6/5=1.2 会给 4】');
  isNull(mapAt(context, 5), 'D3 map(5)=null');
});

test('D4 fs=23976 fp=29970 o=6（Lp=8）：NTSC 分数帧率 —— map(2)=1、map(5)=4、map(7)=5、map(8)=null', () => {
  const context = buildClip({
    assetFpsMilli: 23976,
    projectFpsMilli: 29970,
    outFrame: 6,
  });
  eq(context.clip.durationFrames, 8, 'D4 Lp=8（6×29970/23976=7.5，half-up）');
  eq(mapAt(context, 2), 1, 'D4 map(2)');
  eq(mapAt(context, 5), 4, 'D4 map(5)【反推 6/8=0.75 会给 3】');
  eq(mapAt(context, 7), 5, 'D4 map(7)=o-1');
  isNull(mapAt(context, 8), 'D4 map(8)=null');
});

test('D5 fs=25000 fp=30000 o=2（Lp=2）：2 帧极短片段 hold-previous —— map(1)=0', () => {
  const context = buildClip({ assetFpsMilli: 25000, projectFpsMilli: 30000, outFrame: 2 });
  eq(context.clip.durationFrames, 2, 'D5 Lp=2（2×30000/25000=2.4，half-up）');
  eq(mapAt(context, 0), 0, 'D5 map(0)');
  eq(mapAt(context, 1), 0, 'D5 map(1)=0：1×25/30=0.833<1，仍显示素材第 0 帧【反推 2/2=1 会给 1】');
  isNull(mapAt(context, 2), 'D5 map(2)=null（=s0+Lp）');
});

console.log('\n[3b] X1–X5（我自补的补充用例，不占用验收 D 编号）');

test('X1 60→30 长片段（o=600）：隔帧取语义与逐帧一致', () => {
  const context = buildClip({ assetFpsMilli: 60000, projectFpsMilli: 30000, outFrame: 600 });
  eq(context.clip.durationFrames, 300, 'X1 Lp');
  eq(mapAt(context, 7), 14, 'X1 N=7');
  eq(mapAt(context, 299), 598, 'X1 末帧');
});

test('X2 24→30 较长片段（o=10）：N=5→4、N=9→7', () => {
  const context = buildClip({ assetFpsMilli: 24000, projectFpsMilli: 30000, outFrame: 10 });
  eq(context.clip.durationFrames, 13, 'X2 Lp');
  eq(mapAt(context, 5), 4, 'X2 N=5');
  eq(mapAt(context, 9), 7, 'X2 N=9');
});

test('X3 25→30（o=24）：N=12→10、N=24→20', () => {
  const context = buildClip({ assetFpsMilli: 25000, projectFpsMilli: 30000, outFrame: 24 });
  eq(context.clip.durationFrames, 29, 'X3 Lp');
  eq(mapAt(context, 12), 10, 'X3 N=12');
  eq(mapAt(context, 24), 20, 'X3 N=24');
});

test('X4 30→24（o=241）：N=108→135（跨整除边界）', () => {
  const context = buildClip({ assetFpsMilli: 30000, projectFpsMilli: 24000, outFrame: 241 });
  eq(context.clip.durationFrames, 193, 'X4 Lp');
  eq(mapAt(context, 108), 135, 'X4 N=108');
});

test('X5 全区间不变量（60→30、o=25）：恒 inFrame ≤ map(N) < outFrame', () => {
  const context = buildClip({ assetFpsMilli: 60000, projectFpsMilli: 30000, outFrame: 25 });
  for (let frame = 0; frame < context.clip.durationFrames; frame += 1) {
    const mapped = mapAt(context, frame);
    if (mapped === null) throw new Error(`X5 N=${frame} 不应为 null`);
    if (mapped >= context.clip.outFrame) {
      throw new Error(`X5 N=${frame} 越过 outFrame：${mapped} ≥ ${context.clip.outFrame}`);
    }
    if (mapped < context.clip.inFrame) {
      throw new Error(`X5 N=${frame} 早于 inFrame：${mapped} < ${context.clip.inFrame}`);
    }
  }
});

console.log('\n[4] 性质测试（随机 200 组，逐帧对齐 spec 公式）');

test('随机 (fs, fp, i, o)：map 与 spec 公式逐帧相等 + 单调不减 + 落在 [i, o)', () => {
  const FPS = [23976, 24000, 25000, 29970, 30000, 60000];
  // 固定种子的 LCG，保证可复现（不引入 Math.random）
  let seed = 20261018;
  const nextRandom = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = (list) => list[Math.floor(nextRandom() * list.length)];

  let checked = 0;
  for (let round = 0; round < 200; round += 1) {
    const assetFpsMilli = pick(FPS);
    const projectFpsMilli = pick(FPS);
    const span = 1 + Math.floor(nextRandom() * 600);
    const startFrame = Math.floor(nextRandom() * 500);
    const inFrame = Math.floor(nextRandom() * 300);
    const outFrame = inFrame + span;
    const context = buildClip({
      assetFpsMilli,
      projectFpsMilli,
      startFrame,
      inFrame,
      outFrame,
      assetDuration: outFrame + 100,
    });

    let previous = -1;
    for (let offset = 0; offset < context.clip.durationFrames; offset += 1) {
      const projectFrame = startFrame + offset;
      const mapped = mapAt(context, projectFrame);
      if (mapped === null) {
        throw new Error(
          `性质测试：fs=${assetFpsMilli} fp=${projectFpsMilli} N=${projectFrame} 不应为 null`,
        );
      }
      const expected = specMap(context, offset);
      if (mapped !== expected) {
        throw new Error(
          `性质测试失配：fs=${assetFpsMilli} fp=${projectFpsMilli} s0=${startFrame} i=${inFrame} o=${outFrame} ` +
            `N=${projectFrame} → 实际 ${mapped}，spec ${expected}（Lp=${context.clip.durationFrames}）`,
        );
      }
      if (mapped < previous) {
        throw new Error(
          `性质测试单调性破坏：fs=${assetFpsMilli} fp=${projectFpsMilli} N=${projectFrame} ${mapped} < ${previous}`,
        );
      }
      if (mapped < inFrame || mapped >= outFrame) {
        throw new Error(
          `性质测试区间越界：fs=${assetFpsMilli} fp=${projectFpsMilli} N=${projectFrame} → ${mapped} ∉ [${inFrame}, ${outFrame})`,
        );
      }
      previous = mapped;
      checked += 1;
    }
    // 边界：首帧锚定、越界 null
    eq(mapAt(context, startFrame), inFrame, '性质测试首帧锚定');
    isNull(mapAt(context, startFrame + context.clip.durationFrames), '性质测试右越界');
    if (startFrame > 0) isNull(mapAt(context, startFrame - 1), '性质测试左越界');
  }
  if (checked < 10000) throw new Error(`性质测试覆盖不足：仅校验 ${checked} 帧`);
});

console.log('\n[5] 架构 §5.4 · hold-previous 四条不变量');

const INV = buildClip({ assetFpsMilli: 24000, projectFpsMilli: 30000, outFrame: 240 });
const INV_END = INV.clip.startFrame + INV.clip.durationFrames - 1;

test('不变量 1：单调不减 map(N+1) >= map(N)', () => {
  let previous = -1;
  for (let frame = INV.clip.startFrame; frame <= INV_END; frame += 1) {
    const mapped = mapAt(INV, frame);
    if (mapped === null) throw new Error(`不变量 1：N=${frame} 返回 null（应命中片段）`);
    if (mapped < previous) throw new Error(`不变量 1：N=${frame} 出现回退 ${previous} → ${mapped}`);
    previous = mapped;
  }
});

test('不变量 2：永不取未来帧 map(N) < outFrame', () => {
  for (let frame = INV.clip.startFrame; frame <= INV_END; frame += 1) {
    const mapped = mapAt(INV, frame);
    if (mapped === null || mapped >= INV.clip.outFrame) {
      throw new Error(`不变量 2：N=${frame} 返回 ${String(mapped)}，outFrame=${INV.clip.outFrame}`);
    }
  }
});

test('不变量 3：首帧锚定 map(startFrame) === inFrame', () => {
  eq(mapAt(INV, INV.clip.startFrame), INV.clip.inFrame, '不变量 3');
});

test('不变量 4：只允许项目帧→素材帧，反向映射不得推进播放头', () => {
  const before = JSON.stringify(INV.clip);
  eq(inverseAt(INV, INV.clip.inFrame), INV.clip.startFrame, '不变量 4 反向：素材首帧 → 项目首帧');
  eq(JSON.stringify(INV.clip), before, '不变量 4：映射不产生副作用');
  throws(() => inverseAt(INV, INV.clip.outFrame + 1), '不变量 4 越界');
});

console.log('\n[6] 音频采样反推（spec §4 规则 6 / §5.5）');

test('frameToSample：Lp=300, fp=30000 → 480000 采样点', () => {
  eq(tb.frameToSample(300, 30000), 480000, 'samples(300)');
  eq(tb.frameToSample(0, 30000), 0, 'samples(0)');
  eq(tb.frameToSample(1, 30000), 1600, 'samples(1) = 48000/30');
  eq(tb.frameToSample(1, 29970, 44100), 1471, 'samples(1, 29970, 44100)');
});

console.log('\n[7] 额外边界（自补）');

test('E1 N=0 且 s0=0 → 返回 inFrame（时间线起点）', () => {
  const combos = [
    [24000, 30000],
    [30000, 24000],
    [23976, 29970],
    [60000, 30000],
  ];
  for (const [assetFps, projectFps] of combos) {
    const context = buildClip({
      assetFpsMilli: assetFps,
      projectFpsMilli: projectFps,
      startFrame: 0,
      inFrame: 7,
      outFrame: 107,
    });
    eq(mapAt(context, 0), 7, `E1 fs=${assetFps} fp=${projectFps}`);
  }
});

test('E2 Lp=1 的单帧片段：只有 s0 一帧有画面', () => {
  const context = buildClip({
    assetFpsMilli: 24000,
    projectFpsMilli: 30000,
    startFrame: 10,
    inFrame: 5,
    outFrame: 6,
  });
  eq(context.clip.durationFrames, 1, 'E2 Lp');
  eq(mapAt(context, 10), 5, 'E2 map(10)');
  isNull(mapAt(context, 11), 'E2 map(11)');
  isNull(mapAt(context, 9), 'E2 map(9)');
});

test('E3 裁剪后重算 Lp（29.97 素材）：末帧仍 ≤ o-1 且越界为 null', () => {
  const context = buildClip({
    assetFpsMilli: 29970,
    projectFpsMilli: 30000,
    inFrame: 0,
    outFrame: 1000,
  });
  eq(context.clip.durationFrames, 1001, 'E3 Lp');
  eq(mapAt(context, 1000), 999, 'E3 map(1000)');
  isNull(mapAt(context, 1001), 'E3 map(1001)');
});

test('E4 反向映射往返：map(s0+N) 再反推回同一项目帧', () => {
  const context = buildClip({
    assetFpsMilli: 24000,
    projectFpsMilli: 30000,
    startFrame: 20,
    inFrame: 48,
    outFrame: 288,
  });
  eq(inverseAt(context, 48), 20, 'E4 首帧');
  eq(inverseAt(context, 287), 319, 'E4 末帧');
  const mapped = mapAt(context, 150);
  if (mapped === null) throw new Error('E4：N=150 不应为 null');
  eq(inverseAt(context, mapped), 150, 'E4 中点往返');
});

test('E5 非法输入一律抛错（浮点帧、零帧率、越界素材）', () => {
  const context = buildClip({ assetFpsMilli: 24000, projectFpsMilli: 30000, outFrame: 240 });
  throws(() => mapAt(context, 1.5), 'E5 浮点帧');
  throws(() => tb.frameToUs(1, 0), 'E5 零帧率');
  throws(() => tb.frameToSample(1, 30000, 0), 'E5 零采样率');
  throws(() => tb.projectSpanFrames(0, 24000, 30000), 'E5 跨度 0');
  throws(
    () => tb.mapProjectFrameToAssetFrame(0, { ...context.clip, outFrame: 9999 }, context.asset, 30000),
    'E5 越界素材',
  );
  throws(() => mapAt({ ...context, projectMilliFps: 0 }, 0), 'E5 项目帧率为 0');
});

test('E6 导出符号封闭：恰好 14 个函数 + 2 个常量', () => {
  // 2026-10-20（T09）：新增 `usToSeconds`——兼容模式要把帧号换算成秒驱动 <video>。
  // 2026-10-20（T15）：新增 `framesPerSecond`——标尺刻度要算 px/秒，`fpsMilli/1000`
  //   是毫帧率定义里的固有除法，只能收进 timebase。两者都刻意不加"组合函数"：
  //   调用方用 usToSeconds(frameToUs(...)) / framesPerSecond 自行组合，导出面不再膨胀。
  // 2026-10-20（M3）：新增 `samplesToUs`——导出给 `AudioData.timestamp` 赋微秒值，
  //   是 `frameToSample` 的逆方向；调用方拿秒时用 usToSeconds 组合，不新增 `samplesToSeconds`。
  // 2026-10-21（R-059）：新增 `msToFrame` / `frameToMs`——SRT 是毫秒定义的格式，
  //   字幕导入导出要在这两个单位间来回换；放在调用方就是又一处裸换算（守卫也会拦）。
  // 2026-10-21（R-059 语音识别）：新增 `secondsToMs` / `msToSeconds`——宿主 ASR 回传的是
  //   "秒"，字幕内部是"毫秒"；`sec * 1000` 同样是被守卫拦的裸换算。
  const expected = [
    'DEFAULT_FPS_MILLI',
    'PROJECT_SAMPLE_RATE',
    'assetFrameToProjectFrame',
    'frameToMs',
    'frameToSample',
    'frameToUs',
    'framesPerSecond',
    'mapProjectFrameToAssetFrame',
    'msToFrame',
    'msToSeconds',
    'projectSpanFrames',
    'samplesToUs',
    'secondsToFrames',
    'secondsToMs',
    'usToFrame',
    'usToSeconds',
  ];
  const actual = Object.keys(tb).sort();
  assert.deepStrictEqual(actual, expected, `导出符号不符：${actual.join(', ')}`);
});

test('E7 secondsToFrames：只用于读时钟，负值归 0', () => {
  eq(tb.secondsToFrames(10, 30000), 300, 'E7 10s@30fps');
  eq(tb.secondsToFrames(0, 30000), 0, 'E7 0s');
  eq(tb.secondsToFrames(-1, 30000), 0, 'E7 负秒');
  eq(tb.secondsToFrames(1.001, 29970), 29, 'E7 1.001s@29.97（还差 0.03ms 到第 30 帧）');
  eq(tb.secondsToFrames(1.002, 29970), 30, 'E7 1.002s@29.97');
});

test('E8 asset.durationFrames === null（时长不可知）：跳过边界校验但不崩', () => {
  const context = buildClip({
    assetFpsMilli: 30000,
    projectFpsMilli: 30000,
    inFrame: 0,
    outFrame: 240,
    assetDuration: null,
  });
  eq(mapAt(context, 0), 0, 'E8 首帧');
  eq(mapAt(context, 239), 239, 'E8 末帧');
  isNull(mapAt(context, 240), 'E8 越界仍为 null');
  eq(inverseAt(context, 100), 100, 'E8 反向');
});

test('E9 durationFrames 与 fps 失配时抛错（不静默 clamp）', () => {
  // 手工构造一个"Lp 被错误缓存"的片段：span=25 但 Lp=25（正确应为 13）
  const broken = {
    clip: makeClip({ inFrame: 0, outFrame: 25, durationFrames: 25, startFrame: 0 }),
    asset: makeAsset({ fpsMilli: 60000, durationFrames: 100 }),
    projectMilliFps: 30000,
  };
  // N=24 时 spec 给出 S=48 ≥ outFrame=25 → 必须抛错而不是返回越界帧
  throws(() => mapAt(broken, 24), 'E9 越界必须抛错');
});


test('E10 samplesToUs：与 frameToSample 互为逆（导出给 AudioData 打时间戳）', () => {
  // 48kHz 下 1 秒 = 48000 采样 = 1_000_000us
  eq(tb.samplesToUs(48000, 48000), 1000000, 'E10 1s@48k');
  eq(tb.samplesToUs(0, 48000), 0, 'E10 起点');
  // 44.1kHz 下 44100 采样也是 1 秒
  eq(tb.samplesToUs(44100, 44100), 1000000, 'E10 1s@44.1k');
  // 单采样精度：48k 下 1 采样 = 20.833us（half-up → 21）
  eq(tb.samplesToUs(1, 48000), 21, 'E10 单采样四舍五入');
  // 与 frameToSample 的组合：30fps 第 30 帧 → 48000 采样 → 1000000us
  eq(tb.samplesToUs(tb.frameToSample(30, 30000, 48000), 48000), 1000000, 'E10 帧→采样→微秒');
  throws(() => tb.samplesToUs(-1, 48000), 'E10 负数抛错');
  throws(() => tb.samplesToUs(10, 0), 'E10 采样率 0 抛错');
});

test('E11 trackDisplayOrder：屏幕顺序视频在上、音频垫底，且不改动原数组', () => {
  const tracks = [
    types.createTrack({ id: 'trk_A1', kind: 'audio', name: 'A1', order: 0 }),
    types.createTrack({ id: 'trk_V1', kind: 'video', name: 'V1', order: 0 }),
    types.createTrack({ id: 'trk_V2', kind: 'video', name: 'V2', order: 1 }),
  ];
  const ordered = types.trackDisplayOrder(tracks);
  eq(ordered.map((t) => t.id).join(','), 'trk_V2,trk_V1,trk_A1', 'E11 自上而下 V2/V1/A1');
  eq(tracks[0].id, 'trk_A1', 'E11 原数组顺序未被修改');
  // 再加一条 V3（order 2）应排到最上
  const more = [...tracks, types.createTrack({ id: 'trk_V3', kind: 'video', name: 'V3', order: 2 })];
  eq(types.trackDisplayOrder(more)[0].id, 'trk_V3', 'E11 新视频轨在最上');
});

/* ---------------- S8 变速（speedMilli）守恒 ---------------- */

test('S8a speed=2x 时项目时长减半（240 帧跨度 → 120 项目帧）', () => {
  const asset = makeAsset();
  // 1x：240 帧素材跨度 → 240 项目帧（同帧率）
  if (tb.projectSpanFrames(240, asset.fpsMilli, 30000) !== 240) {
    throw new Error('1x 基线应为 240');
  }
  const fast = tb.projectSpanFrames(240, asset.fpsMilli, 30000, 2000);
  if (fast !== 120) throw new Error(`2x 应为 120，实际 ${fast}`);
});

test('S8b speed=0.5x 时项目时长翻倍（240 → 480）', () => {
  const asset = makeAsset();
  const slow = tb.projectSpanFrames(240, asset.fpsMilli, 30000, 500);
  if (slow !== 480) throw new Error(`0.5x 应为 480，实际 ${slow}`);
});

test('S8c 2x 播放：项目帧 60 对应素材帧 120', () => {
  const asset = makeAsset();
  const clip = makeClip({ speedMilli: 2000, durationFrames: 120 });
  const mapped = tb.mapProjectFrameToAssetFrame(60, clip, asset, 30000);
  if (mapped !== 120) throw new Error(`2x 下项目帧 60 应映射素材帧 120，实际 ${mapped}`);
});

test('S8d 0.5x 播放：项目帧 120 对应素材帧 60', () => {
  const asset = makeAsset();
  const clip = makeClip({ speedMilli: 500, durationFrames: 480 });
  const mapped = tb.mapProjectFrameToAssetFrame(120, clip, asset, 30000);
  if (mapped !== 60) throw new Error(`0.5x 下项目帧 120 应映射素材帧 60，实际 ${mapped}`);
});

test('S8e 变速不变量：map(start)===inFrame、单调、恒 < outFrame', () => {
  const asset = makeAsset();
  for (const speedMilli of [250, 500, 1000, 2000, 4000]) {
    const duration = tb.projectSpanFrames(240, asset.fpsMilli, 30000, speedMilli);
    const clip = makeClip({ speedMilli, durationFrames: duration, startFrame: 37 });
    if (tb.mapProjectFrameToAssetFrame(37, clip, asset, 30000) !== 0) {
      throw new Error(`${speedMilli}：map(startFrame) 应等于 inFrame=0`);
    }
    let previous = -1;
    for (let frame = 37; frame < 37 + duration; frame += 1) {
      const mapped = tb.mapProjectFrameToAssetFrame(frame, clip, asset, 30000);
      if (mapped === null) throw new Error(`${speedMilli}：帧 ${frame} 意外返回 null`);
      if (mapped < previous) throw new Error(`${speedMilli}：映射非单调（帧 ${frame}）`);
      if (mapped >= 240) throw new Error(`${speedMilli}：素材帧 ${mapped} 越过 outFrame=240`);
      previous = mapped;
    }
  }
});

test('S8f speedMilli 缺失（旧工程）按 1x', () => {
  const asset = makeAsset();
  const legacy = makeClip({ durationFrames: 300 });
  delete legacy.speedMilli;
  const mapped = tb.mapProjectFrameToAssetFrame(137, legacy, asset, 30000);
  if (mapped !== 137) throw new Error(`旧工程应按 1x 映射为 137，实际 ${mapped}`);
});

test('S8g 变速不改变素材跨度（outFrame-inFrame 守恒）', () => {
  const asset = makeAsset();
  for (const speedMilli of [500, 1000, 2000]) {
    const duration = tb.projectSpanFrames(240, asset.fpsMilli, 30000, speedMilli);
    const clip = makeClip({ speedMilli, durationFrames: duration });
    // 变速只改项目时长，素材起止点不动
    if (clip.outFrame - clip.inFrame !== 240) throw new Error('素材跨度不应变化');
    // 且 durationFrames 与 projectSpanFrames 口径一致
    if (clip.durationFrames !== tb.projectSpanFrames(clip.outFrame - clip.inFrame, asset.fpsMilli, 30000, speedMilli)) {
      throw new Error(`${speedMilli}：durationFrames 与 projectSpanFrames 不一致`);
    }
  }
});

/* ---------------- 汇总 ---------------- */

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} 时基单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  console.log('失败用例：');
  for (const failure of failures) console.log(`  - ${failure.name}: ${failure.message}`);
  process.exit(1);
}
