/**
 * 真实素材场景回归（手机拍摄视频的两大特征：1080p + 旋转元数据）。
 *
 * ## 为什么必须有
 *
 * 2026-10-21 用 ffmpeg 生成 1080p 与"带 displaymatrix 的竖拍素材"才发现两个缺陷，
 * 而当时 173 条单测 + 19 个 E2E 全绿——因为原有 fixture 全是 640×360 / 1280×720 的横屏：
 *
 * 1. **1080p 导入后预览全黑**：并发的 `renderFrame` 共享池的 LRU 帧缓存，
 *    一个渲染的 `ensureFrame` 把另一个尚未绘制的帧 `close()` 掉 → `displayWidth=0`
 *    → 合成器抛 "层源尺寸为 0" → 异常被 `void` 吞掉 → 黑屏且无提示。
 *    1080p 帧更大、缓存能存的帧数更少，所以必现；720p 常常侥幸不触发。
 * 2. **竖拍视频横躺**：`tkhd` 变换矩阵从未被解析，WebCodecs 也不解旋转。
 *
 * 验证：
 *   ① 1080p 导入后（不 seek、不播放）预览非黑
 *   ② 旋转素材的 Asset.rotation = 270、宽高已交换为 1080×1920（显示尺寸）
 *   ③ 旋转素材预览非黑，且工程尺寸跟随为竖屏 1080×1920
 *   ④ 渲染无异常（lastRenderError 为空）
 *
 * 运行：node tests/verify-realworld.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5200;
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'compat');

function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
    const found = [path.join(FIXTURES, name), path.join(ROOT, 'tests', 'fixtures', name)]
      .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!found) {
      response.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'video/mp4', 'Access-Control-Allow-Origin': '*' });
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

/** 打开一个素材，等自动导入完成，返回页面快照。 */
async function inspect(name, waitMs = 2000) {
  const page = await launchPage({
    url: `http://127.0.0.1:${PORT}/?src=${encodeURIComponent(`${fixtures.origin}/${name}`)}`,
    width: 1400,
    height: 900,
  });
  try {
    await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
    await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 15000);
    // 不 seek、不播放：只等导入后的自然渲染完成（这正是原先 1080p 会黑的路径）。
    // **不能用固定 sleep**：全量 E2E 连跑时机器被压着，2 秒可能还没解出首帧，
    // 会拍到一个全黑画面，看起来像"旋转素材渲染失败"（实测 42 个脚本连跑时偶发）。
    // 改成轮询"画出来了"：真渲染不出来仍然会失败（只是等到超时）。
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, waitMs)));
    // 4K 首帧在负载下可能要 20s+：给足 30s（真渲染不出来仍然会失败，只是等得久）
    const deadline = Date.now() + Math.max(waitMs, 30000);
    while (Date.now() < deadline) {
      const probe = await page.session.evaluate('window.__VEDITOR_TEST__.previewSnapshot()');
      if ((probe?.nonBlack ?? 0) > (probe?.total ?? 1) * 0.1) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // 画出来之后留一点余量，让 in-flight 的渲染结束（否则下面拍的快照可能是一帧旧的空画面）
    await new Promise((resolve) => setTimeout(resolve, 300));

    // **先取快照与统计，再跑 decodeTest**。
    // `decodeTest` 会直接向解码器池要一帧，从而 bump epoch、取消引擎正在跑的渲染
    // （`seek 被新的 epoch 取消`），之后拍的快照就是空的（层数 0 / 全黑）。
    // 之前它排在快照前面，恰好被"负载下渲染本来就慢"掩盖了，一直没人发现。
    const snapshot = await page.session.evaluate('window.__VEDITOR_TEST__.previewSnapshot()');
    const stats = await page.session.evaluate('window.__VEDITOR_TEST__.previewStats()');
    const renderError = await page.session.evaluate('window.__VEDITOR_TEST__.lastRenderError()');
    const assets = await page.session.evaluate('window.__VEDITOR_TEST__.assets()');

    // 以下是纯诊断（不影响上面的断言）
    const assetId0 = assets?.[0]?.id;
    const probes = [];
    for (let i = 0; i < 3; i += 1) {
      probes.push(await page.session.evaluate(`window.__VEDITOR_TEST__.decodeTest('${assetId0}', 0)`));
    }
    console.log(`    · decodeTest x3: ${JSON.stringify(probes)}`);
    const diag = {
      repaint: await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.docRepaintInfo())'),
      stats: JSON.stringify(stats),
    };
    console.log(`    · ${name} stats=${diag.stats} repaint=${diag.repaint}`);
    return {
      assets,
      snapshot,
      stats,
      renderError,
      audio: await page.session.evaluate('window.__VEDITOR_TEST__.audioStats()'),
      canvas: await page.session.evaluate(`(() => {
        const c = document.querySelector('[data-v="preview-canvas"]');
        return c === null ? null : { width: c.width, height: c.height };
      })()`),
    };
  } finally {
    await page.close();
  }
}

try {
  // ---- ① 1080p：导入后预览必须非黑（不借助 seek）----
  const hd = await inspect('plain-1080p.mp4');
  report.check(
    `① 1080p 导入后预览非黑（${hd.snapshot?.nonBlack}/${hd.snapshot?.total}）`,
    (hd.snapshot?.nonBlack ?? 0) > (hd.snapshot?.total ?? 1) * 0.1,
  );
  report.check(
    `①b 1080p 渲染无异常（lastRenderError="${hd.renderError}"）`,
    hd.renderError === '',
  );
  report.check(
    `①c 1080p 层数 > 0（${hd.stats?.compositor?.lastLayerCount}）`,
    (hd.stats?.compositor?.lastLayerCount ?? 0) > 0,
  );

  // ---- ②/③ 旋转素材：Asset 显示尺寸交换 + 预览非黑 ----
  const rotated = await inspect('rotated-90.mp4');
  const asset = rotated.assets?.[0] ?? {};
  report.check(
    `② 旋转素材 rotation=${asset.rotation}（期望 270）`,
    asset.rotation === 270,
  );
  report.check(
    `②b 显示宽高已交换（${asset.width}×${asset.height}，期望 1080×1920）`,
    asset.width === 1080 && asset.height === 1920,
  );
  report.check(
    `③ 工程尺寸跟随为竖屏（canvas ${rotated.canvas?.width}×${rotated.canvas?.height}）`,
    rotated.canvas?.width === 1080 && rotated.canvas?.height === 1920,
  );
  report.check(
    `③b 旋转后预览非黑（${rotated.snapshot?.nonBlack}/${rotated.snapshot?.total}）`,
    (rotated.snapshot?.nonBlack ?? 0) > (rotated.snapshot?.total ?? 1) * 0.1,
  );
  report.check(
    `④ 旋转渲染无异常（lastRenderError="${rotated.renderError}"）`,
    rotated.renderError === '',
  );
  // ---- ⑤ 4K：帧 3.1MB → 12.4MB，超出 8MB 缓存预算，必须仍能出画 ----
  const uhd = await inspect('uhd-4k.mp4', 2500);
  report.check(
    `⑤ 4K 预览非黑（${uhd.snapshot?.nonBlack}/${uhd.snapshot?.total}）`,
    (uhd.snapshot?.nonBlack ?? 0) > (uhd.snapshot?.total ?? 1) * 0.1,
  );
  report.check(
    `⑤b 4K 无解码失败（decodeFailures=${uhd.stats?.decodeFailures}）`,
    (uhd.stats?.decodeFailures ?? -1) === 0,
  );
  report.check(
    `⑤c 4K canvas 尺寸（${uhd.canvas?.width}×${uhd.canvas?.height}）`,
    uhd.canvas?.width === 3840 && uhd.canvas?.height === 2160,
  );

  // ---- ⑥ 无音频视频（屏幕录制/无声素材）----
  const silent = await inspect('silent-720p.mp4');
  const silentAsset = silent.assets?.[0] ?? {};
  report.check(`⑥ 无音频素材 hasAudio=false`, silentAsset.hasAudio === false);
  report.check(
    `⑥b 无音频素材仍能出画（${silent.snapshot?.nonBlack}/${silent.snapshot?.total}）`,
    (silent.snapshot?.nonBlack ?? 0) > (silent.snapshot?.total ?? 1) * 0.1,
  );
  report.check(
    `⑥c 无音频时音频调度静默跳过（gaps=${silent.audio?.gaps} audible=${silent.audio?.audible}）`,
    (silent.audio?.gaps ?? -1) === 0,
  );

  // ---- ⑦ VFR（可变帧率）：总时长必须按真实 PTS 走，不能按标称 30fps 算 ----
  const vfr = await inspect('vfr-mixed.mp4');
  const vfrAsset = vfr.assets?.[0] ?? {};
  // 素材实际 4.0s（前 2s@30fps + 后 2s@15fps，共 90 帧），标称 30fps 会算成 3s
  report.check(
    `⑦ VFR 时长按真实 PTS（${vfrAsset.durationSec}s ≈ 4s）`,
    Math.abs((vfrAsset.durationSec ?? 0) - 4) <= 0.1,
  );
  report.check(
    `⑦b VFR 帧率用均值（fpsMilli=${vfrAsset.fpsMilli} ≈ 22500）`,
    Math.abs((vfrAsset.fpsMilli ?? 0) - 22500) <= 500,
  );
  report.check(
    `⑦c VFR 仍能出画（${vfr.snapshot?.nonBlack}/${vfr.snapshot?.total}）`,
    (vfr.snapshot?.nonBlack ?? 0) > (vfr.snapshot?.total ?? 1) * 0.1,
  );
  // ---- ⑧ 10 分钟长素材（18000 帧 / GOP=300）：索引规模 + 跳片尾 ----
  const longStart = Date.now();
  const longPage = await launchPage({
    url: `http://127.0.0.1:${PORT}/?src=${encodeURIComponent(`${fixtures.origin}/long-10min.mp4`)}`,
    width: 1400,
    height: 900,
  });
  try {
    await longPage.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
    await longPage.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 30000);
    const importMs = Date.now() - longStart;
    const longClip = (await longPage.session.evaluate('window.__VEDITOR_TEST__.clips()'))?.[0];
    report.check(
      `⑧ 10 分钟素材导入（${importMs}ms，${longClip?.outFrame} 帧）`,
      longClip?.outFrame === 18000 && importMs < 15000,
    );

    // 跳到 9:50（最后 10 秒）：长 GOP 需要从最近关键帧解最多 300 帧
    const seekStart = Date.now();
    await longPage.session.evaluate("document.querySelector('[data-v=\"timecode\"]')?.click()");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await longPage.session.evaluate(`(() => {
      const input = document.querySelector('[data-v="timecode-input"]');
      if (!input) return false;
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '00:09:50:00');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await longPage.session.evaluate(
      "document.querySelector('[data-v=\"timecode-input\"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))",
    );
    let lastSnap = null;
    for (let i = 0; i < 16; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      lastSnap = await longPage.session.evaluate('window.__VEDITOR_TEST__.previewSnapshot()');
      if ((lastSnap?.nonBlack ?? 0) > 1000) break;
    }
    const seekMs = Date.now() - seekStart;
    const playhead = await longPage.session.evaluate('window.__VEDITOR_TEST__.playheadFrame()');
    report.check(
      `⑧b 跳到片尾 9:50（frame=${playhead}，${seekMs}ms ≤ 3000ms）`,
      playhead === 17700 && seekMs <= 3000,
    );
    report.check(
      `⑧c 片尾画面非黑（${lastSnap?.nonBlack}/${lastSnap?.total}）`,
      (lastSnap?.nonBlack ?? 0) > 1000,
    );
  } finally {
    await longPage.close();
  }
} finally {
  devServer.kill();
  await fixtures.close();
}

report.summary('真实素材场景回归');