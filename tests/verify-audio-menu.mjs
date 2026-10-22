/**
 * 右键菜单里的音频三件事（用户 2026-10-21 反馈："视频也允许导出或导入音频和删除音频"）。
 *
 *   ① 片段菜单必须同时有：分离音频 / 导出这段的音频… / 配一段音频… / 删除音频 / 静音 / 复制 / 删除片段
 *   ② 删除音频（只留画面）→ `role: 'video'`，一次撤销能回来
 *   ③ 分离音频 → 两个片段：V1 上 `role: 'video'`、音频轨上 `role: 'audio'`，音画同区间
 *   ④ 分离出来的音频片段右键 → 导出这段的音频…**可点**（导出 WAV 真的落盘、RIFF 头正确）
 *   ⑤ 空白处右键 → 永远有菜单（至少"在此处插入音频…"）
 *
 * ## 为什么④必须真的落盘
 *
 * "菜单项点了没反应"是这个项目反复出现的坑（菜单 portal / 贴边 / 事件顺序都踩过）。
 * 只断言"点了不报错"等于没断言——必须看到文件真的写出来，而且开头是 `RIFF/WAVE`。
 *
 * 运行：`node tests/verify-audio-menu.mjs`
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5224;
const FIXTURE = 'sample-720p.mp4';

function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
    const found = [
      path.join(ROOT, 'tests', 'fixtures', 'compat', name),
      path.join(ROOT, 'tests', 'fixtures', 'hardline', name),
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = createReport();
const fixture = await startFixtureServer();
const dev = await startDevServer();
const DOWNLOAD_DIR = path.join(ROOT, 'tests', '.tmp', 'audio-menu');
fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
const page = await launchPage({
  url: `http://127.0.0.1:${PORT}/?src=${fixture.origin}/${FIXTURE}`,
  width: 1440,
  height: 900,
});

/** 画布几何（帧 → 屏幕坐标必须换算，不能假设 1:1）。 */
let geo = { left: 0, top: 0, cssWidth: 1, canvasWidth: 1, zoom: 5 };
async function geometry() {
  return JSON.parse(
    await page.session.evaluate(`(() => {
      const canvas = document.querySelector('[data-v="timeline-canvas"]');
      const rect = canvas.getBoundingClientRect();
      return JSON.stringify({
        left: rect.left,
        top: rect.top,
        cssWidth: rect.width,
        canvasWidth: canvas.width,
        zoom: window.__VEDITOR_TEST__.zoomLevel(),
        scrollX: Number(canvas.dataset.scrollX ?? '0'),
        // 几何从钩子取（轨道头 130px、轨道高 60/50/32）
        headerWidth: window.__VEDITOR_TEST__.timelineLayout().headerWidth,
        rows: window.__VEDITOR_TEST__.timelineLayout().rows,
      });
    })()`),
  );
}

const state = async () =>
  JSON.parse(
    await page.session.evaluate(`JSON.stringify({
      clips: window.__VEDITOR_TEST__.clips().map((clip) => ({
        id: clip.id,
        trackId: clip.trackId,
        start: clip.startFrame,
        duration: clip.durationFrames,
        role: clip.role,
      })),
      tracks: window.__VEDITOR_TEST__.tracks(),
      errors: window.__VEDITOR_TEST__.errors().map((item) => item.message),
    })`),
  );

/** 轨道在屏幕上的行号（与 `trackDisplayOrder` 一致：视频按 order 降序，音频垫底）。 */
function trackRowIndex(tracks, trackId) {
  const ordered = [...tracks].sort((left, right) => {
    const leftAudio = left.kind === 'audio' ? 1 : 0;
    const rightAudio = right.kind === 'audio' ? 1 : 0;
    if (leftAudio !== rightAudio) return leftAudio - rightAudio;
    if (left.order !== right.order) return right.order - left.order;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return ordered.findIndex((track) => track.id === trackId);
}

async function rightClickClip(clip) {
  geo = await geometry();
  const scale = geo.cssWidth / geo.canvasWidth;
  const row = geo.rows.findIndex((item) => item.trackId === clip.trackId);
  const frame = clip.start + Math.min(10, clip.duration - 1);
  const x = Math.round(geo.left + (geo.headerWidth + frame * geo.zoom - geo.scrollX) * scale);
  const y = Math.round(geo.top + (geo.rows[row].top + geo.rows[row].height / 2) * scale);
  // 合成 contextmenu：CDP 的右键在时间线刚滚动过时会落空（几何算出来偏）
  await page.session.evaluate(`(() => {
    const canvas = document.querySelector('[data-v="timeline-canvas"]');
    canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y} }));
    return true;
  })()`);
  await sleep(320);
}

async function menuText() {
  return String(
    await page.session.evaluate(`document.querySelector('[data-v="context-menu"]')?.textContent ?? ''`),
  );
}

/** 点菜单里文字包含 `label` 的那一项（按真实坐标点，验证"点得动"）。 */
async function clickMenuItem(label) {
  const rect = JSON.parse(
    await page.session.evaluate(`(() => {
      const menu = document.querySelector('[data-v="context-menu"]');
      if (menu === null) return JSON.stringify({ x: -1, y: -1 });
      const button = Array.from(menu.querySelectorAll('button')).find((item) => item.textContent.includes(${JSON.stringify(label)}));
      if (button === undefined) return JSON.stringify({ x: -1, y: -1 });
      const box = button.getBoundingClientRect();
      return JSON.stringify({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
    })()`),
  );
  if (rect.x < 0) throw new Error(`菜单里没有"${label}"`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.session.send('Input.dispatchMouseEvent', {
      type,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: 1,
    });
  }
  await sleep(500);
}

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 15000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 25000);
  await sleep(1200);
  await page.session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOAD_DIR });

  // ---- ① 菜单项齐全 ----
  let clips = (await state()).clips;
  await rightClickClip(clips[0]);
  const text = await menuText();
  const wanted = ['分离音频', '导出这段的音频', '配一段音频', '删除音频', '静音', '复制', '删除片段'];
  const missing = wanted.filter((label) => !text.includes(label));
  report.check(`① 片段菜单 ${wanted.length} 项齐全（缺 ${JSON.stringify(missing)}）`, missing.length === 0);

  // ---- ② 删除音频（只留画面）→ role=video，一次撤销回来 ----
  await clickMenuItem('删除音频');
  let after = (await state()).clips;
  const deletedRole = after.find((clip) => clip.id === clips[0].id)?.role;
  report.check(`② 删除音频后 role=${JSON.stringify(deletedRole)}（应为 video）`, deletedRole === 'video');

  await page.session.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2,
  });
  await page.session.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2,
  });
  await sleep(600);
  after = (await state()).clips;
  const restoredRole = after.find((clip) => clip.id === clips[0].id)?.role;
  report.check(`② 撤销后 role=${JSON.stringify(restoredRole)}（应为 null）`, restoredRole === null);

  // ---- ③ 分离音频 → 画面/声音各一段 ----
  await rightClickClip(after[0]);
  await clickMenuItem('分离音频');
  after = (await state()).clips;
  const videoPart = after.find((clip) => clip.role === 'video');
  const audioPart = after.find((clip) => clip.role === 'audio');
  report.check(
    `③ 分离出画面(${videoPart === undefined ? '无' : videoPart.trackId}) + 声音(${audioPart === undefined ? '无' : audioPart.trackId})`,
    after.length === 2 && videoPart !== undefined && audioPart !== undefined,
  );
  report.check(
    `③ 音画同区间（${videoPart?.start}+${videoPart?.duration} vs ${audioPart?.start}+${audioPart?.duration}）`,
    videoPart !== undefined &&
      audioPart !== undefined &&
      videoPart.start === audioPart.start &&
      videoPart.duration === audioPart.duration,
  );

  // ---- ④ 分离出来的音频片段 → 导出这段的音频（真的落盘） ----
  await rightClickClip(audioPart);
  const audioMenuText = await menuText();
  report.check(
    `④ 音频片段菜单有"导出这段的音频"（"${audioMenuText.slice(0, 24)}…"）`,
    audioMenuText.includes('导出这段的音频'),
  );
  await clickMenuItem('导出这段的音频');

  const deadline = Date.now() + 90000;
  let files = [];
  while (Date.now() < deadline) {
    files = fs.readdirSync(DOWNLOAD_DIR).filter((name) => name.endsWith('.wav'));
    if (files.length > 0) break;
    await sleep(700);
  }
  report.check(`④ WAV 落盘（${files.join(', ') || '无'}）`, files.length === 1);

  let header = '';
  let bytes = 0;
  if (files.length === 1) {
    const buffer = fs.readFileSync(path.join(DOWNLOAD_DIR, files[0]));
    bytes = buffer.length;
    header = buffer.subarray(0, 12).toString('latin1');
  }
  report.check(
    `④ 是合法 WAV（头 "${header.replace(/[^\x20-\x7e]/g, '·')}"，${bytes} 字节）`,
    header.startsWith('RIFF') && header.slice(8, 12) === 'WAVE' && bytes > 44,
  );

  // ---- ⑤ 空白处右键永远有菜单 ----
  geo = await geometry();
  const scale = geo.cssWidth / geo.canvasWidth;
  const blankX = Math.round(geo.left + (geo.headerWidth + 600 * geo.zoom - geo.scrollX) * scale);
  const blankY = Math.round(geo.top + (geo.rows[1].top + geo.rows[1].height / 2) * scale);
  await page.session.evaluate(`(() => {
    const canvas = document.querySelector('[data-v="timeline-canvas"]');
    canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${blankX}, clientY: ${blankY} }));
    return true;
  })()`);
  await sleep(320);
  const blankText = await menuText();
  report.check(`⑤ 空白处右键有"在此处插入音频…"（"${blankText.trim()}"）`, blankText.includes('在此处插入音频'));

  const errors = (await state()).errors;
  report.check(`⑥ 全程无错误条（${JSON.stringify(errors)}）`, errors.length === 0);

  report.summary('右键菜单 · 音频三件事');
} finally {
  await page.close();
  dev.kill();
  await fixture.close();
  fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
}
