/**
 * 工程文件迁出单测（R-054）。
 *
 * 重点不是"能序列化"，而是**读回来的东西还能不能剪**：
 * 片段帧号、文字内容、关键帧、转场、轨道顺序、工程参数，一个字段丢了用户就要重剪。
 * 另外要保证素材被标成 offline（文件里没有字节），而不是假装还能播。
 *
 * 运行：`node tests/project-file.test.mjs`
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

const file = await load('src/persist/projectFile.ts', 'projectFile');
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

function eq(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message);
}

/** 造一份"什么都有"的工程：视频片段 + 文字 + 关键帧 + 转场 + 效果。 */
function richProject() {
  const asset = types.createAsset({
    id: 'ast_1',
    name: 'a.mp4',
    fpsMilli: 30000,
    durationFrames: 300,
    durationSec: 10,
    width: 1920,
    height: 1080,
    hasAudio: true,
    container: 'mp4',
    exactSeek: true,
    hashKey: 'a.mp4|100|1',
  });
  const video = types.createClip({
    id: 'clp_v',
    assetId: 'ast_1',
    trackId: 'trk_V1',
    startFrame: 0,
    inFrame: 0,
    outFrame: 120,
    durationFrames: 120,
    transform: { scale: 1.5, x: 12, y: -8, opacity: 0.9, blendMode: 'screen' },
    audio: { gain: 0.8, fadeInFrames: 6, fadeOutFrames: 9 },
    keyframes: [{ frame: 0, property: 'transform.opacity', value: 0, easing: 'linear' }],
  });
  video.effects = [
    {
      id: 'fx_1',
      clipId: 'clp_v',
      type: 'colorGrade',
      params: { brightness: 20 },
      keyframes: [],
      enabled: true,
      order: 0,
      source: 'ui',
    },
  ];
  video.transitionIn = { type: 'crossDissolve', durationFrames: 15 };
  const text = types.createClip({
    id: 'clp_t',
    assetId: '',
    trackId: 'trk_V2',
    startFrame: 30,
    inFrame: 0,
    outFrame: 90,
    durationFrames: 90,
    text: types.createTextContent({ content: '标题\n第二行', fontSize: 96 }),
  });
  return {
    id: 'prj_1',
    name: '测试工程',
    fpsMilli: 30000,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    frameMapPolicy: 'holdPrevious',
    durationRounding: 'halfUp',
    tracks: [
      types.createTrack({ id: 'trk_V2', kind: 'video', name: 'V2', order: 1, clips: [text] }),
      types.createTrack({ id: 'trk_V1', kind: 'video', name: 'V1', order: 0, clips: [video] }),
      types.createTrack({ id: 'trk_A1', kind: 'audio', name: 'A1', order: 0, clips: [] }),
    ],
    assets: [asset],
    playheadFrame: 42,
    zoomLevel: 7,
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 2,
  };
}

console.log('\n[1] 序列化 → 解析往返');

const doc = richProject();
const text = file.serializeProjectFile(doc, 1700000000000);

test('①a 信封字段齐全（format / version / schemaVersion / assets 清单）', () => {
  const envelope = JSON.parse(text);
  eq(envelope.format, 'veditor-project');
  eq(envelope.version, 1);
  eq(envelope.schemaVersion, 1);
  eq(envelope.exportedAt, 1700000000000);
  eq(envelope.assets.length, 1);
  eq(envelope.assets[0].id, 'ast_1');
});

test('①b 读回来工程参数一致', () => {
  const parsed = file.parseProjectFile(text);
  assert.ok(parsed.ok, '应当解析成功');
  eq(parsed.value.name, '测试工程');
  eq(parsed.value.width, 1920);
  eq(parsed.value.height, 1080);
  eq(parsed.value.fpsMilli, 30000);
  eq(parsed.value.tracks.length, 3);
});

test('①c 片段/轨道结构完整（含文字、关键帧、效果、转场、音频参数）', () => {
  const parsed = file.parseProjectFile(text);
  assert.ok(parsed.ok);
  const byId = new Map();
  for (const track of parsed.value.tracks) for (const clip of track.clips) byId.set(clip.id, clip);
  eq(byId.size, 2);

  const video = byId.get('clp_v');
  eq(video.startFrame, 0);
  eq(video.durationFrames, 120);
  eq(video.transform.scale, 1.5);
  eq(video.transform.blendMode, 'screen');
  eq(video.audio.gain, 0.8);
  eq(video.audio.fadeOutFrames, 9);
  eq(video.keyframes.length, 1);
  eq(video.effects.length, 1);
  eq(video.effects[0].params.brightness, 20);
  eq(video.transitionIn.type, 'crossDissolve');

  const textClip = byId.get('clp_t');
  eq(textClip.text.content, '标题\n第二行');
  eq(textClip.text.fontSize, 96);
});

test('①d 素材被标 offline（文件里没有字节）', () => {
  const parsed = file.parseProjectFile(text);
  assert.ok(parsed.ok);
  eq(parsed.value.assets.length, 1);
  eq(parsed.value.assets[0].status, 'offline');
  eq(parsed.value.assets[0].handleRef, null);
  eq(parsed.value.assets[0].thumbnailRef, null);
  eq(parsed.value.assets[0].hashKey, 'a.mp4|100|1');
});

test('①e 轨道顺序与轨道名保留', () => {
  const parsed = file.parseProjectFile(text);
  assert.ok(parsed.ok);
  eq(
    parsed.value.tracks.map((track) => track.id),
    ['trk_V2', 'trk_V1', 'trk_A1'],
  );
  eq(parsed.value.tracks[0].name, 'V2');
});

console.log('\n[2] 拒绝路径（错误必须可读）');

test('②a 非 JSON → 不是有效的工程文件', () => {
  const parsed = file.parseProjectFile('not json at all');
  eq(parsed.ok, false);
  assert.match(parsed.error.message, /不是有效的工程文件/);
});

test('②b format 不对 → 不是 veditor 工程文件', () => {
  const parsed = file.parseProjectFile(JSON.stringify({ format: 'other', version: 1 }));
  eq(parsed.ok, false);
  assert.match(parsed.error.message, /不是 veditor 工程文件/);
});

test('②c 版本过新 → 明确提示升级', () => {
  const parsed = file.parseProjectFile(
    JSON.stringify({ format: 'veditor-project', version: 99, project: {} }),
  );
  eq(parsed.ok, false);
  assert.match(parsed.error.message, /版本过新/);
});

test('②d 结构不合法（没有 tracks / 宽高为 0）→ 拒绝', () => {
  const noTracks = file.parseProjectFile(
    JSON.stringify({ format: 'veditor-project', version: 1, project: { width: 1920, height: 1080, fpsMilli: 30000 } }),
  );
  eq(noTracks.ok, false);
  assert.match(noTracks.error.message, /结构不合法/);

  const zeroSize = file.parseProjectFile(
    JSON.stringify({
      format: 'veditor-project',
      version: 1,
      project: { width: 0, height: 0, fpsMilli: 30000, tracks: [{ id: 't', kind: 'video', clips: [] }] },
    }),
  );
  eq(zeroSize.ok, false);
});

console.log('\n[3] 文件名');

test('③a 非法字符被替换、扩展名固定', () => {
  eq(file.projectFileName({ ...doc, name: 'a/b:c*?"<>|d' }), 'a_b_c_d.vedproj');
  eq(file.projectFileName({ ...doc, name: '   ' }), 'veditor.vedproj');
});

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} 工程文件迁出单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}`);
    console.error(failure.error);
  }
  process.exit(1);
}
