/**
 * MP3 解析单测：`media/demuxMp3.ts`（程序化构造 MP3 帧字节，不依赖 fixture）。
 *
 * 覆盖：
 *   ① parseMp3FrameHeader：MPEG1/2 帧头、padding、非同步字、保留版本/码率
 *   ② openMp3：CBR 索引（1 秒粒度 ptsUs 单调）、ID3v2 跳过、VBR（逐帧帧长）、
 *      中途变采样率容错丢弃、截断文件、0 帧报错、丢弃字节统计
 *
 * 运行：`node tests/demuxMp3.test.mjs`
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

const mp3 = await loadTsModule('src/media/demuxMp3.ts', 'demuxMp3');

/** 构造一帧 MP3 字节：4 字节合法帧头 + size-4 字节伪数据（不含 0xFF 同步字）。 */
function frame({ versionBits = 3, bitrateIndex = 9, rateIndex = 0, padding = 0, channelMode = 0, size } = {}) {
  // MPEG1/L3 128kbps 44100Hz：144*128000/44100 ≈ 417.9 → 417 + padding
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = 0xe0 | ((versionBits & 0x03) << 3) | (1 << 1); // sync + version + Layer3
  header[2] = ((bitrateIndex & 0x0f) << 4) | ((rateIndex & 0x03) << 2) | ((padding & 0x01) << 1) | 0;
  header[3] = ((channelMode & 0x03) << 6) | 0x00;
  if (size === undefined) {
    // versionBits 保留（1）时查表无意义：调用方必须显式给 size
    const bitrateKbps = { 3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], 1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 288, 320] }[versionBits]?.[bitrateIndex];
    const sampleRate = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 1: [44100, 48000, 32000], 0: [11025, 12000, 8000] }[versionBits]?.[rateIndex];
    if (bitrateKbps === undefined || sampleRate === undefined) throw new Error(`不支持的测试参数：versionBits=${versionBits}`);
    const coefficient = versionBits === 3 ? 144 : 72;
    size = Math.floor((coefficient * bitrateKbps * 1000) / sampleRate) + padding;
  }
  const payload = Buffer.alloc(size - 4, 0x33); // 0x33 不构成同步字
  return Buffer.concat([header, payload]);
}

/** 假 BlobLike。 */
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

/* ---------------- ① parseMp3FrameHeader ---------------- */

section('① parseMp3FrameHeader');

test('MPEG1 L3 128kbps 44100Hz 无 padding → 417 字节、1152 采样、立体声', () => {
  const header = mp3.parseMp3FrameHeader(new Uint8Array(frame({ versionBits: 3, bitrateIndex: 9, rateIndex: 0 })), 0);
  eq(header?.frameLength, 417, '帧长');
  eq(header?.samplesPerFrame, 1152, '采样数');
  eq(header?.sampleRate, 44100, '采样率');
  eq(header?.channels, 2, '声道');
});

test('padding +1 → 帧长 +1', () => {
  const noPad = mp3.parseMp3FrameHeader(new Uint8Array(frame({ versionBits: 3, bitrateIndex: 9, rateIndex: 0, padding: 0 })), 0);
  const padded = mp3.parseMp3FrameHeader(new Uint8Array(frame({ versionBits: 3, bitrateIndex: 9, rateIndex: 0, padding: 1 })), 0);
  eq(padded.frameLength - noPad.frameLength, 1, '差 1');
});

test('非同步字 / 保留版本 / 保留码率 → null', () => {
  eq(mp3.parseMp3FrameHeader(new Uint8Array(Buffer.from([0x12, 0x34, 0x00, 0x00])), 0), null, '非同步字');
  eq(
    mp3.parseMp3FrameHeader(new Uint8Array(frame({ versionBits: 1, bitrateIndex: 9, rateIndex: 0 })), 0),
    null,
    '保留版本',
  );
  // 保留码率（15）：手动构造头（helper 查表会拒绝这个组合）
  const reservedHeader = Buffer.alloc(4);
  reservedHeader[0] = 0xff;
  reservedHeader[1] = 0xe0 | (3 << 3) | (1 << 1);
  reservedHeader[2] = (15 << 4) | (0 << 2);
  reservedHeader[3] = 0x00;
  eq(mp3.parseMp3FrameHeader(new Uint8Array(reservedHeader), 0), null, '保留码率');
});

/* ---------------- ② openMp3：CBR / ID3 / 容错 ---------------- */

section('② openMp3');

test('CBR：索引逐帧、ptsUs 按 1152 采样单调、声道/时长正确', async () => {
  const buffer = Buffer.concat(Array.from({ length: 20 }, () => frame({ versionBits: 3, bitrateIndex: 9, rateIndex: 0 })));
  const result = await mp3.openMp3(fakeBlob(buffer));
  eq(result.ok, true, 'open ok');
  if (!result.ok) return;
  const probe = result.value;
  eq(probe.container, 'mp3', 'container');
  eq(probe.audioCodec, 'mp3', 'codec');
  eq(probe.audio.samples.length, 20, '20 帧索引');
  eq(probe.audio.sampleRate, 44100, '采样率');
  eq(probe.audio.channels, 2, '声道');
  eq(probe.durationSec > 0, true, '时长 > 0');
  // ptsUs 单调：第 n 帧起点 = n × 1152 采样
  const first = probe.audio.samples[0];
  const second = probe.audio.samples[1];
  eq(second.ptsUs - first.ptsUs, Math.round((1152 / 44100) * 1_000_000 * 1e6) / 1e6 === 0 ? 26122 : 26122, '帧间隔 ≈ 26.1ms');
  for (let index = 1; index < probe.audio.samples.length; index += 1) {
    if (probe.audio.samples[index].ptsUs <= probe.audio.samples[index - 1].ptsUs) {
      throw new Error(`ptsUs 非单调 @ ${index}`);
    }
  }
});

test('ID3v2 头被跳过（丢弃不计入 droppedBytes）', async () => {
  const id3 = Buffer.alloc(10 + 100);
  id3.write('ID3', 0, 'latin1');
  id3[5] = 3; // 版本
  id3[6] = 0; id3[7] = 0; id3[8] = 0; id3[9] = 100; // syncsafe 100
  const buffer = Buffer.concat([id3, ...Array.from({ length: 5 }, () => frame({ versionBits: 3, bitrateIndex: 9, rateIndex: 0 }))]);
  const result = await mp3.openMp3(fakeBlob(buffer));
  eq(result.ok, true, 'open ok');
  if (!result.ok) return;
  eq(result.value.audio.samples.length, 5, '5 帧');
  eq(result.value.audio.droppedBytes, 0, '无丢弃');
});

test('VBR（逐帧不同码率）→ 帧长逐帧各自计算', async () => {
  const buffer = Buffer.concat([
    frame({ versionBits: 3, bitrateIndex: 9, rateIndex: 0 }), // 128k → 417
    frame({ versionBits: 3, bitrateIndex: 5, rateIndex: 0 }), // 64k → 208（144*64000/44100=208.9→208）
    frame({ versionBits: 3, bitrateIndex: 9, rateIndex: 0 }),
  ]);
  const result = await mp3.openMp3(fakeBlob(buffer));
  eq(result.ok, true, 'open ok');
  if (!result.ok) return;
  const samples = result.value.audio.samples;
  eq(samples.length, 3, '3 帧');
  eq(samples[0].size, 417, '128k 帧');
  eq(samples[1].size, 208, '64k 帧');
});

test('中途垃圾字节 → 容错丢弃并计数（帧数不减）', async () => {
  const junk = Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44]);
  const buffer = Buffer.concat([
    frame({ versionBits: 3, bitrateIndex: 9, rateIndex: 0 }),
    junk,
    frame({ versionBits: 3, bitrateIndex: 9, rateIndex: 0 }),
  ]);
  const result = await mp3.openMp3(fakeBlob(buffer));
  eq(result.ok, true, 'open ok');
  if (!result.ok) return;
  eq(result.value.audio.samples.length, 2, '2 帧');
  eq(result.value.audio.droppedBytes, junk.length, `丢弃 ${junk.length} 字节`);
});

test('中途变采样率 → 按损坏容错丢弃后续', async () => {
  const buffer = Buffer.concat([
    frame({ versionBits: 3, bitrateIndex: 9, rateIndex: 0 }),
    frame({ versionBits: 2, bitrateIndex: 8, rateIndex: 0 }), // MPEG2 22050Hz ≠ 首帧
  ]);
  const result = await mp3.openMp3(fakeBlob(buffer));
  eq(result.ok, true, 'open ok');
  if (!result.ok) return;
  eq(result.value.audio.samples.length, 1, '只保留首帧');
  eq(result.value.audio.droppedBytes > 0, true, '有丢弃');
});

test('截断文件（帧头声明帧长超出剩余字节）→ 容错或报错，不抛异常', async () => {
  const full = frame({ versionBits: 3, bitrateIndex: 9, rateIndex: 0 });
  const truncated = full.subarray(0, 10); // 头声称 417 字节，只剩 10
  const result = await mp3.openMp3(fakeBlob(Buffer.concat([full, truncated])));
  // 截断帧在尾帧解析中 frameLength 超界 → 逐字节丢弃到尾 → 1 帧 + dropped
  eq(result.ok, true, 'open ok');
  if (!result.ok) return;
  eq(result.value.audio.samples.length, 1, '完整帧保留');
});

test('0 帧 → 中文报错', async () => {
  const result = await mp3.openMp3(fakeBlob(Buffer.from([0x00, 0x01, 0x02, 0x03])));
  eq(result.ok, false, '失败');
  eq(result.error.message.includes('MP3'), true, '中文报错');
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
  console.log(`✓ MP3 解析单测：通过 ${passed} / ${passed}`);
  process.exit(0);
} else {
  console.log(`✗ MP3 解析单测：${failures.length} 项失败`);
  for (const item of failures) console.log(`  - ${item.name}：${item.message}`);
  process.exit(1);
}
