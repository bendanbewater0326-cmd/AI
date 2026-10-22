/**
 * M4 AI 层 E2E（真浏览器 + 真输入 + 真撤销栈）。
 *
 * 验证：
 *   ① `Ctrl+K` 唤起命令栏，**布局尺寸不变**（时间线高度、画布宽度与唤起前一致）
 *   ② 命令式输入 → 改 doc、弹 4 秒可撤销 toast；点「撤销」后完全还原
 *   ③ 提问式输入 → **不动 doc**，只写建议切点（overlayMarks），并给文字理由
 *   ④ 点「采纳」→ 建议变成真正的切分（一次撤销步）
 *   ⑤ `Esc` 关闭后 DOM 里没有命令栏、建议标记被清空
 *   ⑥ `?ai=off` → ✦ 置灰不可点（R-048 降级）
 *
 * 运行：`node tests/verify-m4-ai.mjs`
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5182;

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
    const timer = setTimeout(() => reject(new Error('dev server 未就绪')), 20000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes(`127.0.0.1:${PORT}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return child;
}

/** React 受控 input 必须走原生 setter + input 事件，直接赋 value 不触发 onChange。 */
const SET_INPUT = `(value) => {
  const el = document.querySelector('[data-v="command-input"]');
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}`;

/**
 * 输入 + 执行。
 *
 * **必须等按钮从 disabled 变可点再点**：`input` 事件里 setState 是异步的，
 * 紧接着 click 时 `disabled` 还是 true（`text.trim() === ''`），点击被浏览器吞掉——
 * 表现就是"什么都没发生"，然后 15 秒后超时。机器越慢越容易撞上（本机实测约 1/3 概率）。
 */
async function runCommand(page, text) {
  await page.session.evaluate(`(${SET_INPUT})(${JSON.stringify(text)})`);
  await page.session.waitFor(`document.querySelector('[data-v="command-run"]')?.disabled === false`, 10000);
  await page.session.evaluate(`document.querySelector('[data-v="command-run"]').click()`);
}

const report = createReport();
const fixtures = await startFixtureServer();
const devServer = await startDevServer();

try {
  // ---------------- 主流程 ----------------
  const page = await launchPage({ url: `http://127.0.0.1:${PORT}/?src=${fixtures.origin}/sample-720p.mp4`, width: 1440, height: 900 });
  try {
    await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 20000);
    await page.session.waitFor("window.__VEDITOR_TEST__.clips().length > 0", 20000);

    const layoutBefore = await page.session.evaluate(`(() => {
      const tl = document.querySelector('[data-v="timeline"]').getBoundingClientRect();
      const cv = document.querySelector('[data-v="timeline-canvas"]').getBoundingClientRect();
      return JSON.stringify({ h: tl.height, w: cv.width, top: tl.top });
    })()`);

    // ① Ctrl+K
    await page.session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
    await page.session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
    await page.session.waitFor("!!document.querySelector('[data-v=\"command-bar\"]')", 5000);
    const layoutAfter = await page.session.evaluate(`(() => {
      const tl = document.querySelector('[data-v="timeline"]').getBoundingClientRect();
      const cv = document.querySelector('[data-v="timeline-canvas"]').getBoundingClientRect();
      return JSON.stringify({ h: tl.height, w: cv.width, top: tl.top });
    })()`);
    report.check(`① Ctrl+K 唤起命令栏，布局不变（${layoutBefore} → ${layoutAfter}）`, layoutBefore === layoutAfter);

    const privacy = await page.session.evaluate("document.querySelector('[data-v=\"command-privacy\"]')?.textContent ?? ''");
    report.check(`① 隐私说明可见（${privacy.slice(0, 24)}…）`, privacy.includes('将发送') && privacy.includes('不上传素材'));

    // ② 命令式：剪掉开头 3 秒（90 帧）
    const before = await page.session.evaluate("JSON.stringify(window.__VEDITOR_TEST__.clips()[0])");
    await runCommand(page, '剪掉开头 3 秒');
    await page.session.waitFor("!!document.querySelector('[data-v=\"toast\"]')", 20000);
    const toastLabel = await page.session.evaluate("document.querySelector('[data-v=\"toast\"]')?.textContent ?? ''");
    const afterClip = await page.session.evaluate("JSON.stringify(window.__VEDITOR_TEST__.clips()[0])");
    const beforeObj = JSON.parse(before);
    const afterObj = JSON.parse(afterClip);
    report.check(
      `② 执行模式改了时长（${beforeObj.durationFrames} → ${afterObj.durationFrames}，期望 150）`,
      afterObj.durationFrames === 150,
    );
    report.check(`② toast 含可读描述（${toastLabel.replace(/\s+/g, ' ').trim()}）`, toastLabel.includes('剪掉开头'));
    report.check('② 命令栏已自动关闭（不留聊天记录）', (await page.session.evaluate("!!document.querySelector('[data-v=\"command-bar\"]')")) === false);

    // 撤销
    await page.session.evaluate("document.querySelector('[data-v=\"toast-undo\"]').click()");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const restored = await page.session.evaluate("window.__VEDITOR_TEST__.clips()[0].durationFrames");
    report.check(`② 点撤销后完全还原（${restored} 帧）`, restored === 240);
    report.check('② toast 点撤销后消失', (await page.session.evaluate("!!document.querySelector('[data-v=\"toast\"]')")) === false);

    // ③ 提问式：这里为什么要切
    await page.session.evaluate("window.__VEDITOR_TEST__.playheadFrame()");
    await page.session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
    await page.session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
    await page.session.waitFor("!!document.querySelector('[data-v=\"command-input\"]')", 10000);
    // 先把播放头移到片段中间（120 帧），建议切点才有意义
    await page.session.evaluate("document.querySelector('[data-v=\"timecode\"]').click()");
    await page.session.waitFor("!!document.querySelector('[data-v=\"timecode-input\"]')", 3000);
    await page.session.evaluate(`(() => {
      const el = document.querySelector('[data-v="timecode-input"]');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, '00:00:04:00');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const clipBeforeSuggest = await page.session.evaluate("JSON.stringify(window.__VEDITOR_TEST__.clips())");
    await runCommand(page, '这里为什么要切');
    await page.session.waitFor("!!document.querySelector('[data-v=\"command-suggestion\"]')", 20000);
    const suggestionText = await page.session.evaluate("document.querySelector('[data-v=\"command-suggestion\"]')?.textContent ?? ''");
    const marks = await page.session.evaluate("JSON.stringify(window.__VEDITOR_TEST__.overlayMarks())");
    const clipAfterSuggest = await page.session.evaluate("JSON.stringify(window.__VEDITOR_TEST__.clips())");
    report.check(`③ 建议模式给出文字理由（${suggestionText.slice(0, 20)}…）`, suggestionText.length > 20);
    report.check(`③ 建议模式写了切点标记（${marks}）`, JSON.parse(marks).length > 0);
    report.check('③ 建议模式**没有**改 doc', clipBeforeSuggest === clipAfterSuggest);

    // ④ 采纳
    await page.session.evaluate("document.querySelector('[data-v=\"command-accept\"]').click()");
    await new Promise((resolve) => setTimeout(resolve, 400));
    const clipCount = await page.session.evaluate("window.__VEDITOR_TEST__.clips().length");
    report.check(`④ 采纳后切分生效（${clipCount} 段）`, clipCount === 2);
    report.check('④ 采纳后标记被清空', (await page.session.evaluate("JSON.stringify(window.__VEDITOR_TEST__.overlayMarks())")) === '[]');

    // ⑤ Esc 关闭（再开一次，只问不采纳）
    // 播放头必须先落在某个片段**内部**：切分之后第 120 帧正好是接缝，那里没有"建议切点"可言
    await page.session.evaluate("document.querySelector('[data-v=\"timecode\"]').click()");
    await page.session.waitFor("!!document.querySelector('[data-v=\"timecode-input\"]')", 3000);
    await page.session.evaluate(`(() => {
      const el = document.querySelector('[data-v="timecode-input"]');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, '00:00:05:00');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await page.session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
    await page.session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
    await page.session.waitFor("!!document.querySelector('[data-v=\"command-input\"]')", 10000);
    await runCommand(page, '这里建议在哪里切');
    await page.session.waitFor("!!document.querySelector('[data-v=\"command-suggestion\"]')", 20000);
    const marksBeforeEsc = await page.session.evaluate("window.__VEDITOR_TEST__.overlayMarks().length");
    await page.session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    report.check(`⑤ Esc 关闭：命令栏消失（DOM ${await page.session.evaluate("!!document.querySelector('[data-v=\"command-bar\"]')")}）`, (await page.session.evaluate("!!document.querySelector('[data-v=\"command-bar\"]')")) === false);
    report.check(`⑤ Esc 前确实有建议标记（${marksBeforeEsc} 个）`, marksBeforeEsc > 0);
    report.check('⑤ Esc 关闭：建议标记清空', (await page.session.evaluate("window.__VEDITOR_TEST__.overlayMarks().length")) === 0);

    await page.screenshot({ path: path.join(ROOT, 'tests', 'screenshots', 'm4-ai.png') });
  } finally {
    await page.close();
  }

  // ---------------- 降级态（?ai=off） ----------------
  const page2 = await launchPage({ url: `http://127.0.0.1:${PORT}/?ai=off`, width: 1280, height: 800 });
  try {
    await page2.session.waitFor("!!window.__VEDITOR_TEST__", 20000);
    const disabled = await page2.session.evaluate("document.querySelector('[data-v=\"ai-open\"]')?.disabled");
    report.check(`⑥ ?ai=off 时 ✦ 置灰（disabled=${disabled}）`, disabled === true);
    const title = await page2.session.evaluate("document.querySelector('[data-v=\"ai-open\"]')?.getAttribute('title')");
    report.check(`⑥ 置灰时给出可读提示（${title}）`, String(title).includes('未提供模型'));
  } finally {
    await page2.close();
  }
} finally {
  devServer.kill();
  await fixtures.close();
  report.summary('M4 AI 层 E2E');
}
