/**
 * T16 时间线交互 E2E（真浏览器 + 真指针事件 + 真 canvas）。
 *
 * 验证：
 *   ① 拖动片段改 startFrame（整数帧）
 *   ⑥ 拖拽期间 React 不重渲染：pointerdown 前读 commitCount，pointerup 后增量 ≤ 1
 *   ⑧（部分）标尺 seek：点击标尺 → 播放头变化
 *
 * 运行：node tests/verify-t16.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEV_PORT = 5189;

function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
    const candidates = [
      path.join(ROOT, 'tests', 'fixtures', name),
      path.join(ROOT, 'tests', 'fixtures', 'hardline', name),
    ];
    const found = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
    if (!found) {
      response.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(found).pipe(response);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

async function startDevServer() {
  const child = spawn(process.execPath, ['scripts/dev.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(DEV_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dev server 10 秒内未就绪')), 10000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes(`127.0.0.1:${DEV_PORT}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => {
      if (String(chunk).includes('EADDRINUSE')) {
        clearTimeout(timer);
        reject(new Error(`端口 ${DEV_PORT} 被占用`));
      }
    });
  });
  return child;
}

const fixtures = await startFixtureServer();
const devServer = await startDevServer();
const page = await launchPage({ url: `http://127.0.0.1:${DEV_PORT}/`, width: 1440, height: 900 });
const report = createReport();

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 8000);

  // ---- 导入 + 上轨 ----
  await page.session.evaluate(`
    window.__drop = async (name) => {
      const response = await fetch('${fixtures.origin}/' + encodeURIComponent(name));
      const blob = await response.blob();
      const file = new File([blob], name, { type: 'video/mp4', lastModified: 1700000000000 });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      for (const type of ['dragenter', 'dragover', 'drop']) {
        document.body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
      }
      return true;
    };
    true;
  `);
  await page.session.evaluate("window.__drop('sample-720p.mp4'); true");
  await page.session.waitFor("document.querySelectorAll('[data-v=\"asset-card\"]').length === 1", 8000);
  await new Promise((resolve) => setTimeout(resolve, 600));
  await page.session.evaluate(`
    (async () => {
      const card = document.querySelector('[data-v="asset-card"]');
      card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      return true;
    })();
  `);

  // canvas 几何（内部尺寸 vs CSS 尺寸）
  const geom = await page.session.evaluate(`
    (() => {
      const canvas = document.querySelector('[data-v="timeline-canvas"]');
      const rect = canvas.getBoundingClientRect();
      return { width: canvas.width, height: canvas.height, cssW: rect.width, cssH: rect.height, left: rect.left, top: rect.top };
    })();
  `);
  const sx = geom.width / geom.cssW; // 内部/CSS 缩放
  const sy = geom.height / geom.cssH;

  // 片段在 V1（index 1），zoom=5，startFrame=0，duration 240 → 块 x∈[0,1200)，中心 x=600
  // 内部坐标 → CSS 坐标
  const clipCssX = geom.left + 600 / sx;
  const clipCssY = geom.top + (24 + 56 + 28) / sy; // 标尺 24 + V1 中心 28

  // 先点击选中片段（触发一次 commit），等稳定
  await page.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clipCssX, y: clipCssY, button: 'left', clickCount: 1 });
  await page.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clipCssX, y: clipCssY, button: 'left', clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 300));

  const baselineCommit = await page.session.evaluate('window.__VEDITOR_TEST__.commitCount');
  const baselineStart = await page.session.evaluate("window.__VEDITOR_TEST__.clips()[0]?.startFrame ?? -1");

  // ---- 拖动：pointerdown → move×3 → pointerup（内部 dx=100 → 20 帧）----
  const dxCss = 100 / sx;
  await page.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clipCssX, y: clipCssY, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 4; i += 1) {
    await page.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clipCssX + dxCss * (i / 4), y: clipCssY, button: 'left' });
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  await page.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clipCssX + dxCss, y: clipCssY, button: 'left', clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 400));

  const afterCommit = await page.session.evaluate('window.__VEDITOR_TEST__.commitCount');
  const afterStart = await page.session.evaluate("window.__VEDITOR_TEST__.clips()[0]?.startFrame ?? -1");

  report.check(
    `① 拖动改 startFrame（${baselineStart} → ${afterStart}）`,
    afterStart !== baselineStart && afterStart > 0 && Number.isInteger(afterStart),
  );
  report.check(
    `⑥ 拖拽期间 React 不重渲染（commitCount 增量 ${afterCommit - baselineCommit}，要求 ≤ 1）`,
    afterCommit - baselineCommit <= 1,
  );

  // ---- 标尺 seek（⑧ 部分）：点击标尺第 100 帧处（可视区内）----
  const rulerFrame = 100;
  const rulerCssX = geom.left + (rulerFrame * 5) / sx;
  const rulerCssY = geom.top + 12 / sy; // 标尺中部
  const beforeSeek = await page.session.evaluate('window.__VEDITOR_TEST__.playheadFrame()');
  await page.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rulerCssX, y: rulerCssY, button: 'left', clickCount: 1 });
  await page.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rulerCssX, y: rulerCssY, button: 'left', clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const afterSeek = await page.session.evaluate('window.__VEDITOR_TEST__.playheadFrame()');
  report.check(
    `⑧ 标尺 seek 播放头变化（${beforeSeek} → ${afterSeek}）`,
    afterSeek !== beforeSeek,
  );
} finally {
  await page.close();
  devServer.kill();
  await fixtures.close();
}

report.summary('T16 时间线交互 E2E');