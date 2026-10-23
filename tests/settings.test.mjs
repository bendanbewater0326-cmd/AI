/**
 * 设置面板 S1 单测：`core/prefs`（偏好持久化）与 `ui/settings/keymapView`（快捷键展示）。
 *
 * 覆盖：
 *   ① prefs：无存储 / 写入读回 / 脏 JSON / 范围 clamp / 类型不对 -> 默认
 *   ② keymapView：17 条全覆盖分类、四组顺序、mac 与 win 的修饰键差异、
 *      多键同义只显示第一个、空格与方向键的显示名
 *
 * 运行：`node tests/settings.test.mjs`
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
    logLevel: 'silent',
  });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

/* ---------------- 假 localStorage（Node 里没有） ---------------- */

const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => {
    memory.set(key, String(value));
  },
  removeItem: (key) => {
    memory.delete(key);
  },
  clear: () => memory.clear(),
  key: (index) => [...memory.keys()][index] ?? null,
  get length() {
    return memory.size;
  },
};

const prefs = await loadTsModule('src/core/prefs.ts', 'prefs');
const keymapView = await loadTsModule('src/ui/settings/keymapView.ts', 'keymapView');
const keymap = await loadTsModule('src/core/keymap.ts', 'keymap');

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

function deepEq(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
  } catch (error) {
    throw new Error(`${label}：结构不相等 → ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ---------------- ① prefs ---------------- */

console.log('① prefs');

test('没有存储时返回默认值', () => {
  memory.clear();
  deepEq(prefs.readPrefs(), prefs.DEFAULT_PREFS, '默认');
});

test('写入后能读回', () => {
  memory.clear();
  prefs.writePrefs({ defaultClipSeconds: 5 });
  eq(prefs.readPrefs().defaultClipSeconds, 5, '时长');
  prefs.writePrefs({ snapEnabled: false });
  eq(prefs.readPrefs().snapEnabled, false, '吸附');
  eq(prefs.readPrefs().defaultClipSeconds, 5, '局部更新不清掉其它字段');
});

test('脏 JSON 退回默认（不抛）', () => {
  memory.clear();
  memory.set('veditor:prefs', '{ 不是 json');
  deepEq(prefs.readPrefs(), prefs.DEFAULT_PREFS, '脏数据');
});

test('defaultClipSeconds 超范围被 clamp', () => {
  memory.clear();
  eq(prefs.writePrefs({ defaultClipSeconds: 999 }).defaultClipSeconds, prefs.MAX_DEFAULT_SECONDS, '上限');
  eq(prefs.writePrefs({ defaultClipSeconds: 0 }).defaultClipSeconds, prefs.MIN_DEFAULT_SECONDS, '下限');
});

test('字段类型不对时只用该字段的默认值（不整份丢弃）', () => {
  memory.clear();
  memory.set('veditor:prefs', JSON.stringify({ defaultClipSeconds: '五秒', snapEnabled: false }));
  const read = prefs.readPrefs();
  eq(read.defaultClipSeconds, prefs.DEFAULT_PREFS.defaultClipSeconds, '坏字段退回默认');
  eq(read.snapEnabled, false, '好字段保留');
});

test('保留 1 位小数', () => {
  memory.clear();
  eq(prefs.writePrefs({ defaultClipSeconds: 2.56 }).defaultClipSeconds, 2.6, '四舍五入到 0.1');
});

/* ---------------- ② keymapView ---------------- */

console.log('② keymapView');

test('KEY_BINDINGS 里每一条都有分类（掉一条就会进兜底的全局功能）', () => {
  deepEq(keymapView.uncategorizedIds(), [], '未分类 id');
});

test('四组齐全且顺序按用户指定', () => {
  const groups = keymapView.groupBindings('other');
  deepEq(groups.map((group) => group.label), ['播放控制', '编辑操作', '视图调整', '全局功能'], '顺序');
});

test('分组后总数 = 绑定总数（不重不漏）', () => {
  const total = keymapView.groupBindings('other').reduce((sum, group) => sum + group.rows.length, 0);
  eq(total, keymap.KEY_BINDINGS.length, `总数（期望 ${keymap.KEY_BINDINGS.length}）`);
});

test('播放控制 5 条 / 编辑操作 6 条 / 全局功能 5 条', () => {
  const groups = keymapView.groupBindings('other');
  const count = (category) => groups.find((group) => group.category === category).rows.length;
  eq(count('playback'), 5, '播放');
  eq(count('edit'), 6, '编辑');
  eq(count('global'), 5, '全局');
});

test('Win 的修饰键是 Ctrl / Alt / Shift', () => {
  const redo = keymap.KEY_BINDINGS.find((binding) => binding.id === 'redo');
  deepEq(keymapView.formatBindingKeys(redo, 'other'), ['Ctrl', 'Shift', 'Z'], 'Win');
});

test('Mac 的修饰键是 ⌘ / ⇧（不是 Cmd / Shift）', () => {
  const redo = keymap.KEY_BINDINGS.find((binding) => binding.id === 'redo');
  deepEq(keymapView.formatBindingKeys(redo, 'mac'), ['⌘', '⇧', 'Z'], 'Mac');
});

test('多键同义只显示第一个（delete / backspace）', () => {
  const del = keymap.KEY_BINDINGS.find((binding) => binding.id === 'deleteClip');
  deepEq(keymapView.formatBindingKeys(del, 'other'), ['Delete'], '只有 Delete');
});

test('空格显示成「空格」，方向键显示成箭头', () => {
  const play = keymap.KEY_BINDINGS.find((binding) => binding.id === 'togglePlay');
  deepEq(keymapView.formatBindingKeys(play, 'other'), ['空格'], '空格');
  const back = keymap.KEY_BINDINGS.find((binding) => binding.id === 'stepBack');
  deepEq(keymapView.formatBindingKeys(back, 'other'), ['←'], '左箭头');
});

test('Esc 显示成 Esc 而不是 escape', () => {
  const esc = keymap.KEY_BINDINGS.find((binding) => binding.id === 'escape');
  deepEq(keymapView.formatBindingKeys(esc, 'other'), ['Esc'], 'Esc');
});

test('行的 id / label / caps 齐全（面板要直接用）', () => {
  const group = keymapView.groupBindings('other').find((item) => item.category === 'playback');
  for (const row of group.rows) {
    if (typeof row.id !== 'string' || typeof row.label !== 'string' || !Array.isArray(row.caps)) {
      throw new Error(`行结构不对：${JSON.stringify(row)}`);
    }
    if (row.caps.length === 0) throw new Error(`行 ${row.id} 没有键帽`);
  }
});

/* ---------------- 汇总 ---------------- */

console.log('');
if (failures.length === 0) {
  console.log(`✓ 设置面板 S1 单测：通过 ${passed} / ${passed}`);
  process.exit(0);
} else {
  console.log(`✗ 设置面板 S1 单测：${failures.length} 项失败`);
  for (const item of failures) console.log(`  - ${item.name}：${item.message}`);
  process.exit(1);
}
