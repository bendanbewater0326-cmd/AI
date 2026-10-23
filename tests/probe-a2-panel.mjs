/**
 * 音频面板 A2 验收探针（一次性验证，不进 npm test；A3 会写成正式 verify-audio-panel）。
 *
 * 验证：切「音频」Tab → 面板出现 → 点「叮」卡片 → 音频轨出现片段（时长 ±1 帧、被选中）
 * → 再点一次 → 片段 ×2 而资产仍 ×1（hashKey 幂等）。每步截图到 tests/screenshots/。
 *
 * 运行：`node --experimental-websocket tests/probe-a2-panel.mjs`
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createReport, launchPage } from './cdp.mjs';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..');
const PORT = 5821;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = (await import('node:http')).createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('ok');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const dev = spawn(process.execPath, ['scripts/dev.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('dev server 启动超时')), 20000);
  dev.stdout.on('data', (chunk) => {
    if (String(chunk).includes(`127.0.0.1:${PORT}`)) {
      clearTimeout(timer);
      resolve();
    }
  });
});

const page = await launchPage({ url: `http://127.0.0.1:${PORT}/`, width: 1440, height: 900 });
const report = createReport();

const hooks = async (expression) => page.session.evaluate(expression);
const click = async (selector) => {
  await page.session.evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  await sleep(300);
};
const clips = async () => JSON.parse(await hooks('JSON.stringify(window.__VEDITOR_TEST__.clips())'));
const assets = async () => JSON.parse(await hooks('JSON.stringify(window.__VEDITOR_TEST__.assets())'));

try {
  // ① 切到音频 Tab：面板**可见**（常驻挂载的隐藏面板也能被程序点中，必须等 data-tab 真切过去）
  {
    let switched = false;
    for (let attempt = 0; attempt < 10 && !switched; attempt += 1) {
      await click('[data-v="left-tab-audio"]');
      switched = await hooks(`document.querySelector('[data-v="left-content"]')?.getAttribute('data-tab') === 'audio'`);
      if (!switched) await sleep(300);
    }
    report.check('切到音频 Tab', switched);
  }
  report.check(
    '面板可见（非 hidden）',
    await hooks(`(() => {
      const slot = document.querySelector('[data-v="audio-content-slot"]');
      if (slot === null || slot.hidden) return false;
      const rect = slot.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })()`),
  );
  report.check('音频 Tab 可见', await hooks(`document.querySelector('[data-v="sfx-panel"]') !== null`));
  const cardCount = await hooks(`document.querySelectorAll('[data-v="sfx-preset"]').length`);
  report.check(`卡片 10 张（实际 ${cardCount}）`, cardCount === 10);
  await page.screenshot({ path: path.join(ROOT, 'tests', 'screenshots', 'a2-audio-panel.png') });

  // ② 点「叮」：落音频轨播放头处，时长 ±1 帧，被选中
  const fps = 30; // 空工程默认 30fps
  await click('[data-v="sfx-preset"][data-preset-id="ding"]');
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 1`, 8000);
  const first = (await clips())[0];
  const expectFrames = Math.round(0.6 * fps);
  report.check('落在音轨（A1）', first.trackId === 'trk_A1');
  report.check(`时长 ±1 帧（${first.durationFrames} ≈ ${expectFrames}）`, Math.abs(first.durationFrames - expectFrames) <= 1);
  report.check(
    '片段被选中',
    await hooks(`window.__VEDITOR_TEST__.selection() === ${JSON.stringify(first.id)}`),
  );
  report.check('资产 1 个（音效·叮）', (await assets()).length === 1);
  await page.screenshot({ path: path.join(ROOT, 'tests', 'screenshots', 'a2-ding-placed.png') });

  // ③ 再点一次：片段 ×2、资产仍 ×1（幂等）
  await click('[data-v="sfx-preset"][data-preset-id="ding"]');
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 2`, 8000);
  report.check('再次点击 → 片段 ×2', (await clips()).length === 2);
  report.check('资产仍 ×1（hashKey 幂等）', (await assets()).length === 1);

  // ④ 撤销一步 → 只剩 1 个片段（一个 dispatch = 一个撤销步，建轨/落片同批）
  await click('[data-v="undo"]');
  await sleep(300);
  report.check('撤销一步 → 片段 ×1', (await clips()).length === 1);

  report.summary();
} finally {
  await page.close().catch(() => {});
  dev.kill();
  await new Promise((resolve) => server.close(resolve));
}
