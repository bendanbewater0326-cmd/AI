/**
 * WebM 导出端到端验证（补 T19 的真实缺口）。
 *
 * ## 为什么单独一个
 *
 * T19 交付后 webm 能导入、能预览，但导出路径里原本写着
 * `if (probe.container !== 'mp4') continue`——**webm 片段导出时画面与声音会静默消失**。
 * 这正是架构禁止的"能导入但导不出"中间态，且是最难发现的一类（产物看起来"导出成功"）。
 *
 * 验证：
 *   ① webm 素材导出 mp4 成功
 *   ② 产物含视频轨（ffprobe）
 *   ③ 产物含音轨且**不是静音**（volumedetect 均值 > -60dB）
 *   ④ 时长 ≈ 4.0s（webm-vp9-opus 120 帧 @30fps）
 *   ⑤ 抽第 60 帧，画面非黑（真解出了 VP9 内容）
 *
 * 运行：node tests/verify-webm-export.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5194;
const DOWNLOAD_DIR = path.join(ROOT, 'tests', '.tmp', 'webm-export');

function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
    // compat 优先（hardline 下有同名但不同时长的 webm）
    const found = [
      path.join(ROOT, 'tests', 'fixtures', 'compat', name),
      path.join(ROOT, 'tests', 'fixtures', name),
    ].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!found) {
      response.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'video/webm', 'Access-Control-Allow-Origin': '*' });
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

function hasTool(name) {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const report = createReport();
const fixtures = await startFixtureServer();
const devServer = await startDevServer();
fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const page = await launchPage({
  url: `http://127.0.0.1:${PORT}/?src=${encodeURIComponent(`${fixtures.origin}/webm-vp9-opus.webm`)}`,
  width: 1440,
  height: 900,
});

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 15000);
  await page.session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOAD_DIR });

  // 断言导入的确实是 compat 那个 120 帧版本
  const clips = await page.session.evaluate('window.__VEDITOR_TEST__.clips()');
  report.check(
    `⓪ 导入的是 120 帧 webm（实际 out=${clips[0]?.outFrame}）`,
    clips[0]?.outFrame === 120,
  );

  // ---- ⑤ 播放真的有声音（webm 的 Opus 必须被音频调度器排期）----
  // 这条独立于导出：修复前 getProbe 只认 mp4，webm 会「画面正常但播放无声」。
  await page.session.evaluate("document.querySelector('[data-v=\"play-toggle\"]').click()");
  await new Promise((resolve) => setTimeout(resolve, 1600));
  const audioStats = await page.session.evaluate('window.__VEDITOR_TEST__.audioStats()');
  await page.session.evaluate("document.querySelector('[data-v=\"play-toggle\"]').click()");
  report.check(
    `播放是排期了音频（chunks=${audioStats?.chunks} pcmBytes=${audioStats?.pcmBytes} 排期 ${String(audioStats?.scheduledSeconds)}s）`,
    typeof audioStats?.chunks === 'number' && audioStats.chunks > 0 && audioStats.pcmBytes > 0 && (audioStats.scheduledSeconds ?? 0) > 0,
  );

  // ---- 导出 mp4 ----
  await page.session.evaluate("document.querySelector('[data-v=\"export-open\"]').click()");
  await page.session.waitFor("!!document.querySelector('[data-v=\"export-dialog\"]')", 5000);
  await page.session.evaluate("document.querySelector('[data-v=\"export-format-mp4\"]').click()");
  await page.session.evaluate("document.querySelector('[data-v=\"export-start\"]').click()");
  await page.session.waitFor("!!document.querySelector('[data-v=\"export-message\"]')", 180000);
  const message = await page.session.evaluate("document.querySelector('[data-v=\"export-message\"]').textContent");

  // 等下载真正落盘（导出消息出现 ≠ 文件写完；中文文件名也要能匹配）
  const listMp4 = () => (fs.existsSync(DOWNLOAD_DIR)
    ? fs.readdirSync(DOWNLOAD_DIR).filter((name) => name.endsWith('.mp4') && !name.endsWith('.crdownload'))
    : []);
  let files = listMp4();
  for (let i = 0; i < 40 && files.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    files = listMp4();
  }
  const mp4Path = files.length > 0 ? path.join(DOWNLOAD_DIR, files[0]) : null;

  report.check(`① webm 导出 mp4 完成（${String(message).slice(0, 60)}）`, mp4Path !== null);
  report.check(`①b 导出消息不含"无音轨"（webm 的 Opus 音轨应被混入）`, !String(message).includes('无音轨'));

  if (!hasTool('ffprobe')) {
    console.log('  · 未找到 ffprobe：跳过 ②③④⑤（产物正确性未验证）');
  } else if (mp4Path !== null) {
    // ---- ② 视频轨 / 音轨 ----
    const probeRaw = execFileSync('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', mp4Path,
    ], { encoding: 'utf8' });
    const meta = JSON.parse(probeRaw);
    const video = (meta.streams ?? []).find((stream) => stream.codec_type === 'video');
    const audio = (meta.streams ?? []).find((stream) => stream.codec_type === 'audio');

    report.check(`② 产物含视频轨（${video?.codec_name ?? '无'}）`, video !== undefined);
    report.check(`③ 产物含音轨（${audio?.codec_name ?? '无'}）`, audio !== undefined);

    // ---- ④ 时长 ≈ 4s（120 帧 @30fps）----
    const duration = Number(meta.format?.duration ?? 0);
    report.check(
      `④ 时长 ${duration.toFixed(3)}s ≈ 4.0s（容差 1 帧 = 0.033s）`,
      Math.abs(duration - 4) <= 1 / 30 + 0.01,
    );

    // ---- ⑤ 音轨非静音 ----
    if (audio !== undefined) {
      // volumedetect 把结果打到 **stderr**，execFileSync 只返回 stdout —— 必须用 spawnSync
      const volRun = spawnSync('ffmpeg', ['-hide_banner', '-i', mp4Path, '-af', 'volumedetect', '-f', 'null', '-'], {
        encoding: 'utf8',
      });
      const stderrText = String(volRun.stderr ?? '');
      const meanMatch = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderrText);
      const meanDb = meanMatch ? Number(meanMatch[1]) : Number.NEGATIVE_INFINITY;
      report.check(`⑤ 音轨均值 ${meanDb.toFixed(1)}dB > -60dB（webm 的 Opus 真被混入）`, meanDb > -60);
    }

    // ---- ⑥ 抽第 2 秒一帧，非黑 ----
    const framePng = path.join(DOWNLOAD_DIR, 'webm-export-frame.png');
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '2', '-i', mp4Path, '-frames:v', '1', framePng]);
    if (fs.existsSync(framePng)) {
      // signalstats/metadata=print 同样输出到 stderr
      const statRun = spawnSync('ffmpeg', ['-hide_banner', '-i', framePng, '-vf', 'signalstats,metadata=print', '-f', 'null', '-'], {
        encoding: 'utf8',
      });
      const yavgMatch = /YAVG=([\d.]+)/.exec(String(statRun.stderr ?? ''));
      const yavg = yavgMatch ? Number(yavgMatch[1]) : 0;
      report.check(`⑥ 导出第 2 秒画面非黑（YAVG=${yavg.toFixed(1)}）`, yavg > 16);
    }
  }
} finally {
  await page.close();
  devServer.kill();
  await fixtures.close();
}

report.summary('WebM 导出端到端验证');