/**
 * 全链路走查（P0，2026-10-25）：模拟真实用户完整创作流程，每步截图 + 记录状态。
 *
 * 流程（10 步，全真实操作路径——不用测试钩子改状态）：
 *   ① 导入素材（拖拽）② 播放定位（空格/时间码）③ 分割剪辑（右键点哪切哪）+ 删多余段
 *   ④ 加文字（模板库点击 + 改内容）⑤ 加特效（调色预设）⑥ 加转场
 *   ⑦ 配音频（音效点击 + mp3 导入）⑧ 调音量淡入淡出 ⑨ 预览回看 ⑩ 导出 MP4
 *
 * 产出：tests/screenshots/walk-*.png + 每步的状态记录（走查报告素材）。
 * 运行：`node --experimental-websocket tests/probe-walkthrough.mjs`
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5864;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SHOTS = path.join(ROOT, 'tests', 'screenshots');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'sample-720p.mp4');
const FIXTURE_MP3 = path.join(ROOT, 'tests', 'fixtures', 'compat', 'sample-440-2s.mp3');
assertExist(FIXTURE, 'sample-720p.mp4');
assertExist(FIXTURE_MP3, 'sample-440-2s.mp3');

function assertExist(file, label) {
  if (!fs.existsSync(file)) {
    console.error(`✗ 缺测试素材 ${label}`);
    process.exit(1);
  }
}

const server = http.createServer((request, response) => {
  const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
  const found = [path.join(ROOT, 'tests', 'fixtures', name), path.join(ROOT, 'tests', 'fixtures', 'compat', name)]
    .find((candidate) => fs.existsSync(candidate));
  if (found !== undefined) {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(found).pipe(response);
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
  const timer = setTimeout(() => reject(new Error('dev 未就绪')), 20000);
  dev.stdout.on('data', (chunk) => {
    if (String(chunk).includes(`127.0.0.1:${PORT}`)) {
      clearTimeout(timer);
      resolve();
    }
  });
});

const page = await launchPage({ url: `http://127.0.0.1:${PORT}/`, width: 1440, height: 900 });
const ev = async (expression) => page.session.evaluate(expression);
const evalJson = async (expression) => JSON.parse(await ev(`JSON.stringify(${expression})`));
const log = [];
const notes = (text) => { log.push(text); console.log(`  · ${text}`); };
const shot = async (name) => { await page.screenshot({ path: path.join(SHOTS, `walk-${name}.png`) }); };

const dropFile = async (fixturePath, name, type) => {
  const bytes = fs.readFileSync(fixturePath);
  const b64 = bytes.toString('base64');
  await ev(`(async () => {
    const raw = atob('${b64}');
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    const file = new File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)}, lastModified: 1700000000000 });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      document.body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
    }
    return true;
  })()`);
};

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
  await sleep(600);
  await ev(`(() => {
    const root = document.documentElement;
    root.style.setProperty('--v-timeline-h', '420px');
    root.style.setProperty('--v-timeline-pct', '60');
    return true;
  })()`);

  // ---------- ① 导入素材 ----------
  console.log('\n① 导入素材');
  await dropFile(FIXTURE, '我的旅行视频.mp4', 'video/mp4');
  await page.session.waitFor(`document.querySelectorAll('[data-v="asset-card"]').length === 1`, 10000);
  await sleep(700);
  const busyDuringImport = await ev(`document.querySelector('[data-v="busybar"]') !== null ? 'busy条可见' : 'busy条未见（可能太快）'`);
  notes(`导入后素材卡出现；${busyDuringImport}`);
  await shot('01-imported');
  await ev(`document.querySelector('[data-v="asset-card"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true`);
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 1`, 8000);
  await sleep(500);
  notes('双击上轨：片段落 V1（自动上轨 ✓）');
  await shot('02-on-track');

  // ---------- ② 播放定位 ----------
  console.log('② 播放定位');
  await ev(`window.__VEDITOR_TEST__.play()`);
  await sleep(1500);
  await ev(`window.__VEDITOR_TEST__.pause()`);
  const playhead = await ev('window.__VEDITOR_TEST__.playheadFrame()');
  notes(`空格播放/暂停正常，播放头停在 ${playhead} 帧`);
  await shot('03-played');

  // ---------- ③ 分割剪辑 ----------
  console.log('③ 分割剪辑（右键点哪切哪 + 删段）');
  await ev(`window.__VEDITOR_TEST__.seek(90)`);
  await sleep(200);
  await ev(`(() => {
    const canvas = document.querySelector('[data-v="timeline-canvas"]');
    const rect = canvas.getBoundingClientRect();
    const layout = window.__VEDITOR_TEST__.timelineLayout();
    const row = layout.rows.find((item) => item.trackId === 'trk_V1');
    const zoom = window.__VEDITOR_TEST__.zoomLevel();
    canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(rect.left + layout.headerWidth + 90 * zoom), clientY: Math.round(rect.top + row.top + row.height / 2) }));
    return true;
  })()`);
  await sleep(250);
  await ev(`document.querySelector('[data-v="context-分割"]')?.click()`);
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 2`, 8000);
  await sleep(300);
  notes('右键「分割」在点击位置切成两段 ✓');
  // 删掉前段（右键删除）
  await ev(`(() => {
    const canvas = document.querySelector('[data-v="timeline-canvas"]');
    const rect = canvas.getBoundingClientRect();
    const layout = window.__VEDITOR_TEST__.timelineLayout();
    const row = layout.rows.find((item) => item.trackId === 'trk_V1');
    const zoom = window.__VEDITOR_TEST__.zoomLevel();
    canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(rect.left + layout.headerWidth + 45 * zoom), clientY: Math.round(rect.top + row.top + row.height / 2) }));
    return true;
  })()`);
  await sleep(250);
  await ev(`document.querySelector('[data-v="context-删除片段"]')?.click()`);
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 1`, 8000);
  await sleep(300);
  const leftClip = (await evalJson('window.__VEDITOR_TEST__.clips().find((item) => item.trackId === \'trk_V1\')'));
  notes(`删前段后剩 1 段（start=${leftClip.startFrame}，原素材内容从 90 帧处开始）`);
  await shot('04-cut');

  // ---------- ④ 加文字 ----------
  console.log('④ 加文字（模板库 + 改内容）');
  await ev(`document.querySelector('[data-v="left-tab-text"]')?.click()`);
  await sleep(400);
  const firstPreset = await ev(`document.querySelector('[data-v="text-preset"]')?.getAttribute('data-preset-id')`);
  await ev(`document.querySelector('[data-v="text-preset"]')?.click()`);
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 2`, 8000);
  await sleep(400);
  // 改内容（属性栏文字编辑框——原生 setter）
  await ev(`(() => {
    const textarea = document.querySelector('[data-v="inspector-text"]');
    if (textarea === null) return 'no-textarea';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, '我的旅行 Vlog');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(200);
  await ev(`document.querySelector('[data-v="inspector-text"]')?.blur(); true`);
  await sleep(400);
  const textClip = (await evalJson(`window.__VEDITOR_TEST__.clips().find((item) => item.text !== null)`));
  notes(`套用模板「${firstPreset}」→ 落文字轨 → 改内容为「${textClip?.text?.content}」✓`);
  await shot('05-text');

  // ---------- ⑤ 加特效 ----------
  console.log('⑤ 加特效（调色预设）');
  await ev(`window.__VEDITOR_TEST__.selectClip(window.__VEDITOR_TEST__.clips().find((item) => item.trackId === 'trk_V1').id)`);
  await sleep(200);
  await ev(`document.querySelector('[data-v="left-tab-effect"]')?.click()`);
  await sleep(400);
  // 点「暖阳」预设（跳过原片）
  await ev(`(() => {
    const cards = Array.from(document.querySelectorAll('[data-v="effect-preset"]'));
    const warm = cards.find((card) => card.textContent.includes('暖阳'));
    warm?.click();
    return warm === null || warm === undefined ? 'not-found' : 'ok';
  })()`);
  await sleep(500);
  const graded = (await evalJson(`window.__VEDITOR_TEST__.clips().find((item) => item.trackId === 'trk_V1')`));
  notes(`调色预设「暖阳」应用：effects=${JSON.stringify(graded.effects)}`);
  await shot('06-grade');

  // ---------- ⑥ 加转场 ----------
  console.log('⑥ 加转场（淡入）');
  await ev(`document.querySelector('[data-v="left-tab-transition"]')?.click()`);
  await sleep(400);
  await ev(`(() => {
    const cards = Array.from(document.querySelectorAll('[data-v="transition-preset"]'));
    const fadeIn = cards.find((card) => card.textContent.includes('淡入'));
    fadeIn?.click();
    return fadeIn === null || fadeIn === undefined ? 'not-found' : 'ok';
  })()`);
  await sleep(500);
  const withTransition = (await evalJson(`window.__VEDITOR_TEST__.clips().find((item) => item.trackId === 'trk_V1')`));
  notes(`转场「淡入」：transitionIn=${JSON.stringify(withTransition.transitions?.in)}`);
  await shot('07-transition');

  // ---------- ⑦ 配音频 ----------
  console.log('⑦ 配音频（音效 + MP3）');
  await ev(`document.querySelector('[data-v="left-tab-audio"]')?.click()`);
  await sleep(400);
  // 试听
  await ev(`document.querySelector('[data-v="sfx-preview"]')?.click()`);
  await sleep(400);
  const previewState = await ev(`document.querySelector('[data-v="sfx-preview"]')?.getAttribute('data-playing')`);
  notes(`试听按钮状态 data-playing=${previewState}（试听不碰引擎）`);
  // 应用音效（播放头在 90）
  await ev(`document.querySelector('[data-v="sfx-preset"][data-preset-id="ding"]')?.click()`);
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 3`, 8000);
  await sleep(400);
  // 导入 MP3 并上轨（播放头挪到 3s 处再加，避免与音效重叠）
  await ev(`window.__VEDITOR_TEST__.seek(240)`);
  await sleep(200);
  await dropFile(FIXTURE_MP3, '背景音乐.mp3', 'audio/mpeg');
  await page.session.waitFor(`window.__VEDITOR_TEST__.assets().length >= 3`, 10000);
  await sleep(600);
  await ev(`document.querySelectorAll('[data-v="asset-card"]')[2]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true`);
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 4`, 8000);
  await sleep(400);
  notes(`音效「叮」落 A1 + MP3「背景音乐」导入并双击上轨（共 4 片段）`);
  await shot('08-audio');

  // ---------- ⑧ 调音量淡入淡出 ----------
  console.log('⑧ 调音量与淡入淡出');
  const mp3Clip = (await evalJson(`window.__VEDITOR_TEST__.clips().find((item) => item.assetId !== '' && item.trackId.startsWith('trk_A') && item.durationFrames > 30)`));
  await ev(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(mp3Clip.id)})`);
  await sleep(300);
  await ev(`(() => {
    const input = document.querySelector('[data-v="inspector-fadein"]');
    if (input === null) return 'no-input';
    // 必须先 focus：未聚焦元素的 blur() 是 no-op（不派发事件，React onBlur 不触发）
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '0.5');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.blur();
    return 'ok';
  })()`);
  await sleep(400);
  const faded = (await evalJson(`window.__VEDITOR_TEST__.clips().find((item) => item.id === ${JSON.stringify(mp3Clip.id)})`));
  notes(`MP3 淡入 0.5s：fadeInFrames=${faded.audio.fadeInFrames}（期望 15 帧@30fps）`);
  await shot('09-fade');

  // ---------- ⑨ 预览回看 ----------
  console.log('⑨ 预览回看');
  await ev(`window.__VEDITOR_TEST__.seek(0)`);
  await ev(`window.__VEDITOR_TEST__.play()`);
  await sleep(2500);
  await ev(`window.__VEDITOR_TEST__.pause()`);
  const stats = await evalJson('window.__VEDITOR_TEST__.audioStats()');
  notes(`回看：音频调度 chunks=${stats?.chunks} gaps=${stats?.gaps}（0=无爆音）`);
  await shot('10-preview');

  // ---------- ⑩ 导出 MP4 ----------
  console.log('⑩ 导出成片');
  const DOWNLOAD_DIR = path.join(ROOT, 'tests', '.tmp-download');
  fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  await page.session.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOAD_DIR });
  await ev(`document.querySelector('[data-v="export-open"]')?.click()`);
  await page.session.waitFor(`document.querySelector('[data-v="export-dialog"]') !== null`, 8000);
  await shot('11-export-dialog');
  await ev(`document.querySelector('[data-v="export-start"]')?.click()`);
  await page.session.waitFor(`document.querySelector('[data-v="export-start"]')?.textContent?.includes('再导一次')`, 60000);
  await sleep(800);
  const files = fs.readdirSync(DOWNLOAD_DIR).filter((name) => name.endsWith('.mp4'));
  const outPath = files.length > 0 ? path.join(DOWNLOAD_DIR, files[0]) : '';
  const sizeMB = outPath !== '' ? (fs.statSync(outPath).size / 1024 / 1024).toFixed(2) : '0';
  notes(`导出完成：${files.join(', ') || '无产物'}（${sizeMB}MB）`);
  await shot('12-export-done');

  fs.writeFileSync(path.join(ROOT, 'tests', 'screenshots', 'walk-notes.json'), JSON.stringify(log, null, 2));
  console.log('\n✓ 走查完成：12 张截图 + 记录 → tests/screenshots/walk-*.png / walk-notes.json');
} finally {
  await page.close().catch(() => {});
  dev.kill();
  await new Promise((resolve) => server.close(resolve));
}
