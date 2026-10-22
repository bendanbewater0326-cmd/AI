/**
 * 宿主命令通道单测（R-050）。
 *
 * 分两层：
 * 1. `projectInput`：纯归一化（不碰 store / DOM），旧工程、脏字段、乱序片段都在这里挡；
 * 2. `runHostCommand`：命令分发与回包，**永远回恰好一条**、永远不抛。
 *
 * 浏览器侧的真实链路（postMessage 双向、导出字节 transfer）由
 * `tests/verify-postmessage.mjs` 覆盖——这里不重复造浏览器。
 *
 * 运行：`node tests/host-commands.test.mjs`
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

const input = await load('src/host/projectInput.ts', 'projectInput');
const commands = await load('src/host/commands.ts', 'hostCommands');

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

async function testAsync(name, fn) {
  try {
    await fn();
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

/* ---------------- 夹具 ---------------- */

/** 造一份"旧版本"工程：缺 keyframes / effects / audio / transition，片段还是乱序的。 */
function legacyProject() {
  return {
    id: 'prj_old',
    name: '旧工程',
    fpsMilli: 30000,
    width: 1280,
    height: 720,
    tracks: [
      {
        id: 'trk_V1',
        kind: 'video',
        name: 'V1',
        order: 0,
        clips: [
          {
            id: 'clp_late',
            assetId: 'ast_1',
            startFrame: 120,
            inFrame: 0,
            outFrame: 60,
            durationFrames: 60,
          },
          {
            id: 'clp_early',
            assetId: 'ast_1',
            startFrame: 0,
            inFrame: 0,
            outFrame: 120,
            durationFrames: 120,
          },
        ],
      },
    ],
    assets: [
      {
        id: 'ast_1',
        name: 'a.mp4',
        fpsMilli: 30000,
        durationFrames: 240,
        durationSec: 8,
        width: 1280,
        height: 720,
        hasAudio: true,
      },
    ],
  };
}

function makeCtx(overrides = {}) {
  const calls = { replies: [], events: [], replaced: null, imports: [] };
  const doc = overrides.doc ?? commands.normalizeProjectInput(legacyProject());
  const ctx = {
    reply: (result) => calls.replies.push(result),
    postEvent: (event) => calls.events.push(event),
    getDoc: () => doc,
    replaceDoc: (project) => {
      calls.replaced = project;
    },
    importFile: async (file, assetId) => {
      calls.imports.push({ name: file.name, size: file.size, assetId });
      return { ok: true, value: assetId ?? 'ast_new' };
    },
    ...overrides.ctx,
  };
  return { ctx, calls, doc };
}

/* ---------------- 1. 归一化：拒绝 ---------------- */

console.log('\n[1] normalizeProjectInput 的拒绝路径');

test('①a 非对象 → null', () => {
  eq(input.normalizeProjectInput(null), null);
  eq(input.normalizeProjectInput('project'), null);
  eq(input.normalizeProjectInput([]), null);
});

test('①b 缺 tracks / 空 tracks → null', () => {
  eq(input.normalizeProjectInput({ width: 1280, height: 720, fpsMilli: 30000 }), null);
  eq(input.normalizeProjectInput({ width: 1280, height: 720, fpsMilli: 30000, tracks: [] }), null);
});

test('①c 宽高或帧率非正 → null', () => {
  const base = { tracks: [{ id: 't', kind: 'video', clips: [] }] };
  eq(input.normalizeProjectInput({ ...base, width: 0, height: 720, fpsMilli: 30000 }), null);
  eq(input.normalizeProjectInput({ ...base, width: 1280, height: -1, fpsMilli: 30000 }), null);
  eq(input.normalizeProjectInput({ ...base, width: 1280, height: 720, fpsMilli: 0 }), null);
  eq(input.normalizeProjectInput({ ...base, width: 1280, height: 720, fpsMilli: '30' }), null);
});

/* ---------------- 2. 归一化：补默认值 ---------------- */

console.log('\n[2] 旧工程补齐（缺 keyframes / effects / audio / transition）');

test('②a 旧工程能被接受，且补出 schemaVersion / 常量字段', () => {
  const project = input.normalizeProjectInput(legacyProject());
  assert.ok(project !== null, '应当接受');
  eq(project.schemaVersion, 1);
  eq(project.sampleRate, 48000);
  eq(project.frameMapPolicy, 'holdPrevious');
  eq(project.durationRounding, 'halfUp');
  eq(project.width, 1280);
  eq(project.fpsMilli, 30000);
});

test('②b 每个片段都补齐数组与对象（渲染层不再读到 undefined）', () => {
  const project = input.normalizeProjectInput(legacyProject());
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      assert.deepStrictEqual(clip.keyframes, [], `${clip.id} keyframes`);
      assert.deepStrictEqual(clip.effects, [], `${clip.id} effects`);
      eq(clip.transitionIn, null);
      eq(clip.transitionOut, null);
      eq(clip.audio.gain, 1);
      eq(clip.audio.fadeInFrames, 0);
      eq(clip.transform.scale, 1);
      eq(clip.transform.opacity, 1);
      eq(clip.transform.blendMode, 'normal');
      eq(clip.speedMilli, 1000);
      eq(clip.enabled, true);
      eq(clip.source, 'ui');
    }
  }
});

test('②c 轨道内片段按 startFrame 升序（不变式）', () => {
  const project = input.normalizeProjectInput(legacyProject());
  eq(
    project.tracks[0].clips.map((clip) => clip.id),
    ['clp_early', 'clp_late'],
  );
});

test('②d 非法片段被丢弃（durationFrames=0 / 负起点），合法的不受影响', () => {
  const raw = legacyProject();
  raw.tracks[0].clips.push({ id: 'clp_zero', assetId: 'ast_1', startFrame: 0, durationFrames: 0 });
  raw.tracks[0].clips.push({ id: 'clp_neg', assetId: 'ast_1', startFrame: -5, durationFrames: 10 });
  const project = input.normalizeProjectInput(raw);
  eq(
    project.tracks[0].clips.map((clip) => clip.id),
    ['clp_early', 'clp_late'],
  );
});

test('②e playheadFrame 被夹进 [0, 时长]', () => {
  const raw = { ...legacyProject(), playheadFrame: 9999 };
  const project = input.normalizeProjectInput(raw);
  eq(project.playheadFrame, 180); // 最长片段结束于 120+60=180
  const negative = input.normalizeProjectInput({ ...legacyProject(), playheadFrame: -3 });
  eq(negative.playheadFrame, 0);
});

test('②f 素材标 offline（只有元数据、没有字节），id 保留供重连', () => {
  const project = input.normalizeProjectInput(legacyProject());
  eq(project.assets.length, 1);
  const asset = project.assets[0];
  eq(asset.id, 'ast_1');
  eq(asset.status, 'offline');
  eq(asset.name, 'a.mp4');
  eq(asset.durationFrames, 240);
  eq(asset.hasAudio, true);
});

test('②g 脏字段被夹住：opacity 超范围、scale 负数、blendMode 乱写', () => {
  const raw = legacyProject();
  raw.tracks[0].clips[0].transform = { opacity: 5, scale: -2, blendMode: 'weird' };
  const project = input.normalizeProjectInput(raw);
  const clip = project.tracks[0].clips.find((candidate) => candidate.id === 'clp_late');
  eq(clip.transform.opacity, 1);
  eq(clip.transform.scale, 0);
  eq(clip.transform.blendMode, 'normal');
});

test('②h 转场类型非法 → 置空；合法 → 保留帧数', () => {
  const raw = legacyProject();
  raw.tracks[0].clips[0].transitionIn = { type: 'wipe', durationFrames: 15 };
  raw.tracks[0].clips[1].transitionIn = { type: 'crossDissolve', durationFrames: 15 };
  const project = input.normalizeProjectInput(raw);
  const late = project.tracks[0].clips.find((candidate) => candidate.id === 'clp_late');
  const early = project.tracks[0].clips.find((candidate) => candidate.id === 'clp_early');
  eq(late.transitionIn, null);
  eq(early.transitionIn.type, 'crossDissolve');
  eq(early.transitionIn.durationFrames, 15);
});

/* ---------------- 3. dataUrl ---------------- */

console.log('\n[3] dataUrl / mime');

test('③a base64 dataUrl → Blob（类型与字节都对）', () => {
  const blob = input.dataUrlToBlob('data:video/mp4;base64,AAAA');
  eq(blob.type, 'video/mp4');
  eq(blob.size, 3);
});

test('③b 百分号编码 dataUrl → Blob', () => {
  const blob = input.dataUrlToBlob('data:text/plain,hi%20there');
  eq(blob.type, 'text/plain');
});

test('③c 非法 dataUrl → null（不是抛错）', () => {
  eq(input.dataUrlToBlob('not-a-data-url'), null);
  eq(input.dataUrlToBlob('data:video/mp4;base64,@@@'), null);
});

test('③d guessMime 按扩展名，未知回 octet-stream', () => {
  eq(input.guessMime('a.MP4'), 'video/mp4');
  eq(input.guessMime('b.webm'), 'video/webm');
  eq(input.guessMime('c.xyz'), 'application/octet-stream');
  eq(input.guessMime('noext'), 'application/octet-stream');
});

/* ---------------- 4. 命令分发 ---------------- */

console.log('\n[4] runHostCommand 分发与回包');

await testAsync('④a getProject → 回工程本体', async () => {
  const { ctx, calls } = makeCtx();
  await commands.runHostCommand({ type: 'getProject', id: 'q1' }, ctx);
  eq(calls.replies.length, 1);
  eq(calls.replies[0].ok, true);
  eq(calls.replies[0].project.tracks.length, 1);
});

await testAsync('④b setProject 非法 → E_INVALID_PROJECT，且不 replaceDoc', async () => {
  const { ctx, calls } = makeCtx();
  await commands.runHostCommand({ type: 'setProject', project: { tracks: [] } }, ctx);
  eq(calls.replies[0].ok, false);
  eq(calls.replies[0].code, 'E_INVALID_PROJECT');
  eq(calls.replaced, null);
});

await testAsync('④c setProject 合法 → replaceDoc 被调用，回 schemaVersion', async () => {
  const { ctx, calls } = makeCtx();
  await commands.runHostCommand({ type: 'setProject', project: legacyProject() }, ctx);
  eq(calls.replies[0].ok, true);
  eq(calls.replies[0].schemaVersion, 1);
  assert.ok(calls.replaced !== null);
  eq(calls.replaced.tracks[0].clips.length, 2);
});

await testAsync('④d importAsset 无载荷 → E_INVALID_PAYLOAD', async () => {
  const { ctx, calls } = makeCtx();
  await commands.runHostCommand({ type: 'importAsset' }, ctx);
  eq(calls.replies[0].ok, false);
  eq(calls.replies[0].code, 'E_INVALID_PAYLOAD');
  eq(calls.imports.length, 0);
});

await testAsync('④e importAsset 带 buffer → 走 importFile，回 assetId', async () => {
  const { ctx, calls } = makeCtx();
  const buffer = new Uint8Array([0, 1, 2, 3]).buffer;
  await commands.runHostCommand({ type: 'importAsset', buffer, name: 'x.mp4' }, ctx);
  eq(calls.imports.length, 1);
  eq(calls.imports[0].name, 'x.mp4');
  eq(calls.imports[0].size, 4);
  eq(calls.replies[0].ok, true);
  eq(calls.replies[0].assetId, 'ast_new');
});

await testAsync('④f importAsset 带 assetId → 透传（R-054 重连）', async () => {
  const { ctx, calls } = makeCtx();
  await commands.runHostCommand(
    { type: 'importAsset', dataUrl: 'data:video/mp4;base64,AAAA', assetId: 'ast_1' },
    ctx,
  );
  eq(calls.imports[0].assetId, 'ast_1');
  eq(calls.replies[0].assetId, 'ast_1');
});

await testAsync('④g importAsset 失败 → 原样把错误码回给宿主', async () => {
  const { ctx, calls } = makeCtx({
    ctx: {
      importFile: async () => ({
        ok: false,
        error: { code: 'E_UNSUPPORTED_CONTAINER', message: '无法识别的容器', at: Date.now() },
      }),
    },
  });
  await commands.runHostCommand(
    { type: 'importAsset', dataUrl: 'data:video/mp4;base64,AAAA' },
    ctx,
  );
  eq(calls.replies[0].ok, false);
  eq(calls.replies[0].code, 'E_UNSUPPORTED_CONTAINER');
});

await testAsync('④h export webm → E_UNSUPPORTED_FORMAT（不尝试编码）', async () => {
  const { ctx, calls } = makeCtx();
  await commands.runHostCommand({ type: 'export', format: 'webm' }, ctx);
  eq(calls.replies[0].ok, false);
  eq(calls.replies[0].code, 'E_UNSUPPORTED_FORMAT');
  assert.match(calls.replies[0].message, /WebM/);
});

await testAsync('④i export 未知格式 → E_UNSUPPORTED_FORMAT', async () => {
  const { ctx, calls } = makeCtx();
  await commands.runHostCommand({ type: 'export', format: 'avi' }, ctx);
  eq(calls.replies[0].code, 'E_UNSUPPORTED_FORMAT');
});

await testAsync('④j export 区间非法（end <= start）→ E_INVALID_RANGE', async () => {
  const { ctx, calls } = makeCtx();
  await commands.runHostCommand({ type: 'export', format: 'mp4', startFrame: 100, endFrame: 100 }, ctx);
  eq(calls.replies[0].ok, false);
  eq(calls.replies[0].code, 'E_INVALID_RANGE');
});

await testAsync('④k 未知命令 → E_UNSUPPORTED_COMMAND，并列出可用命令', async () => {
  const { ctx, calls } = makeCtx();
  await commands.runHostCommand({ type: 'deleteEverything' }, ctx);
  eq(calls.replies[0].ok, false);
  eq(calls.replies[0].code, 'E_UNSUPPORTED_COMMAND');
  assert.match(calls.replies[0].message, /getProject/);
});

await testAsync('④l 内部异常不抛出：getDoc 抛错 → E_INTERNAL', async () => {
  const { ctx, calls } = makeCtx({
    ctx: {
      getDoc: () => {
        throw new Error('boom');
      },
    },
  });
  await commands.runHostCommand({ type: 'getProject' }, ctx);
  eq(calls.replies.length, 1);
  eq(calls.replies[0].ok, false);
  eq(calls.replies[0].code, 'E_INTERNAL');
  assert.match(calls.replies[0].message, /boom/);
});

/* ---------------- 汇总 ---------------- */

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} 宿主命令通道单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}`);
    console.error(failure.error);
  }
  process.exit(1);
}
