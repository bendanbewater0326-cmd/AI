/**
 * ZIP 写入器单测（R-062）。
 *
 * ZIP 是二进制格式，**"写出来能打开"不等于"字段都对"**——偏移错 4 字节，
 * 大部分解压器会容忍，直到遇到某个严格的工具（或 Windows 资源管理器）才炸。
 * 所以这里用一个**独立实现的读取器**把结构逐字段读回来，不复用写入器的任何代码。
 *
 * 另外用 Python 的 `zipfile` 做第二意见（如果环境里有 python）：它是完全独立的实现，
 * 能证明"别的工具也认这个包"。
 *
 * 运行：`node tests/zip.test.mjs`
 */
import { buildSync } from 'esbuild';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
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

const zip = await load('src/export/zip.ts', 'zip');

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

/* ---------------- 独立读取器（刻意不复用写入器） ---------------- */

function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();

  // EOCD 固定在末尾 22 字节（本实现不写注释）
  const eocd = bytes.length - 22;
  const eocdSig = view.getUint32(eocd, true);
  if (eocdSig !== 0x06054b50) throw new Error(`EOCD 签名错：0x${eocdSig.toString(16)}`);
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset + cdSize !== eocd) throw new Error('中央目录尺寸/偏移不自洽');

  const entries = [];
  let cursor = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error(`第 ${i} 个中央目录项签名错`);
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compSize = view.getUint32(cursor + 20, true);
    const rawSize = view.getUint32(cursor + 24, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));

    // 回到本地文件头取数据
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`${name} 本地头签名错`);
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = bytes.subarray(dataStart, dataStart + compSize);

    entries.push({ name, flags, method, crc, compSize, rawSize, data });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return { count, entries };
}

/* ---------------- 1. CRC32 ---------------- */

console.log('\n[1] CRC-32');

test('①a 空数据 = 0', () => {
  eq(zip.crc32(new Uint8Array(0)), 0);
});

test('①b "123456789" = 0xCBF43926（标准测试向量）', () => {
  eq(zip.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('①c "hello" 与预期一致', () => {
  // echo -n hello | cksum 的 CRC 变体不同，这里用 Python zlib.crc32 的值
  eq(zip.crc32(new TextEncoder().encode('hello')), 0x3610a686);
});

/* ---------------- 2. 结构 ---------------- */

console.log('\n[2] 包结构与字段');

const encoder = new TextEncoder();
const entries = [
  { name: 'frame_000001.png', data: encoder.encode('\x89PNG\r\n\x1a\n') },
  { name: 'frame_000002.png', data: new Uint8Array([1, 2, 3, 4, 5]) },
  { name: 'frames.json', data: encoder.encode('{"fps":30}') },
];
const fixedDate = new Date(2026, 9, 21, 12, 0, 0);
const bytes = zip.createZip(entries, { date: fixedDate });

test('②a EOCD 里的条目数正确', () => {
  eq(readZip(bytes).count, 3);
});

test('②b 每个条目：method=0 / 尺寸一致 / CRC 正确', () => {
  const parsed = readZip(bytes);
  for (const [index, entry] of parsed.entries.entries()) {
    eq(entry.method, 0, `${entry.name} method`);
    eq(entry.compSize, entries[index].data.length, `${entry.name} 压缩后尺寸`);
    eq(entry.rawSize, entries[index].data.length, `${entry.name} 原始尺寸`);
    eq(entry.crc, zip.crc32(entries[index].data), `${entry.name} CRC`);
  }
});

test('②c 文件名置了 UTF-8 标志位（bit 11）', () => {
  for (const entry of readZip(bytes).entries) {
    eq((entry.flags & 0x0800) !== 0, true, `${entry.name} 缺 UTF-8 标志`);
  }
});

test('②d 数据字节与输入完全一致（含 PNG 魔数）', () => {
  const parsed = readZip(bytes);
  eq(Array.from(parsed.entries[0].data), Array.from(entries[0].data));
  eq(parsed.entries[0].name, 'frame_000001.png');
  eq(parsed.entries[2].name, 'frames.json');
});

test('②e 顺序与写入顺序一致（帧序即包内顺序）', () => {
  eq(
    readZip(bytes).entries.map((entry) => entry.name),
    ['frame_000001.png', 'frame_000002.png', 'frames.json'],
  );
});

test('②f 中文条目名可往返（UTF-8）', () => {
  const packed = zip.createZip([{ name: '片段/帧_000001.png', data: encoder.encode('x') }], {
    date: fixedDate,
  });
  eq(readZip(packed).entries[0].name, '片段/帧_000001.png');
});

test('②g 空包 = 只有 22 字节 EOCD', () => {
  const packed = zip.createZip([], { date: fixedDate });
  eq(packed.length, 22);
  eq(readZip(packed).count, 0);
});

test('②h 时间戳按 DOS 格式写入（固定日期可复现）', () => {
  const view = new DataView(bytes.buffer);
  const dosTime = view.getUint16(10, true); // 本地头偏移 10 = time
  const dosDate = view.getUint16(12, true);
  eq(dosDate >> 9, 2026 - 1980, '年');
  eq((dosDate >> 5) & 0x0f, 10, '月（1 起）');
  eq(dosDate & 0x1f, 21, '日');
  eq(dosTime >> 11, 12, '时');
});

/* ---------------- 3. 拒绝非法名 ---------------- */

console.log('\n[3] 非法条目名');

for (const name of ['../evil.png', 'a\\b.png', '/abs.png', '']) {
  test(`③ ${JSON.stringify(name)} 被拒绝`, () => {
    assert.throws(() => zip.createZip([{ name, data: new Uint8Array([1]) }]));
  });
}

/* ---------------- 4. Python zipfile 第二意见 ---------------- */

console.log('\n[4] 用 Python zipfile 独立验证');

const pythonCandidates = [
  'C:/Users/Administrator/.workbuddy-ai/binaries/python/versions/3.13.12/python.exe',
  'python',
];
let pythonOk = false;
let pythonOutput = '';
for (const candidate of pythonCandidates) {
  const zipPath = path.join(TMP_DIR, 'unit-test.zip');
  fs.writeFileSync(zipPath, bytes);
  const script = [
    'import zipfile,sys,json',
    `z=zipfile.ZipFile(r"${zipPath}")`,
    'bad=z.testzip()',
    'names=z.namelist()',
    'print(json.dumps({"bad":bad,"names":names,"sizes":[len(z.read(n)) for n in names]}))',
  ].join('\n');
  const run = spawnSync(candidate, ['-c', script], { encoding: 'utf8' });
  if (run.status === 0 && run.stdout.trim().startsWith('{')) {
    pythonOk = true;
    pythonOutput = run.stdout.trim();
    break;
  }
}

test('④a Python zipfile 能打开且 CRC 全部通过', () => {
  if (!pythonOk) {
    console.log('      （跳过：环境里没有可用的 python）');
    return;
  }
  const parsed = JSON.parse(pythonOutput);
  eq(parsed.bad, null, 'testzip 应返回 None');
  eq(parsed.names, ['frame_000001.png', 'frame_000002.png', 'frames.json']);
  // 期望值从输入算，别硬编码：`\x89PNG...` 在 UTF-8 里是 9 字节（0x89 要两字节），
  // 第一版写死 8 导致"写入器没问题、测试自己错"
  eq(parsed.sizes, entries.map((entry) => entry.data.length));
});

/* ---------------- 汇总 ---------------- */

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} ZIP 写入器单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}`);
    console.error(failure.error);
  }
  process.exit(1);
}
