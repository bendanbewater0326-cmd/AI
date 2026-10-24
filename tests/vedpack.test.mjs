/**
 * .vedpack 工程打包单测：`unzipStore`（zip 往返/CRC/坏包）+ `vedpack.ts`
 * （收集三层来源/打包清单/解包校验/缺失降级）。
 *
 * 打包与解包全部用注入的假字节源（不碰 previewSource/IDB/OPFS）。
 * 运行：`node tests/vedpack.test.mjs`
 */
import { buildSync } from 'esbuild';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..');
const TMP_DIR = path.join(HERE, '.tmp');

function loadEntry(name, lines) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const entry = path.join(TMP_DIR, `${name}-entry.ts`);
  fs.writeFileSync(entry, lines.join('\n'), 'utf8');
  const outfile = path.join(TMP_DIR, `${name}-entry.mjs`);
  buildSync({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
  });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

const mod = await loadEntry('vedpack', [
  "export { createZip, unzipStore, crc32 } from '../../src/export/zip';",
  "export { buildVedpack, openVedpack, vedpackProjectText, collectAssetBytes, VEDPACK_MAX_BYTES } from '../../src/persist/vedpack';",
  "export { parseProjectFile } from '../../src/persist/projectFile';",
  "export { createProject, createAsset, createClip } from '../../src/core/types';",
]);

let passed = 0;
const failures = [];
const queue = [];
const section = (title) => queue.push({ title });
const test = (name, fn) => queue.push({ name, fn });
const eq = (actual, expected, label) => {
  assert.deepStrictEqual(actual, expected, `${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
};
const ok = (condition, label) => {
  if (condition !== true) throw new Error(`${label}：条件不成立`);
};

/** 假字节源：memory 里有 a1，cache 里有 a2，a3 三层全空（缺失）。 */
function fakeSource() {
  return {
    async readMemory(assetId) {
      if (assetId === 'a1') return new File([new Uint8Array([1, 2, 3, 4])], 'clip1.mp4');
      return null;
    },
    async readCache(assetId) {
      void assetId;
      if (assetId === 'a2') return new File([new Uint8Array([9, 9, 9])], 'music.mp3');
      return null;
    },
    async readHandle() {
      return null;
    },
  };
}

function makeDoc() {
  const project = mod.createProject({ width: 1280, height: 720, fpsMilli: 30000 });
  const a1 = mod.createAsset({ id: 'a1', name: 'clip1.mp4', kind: 'video', fpsMilli: 30000, durationFrames: 90, durationSec: 3, width: 1280, height: 720, hasAudio: true, container: 'mp4' });
  const a2 = mod.createAsset({ id: 'a2', name: 'music.mp3', kind: 'audio', fpsMilli: 30000, durationFrames: 60, durationSec: 2, width: 0, height: 0, hasAudio: true, container: 'unknown' });
  const a3 = mod.createAsset({ id: 'a3', name: 'gone.mp4', kind: 'video', fpsMilli: 30000, durationFrames: 30, durationSec: 1, width: 1280, height: 720, hasAudio: false, container: 'mp4' });
  const c1 = mod.createClip({ id: 'c1', assetId: 'a1', trackId: 'trk_V1', startFrame: 0, inFrame: 0, outFrame: 90, durationFrames: 90 });
  const tracks = project.tracks.map((track) => (track.id === 'trk_V1' ? { ...track, clips: [c1] } : track));
  return { ...project, name: '测试工程', assets: [a1, a2, a3], tracks };
}

/* ---------------- ① unzipStore ---------------- */

section('① unzipStore');

test('createZip → unzipStore 往返：条目与字节一致', () => {
  const entries = [
    { name: 'pack.json', data: new TextEncoder().encode('{"a":1}') },
    { name: 'assets/x1/视 频.mp4', data: new Uint8Array([1, 2, 254, 255]) },
  ];
  const zipped = mod.createZip(entries, { date: new Date(1700000000000) });
  const result = mod.unzipStore(zipped);
  ok(result.ok, '解包成功');
  if (!result.ok) return;
  eq([...result.entries.keys()].sort(), ['assets/x1/视 频.mp4', 'pack.json'], '条目名（含中文与空格）');
  eq([...(result.entries.get('assets/x1/视 频.mp4') ?? [])], [1, 2, 254, 255], '字节一致');
});

test('CRC 损坏 → corrupt 拒绝', () => {
  const zipped = mod.createZip([{ name: 'a.bin', data: new Uint8Array([1, 2, 3]) }]);
  zipped[40] = (zipped[40] ?? 0) ^ 0xff; // 破坏数据区
  const result = mod.unzipStore(zipped);
  ok(!result.ok && result.reason === 'corrupt', 'corrupt');
});

test('非 ZIP → not-zip', () => {
  const result = mod.unzipStore(new TextEncoder().encode('这不是一个zip文件'));
  ok(!result.ok && result.reason === 'not-zip', 'not-zip');
});

test('空 ZIP（零条目）→ ok 空表', () => {
  const result = mod.unzipStore(mod.createZip([]));
  ok(result.ok, 'ok');
  if (result.ok) eq(result.entries.size, 0, '空表');
});

/* ---------------- ② 打包与解包往返 ---------------- */

section('② 打包与解包');

test('buildVedpack：三层来源收集 + 缺失标记 + 包结构', async () => {
  const doc = makeDoc();
  const build = await mod.buildVedpack(doc, { source: fakeSource(), now: 1700000000000 });
  ok(build.ok, '打包成功');
  if (!build.ok) return;
  eq(build.value.missingNames, ['gone.mp4'], 'a3 缺失');
  eq(build.value.totalBytes, 4 + 3, '总字节（不含缺失）');
  eq(build.value.manifest.entries.a1.path, 'assets/a1/clip1.mp4', 'a1 路径');
  eq(build.value.manifest.entries.a3.missing, true, 'a3 标记 missing');

  // 解包回来
  const opened = await mod.openVedpack(build.value.blob);
  ok(opened.ok, '解包成功');
  if (!opened.ok) return;
  eq(opened.value.files.size, 2, '两个素材字节（缺失的不在）');
  eq(opened.value.files.get('a1')?.name, 'clip1.mp4', 'a1 文件名');
  eq(new Uint8Array(await (opened.value.files.get('a2')?.arrayBuffer() ?? new ArrayBuffer(0))), new Uint8Array([9, 9, 9]), 'a2 字节一致');
});

test('往返一致性：project.json 可被 parseProjectFile 还原（工程结构一字不差）', async () => {
  const doc = makeDoc();
  const build = await mod.buildVedpack(doc, { source: fakeSource(), now: 1700000000000 });
  if (!build.ok) throw new Error('打包失败');
  const text = await mod.vedpackProjectText(build.value.blob);
  ok(text.ok, '取工程文本');
  if (!text.ok) return;
  const parsed = mod.parseProjectFile(text.value);
  ok(parsed.ok, 'parseProjectFile 通过（与 .vedproj 同一条校验）');
  if (!parsed.ok) return;
  eq(parsed.value.name, '测试工程', '工程名');
  eq(parsed.value.assets.length, 3, '素材数');
  eq(parsed.value.assets.map((item) => item.id), ['a1', 'a2', 'a3'], 'assetId 保持（片段引用不漂移）');
  eq(parsed.value.tracks.flatMap((track) => track.clips).length, 1, '片段数');
});

test('坏文件 → 统一中文提示（用户拍板文案）', async () => {
  const notZip = new File([new TextEncoder().encode('随便什么内容')], 'x.vedpack');
  const result = await mod.openVedpack(notZip);
  ok(!result.ok, '拒绝');
  if (result.ok) return;
  eq(result.error.message, '该文件不是 veditor 工程包，请选择正确的 .vedpack 文件', '中文提示');
});

test('缺 project.json 的 zip → 同款中文提示', async () => {
  const zipped = mod.createZip([{ name: 'pack.json', data: new TextEncoder().encode('{}') }]);
  const result = await mod.openVedpack(new Blob([zipped]));
  ok(!result.ok, '拒绝');
  if (result.ok) return;
  eq(result.error.message, '该文件不是 veditor 工程包，请选择正确的 .vedpack 文件', '中文提示');
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
  console.log(`✓ 工程打包单测：通过 ${passed} / ${passed}`);
  process.exit(0);
} else {
  console.log(`✗ 工程打包单测：${failures.length} 项失败`);
  for (const item of failures) console.log(`  - ${item.name}：${item.message}`);
  process.exit(1);
}
