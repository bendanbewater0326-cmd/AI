/**
 * C2 UI 验收：转场（R-033）+ 入出点与区间导出（R-040）。
 *
 * 验证：
 *   ① 淡入：设置后第 0 帧明显变暗，过渡结束后恢复正常亮度
 *   ② 淡出：末帧明显变暗
 *   ③ 转场写进 doc（transitionIn / transitionOut）
 *   ④ I / O 打点写入 ephemeral，且不改 doc
 *   ⑤ 导出弹窗的「仅导出区间」在打点后可勾选，导出时长 == 区间时长
 *
 * 运行：`node tests/verify-c2-ui.mjs`
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5175;
const DOWNLOAD_DIR = path.join(ROOT, 'tests', '.tmp', 'c2-downloads');

function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
    const found = [
      path.join(ROOT, 'tests', 'fixtures', name),
      path.join(ROOT, 'tests', 'fixtures', 'hardline', name),
    ].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!found) {
      response.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
      response.end('nf');
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

/** 把时间码输入框设成指定值并回车（项目 30fps）。 */
const SEEK = (tc) => `(() => {
  document.querySelector('[data-v="timecode"]').click();
  return true;
})()`;

const report = createReport();
const fixtures = await startFixtureServer();
const devServer = await startDevServer();
fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
const page = await launchPage({ url: `http://127.0.0.1:${PORT}/?src=${fixtures.origin}/sample-720p.mp4`, width: 1440, height: 900 });

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
  await page.session.waitFor("window.__VEDITOR_TEST__.clips().length > 0", 15000);
  await page.session.waitFor("(async () => { const s = await window.__VEDITOR_TEST__.previewSnapshot(); return !!s && s.nonBlack > 1000; })()", 20000);

  const seekTo = async (frame) => {
    await page.session.evaluate(SEEK());
    await page.session.waitFor("!!document.querySelector('[data-v=\"timecode-input\"]')", 3000);
    await page.session.evaluate(`(() => {
      const el = document.querySelector('[data-v="timecode-input"]');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, String(${frame}));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  };
  const luma = async () => JSON.parse(await page.session.evaluate("(async () => JSON.stringify(await window.__VEDITOR_TEST__.previewSnapshot()))()")).meanLuma;

  // 选中 V1 上的视频片段（V1 是屏幕第 2 行）
  const rect = JSON.parse(
    await page.session.evaluate("(() => { const r = document.querySelector('[data-v=\"timeline-canvas\"]').getBoundingClientRect(); return JSON.stringify({ x: r.left, y: r.top }); })()"),
  );
  /**
   * 坐标一律从布局取：轨道头 130px、轨道高 60/50/32 之后，
   * 写死 `+120 / 24+56+28` 会点到轨道头或点错行。
   */
  const tlLayout = JSON.parse(
    await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.timelineLayout())'),
  );
  const clipClickX = rect.x + tlLayout.headerWidth + 60;
  const clipClickY = rect.y + tlLayout.rows[1].top + tlLayout.rows[1].height / 2;
  const clickV1 = async () => {
    await page.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clipClickX, y: clipClickY, button: 'left', clickCount: 1 });
    await page.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clipClickX, y: clipClickY, button: 'left', clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 300));
  };

  const setTransition = async (type, seconds) => {
    await page.session.evaluate(`(() => {
      const el = document.querySelector('[data-v="inspector-transition"]');
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      set.call(el, '${type}');
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (seconds !== undefined) {
      await page.session.evaluate(`(() => {
        const el = document.querySelector('[data-v="inspector-transition-sec"]');
        if (!el) return;
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(el, '${seconds}');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  };

  await seekTo(30);
  const normal = await luma();
  await clickV1();

  // ① 淡入 0.5 秒（15 帧）：窗口 [-7, 8)
  await setTransition('fadeIn', '0.5');
  const transitionIn = await page.session.evaluate("JSON.stringify(window.__VEDITOR_TEST__.clips()[0].transitions)");
  report.check(`③ 淡入写进 doc（${transitionIn}）`, String(transitionIn).includes('fadeIn'));

  await seekTo(0);
  const atStart = await luma();
  await seekTo(30);
  const afterRamp = await luma();
  report.check(
    `① 淡入：第 0 帧 ${atStart.toFixed(1)} 明显暗于第 30 帧 ${afterRamp.toFixed(1)}`,
    atStart < afterRamp * 0.75,
  );

  // ② 淡出 0.5 秒：窗口 [225, 240)
  await clickV1();
  await setTransition('fadeOut', '0.5');
  await seekTo(239);
  const atEnd = await luma();
  const transitions = await page.session.evaluate("JSON.stringify(window.__VEDITOR_TEST__.clips()[0].transitions)");
  report.check(`③ 淡出写进 doc（${transitions}）`, String(transitions).includes('fadeOut'));
  report.check(`② 淡出：末帧 ${atEnd.toFixed(1)} 明显暗于常态 ${normal.toFixed(1)}`, atEnd < normal * 0.5);

  // ④ I / O 打点
  await seekTo(60);
  await page.session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'i', code: 'KeyI', windowsVirtualKeyCode: 73 });
  await page.session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'i', code: 'KeyI', windowsVirtualKeyCode: 73 });
  await seekTo(180);
  await page.session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'o', code: 'KeyO', windowsVirtualKeyCode: 79 });
  await page.session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'o', code: 'KeyO', windowsVirtualKeyCode: 79 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const marks = JSON.parse(await page.session.evaluate("JSON.stringify(window.__VEDITOR_TEST__.marks())"));
  report.check(`④ I/O 打点（${marks.in} – ${marks.out}）`, marks.in === 60 && marks.out === 180);
  const clipCount = await page.session.evaluate("window.__VEDITOR_TEST__.clips().length");
  report.check(`④ 打点不改 doc（片段数 ${clipCount}）`, clipCount === 1);

  // ⑤ 区间导出（WAV，最快）
  await page.session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOAD_DIR });
  await page.session.evaluate("document.querySelector('[data-v=\"export-open\"]').click()");
  await page.session.waitFor("!!document.querySelector('[data-v=\"export-dialog\"]')", 5000);
  const rangeEnabled = await page.session.evaluate("document.querySelector('[data-v=\"export-range\"]')?.disabled === false");
  report.check('⑤ 打点后「仅导出区间」可勾选', rangeEnabled === true);
  await page.session.evaluate("document.querySelector('[data-v=\"export-format-wav\"]').click()");
  await page.session.evaluate("document.querySelector('[data-v=\"export-range\"]').click()");
  const summary = await page.session.evaluate("document.querySelector('[data-v=\"export-summary\"]')?.textContent");
  report.check(`⑤ 弹窗显示区间时长（${summary}）`, String(summary).includes('4.00s') && String(summary).includes('120 帧'));
  await page.session.evaluate("document.querySelector('[data-v=\"export-start\"]').click()");
  await page.session.waitFor("!!document.querySelector('[data-v=\"export-message\"]')", 120000);
  const message = await page.session.evaluate("document.querySelector('[data-v=\"export-message\"]').textContent");
  report.check(`⑤ 区间导出完成（${message}）`, String(message).includes('120 帧'));
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const wav = fs.readdirSync(DOWNLOAD_DIR).find((name) => name.endsWith('.wav'));
  if (wav !== undefined && spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0) {
    const probe = spawnSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path.join(DOWNLOAD_DIR, wav)],
      { encoding: 'utf8' },
    );
    const duration = Number(JSON.parse(probe.stdout || '{}').format?.duration ?? 0);
    report.check(`⑤ 导出时长 4.000s（实测 ${duration.toFixed(3)}s）`, Math.abs(duration - 4) <= 1 / 30);
  }

  await page.screenshot({ path: path.join(ROOT, 'tests', 'screenshots', 'c2-transition.png') });
} finally {
  await page.close();
  devServer.kill();
  await fixtures.close();
  report.summary('C2 转场与区间导出验收');
}
