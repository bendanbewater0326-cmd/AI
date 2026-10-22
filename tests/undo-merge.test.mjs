/**
 * 撤销合并（`dispatch(..., { mergeKey })`）单测。
 *
 * ## 为什么要这个功能
 *
 * 音量/缩放这类滑块一次拖动会发几十个 `change`。每个都压一条撤销记录的话，
 * 用户按 Ctrl+Z 要按二十下才退回拖动前 —— 这不是"撤销"，是惩罚。
 * 合并之后：**一次拖动 = 一个撤销步**，且撤销回到拖动**开始前**的值。
 *
 * ## 为什么单独测
 *
 * 合并会动撤销栈的核心逻辑（`record`）：合并错了会导致"撤销撤不干净"或
 * "重做跳错值"，而这两种错误在界面上都不报错、只是感觉"怪"。
 *
 * 运行：`node tests/undo-merge.test.mjs`
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

const types = await load('src/core/types.ts', 'types');
const storeModule = await load('src/core/store.ts', 'store');

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
const eq = (a, b, m) => assert.deepStrictEqual(a, b, m);

/** 造一个只有一条视频轨、一个片段的工程。 */
function makeStore() {
  const asset = types.createAsset({
    id: 'ast',
    name: 'a.mp4',
    kind: 'video',
    fpsMilli: 30000,
    durationFrames: 240,
    durationSec: 8,
    hasAudio: true,
  });
  const clip = types.createClip({
    id: 'clp',
    assetId: 'ast',
    trackId: 'trk_V1',
    startFrame: 0,
    inFrame: 0,
    outFrame: 240,
    durationFrames: 240,
  });
  const doc = types.createProject({
    assets: [asset],
    tracks: [types.createTrack({ id: 'trk_V1', kind: 'video', name: 'V1', order: 0, clips: [clip] })],
  });
  return storeModule.createStore(doc);
}

const gainOp = (from, to) => ({ op: 'setClipProps', clipId: 'clp', path: 'audio.gain', from, to });
const gainOf = (store) =>
  store.getDoc().tracks.flatMap((track) => track.clips).find((clip) => clip.id === 'clp').audio.gain;

console.log('\n[1] 同键合并');

test('①a 连续三次同 mergeKey → 只占一个撤销步', () => {
  const store = makeStore();
  store.dispatch([gainOp(1, 0.5)], '调整音量', 'ui', { mergeKey: 'gain:clp' });
  store.dispatch([gainOp(0.5, 0.2)], '调整音量', 'ui', { mergeKey: 'gain:clp' });
  store.dispatch([gainOp(0.2, 0.05)], '调整音量', 'ui', { mergeKey: 'gain:clp' });
  eq(store.getState().undo.past.length, 1, '三次合并成一条');
  eq(gainOf(store), 0.05, 'doc 是最终值');
});

test('①b 合并后撤销一次 → 回到拖动**开始前**的值（不是中间值）', () => {
  const store = makeStore();
  store.dispatch([gainOp(1, 0.5)], '调整音量', 'ui', { mergeKey: 'gain:clp' });
  store.dispatch([gainOp(0.5, 0.2)], '调整音量', 'ui', { mergeKey: 'gain:clp' });
  store.dispatch([gainOp(0.2, 0.05)], '调整音量', 'ui', { mergeKey: 'gain:clp' });
  store.undo();
  eq(gainOf(store), 1, '一步退回 100%');
  eq(store.getState().undo.past.length, 0);
});

test('①c 撤销后再重做 → 直接回到最终值', () => {
  const store = makeStore();
  store.dispatch([gainOp(1, 0.5)], '调整音量', 'ui', { mergeKey: 'gain:clp' });
  store.dispatch([gainOp(0.5, 0.05)], '调整音量', 'ui', { mergeKey: 'gain:clp' });
  store.undo();
  store.redo();
  eq(gainOf(store), 0.05, '重做是"原值 → 最终值"');
});

test('①d 换一个 mergeKey → 是新的一步（不同片段的音量互不合并）', () => {
  const store = makeStore();
  store.dispatch([gainOp(1, 0.5)], '调整音量', 'ui', { mergeKey: 'gain:clp' });
  store.dispatch([gainOp(0.5, 0.3)], '调整音量', 'ui', { mergeKey: 'gain:other' });
  eq(store.getState().undo.past.length, 2, '不同键各占一步');
});

test('①e 不带 mergeKey → 每次都是新的一步（离散操作不能被合并）', () => {
  const store = makeStore();
  store.dispatch([gainOp(1, 0.5)], '调整音量');
  store.dispatch([gainOp(0.5, 0.2)], '调整音量');
  eq(store.getState().undo.past.length, 2);
});

test('①f 中间插一条不同键的操作 → 之后的同键操作不再合并（合并只看上一条）', () => {
  const store = makeStore();
  store.dispatch([gainOp(1, 0.5)], '调整音量', 'ui', { mergeKey: 'gain:clp' });
  store.dispatch([{ op: 'renameTrack', trackId: 'trk_V1', from: 'V1', to: 'V1改' }], '重命名轨道');
  store.dispatch([gainOp(0.5, 0.2)], '调整音量', 'ui', { mergeKey: 'gain:clp' });
  eq(store.getState().undo.past.length, 3, '被隔开就不能合并');
});

console.log('\n[2] 合并不会吃掉别的字段');

test('②a 合并保留标签与来源', () => {
  const store = makeStore();
  store.dispatch([gainOp(1, 0.5)], '调整音量', 'ui', { mergeKey: 'gain:clp' });
  store.dispatch([gainOp(0.5, 0.2)], '调整音量', 'ui', { mergeKey: 'gain:clp' });
  const entry = store.getState().undo.past[0];
  eq(entry.label, '调整音量');
  eq(entry.source, 'ui');
  eq(entry.mergeKey, 'gain:clp');
});

test('②b 合并后 ops 里的 from 保留原值（重做才对）', () => {
  const store = makeStore();
  store.dispatch([gainOp(1, 0.5)], '调整音量', 'ui', { mergeKey: 'gain:clp' });
  store.dispatch([gainOp(0.5, 0.2)], '调整音量', 'ui', { mergeKey: 'gain:clp' });
  const entry = store.getState().undo.past[0];
  eq(entry.ops[0].from, 1, 'from 是拖动开始前的值');
  eq(entry.ops[0].to, 0.2, 'to 是最终值');
});

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} 撤销合并单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}`);
    console.error(failure.error);
  }
  process.exit(1);
}
