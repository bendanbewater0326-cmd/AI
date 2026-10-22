/**
 * 时间码解析/格式化单测（T13 ②③ / R-030）。
 *
 * 运行：`node tests/timecode.test.mjs`
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

// TopBar.tsx 顶层 import 了 React + store，bundle 时一并打进产物即可（能跑，体积无所谓）
const tb = await loadTsModule('src/ui/TopBar.tsx', 'topbar');
const { formatTimecode, parseTimecode } = tb;

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

/* ---------------- 格式（T13 ②） ---------------- */

test('② format：HH:MM:SS:FF 四段', () => {
  eq(formatTimecode(150, 30000), '00:00:05:00', '150 帧 @30fps = 00:00:05:00');
  eq(formatTimecode(0, 30000), '00:00:00:00', '0 帧');
  eq(formatTimecode(137, 30000), '00:00:04:17', '137 帧 = 4 秒 17 帧');
});

test('② format：非 30fps 基数', () => {
  eq(formatTimecode(150, 29970), '00:00:05:00', '29970 → 基数 30');
  eq(formatTimecode(137, 23976), '00:00:05:17', '23976 → 基数 24，137 = 5×24+17');
});

/* ---------------- 解析（T13 ③ / R-030） ---------------- */

test('③ parse：完整 HH:MM:SS:FF', () => {
  eq(parseTimecode('00:00:05:00', 30000), 150, 'HH:MM:SS:FF');
});

test('③ parse：省略高位', () => {
  eq(parseTimecode('05:00', 30000), 150, 'SS:FF → 150');
  eq(parseTimecode('00:05:00', 30000), 150, 'MM:SS:FF → 150');
  eq(parseTimecode('150', 30000), 150, '纯帧数 → 150');
});

test('③ parse：往返一致', () => {
  for (const f of [0, 1, 29, 30, 137, 3599, 3600 * 24 + 137]) {
    eq(parseTimecode(formatTimecode(f, 30000), 30000), f, `往返 frame=${f}`);
  }
});

test('③ parse：非法输入返回 null（R-030）', () => {
  eq(parseTimecode('abc', 30000), null, '非数字');
  eq(parseTimecode('', 30000), null, '空串');
  eq(parseTimecode('99:99', 30000), null, '分钟 ≥ 60');
  eq(parseTimecode('00:00:00:30', 30000), null, 'FF ≥ 基数 30');
  eq(parseTimecode('1:2:3:4:5', 30000), null, '段数 > 4');
});

console.log(`\n✓ 时间码解析/格式化：通过 ${passed} / ${passed + failures.length}`);
if (failures.length > 0) {
  console.log('失败用例：');
  for (const f of failures) console.log(`  - ${f.name} — ${f.message}`);
  process.exitCode = 1;
}
