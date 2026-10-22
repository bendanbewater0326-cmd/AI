/**
 * T19 WebM/EBML 单测：vint、未知 size、三种 lacing、四个真实素材。
 *
 * 运行：node tests/webm.test.mjs
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

const webm = await loadTsModule('src/media/demuxWebm.ts', 'demuxWebm');
const { readVint, readElementHeader, lacingOf, splitBlockLacing, openWebm } = webm;

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
  if (!Object.is(actual, expected)) throw new Error(`${label}：期望 ${String(expected)}，实际 ${String(actual)}`);
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, message: error instanceof Error ? error.message : String(error) });
    console.log(`  ✗ ${name}`);
    console.log(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ---------------- ① vint 可变长整数 ---------------- */

test('①a vint 1 字节（size 语义：去掉 marker）', () => {
  const r = readVint(new Uint8Array([0x81]), 0, false);
  eq(r?.value, 1, '0x81 → 1');
  eq(r?.length, 1, '长度 1');
  const z = readVint(new Uint8Array([0x80]), 0, false);
  eq(z?.value, 0, '0x80 → 0');
});

test('①b vint 2 字节', () => {
  const r = readVint(new Uint8Array([0x40, 0x01]), 0, false);
  eq(r?.value, 1, '0x4001 → 1');
  eq(r?.length, 2, '长度 2');
});

test('①c vint 元素 ID 保留 marker（EBML 魔数）', () => {
  const r = readVint(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), 0, true);
  eq(r?.value, 0x1a45dfa3, 'ID = 1A45DFA3');
  eq(r?.length, 4, '长度 4');
});

test('①d 未知 size：01 FF FF FF FF FF FF FF → size null', () => {
  // 元素头：ID=Segment(18538067) + size=01FFFFFFFFFFFFFF（全 1 = 未知）
  const bytes = new Uint8Array([
    0x18, 0x53, 0x80, 0x67,
    0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  ]);
  const h = readElementHeader(bytes, 0);
  eq(h?.id, 0x18538067, 'Segment ID');
  eq(h?.size, null, 'size 为 null（未知，延伸到文件尾）');
  eq(h?.headerSize, 12, 'header 12 字节');
});

/* ---------------- ① lacing 三种 ---------------- */

test('①e lacing none：单帧（现有 fixture 全是这种）', () => {
  const frames = splitBlockLacing(new Uint8Array([1, 2, 3]), 100, 'none', true, 0);
  eq(frames?.length, 1, '1 帧');
  eq(frames?.[0]?.size, 3, 'size 3');
  eq(frames?.[0]?.offset, 100, 'offset 100');
  eq(frames?.[0]?.isKey, true, '关键帧');
});

test('①f lacing fixed：3 帧均分', () => {
  // [帧数-1=2][6 字节载荷] → 每帧 2 字节
  const data = new Uint8Array([0x02, 1, 2, 3, 4, 5, 6]);
  const frames = splitBlockLacing(data, 0, 'fixed', false, 0);
  eq(frames?.length, 3, '3 帧');
  eq(frames?.[0]?.size, 2, '帧1 size 2');
  eq(frames?.[1]?.size, 2, '帧2 size 2');
  eq(frames?.[2]?.size, 2, '帧3 size 2');
  eq(frames?.[1]?.offset, 3, '帧2 offset 3');
});

test('①g lacing fixed：除不尽时余数归最后一帧', () => {
  // [帧数-1=1][7 字节] → base=3, 最后一帧 4
  const data = new Uint8Array([0x01, 1, 2, 3, 4, 5, 6, 7]);
  const frames = splitBlockLacing(data, 0, 'fixed', false, 0);
  eq(frames?.[0]?.size, 3, '帧1 3 字节');
  eq(frames?.[1]?.size, 4, '帧2 4 字节（余数）');
});

test('①h lacing Xiph：2 帧（255 累加语义）', () => {
  // [帧数-1=1][帧1 size=3][3 字节][2 字节]
  const data = new Uint8Array([0x01, 0x03, 10, 11, 12, 20, 21]);
  const frames = splitBlockLacing(data, 0, 'xiph', true, 0);
  eq(frames?.length, 2, '2 帧');
  eq(frames?.[0]?.size, 3, '帧1 size 3');
  eq(frames?.[1]?.size, 2, '帧2 size 2（剩余）');
  eq(frames?.[0]?.offset, 2, '帧1 offset 2');
});

test('①i lacing EBML：3 帧（首帧 vint + signed diff）', () => {
  // [帧数-1=2][首帧 vint=0x83][diff=0xBF(=0)][3+3+3 字节]
  // 注意：1 字节 vint 必须高位为 1（0x80-0xFF）。写成 0x03 会被正确解析成 **7 字节** vint
  // ——这正是第一版用例失败的原因（实现是对的，数据不合 EBML 规范）。
  const data = new Uint8Array([0x02, 0x83, 0xbf, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const frames = splitBlockLacing(data, 0, 'ebml', true, 0);
  eq(frames?.length, 3, '3 帧');
  eq(frames?.[0]?.size, 3, '帧1 3 字节');
  eq(frames?.[1]?.size, 3, '帧2 3 字节（diff=0）');
  eq(frames?.[2]?.size, 3, '帧3 3 字节（剩余）');
});

test('①j lacing flags 位解析（bits 1-2）', () => {
  eq(lacingOf(0x00), 'none', 'bits=0 → none');
  eq(lacingOf(0x02), 'xiph', 'bits=1 → xiph');
  eq(lacingOf(0x04), 'fixed', 'bits=2 → fixed');
  eq(lacingOf(0x06), 'ebml', 'bits=3 → ebml');
});

/* ---------------- ② 四个真实素材 ---------------- */

const FIXTURES = 'tests/fixtures/compat';

async function openFixture(name) {
  const buffer = fs.readFileSync(path.join(ROOT, FIXTURES, name));
  return openWebm(new Blob([buffer]));
}

await testAsync('②a webm-vp9-opus：640×360 / 30fps / 120 帧 / vp9+opus', async () => {
  const result = await openFixture('webm-vp9-opus.webm');
  if (!result.ok) throw new Error(`解析失败 ${result.error.code}: ${result.error.message}`);
  const v = result.value;
  eq(v.container, 'webm', 'container');
  eq(v.width, 640, 'width');
  eq(v.height, 360, 'height');
  eq(v.fpsMilli, 30000, 'fpsMilli（毫帧率，不是 30）');
  eq(v.durationFrames, 120, '视频帧数');
  eq(v.videoCodec, 'vp09.00.10.08', 'videoCodec');
  eq(v.audioCodec, 'opus', 'audioCodec');
  eq(v.sampleRate, 48000, 'sampleRate');
  eq(v.audio?.sampleCount, 201, '音频样本数（与架构实测 201 一致）');
});

await testAsync('②b webm-vp8-vorbis：44.1kHz / 174 音频样本', async () => {
  const result = await openFixture('webm-vp8-vorbis.webm');
  if (!result.ok) throw new Error(`解析失败 ${result.error.code}`);
  const v = result.value;
  eq(v.videoCodec, 'vp8', 'videoCodec');
  eq(v.audioCodec, 'vorbis', 'audioCodec');
  eq(v.sampleRate, 44100, 'sampleRate');
  eq(v.audio?.sampleCount, 174, '音频样本数（架构实测 174）');
});

await testAsync('②c webm-nocues：无 Cues + 未知 size Segment + 无 Duration', async () => {
  const result = await openFixture('webm-nocues.webm');
  if (!result.ok) throw new Error(`解析失败 ${result.error.code}`);
  const v = result.value;
  eq(v.hasCues, false, '无 Cues');
  eq(v.durationMs, null, '无 Duration（null 合法）');
  eq(v.durationFrames, 120, '仍能扫出 120 帧（未知 size Segment 处理成功）');
  eq(v.needsIndexScan, true, 'needsIndexScan = true');
});

await testAsync('②d webm-longgop：240 帧 / 仅 1 个关键帧', async () => {
  const result = await openFixture('webm-longgop.webm');
  if (!result.ok) throw new Error(`解析失败 ${result.error.code}`);
  const v = result.value;
  eq(v.durationFrames, 240, '240 帧');
  eq(v.keyframeIndex?.length, 1, '长 GOP 只有 1 个关键帧');
});

await testAsync('②e 关键帧只取视频轨（音频 0x80 位不计入）', async () => {
  const result = await openFixture('webm-vp9-opus.webm');
  if (!result.ok) throw new Error(`解析失败`);
  const v = result.value;
  // 视频 4 个关键帧；若把音频 block 的 0x80 位混入会得到 174/201 个假关键帧
  eq(v.keyframeIndex?.length, 4, '关键帧数 4（不是 201）');
  // 音频样本 isKey 必须全 false
  const anyAudioKey = v.audio?.samples.some((sample) => sample.isKey) ?? false;
  eq(anyAudioKey, false, '音频样本 isKey 全为 false');
});

await testAsync('②f 视频样本按 presentation order 连续编号', async () => {
  const result = await openFixture('webm-vp9-opus.webm');
  if (!result.ok) throw new Error(`解析失败`);
  const samples = result.value.samples;
  for (let i = 0; i < samples.length; i += 1) {
    if (samples[i].index !== i) throw new Error(`样本 ${i} 的 index 应为 ${i}，实际 ${samples[i].index}`);
  }
  eq(samples.length, 120, '120 个视频样本');
  // PTS 单调不减
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i].ptsUs < samples[i - 1].ptsUs) throw new Error(`PTS 非单调 @${i}`);
  }
});

console.log(`\n✓ WebM 解封装单测：通过 ${passed} / ${passed + failures.length}`);
if (failures.length > 0) {
  console.log('失败用例：');
  for (const f of failures) console.log(`  - ${f.name} — ${f.message}`);
  process.exitCode = 1;
}