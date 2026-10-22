/**
 * T18 宿主边界 E2E。
 *
 * 验证：
 *   ① `?src=<url>` 打开 → 自动导入并在 V1 生成片段
 *   ③ postMessage `getProject` → 回工程本体（iframe 场景；R-050 已实现，
 *      2026-10-21 之前的 `not_implemented` 断言作废，完整命令矩阵见 verify-postmessage.mjs）
 *
 * 运行：node tests/verify-t18.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEV_PORT = 5191;

function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
    const found = [path.join(ROOT, 'tests', 'fixtures', name), path.join(ROOT, 'tests', 'fixtures', 'hardline', name)]
      .find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
    if (!found) { response.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); response.end('nf'); return; }
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
    cwd: ROOT, env: { ...process.env, PORT: String(DEV_PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dev server 未就绪')), 10000);
    child.stdout.on('data', (chunk) => { if (String(chunk).includes(`127.0.0.1:${DEV_PORT}`)) { clearTimeout(timer); resolve(); } });
  });
  return child;
}

const fixtures = await startFixtureServer();
const devServer = await startDevServer();
const report = createReport();

// ---- ① ?src= 自动导入 ----
const srcUrl = `${fixtures.origin}/sample-720p.mp4`;
const page = await launchPage({ url: `http://127.0.0.1:${DEV_PORT}/?src=${encodeURIComponent(srcUrl)}`, width: 1440, height: 900 });

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 8000);
  // 等自动导入（fetch + probe + 上轨）
  await page.session.waitFor("window.__VEDITOR_TEST__.clips().length >= 1", 10000);

  const clips = await page.session.evaluate('window.__VEDITOR_TEST__.clips()');
  const assets = await page.session.evaluate('window.__VEDITOR_TEST__.assets()');
  report.check(
    `①a ?src= 自动导入素材（assets ${assets.length}）`,
    assets.length >= 1,
  );
  report.check(
    `①b 自动在 V1 生成片段（clips ${clips.length}，首片段 trackId=${clips[0]?.trackId}）`,
    clips.length >= 1 && clips[0]?.trackId === 'trk_V1',
  );
} finally {
  await page.close();
}

// ---- ③ postMessage getProject → 回工程本体（iframe 宿主页）----
{
  // 建一个宿主页，内嵌 iframe 指向 veditor，宿主向 iframe 发 getProject 并监听回包
  const hostServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><iframe id="f" src="http://127.0.0.1:${DEV_PORT}/" style="width:1200px;height:700px"></iframe>
<script>
  window.__replies = [];
  window.addEventListener('message', (e) => { window.__replies.push(e.data); });
  document.getElementById('f').addEventListener('load', () => {
    document.getElementById('f').contentWindow.postMessage({ type: 'getProject' }, '*');
  });
</script>`);
  });
  await new Promise((resolve) => hostServer.listen(0, '127.0.0.1', resolve));
  const hostPort = hostServer.address().port;

  const hostPage = await launchPage({ url: `http://127.0.0.1:${hostPort}/`, width: 1440, height: 900 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const replies = await hostPage.session.evaluate('JSON.stringify(window.__replies ?? [])');
    const parsed = JSON.parse(replies);
    const reply = parsed.find((item) => item?.type === 'getProject');
    const tracks = reply?.project?.tracks?.length ?? 0;
    report.check(
      `③ postMessage getProject 回工程本体（ok=${reply?.ok}，tracks=${tracks}）`,
      Array.isArray(parsed) && reply?.ok === true && tracks >= 3,
    );
  } finally {
    await hostPage.close();
    await new Promise((resolve) => hostServer.close(resolve));
  }
}

devServer.kill();
await fixtures.close();

report.summary('T18 宿主边界 E2E');