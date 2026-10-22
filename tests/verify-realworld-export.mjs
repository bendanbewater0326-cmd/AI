/**
 * 真实素材导出回归：无音频素材 / VFR 素材。
 *
 * 这两类在导出侧最容易出"静默错误"：
 * - 无音频素材：`hasAudio=false`，导出时若仍按"有音轨"去混音，可能产出全静音音轨
 *   或直接抛错；正确行为是**明确告知无音轨**且视频完整。
 * - VFR 素材：标称 30fps 但实际 22.5fps，导出时长若按标称算会变成 3s（真实 4s），
 *   整片变快 33%。
 *
 * 运行：node tests/verify-realworld-export.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5202;
const DOWNLOAD_DIR = path.join(ROOT, 'tests', '.tmp', 'realworld-export');

function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
    const found = [path.join(ROOT, 'tests', 'fixtures', 'compat', name), path.join(ROOT, 'tests', 'fixtures', name)]
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

let pack = 0;
/** 打开素材 → 导出 mp4 → 返回 { message, mp4Path }。 */
async function exportFixture(name) {
  pack += 1;
  const dir = path.join(DOWNLOAD_DIR, String(pack));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const page = await launchPage({
    url: `http://127.0.0.1:${PORT}/?src=${encodeURIComponent(`${fixtures.origin}/${name}`)}`,
    width: 1400,
    height: 900,
  });
  try {
    await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
    await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 15000);
    await page.session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });

    await page.session.evaluate("document.querySelector('[data-v=\"export-open\"]').click()");
    await page.session.waitFor("!!document.querySelector('[data-v=\"export-dialog\"]')", 5000);
    await page.session.evaluate("document.querySelector('[data-v=\"export-format-mp4\"]').click()");
    await page.session.evaluate("document.querySelector('[data-v=\"export-start\"]').click()");
    await page.session.waitFor("!!document.querySelector('[data-v=\"export-message\"]')", 180000);
    const message = await page.session.evaluate("document.querySelector('[data-v=\"export-message\"]').textContent");

    const listMp4 = () => (fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((file) => file.endsWith('.mp4') && !file.endsWith('.crdownload'))
      : []);
    let files = listMp4();
    for (let i = 0; i < 40 && files.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      files = listMp4();
    }
    return { message: String(message), mp4Path: files.length > 0 ? path.join(dir, files[0]) : null };
  } finally {
    await page.close();
  }
}

function probeStreams(mp4Path) {
  const raw = execFileSync('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', mp4Path,
  ], { encoding: 'utf8' });
  return JSON.parse(raw);
}

try {
  // ---- ① 无音频素材：视频完整、无音轨、时长 3s ----
  const silent = await exportFixture('silent-720p.mp4');
  report.check(
    `① 无音频素材导出完成（${silent.message.slice(0, 40)}）`,
    silent.mp4Path !== null,
  );
  if (silent.mp4Path !== null) {
    const meta = probeStreams(silent.mp4Path);
    const video = (meta.streams ?? []).find((stream) => stream.codec_type === 'video');
    const audio = (meta.streams ?? []).find((stream) => stream.codec_type === 'audio');
    const duration = Number(meta.format?.duration ?? 0);
    report.check(`①b 产物有视频轨（${video?.codec_name}）`, video !== undefined);
    report.check(`①c 产物**没有**音轨（不应凭空造静音轨）`, audio === undefined);
    report.check(`①d 时长 ${duration.toFixed(2)}s ≈ 3s`, Math.abs(duration - 3) <= 0.1);
    report.check(
      `①e 导出消息明确告知无音轨（"${silent.message.includes('无音轨') ? '含无音轨' : '未提及'}"）`,
      silent.message.includes('无音轨'),
    );
  }

  // ---- ② VFR 素材：总时长必须 ≈ 4s（真实 PTS），不能是 3s ----
  const vfr = await exportFixture('vfr-mixed.mp4');
  report.check(`② VFR 素材导出完成`, vfr.mp4Path !== null);
  if (vfr.mp4Path !== null) {
    const meta = probeStreams(vfr.mp4Path);
    const duration = Number(meta.format?.duration ?? 0);
    report.check(
      `②b VFR 导出时长 ${duration.toFixed(2)}s ≈ 4s（按标称 30fps 会错成 3s）`,
      Math.abs(duration - 4) <= 0.15,
    );
  }
} finally {
  devServer.kill();
  await fixtures.close();
}

report.summary('真实素材导出回归');