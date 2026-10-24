/**
 * WAV 解析单测：`media/demuxWav.ts`（纯函数 + openWav 用假 BlobLike）。
 *
 * 覆盖：
 *   ① parseWavFormat：PCM 16/24/32/8、f32、extensible（0xFFFE）子格式、非 PCM 拒绝
 *   ② pcmChunkToPlanarF32：**字节级**比对（16 位满幅/立体声去交错/f32 原样）
 *   ③ openWav：chunk 遍历（跳过 LIST）、样本索引（1 秒一块、ptsUs 单调）、
 *      非 PCM 中文提示、截断文件、fmt 缺失
 *
 * 运行：`node tests/demuxWav.test.mjs`
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

const wav = await loadTsModule('src/media/demuxWav.ts', 'demuxWav');

/* ---------------- WAV 字节构造工具（程序化，不依赖 fixture） ---------------- */

/** 构造一段 WAV 字节：chunks = [['fmt ', payload], ['LIST', ...], ['data', ...]]。 */
function buildWav({ channels = 2, sampleRate = 44100, bits = 16, isFloat = false, samples, extraChunks = [], formatCode } = {}) {
  const bytesPerSample = bits / 8;
  const frames = samples.length;
  const bytesPerFrame = channels * bytesPerSample;
  const data = Buffer.alloc(frames * bytesPerFrame);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = samples[frame][channel];
      const offset = (frame * channels + channel) * bytesPerSample;
      if (isFloat && bits === 32) data.writeFloatLE(value, offset);
      else if (bits === 8) data.writeUInt8(Math.max(0, Math.min(255, Math.round(value * 128 + 128))), offset);
      else if (bits === 16) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32767))), offset);
      else if (bits === 24) {
        const raw = Math.max(-8388608, Math.min(8388607, Math.round(value * 8388607)));
        data.writeUInt8(raw & 0xff, offset);
        data.writeUInt8((raw >> 8) & 0xff, offset + 1);
        data.writeUInt8((raw >> 16) & 0xff, offset + 2);
      } else if (bits === 32) data.writeInt32LE(Math.max(-2147483648, Math.min(2147483647, Math.round(value * 2147483647))), offset);
    }
  }
  const fmtCode = formatCode ?? (isFloat ? 3 : 1);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(fmtCode, 0);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(bytesPerFrame * sampleRate, 8);
  fmt.writeUInt16LE(bytesPerFrame, 12);
  fmt.writeUInt16LE(bits, 14);
  const chunks = [['fmt ', fmt], ...extraChunks, ['data', data]];
  let body = Buffer.alloc(0);
  for (const [id, payload] of chunks) {
    const header = Buffer.alloc(8);
    header.write(id, 0, 'latin1');
    header.writeUInt32LE(payload.length, 4);
    const pad = payload.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0);
    body = Buffer.concat([body, header, payload, pad]);
  }
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(4 + body.length, 4);
  riff.write('WAVE', 8, 'latin1');
  return Buffer.concat([riff, body]);
}

/** 假 BlobLike（buffer 上的 slice/arrayBuffer）。 */
function fakeBlob(buffer) {
  return {
    size: buffer.length,
    slice(start = 0, end = buffer.length) {
      const sliced = buffer.subarray(start, end);
      return {
        arrayBuffer: async () => sliced.buffer.slice(sliced.byteOffset, sliced.byteOffset + sliced.byteLength),
      };
    },
  };
}

let passed = 0;
const failures = [];
const queue = [];
const section = (title) => queue.push({ title });
const test = (name, fn) => queue.push({ name, fn });
const eq = (actual, expected, label) => {
  if (!Object.is(actual, expected)) throw new Error(`${label}：期望 ${String(expected)}，实际 ${String(actual)}`);
};

/* ---------------- ① parseWavFormat ---------------- */

section('① parseWavFormat');

test('PCM 16bit 立体声', () => {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(2, 2);
  fmt.writeUInt32LE(44100, 4);
  fmt.writeUInt16LE(16, 14);
  const info = wav.parseWavFormat(fmt);
  eq(info?.codec, 'pcm-s16', 'codec');
  eq(info?.channels, 2, 'channels');
  eq(info?.sampleRate, 44100, 'rate');
  eq(info?.bytesPerSample, 2, 'bytes');
});

test('IEEE float 32bit → pcm-f32', () => {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(3, 0);
  fmt.writeUInt16LE(2, 2);
  fmt.writeUInt32LE(48000, 4);
  fmt.writeUInt16LE(32, 14);
  eq(wav.parseWavFormat(fmt)?.codec, 'pcm-f32', 'codec');
});

test('WAVE_FORMAT_EXTENSIBLE 按 SubFormat 判定（0xFFFE + PCM GUID）', () => {
  const fmt = Buffer.alloc(40);
  fmt.writeUInt16LE(0xfffe, 0);
  fmt.writeUInt16LE(2, 2);
  fmt.writeUInt32LE(44100, 4);
  fmt.writeUInt16LE(24, 14);
  fmt.writeUInt16LE(1, 24); // SubFormat 前 2 字节 = PCM
  const info = wav.parseWavFormat(fmt);
  eq(info?.codec, 'pcm-s24', 'extensible PCM 24bit');
});

test('非 PCM（ADPCM 2）→ null（中文拒绝文案）', () => {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(2, 0);
  eq(wav.parseWavFormat(fmt), null, 'ADPCM');
  eq(wav.WAV_NON_PCM_MESSAGE.includes('压缩格式'), true, '文案');
});

/* ---------------- ② pcmChunkToPlanarF32 字节级 ---------------- */

section('② pcmChunkToPlanarF32 字节级');

test('16 位立体声：去交错 + 满幅归一（字节级比对）', () => {
  const bytes = Buffer.alloc(8); // 2 帧 × 2 声道 × 2 字节
  bytes.writeInt16LE(32767, 0); // L0 = +1.0
  bytes.writeInt16LE(-16384, 2); // R0 = -0.5
  bytes.writeInt16LE(0, 4); // L1 = 0
  bytes.writeInt16LE(16384, 6); // R1 = +0.5
  const planes = wav.pcmChunkToPlanarF32(new Uint8Array(bytes), { bytesPerSample: 2, isFloat: false, channels: 2 });
  eq(planes.length, 2, '平面数');
  eq(planes[0][0], 32767 / 32768, 'L0');
  eq(planes[0][1], 0, 'L1');
  eq(planes[1][0], -16384 / 32768, 'R0');
  eq(planes[1][1], 16384 / 32768, 'R1');
});

test('32 位 float 原样直通', () => {
  const bytes = Buffer.alloc(8);
  bytes.writeFloatLE(0.25, 0);
  bytes.writeFloatLE(-0.75, 4);
  const planes = wav.pcmChunkToPlanarF32(new Uint8Array(bytes), { bytesPerSample: 4, isFloat: true, channels: 1 });
  eq(planes[0][0], 0.25, 'f0');
  eq(planes[0][1], -0.75, 'f1');
});

test('8 位无符号（中心 128）', () => {
  const bytes = Buffer.from([128, 255]);
  const planes = wav.pcmChunkToPlanarF32(new Uint8Array(bytes), { bytesPerSample: 1, isFloat: false, channels: 1 });
  eq(planes[0][0], 0, '中心');
  eq(planes[0][1], 127 / 128, '满幅');
});

/* ---------------- ③ openWav ---------------- */

section('③ openWav');

test('正常 WAV：样本索引 1 秒一块、ptsUs 单调、时长正确', async () => {
  // 1.5 秒 × 8000Hz 单声道 16bit = 12000 帧 → 2 块（8000 + 4000）
  const samples = Array.from({ length: 12000 }, (_, index) => [Math.sin(index / 10), 0]);
  const buffer = buildWav({ channels: 1, sampleRate: 8000, bits: 16, samples });
  const result = await wav.openWav(fakeBlob(buffer));
  eq(result.ok, true, 'open ok');
  if (!result.ok) return;
  const probe = result.value;
  eq(probe.hasVideo, false, '无视频');
  eq(probe.hasAudio, true, '有音频');
  eq(probe.audioCodec, 'pcm-s16', 'codec');
  eq(probe.sampleRate, 8000, 'rate');
  eq(probe.channels, 1, 'channels');
  eq(probe.durationSec, 1.5, '时长');
  eq(probe.audio.samples.length, 2, '1 秒一块 → 2 条索引');
  const first = probe.audio.samples[0];
  const second = probe.audio.samples[1];
  eq(first.size, 8000 * 2, '首块字节');
  eq(second.size, 4000 * 2, '次块字节');
  eq(second.ptsUs > first.ptsUs, true, 'ptsUs 单调');
  eq(probe.durationFrames, 45, '时基帧数（1.5s × 30）');
});

test('带 LIST 附加 chunk 的真实 WAV 也能解析（chunk 遍历跳过）', async () => {
  const samples = Array.from({ length: 8000 }, (_, index) => [Math.sin(index / 10), 0]); // 1s
  const list = Buffer.from('INFOhello');
  const buffer = buildWav({ channels: 1, sampleRate: 8000, bits: 16, samples, extraChunks: [['LIST', list]] });
  const result = await wav.openWav(fakeBlob(buffer));
  eq(result.ok, true, 'open ok');
  if (!result.ok) return;
  eq(result.value.durationSec, 1, '时长');
  eq(result.value.audio.samples[0].offset > 12 + 8 + 16 + 8 + list.length, true, 'data 偏移跳过了 LIST');
});

test('非 PCM → 中文拒绝文案', async () => {
  const buffer = buildWav({ channels: 1, sampleRate: 8000, bits: 16, samples: [[0, 0]], formatCode: 2 });
  const result = await wav.openWav(fakeBlob(buffer));
  eq(result.ok, false, '失败');
  eq(result.error.message, wav.WAV_NON_PCM_MESSAGE, '文案');
});

test('截断文件（无 data chunk）→ 可读报错', async () => {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2); // channels
  fmt.writeUInt32LE(8000, 4); // rate
  fmt.writeUInt16LE(16, 14); // bits（缺 bits 会被判为非 PCM）
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.write('WAVE', 8, 'latin1');
  const result = await wav.openWav(fakeBlob(Buffer.concat([header, Buffer.from('fmt '), Buffer.from([16, 0, 0, 0]), fmt])));
  eq(result.ok, false, '失败');
  eq(result.error.message.includes('data'), true, '报错提到缺 data');
});

/* ---------------- 顺序执行 + 汇总 ---------------- */

for (const item of queue) {
  if (item.title !== undefined) {
    console.log(item.title);
    continue;
  }
  try {
    await item.fn();
    passed += 1;
    console.log(`  ✓ ${item.name}`);
  } catch (error) {
    failures.push({ name: item.name, message: error instanceof Error ? error.message : String(error) });
    console.log(`  ✗ ${item.name}`);
    console.log(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log('');
if (failures.length === 0) {
  console.log(`✓ WAV 解析单测：通过 ${passed} / ${passed}`);
  process.exit(0);
} else {
  console.log(`✗ WAV 解析单测：${failures.length} 项失败`);
  for (const item of failures) console.log(`  - ${item.name}：${item.message}`);
  process.exit(1);
}
