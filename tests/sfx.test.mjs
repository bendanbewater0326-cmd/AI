/**
 * 内置音效库（音频面板 A1）单测：`ui/audio/sfxLibrary`（数据层）+ `core/operations.applyFirstAssetParams` 修复。
 *
 * 覆盖：
 *   ① 预设表完整性：10 个、id/名称/文件名唯一、全中文、分类合法且三个分类都有内容
 *   ② dataUrlToBytes：解码正确 / 无 base64 段返回空
 *   ③ hashKey：格式确定、字节非空且量级正确
 *   ④ ensureSfxAsset：已有同 hashKey 复用不导入 / 无则导入一次 / 导入失败透传 / 并发合并
 *   ⑤ applyFirstAssetParams：纯音频不跟随（修复回归）/ 视频跟随 / 已有资产不跟随
 *
 * 运行：`node tests/sfx.test.mjs`
 */
import { buildSync } from 'esbuild';
import assert from 'node:assert';
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
    // 与 scripts/build.mjs 同一份口径：音效源文件内联成 data URL
    loader: { '.m4a': 'dataurl' },
    logLevel: 'silent',
  });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

const sfx = await loadTsModule('src/ui/audio/sfxLibrary.ts', 'sfxLibrary');
const operations = await loadTsModule('src/core/operations.ts', 'operations');

let passed = 0;
const failures = [];
const queue = [];

/** 先登记后执行：同步/异步用例统一走一个顺序 runner（异步失败不能被吞）。 */
function section(title) {
  queue.push({ title });
}
function test(name, fn) {
  queue.push({ name, fn });
}

function eq(actual, expected, label) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${label}：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
}

/* ---------------- ① 预设表完整性 ---------------- */

section('① 预设表完整性');

test('共 10 个预设', () => {
  eq(sfx.SFX_PRESETS.length, 10, '数量');
});

test('id / 显示名 / 文件名各自唯一', () => {
  const ids = new Set(sfx.SFX_PRESETS.map((p) => p.id));
  const names = new Set(sfx.SFX_PRESETS.map((p) => p.name));
  const files = new Set(sfx.SFX_PRESETS.map((p) => p.fileName));
  eq(ids.size, sfx.SFX_PRESETS.length, 'id 唯一');
  eq(names.size, sfx.SFX_PRESETS.length, '名称唯一');
  eq(files.size, sfx.SFX_PRESETS.length, '文件名唯一');
});

test('名称全中文、文件名带「音效·」前缀', () => {
  for (const preset of sfx.SFX_PRESETS) {
    if (!/^[\u4e00-\u9fa5·]+$/.test(preset.name)) throw new Error(`${preset.id} 名称含非中文：${preset.name}`);
    if (!preset.fileName.startsWith('音效·')) throw new Error(`${preset.id} 文件名缺前缀：${preset.fileName}`);
    if (!preset.fileName.endsWith('.m4a')) throw new Error(`${preset.id} 文件名后缀不对：${preset.fileName}`);
  }
});

test('分类合法且三个分类都有内容', () => {
  const valid = ['cue', 'transition', 'ambience'];
  for (const preset of sfx.SFX_PRESETS) {
    if (!valid.includes(preset.category)) throw new Error(`${preset.id} 分类非法：${preset.category}`);
  }
  for (const key of valid) {
    const count = sfx.SFX_PRESETS.filter((p) => p.category === key).length;
    if (count === 0) throw new Error(`分类 ${key} 没有任何内容`);
  }
});

test('时长在 0.1–3 秒、dataUrl 是内联的 base64', () => {
  for (const preset of sfx.SFX_PRESETS) {
    if (!(preset.seconds > 0.1 && preset.seconds < 3)) throw new Error(`${preset.id} 时长异常：${preset.seconds}`);
    if (!preset.dataUrl.startsWith('data:')) throw new Error(`${preset.id} dataUrl 不是 data URL`);
    if (!preset.dataUrl.includes('base64,')) throw new Error(`${preset.id} dataUrl 没有 base64 段`);
  }
});

test('sfxPresetById 能找回；未知 id 返回 null', () => {
  eq(sfx.sfxPresetById('ding')?.name, '叮', 'ding');
  eq(sfx.sfxPresetById('no-such'), null, '未知 id');
});

/* ---------------- ② dataUrlToBytes ---------------- */

section('② dataUrlToBytes');

test('解码已知样本', () => {
  const bytes = sfx.dataUrlToBytes('data:audio/mp4;base64,AQID');
  eq(bytes.length, 3, '长度');
  eq(bytes[0], 1, '首字节');
  eq(bytes[2], 3, '末字节');
});

test('没有 base64 段返回空（不抛）', () => {
  eq(sfx.dataUrlToBytes('data:audio/mp4,raw').length, 0, '空');
});

/* ---------------- ③ hashKey 与真实内联字节 ---------------- */

section('③ hashKey');

test('格式 = 文件名|字节数|0（lastModified 固定 0）', () => {
  const preset = sfx.SFX_PRESETS[0];
  eq(sfx.sfxHashKey(preset), `${preset.fileName}|${sfx.dataUrlToBytes(preset.dataUrl).length}|0`, '格式');
});

test('内联字节非空且与生成产物同量级（>1KB）', () => {
  for (const preset of sfx.SFX_PRESETS) {
    const size = sfx.dataUrlToBytes(preset.dataUrl).length;
    if (size < 1024) throw new Error(`${preset.id} 内联字节只有 ${size}，可能产物没进 bundle`);
  }
});

/* ---------------- ④ ensureSfxAsset ---------------- */

section('④ ensureSfxAsset');

function fakeAssets(preset) {
  return [{ id: 'as_x', hashKey: sfx.sfxHashKey(preset), name: preset.fileName }];
}

test('已有同 hashKey 资产 → 复用，不再导入', async () => {
  const preset = sfx.SFX_PRESETS[0];
  let imported = 0;
  const result = await sfx.ensureSfxAsset(preset, {
    getAssets: () => fakeAssets(preset),
    importFile: async () => {
      imported += 1;
      return { ok: true, value: 'as_new' };
    },
  });
  if (!result.ok) throw new Error(`应成功：${result.error.message}`);
  eq(result.value.assetId, 'as_x', '复用已有 id');
  eq(result.value.reused, true, '标记复用');
  eq(imported, 0, '不触发导入');
});

test('没有资产 → 导入一次并按 hashKey 找回；File 的 name/size/lastModified/type 正确', async () => {
  const preset = sfx.SFX_PRESETS[1];
  let captured = null;
  const bytes = sfx.dataUrlToBytes(preset.dataUrl);
  const result = await sfx.ensureSfxAsset(preset, {
    getAssets: () => (captured === null ? [] : fakeAssets(preset)),
    importFile: async (file) => {
      captured = file;
      return { ok: true, value: 'as_new' };
    },
  });
  if (!result.ok) throw new Error(`应成功：${result.error.message}`);
  eq(result.value.reused, false, '不是复用');
  eq(result.value.assetId, 'as_x', '找回的 id');
  eq(captured.name, preset.fileName, '文件名');
  eq(captured.size, bytes.length, '字节数');
  eq(captured.lastModified, 0, 'lastModified 固定 0');
  eq(captured.type, 'audio/mp4', 'mime');
});

test('导入失败 → 错误透传', async () => {
  const preset = sfx.SFX_PRESETS[2];
  const result = await sfx.ensureSfxAsset(preset, {
    getAssets: () => [],
    importFile: async () => ({ ok: false, error: { code: 'E_UNSUPPORTED_CONTAINER', message: '炸了', at: 0 } }),
  });
  eq(result.ok, false, '失败');
  eq(result.error.code, 'E_UNSUPPORTED_CONTAINER', '错误码透传');
});

test('同一预设并发调用只导入一次', async () => {
  const preset = sfx.SFX_PRESETS[3];
  let imported = 0;
  const importFile = async () => {
    imported += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { ok: true, value: 'as_new' };
  };
  const [a, b] = await Promise.all([
    sfx.ensureSfxAsset(preset, { getAssets: () => (imported > 0 ? fakeAssets(preset) : []), importFile }),
    sfx.ensureSfxAsset(preset, { getAssets: () => (imported > 0 ? fakeAssets(preset) : []), importFile }),
  ]);
  eq(imported, 1, 'importFile 调用次数');
  eq(a.ok && b.ok, true, '两次都成功');
});

/* ---------------- ⑤ applyFirstAssetParams（纯音频不跟随） ---------------- */

section('⑤ applyFirstAssetParams');

function fakeStore(initialAssets) {
  const doc = { assets: initialAssets, width: 1920, height: 1080, fpsMilli: 60000 };
  const applied = [];
  return {
    applied,
    store: {
      getDoc: () => doc,
      applyProjectParams: (params) => applied.push(params),
    },
  };
}

test('纯音频资产不跟随：不改任何工程参数（音效不能把 fps 悄悄重置成 30）', () => {
  const { store, applied } = fakeStore([]);
  const hit = operations.applyFirstAssetParams(
    store,
    { width: 0, height: 0, fpsMilli: 30000, kind: 'audio' },
  );
  eq(hit, false, '返回 false');
  eq(applied.length, 0, '不写参数');
});

test('视频资产跟随宽高与帧率', () => {
  const { store, applied } = fakeStore([]);
  const hit = operations.applyFirstAssetParams(
    store,
    { width: 1280, height: 720, fpsMilli: 25000, kind: 'video' },
  );
  eq(hit, true, '返回 true');
  assert.deepStrictEqual(applied[0], { width: 1280, height: 720, fpsMilli: 25000 });
});

test('已有资产时不再跟随', () => {
  const { store, applied } = fakeStore([{ id: 'as_1' }]);
  const hit = operations.applyFirstAssetParams(
    store,
    { width: 1280, height: 720, fpsMilli: 25000, kind: 'video' },
  );
  eq(hit, false, '返回 false');
  eq(applied.length, 0, '不写参数');
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
  console.log(`✓ 音效库 A1 单测：通过 ${passed} / ${passed}`);
  process.exit(0);
} else {
  console.log(`✗ 音效库 A1 单测：${failures.length} 项失败`);
  for (const item of failures) console.log(`  - ${item.name}：${item.message}`);
  process.exit(1);
}
