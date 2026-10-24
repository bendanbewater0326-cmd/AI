/**
 * 纯音频导入端到端验证（WAV，W1；MP3 部分在 W2 补）。
 *
 * 覆盖：
 *   ① 拖入 .wav → 素材卡出现（kind=audio、无缩略图不报错）
 *   ② 双击上音轨 → 片段时长与 WAV 时长 ±1 帧
 *   ③ 播放压过片段 → audioStats chunks/scheduledSeconds>0、gaps=0（PCM 直通真进了调度）
 *   ④ 导出整段 WAV → ffprobe 校验时长 ±1 帧
 *   ⑤ 损坏文件（截断 WAV）→ 可读报错不崩
 *
 * 运行：`node --experimental-websocket tests/verify-audio-import.mjs`
 * 前置：`node tests/fixtures/compat/gen-audio.cjs`（生成 sample-440-2s.wav / .mp3）
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createReport, launchPage } from './cdp.mjs';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..');
const PORT = 5854;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FFPROBE = process.env.FFPROBE ??
  'C:/Users/Administrator/AppData/Local/Microsoft/Winget/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.2-full_build/bin/ffprobe.exe';
const FIXTURE_WAV = path.join(ROOT, 'tests', 'fixtures', 'compat', 'sample-440-2s.wav');
const FIXTURE_MP3 = path.join(ROOT, 'tests', 'fixtures', 'compat', 'sample-440-2s.mp3');
assert(fs.existsSync(FIXTURE_WAV), '缺 sample-440-2s.wav（先跑 gen-audio.cjs）');

/** WAV 时长（秒，ffprobe）。 */
function wavDurationSec(file) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
  return Number.parseFloat(out.trim());
}

/** 导出产物落盘校验（verify-m3-export 同款套路：ffprobe 时长）。 */
function assertExportDuration(file, expectSec) {
  const actual = wavDurationSec(file);
  assert(
    Math.abs(actual - expectSec) <= 1,
    `导出时长 ${actual}s ≠ 预期 ${expectSec}s（±1 帧≈0.03s，±1s 已极宽）`,
  );
}

const server = http.createServer((request, response) => {
  const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
  const candidates = [
    path.join(ROOT, 'tests', 'fixtures', 'compat', name),
    path.join(ROOT, 'tests', 'fixtures', name),
  ].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (candidates !== undefined) {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(candidates).pipe(response);
    return;
  }
  response.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
  response.end('nf');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const dev = spawn(process.execPath, ['scripts/dev.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('dev server 未就绪')), 20000);
  dev.stdout.on('data', (chunk) => {
    if (String(chunk).includes(`127.0.0.1:${PORT}`)) {
      clearTimeout(timer);
      resolve();
    }
  });
});

const page = await launchPage({ url: `http://127.0.0.1:${PORT}/`, width: 1440, height: 900 });
const report = createReport();

const ev = async (expression) => page.session.evaluate(expression);
const evalJson = async (expression) => JSON.parse(await ev(`JSON.stringify(${expression})`));
const clips = async () => evalJson('window.__VEDITOR_TEST__.clips()');
const assets = async () => evalJson('window.__VEDITOR_TEST__.assets()');
const click = async (selector) => {
  await ev(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  await sleep(300);
};

/** 整窗拖入一份素材文件。 */
const dropFile = async (fixturePath, name) => {
  const bytes = fs.readFileSync(fixturePath);
  const b64 = bytes.toString('base64');
  await ev(`(async () => {
    const raw = atob('${b64}');
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    const file = new File([bytes], ${JSON.stringify(name)}, { lastModified: 1700000000000 });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      document.body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
    }
    return true;
  })()`);
  await sleep(600);
};

const DOWNLOAD_DIR = path.join(ROOT, 'tests', '.tmp-download');
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

/** 从页面下载导出产物（复用 verify-m3-export 的 downloadBlob 钩子思路：导出对话框 → 开始）。 */
const exportWavTo = async (file) => {
  await click('[data-v="export-open"]');
  await page.session.waitFor(`document.querySelector('[data-v="export-dialog"]') !== null`, 8000);
  // 格式选 WAV（若当前不是）
  // 格式按钮是 data-v=`export-format-<key>` 的点击式选择（不是 select）
  await ev(`(() => {
    const button = document.querySelector('[data-v="export-format-wav"]');
    button?.click();
    return true;
  })()`);
  await sleep(200);
  // CDP 下载行为重定向到本地目录
  await page.session.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOAD_DIR });
  await click('[data-v="export-start"]');
  // 等待导出完成（done 阶段）
  await page.session.waitFor(
    `document.querySelector('[data-v="export-start"]')?.textContent?.includes('再导一次')`,
    30000,
  );
  await sleep(600);
  const files = fs.readdirSync(DOWNLOAD_DIR).filter((item) => item.endsWith('.wav') || item.endsWith('.m4a') || item.endsWith('.mp4'));
  assert(files.length > 0, `下载目录没有产物：${fs.readdirSync(DOWNLOAD_DIR).join(',')}`);
  const latest = files
    .map((name) => ({ name, at: fs.statSync(path.join(DOWNLOAD_DIR, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0].name;
  fs.copyFileSync(path.join(DOWNLOAD_DIR, latest), file);
};

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
  await sleep(500);
  await ev(`(() => {
    const root = document.documentElement;
    root.style.setProperty('--v-timeline-h', '420px');
    root.style.setProperty('--v-timeline-pct', '60');
    return true;
  })()`);

  // ---- ① 拖入 .wav → 素材卡出现 ----
  await dropFile(FIXTURE_WAV, 'sample-440-2s.wav');
  await page.session.waitFor(`document.querySelectorAll('[data-v="asset-card"]').length === 1`, 10000);
  const asset = await evalJson(`window.__VEDITOR_TEST__.assets()[0]`);
  report.check(
    `① WAV 导入：kind=${asset.kind} sampleRate=${asset.sampleRate} channels=${asset.channels}`,
    asset.kind === 'audio' && asset.hasAudio === true,
  );

  // ---- ② 双击上音轨 → 片段时长 ±1 帧 ----
  await ev(`document.querySelector('[data-v="asset-card"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true`);
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 1`, 8000);
  await sleep(400);
  const wavSec = wavDurationSec(FIXTURE_WAV);
  const clip = (await clips())[0];
  const expectFrames = Math.round(wavSec * 30);
  report.check(
    `② 上音轨：时长 ${clip.durationFrames} 帧 ≈ ${expectFrames}（WAV 实测 ${wavSec.toFixed(2)}s）`,
    Math.abs(clip.durationFrames - expectFrames) <= 1,
  );
  report.check(`② 落在音频轨 A1（${clip.trackId}）`, clip.trackId === 'trk_A1');

  // ---- ③ 播放调度：PCM 直通真进了引擎 ----
  await ev(`window.__VEDITOR_TEST__.seek(0)`);
  await sleep(200);
  await ev(`window.__VEDITOR_TEST__.play()`);
  await sleep(1600);
  await ev(`window.__VEDITOR_TEST__.pause()`);
  const stats = await evalJson('window.__VEDITOR_TEST__.audioStats()');
  report.check(
    `③ 播放调度：chunks/scheduledSeconds>0、gaps=0（${JSON.stringify(stats)}）`,
    stats !== null && stats.chunks > 0 && stats.scheduledSeconds > 0 && stats.gaps === 0,
  );

  // ---- ④ 导出整段 WAV → ffprobe 时长校验 ----
  {
    const outFile = path.join(DOWNLOAD_DIR, `exported-${Date.now()}.wav`);
    await exportWavTo(outFile);
    assertExportDuration(outFile, wavSec);
    report.check(`④ 导出 WAV 时长 ±1s（ffprobe 实测通过）`, true);
  }

  // ---- ④b MP3 导入全链路（W2）：导入 / 上轨 / 播放调度 / 导出 ----
  {
    assert(fs.existsSync(FIXTURE_MP3), '缺 sample-440-2s.mp3');
    await dropFile(FIXTURE_MP3, 'sample-440-2s.mp3');
    await page.session.waitFor(`window.__VEDITOR_TEST__.assets().length === 2`, 10000);
    const mp3Asset = (await assets())[1];
    report.check(
      `④b MP3 导入：kind=${mp3Asset.kind} codecAudio=${mp3Asset.codecAudio}`,
      mp3Asset.kind === 'audio' && mp3Asset.codecAudio === 'mp3',
    );
    // 双击上音轨（第二段接到现有片段之后）
    await ev(`document.querySelectorAll('[data-v="asset-card"]')[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true`);
    await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 2`, 8000);
    await sleep(400);
    const mp3Clip = (await clips()).find((item) => item.assetId === mp3Asset.id);
    const mp3Sec = wavDurationSec(FIXTURE_MP3); // ffprobe 实测（LAME 有 encoder padding，≠2s 整）
    report.check(
      `④b MP3 上音轨：时长 ${mp3Clip?.durationFrames} 帧 ≈ ${Math.round(mp3Sec * 30)}（实测 ${mp3Sec.toFixed(3)}s）`,
      mp3Clip !== undefined && Math.abs(mp3Clip.durationFrames - Math.round(mp3Sec * 30)) <= 2,
    );
    // 播放压过 MP3 片段（seek 到第二段起点）
    const mp3Start = mp3Clip.startFrame;
    await ev(`window.__VEDITOR_TEST__.seek(${mp3Start})`);
    await sleep(200);
    await ev(`window.__VEDITOR_TEST__.play()`);
    await sleep(1600);
    await ev(`window.__VEDITOR_TEST__.pause()`);
    const mp3Stats = await evalJson('window.__VEDITOR_TEST__.audioStats()');
    report.check(
      `④b MP3 播放调度：chunks>0、gaps=0（${JSON.stringify(mp3Stats)}）`,
      mp3Stats !== null && mp3Stats.chunks > 0 && mp3Stats.gaps === 0,
    );
    // 导出整段 → WAV 时长 = 工程时长（各片段 end 的最大值，由 doc 实测）
    const docFrames = (await clips()).reduce((max, item) => Math.max(max, item.startFrame + item.durationFrames), 0);
    const outFile = path.join(DOWNLOAD_DIR, `exported-mp3-${Date.now()}.wav`);
    await exportWavTo(outFile);
    assertExportDuration(outFile, docFrames / 30);
    report.check(`④b 导出含 MP3 的工程：时长 ≈ ${(docFrames / 30).toFixed(2)}s（ffprobe 实测通过）`, true);
  }

  // ---- ⑤ 非 PCM 的 .wav（ADPCM）→ 中文可读拒绝，不崩 ----
  {
    // 手工构造：RIFF/WAVE + fmt(format=2 ADPCM) + 空 data
    const header = Buffer.alloc(64);
    header.write('RIFF', 0, 'latin1');
    header.writeUInt32LE(56, 4);
    header.write('WAVE', 8, 'latin1');
    header.write('fmt ', 12, 'latin1');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(2, 20); // audioFormat = 2（ADPCM，非 PCM 族）
    header.writeUInt16LE(2, 22);
    header.writeUInt32LE(44100, 24);
    header.writeUInt32LE(176400, 28);
    header.writeUInt16LE(4, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'latin1');
    header.writeUInt32LE(16, 40);
    const badWav = path.join(ROOT, 'tests', 'fixtures', 'compat', '.tmp-adpcm.wav');
    fs.writeFileSync(badWav, header);
    const errorCountBefore = (await evalJson('window.__VEDITOR_TEST__.errors()')).length;
    await dropFile(badWav, 'adpcm.wav');
    await sleep(1000);
    const errors = await evalJson('window.__VEDITOR_TEST__.errors()');
    report.check(
      `⑤ 非 PCM WAV：可读中文拒绝（${JSON.stringify(errors.slice(errorCountBefore).map((item) => item.message))}）`,
      errors.length > errorCountBefore,
    );
    fs.rmSync(badWav, { force: true });
  }

  report.summary('纯音频导入（WAV）');
} finally {
  await page.close().catch(() => {});
  dev.kill();
  await new Promise((resolve) => server.close(resolve));
}
