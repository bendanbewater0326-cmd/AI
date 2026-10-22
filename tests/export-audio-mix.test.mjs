/**
 * 导出混音的"谁参与"规则单测（`export/audioMix.audibleClipsFor`）。
 *
 * 这条规则原先只写在 `mixTimelineAudio` 内部，且**漏了 `role` 判断**：
 * 分离音频之后，原片段（`role: 'video'`）与音频轨上的新片段（`role: 'audio'`）
 * 指向同一个素材、同一区间 —— 导出时两段都参与混音，同一段声音被叠加两遍
 * （音量翻倍、相位偏移发闷）。预览路径（`audioEngine`）有判断、导出路径没有，
 * 表现为"预览听着正常，导出炸了"。
 *
 * 这里把"谁参与"钉住：role 过滤、onlyClipId、静音轨、禁用片段、区间相交。
 *
 * 运行：`node tests/export-audio-mix.test.mjs`
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

const mix = await load('src/export/audioMix.ts', 'audioMix');
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

/** 造素材（有音频）。 */
function asset(id = 'ast', name = 'clip.mp4') {
  return types.createAsset({
    id,
    name,
    kind: 'video',
    fpsMilli: 30000,
    durationFrames: 240,
    durationSec: 8,
    hasAudio: true,
  });
}

/**
 * 造工程：`clips` 是 `[trackId, { start, duration, role, enabled }]`。
 */
function docWith(clips, options = {}) {
  const tracks = types.createDefaultTracks().map((track) => ({
    ...track,
    muted: options.mutedTracks?.includes(track.id) === true,
    clips: clips
      .filter(([trackId]) => trackId === track.id)
      .map(([trackId, spec], index) =>
        types.createClip({
          id: spec.id ?? `clp_${trackId}_${index}`,
          assetId: spec.assetId ?? 'ast',
          trackId,
          startFrame: spec.start,
          inFrame: 0,
          outFrame: spec.duration,
          durationFrames: spec.duration,
          enabled: spec.enabled ?? true,
          ...(spec.role === undefined ? {} : { role: spec.role }),
        }),
      ),
  }));
  return types.createProject({ tracks, assets: [asset(), asset('ast2', 'music.mp3')] });
}

const ids = (list) => list.map((item) => item.clip.id).sort();

console.log('\n[1] 基本筛选');

test('①a 区间内的片段参与', () => {
  const doc = docWith([['trk_V1', { start: 0, duration: 240 }]]);
  eq(ids(mix.audibleClipsFor(doc, 0, 240)), ['clp_trk_V1_0']);
});

test('①b 完全在区间外 → 不参与', () => {
  const doc = docWith([['trk_V1', { start: 0, duration: 60 }]]);
  eq(ids(mix.audibleClipsFor(doc, 60, 120)), []);
});

test('①c 部分相交 → 参与（导出会按交集截断）', () => {
  const doc = docWith([['trk_V1', { start: 0, duration: 60 }]]);
  eq(ids(mix.audibleClipsFor(doc, 30, 120)), ['clp_trk_V1_0']);
});

test('①d 静音轨 / 禁用片段不参与', () => {
  const doc = docWith([['trk_V1', { start: 0, duration: 240 }]], { mutedTracks: ['trk_V1'] });
  eq(ids(mix.audibleClipsFor(doc, 0, 240)), []);
  const disabled = docWith([['trk_V1', { start: 0, duration: 240, enabled: false }]]);
  eq(ids(mix.audibleClipsFor(disabled, 0, 240)), []);
});

test('①e 素材没有音频 → 不参与', () => {
  const doc = docWith([['trk_V1', { start: 0, duration: 240 }]]);
  doc.assets = doc.assets.map((item) => ({ ...item, hasAudio: false }));
  eq(ids(mix.audibleClipsFor(doc, 0, 240)), []);
});

console.log('\n[2] 分离音频（role）—— 这条曾让导出声音翻倍');

test('②a 分离后：只出画的片段不参与混音', () => {
  const doc = docWith([
    ['trk_V1', { start: 0, duration: 240, role: 'video' }],
    ['trk_A1', { start: 0, duration: 240, role: 'audio' }],
  ]);
  const list = mix.audibleClipsFor(doc, 0, 240);
  eq(list.length, 1, '只有音频片段参与');
  eq(list[0].clip.role, 'audio');
});

test('②b 分离前的普通片段照常参与', () => {
  const doc = docWith([['trk_V1', { start: 0, duration: 240 }]]);
  eq(mix.audibleClipsFor(doc, 0, 240).length, 1);
});

console.log('\n[3] onlyClipId（"导出这段的音频"）');

test('③a 指定片段 → 别的片段不参与', () => {
  const doc = docWith([
    ['trk_V1', { start: 0, duration: 120, id: 'want' }],
    ['trk_A1', { start: 0, duration: 240, id: 'other', assetId: 'ast2' }],
  ]);
  eq(ids(mix.audibleClipsFor(doc, 0, 240, 'want')), ['want']);
});

test('③b 指定的片段不在区间内 → 空（不会退化成"全都混"）', () => {
  const doc = docWith([['trk_V1', { start: 0, duration: 60, id: 'want' }]]);
  eq(ids(mix.audibleClipsFor(doc, 120, 240, 'want')), []);
});

test('③c 不指定 → 区间内全部（正常导出行为不变）', () => {
  const doc = docWith([
    ['trk_V1', { start: 0, duration: 120, id: 'a' }],
    ['trk_A1', { start: 0, duration: 240, id: 'b', assetId: 'ast2' }],
  ]);
  eq(ids(mix.audibleClipsFor(doc, 0, 240)), ['a', 'b']);
});

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} 导出混音筛选单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}`);
    console.error(failure.error);
  }
  process.exit(1);
}
