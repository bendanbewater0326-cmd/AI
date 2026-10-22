/**
 * T10 音频引擎单测：重采样纯函数（⑦）+ 质量验证（⑥，Goertzel 检测）。
 *
 * 运行：node tests/audio.test.mjs
 */
import { buildSync } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..');
const TMP_DIR = path.join(HERE, '.tmp');

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

const audio = await loadTsModule('src/media/audioEngine.ts', 'audioEngine');
const { resample, totalSamplesFor, PROJECT_SAMPLE_RATE, envelopeAt, applyClipGain } = audio;

let passed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { failures.push({ name, message: error instanceof Error ? error.message : String(error) }); console.log(`  ✗ ${name}`); console.log(`      ${error instanceof Error ? error.message : String(error)}`); }
}
function truthy(v, label) { if (!v) throw new Error(`${label}：期望为真`); }
function approx(a, b, tol, label) { if (Math.abs(a - b) > tol) throw new Error(`${label}：期望 ${b}±${tol}，实际 ${a}`); }

/* ---------------- ⑦ 纯函数基本性质 ---------------- */

test('⑦ 同采样率恒等拷贝', () => {
  const input = new Float32Array([0.1, 0.5, -0.3, 0.9]);
  const out = resample(input, 48000, 48000);
  truthy(out.length === input.length, '长度一致');
  for (let i = 0; i < input.length; i += 1) approx(out[i], input[i], 1e-6, `out[${i}]`);
});

test('⑦ 输出长度 = round(len × toRate/fromRate)', () => {
  const input = new Float32Array(44100); // 1 秒 44.1k
  const out = resample(input, 44100, 48000);
  truthy(out.length === 48000, `长度 ${out.length} === 48000`);
});

test('⑦ 直流增益为 1（恒定信号不变）', () => {
  const input = new Float32Array(1000).fill(0.5);
  const out = resample(input, 44100, 48000);
  for (let i = 0; i < out.length; i += 1) approx(out[i], 0.5, 0.01, `out[${i}]`);
});

/* ---------------- ⑥ 重采样质量：1kHz 正弦 44.1k → 48k ---------------- */

function goertzel(samples, freq, sampleRate) {
  const w = (2 * Math.PI * freq) / sampleRate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return power;
}

function db(power, n) {
  return 10 * Math.log10(power / ((n * n) / 4) + 1e-12);
}

test('⑥ 1kHz 正弦重采样后峰值频率偏差 ≤ 1Hz', () => {
  const N = 44100; // 1 秒 44.1k
  const input = new Float32Array(N);
  for (let i = 0; i < N; i += 1) input[i] = Math.sin((2 * Math.PI * 1000 * i) / 44100);
  const out = resample(input, 44100, 48000);

  // 在 999/1000/1001 Hz 扫 Goertzel，找最大响应
  let bestFreq = 0;
  let bestPow = -1;
  for (let f = 995; f <= 1005; f += 1) {
    const p = goertzel(out, f, 48000);
    if (p > bestPow) { bestPow = p; bestFreq = f; }
  }
  approx(bestFreq, 1000, 1, '峰值频率');
});

test('⑥ 无非谐波尖峰（2k/3k/5k/10k 处 < −60dB）', () => {
  const N = 44100;
  const input = new Float32Array(N);
  for (let i = 0; i < N; i += 1) input[i] = Math.sin((2 * Math.PI * 1000 * i) / 44100);
  const out = resample(input, 44100, 48000);

  const fundamental = db(goertzel(out, 1000, 48000), out.length);
  for (const f of [2000, 3000, 5000, 10000]) {
    const spurious = db(goertzel(out, f, 48000), out.length);
    // 相对基频的尖峰抑制
    truthy(spurious - fundamental < -60, `${f}Hz 处相对基频 ${(spurious - fundamental).toFixed(1)}dB < -60dB`);
  }
});

/* ---------------- ⑧ 采样数守恒 ---------------- */

test('⑧ totalSamplesFor 采样数守恒', () => {
  // 30fps × 10 秒 = 300 帧 → 48000 × 10 = 480000 采样
  approx(totalSamplesFor(300, 30000), 480000, 0, '300 帧 @30fps');
  // 24fps × 10 秒 = 240 帧 → 480000
  approx(totalSamplesFor(240, 24000), 480000, 0, '240 帧 @24fps');
});


/* ---------------- R-037 音量与淡入淡出 ---------------- */

/** 造一个最小 clip（只带 audio 包络需要的字段）。 */
function makeClip(audioPatch, durationFrames = 240) {
  return {
    id: 'c1',
    durationFrames,
    audio: { gain: 1, fadeInFrames: 0, fadeOutFrames: 0, ...audioPatch },
  };
}

test('R-037a 无淡化时包络恒为 1', () => {
  const clip = makeClip({});
  approx(envelopeAt(clip, 0), 1, 0, '起点');
  approx(envelopeAt(clip, 120), 1, 0, '中点');
  approx(envelopeAt(clip, 240), 1, 0, '终点');
});

test('R-037b 淡入是线性斜坡（0 → 1）', () => {
  const clip = makeClip({ fadeInFrames: 30 });
  approx(envelopeAt(clip, 0), 0, 1e-9, '第 0 帧');
  approx(envelopeAt(clip, 15), 0.5, 1e-9, '第 15 帧');
  approx(envelopeAt(clip, 30), 1, 1e-9, '第 30 帧');
  approx(envelopeAt(clip, 31), 1, 1e-9, '斜坡之后');
});

test('R-037c 淡出是线性斜坡（1 → 0）', () => {
  const clip = makeClip({ fadeOutFrames: 60 });
  approx(envelopeAt(clip, 179), 1, 1e-9, '淡出之前');
  approx(envelopeAt(clip, 180), 1, 1e-9, '淡出起点');
  approx(envelopeAt(clip, 210), 0.5, 1e-9, '中点');
  approx(envelopeAt(clip, 240), 0, 1e-9, '终点');
});

test('R-037d 淡入淡出同时存在时取较小值（不会互相抵消）', () => {
  const clip = makeClip({ fadeInFrames: 60, fadeOutFrames: 60 }, 120);
  approx(envelopeAt(clip, 30), 0.5, 1e-9, '淡入中点');
  approx(envelopeAt(clip, 60), 1, 1e-9, '交界处');
  approx(envelopeAt(clip, 90), 0.5, 1e-9, '淡出中点');
});

test('R-037e applyClipGain 把音量与包络烘进 PCM', () => {
  const clip = makeClip({ gain: 0.5 });
  const plane = new Float32Array([1, 1, 1, 1]);
  applyClipGain([plane], clip, 0, 240);
  for (const value of plane) approx(value, 0.5, 1e-6, '音量 50%');

  // 淡入段：块首 0、块尾 1，块内线性插值
  const fading = makeClip({ fadeInFrames: 100 });
  const ramp = new Float32Array([1, 1, 1]);
  applyClipGain([ramp], fading, 0, 100);
  approx(ramp[0], 0, 1e-6, '块首');
  approx(ramp[1], 0.5, 1e-6, '块中');
  approx(ramp[2], 1, 1e-6, '块尾');
});

console.log(`\n✓ 音频引擎单测：通过 ${passed} / ${passed + failures.length}`);
if (failures.length > 0) {
  console.log('失败用例：');
  for (const f of failures) console.log(`  - ${f.name} — ${f.message}`);
  process.exitCode = 1;
}
