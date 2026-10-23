/**
 * 蒙版端到端验证（R-056）。
 *
 * 单测证明的是 JS 侧公式；着色器那一半必须看像素：
 * "遮住左边"之后，左半边的画面应该露出背景（黑），**平均亮度必须掉一半左右**。
 * 撤销后回到原值。
 *
 * 运行：node tests/verify-mask.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5219;
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

async function snapshot(region) {
  const arg = region === undefined ? '' : JSON.stringify(region);
  return JSON.parse(
    await page.session.evaluate(
      `(async () => JSON.stringify(await window.__VEDITOR_TEST__.previewSnapshot(${arg})))()`,
    ),
  );
}

const LEFT = { x: 0, y: 0.25, w: 0.4, h: 0.5 };
const RIGHT = { x: 0.6, y: 0.25, w: 0.4, h: 0.5 };

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 15000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 25000);
  await sleep(1500);
  const before = await snapshot();
  const beforeLeft = await snapshot(LEFT);
  const beforeRight = await snapshot(RIGHT);
  report.check(`① 基准画面（平均亮度 ${before.meanLuma.toFixed(1)}，左 ${beforeLeft.meanLuma.toFixed(1)} / 右 ${beforeRight.meanLuma.toFixed(1)}）`, before.meanLuma > 10);

  // ② 一句话加蒙版
  for (const type of ['keyDown', 'keyUp']) {
    await page.session.send('Input.dispatchKeyEvent', { type, key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
  }
  await page.session.waitFor(`!!document.querySelector('[data-v="command-input"]')`, 5000);
  await page.session.evaluate(`(() => {
    const input = document.querySelector('[data-v="command-input"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '遮住左边');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.session.evaluate(`document.querySelector('[data-v="command-run"]').click()`);
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips()[0].effects.includes('mask')`, 15000);
  report.check('② 「遮住左边」→ 片段上出现 mask 效果', true);

  await sleep(1200);
  const after = await snapshot();
  const afterLeft = await snapshot(LEFT);
  const afterRight = await snapshot(RIGHT);
  report.check(
    `③ 全画面掉到一半（${before.meanLuma.toFixed(1)} → ${after.meanLuma.toFixed(1)}）`,
    after.meanLuma < before.meanLuma * 0.7 && after.meanLuma > before.meanLuma * 0.2,
  );
  // 这两条才是真正的断言：**遮住的是左边**，不是右边。
  // 只量全画面均值时，"遮左"和"遮右"结果完全一样（曾经因此放过一个方向反了的 bug）。
  report.check(
    `③ 左半被遮住（${beforeLeft.meanLuma.toFixed(1)} → ${afterLeft.meanLuma.toFixed(1)}，应接近 0）`,
    afterLeft.meanLuma < 12,
  );
  report.check(
    `③ 右半没动（${beforeRight.meanLuma.toFixed(1)} → ${afterRight.meanLuma.toFixed(1)}）`,
    Math.abs(afterRight.meanLuma - beforeRight.meanLuma) < 6,
  );

  const stats = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.compositorStats())'));
  report.check(`④ 没有 GL 错误（lastGlError=${stats.lastGlError}）`, stats.lastGlError === 0);

  // ⑤ 属性栏能细调：反向一次 → 左右互换（动态分组改造后蒙版组默认折叠：先展开）
  await page.session.evaluate(`document.querySelector('[data-v="inspector-section-mask-toggle"]')?.click()`);
  await sleep(200);
  const maskControls = JSON.parse(
    await page.session.evaluate(`JSON.stringify({
      shape: !!document.querySelector('[data-v="inspector-mask-shape"]'),
      invert: !!document.querySelector('[data-v="inspector-mask-invert"]'),
      x: !!document.querySelector('[data-v="inspector-mask-x"]'),
      feather: !!document.querySelector('[data-v="inspector-mask-feather"]'),
      remove: !!document.querySelector('[data-v="inspector-mask-remove"]'),
    })`),
  );
  report.check(
    `⑤ 属性栏出现蒙版组（形状/反向/位置/羽化/移除 ${Object.values(maskControls).filter(Boolean).length}/5）`,
    Object.values(maskControls).every(Boolean),
  );
  await page.session.evaluate(`document.querySelector('[data-v="inspector-mask-invert"]').click()`);
  await sleep(1000);
  const flippedLeft = await snapshot(LEFT);
  const flippedRight = await snapshot(RIGHT);
  report.check(
    `⑤ 反向 → 左右互换（左 ${flippedLeft.meanLuma.toFixed(1)} / 右 ${flippedRight.meanLuma.toFixed(1)}）`,
    flippedLeft.meanLuma > beforeLeft.meanLuma * 0.8 && flippedRight.meanLuma < 12,
  );

  // ⑥ 撤销反向
  for (const type of ['keyDown', 'keyUp']) {
    await page.session.send('Input.dispatchKeyEvent', { type, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
  }
  await sleep(1000);
  const undoneFlip = await snapshot(LEFT);
  report.check(`⑥ 撤销反向（左半回到 ${undoneFlip.meanLuma.toFixed(1)}）`, undoneFlip.meanLuma < 12);

  // ⑦ 再撤销一次 → 蒙版整体移除
  for (const type of ['keyDown', 'keyUp']) {
    await page.session.send('Input.dispatchKeyEvent', { type, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
  }
  await sleep(1200);
  const restored = await snapshot();
  const effects = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.clips()[0].effects)'));
  report.check(`⑦ 一次撤销移除蒙版（效果 ${JSON.stringify(effects)}）`, effects.length === 0);
  report.check(
    `⑦ 撤销后回到原值（${restored.meanLuma.toFixed(1)} vs ${before.meanLuma.toFixed(1)}）`,
    Math.abs(restored.meanLuma - before.meanLuma) < 1,
  );

  const errors = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.errors())'));
  report.check(`⑧ 全程无页面错误（${JSON.stringify(errors)}）`, Array.isArray(errors) && errors.length === 0);

  report.summary('蒙版（R-056）');
} finally {
  await page.close();
  dev.kill();
  await fixture.close();
}
