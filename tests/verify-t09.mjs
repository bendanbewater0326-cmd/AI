/**
 * T09 播放引擎验收（真浏览器 + 真 WebCodecs + 逐像素比对参考帧）。
 *
 * 覆盖架构 task:T09 的 ①–④：
 *   ① renderFrame(137) + captureFrame() 与 ref_137.png 比对：平均通道差 ≤ 15 且 PSNR ≥ 20dB
 *      （单通道最大差不设阈值——跨渲染链路固有差异，实测可达 100+，只记录）
 *   ② 连续播放 10 秒：`exact=false` 不得连续超过 3 帧
 *   ③ 强制 ElementEngine 模式：能出帧、能 seek（允许不精确）
 *   ④ dispose() 后所有 VideoFrame 已 close（守恒式 totalCreated - totalClosed === openFrames）
 *
 * 运行：node tests/verify-t09.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { createReport } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, 'tests', '.cache');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const PAGE = `<!doctype html><meta charset="utf-8"><script type="module">
import {
  probeAsset, createDecoderPool, createPlaybackEngine, maxChannelDiff,
  createProject, createAsset, createClip, createDefaultTracks,
} from '/tests/.cache/t09-bundle.mjs';

window.__phase = 'boot';
window.__result = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 平均通道差 + PSNR（与 T05 缩略图、T07 同链路比对同一套口径）。 */
function compare(actual, expected) {
  let sum = 0;
  let sqSum = 0;
  let maxCh = 0;
  const n = Math.min(actual.data.length, expected.data.length);
  for (let i = 0; i < n; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      const d = actual.data[i + c] - expected.data[i + c];
      sum += Math.abs(d);
      sqSum += d * d;
      const abs = Math.abs(d);
      if (abs > maxCh) maxCh = abs;
    }
  }
  const pixels = n / 4;
  const meanDiff = sum / (pixels * 3);
  const mse = sqSum / (pixels * 3);
  const psnr = mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
  return { meanDiff, psnr, maxCh };
}

async function loadBitmap(url) {
  const blob = await (await fetch(url)).blob();
  return createImageBitmap(blob);
}

async function bitmapToImageData(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

const blob = await (await fetch('/tests/fixtures/sample-720p.mp4')).blob();
const file = new File([blob], 'sample-720p.mp4');
const probed = await probeAsset(file, { thumbnailDecoder: null });
if (!probed.ok) { window.__result = { fatal: probed.error }; window.__phase = 'done'; throw new Error('probe 失败'); }

const doc = createProject({ width: 1280, height: 720, fpsMilli: 30000 });
doc.assets = [createAsset({
  id: 'a1', name: 'sample-720p.mp4', kind: 'video',
  width: 1280, height: 720, fpsMilli: 30000,
  durationFrames: 240, durationSec: 8, hasAudio: true, container: 'mp4',
})];
doc.tracks = createDefaultTracks();
const clip = createClip({ assetId: 'a1', trackId: 'trk_V1', startFrame: 0, inFrame: 0, outFrame: 240, durationFrames: 240 });
doc.tracks.find((t) => t.id === 'trk_V1').clips = [clip];

const pool = createDecoderPool();
const engine = createPlaybackEngine({ width: 1280, height: 720, fpsMilli: 30000, decoderPool: pool });
engine.registerAsset('a1', file, probed.value.probe);

const result = {};

// ---- ① renderFrame(137) vs ref_137.png ----
{
  const r = await engine.renderFrame(doc, 137);
  const shot = await engine.compositor.captureFrame();
  const actual = await bitmapToImageData(shot);
  shot.close();
  const expectedBitmap = await loadBitmap('/tests/fixtures/ref/ref_137.png');
  const expected = await bitmapToImageData(expectedBitmap);
  expectedBitmap.close();
  const cmp = compare(actual, expected);
  // 诊断：和三张不同帧的参考图都比一遍，用最小差值反推"实际画的是哪一帧"
  const identity = {};
  for (const name of ['ref_000', 'ref_137', 'ref_239']) {
    const bmp = await loadBitmap('/tests/fixtures/ref/' + name + '.png');
    const img = await bitmapToImageData(bmp);
    bmp.close();
    const c = compare(actual, img);
    identity[name] = { meanDiff: Number(c.meanDiff.toFixed(2)), psnr: Number(c.psnr.toFixed(2)) };
  }
  result.identity = identity;
  // 把实际渲染结果存成 PNG，便于人眼确认
  const outCanvas = new OffscreenCanvas(actual.width, actual.height);
  outCanvas.getContext('2d').putImageData(actual, 0, 0);
  const pngBlob = await outCanvas.convertToBlob({ type: 'png' });
  const reader = new FileReader();
  const dataUrl = await new Promise((res) => { reader.onload = () => res(reader.result); reader.readAsDataURL(pngBlob); });
  result.png = dataUrl;
  result.render137 = {
    ok: r.ok,
    exact: r.ok ? r.value.exact : false,
    assetFrame: r.ok ? r.value.assetFrame : null,
    clipIds: r.ok ? r.value.clipIds : null,
    size: [actual.width, actual.height],
    meanDiff: Number(cmp.meanDiff.toFixed(2)),
    psnr: Number(cmp.psnr.toFixed(2)),
    maxCh: cmp.maxCh,
    compositor: engine.compositor.kind,
  };
}

// ---- ② 连续播放 10 秒（300 帧）----
{
  const start = performance.now();
  let inexactRun = 0;
  let maxRun = 0;
  let inexact = 0;
  for (let f = 0; f < 300; f += 1) {
    const r = await engine.renderFrame(doc, f);
    if (!r.ok || !r.value.exact) {
      inexactRun += 1;
      inexact += 1;
      if (inexactRun > maxRun) maxRun = inexactRun;
    } else {
      inexactRun = 0;
    }
  }
  const wallMs = Math.round(performance.now() - start);
  result.play10s = { frames: 300, wallMs, inexact, maxInexactRun: maxRun, stats: engine.stats() };
}

const beforeDispose = pool.stats();

// ---- ③ ElementEngine 兜底 ----
{
  const elPool = createDecoderPool();
  const elEngine = createPlaybackEngine({ width: 1280, height: 720, fpsMilli: 30000, decoderPool: elPool, mode: 'element' });
  elEngine.registerAsset('a1', file, probed.value.probe);
  await sleep(400); // 等 <video> loadeddata
  const r1 = await elEngine.renderFrame(doc, 0);
  const r2 = await elEngine.renderFrame(doc, 137);
  const r3 = await elEngine.renderFrame(doc, 60);
  const shot = await elEngine.compositor.captureFrame();
  // 判"出了画面"：不能是纯黑空帧（背景清屏色）
  const data = await bitmapToImageData(shot);
  shot.close();
  let nonBlack = 0;
  for (let i = 0; i < data.data.length; i += 4) {
    if (data.data[i] > 8 || data.data[i + 1] > 8 || data.data[i + 2] > 8) nonBlack += 1;
  }
  result.element = {
    mode: elEngine.mode,
    exactSeek: elEngine.exactSeek,
    first: r1.ok, second: r2.ok, third: r3.ok,
    nonBlackPixels: nonBlack,
    totalPixels: data.width * data.height,
    exactFlag: r2.ok ? r2.value.exact : null,
  };
  await elEngine.dispose();
}

// ---- ④ dispose 后帧守恒 ----
await engine.dispose();
result.dispose = { before: beforeDispose, after: pool.stats(), engineStats: engine.stats() };

window.__result = result;
window.__phase = 'done';
</script>`;

fs.mkdirSync(CACHE, { recursive: true });
await build({
  entryPoints: [path.join(CACHE, 't09-entry.ts')],
  outfile: path.join(CACHE, 't09-bundle.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  logLevel: 'warning',
});
fs.writeFileSync(path.join(CACHE, 't09.html'), PAGE);

const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  fs.readFile(p, (e, d) => {
    if (e) { res.writeHead(404).end('nf'); return; }
    const ext = path.extname(p);
    const mime = ext === '.mp4' ? 'video/mp4' : ext === '.mjs' ? 'text/javascript; charset=utf-8' : ext === '.png' ? 'image/png' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': mime });
    res.end(d);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-t09-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-first-run', '--mute-audio', '--remote-debugging-port=9339', `--user-data-dir=${udd}`, 'about:blank'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));
const t = await (await fetch(`http://127.0.0.1:9339/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/tests/.cache/t09.html`)}`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
await new Promise((r) => { ws.onopen = r; });
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pend.set(i, r)); };
await send('Runtime.enable');
const pageErrors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? 'unknown');
  }
});
let out = null;
let lastPhase = null;
for (let i = 0; i < 800; i += 1) {
  const ev = await send('Runtime.evaluate', { expression: 'JSON.stringify({phase: window.__phase ?? null, result: window.__result ?? null})', returnByValue: true });
  if (ev.result?.value) {
    const snap = JSON.parse(ev.result.value);
    if (snap.phase !== lastPhase) { lastPhase = snap.phase; console.log(`  … 页面阶段：${snap.phase}`); }
    if (snap.phase === 'done') { out = snap.result; break; }
  }
  await new Promise((r) => setTimeout(r, 250));
}
chrome.kill(); server.close();
if (pageErrors.length) console.log('页面错误：', pageErrors.slice(0, 2));
if (!out) { console.log('页面未完成（最后阶段 ' + lastPhase + '）'); process.exit(1); }

const report = createReport();
const r137 = out.render137 ?? {};
report.check(
  `①a renderFrame(137) 命中且 exact（exact=${r137.exact} assetFrame=${r137.assetFrame} clipIds=${JSON.stringify(r137.clipIds)}）`,
  r137.ok === true && r137.exact === true && r137.assetFrame === 137,
);
report.check(
  `①b captureFrame 尺寸 1280×720（实际 ${JSON.stringify(r137.size)}，合成器 ${r137.compositor}）`,
  Array.isArray(r137.size) && r137.size[0] === 1280 && r137.size[1] === 720,
);
report.check(
  `①c 平均通道差 ≤ 15（实际 ${r137.meanDiff}）`,
  typeof r137.meanDiff === 'number' && r137.meanDiff <= 15,
);
report.check(
  `①d PSNR ≥ 20dB（实际 ${r137.psnr}dB；单通道最大差 ${r137.maxCh} 仅记录不判）`,
  typeof r137.psnr === 'number' && r137.psnr >= 20,
);
const play = out.play10s ?? {};
report.check(
  `②a 连续播放 300 帧：` + `exact=false 不连续超过 3 帧（实测最长连续 ${play.maxInexactRun}，总 inexact ${play.inexact}，耗时 ${play.wallMs}ms）`,
  typeof play.maxInexactRun === 'number' && play.maxInexactRun <= 3,
);
const el = out.element ?? {};
report.check(
  `③a ElementEngine 模式生效（mode=${el.mode} exactSeek=${el.exactSeek}）`,
  el.mode === 'element' && el.exactSeek === false,
);
report.check(
  `③b ElementEngine 三次渲染都出帧（first=${el.first} second=${el.second} third=${el.third}）`,
  el.first === true && el.second === true && el.third === true,
);
report.check(
  `③c ElementEngine 画面非纯黑（非黑像素 ${el.nonBlackPixels}/${el.totalPixels}）`,
  typeof el.nonBlackPixels === 'number' && el.nonBlackPixels > el.totalPixels * 0.2,
);
const dis = out.dispose ?? {};
const after = dis.after ?? {};
report.check(
  `④a dispose 后会话与帧归零（openSessions=${after.openSessions} openFrames=${after.openFrames}）`,
  after.openSessions === 0 && after.openFrames === 0,
);
report.check(
  `④b dispose 前帧守恒（created-created === open：${dis.before?.totalCreated}-${dis.before?.totalClosed}=${(dis.before?.totalCreated ?? 0) - (dis.before?.totalClosed ?? 0)} vs open=${dis.before?.openFrames}）`,
  dis.before?.totalCreated - dis.before?.totalClosed === dis.before?.openFrames,
);

if (typeof out.png === 'string') {
  const shots = path.join(ROOT, 'tests', 'screenshots');
  fs.mkdirSync(shots, { recursive: true });
  fs.writeFileSync(path.join(shots, 't09-render137.png'), Buffer.from(out.png.split(',')[1], 'base64'));
  console.log('  · 实际渲染结果已存 tests/screenshots/t09-render137.png');
  console.log('  · 与各参考帧的差值：' + JSON.stringify(out.identity));
}

report.summary('T09 播放引擎验收');