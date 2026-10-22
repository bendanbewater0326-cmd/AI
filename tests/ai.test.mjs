/**
 * AI 层单测（M4）：语气判定 + 意图编译。
 *
 * 这两块是"AI 改片"的安全边界，必须能脱离浏览器验证：
 *   - `classifyTone` 判错 → 用户只是提问却被改了时间线；
 *   - `compileIntents` 放过非法意图 → 撤销栈里出现坏数据。
 *
 * 运行：`node tests/ai.test.mjs`
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

/** 一个入口把被测模块与测试夹具一起打出来（避免逐个 bundle）。 */
function loadAiModule() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const entry = path.join(TMP_DIR, 'ai-entry.ts');
  fs.writeFileSync(
    entry,
    [
      "export { classifyTone } from '../../src/ai/tone';",
      "export { compileIntents, compileMarkAcceptance } from '../../src/ai/intents';",
      "export { normalizeIntents, extractJson, parseAIResponse } from '../../src/ai/provider';",
      "export { applyOperation } from '../../src/core/operations';",
      "export { createProject, createAsset, createClip, createTrack } from '../../src/core/types';",
    ].join('\n'),
    'utf8',
  );
  const outfile = path.join(TMP_DIR, 'ai-entry.mjs');
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

const ai = await loadAiModule();

/* ---------------- 断言框架 ---------------- */

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
  assert.deepStrictEqual(actual, expected, `${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ---------------- 夹具 ---------------- */

function makeDoc() {
  const project = ai.createProject({ width: 1280, height: 720, fpsMilli: 30000 });
  const asset = ai.createAsset({
    id: 'a1',
    name: 'sample.mp4',
    kind: 'video',
    fpsMilli: 30000,
    durationFrames: 240,
    durationSec: 8,
    width: 1280,
    height: 720,
    hasAudio: true,
    container: 'mp4',
  });
  const clip = ai.createClip({
    id: 'c1',
    assetId: 'a1',
    trackId: 'trk_V1',
    startFrame: 0,
    inFrame: 0,
    outFrame: 240,
    durationFrames: 240,
  });
  const tracks = project.tracks.map((track) =>
    track.id === 'trk_V1' ? { ...track, clips: [clip] } : track,
  );
  return { ...project, assets: [asset], tracks };
}

function applyAll(doc, ops) {
  let next = doc;
  for (const op of ops) next = ai.applyOperation(next, op);
  return next;
}

function allClips(doc) {
  return doc.tracks.flatMap((track) => track.clips).sort((a, b) => a.startFrame - b.startFrame);
}

/* ---------------- 语气判定（R-045） ---------------- */

test('T1 命令式：动词开头 → command', () => {
  eq(ai.classifyTone('剪掉开头 3 秒').tone, 'command', 'T1a');
  eq(ai.classifyTone('删掉选中的片段').tone, 'command', 'T1b');
  eq(ai.classifyTone('在播放头切一刀').tone, 'command', 'T1c');
});

test('T2 命令式：把/将字句 → command', () => {
  eq(ai.classifyTone('把最后 2 秒删掉').tone, 'command', 'T2a');
  eq(ai.classifyTone('把这段放大到 150%').tone, 'command', 'T2b');
});

test('T3 礼貌前缀不影响命令判定', () => {
  eq(ai.classifyTone('请帮我删掉前 3 秒').tone, 'command', 'T3a');
  eq(ai.classifyTone('麻烦把结尾剪掉 1 秒').tone, 'command', 'T3b');
});

test('T4 提问式：疑问词优先于动词', () => {
  eq(ai.classifyTone('这里为什么要切').tone, 'question', 'T4a');
  eq(ai.classifyTone('建议在哪里切').tone, 'question', 'T4b');
  eq(ai.classifyTone('能不能去掉开头').tone, 'question', 'T4c');
  eq(ai.classifyTone('删掉开头会不会太快？').tone, 'question', 'T4d');
});

test('T5 空串与模糊表达默认走安全侧（question）', () => {
  eq(ai.classifyTone('').tone, 'question', 'T5a');
  eq(ai.classifyTone('这段有点长').tone, 'question', 'T5b');
});

/* ---------------- 意图编译（R-046 / Q12） ---------------- */

test('I1 removeRange 覆盖整段 → 一条 removeClip', () => {
  const doc = makeDoc();
  const result = ai.compileIntents(doc, [{ kind: 'removeRange', clipId: 'c1', startFrame: 0, endFrame: 240 }]);
  assert.ok(result.ok, '应编译成功');
  eq(result.ops.length, 1, 'I1 操作数');
  eq(result.ops[0].op, 'removeClip', 'I1 操作类型');
  eq(allClips(applyAll(doc, result.ops)).length, 0, 'I1 应用后无片段');
});

test('I2 removeRange 剪头部 → 切分 + 删除，剩余片段从 0 开始且时长正确', () => {
  const doc = makeDoc();
  const result = ai.compileIntents(doc, [{ kind: 'removeRange', clipId: 'c1', startFrame: 0, endFrame: 30 }]);
  assert.ok(result.ok, '应编译成功');
  const after = applyAll(doc, result.ops);
  const clips = allClips(after);
  eq(clips.length, 1, 'I2 剩 1 段');
  eq(clips[0].startFrame, 0, 'I2 起点');
  eq(clips[0].durationFrames, 210, 'I2 时长');
  eq(clips[0].inFrame, 30, 'I2 素材入点');
  eq(clips[0].outFrame, 240, 'I2 素材出点');
});

test('I3 removeRange 剪中间 → 两段保留且总时长减少被剪跨度', () => {
  const doc = makeDoc();
  const result = ai.compileIntents(doc, [{ kind: 'removeRange', clipId: 'c1', startFrame: 60, endFrame: 120 }]);
  assert.ok(result.ok, '应编译成功');
  const after = applyAll(doc, result.ops);
  const clips = allClips(after);
  eq(clips.length, 2, 'I3 剩 2 段');
  eq(clips[0].durationFrames, 60, 'I3 前段时长');
  eq(clips[1].durationFrames, 120, 'I3 后段时长');
  eq(clips[1].startFrame, 60, 'I3 后段起点（原位留空）');
  eq(clips[0].durationFrames + clips[1].durationFrames, 180, 'I3 总时长守恒');
});

test('I4 removeRange 剪尾部 → 只剩前段', () => {
  const doc = makeDoc();
  const result = ai.compileIntents(doc, [{ kind: 'removeRange', clipId: 'c1', startFrame: 200, endFrame: 240 }]);
  assert.ok(result.ok, '应编译成功');
  const clips = allClips(applyAll(doc, result.ops));
  eq(clips.length, 1, 'I4 剩 1 段');
  eq(clips[0].durationFrames, 200, 'I4 时长');
});

test('I5 splitAt 落在片段边界 → 拒绝（no-op 不允许静默通过）', () => {
  const doc = makeDoc();
  const result = ai.compileIntents(doc, [{ kind: 'splitAt', frame: 0 }]);
  eq(result.ok, false, 'I5 应失败');
});

test('I6 setProperty 越界 → 拒绝', () => {
  const doc = makeDoc();
  const result = ai.compileIntents(doc, [{ kind: 'setProperty', clipId: 'c1', path: 'transform.scale', value: 99 }]);
  eq(result.ok, false, 'I6 应失败');
  assert.match(result.error, /超出范围/, 'I6 错误信息应可读');
});

test('I7 setProperty 合法 → 一条 setClipProps，from 取真实旧值', () => {
  const doc = makeDoc();
  const result = ai.compileIntents(doc, [{ kind: 'setProperty', clipId: 'c1', path: 'transform.opacity', value: 0.5 }]);
  assert.ok(result.ok, '应编译成功');
  eq(result.ops.length, 1, 'I7 操作数');
  const op = result.ops[0];
  eq(op.op, 'setClipProps', 'I7 操作类型');
  eq(op.from, 1, 'I7 from 是旧值');
  eq(op.to, 0.5, 'I7 to 是新值');
});

test('I8 moveClip 与已有片段重叠 → 拒绝（不静默挪位）', () => {
  const doc = makeDoc();
  const second = ai.createClip({
    id: 'c2',
    assetId: 'a1',
    trackId: 'trk_V1',
    startFrame: 300,
    inFrame: 0,
    outFrame: 60,
    durationFrames: 60,
  });
  const withTwo = { ...doc, tracks: doc.tracks.map((t) => (t.id === 'trk_V1' ? { ...t, clips: [...t.clips, second] } : t)) };
  const result = ai.compileIntents(withTwo, [{ kind: 'moveClip', clipId: 'c1', startFrame: 290 }]);
  eq(result.ok, false, 'I8 应失败');
  assert.match(result.error, /重叠/, 'I8 错误信息');
});

test('I9 moveClip 视频片段进音轨 → 拒绝', () => {
  const doc = makeDoc();
  const result = ai.compileIntents(doc, [{ kind: 'moveClip', clipId: 'c1', startFrame: 0, trackId: 'trk_A1' }]);
  eq(result.ok, false, 'I9 应失败');
});

test('I10 muteTrack 状态未变 → 视为空操作并报错', () => {
  const doc = makeDoc();
  const result = ai.compileIntents(doc, [{ kind: 'muteTrack', trackId: 'trk_V1', muted: false }]);
  eq(result.ok, false, 'I10 应失败');
});

test('I11 addTrack → 一条 addTrack，命名不冲突', () => {
  const doc = makeDoc();
  const result = ai.compileIntents(doc, [{ kind: 'addTrack', trackKind: 'video' }]);
  assert.ok(result.ok, '应编译成功');
  const after = applyAll(doc, result.ops);
  const videos = after.tracks.filter((track) => track.kind === 'video');
  eq(videos.length, 3, 'I11 视频轨数');
  assert.ok(videos.some((track) => track.name === 'V3'), 'I11 新轨名 V3');
});

test('I12 suggestCut 只产标记，不产操作', () => {
  const doc = makeDoc();
  const result = ai.compileIntents(doc, [{ kind: 'suggestCut', frame: 90, label: '这里' }]);
  assert.ok(result.ok, '应编译成功');
  eq(result.ops.length, 0, 'I12 无操作');
  eq(result.marks.length, 1, 'I12 一个标记');
  eq(result.marks[0].frame, 90, 'I12 标记帧');
});

test('I13 引用不存在的片段 → 整条拒绝', () => {
  const doc = makeDoc();
  const result = ai.compileIntents(doc, [{ kind: 'removeClip', clipId: 'nope' }]);
  eq(result.ok, false, 'I13 应失败');
});

test('I14 空意图数组 → 拒绝（不允许"执行了个寂寞"）', () => {
  const doc = makeDoc();
  eq(ai.compileIntents(doc, []).ok, false, 'I14 应失败');
});

test('I15 多条意图串行叠加（同段两刀）', () => {
  const doc = makeDoc();
  const result = ai.compileIntents(doc, [
    { kind: 'removeRange', clipId: 'c1', startFrame: 0, endFrame: 30 },
    { kind: 'removeRange', clipId: 'c1', startFrame: 120, endFrame: 150 },
  ]);
  assert.ok(result.ok, '应编译成功');
  const clips = allClips(applyAll(doc, result.ops));
  eq(clips.length, 2, 'I15 剩 2 段');
  eq(clips.reduce((sum, clip) => sum + clip.durationFrames, 0), 180, 'I15 总时长');
});

/* ---------------- 模型输出解析 ---------------- */

test('P1 extractJson 容忍 markdown 围栏与前后废话', () => {
  const text = '好的，结果如下：\n```json\n{"message":"ok","intents":[{"kind":"removeClip","clipId":"c1"}]}\n```\n希望有帮助';
  const json = ai.extractJson(text);
  assert.ok(json !== null, 'P1 应解析出 JSON');
  eq(json.message, 'ok', 'P1 message');
});

test('P2 normalizeIntents 丢弃未知意图与非法字段', () => {
  const { intents, dropped } = ai.normalizeIntents([
    { kind: 'removeClip', clipId: 'c1' },
    { kind: 'hackThePlanet' },
    { kind: 'setProperty', clipId: 'c1', path: 'transform.hacked', value: 1 },
    { kind: 'removeRange', clipId: 'c1' },
  ]);
  eq(intents.length, 1, 'P2 只保留合法意图');
  eq(dropped.length, 3, 'P2 丢弃 3 条');
});

test('P3 parseAIResponse 对空结果报错而不是返回空操作', () => {
  const result = ai.parseAIResponse('{"message":"","intents":[]}');
  eq(result.ok, false, 'P3 应失败');
});

/* ---------------- 汇总 ---------------- */

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} AI 层单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  console.log('失败用例：');
  for (const failure of failures) console.log(`  - ${failure.name}: ${failure.message}`);
  process.exit(1);
}
