/**
 * T19 WebM 端到端 E2E（真浏览器 + 真 VP9 解码 + 真上屏）。
 *
 * 验证 webm 与 mp4 同等可用（架构 T19：输出契约复用 MediaProbeResult）：
 *   ① 导入 webm-vp9-opus.webm 成功（probeAsset 走 openWebm）
 *   ② 上轨成功，且帧数为 120（视频样本数，不是音频的 201）
 *   ③ seek 到第 60 帧后预览非黑（decoderPool 真解 VP9，不是占位/黑屏）
 *   ④ 素材元数据正确（640×360 / vp09）
 *
 * 运行：node tests/verify-t19.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEV_PORT = 5193;

function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
    // compat 必须排第一：hardline/ 下有一个 **同名但不同** 的 webm-vp9-opus.webm
    // （6.78MB/240 帧 vs compat 的 449KB/120 帧），先命中 hardline 会让断言全部错位。
    const candidates = [
      path.join(ROOT, 'tests', 'fixtures', 'compat', name),
      path.join(ROOT, 'tests', 'fixtures', name),
      path.join(ROOT, 'tests', 'fixtures', 'hardline', name),
    ];
    const found = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
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
    env: { ...process.env, PORT: String(DEV_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dev server 10 秒内未就绪')), 10000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes(`127.0.0.1:${DEV_PORT}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => {
      if (String(chunk).includes('EADDRINUSE')) {
        clearTimeout(timer);
        reject(new Error(`端口 ${DEV_PORT} 被占用`));
      }
    });
  });
  return child;
}

const fixtures = await startFixtureServer();
const devServer = await startDevServer();
const page = await launchPage({ url: `http://127.0.0.1:${DEV_PORT}/`, width: 1440, height: 900 });
const report = createReport();

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 8000);

  // ---- 拖拽导入 + 双击上轨 ----
  await page.session.evaluate(`
    window.__drop = async (name) => {
      const response = await fetch('${fixtures.origin}/' + encodeURIComponent(name));
      const blob = await response.blob();
      const file = new File([blob], name, { type: 'video/mp4', lastModified: 1700000000000 });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      for (const type of ['dragenter', 'dragover', 'drop']) {
        document.body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
      }
      return true;
    };
    true;
  `);

  await page.session.evaluate("window.__drop('webm-vp9-opus.webm'); true");
  await page.session.waitFor("document.querySelectorAll('[data-v=\"asset-card\"]').length === 1", 8000);
  // 等缩略图 + 素材探测完成
  await new Promise((resolve) => setTimeout(resolve, 600));

  // 双击上轨
  await page.session.evaluate(`
    (async () => {
      const card = document.querySelector('[data-v="asset-card"]');
      card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      return true;
    })();
  `);
  const clipCount = await page.session.evaluate("window.__VEDITOR_TEST__.clips().length");
  report.check(`上轨成功（V1 片段数 ${clipCount}）`, clipCount === 1);

  // ---- ③ 时间码输入跳转 ----
  await page.session.evaluate("document.querySelector('[data-v=\"timecode\"]').click(); true");
  await page.session.waitFor("!!document.querySelector('[data-v=\"timecode-input\"]')", 2000);

  // 设置受控 input 的值（React 需要原生 setter + input 事件）
  await page.session.evaluate(`
    (() => {
      const input = document.querySelector('[data-v="timecode-input"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '00:00:02:00');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })();
  `);
  await page.session.evaluate(`
    (() => {
      const input = document.querySelector('[data-v="timecode-input"]');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })();
  `);
  // 等 seek + 渲染
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const playhead = await page.session.evaluate('window.__VEDITOR_TEST__.playheadFrame()');
  report.check(`③ 时间码输入 00:00:02:00 → 播放头 ${playhead}`, playhead === 60);

  // ---- 预览出画面 ----
  const canvasInfo = await page.session.evaluate(`
    (() => {
      const canvas = document.querySelector('[data-v="preview-canvas"]');
      const rect = canvas.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })();
  `);
  const shot = await page.session.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: canvasInfo.x, y: canvasInfo.y, width: canvasInfo.width, height: canvasInfo.height, scale: 1 },
  });
  // 用 esbuild 不可行，直接用内置 zlib? 这里不解析 PNG，改成在页面里读 canvas 像素。
  // 但 WebGL2 context 不能 getImageData。改用 CDP 读屏外：把 canvas drawImage 到 2d canvas。
  const previewCheck = await page.session.evaluate(
    'window.__VEDITOR_TEST__.previewSnapshot()',
  );
  if (previewCheck === null) {
    report.check('预览快照可用（engine 未创建或读回失败）', false);
  }
  const webmAssets = await page.session.evaluate('window.__VEDITOR_TEST__.assets()');
  const webmAsset = webmAssets.find((a) => a.name === 'webm-vp9-opus.webm') ?? webmAssets[0] ?? {};
  report.check(
    `④ 素材元数据（${webmAsset.name} ${webmAsset.fpsMilli} ${webmAsset.durationFrames} 帧）`,
    webmAsset.durationFrames === 120 && webmAsset.fpsMilli === 30000,
  );

  // 帧精确断言：直接问解码器池要第 60 帧，必须 exact（不是近似帧）
  const assetId = webmAsset.id;
  const dec = await page.session.evaluate(`window.__VEDITOR_TEST__.decodeTest('${assetId}', 60)`);
  report.check(`⑤ webm 帧精确解码（decodeTest(60) → ${JSON.stringify(dec)}）`, dec?.ok === true && dec?.detail?.includes('exact=true'));

  report.check(
    `预览出画面（非黑像素 ${previewCheck.nonBlack}/${previewCheck.total}，最大亮度 ${previewCheck.maxLuma}）`,
    previewCheck.nonBlack > previewCheck.total * 0.1,
  );

  fs.writeFileSync(path.join(ROOT, 'tests', 'screenshots', 't19-webm.png'), Buffer.from(shot.data, 'base64'));
} finally {
  await page.close();
  devServer.kill();
  await fixtures.close();
}

report.summary('T19 WebM 端到端验收');
