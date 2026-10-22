/**
 * C3 变速 E2E（真浏览器 + 真属性栏输入 + 真 dispatch）。
 *
 * 验证：
 *   ① 选中片段后速度显示 ×1
 *   ② 输入 2 → doc.speedMilli=2000、durationFrames 减半（240→120）
 *   ③ 时间线片段块宽度随变速缩短（视觉证据）
 *   ④ 撤销后回到 1x / 原时长
 *
 * 运行：node tests/verify-c3-ui.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEV_PORT = 5192;

function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
    const found = [path.join(ROOT, 'tests', 'fixtures', name), path.join(ROOT, 'tests', 'fixtures', 'hardline', name)]
      .find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
    if (!found) { response.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); response.end('nf'); return; }
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
    cwd: ROOT, env: { ...process.env, PORT: String(DEV_PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dev server 未就绪')), 10000);
    child.stdout.on('data', (chunk) => { if (String(chunk).includes(`127.0.0.1:${DEV_PORT}`)) { clearTimeout(timer); resolve(); } });
  });
  return child;
}

const fixtures = await startFixtureServer();
const devServer = await startDevServer();
const page = await launchPage({ url: `http://127.0.0.1:${DEV_PORT}/`, width: 1440, height: 900 });
const report = createReport();

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 8000);

  // 导入 + 上轨
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
  await new Promise((resolve) => setTimeout(resolve, 500));
  await page.session.evaluate("document.querySelector('[data-v=\"asset-card\"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true");
  await new Promise((resolve) => setTimeout(resolve, 300));

  // 选中片段
  const geom = await page.session.evaluate(`(() => { const c = document.querySelector('[data-v="timeline-canvas"]'); const r = c.getBoundingClientRect(); return { w: c.width, cw: r.width, ch: r.height, h: c.height, left: r.left, top: r.top }; })()`);
  const sx = geom.w / geom.cw;
  const sy = geom.h / geom.ch;
  const clipCssX = geom.left + 600 / sx;
  const clipCssY = geom.top + (24 + 56 + 28) / sy;
  await page.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clipCssX, y: clipCssY, button: 'left', clickCount: 1 });
  await page.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clipCssX, y: clipCssY, button: 'left', clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 300));

  // ① 选中后速度显示 ×1
  const speedShown = await page.session.evaluate("document.querySelector('[data-v=\"inspector-speed-value\"]')?.textContent");
  const before = await page.session.evaluate('window.__VEDITOR_TEST__.clips()[0]');
  report.check(
    `① 选中后速度显示（"${speedShown}"，speedMilli=${before?.speedMilli}，时长=${before?.durationFrames}）`,
    speedShown === '×1' && before?.speedMilli === 1000,
  );

  // ② 输入 2 → 变速。
  // **必须分两步**：input 事件先让 React 的 setSpeed('2') flush，再派发 Enter 触发 blur。
  // 同一同步块里连发的话，onBlur 闭包里的 `speed` 还是旧值 '1'，commitSpeed('1') 会被
  // "与当前相同" 短路掉——这正是第一版 E2E 假失败的原因。
  await page.session.evaluate(`
    (() => {
      const input = document.querySelector('[data-v="inspector-speed"]');
      // 必须先聚焦：没焦点时 blur() 是空操作，onBlur 不会触发（真实用户是先点进去的）
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '2');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })();
  `);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await page.session.evaluate(`
    (() => {
      const input = document.querySelector('[data-v="inspector-speed"]');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })();
  `);
  await new Promise((resolve) => setTimeout(resolve, 400));

  const after = await page.session.evaluate('window.__VEDITOR_TEST__.clips()[0]');
  report.check(
    `② 输入 2 → speedMilli=${after?.speedMilli}（期望 2000）`,
    after?.speedMilli === 2000,
  );
  report.check(
    `②b 时长减半（${before?.durationFrames} → ${after?.durationFrames}，期望 120）`,
    after?.durationFrames === 120,
  );
  report.check(
    `②c 素材起止点不动（in=${after?.inFrame} out=${after?.outFrame}）`,
    after?.inFrame === 0 && after?.outFrame === 240,
  );

  // ③ 时间线块宽度缩短（截图为视觉证据）
  const shot = await page.session.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.join(ROOT, 'tests', 'screenshots'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'tests', 'screenshots', 'c3-speed2.png'), Buffer.from(shot.data, 'base64'));

  // ④ 撤销回 1x
  await page.session.evaluate("document.querySelector('[data-v=\"app\"]') && window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })); true");
  await new Promise((resolve) => setTimeout(resolve, 400));
  const undone = await page.session.evaluate('window.__VEDITOR_TEST__.clips()[0]');
  report.check(
    `④ 撤销回到 1x（speedMilli=${undone?.speedMilli}，时长=${undone?.durationFrames}）`,
    undone?.speedMilli === 1000 && undone?.durationFrames === 240,
  );
} finally {
  await page.close();
  devServer.kill();
  await fixtures.close();
}

report.summary('C3 变速 E2E');