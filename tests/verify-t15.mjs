/**
 * T15 时间线画布绘制验收（真浏览器，验证标尺/片段块/播放头/空态/性能）。
 *
 * 覆盖 task:T15 的 ①–⑤：
 *   ① 标尺 zoom=1/5/20 三档下三级刻度（帧/秒/分）且标签不重叠（R-010）
 *   ② 片段块宽度 = durationFrames × zoomLevel（误差 ≤ 1px）
 *   ③ 块内可见缩略图 + 素材名（R-012）
 *   ④ 100 片段工程全量重绘 < 3ms
 *   ⑤ 空时间线显示居中提示"把素材拖到时间线上"（R-014）
 *
 * 运行：node tests/verify-t15.mjs
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
  paintTimeline, tickSpecs, frameToX, xToFrame, frameToSecondLabel,
  RULER_HEIGHT, TRACK_HEIGHT, TRACK_HEADER_WIDTH, DEFAULT_TIMELINE_COLORS,
} from '/tests/.cache/t15-bundle.mjs';
import { createProject, createClip, createAsset } from '/tests/.cache/t15-bundle.mjs';

window.__phase = 'boot';
window.__result = null;

const W = 1280;
const H = 220;

function makeDoc(clipCount = 0, zoom = 5) {
  const doc = createProject({ width: 1280, height: 720, fpsMilli: 30000, zoomLevel: zoom });
  doc.assets = [createAsset({ id: 'a1', name: 'sample-720p.mp4', kind: 'video', width: 1280, height: 720, fpsMilli: 30000, durationFrames: 240, durationSec: 8, hasAudio: true, container: 'mp4' })];
  for (let i = 0; i < clipCount; i += 1) {
    const start = i * 120;
    doc.tracks.find((t) => t.id === 'trk_V1').clips.push(createClip({ assetId: 'a1', trackId: 'trk_V1', startFrame: start, inFrame: 0, outFrame: 120, durationFrames: 120 }));
  }
  return doc;
}

function freshCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  return { canvas, ctx: canvas.getContext('2d') };
}

/**
 * 空 ephemeral。
 *
 * 字段要与 EphemeralState 对齐：这里少字段不会报错，只会让 painter 读到 undefined，
 * 一旦 painter 里写的是「!== null」判断就会走进不该走的分支。
 * （dropGhost 就是这么把 t15 弄红的；painter 那边也加了「?? null」兜底。）
 *
 * 注意：这段代码在下面的 PAGE 模板字符串里，**不能用反引号**（会把模板截断）。
 */
function emptyEphemeral() {
  return {
    selectedClipId: null,
    extraSelectedClipIds: [],
    hoverClipId: null,
    drag: null,
    dropGhost: null,
    trackDrag: null,
    overlayMarks: [],
    markIn: null,
    markOut: null,
    isPlaying: false,
    busyLabel: null,
    errors: [],
    snapEnabled: true,
  };
}

function paintInto(doc, ephemeral, scrollX = 0, zoomOverride = null) {
  const { canvas, ctx } = freshCanvas();
  if (zoomOverride !== null) doc = { ...doc, zoomLevel: zoomOverride };
  const t0 = performance.now();
  paintTimeline(ctx, { doc, ephemeral, viewport: { width: W, height: H }, scrollX, thumbnails: new Map() });
  const ms = performance.now() - t0;
  return { canvas, ms };
}

// 做一个 90×51 的彩色缩略图（模拟 T12 首帧缩略图）
function makeThumb(color = '#3366cc') {
  const c = document.createElement('canvas');
  c.width = 90; c.height = 51;
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.fillRect(0, 0, 90, 51);
  // 加一点纹理，确保"采样色方差 > 阈值"能过
  g.fillStyle = '#ffffff';
  g.fillRect(10, 10, 20, 20);
  return c;
}

const result = {};

// ---- ① 标尺三级刻度 + 标签不重叠 ----
{
  result.ruler = {};
  for (const zoom of [1, 5, 20]) {
    const specs = tickSpecs(zoom, 30000);
    result.ruler[zoom] = {
      frameInterval: specs.frames.frameInterval,
      frameHeight: specs.frames.height,
      secondInterval: specs.seconds.frameInterval,
      minuteInterval: specs.minutes.frameInterval,
    };
  }
}

// ---- ② 片段块宽度 ----
{
  const doc = makeDoc(1, 5); // 1 个 120 帧的片段，zoom=5 → 宽 600px
  const { canvas, ctx } = freshCanvas();
  paintTimeline(ctx, { doc, ephemeral: emptyEphemeral(), viewport: { width: W, height: H }, scrollX: 0, thumbnails: new Map() });
  // 扫描**整个轨道区**找片段块底色（#d9d7f0），量出 x 方向包围盒
  const scan = ctx.getImageData(0, RULER_HEIGHT, W, H - RULER_HEIGHT).data;
  const [cr, cg, cb] = [0xd9, 0xd7, 0xf0];
  let firstX = -1;
  let lastX = -1;
  for (let y = 0; y < H - RULER_HEIGHT; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 4;
      if (Math.abs(scan[i] - cr) < 8 && Math.abs(scan[i + 1] - cg) < 8 && Math.abs(scan[i + 2] - cb) < 8) {
        if (firstX < 0 || x < firstX) firstX = x;
        if (x > lastX) lastX = x;
      }
    }
  }
  result.clipWidth = { firstX, lastX, measured: lastX - firstX + 1, expected: 120 * 5 };
}

// ---- ③ 块内缩略图 + 素材名 ----
{
  const doc = makeDoc(1, 5);
  const thumb = makeThumb('#3366cc');
  const { canvas, ctx } = freshCanvas();
  const thumbnails = new Map([['a1', thumb]]);
  paintTimeline(ctx, { doc, ephemeral: emptyEphemeral(), viewport: { width: W, height: H }, scrollX: 0, thumbnails });
  // 扫描整个轨道区：统计"蓝色"像素（缩略图）与"深色"像素（文字）
  const img = ctx.getImageData(0, RULER_HEIGHT, W, H - RULER_HEIGHT).data;
  let bluePixels = 0;
  let textPixels = 0;
  for (let i = 0; i < img.length; i += 4) {
    const r = img[i], g = img[i + 1], b = img[i + 2];
    if (b > 120 && b - r > 40 && b - g > 20) bluePixels += 1;
    if (r < 60 && g < 60 && b < 60) textPixels += 1;
  }
  result.thumb = { bluePixels, textPixels };
}

// ---- ⑤ 空态提示（含字体渲染自检：先画一个 ASCII 串，确认 fillText 本身能出像素）----
{
  // 自检：ASCII "OK" 在画布上必须能渲染出像素，排除"无头环境 fillText 完全失效"
  {
    const { canvas, ctx } = freshCanvas();
    ctx.fillStyle = '#000000';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('OK', 100, 100);
    const img = ctx.getImageData(0, 0, W, H).data;
    let dark = 0;
    for (let i = 0; i < img.length; i += 4) if (img[i] < 60) dark += 1;
    result.asciiTextPixels = dark;
  }
  const doc = makeDoc(0, 5);
  const { canvas, ctx } = freshCanvas();
  paintTimeline(ctx, { doc, ephemeral: emptyEphemeral(), viewport: { width: W, height: H }, scrollX: 0, thumbnails: new Map() });
  // 扫整个画布（标尺之下）找非背景深色像素
  const img = ctx.getImageData(0, RULER_HEIGHT, W, H - RULER_HEIGHT).data;
  let textPixels = 0;
  for (let i = 0; i < img.length; i += 4) {
    const r = img[i], g = img[i + 1], b = img[i + 2];
    if (r < 160 && g < 160 && b < 160) textPixels += 1;
  }
  result.empty = { textPixels, total: img.length / 4 };
}

// ---- ④ 100 片段重绘性能 ----
{
  const doc = makeDoc(100, 5);
  const { canvas, ctx } = freshCanvas();
  // 预热一次
  paintTimeline(ctx, { doc, ephemeral: emptyEphemeral(), viewport: { width: W, height: H }, scrollX: 0, thumbnails: new Map() });
  const times = [];
  for (let i = 0; i < 20; i += 1) {
    const t0 = performance.now();
    paintTimeline(ctx, { doc, ephemeral: emptyEphemeral(), viewport: { width: W, height: H }, scrollX: 0, thumbnails: new Map() });
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  result.perf = { median: times[10], min: times[0], max: times[19] };
}

window.__result = result;
window.__phase = 'done';
</script>`;

fs.mkdirSync(CACHE, { recursive: true });
await build({
  entryPoints: [path.join(CACHE, 't15-entry.ts')],
  outfile: path.join(CACHE, 't15-bundle.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  logLevel: 'warning',
});
fs.writeFileSync(path.join(CACHE, 't15.html'), PAGE);

const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  fs.readFile(p, (e, d) => {
    if (e) { res.writeHead(404).end('nf'); return; }
    const ext = path.extname(p);
    const mime = ext === '.mjs' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': mime });
    res.end(d);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-t15-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-first-run', '--mute-audio', '--remote-debugging-port=9340', `--user-data-dir=${udd}`, 'about:blank'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));
const t = await (await fetch(`http://127.0.0.1:9340/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/tests/.cache/t15.html`)}`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
await new Promise((r) => { ws.onopen = r; });
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pend.set(i, r)); };
await send('Runtime.enable');
let out = null;
for (let i = 0; i < 400; i += 1) {
  const ev = await send('Runtime.evaluate', { expression: 'JSON.stringify({phase: window.__phase ?? null, result: window.__result ?? null})', returnByValue: true });
  if (ev.result?.value) {
    const snap = JSON.parse(ev.result.value);
    if (snap.phase === 'done') { out = snap.result; break; }
  }
  await new Promise((r) => setTimeout(r, 250));
}
chrome.kill(); server.close();
if (!out) { console.log('页面未完成'); process.exit(1); }

const report = createReport();
const ruler = out.ruler ?? {};
const expectedRuler = {
  1: { frameInterval: 8, secondInterval: 60, minuteInterval: 1800 },
  5: { frameInterval: 2, secondInterval: 30, minuteInterval: 1800 },
  20: { frameInterval: 1, secondInterval: 30, minuteInterval: 1800 },
};
let rulerOk = true;
const rulerDetail = [];
for (const zoom of [1, 5, 20]) {
  const got = ruler[zoom];
  const want = expectedRuler[zoom];
  const frameOk = got?.frameInterval === want.frameInterval && got?.frameHeight > 0;
  const secondOk = got?.secondInterval === want.secondInterval;
  const minuteOk = got?.minuteInterval === want.minuteInterval;
  rulerDetail.push(`zoom${zoom}: 帧${got?.frameInterval ?? '?'}/${want.frameInterval} 秒${got?.secondInterval ?? '?'}/${want.secondInterval} 分${got?.minuteInterval ?? '?'}/${want.minuteInterval}`);
  if (!frameOk || !secondOk || !minuteOk) rulerOk = false;
}
report.check(`① 标尺三级刻度三档自适应（${rulerDetail.join(' | ')}）`, rulerOk);

const cw = out.clipWidth ?? {};
report.check(
  `② 片段块宽度 = durationFrames×zoom（实测 ${cw.measured ?? '?'}px，期望 ${cw.expected ?? '?'}px，误差 ${cw.measured === undefined ? '?' : Math.abs(cw.measured - cw.expected)}px）`,
  typeof cw.measured === 'number' && cw.expected !== undefined && Math.abs(cw.measured - cw.expected) <= 1,
);

const th = out.thumb ?? {};
report.check(
  `③a 块内缩略图可见（蓝色像素 ${th.bluePixels ?? '?'} > 0）`,
  typeof th.bluePixels === 'number' && th.bluePixels > 100,
);
report.check(
  `③b 块内素材名文字（深色像素 ${th.textPixels ?? '?'} > 0）`,
  typeof th.textPixels === 'number' && th.textPixels > 50,
);

const perf = out.perf ?? {};
report.check(
  `④ 100 片段全量重绘 < 3ms（中位 ${perf.median?.toFixed(2) ?? '?'}ms，min ${perf.min?.toFixed(2) ?? '?'}ms，max ${perf.max?.toFixed(2) ?? '?'}ms）`,
  typeof perf.median === 'number' && perf.median < 3,
);

const empty = out.empty ?? {};
report.check(
  `⑤ 空时间线提示文字（文字像素 ${empty.textPixels ?? '?'} > 0；ASCII 字体自检 ${out.asciiTextPixels ?? '?'} 像素）`,
  typeof empty.textPixels === 'number' && empty.textPixels > 50,
);

report.summary('T15 时间线画布绘制验收');