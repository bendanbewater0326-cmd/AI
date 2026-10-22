/**
 * 文字模板库单测（左栏「文本」面板的数据层）。
 *
 * 守四条规则：
 * 1. **id 唯一、名称全中文、分类合法** —— 界面上不允许出现英文，也不能两张卡同名；
 * 2. **每个模板都"看起来不一样"** —— 至少一个视觉维度与默认值不同，否则 10 张卡片长一个样；
 * 3. **`presetToText` 的内容覆盖语义**：传了内容就用传的（套样式保留用户文案），
 *    不传就用模板自带的（新建时要有示例文字）；
 * 4. **向下兼容**：`bold` / `stroke` 缺省时不写进对象，老工程打开不会多出字段。
 *
 * 运行：`node tests/text-presets.test.mjs`
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

const presets = await load('src/core/textPresets.ts', 'textPresets');
const types = await load('src/core/types.ts', 'types');

const { TEXT_PRESETS, TEXT_CATEGORIES, presetToText, textPresetsIn, textPresetById } = presets;
const { createTextContent } = types;

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}
const eq = (actual, expected, message) => assert.deepStrictEqual(actual, expected, message ?? undefined);
const ok = (value, message) => assert.ok(value, message);

/* ---------------- ① 清单完整性 ---------------- */

test('① 共 10 个模板，id 唯一', () => {
  eq(TEXT_PRESETS.length, 10);
  eq(new Set(TEXT_PRESETS.map((item) => item.id)).size, 10, 'id 有重复');
});

test('①b 名称全中文（不含拉丁字母）', () => {
  for (const preset of TEXT_PRESETS) {
    ok(preset.name.length > 0, `${preset.id} 名称为空`);
    ok(!/[A-Za-z]/.test(preset.name), `${preset.id} 名称含英文：${preset.name}`);
  }
});

test('①c 分类都在 TEXT_CATEGORIES 里，且每个分类都有模板', () => {
  const keys = new Set(TEXT_CATEGORIES.map((item) => item.key).filter((key) => key !== 'all'));
  for (const preset of TEXT_PRESETS) {
    ok(keys.has(preset.category), `${preset.id} 分类非法：${preset.category}`);
  }
  for (const key of keys) {
    ok(textPresetsIn(key).length > 0, `分类 ${key} 没有任何模板（点进去会是空网格）`);
  }
});

test('①d textPresetsIn(all) 返回全部，其它分类是子集', () => {
  eq(textPresetsIn('all').length, TEXT_PRESETS.length);
  const titles = textPresetsIn('title');
  eq(titles.length, 4);
  ok(titles.every((item) => item.category === 'title'));
});

test('①e textPresetById 能取回、取不到返回 null', () => {
  eq(textPresetById(TEXT_PRESETS[0].id)?.id, TEXT_PRESETS[0].id);
  eq(textPresetById('tpl-not-exist'), null);
});

/* ---------------- ② 每个模板都要"看得出不同" ---------------- */

test('② 每个模板至少有一个视觉维度与默认值不同', () => {
  const base = createTextContent();
  for (const preset of TEXT_PRESETS) {
    const text = presetToText(preset);
    const differs =
      text.fontSize !== base.fontSize ||
      text.color !== base.color ||
      text.align !== base.align ||
      text.x !== base.x ||
      text.y !== base.y ||
      text.background !== base.background ||
      text.bold === true ||
      (text.stroke !== null && text.stroke !== undefined);
    ok(differs, `${preset.id} 与默认样式完全一样，卡片会没有辨识度`);
  }
});

test('②b 字号 / 位置都在安全范围（字号 12–240，y 在 ±480，x 在 ±860）', () => {
  for (const preset of TEXT_PRESETS) {
    const text = presetToText(preset);
    ok(text.fontSize >= 12 && text.fontSize <= 240, `${preset.id} 字号越界：${text.fontSize}`);
    ok(Math.abs(text.y) <= 480, `${preset.id} y 越界：${text.y}`);
    ok(Math.abs(text.x) <= 860, `${preset.id} x 越界：${text.x}`);
  }
});

test('②c 颜色都是合法的 #rrggbb 或 rgba()', () => {
  for (const preset of TEXT_PRESETS) {
    const text = presetToText(preset);
    ok(/^#[0-9a-fA-F]{6}$/.test(text.color), `${preset.id} 颜色非法：${text.color}`);
    if (text.background !== '') {
      ok(/^rgba?\(/.test(text.background), `${preset.id} 底衬非法：${text.background}`);
    }
    if (text.stroke !== null && text.stroke !== undefined) {
      ok(text.stroke.width > 0 && /^#[0-9a-fA-F]{6}$/.test(text.stroke.color), `${preset.id} 描边非法`);
    }
  }
});

test('②d 多行模板的内容里真的有换行', () => {
  const pair = textPresetById('tpl-title-pair');
  ok(pair !== null);
  ok(pair.content.includes('\n'), '主副标题应当是两行');
});

/* ---------------- ③ 内容覆盖语义 ---------------- */

test('③ presetToText 不传内容 → 用模板自带示例文字', () => {
  const preset = textPresetById('tpl-title-main');
  eq(presetToText(preset).content, preset.content);
});

test('③b presetToText 传内容 → 内容被覆盖、样式仍来自模板', () => {
  const preset = textPresetById('tpl-caption-bottom');
  const text = presetToText(preset, '我自己的文案');
  eq(text.content, '我自己的文案');
  eq(text.fontSize, 44);
  eq(text.y, 380);
});

test('③c 传空串也算"传了"（用户把内容删空时不该被模板文案覆盖）', () => {
  eq(presetToText(textPresetById('tpl-title-main'), '').content, '');
});

/* ---------------- ④ 向下兼容 ---------------- */

test('④ 默认 TextContent 不带 bold / stroke 字段（老工程不变样）', () => {
  const base = createTextContent();
  eq(Object.hasOwn(base, 'bold'), false);
  eq(Object.hasOwn(base, 'stroke'), false);
});

test('④b 金句描边：bold=true 且 stroke 有值，其余模板不写这两个字段', () => {
  const quote = presetToText(textPresetById('tpl-quote-stroke'));
  eq(quote.bold, true);
  eq(quote.stroke, { width: 6, color: '#000000' });
  const plain = presetToText(textPresetById('tpl-caption-bottom'));
  eq(plain.bold, undefined);
  eq(plain.stroke, undefined);
});

/* ---------------- ⑤ 分辨率换算 ---------------- */

test('⑤ 720p 工程：字号与位置按高度比例缩小（否则文字被推到画面外）', () => {
  const preset = textPresetById('tpl-caption-bottom');
  const text = presetToText(preset, undefined, { width: 1280, height: 720 });
  eq(text.fontSize, Math.round(44 * (720 / 1080)), '字号未按比例缩放');
  eq(text.y, Math.round(380 * (720 / 1080)), 'y 未按比例缩放');
  // 关键：720 高时 y 必须落在半画面内（360），否则文字直接看不见
  ok(Math.abs(text.y) < 720 / 2, `y=${text.y} 超出 720p 画面`);
});

test('⑤b 4K 工程：字号与位置等比放大', () => {
  const preset = textPresetById('tpl-title-main');
  const text = presetToText(preset, undefined, { width: 3840, height: 2160 });
  eq(text.fontSize, 176);
  eq(text.y, 0);
  const label = presetToText(textPresetById('tpl-label-corner'), undefined, { width: 3840, height: 2160 });
  eq(label.x, -1640);
  eq(label.y, -860);
});

test('⑤c 描边粗细也随分辨率缩放（4K 下不缩会细得像没画）', () => {
  const preset = textPresetById('tpl-quote-stroke');
  eq(presetToText(preset, undefined, { width: 1280, height: 720 }).stroke.width, 4);
  eq(presetToText(preset, undefined, { width: 1920, height: 1080 }).stroke.width, 6);
  eq(presetToText(preset, undefined, { width: 3840, height: 2160 }).stroke.width, 12);
});

test('⑤d 不传 size 时按 1080p 处理（向后兼容）', () => {
  eq(presetToText(textPresetById('tpl-title-main')).fontSize, 88);
});

console.log(`\n${failed === 0 ? '✓' : '✗'} 文字模板库单测：通过 ${passed} / ${passed + failed}`);
process.exitCode = failed === 0 ? 0 : 1;
