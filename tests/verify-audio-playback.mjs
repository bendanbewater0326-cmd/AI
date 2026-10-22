/**
 * 播放音频回归（M2 核心能力，R-032 音画同步的前提）。
 *
 * ## 为什么必须单独测
 *
 * 2026-10-21 发现：**播放完全无声**（mp4 与 webm 都是），而 173 条单测 + 17 个 E2E 全绿。
 * 原因是 `createAudioScheduler({ pool })` 持有的是**创建时的池快照**，而
 * `ensurePreviewEngine` 在工程尺寸/帧率变化时会重建引擎并换一个新池（旧池 dispose）——
 * 调度器于是永远指向一个空池，`decodeAudioRange` 一路 `E_ASSET_OFFLINE`，
 * 表现为"画面正常、播放无声、不报任何错"。
 *
 * 导出侧不受影响（走 `mixTimelineAudio` 一次性混音），所以"导出有声音"不能证明"播放有声音"。
 *
 * 验证（mp4 与 webm 各一遍）：
 *   ① 播放 1.5s 后音频调度器排期了 PCM（chunks > 0 且 pcmBytes > 0）
 *   ② gaps === 0（没有被跳过的分块）
 *   ③ scheduledSeconds ≥ 1s（预读窗口真的在推进）
 *
 * 运行：node tests/verify-audio-playback.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5195;

function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
    const found = [
      path.join(ROOT, 'tests', 'fixtures', 'compat', name),
      path.join(ROOT, 'tests', 'fixtures', name),
    ].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
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

const report = createReport();
const fixtures = await startFixtureServer();
const devServer = await startDevServer();

async function checkPlayback(name) {
  const page = await launchPage({
    url: `http://127.0.0.1:${PORT}/?src=${encodeURIComponent(`${fixtures.origin}/${name}`)}`,
    width: 1200,
    height: 800,
  });
  try {
    await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
    await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 15000);

    await page.session.evaluate("document.querySelector('[data-v=\"play-toggle\"]').click()");
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const stats = await page.session.evaluate('window.__VEDITOR_TEST__.audioStats()');
    await page.session.evaluate("document.querySelector('[data-v=\"play-toggle\"]').click()");

    report.check(
      `${name} ① 排期了 PCM（chunks=${stats?.chunks} pcmBytes=${stats?.pcmBytes}）`,
      typeof stats?.chunks === 'number' && stats.chunks > 0 && (stats.pcmBytes ?? 0) > 0,
    );
    report.check(
      `${name} ② 无空洞（gaps=${stats?.gaps}${stats?.lastGapError ? ` | ${stats.lastGapError}` : ''}）`,
      stats?.gaps === 0,
    );
    report.check(
      `${name} ③ 预读推进（scheduledSeconds=${Number(stats?.scheduledSeconds ?? 0).toFixed(2)}s ≥ 1s）`,
      (stats?.scheduledSeconds ?? 0) >= 1,
    );

    // ⑤ 块不能切得太碎：平均每块 ≥ 500ms。
    // 旧实现把块截到"预读窗口剩下的那一小段"，一秒排出十几个 60–70ms 的碎块，
    // 每块边界一次样本跳变 → 持续"呲呲"的电磁音（PCM 本身没问题，所以别的指标全绿）。
    const avgChunkSec = (stats?.scheduledSeconds ?? 0) / Math.max(1, stats?.chunks ?? 1);
    report.check(
      `${name} ⑤ 块不碎（平均 ${(avgChunkSec * 1000).toFixed(0)}ms/块 ≥ 500ms）`,
      avgChunkSec >= 0.5,
    );

    // ④ 排期的 PCM 必须是**源采样率**（不是逐块重采样到 48k）。
    // 逐块重采样会让每块边界丢 sinc 上下文（16 抽头），一秒十来个爆音 → 听感"一直沙哑"
    // （2026-10-21 用户实测：微信 44.1k 单声道素材，同一文件用播放器听正常）。
    const asset = (await page.session.evaluate('window.__VEDITOR_TEST__.assets()'))?.[0];
    const bytesPerSecond = (stats?.pcmBytes ?? 0) / Math.max(0.001, stats?.scheduledSeconds ?? 0);
    const expected = (asset?.sampleRate ?? 0) * (asset?.channels ?? 0) * 4;
    report.check(
      `${name} ④ 排期 PCM 用源采样率（${Math.round(bytesPerSecond)} B/s ≈ ${asset?.sampleRate}Hz×${asset?.channels}ch×4 = ${expected}）`,
      expected > 0 && Math.abs(bytesPerSecond - expected) / expected < 0.02,
    );
  } finally {
    await page.close();
  }
}

try {
  await checkPlayback('sample-720p.mp4');
  await checkPlayback('webm-vp9-opus.webm');
  // 44.1kHz **单声道** AAC：微信/手机视频的典型配置，也是"逐块重采样"那个 bug 的现场
  await checkPlayback('aac-44k-mono.mp4');
} finally {
  devServer.kill();
  await fixtures.close();
}

report.summary('播放音频回归');