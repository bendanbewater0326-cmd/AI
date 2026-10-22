/**
 * M3 导出验收（真浏览器 + 真编码 + ffprobe 校验产物）。
 *
 * 验证：
 *   ① 三种格式都能导出并落盘（MP4 / GIF / WAV）
 *   ② MP4 的流信息正确：h264 + aac 48k 立体声，时长与时间线一致（误差 ≤ 1 帧）
 *   ③ MP4 第 137 帧与 `ref_137.png` 的 PSNR ≥ 20dB（跨链路口径，见 acceptance §5.1）
 *   ④ 音轨不是静音（volumedetect 均值 > -60dB）
 *   ⑤ WAV 采样率/声道/时长正确
 *
 * 运行：`node tests/verify-m3-export.mjs`
 * 依赖：ffmpeg/ffprobe 在 PATH 上（没有则跳过 ②③④⑤ 并明确标注"未验证"）
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5183;
const DOWNLOAD_DIR = path.join(ROOT, 'tests', '.tmp', 'export-downloads');

function hasTool(name) {
  const probe = spawnSync(name, ['-version'], { stdio: 'ignore' });
  return probe.status === 0;
}

function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
    const found = [
      path.join(ROOT, 'tests', 'fixtures', name),
      path.join(ROOT, 'tests', 'fixtures', 'hardline', name),
    ].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!found) {
      response.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
      response.end('nf');
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
fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const page = await launchPage({ url: `http://127.0.0.1:${PORT}/?src=${fixtures.origin}/sample-720p.mp4`, width: 1440, height: 900 });

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
  // 等导入 + 首帧解码完成
  await page.session.waitFor("window.__VEDITOR_TEST__.clips().length > 0", 15000);
  await page.session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOAD_DIR });

  const runExport = async (format) => {
    await page.session.evaluate("document.querySelector('[data-v=\"export-open\"]').click()");
    await page.session.waitFor("!!document.querySelector('[data-v=\"export-dialog\"]')", 5000);
    await page.session.evaluate(`document.querySelector('[data-v="export-format-${format}"]').click()`);
    await page.session.evaluate("document.querySelector('[data-v=\"export-start\"]').click()");
    await page.session.waitFor("!!document.querySelector('[data-v=\"export-message\"]')", 180000);
    const message = await page.session.evaluate("document.querySelector('[data-v=\"export-message\"]').textContent");
    // 关闭弹窗（取消按钮与关闭按钮同位置，用 Esc 更稳）
    await page.session.evaluate("document.querySelector('[data-v=\"export-dialog\"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
    await page.session.evaluate("document.querySelectorAll('[data-v=\"export-dialog\"] .v-dialog__actions button')[0]?.click()");
    return message;
  };

  const mp4Message = await runExport('mp4');
  report.check(`① MP4 导出完成（${mp4Message}）`, typeof mp4Message === 'string' && mp4Message.includes('.mp4'));
  report.check(`① MP4 含音轨（消息里没有"无音轨"）`, !mp4Message.includes('无音轨'));

  const gifMessage = await runExport('gif');
  report.check(`① GIF 导出完成（${gifMessage}）`, typeof gifMessage === 'string' && gifMessage.includes('.gif'));
  const wavMessage = await runExport('wav');
  report.check(`① WAV 导出完成（${wavMessage}）`, typeof wavMessage === 'string' && wavMessage.includes('.wav'));

  await new Promise((resolve) => setTimeout(resolve, 2500));
  const files = fs.existsSync(DOWNLOAD_DIR) ? fs.readdirSync(DOWNLOAD_DIR) : [];
  const find = (ext) => files.find((name) => name.endsWith(ext));
  const mp4Path = find('.mp4');
  const gifPath = find('.gif');
  const wavPath = find('.wav');
  report.check(`① 三个文件都已落盘（${files.join(', ') || '无'}）`, Boolean(mp4Path && gifPath && wavPath));

  const ffprobeOk = hasTool('ffprobe');
  if (!ffprobeOk) {
    console.log('  · 未找到 ffprobe：跳过 ②③④⑤（产物正确性未验证）');
  } else if (mp4Path) {
    const full = path.join(DOWNLOAD_DIR, mp4Path);
    const probe = spawnSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,codec_type,width,height,r_frame_rate,sample_rate,channels', '-of', 'json', full],
      { encoding: 'utf8' },
    );
    const info = JSON.parse(probe.stdout || '{}');
    const video = (info.streams ?? []).find((stream) => stream.codec_type === 'video');
    const audio = (info.streams ?? []).find((stream) => stream.codec_type === 'audio');
    report.check(
      `② MP4 视频流 h264 1280×720@30（实测 ${video?.codec_name} ${video?.width}×${video?.height}@${video?.r_frame_rate}）`,
      video?.codec_name === 'h264' && video.width === 1280 && video.height === 720 && video.r_frame_rate === '30/1',
    );
    report.check(
      `② MP4 音频流 aac 48k 立体声（实测 ${audio?.codec_name} ${audio?.sample_rate} ${audio?.channels}ch）`,
      audio?.codec_name === 'aac' && audio.sample_rate === '48000' && audio.channels === 2,
    );
    const duration = Number(info.format?.duration ?? 0);
    report.check(`② 时长 8.000s（实测 ${duration.toFixed(3)}s，容差 1 帧 = 0.033s）`, Math.abs(duration - 8) <= 1 / 30);

    // ③ 抽第 137 帧与参考图比 PSNR
    const framePng = path.join(DOWNLOAD_DIR, 'export-137.png');
    spawnSync('ffmpeg', ['-v', 'error', '-i', full, '-vf', 'select=eq(n\\,137)', '-vsync', '0', '-frames:v', '1', '-update', '1', framePng, '-y'], { stdio: 'ignore' });
    const psnr = spawnSync(
      'ffmpeg',
      ['-i', framePng, '-i', path.join(ROOT, 'tests', 'fixtures', 'ref', 'ref_137.png'), '-lavfi', 'psnr', '-f', 'null', '-'],
      { encoding: 'utf8' },
    );
    const match = /average:([0-9.]+)/.exec(`${psnr.stdout}${psnr.stderr}`);
    const value = match ? Number(match[1]) : 0;
    report.check(`③ 导出第 137 帧 PSNR ${value.toFixed(2)}dB ≥ 20dB（跨链路口径）`, value >= 20);

    // ④ 音轨不是静音
    const volume = spawnSync('ffmpeg', ['-i', full, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
    const mean = /mean_volume:\s*(-?[0-9.]+) dB/.exec(`${volume.stdout}${volume.stderr}`);
    const meanDb = mean ? Number(mean[1]) : -999;
    report.check(`④ 音轨均值 ${meanDb.toFixed(1)}dB > -60dB（不是静音）`, meanDb > -60);
  }

  if (ffprobeOk && wavPath) {
    const full = path.join(DOWNLOAD_DIR, wavPath);
    const probe = spawnSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,sample_rate,channels', '-of', 'json', full],
      { encoding: 'utf8' },
    );
    const info = JSON.parse(probe.stdout || '{}');
    const stream = (info.streams ?? [])[0];
    const duration = Number(info.format?.duration ?? 0);
    report.check(
      `⑤ WAV pcm_s16le 48k 2ch 8.000s（实测 ${stream?.codec_name} ${stream?.sample_rate} ${stream?.channels}ch ${duration.toFixed(3)}s）`,
      stream?.codec_name === 'pcm_s16le' && stream.sample_rate === '48000' && stream.channels === 2 && Math.abs(duration - 8) <= 1 / 30,
    );
  }

  if (ffprobeOk && gifPath) {
    const size = fs.statSync(path.join(DOWNLOAD_DIR, gifPath)).size;
    report.check(`① GIF 体积合理（${(size / 1024 / 1024).toFixed(2)}MB < 20MB）`, size > 1024 && size < 20 * 1024 * 1024);
  }
} finally {
  await page.close();
  devServer.kill();
  await fixtures.close();
  report.summary('M3 导出验收');
}
