/**
 * 语音识别生成字幕（R-059）单测：音频前置处理 + 片段清洗 + 指令识别。
 *
 * 这里**不测 ASR 本身**（客户端没有识别能力，识别在宿主侧）。
 * 测的是我们负责的那三段：
 *   ① 多声道 → 单声道、重采样 16k（`media/asrAudio`）
 *   ② 宿主回传的脏片段 → 干净 cue（时间戳/重叠/空文本）
 *   ③ 指令识别（"自动生成字幕" vs "字幕怎么导入"）
 *
 * 运行：`node tests/transcribe.test.mjs`
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

const asr = await load('src/media/asrAudio.ts', 'asrAudio');
const transcribe = await load('src/ai/transcribe.ts', 'transcribe');

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
function near(a, b, tol, m) {
  assert.ok(Math.abs(a - b) <= tol, m ?? `期望 ${b}±${tol}，实际 ${a}`);
}

/* ---------------- ① 音频前置处理 ---------------- */

console.log('\n[1] downmixToMono / resampleLinear / rmsOf');

test('①a 双声道取平均（不是取最大）', () => {
  const left = Float32Array.from([0.5, -0.5, 1, 0]);
  const right = Float32Array.from([-0.5, 0.5, 0, 0]);
  const mono = asr.downmixToMono([left, right]);
  eq(Array.from(mono), [0, 0, 0.5, 0], '相位相反的两声道应当抵消为 0');
});

test('①b 单声道原样返回（不复制）', () => {
  const mono = Float32Array.from([0.1, 0.2]);
  assert.strictEqual(asr.downmixToMono([mono]), mono);
});

test('①c 48k → 16k：长度按 1/3 缩，直流电平保持', () => {
  const input = new Float32Array(4800).fill(0.25);
  const out = asr.resampleLinear(input, 48000, 16000);
  eq(out.length, 1600);
  near(out[800], 0.25, 1e-6, '直流分量必须原样保留（插值不该改变电平）');
});

test('①d 采样率相同 → 原样返回', () => {
  const input = new Float32Array(10).fill(0.1);
  assert.strictEqual(asr.resampleLinear(input, 16000, 16000), input);
});

test('①e 正弦波重采样后仍是同频正弦（峰值接近原值）', () => {
  // 440Hz @48k → 16k：每 109 个采样一个周期，插值后峰值应仍在 ±1 附近
  const input = new Float32Array(4800);
  for (let i = 0; i < input.length; i += 1) input[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
  const out = asr.resampleLinear(input, 48000, 16000);
  let peak = 0;
  for (const value of out) peak = Math.max(peak, Math.abs(value));
  assert.ok(peak > 0.95 && peak <= 1.001, `峰值应在 0.95..1，实际 ${peak.toFixed(3)}`);
});

test('①f rmsOf：静音 0、满幅 1', () => {
  near(asr.rmsOf(new Float32Array(100)), 0, 1e-9);
  near(asr.rmsOf(new Float32Array(100).fill(1)), 1, 1e-6);
  near(asr.rmsOf(new Float32Array(0)), 0, 1e-9, '空数组不能除零');
});

/* ---------------- ② 片段清洗 ---------------- */

console.log('\n[2] segmentsToCues（不可信输入清洗）');

test('②a 正常片段按顺序转毫秒', () => {
  const result = transcribe.segmentsToCues([
    { startSec: 0, endSec: 1.5, text: '第一句' },
    { startSec: 2, endSec: 3.25, text: ' 第二句 ' },
  ]);
  eq(result.dropped, 0);
  eq(result.cues, [
    { startMs: 0, endMs: 1500, text: '第一句' },
    { startMs: 2000, endMs: 3250, text: '第二句' },
  ]);
});

test('②b 坏片段被丢弃：end<=start / 非有限 / 空文本', () => {
  const result = transcribe.segmentsToCues([
    { startSec: 1, endSec: 1, text: '零长' },
    { startSec: 2, endSec: 1, text: '倒着' },
    { startSec: Number.NaN, endSec: 3, text: 'NaN' },
    { startSec: 0, endSec: 1, text: '   ' },
    { startSec: 0, endSec: 1, text: '好的' },
  ]);
  eq(result.dropped, 4);
  eq(result.cues.length, 1);
  eq(result.cues[0].text, '好的');
});

test('②c 乱序输入按起点排序', () => {
  const result = transcribe.segmentsToCues([
    { startSec: 3, endSec: 4, text: '第三' },
    { startSec: 0, endSec: 1, text: '第一' },
    { startSec: 1.5, endSec: 2.5, text: '第二' },
  ]);
  eq(result.cues.map((cue) => cue.text), ['第一', '第二', '第三']);
});

test('②d 重叠 → 前一条终点收到后一条起点（字幕不能同时出现两条）', () => {
  const result = transcribe.segmentsToCues([
    { startSec: 0, endSec: 5, text: '长句' },
    { startSec: 2, endSec: 3, text: '短句' },
  ]);
  eq(result.cues[0].endMs, 2000, '第一条被截到 2s');
  eq(result.cues[1].startMs, 2000);
  eq(result.dropped, 0);
});

test('②e 被完全挤没的片段丢弃（不足 40ms）', () => {
  const result = transcribe.segmentsToCues([
    { startSec: 0, endSec: 1, text: '甲' },
    { startSec: 0.005, endSec: 1, text: '乙' }, // 起点几乎相同 → 甲被截成 5ms
  ]);
  eq(result.cues.length, 1, '只剩一条');
  eq(result.cues[0].text, '乙');
  eq(result.dropped, 1);
});

test('②f 负时间戳夹到 0', () => {
  const result = transcribe.segmentsToCues([{ startSec: -0.5, endSec: 1, text: '提前' }]);
  eq(result.cues[0].startMs, 0);
  eq(result.cues[0].endMs, 1000);
});

test('②g 空输入 → 空结果（不抛）', () => {
  eq(transcribe.segmentsToCues([]), { cues: [], dropped: 0 });
});

/* ---------------- ③ 指令识别 ---------------- */

console.log('\n[3] parseTranscribeRequest');

test('③a "自动生成字幕" → 中文', () => {
  eq(transcribe.parseTranscribeRequest('自动生成字幕'), { language: 'zh' });
});

test('③b "识别英文字幕" → en', () => {
  eq(transcribe.parseTranscribeRequest('识别英文字幕')?.language, 'en');
});

test('③c "帮我转写一下" → 也算（没有"字幕"二字）', () => {
  eq(transcribe.parseTranscribeRequest('帮我转写一下')?.language, 'zh');
});

test('③d 提问不接（"字幕怎么导入"）', () => {
  eq(transcribe.parseTranscribeRequest('字幕怎么导入'), null);
});

test('③e 无关指令 → null', () => {
  eq(transcribe.parseTranscribeRequest('把音量调大'), null);
  eq(transcribe.parseTranscribeRequest('剪掉开头 3 秒'), null);
});

/* ---------------- ④ 没有转写通道 ---------------- */

console.log('\n[4] transcribeTimeline（无通道）');

const silentDoc = {
  id: 'prj',
  name: 't',
  fpsMilli: 30000,
  width: 640,
  height: 360,
  sampleRate: 48000,
  frameMapPolicy: 'holdPrevious',
  durationRounding: 'halfUp',
  tracks: [],
  assets: [],
  playheadFrame: 0,
  zoomLevel: 5,
  schemaVersion: 1,
  createdAt: 0,
  updatedAt: 0,
};

await (async () => {
  try {
    const result = await transcribe.transcribeTimeline({ doc: silentDoc, transcribe: undefined });
    eq(result.ok, false);
    assert.match(result.error.message, /未提供语音识别通道/);
    assert.match(String(result.error.detail), /transcribe/);
    passed += 1;
    console.log('  ✓ ④a 没有 transcribe → 可读拒绝（含"怎么接"的提示）');
  } catch (error) {
    failures.push({ name: '④a', error });
    console.log(`  ✗ ④a\n      ${error instanceof Error ? error.message : String(error)}`);
  }
})();

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} 语音识别单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}`);
    console.error(failure.error);
  }
  process.exit(1);
}
