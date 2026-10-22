/**
 * 字幕单测（R-059）：SRT 解析 / 生成 / 落时间线。
 *
 * 容错是重点：真实 SRT 文件经常有缺序号、`.` 代替 `,`、时间轴后带坐标、
 * 多余空行。**坏块跳过、好块照用**，整份拒绝等于让用户没法用。
 *
 * 运行：`node tests/subtitle.test.mjs`
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

const srt = await load('src/subtitle/srt.ts', 'srt');
const types = await load('src/core/types.ts', 'types');

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
function eq(a, b, m) {
  assert.deepStrictEqual(a, b, m);
}

const SAMPLE = `1
00:00:01,000 --> 00:00:03,500
第一句

2
00:00:04,000 --> 00:00:06,000
第二句
换行也算
`;

console.log('\n[1] parseSrt');

test('①a 标准文件解析出 2 条，时间与文本都对', () => {
  const { cues, skipped } = srt.parseSrt(SAMPLE);
  eq(skipped, 0);
  eq(cues.length, 2);
  eq(cues[0].startMs, 1000);
  eq(cues[0].endMs, 3500);
  eq(cues[0].text, '第一句');
  eq(cues[1].text, '第二句\n换行也算');
});

test('①b CRLF 换行同样能解析', () => {
  const { cues } = srt.parseSrt(SAMPLE.replace(/\n/g, '\r\n'));
  eq(cues.length, 2);
});

test('①c 缺序号 / 用 . 代替 , / 带坐标后缀 都能解析', () => {
  const messy = `00:00:01.000 --> 00:00:02.000 X1:100 X2:200 Y1:10 Y2:20
没有序号

3
00:00:03,000 --> 00:00:04,000
第三条`;
  const { cues, skipped } = srt.parseSrt(messy);
  eq(skipped, 0);
  eq(cues.length, 2);
  eq(cues[0].startMs, 1000);
  eq(cues[1].startMs, 3000);
});

test('①d 坏块被跳过、好块保留（不整份失败）', () => {
  const broken = `1
00:00:01,000 --> 00:00:02,000
好的

2
这不是时间轴
坏的`;
  const { cues, skipped } = srt.parseSrt(broken);
  eq(cues.length, 1);
  eq(skipped, 1);
});

test('①e 空文件 → 0 条、不报错', () => {
  eq(srt.parseSrt('').cues.length, 0);
  eq(srt.parseSrt('   \n\n  ').cues.length, 0);
});

test('①f 结束早于开始的块被丢弃', () => {
  const bad = `1
00:00:05,000 --> 00:00:03,000
倒着的`;
  const { cues, skipped } = srt.parseSrt(bad);
  eq(cues.length, 0);
  eq(skipped, 1);
});

console.log('\n[2] serializeSrt');

test('②a 往返一致（解析 → 生成 → 再解析）', () => {
  const { cues } = srt.parseSrt(SAMPLE);
  const text = srt.serializeSrt(cues);
  const again = srt.parseSrt(text).cues;
  eq(again, cues);
});

test('②b 序号从 1 起、按时间排序', () => {
  const text = srt.serializeSrt([
    { startMs: 5000, endMs: 6000, text: '后' },
    { startMs: 1000, endMs: 2000, text: '前' },
  ]);
  const lines = text.split('\n');
  eq(lines[0], '1');
  eq(lines[1], '00:00:01,000 --> 00:00:02,000');
  eq(lines[4], '2');
});

console.log('\n[3] 时间换算与落时间线');

test('③a 毫秒 ↔ 帧（30fps）', () => {
  eq(srt.msToFrame(1000, 30000), 30);
  eq(srt.msToFrame(0, 30000), 0);
  eq(srt.frameToMs(30, 30000), 1000);
  // 23.976fps 下 1 秒 = 24 帧（half-up）
  eq(srt.msToFrame(1000, 24000), 24);
});

test('③b 每个 cue 生成一个文本片段，帧号与时长正确', () => {
  const doc = {
    id: 'p', name: 't', fpsMilli: 30000, width: 1280, height: 720,
    sampleRate: 48000, frameMapPolicy: 'holdPrevious', durationRounding: 'halfUp',
    tracks: [types.createTrack({ id: 'trk_V2', kind: 'video', order: 1 })],
    assets: [], playheadFrame: 0, zoomLevel: 5, schemaVersion: 1, createdAt: 0, updatedAt: 0,
  };
  const clips = srt.buildSubtitleClips(
    [{ startMs: 1000, endMs: 2000, text: '一' }, { startMs: 2000, endMs: 2500, text: '二' }],
    doc,
    { trackId: 'trk_V2' },
  );
  eq(clips.length, 2);
  eq(clips[0].startFrame, 30);
  eq(clips[0].durationFrames, 30);
  eq(clips[0].text.content, '一');
  eq(clips[0].assetId, '', '字幕片段不引用素材');
  eq(clips[1].durationFrames, 15);
});

test('③c 极短 cue 至少 1 帧（0 帧片段不可见）', () => {
  const doc = {
    id: 'p', name: 't', fpsMilli: 30000, width: 1280, height: 720,
    sampleRate: 48000, frameMapPolicy: 'holdPrevious', durationRounding: 'halfUp',
    tracks: [], assets: [], playheadFrame: 0, zoomLevel: 5, schemaVersion: 1, createdAt: 0, updatedAt: 0,
  };
  const clips = srt.buildSubtitleClips([{ startMs: 1000, endMs: 1001, text: '闪' }], doc, { trackId: 't' });
  eq(clips[0].durationFrames, 1);
});

test('③d extractSubtitles 从工程里取回字幕并按起点排序', () => {
  const clip = types.createClip({
    assetId: '', trackId: 'trk_V2', startFrame: 60, inFrame: 0, outFrame: 30, durationFrames: 30,
    text: types.createTextContent({ content: '字幕' }),
  });
  const doc = {
    id: 'p', name: 't', fpsMilli: 30000, width: 1280, height: 720,
    sampleRate: 48000, frameMapPolicy: 'holdPrevious', durationRounding: 'halfUp',
    tracks: [types.createTrack({ id: 'trk_V2', kind: 'video', order: 1, clips: [clip] })],
    assets: [], playheadFrame: 0, zoomLevel: 5, schemaVersion: 1, createdAt: 0, updatedAt: 0,
  };
  const cues = srt.extractSubtitles(doc);
  eq(cues.length, 1);
  eq(cues[0].startMs, 2000);
  eq(cues[0].endMs, 3000);
  eq(cues[0].text, '字幕');
});

test('④a buildSubtitleReplaceOps：旧字幕整段移除 + 新字幕逐条添加（一批 op）', () => {
  const oldClip = types.createClip({
    assetId: '', trackId: 'trk_V1', startFrame: 0, inFrame: 0, outFrame: 30, durationFrames: 30,
    text: types.createTextContent({ content: '旧字幕' }),
  });
  const videoClip = types.createClip({
    assetId: 'ast', trackId: 'trk_V1', startFrame: 0, inFrame: 0, outFrame: 240, durationFrames: 240,
  });
  const doc = {
    id: 'p', name: 't', fpsMilli: 30000, width: 1280, height: 720,
    sampleRate: 48000, frameMapPolicy: 'holdPrevious', durationRounding: 'halfUp',
    tracks: [types.createTrack({ id: 'trk_V1', kind: 'video', order: 0, clips: [videoClip, oldClip] })],
    assets: [], playheadFrame: 0, zoomLevel: 5, schemaVersion: 1, createdAt: 0, updatedAt: 0,
  };
  const plan = srt.buildSubtitleReplaceOps(
    [
      { startMs: 0, endMs: 1000, text: '新一' },
      { startMs: 1200, endMs: 2000, text: '新二' },
    ],
    doc,
  );
  eq(plan.removed, 1, '旧的 1 条文本片段被替换');
  eq(plan.trackId, 'trk_V1');
  const removes = plan.ops.filter((op) => op.op === 'removeClip');
  const adds = plan.ops.filter((op) => op.op === 'addClip');
  eq(removes.length, 1);
  eq(adds.length, 2);
  eq(plan.ops.length, 3, '一批 op（一次 dispatch = 一个撤销步）');
  // 只移除文本片段，不碰视频片段
  eq(removes[0].clipId, oldClip.id);
});

test('④b 没有视频轨 → null（调用方给可读错误，不静默失败）', () => {
  const doc = {
    id: 'p', name: 't', fpsMilli: 30000, width: 1280, height: 720,
    sampleRate: 48000, frameMapPolicy: 'holdPrevious', durationRounding: 'halfUp',
    tracks: [types.createTrack({ id: 'trk_A1', kind: 'audio', order: 0, clips: [] })],
    assets: [], playheadFrame: 0, zoomLevel: 5, schemaVersion: 1, createdAt: 0, updatedAt: 0,
  };
  eq(srt.buildSubtitleReplaceOps([{ startMs: 0, endMs: 1000, text: 'x' }], doc), null);
});

test('⑤a resolveCueOverlaps：重叠 → 前一条尾巴收到后一条起点', () => {
  const result = srt.resolveCueOverlaps([
    { startMs: 0, endMs: 5000, text: '长句' },
    { startMs: 2000, endMs: 3000, text: '短句' },
  ]);
  eq(result.cues[0].endMs, 2000, '长句被截到 2s');
  eq(result.truncated, 1);
  eq(result.dropped, 0);
});

test('⑤b resolveCueOverlaps：乱序输入按起点排序（SRT 工具可能乱序）', () => {
  const result = srt.resolveCueOverlaps([
    { startMs: 3000, endMs: 4000, text: '第三' },
    { startMs: 0, endMs: 1000, text: '第一' },
    { startMs: 1500, endMs: 2500, text: '第二' },
  ]);
  eq(result.cues.map((cue) => cue.text), ['第一', '第二', '第三']);
  eq(result.truncated, 0);
});

test('⑤c resolveCueOverlaps：被完全挤没的条目丢弃（不足 40ms）', () => {
  const result = srt.resolveCueOverlaps([
    { startMs: 0, endMs: 1000, text: '甲' },
    { startMs: 5, endMs: 1000, text: '乙' },
  ]);
  eq(result.cues.length, 1);
  eq(result.cues[0].text, '乙');
  eq(result.dropped, 1);
  eq(result.truncated, 1);
});

test('⑤d 不重叠的输入原样通过（不做任何"优化"）', () => {
  const input = [
    { startMs: 0, endMs: 1000, text: 'A' },
    { startMs: 1000, endMs: 2000, text: 'B' }, // 首尾相接不算重叠
  ];
  const result = srt.resolveCueOverlaps(input);
  eq(result.cues, input);
  eq(result.truncated, 0);
  eq(result.dropped, 0);
});

test('⑤e buildSubtitleReplaceOps 报出被截短的重叠条数（SRT 导入要能提示）', () => {
  const videoClip = types.createClip({
    assetId: 'ast', trackId: 'trk_V1', startFrame: 0, inFrame: 0, outFrame: 240, durationFrames: 240,
  });
  const doc = {
    id: 'p', name: 't', fpsMilli: 30000, width: 1280, height: 720,
    sampleRate: 48000, frameMapPolicy: 'holdPrevious', durationRounding: 'halfUp',
    tracks: [types.createTrack({ id: 'trk_V1', kind: 'video', order: 0, clips: [videoClip] })],
    assets: [], playheadFrame: 0, zoomLevel: 5, schemaVersion: 1, createdAt: 0, updatedAt: 0,
  };
  const plan = srt.buildSubtitleReplaceOps(
    [
      { startMs: 0, endMs: 2000, text: '双语上行' },
      { startMs: 500, endMs: 2000, text: '双语下行' },
    ],
    doc,
  );
  eq(plan.truncated, 1, '有 1 条被截短');
  const adds = plan.ops.filter((op) => op.op === 'addClip');
  eq(adds.length, 2, '两条都保留（只是前一条变短）');
  // 落到时间线上的两个片段不再重叠
  const spans = adds
    .map((op) => ({ start: op.clip.startFrame, end: op.clip.startFrame + op.clip.durationFrames }))
    .sort((left, right) => left.start - right.start);
  eq(spans[0].end <= spans[1].start, true, `片段不该重叠：${JSON.stringify(spans)}`);
});

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} 字幕单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}`);
    console.error(failure.error);
  }
  process.exit(1);
}
