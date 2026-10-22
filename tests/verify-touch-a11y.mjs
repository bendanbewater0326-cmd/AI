/**
 * 触屏适配 + 无障碍端到端验证（R-063 / R-064）。
 *
 * ## R-063 的验收口径是"能完成 P0 操作"，不是"看起来没坏"
 *
 * 所以这里在 820×1180（iPad 竖屏）下真的去做：加文本、点播放、**用触摸事件拖播放头**，
 * 并断言关键控件都在视口内、页面没有横向溢出。
 *
 * ## R-064 的验收口径是"读屏能听到"+"高对比真的换了颜色"
 *
 * - aria-live 区域必须在**播放头/选中变化后**更新成可读的时间码与片段名；
 * - 高对比主题切换后 `data-theme` 属性存在、`.v-app` 的计算背景变黑，
 *   且**尺寸不变**（高对比不该让用户重新找按钮）。
 *
 * 运行：node tests/verify-touch-a11y.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5215;
const FIXTURE = 'sample-720p.mp4';

function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
    const found = [
      path.join(ROOT, 'tests', 'fixtures', 'compat', name),
      path.join(ROOT, 'tests', 'fixtures', name),
      path.join(ROOT, 'tests', 'fixtures', 'hardline', name),
    ].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!found) {
      response.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
      response.end('not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(found).pipe(response);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function startDevServer() {
  const child = spawn(process.execPath, ['scripts/dev.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dev server 未就绪')), 15000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes(`127.0.0.1:${PORT}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return child;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const report = createReport();
const fixture = await startFixtureServer();
const dev = await startDevServer();
// iPad 竖屏尺寸：验证"≥768px 全部 P0 操作可完成"
const page = await launchPage({
  url: `http://127.0.0.1:${PORT}/?src=${fixture.origin}/${FIXTURE}`,
  width: 820,
  height: 1180,
});

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 15000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 25000);

  // ---- ① 布局：无横向溢出、四区都在视口内 ----
  const layout = JSON.parse(
    await page.session.evaluate(`(() => {
      const rect = (selector) => {
        const el = document.querySelector(selector);
        if (el === null) return null;
        const box = el.getBoundingClientRect();
        return { x: box.x, y: box.y, w: box.width, h: box.height, inView: box.x >= 0 && box.y >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1 };
      };
      return JSON.stringify({
        innerWidth,
        innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        canvas: rect('[data-v="timeline-canvas"]'),
        // 时间线的**可视区**是滚动容器：轨道变多/变高时画布会比它高，靠滚动访问
        timelineViewport: rect('[data-v="timeline-scroll"]'),
        assetAdd: rect('[data-v="asset-add"]') ?? rect('[data-v="asset-empty"]'),
        play: rect('[data-v="play-toggle"]'),
        exportButton: rect('[data-v="export-open"]'),
      });
    })()`),
  );
  report.check(
    `① 820px 下无横向溢出（scrollWidth ${layout.scrollWidth} ≤ ${layout.innerWidth}）`,
    layout.scrollWidth <= layout.innerWidth,
  );
  report.check(
    `① 时间线可视区在视口内（可视 ${Math.round(layout.timelineViewport?.w ?? 0)}×${Math.round(layout.timelineViewport?.h ?? 0)}，画布 ${Math.round(layout.canvas?.w ?? 0)}×${Math.round(layout.canvas?.h ?? 0)} 可滚动）`,
    layout.timelineViewport !== null && layout.timelineViewport.inView && layout.timelineViewport.w > 400,
  );
  report.check(
    `① 播放/导入/导出三个入口都在视口内`,
    layout.play?.inView === true && layout.assetAdd?.inView === true && layout.exportButton?.inView === true,
  );

  // ---- ② P0 操作：加文本 ----
  const before = await page.session.evaluate('window.__VEDITOR_TEST__.clips().length');
  await page.session.evaluate(`document.querySelector('[data-v="add-text"]').click()`);
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === ${before + 1}`, 5000);
  report.check('② 窄屏下「＋ 文本」可用（片段 +1）', true);

  // ---- ③ 触摸拖动播放头（pointer/touch 路径） ----
  const canvas = JSON.parse(
    await page.session.evaluate(`(() => {
      const box = document.querySelector('[data-v="timeline-canvas"]').getBoundingClientRect();
      return JSON.stringify({ x: box.x, y: box.y, w: box.width, h: box.height });
    })()`),
  );
  const rulerY = canvas.y + 12;
  // 起点必须越过轨道头那一列（130px），否则 x 落在头部 → seek 被夹到第 0 帧
  const headerWidth = await page.session.evaluate('window.__VEDITOR_TEST__.timelineLayout().headerWidth');
  await page.session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: canvas.x + headerWidth + 60, y: rulerY }],
  });
  await page.session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: canvas.x + headerWidth + 260, y: rulerY }],
  });
  await page.session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(400);
  const playheadAfterTouch = await page.session.evaluate('window.__VEDITOR_TEST__.playheadFrame()');
  report.check(`③ 触摸拖动标尺能移动播放头（第 ${playheadAfterTouch} 帧）`, playheadAfterTouch > 5);

  // ---- ④ 播放：点一下就走 ----
  await page.session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: canvas.x + 40,
    y: canvas.y - 60,
    button: 'left',
    clickCount: 1,
  });
  await page.session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: canvas.x + 40,
    y: canvas.y - 60,
    button: 'left',
    clickCount: 1,
  });
  await sleep(300);

  // ---- ⑤ aria-live：时间码 + 片段名 ----
  const a11y = JSON.parse(
    await page.session.evaluate(`(() => {
      const el = document.querySelector('[data-v="a11y-status"]');
      return JSON.stringify({ exists: el !== null, role: el?.getAttribute('role'), live: el?.getAttribute('aria-live'), text: el?.textContent ?? '' });
    })()`),
  );
  report.check(
    `⑤ 存在 aria-live 播报区（role=${a11y.role} / ${a11y.live}）`,
    a11y.exists && a11y.role === 'status' && a11y.live === 'polite',
  );

  // 选中片段后播报里应出现素材名
  const clipId = await page.session.evaluate('window.__VEDITOR_TEST__.clips()[0].id');
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(clipId)})`);
  await sleep(700);
  const selectedText = await page.session.evaluate(
    `document.querySelector('[data-v="a11y-status"]').textContent`,
  );
  report.check(
    `⑤ 选中后播报含片段名（"${String(selectedText).slice(0, 32)}"）`,
    /sample-720p|文字片段/.test(String(selectedText)),
  );

  // 播放头移动后播报里的时间码要跟着变
  const beforeText = String(selectedText);
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(null)`);
  await sleep(200);
  await page.session.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'ArrowRight',
    code: 'ArrowRight',
    windowsVirtualKeyCode: 39,
  });
  await page.session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'ArrowRight',
    code: 'ArrowRight',
    windowsVirtualKeyCode: 39,
  });
  await sleep(700);
  const movedText = await page.session.evaluate(
    `document.querySelector('[data-v="a11y-status"]').textContent`,
  );
  report.check(
    `⑤ 播放头变化后播报更新（"${String(beforeText).slice(-12)}" → "${String(movedText).slice(-12)}"）`,
    /播放头\s*00:00:/.test(String(movedText)) && String(movedText) !== beforeText,
  );

  // ---- ⑥ 高对比主题 ----
  const beforeTheme = JSON.parse(
    await page.session.evaluate(`(() => {
      const app = document.querySelector('.v-app');
      const box = app.getBoundingClientRect();
      return JSON.stringify({ theme: document.documentElement.getAttribute('data-theme'), bg: getComputedStyle(app).backgroundColor, w: box.width, h: box.height });
    })()`),
  );
  await page.session.evaluate(`document.querySelector('[data-v="theme-toggle"]').click()`);
  await sleep(400);
  const afterTheme = JSON.parse(
    await page.session.evaluate(`(() => {
      const app = document.querySelector('.v-app');
      const box = app.getBoundingClientRect();
      return JSON.stringify({
        theme: document.documentElement.getAttribute('data-theme'),
        bg: getComputedStyle(app).backgroundColor,
        w: box.width,
        h: box.height,
        pressed: document.querySelector('[data-v="theme-toggle"]').getAttribute('aria-pressed'),
      });
    })()`),
  );
  report.check(
    `⑥ 高对比主题生效（data-theme=${afterTheme.theme}，背景 ${beforeTheme.bg} → ${afterTheme.bg}）`,
    afterTheme.theme === 'contrast' && afterTheme.bg === 'rgb(0, 0, 0)',
  );
  report.check(
    `⑥ 主题切换不改变布局（${beforeTheme.w}×${beforeTheme.h} → ${afterTheme.w}×${afterTheme.h}）`,
    afterTheme.w === beforeTheme.w && afterTheme.h === beforeTheme.h,
  );
  report.check('⑥ 按钮 aria-pressed 反映状态', afterTheme.pressed === 'true');

  // 切回默认
  await page.session.evaluate(`document.querySelector('[data-v="theme-toggle"]').click()`);
  await sleep(300);
  const backToDefault = await page.session.evaluate(
    `document.documentElement.getAttribute('data-theme')`,
  );
  report.check('⑥ 可以切回默认主题', backToDefault === null);

  await page.screenshot({ path: path.join(ROOT, 'tests', 'screenshots', 'touch-a11y.png') });

  const errors = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.errors())'));
  report.check(`⑦ 全程无页面错误（${JSON.stringify(errors)}）`, Array.isArray(errors) && errors.length === 0);

  report.summary('触屏适配 + 无障碍（R-063 / R-064）');
} finally {
  await page.close();
  dev.kill();
  await fixture.close();
}
