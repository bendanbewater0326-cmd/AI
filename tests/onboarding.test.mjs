/**
 * 新手引导 G1 单测：`ui/onboarding/steps`（6 步配置）与 `ui/onboarding/state`（状态 + 步骤解析）。
 *
 * 覆盖：
 *   ① steps：6 步齐、id 顺序、四个必填字段非空、selector 形态、requiresAI 唯一、primaryLabel 只在最后一步
 *   ② state：无存储 / done 读回 / skipped 读回 / 脏 JSON / 非法值 / reset / 非法入参被忽略
 *   ③ resolveSteps：有 AI 6 步、无 AI 5 步且最后是 export、空表返回空表、不改入参
 *
 * 运行：`node tests/onboarding.test.mjs`
 * （`npm test` 是显式脚本清单，这个文件必须显式列在里面，加完记得改 package.json）
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

const steps = await loadTsModule('src/ui/onboarding/steps.ts', 'onboarding-steps');
const state = await loadTsModule('src/ui/onboarding/state.ts', 'onboarding-state');

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

function ok(condition, label) {
  if (condition !== true) throw new Error(label);
}

const ALL_STEPS = steps.ONBOARDING_STEPS;

/* ---------------- ① steps 配置 ---------------- */

console.log('① steps 配置');

test('恰好 6 步，且 id 顺序是面板→素材→时间轴→属性→导出→AI', () => {
  eq(ALL_STEPS.length, 6, '步数');
  deepEq(
    ALL_STEPS.map((step) => step.id),
    ['panel', 'assets', 'timeline', 'inspector', 'export', 'ai'],
    'id 顺序',
  );
});

test('每步的 title / body / selector / placement 都非空', () => {
  for (const step of ALL_STEPS) {
    for (const field of ['title', 'body', 'selector', 'placement']) {
      const value = step[field];
      ok(typeof value === 'string', `${step.id} 的 ${field} 不是字符串`);
      ok(value.trim().length > 0, `${step.id} 的 ${field} 是空的`);
    }
  }
});

test('正文长度适中（最短 12 字、最长 60 字：引导框装不下长篇）', () => {
  for (const step of ALL_STEPS) {
    ok(step.body.length >= 12, `${step.id} 的正文太短（${step.body.length} 字）`);
    ok(step.body.length <= 60, `${step.id} 的正文太长（${step.body.length} 字）`);
  }
});

test('selector 都是 [data-v="..."] 形态（Node 里没有 DOM，用正则校验）', () => {
  // Node 环境没有 document，不能真跑 querySelector —— 按项目约定的 data-v 契约校验
  const pattern = /^\[data-v="[a-z][a-z0-9-]*"\]$/;
  for (const step of ALL_STEPS) {
    ok(pattern.test(step.selector), `${step.id} 的 selector 形态不对：${step.selector}`);
  }
});

test('selector 与方案的 6 个锚点一一对应（改一个就会指错地方）', () => {
  deepEq(
    ALL_STEPS.map((step) => step.selector),
    [
      '[data-v="left-tab-media"]',
      '[data-v="asset-content"]',
      '[data-v="timeline"]',
      '[data-v="inspector-panel"]',
      '[data-v="export-open"]',
      '[data-v="ai-open"]',
    ],
    '锚点',
  );
});

test('placement 只能是 right / left / below / above', () => {
  const allowed = ['right', 'left', 'below', 'above'];
  for (const step of ALL_STEPS) {
    ok(allowed.includes(step.placement), `${step.id} 的 placement 非法：${step.placement}`);
  }
  // 目标方位已摸底，写死比运行时瞎猜稳
  deepEq(
    ALL_STEPS.map((step) => step.placement),
    ['right', 'right', 'above', 'left', 'below', 'below'],
    '方位',
  );
});

test('只有第 6 步（ai）标了 requiresAI: true', () => {
  deepEq(
    ALL_STEPS.filter((step) => step.requiresAI === true).map((step) => step.id),
    ['ai'],
    'requiresAI',
  );
});

test('最后一步 primaryLabel 是「开始创作」，其余没有 primaryLabel', () => {
  const last = ALL_STEPS[ALL_STEPS.length - 1];
  eq(last.primaryLabel, '开始创作', '最后一步按钮');
  for (const step of ALL_STEPS.slice(0, -1)) {
    eq(step.primaryLabel, undefined, `${step.id} 不该有 primaryLabel`);
  }
});

test('ONBOARDING_STEP_IDS 与 ONBOARDING_STEPS 不脱节（避免两处各抄一份）', () => {
  deepEq(steps.ONBOARDING_STEP_IDS, ALL_STEPS.map((step) => step.id), 'id 列表');
});

test('标题和正文是中文（不含拉丁字母以外的乱码），且不带 HTML 标签', () => {
  for (const step of ALL_STEPS) {
    for (const text of [step.title, step.body]) {
      ok(!/[<>]/.test(text), `${step.id} 的文案里有尖括号：${text}`);
      ok(/[\u4e00-\u9fa5]/.test(text), `${step.id} 的文案没有中文：${text}`);
    }
  }
});

/* ---------------- ② state（localStorage） ---------------- */

console.log('② state');

test('没有存储时返回 null', () => {
  memory.clear();
  eq(state.readOnboardingStatus(), null, '空存储');
});

test('写入 done 后读回 done', () => {
  memory.clear();
  state.markOnboardingFinished('done');
  eq(state.readOnboardingStatus(), 'done', 'done');
  eq(memory.get(state.ONBOARDING_STORAGE_KEY), 'done', '存的是裸字符串');
});

test('写入 skipped 后读回 skipped', () => {
  memory.clear();
  state.markOnboardingFinished('skipped');
  eq(state.readOnboardingStatus(), 'skipped', 'skipped');
});

test('脏 JSON 返回 null（不抛）', () => {
  memory.clear();
  memory.set(state.ONBOARDING_STORAGE_KEY, '{ 不是 json');
  eq(state.readOnboardingStatus(), null, '脏数据');
});

test('非法值（"watching"）返回 null，不误判成看过了', () => {
  memory.clear();
  memory.set(state.ONBOARDING_STORAGE_KEY, JSON.stringify('watching'));
  eq(state.readOnboardingStatus(), null, '非法值');
});

test('空字符串 / 纯空白也返回 null', () => {
  memory.clear();
  memory.set(state.ONBOARDING_STORAGE_KEY, '   ');
  eq(state.readOnboardingStatus(), null, '空白');
});

test('resetOnboarding 之后读回 null', () => {
  memory.clear();
  state.markOnboardingFinished('done');
  eq(state.readOnboardingStatus(), 'done', '先写入');
  state.resetOnboarding();
  eq(state.readOnboardingStatus(), null, '清掉后');
});

test('写非法状态时不落盘（防止把脏值写进去）', () => {
  memory.clear();
  state.markOnboardingFinished('watching');
  eq(memory.has(state.ONBOARDING_STORAGE_KEY), false, '不该写入');
  eq(state.readOnboardingStatus(), null, '读回仍是 null');
});

test('setItem 抛异常时不炸（隐私模式模拟）', () => {
  memory.clear();
  const original = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => {
    throw new Error('QuotaExceededError');
  };
  try {
    state.markOnboardingFinished('done');
    eq(state.readOnboardingStatus(), null, '写失败 → 读仍为 null');
  } finally {
    globalThis.localStorage.setItem = original;
  }
});

/* ---------------- ③ resolveSteps（本次核心纯函数） ---------------- */

console.log('③ resolveSteps');

test('aiAvailable: true → 6 步全在', () => {
  const resolved = state.resolveSteps({ aiAvailable: true });
  eq(resolved.length, 6, '步数');
  eq(resolved[resolved.length - 1].id, 'ai', '最后一步');
});

test('aiAvailable: false → 5 步，最后一步是 export 而不是 ai', () => {
  const resolved = state.resolveSteps({ aiAvailable: false });
  eq(resolved.length, 5, '步数');
  eq(resolved[resolved.length - 1].id, 'export', '最后一步');
  eq(
    resolved.some((step) => step.id === 'ai'),
    false,
    '不该剩下 ai',
  );
});

test('传空数组返回空数组（调用方据此不启动引导）', () => {
  deepEq(state.resolveSteps({ aiAvailable: true }, []), [], '空表 + 有 AI');
  deepEq(state.resolveSteps({ aiAvailable: false }, []), [], '空表 + 无 AI');
});

test('resolveSteps 不修改入参，也不共享数组引用', () => {
  const source = ALL_STEPS.slice();
  const frozen = Object.freeze(ALL_STEPS.slice());
  const resolved = state.resolveSteps({ aiAvailable: true }, frozen);
  eq(source.length, 6, '原数组长度');
  ok(resolved !== frozen, '返回的是新数组');
  deepEq(
    resolved.map((step) => step.id),
    source.map((step) => step.id),
    '内容一致',
  );
});

test('自定义步骤表里的 requiresAI 也会被过滤（不依赖具体那 6 条）', () => {
  const custom = [
    { id: 'panel', title: '甲', body: '一', selector: '[data-v="a"]', placement: 'right' },
    { id: 'ai', title: '乙', body: '二', selector: '[data-v="b"]', placement: 'below', requiresAI: true },
  ];
  eq(state.resolveSteps({ aiAvailable: true }, custom).length, 2, '有 AI');
  eq(state.resolveSteps({ aiAvailable: false }, custom).length, 1, '无 AI');
});

test('aiAvailable 缺失（undefined）按「没有 AI」处理', () => {
  eq(state.resolveSteps({}).length, 5, '缺字段');
  eq(state.resolveSteps({ aiAvailable: undefined }).length, 5, '显式 undefined');
});

/* ---------------- 汇总 ---------------- */

console.log('');
if (failures.length === 0) {
  console.log(`✓ 新手引导 G1 单测：通过 ${passed} / ${passed}`);
  process.exit(0);
} else {
  console.log(`✗ 新手引导 G1 单测：${failures.length} 项失败`);
  for (const item of failures) console.log(`  - ${item.name}：${item.message}`);
  process.exit(1);
}
