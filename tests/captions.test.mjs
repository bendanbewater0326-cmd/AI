/**
 * 字幕面板纯逻辑单测（`src/core/captions.ts`）。
 *
 * 覆盖 C1 的全部规则：
 *   ① `listCaptions`：只挑文字片段、按起点排序、带来源
 *   ② `buildEditTextOps`：改文本 / 空文本拒绝 / 相同文本不产生撤销步
 *   ③ `buildRetimeOps`：**outFrame 必须跟随 durationFrames**、重叠拒绝、clamp
 *   ④ `buildMergeOps`：文本空格拼接、时间并集、跨轨拒绝、**压到其它字幕要拒绝**
 *   ⑤ `buildShiftOps`：`rippleShift` 只挪起点、前移越界拒绝
 *   ⑥ `buildBatchStyleOps`：只改 patch 里的字段（不顺手改别的）
 *   ⑦ 时间码：格式化 / 解析容错（逗号、省略毫秒）/ 非法返回 null
 *
 * 运行：`node tests/captions.test.mjs`
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

const types = await loadTsModule('src/core/types.ts', 'types');
const captions = await loadTsModule('src/core/captions.ts', 'captions');

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

/* ---------------- 夹具 ---------------- */

/** 一条文字（字幕）片段。 */
function textClip(id, startFrame, durationFrames, content, extra = {}) {
  return types.createClip({
    id,
    trackId: 'trk_T1',
    assetId: '',
    startFrame,
    inFrame: 0,
    outFrame: durationFrames,
    durationFrames,
    text: types.createTextContent({ content }),
    ...extra,
  });
}

/** 一条视频片段（没有 text → 不该出现在字幕列表里）。 */
function videoClip(id, startFrame, durationFrames) {
  return types.createClip({
    id,
    trackId: 'trk_V1',
    assetId: 'ast_1',
    startFrame,
    inFrame: 0,
    outFrame: durationFrames,
    durationFrames,
  });
}

function makeDoc(textClips, extraTracks = []) {
  return {
    ...types.createProject(),
    fpsMilli: 30000,
    tracks: [
      { ...types.createTrack({ id: 'trk_V1', kind: 'video', name: 'V1', order: 0 }), clips: [videoClip('clp_v1', 0, 300)] },
      { ...types.createTrack({ id: 'trk_T1', kind: 'text', name: 'T1', order: 1 }), clips: textClips },
      ...extraTracks,
    ],
  };
}

/* ---------------- ① listCaptions ---------------- */

console.log('① listCaptions');
test('只挑文字片段（视频片段不算）', () => {
  const doc = makeDoc([textClip('c1', 0, 30, '甲'), textClip('c2', 60, 30, '乙')]);
  const rows = captions.listCaptions(doc);
  eq(rows.length, 2, '条数');
  deepEq(rows.map((row) => row.clipId), ['c1', 'c2'], 'id 顺序');
});
test('按起点升序（乱序输入也排好）', () => {
  const doc = makeDoc([textClip('c2', 90, 30, '丙'), textClip('c1', 10, 30, '甲')]);
  deepEq(captions.listCaptions(doc).map((row) => row.clipId), ['c1', 'c2'], '排序');
});
test('带来源与时长', () => {
  const doc = makeDoc([textClip('c1', 15, 45, '甲', { text: types.createTextContent({ content: '甲', origin: 'ai' }) })]);
  const row = captions.listCaptions(doc)[0];
  eq(row.startFrame, 15, 'startFrame');
  eq(row.durationFrames, 45, 'durationFrames');
  eq(row.origin, 'ai', 'origin');
  eq(row.text, '甲', 'text');
});

test('来源：显式 origin 优先', () => {
  const clip = textClip('c1', 0, 30, '甲', { text: types.createTextContent({ content: '甲', origin: 'caption' }) });
  eq(captions.captionOrigin(clip), 'caption', '显式 caption');
});

test('来源：旧工程缺 origin 且 source=ui → manual', () => {
  const clip = textClip('c1', 0, 30, '甲');
  // 手动抹掉 origin，模拟旧工程数据
  const legacy = { ...clip, text: { ...clip.text, origin: undefined } };
  eq(captions.captionOrigin(legacy), 'manual', '旧 ui → manual');
});

test('来源：旧工程缺 origin 且 source=ai → ai', () => {
  const clip = textClip('c1', 0, 30, '甲', { source: 'ai' });
  const legacy = { ...clip, text: { ...clip.text, origin: undefined } };
  eq(captions.captionOrigin(legacy), 'ai', '旧 ai → ai');
});

/* ---------------- ② buildEditTextOps ---------------- */

console.log('② buildEditTextOps');
test('正常改文本 → 一条 setClipText', () => {
  const clip = textClip('c1', 0, 30, '旧文本');
  const result = captions.buildEditTextOps(clip, '新文本');
  if (!result.ok) throw new Error('应当成功');
  eq(result.value.length, 1, 'op 条数');
  eq(result.value[0].op, 'setClipText', 'op 类型');
  eq(result.value[0].to.content, '新文本', '新内容');
  eq(result.value[0].from.content, '旧文本', '旧内容（撤销用）');
});
test('空文本拒绝（空字幕是看不见的黑洞）', () => {
  const result = captions.buildEditTextOps(textClip('c1', 0, 30, '甲'), '   ');
  eq(result.ok, false, '应当失败');
});
test('文本没变 → 不产生 op（不发无用撤销步）', () => {
  const result = captions.buildEditTextOps(textClip('c1', 0, 30, '同一个'), '  同一个  ');
  if (!result.ok) throw new Error('应当成功');
  eq(result.value.length, 0, 'op 条数');
});
test('前后空格被 trim', () => {
  const result = captions.buildEditTextOps(textClip('c1', 0, 30, '甲'), '  乙  ');
  if (!result.ok) throw new Error('应当成功');
  eq(result.value[0].to.content, '乙', 'trim 后');
});

/* ---------------- ③ buildRetimeOps ---------------- */

console.log('③ buildRetimeOps');
test('改起止 → trimClip，且 outFrame 跟随 durationFrames', () => {
  const doc = makeDoc([textClip('c1', 0, 30, '甲')]);
  const result = captions.buildRetimeOps(doc.tracks[1].clips[0], 60, 45, doc);
  if (!result.ok) throw new Error('应当成功');
  const op = result.value[0];
  eq(op.op, 'trimClip', 'op 类型');
  eq(op.to.startFrame, 60, '新起点');
  eq(op.to.durationFrames, 45, '新时长');
  eq(op.to.outFrame, 45, '**outFrame 必须等于 durationFrames**');
  eq(op.to.inFrame, 0, 'inFrame 恒为 0');
});
test('与同轨其它字幕重叠 → 拒绝', () => {
  const doc = makeDoc([textClip('c1', 0, 30, '甲'), textClip('c2', 40, 30, '乙')]);
  const result = captions.buildRetimeOps(doc.tracks[1].clips[0], 20, 40, doc);
  eq(result.ok, false, '应当失败');
});
test('不同轨的字幕不算重叠', () => {
  const other = { ...types.createTrack({ id: 'trk_T2', kind: 'text', name: 'T2', order: 2 }), clips: [textClip('c9', 0, 100, '别的轨')] };
  const doc = makeDoc([textClip('c1', 0, 30, '甲')], [other]);
  const result = captions.buildRetimeOps(doc.tracks[1].clips[0], 20, 40, doc);
  eq(result.ok, true, '跨轨不算重叠（另一个轨的 c9 用的是 trk_T1，同 id 但不同轨）');
});
test('起点负数被 clamp 到 0，时长至少 1 帧', () => {
  const doc = makeDoc([textClip('c1', 0, 30, '甲')]);
  const result = captions.buildRetimeOps(doc.tracks[1].clips[0], -20, 0, doc);
  if (!result.ok) throw new Error('应当成功');
  eq(result.value[0].to.startFrame, 0, '起点 clamp');
  eq(result.value[0].to.durationFrames, 1, '时长下限');
});
test('时间没变 → 不产生 op', () => {
  const doc = makeDoc([textClip('c1', 10, 30, '甲')]);
  const result = captions.buildRetimeOps(doc.tracks[1].clips[0], 10, 30, doc);
  if (!result.ok) throw new Error('应当成功');
  eq(result.value.length, 0, 'op 条数');
});

/* ---------------- ④ buildMergeOps ---------------- */

console.log('④ buildMergeOps');
test('2 条合并 → 删 2 加 1，文本空格拼接', () => {
  const doc = makeDoc([textClip('c1', 0, 30, '第一句'), textClip('c2', 30, 30, '第二句')]);
  const result = captions.buildMergeOps(doc.tracks[1].clips, doc);
  if (!result.ok) throw new Error('应当成功');
  const removes = result.value.filter((op) => op.op === 'removeClip');
  const adds = result.value.filter((op) => op.op === 'addClip');
  eq(removes.length, 2, '删 2 条');
  eq(adds.length, 1, '加 1 条');
  eq(adds[0].clip.text.content, '第一句 第二句', '空格拼接');
  eq(adds[0].clip.startFrame, 0, '起点取最早');
  eq(adds[0].clip.durationFrames, 60, '时长取并集');
  eq(adds[0].clip.outFrame, 60, 'outFrame 跟随');
});
test('少于 2 条拒绝', () => {
  const doc = makeDoc([textClip('c1', 0, 30, '甲')]);
  eq(captions.buildMergeOps(doc.tracks[1].clips, doc).ok, false, '应当失败');
});
test('合并后压到「未选中」的字幕 → 拒绝', () => {
  // c1(0-30) 与 c3(60-90) 合并会覆盖 c2(30-60)
  const doc = makeDoc([
    textClip('c1', 0, 30, '甲'),
    textClip('c2', 30, 30, '乙'),
    textClip('c3', 60, 30, '丙'),
  ]);
  const selected = doc.tracks[1].clips.filter((clip) => clip.id !== 'c2');
  const result = captions.buildMergeOps(selected, doc);
  eq(result.ok, false, '应当失败（会盖住 c2）');
});

/* ---------------- ⑤ buildShiftOps ---------------- */

console.log('⑤ buildShiftOps');
test('整体后移 → 一条 rippleShift，只改起点', () => {
  const doc = makeDoc([textClip('c1', 30, 30, '甲'), textClip('c2', 60, 30, '乙')]);
  const result = captions.buildShiftOps(doc.tracks[1].clips, 15, doc);
  if (!result.ok) throw new Error('应当成功');
  eq(result.value.length, 1, 'op 条数');
  eq(result.value[0].op, 'rippleShift', 'op 类型');
  deepEq(
    result.value[0].shifts,
    [
      { clipId: 'c1', from: 30, to: 45 },
      { clipId: 'c2', from: 60, to: 75 },
    ],
    '两条都挪',
  );
});
test('前移越界（首条会跑到 0 之前）→ 拒绝', () => {
  const doc = makeDoc([textClip('c1', 10, 30, '甲')]);
  eq(captions.buildShiftOps(doc.tracks[1].clips, -20, doc).ok, false, '应当失败');
});
test('delta 为 0 → 不产生 op', () => {
  const doc = makeDoc([textClip('c1', 10, 30, '甲')]);
  const result = captions.buildShiftOps(doc.tracks[1].clips, 0, doc);
  if (!result.ok) throw new Error('应当成功');
  eq(result.value.length, 0, 'op 条数');
});

/* ---------------- ⑥ buildBatchStyleOps ---------------- */

console.log('⑥ buildBatchStyleOps');
test('只改 patch 字段，其余保留各条自己的值', () => {
  const a = textClip('c1', 0, 30, '甲', { text: types.createTextContent({ content: '甲', color: '#ff0000' }) });
  const b = textClip('c2', 30, 30, '乙', { text: types.createTextContent({ content: '乙', color: '#00ff00' }) });
  const ops = captions.buildBatchStyleOps([a, b], { fontSize: 48 });
  eq(ops.length, 2, 'op 条数');
  eq(ops[0].to.fontSize, 48, '字号改了');
  eq(ops[0].to.color, '#ff0000', '颜色保留（各条自己的）');
  eq(ops[1].to.color, '#00ff00', '颜色保留（各条自己的）');
});

/* ---------------- ⑦ 时间码 ---------------- */

console.log('⑦ 时间码');
test('formatCaptionMs 补零正确', () => {
  eq(captions.formatCaptionMs(0), '00:00:00.000', '0');
  eq(captions.formatCaptionMs(2500), '00:00:02.500', '2.5s');
  eq(captions.formatCaptionMs(3_723_004), '01:02:03.004', '1h2m3.004s');
});
test('parseCaptionMs 支持三种写法', () => {
  eq(captions.parseCaptionMs('00:00:02.500'), 2500, 'HH:MM:SS.mmm');
  eq(captions.parseCaptionMs('00:02.500'), 2500, 'MM:SS.mmm');
  eq(captions.parseCaptionMs('2.5'), 2500, 'SS.mmm');
});
test('parseCaptionMs 容忍 SRT 的逗号小数', () => {
  eq(captions.parseCaptionMs('00:00:02,500'), 2500, '逗号');
});
test('parseCaptionMs 非法输入返回 null（不是 0）', () => {
  eq(captions.parseCaptionMs('abc'), null, '非数字');
  eq(captions.parseCaptionMs(''), null, '空串');
  eq(captions.parseCaptionMs('1:2:3:4'), null, '四段');
  eq(captions.parseCaptionMs('00:99:00'), null, '分钟越界');
});
test('往返一致', () => {
  for (const ms of [0, 1, 999, 2500, 59_999, 3_600_000]) {
    const text = captions.formatCaptionMs(ms);
    eq(captions.parseCaptionMs(text), ms, `往返 ${ms}`);
  }
});

/* ---------------- 汇总 ---------------- */

console.log('');
if (failures.length === 0) {
  console.log(`✓ 字幕纯逻辑单测：通过 ${passed} / ${passed}`);
  process.exit(0);
} else {
  console.log(`✗ 字幕纯逻辑单测：${failures.length} 项失败`);
  for (const item of failures) console.log(`  - ${item.name}：${item.message}`);
  process.exit(1);
}
