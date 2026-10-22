/**
 * 曲线调色端到端验证（R-055）。
 *
 * 单测只能证明 **JS 侧**的公式对；真正会坏的是**着色器那一份**（uniform 没设、program 没绑定）。
 * 所以这里看像素：加曲线后平均亮度必须变，撤销后必须回到原值。
 *
 * 运行：node tests/verify-curve.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5217;
const FIXTURE = 'sample-720p.mp4';

function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
    const found = [path.join(ROOT, 'tests', 'fixtures', 'compat', name), path.join(ROOT, 'tests', 'fixtures', 'hardline', name)].find(
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
const page = await launchPage({ url: `http://127.0.0.1:${PORT}/?src=${fixture.origin}/${FIXTURE}`, width: 1440, height: 900 });

async function snapshot() {
  return JSON.parse(
    await page.session.evaluate('(async () => JSON.stringify(await window.__VEDITOR_TEST__.previewSnapshot()))()'),
  );
}

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 15000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 25000);
  await sleep(1500);
  const before = await snapshot();
  report.check(`① 基准画面（平均亮度 ${before.meanLuma.toFixed(1)}）`, before.meanLuma > 10);

  // ② 一句话调曲线
  for (const type of ['keyDown', 'keyUp']) {
    await page.session.send('Input.dispatchKeyEvent', { type, key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
  }
  await page.session.waitFor(`!!document.querySelector('[data-v="command-input"]')`, 5000);
  await page.session.evaluate(`(() => {
    const input = document.querySelector('[data-v="command-input"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    // 用"更亮"而不是"对比更强"：对比曲线绕 0.5 旋转，**平均亮度几乎不变**（这是正确行为），
    // 拿均值去断言会误判；"更亮"抬的是暗部，均值必须上升。
    setter.call(input, '画面更亮一点');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.session.evaluate(`document.querySelector('[data-v="command-run"]').click()`);
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips()[0].effects.includes('curve')`, 15000);
  report.check('② 「画面更亮」→ 片段上出现 curve 效果', true);

  await sleep(1200);
  const after = await snapshot();
  report.check(
    `③ 着色器真的生效（平均亮度 ${before.meanLuma.toFixed(1)} → ${after.meanLuma.toFixed(1)}，应上升）`,
    after.meanLuma > before.meanLuma + 2,
  );

  // ④ 撤销回到原值
  for (const type of ['keyDown', 'keyUp']) {
    await page.session.send('Input.dispatchKeyEvent', { type, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
  }
  await sleep(1200);
  const restored = await snapshot();
  const effects = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.clips()[0].effects)'));
  report.check(`④ 一次撤销移除曲线（效果 ${JSON.stringify(effects)}）`, effects.length === 0);
  report.check(
    `④ 撤销后画面回到原值（${restored.meanLuma.toFixed(1)} vs ${before.meanLuma.toFixed(1)}）`,
    Math.abs(restored.meanLuma - before.meanLuma) < 1,
  );

  const errors = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.errors())'));
  report.check(`⑤ 全程无页面错误（${JSON.stringify(errors)}）`, Array.isArray(errors) && errors.length === 0);

  report.summary('曲线调色（R-055）');
} finally {
  await page.close();
  dev.kill();
  await fixture.close();
}
