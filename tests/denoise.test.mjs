/**
 * 降噪单测（R-061）。
 *
 * 判据只有两条，但都必须硬：
 * 1. **底噪段被压下去**（静音处不再"嘶——"）；
 * 2. **人声段基本不动**（降噪不该把人声也削了）。
 *
 * 用合成信号：0–0.5s 是 440Hz 正弦（代表"人声"），0.5–1.0s 是 -54dBFS 的底噪。
 *
 * 运行：`node tests/denoise.test.mjs`
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

const denoise = await load('src/media/denoise.ts', 'denoise');
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

function eq(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message);
}

function rms(plane, from, to) {
  let sum = 0;
  for (let i = from; i < to; i += 1) {
    const v = plane[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / Math.max(1, to - from));
}

const RATE = 48000;
const TOTAL = Math.round(RATE * 1.2);
/** 人声结束点（0.4s）。后面留 0.8s 底噪，够包络释放（80ms 时间常数 ≈ 4 个周期）。 */
const SPEECH_END = Math.round(RATE * 0.4);

/**
 * 0–0.4s 人声（440Hz, 0.3）+ 0.4–1.2s 底噪（0.002）。
 *
 * 为什么底噪段要留够 0.8s：噪声门的释放是 80ms 时间常数，从人声电平衰减到门限
 * 大约要 300ms——量测窗口如果紧贴人声结束，会测到"还在释放中"的残留，
 * 那是设计使然（快关会把词尾削掉），不是 bug。
 */
function makeSignal() {
  const plane = new Float32Array(TOTAL);
  for (let i = 0; i < TOTAL; i += 1) {
    if (i < SPEECH_END) {
      plane[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / RATE);
    } else {
      // 用确定性的伪噪声，避免测试本身随机
      plane[i] = 0.002 * Math.sin((2 * Math.PI * 7919 * i) / RATE);
    }
  }
  return plane;
}

console.log('\n[1] denoiseOf（参数读取与钳制）');

test('①a 没有效果 → null', () => {
  const clip = types.createClip({ assetId: 'a', trackId: 't', startFrame: 0, inFrame: 0, outFrame: 10, durationFrames: 10 });
  eq(denoise.denoiseOf(clip), null);
});

test('①b 读参数并夹到合法区间', () => {
  const clip = types.createClip({ assetId: 'a', trackId: 't', startFrame: 0, inFrame: 0, outFrame: 10, durationFrames: 10 });
  clip.effects = [
    { id: 'fx', clipId: clip.id, type: 'denoise', params: { thresholdDb: -200, enhance: 5 }, keyframes: [], enabled: true, order: 0, source: 'ui' },
  ];
  const params = denoise.denoiseOf(clip);
  eq(params.thresholdDb, -70);
  eq(params.enhance, 1);
});

test('①c 被禁用的效果不生效', () => {
  const clip = types.createClip({ assetId: 'a', trackId: 't', startFrame: 0, inFrame: 0, outFrame: 10, durationFrames: 10 });
  clip.effects = [
    { id: 'fx', clipId: clip.id, type: 'denoise', params: { thresholdDb: -40, enhance: 0.5 }, keyframes: [], enabled: false, order: 0, source: 'ui' },
  ];
  eq(denoise.denoiseOf(clip), null);
});

console.log('\n[2] applyDenoise（底噪压下去、人声保住）');

test('②a 底噪段 RMS 至少降 90%（量测点在包络释放之后）', () => {
  const plane = makeSignal();
  const from = Math.round(RATE * 0.8);
  const before = rms(plane, from, TOTAL);
  denoise.applyDenoise([plane], { thresholdDb: -42, enhance: 0 }, RATE);
  const after = rms(plane, from, TOTAL);
  assert.ok(after < before * 0.1, `底噪 RMS ${before.toFixed(6)} → ${after.toFixed(6)}`);
});

test('②b 人声段 RMS 保留 70% 以上', () => {
  const plane = makeSignal();
  const before = rms(plane, 2000, SPEECH_END - 2000);
  denoise.applyDenoise([plane], { thresholdDb: -42, enhance: 0 }, RATE);
  const after = rms(plane, 2000, SPEECH_END - 2000);
  assert.ok(after > before * 0.7, `人声 RMS ${before.toFixed(4)} → ${after.toFixed(4)}`);
});

test('②c 增强会改变波形，但不破坏人声电平（±20%）', () => {
  const plain = makeSignal();
  const enhanced = makeSignal();
  denoise.applyDenoise([plain], { thresholdDb: -42, enhance: 0 }, RATE);
  denoise.applyDenoise([enhanced], { thresholdDb: -42, enhance: 1 }, RATE);
  const a = rms(plain, 2000, SPEECH_END - 2000);
  const b = rms(enhanced, 2000, SPEECH_END - 2000);
  // 高通截止从 60Hz 抬到 150Hz + 存在感抬升，电平变化应在 ±20% 内（不该把人声削没）
  assert.ok(Math.abs(b - a) / a < 0.2, `增强前后人声 RMS ${a.toFixed(4)} vs ${b.toFixed(4)}`);
  // 波形确实变了（不是恒等变换）
  let diff = 0;
  for (let i = 2000; i < SPEECH_END - 2000; i += 97) diff += Math.abs((plain[i] ?? 0) - (enhanced[i] ?? 0));
  assert.ok(diff > 0.01, `增强后波形应与未增强不同（累计差 ${diff.toFixed(4)}）`);
});

test('②d 全静音输入不会产生 NaN/Infinity', () => {
  const plane = new Float32Array(4800);
  denoise.applyDenoise([plane], { thresholdDb: -42, enhance: 0.5 }, RATE);
  for (let i = 0; i < plane.length; i += 1) {
    assert.ok(Number.isFinite(plane[i]), `第 ${i} 个样本不是有限值`);
  }
});

test('②e 多声道独立处理（左声道有人声、右声道静音）', () => {
  const left = makeSignal();
  const right = new Float32Array(TOTAL);
  denoise.applyDenoise([left, right], { thresholdDb: -42, enhance: 0 }, RATE);
  assert.ok(rms(left, 2000, SPEECH_END - 2000) > 0.05, '左声道人声应保留');
  assert.ok(rms(right, 0, TOTAL) < 1e-6, '右声道应保持静音');
});

console.log('\n[3] parseDenoiseRequest（自然语言入口）');

test('③a 命中常见说法', () => {
  for (const text of ['降噪', '帮我降噪', '去掉底噪', '开一下人声增强']) {
    eq(denoise.parseDenoiseRequest(text), true, text);
  }
});

test('③b 无关指令不命中', () => {
  for (const text of ['把音量调大', '去掉开头 3 秒', '这段为什么要降']) {
    eq(denoise.parseDenoiseRequest(text), false, text);
  }
});

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} 降噪单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}`);
    console.error(failure.error);
  }
  process.exit(1);
}
