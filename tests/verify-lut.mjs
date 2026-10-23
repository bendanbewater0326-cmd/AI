/**
 * 3D LUT 端到端验证（R-058）。
 *
 * 单测只证明 .cube 读对了；真正会坏的是 **3D 纹理那一段**（sampler3D 没绑、
 * 坐标少了半像素偏移、纹理格式不支持 LINEAR）。所以这里看像素：
 * 载入一个"提亮"LUT 后平均亮度必须上升，而且**不能有 GL 错误**。
 *
 * 运行：node tests/verify-lut.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5218;
const FIXTURE = 'sample-720p.mp4';
const CUBE = path.join(ROOT, 'tests', '.tmp', 'brighten.cube');

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
  const clipId = await page.session.evaluate('window.__VEDITOR_TEST__.clips()[0].id');
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(clipId)})`);
  await sleep(800);
  const before = await snapshot();
  report.check(`① 基准画面（平均亮度 ${before.meanLuma.toFixed(1)}）`, before.meanLuma > 10);

  // ② 通过属性栏载入 .cube（动态分组改造后 LUT 组默认折叠：先展开）
  await page.session.evaluate(`document.querySelector('[data-v="inspector-section-lut-toggle"]')?.click()`);
  await sleep(200);
  const { root } = await page.session.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await page.session.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: '[data-v="inspector-lut-file"]',
  });
  report.check('② 属性栏有 LUT 文件入口', nodeId !== 0);
  await page.session.send('DOM.setFileInputFiles', { nodeId, files: [CUBE] });
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips()[0].effects.includes('lut')`, 10000);
  report.check('② 载入后片段上出现 lut 效果', true);

  await sleep(1200);
  const after = await snapshot();
  report.check(
    `③ LUT 真的生效（平均亮度 ${before.meanLuma.toFixed(1)} → ${after.meanLuma.toFixed(1)}，应上升）`,
    after.meanLuma > before.meanLuma + 5,
  );

  const stats = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.compositorStats())'));
  report.check(
    `④ 没有 GL 错误（lastGlError=${stats.lastGlError}，层数 ${stats.lastLayerCount}）`,
    stats.lastGlError === 0 && stats.lastLayerCount === 1,
  );

  // ⑤ 一次撤销移除 LUT，画面回原值
  for (const type of ['keyDown', 'keyUp']) {
    await page.session.send('Input.dispatchKeyEvent', { type, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
  }
  await sleep(1200);
  const restored = await snapshot();
  const effects = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.clips()[0].effects)'));
  report.check(`⑤ 一次撤销移除 LUT（效果 ${JSON.stringify(effects)}）`, effects.length === 0);
  report.check(
    `⑤ 撤销后回到原值（${restored.meanLuma.toFixed(1)} vs ${before.meanLuma.toFixed(1)}）`,
    Math.abs(restored.meanLuma - before.meanLuma) < 1,
  );

  const errors = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.errors())'));
  report.check(`⑥ 全程无页面错误（${JSON.stringify(errors)}）`, Array.isArray(errors) && errors.length === 0);

  report.summary('3D LUT（R-058）');
} finally {
  await page.close();
  dev.kill();
  await fixture.close();
}
