/**
 * T05 缩略图验收（**真浏览器 + WebCodecs**，Node 无 `VideoDecoder` 故必须走浏览器）。
 *
 * 流程：
 *   1. esbuild 把 `src/media/mediaProbe.ts` 打成浏览器 ESM；
 *   2. 起一个只读静态 server（`127.0.0.1`，不对外）；
 *   3. 无头 Chrome（`--headless=new`）加载页面，页面里 fetch mp4 → `File` → `probeAsset()`
 *      → 真实 `VideoDecoder` 解首帧 → 90×51 缩略图；
 *   4. 与 `tests/tests/fixtures/ref/*.png` 同口径缩到 90×51 后比对：
 *      **平均通道差 ≤ 15**、**8×8 分块每块平均差 ≤ 35**，失败逐块打印。
 *
 * 运行：`node tests/verify-t05-thumb.mjs`
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE_DIR = path.join(ROOT, 'tests', '.cache');
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.png': 'image/png',
};

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('未找到 Chrome / Edge 可执行文件');
}

async function bundleForBrowser() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const entry = path.join(CACHE_DIR, 'thumb-entry.ts');
  fs.writeFileSync(entry, "export { probeAsset } from '../../src/media/mediaProbe';\n", 'utf8');
  const outfile = path.join(CACHE_DIR, 'media-browser.mjs');
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'warning',
  });
  return '/tests/.cache/media-browser.mjs';
}

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>t05-thumb</title>
<script type="module">
import { probeAsset } from '__BUNDLE__';

const THUMB_W = 90;
const THUMB_H = 51;
const BLOCK = 8;
const MEAN_THRESHOLD = 15;
const BLOCK_THRESHOLD = 35;

/** 把任意 ImageBitmap 按 area 平均缩到 90×51 并取 RGBA。 */
function toPixels(bitmap) {
  const canvas = new OffscreenCanvas(THUMB_W, THUMB_H);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, THUMB_W, THUMB_H);
  return ctx.getImageData(0, 0, THUMB_W, THUMB_H).data;
}

async function fetchBlob(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(url + ' HTTP ' + response.status);
  return response.blob();
}

/** 逐像素 / 逐 8×8 块比对。 */
function compare(actual, reference) {
  let sum = 0;
  let maxChannel = 0;
  for (let i = 0; i < actual.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      const diff = Math.abs(actual[i + c] - reference[i + c]);
      sum += diff;
      if (diff > maxChannel) maxChannel = diff;
    }
  }
  const mean = sum / (THUMB_W * THUMB_H * 3);

  const blocks = [];
  let maxBlock = 0;
  for (let by = 0; by * BLOCK < THUMB_H; by += 1) {
    for (let bx = 0; bx * BLOCK < THUMB_W; bx += 1) {
      const y0 = by * BLOCK;
      const x0 = bx * BLOCK;
      const y1 = Math.min(THUMB_H, y0 + BLOCK);
      const x1 = Math.min(THUMB_W, x0 + BLOCK);
      let blockSum = 0;
      let count = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const offset = (y * THUMB_W + x) * 4;
          for (let c = 0; c < 3; c += 1) blockSum += Math.abs(actual[offset + c] - reference[offset + c]);
          count += 3;
        }
      }
      const blockMean = blockSum / count;
      if (blockMean > maxBlock) maxBlock = blockMean;
      if (blockMean > BLOCK_THRESHOLD) blocks.push({ x: bx, y: by, value: Math.round(blockMean * 10) / 10 });
    }
  }
  return {
    mean: Math.round(mean * 100) / 100,
    maxChannel,
    maxBlock: Math.round(maxBlock * 10) / 10,
    failedBlocks: blocks,
    ok: mean <= MEAN_THRESHOLD && blocks.length === 0,
  };
}

async function run() {
  const cases = [
    { label: 'sample-720p.mp4', source: '/tests/fixtures/sample-720p.mp4', ref: '/tests/fixtures/ref/ref_000.png' },
    { label: 'longgop.mp4', source: '/tests/fixtures/compat/longgop.mp4', ref: '/tests/fixtures/ref/ref_longgop_0.png' },
    { label: 'hevc.mp4（诊断，不参与硬断言）', source: '/tests/fixtures/compat/hevc.mp4', ref: null },
  ];
  const results = [];
  for (const item of cases) {
    const entry = { label: item.label, thumb: null, compare: null, error: null };
    try {
      const blob = await fetchBlob(item.source);
      const file = new File([blob], item.source.split('/').pop(), { type: 'video/mp4' });
      const probed = await probeAsset(file);
      if (!probed.ok) {
        entry.error = probed.error.code + ' / ' + probed.error.message + ' / ' + (probed.error.detail || '');
      } else {
        const thumbnail = probed.value.thumbnail;
        if (thumbnail === null) {
          entry.error = 'thumbnail === null（WebCodecs 不可用或首帧解码失败）';
        } else {
          entry.thumb = { width: thumbnail.width, height: thumbnail.height };
          entry.meta = {
            codecVideo: probed.value.asset.codecVideo,
            fpsMilli: probed.value.asset.fpsMilli,
            durationFrames: probed.value.asset.durationFrames,
            hasAudio: probed.value.asset.hasAudio,
          };
          if (item.ref !== null) {
            const refBitmap = await createImageBitmap(await fetchBlob(item.ref));
            entry.refSize = { width: refBitmap.width, height: refBitmap.height };
            entry.compare = compare(toPixels(thumbnail), toPixels(refBitmap));
            refBitmap.close();
          }
          thumbnail.close();
        }
      }
    } catch (error) {
      entry.error = String(error && error.stack ? error.stack : error);
    }
    results.push(entry);
  }
  return {
    webCodecs: typeof VideoDecoder !== 'undefined',
    secureContext: window.isSecureContext,
    results,
  };
}

run()
  .then((value) => { window.__thumbResult = value; })
  .catch((error) => { window.__thumbResult = { fatal: String(error && error.stack ? error.stack : error) }; });
</script>
`;

function startServer(bundleUrl) {
  const pagePath = path.join(CACHE_DIR, 'thumb.html');
  fs.writeFileSync(pagePath, PAGE.replace('__BUNDLE__', bundleUrl), 'utf8');
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const relative = decodeURIComponent(url.pathname);
    const filePath = path.join(ROOT, relative);
    if (!filePath.startsWith(ROOT)) {
      response.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(filePath, (error, data) => {
      if (error) {
        response.writeHead(404).end('not found');
        return;
      }
      response.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
      response.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function waitForDevTools(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('DevTools 端口未就绪');
}

/** 极简 CDP 客户端（Node 内置 WebSocket，无需 playwright）。 */
function createCdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  };
  const ready = new Promise((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = (event) => reject(new Error(`CDP WebSocket 错误 ${String(event.type)}`));
  });
  const send = (method, params = {}) => {
    const id = (nextId += 1);
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  return { ready, send, close: () => socket.close() };
}

async function main() {
  const bundleUrl = await bundleForBrowser();
  const server = await startServer(bundleUrl);
  const port = server.address().port;
  const pageUrl = `http://127.0.0.1:${port}/tests/.cache/thumb.html`;
  const debugPort = 9333;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veditor-thumb-'));
  const chrome = spawn(
    findChrome(),
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--mute-audio',
      '--hide-scrollbars',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let exitCode = 0;
  try {
    await waitForDevTools(debugPort);
    const targetResponse = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(pageUrl)}`, {
      method: 'PUT',
    });
    const target = await targetResponse.json();
    const cdp = createCdp(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');

    const deadline = Date.now() + 90000;
    let payload = null;
    while (Date.now() < deadline) {
      const evaluated = await cdp.send('Runtime.evaluate', {
        expression: 'window.__thumbResult === undefined ? null : JSON.stringify(window.__thumbResult)',
        returnByValue: true,
        awaitPromise: true,
      });
      const raw = evaluated.result ? evaluated.result.value : null;
      if (typeof raw === 'string' && raw.length > 0) {
        payload = JSON.parse(raw);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    cdp.close();
    if (payload === null) throw new Error('页面 90s 内未产出结果');
    if (payload.fatal) throw new Error(payload.fatal);

    console.log(`WebCodecs=${payload.webCodecs} secureContext=${payload.secureContext}`);
    for (const entry of payload.results) {
      if (entry.error) {
        console.error(`✗ ${entry.label} ${entry.error}`);
        exitCode = 1;
        continue;
      }
      const meta = entry.meta ?? {};
      console.log(
        `  ${entry.label} codec=${meta.codecVideo} fps=${meta.fpsMilli} frames=${meta.durationFrames} ` +
          `thumb=${entry.thumb.width}×${entry.thumb.height} ref=${entry.refSize ? `${entry.refSize.width}×${entry.refSize.height}` : 'n/a'}`,
      );
      if (entry.compare) {
        const { mean, maxChannel, maxBlock, failedBlocks, ok } = entry.compare;
        console.log(`    平均通道差=${mean}（阈值 15）  单通道最大差=${maxChannel}  分块最大差=${maxBlock}（阈值 35）`);
        if (!ok) {
          exitCode = 1;
          for (const block of failedBlocks) {
            console.error(`    block(${block.x},${block.y}) actual=${block.value} threshold=35`);
          }
          if (failedBlocks.length === 0) console.error('    （块全部通过，但平均通道差超阈值）');
        } else {
          console.log('    ✓ 缩略图与参考帧一致（面积平均 90×51）');
        }
      } else {
        console.log('    （诊断用例，无参考帧）');
      }
    }
  } finally {
    chrome.kill();
    server.close();
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Windows 上 Chrome 可能仍占用 profile，忽略
    }
  }
  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error('缩略图验证失败：', error);
  process.exitCode = 1;
});
