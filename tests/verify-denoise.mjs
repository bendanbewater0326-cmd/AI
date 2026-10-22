/**
 * 降噪端到端验证（R-061）。
 *
 * 单测证明了 DSP 本身；这里验证**接线**：
 * 一句话能不能开降噪、能不能撤销、导出会不会崩。
 *
 * 素材用 roughcut-8s.mp4（3s 音 + 2s 静音 + 3s 音）——它的静音段是数字静音，
 * 降噪不会改变它，所以这里不断言"底噪下降"（那是单测的活），只断言链路通。
 *
 * 运行：node tests/verify-denoise.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5216;
const FIXTURE = 'roughcut-8s.mp4';

function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
    const found = [path.join(ROOT, 'tests', 'fixtures', 'compat', name)].find(
      (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
    );
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
const dl = path.join(ROOT, 'tests', '.tmp', 'denoise');
fs.rmSync(dl, { recursive: true, force: true });
fs.mkdirSync(dl, { recursive: true });
const page = await launchPage({ url: `http://127.0.0.1:${PORT}/?src=${fixture.origin}/${FIXTURE}`, width: 1440, height: 900 });

async function command(text) {
  for (const type of ['keyDown', 'keyUp']) {
    await page.session.send('Input.dispatchKeyEvent', { type, key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
  }
  await page.session.waitFor(`!!document.querySelector('[data-v="command-input"]')`, 5000);
  await page.session.evaluate(`(() => {
    const input = document.querySelector('[data-v="command-input"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.session.evaluate(`document.querySelector('[data-v="command-run"]').click()`);
}

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 15000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 25000);

  // ① 一句话开降噪
  await command('帮我降噪');
  await page.session.waitFor(
    `window.__VEDITOR_TEST__.clips()[0].effects.includes('denoise')`,
    15000,
  );
  report.check('① 「帮我降噪」→ 片段上出现 denoise 效果', true);

  const toast = await page.session.evaluate(`document.querySelector('[data-v="toast"]')?.textContent ?? ''`);
  report.check(`① toast 可撤销（"${String(toast).slice(0, 16)}"）`, /撤销/.test(String(toast)));

  // ② 一次撤销移除
  for (const type of ['keyDown', 'keyUp']) {
    await page.session.send('Input.dispatchKeyEvent', { type, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
  }
  await sleep(600);
  const afterUndo = JSON.parse(
    await page.session.evaluate(`JSON.stringify(window.__VEDITOR_TEST__.clips()[0].effects)`),
  );
  report.check(`② 一次撤销移除降噪（效果 ${JSON.stringify(afterUndo)}）`, afterUndo.length === 0);

  // ③ 重复开启会提示，而不是叠两个效果
  await command('降噪');
  await sleep(800);
  await command('降噪');
  await sleep(800);
  const effects = JSON.parse(
    await page.session.evaluate(`JSON.stringify(window.__VEDITOR_TEST__.clips()[0].effects)`),
  );
  const errorText = await page.session.evaluate(`document.querySelector('[data-v="command-error"]')?.textContent ?? ''`);
  report.check(
    `③ 不会叠出两个降噪（效果数 ${effects.length}，提示"${String(errorText).slice(0, 12)}"）`,
    effects.filter((type) => type === 'denoise').length === 1 && /已经开/.test(String(errorText)),
  );

  // ④ 开降噪后导出 WAV 不崩、有音轨
  await page.session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
  await page.session.evaluate(`document.querySelector('[data-v="export-open"]').click()`);
  await page.session.waitFor(`!!document.querySelector('[data-v="export-dialog"]')`, 5000);
  await page.session.evaluate(`document.querySelector('[data-v="export-format-wav"]').click()`);
  await sleep(200);
  await page.session.evaluate(`document.querySelector('[data-v="export-start"]').click()`);
  const deadline = Date.now() + 120000;
  let message = null;
  while (Date.now() < deadline) {
    message = await page.session.evaluate(`document.querySelector('[data-v="export-message"]')?.textContent ?? null`);
    if (message !== null && String(message).length > 0) break;
    await sleep(800);
  }
  report.check(`④ 开降噪后 WAV 导出成功（${message}）`, message !== null && /帧/.test(String(message)));
  await sleep(1200);
  const files = fs.readdirSync(dl).filter((name) => name.endsWith('.wav'));
  report.check(`④ 产物落盘（${files.join(', ') || '无'}）`, files.length === 1);

  const errors = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.errors())'));
  report.check(`⑤ 全程无页面错误（${JSON.stringify(errors)}）`, Array.isArray(errors) && errors.length === 0);

  report.summary('音频降噪（R-061）');
} finally {
  await page.close();
  dev.kill();
  await fixture.close();
  fs.rmSync(dl, { recursive: true, force: true });
}
