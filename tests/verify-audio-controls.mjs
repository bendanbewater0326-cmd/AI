/**
 * 音量（dB 映射）+ 峰值保护 + 轨道布局的回归。
 *
 * ## 为什么这套断言长这样
 *
 * 音量滑块现在拖的是**位置**（0~200%），不是振幅：
 *   0% = 静音 · 100% = 0dB（原始音量）· 200% = +12dB
 * 存进 doc 的仍是**线性振幅**（老工程声音不变），所以两头都要断言：
 * **界面显示的 dB** 与 **doc 里的振幅** 必须同时对上（换算见 `core/volume`）。
 *
 * ## 覆盖
 *
 *   ① 三个锚点：100% → 0dB / 50% → -30dB / 200% → +12dB（顺带校验 dB 文案与百分比）
 *   ② 连续拖动只占一个撤销步，撤销一次回到拖动前
 *   ③ 预览音量同样按 dB 走，且真的到了音频引擎（masterGain）
 *   ④ 音量 0 → 时间线上出现红色「静音」标记（"没声音"要看得见）
 *   ⑤ +12dB 播放：峰值不超过天花板、无削顶样本（峰值保护生效）
 *   ⑥ 加两条轨后时间线可纵向滚动到最后一条
 *
 * 运行：`node tests/verify-audio-controls.mjs`
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5233;
const FIXTURE = 'sample-720p.mp4';

/** 位置 → 期望振幅（与 core/volume 同一公式，故意独立写一份做对拍）。 */
const gainAt = (position) =>
  position <= 0 ? 0 : 10 ** ((position <= 1 ? -60 + 60 * position : 12 * (position - 1)) / 20);

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
// 小窗口：正是用户报"看不到下面的轨道"的场景（1280×720）
const page = await launchPage({
  url: `http://127.0.0.1:${PORT}/?src=${fixture.origin}/${FIXTURE}`,
  width: 1280,
  height: 720,
});

const STATE = [
  '(() => JSON.stringify({',
  '  clips: window.__VEDITOR_TEST__.clips().map((c) => ({ id: c.id, track: c.trackId, gain: c.audio.gain })),',
  '  audio: window.__VEDITOR_TEST__.audioProbe(),',
  '  errors: window.__VEDITOR_TEST__.errors().map((e) => e.message),',
  '}))()',
].join('\n');
const state = async () => JSON.parse(await page.session.evaluate(STATE));

/** 设一个 range 控件的值并派发 input/change（等价于用户拖动/键盘调整）。 */
const setRange = (selector, value) =>
  page.session.evaluate(
    [
      '(() => {',
      '  const input = document.querySelector(' + JSON.stringify(selector) + ');',
      '  if (input === null) return "missing";',
      '  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;',
      '  setter.call(input, "' + value + '");',
      '  input.dispatchEvent(new Event("input", { bubbles: true }));',
      '  input.dispatchEvent(new Event("change", { bubbles: true }));',
      '  return input.value;',
      '})()',
    ].join('\n'),
  );

const text = (selector) =>
  page.session
    .evaluate(`document.querySelector('${selector}')?.textContent ?? ''`)
    .then((value) => String(value).trim());

const undoOnce = async () => {
  for (const type of ['keyDown', 'keyUp']) {
    await page.session.send('Input.dispatchKeyEvent', {
      type, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2,
    });
  }
  await sleep(420);
};

/** 时间线上某片段左端 48px 内的"偏红像素"数量（判断静音标记画出来没有）。 */
const redPixelsOnClip = (clipId) =>
  page.session
    .evaluate(
      [
        '(() => {',
        '  const canvas = document.querySelector("[data-v=\\"timeline-canvas\\"]");',
        '  const ctx = canvas.getContext("2d");',
        '  const clip = window.__VEDITOR_TEST__.clips().find((c) => c.id === ' + JSON.stringify(clipId) + ');',
        '  const zoom = window.__VEDITOR_TEST__.zoomLevel();',
        '  const scrollX = Number(canvas.dataset.scrollX ?? "0");',
        '  const layout = window.__VEDITOR_TEST__.timelineLayout();',
        '  const x = Math.round(layout.headerWidth + clip.startFrame * zoom - scrollX);',
        '  const row = layout.rows.find((r) => r.trackId === clip.trackId);',
        '  const data = ctx.getImageData(Math.max(0, x), row.top, 48, 16).data;',
        '  let red = 0;',
        '  for (let i = 0; i + 3 < data.length; i += 4) {',
        '    if (data[i] - data[i + 2] > 60 && data[i] > 120) red += 1;',
        '  }',
        '  return red;',
        '})()',
      ].join('\n'),
    )
    .then(Number);

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 20000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 25000);
  await sleep(1500);

  const before = await state();
  const clipId = before.clips[0].id;
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(clipId)})`);
  await sleep(400);
  report.check(`① 初始 0dB（gain=${before.clips[0].gain}）`, Math.abs(before.clips[0].gain - 1) < 1e-6);
  report.check(
    `① 初始 dB 文案「${await text('[data-v="inspector-gain-value"]')}」`,
    /0\.0 dB/.test(await text('[data-v="inspector-gain-value"]')),
  );

  // ---- ① 三个锚点 ----
  await setRange('[data-v="inspector-gain"]', '0.5');
  await sleep(320);
  const half = await state();
  report.check(
    `① 滑块 50% → -30dB → 振幅 ${half.clips[0].gain.toFixed(4)}（期望 ${gainAt(0.5).toFixed(4)}）`,
    Math.abs(half.clips[0].gain - gainAt(0.5)) < 1e-3,
  );
  const halfLabel = await text('[data-v="inspector-gain-value"]');
  report.check(`① 50% 的 dB 文案「${halfLabel}」`, /-30\.0 dB/.test(halfLabel));

  await setRange('[data-v="inspector-gain"]', '2');
  await sleep(320);
  const boosted = await state();
  const boostedLabel = await text('[data-v="inspector-gain-value"]');
  const percentLabel = await text('[data-v="inspector-gain-percent"]');
  report.check(
    `① 滑块 200% → +12dB → 振幅 ${boosted.clips[0].gain.toFixed(4)}（期望 ${gainAt(2).toFixed(4)}）`,
    Math.abs(boosted.clips[0].gain - gainAt(2)) < 1e-3,
  );
  report.check(`① 200% 的 dB 文案「${boostedLabel}」`, /\+12\.0 dB/.test(boostedLabel));
  report.check(`① 百分比作为辅助「${percentLabel}」`, /200%/.test(percentLabel));

  // ---- ② 连续拖动 = 一个撤销步 ----
  await sleep(1100); // 超过合并窗口，让上一段成为独立的一步
  for (const position of ['1.5', '1.2', '1.1']) {
    await setRange('[data-v="inspector-gain"]', position);
    await sleep(120);
  }
  const afterDrag = await state();
  report.check(
    `② 连续拖动后振幅 ${afterDrag.clips[0].gain.toFixed(4)}（期望 ${gainAt(1.1).toFixed(4)}）`,
    Math.abs(afterDrag.clips[0].gain - gainAt(1.1)) < 1e-3,
  );
  await undoOnce();
  const afterUndo = await state();
  report.check(
    `② 撤销**一次**回到 ${afterUndo.clips[0].gain.toFixed(4)}（期望 ${gainAt(2).toFixed(4)}：整段拖动只占一步）`,
    Math.abs(afterUndo.clips[0].gain - gainAt(2)) < 1e-3,
  );

  // ---- ⑤ +12dB 播放：峰值保护 ----
  await page.session.evaluate('document.querySelector(\'[data-v="play-toggle"]\').click()');
  await sleep(1300);
  await page.session.evaluate('document.querySelector(\'[data-v="play-toggle"]\').click()');
  await sleep(300);
  const played = await state();
  report.check(
    `⑤ +12dB 播放：峰值 ${played.audio?.peak?.toFixed(3)} ≤ 0.999、削顶样本 ${played.audio?.clipped}`,
    played.audio !== null && played.audio.peak <= 0.9991 && played.audio.clipped === 0,
  );

  // ---- ④ 音量 0 → 静音标记 ----
  const redBefore = await redPixelsOnClip(clipId);
  await setRange('[data-v="inspector-gain"]', '0');
  await sleep(400);
  const muted = await state();
  const mutedLabel = await text('[data-v="inspector-gain-value"]');
  const redAfter = await redPixelsOnClip(clipId);
  report.check(
    `④ 音量 0 → gain=${muted.clips[0].gain}，dB 文案「${mutedLabel}」`,
    muted.clips[0].gain === 0 && /-∞ dB/.test(mutedLabel),
  );
  report.check(
    `④ 片段左端出现红色「静音」标记（偏红像素 ${redBefore} → ${redAfter}）`,
    redAfter > redBefore + 40,
  );
  await undoOnce();
  const redRestored = await redPixelsOnClip(clipId);
  report.check(`④ 撤销后标记消失（${redAfter} → ${redRestored}）`, redRestored < redAfter - 40);

  // ---- ③ 预览音量（同一套 dB 曲线，且真的到引擎）----
  await setRange('[data-v="preview-volume"]', '0.5');
  await sleep(350);
  const quiet = await state();
  const previewLabel = await text('[data-v="preview-volume-value"]');
  report.check(
    `③ 预览音量 50% → masterGain=${quiet.audio?.masterGain?.toFixed(4)}（期望 ${gainAt(0.5).toFixed(4)}）`,
    quiet.audio !== null && Math.abs(quiet.audio.masterGain - gainAt(0.5)) < 1e-3,
  );
  report.check(`③ 预览音量 dB 文案「${previewLabel}」`, /-30\.0 dB/.test(previewLabel));
  await setRange('[data-v="preview-volume"]', '1');
  await sleep(300);
  const full = await state();
  report.check(
    `③ 回到 100% → masterGain=${full.audio?.masterGain?.toFixed(3)}`,
    full.audio !== null && Math.abs(full.audio.masterGain - 1) < 1e-3,
  );

  // ---- ⑥ 加轨后仍能看到/操作最后一条轨 ----
  /**
   * 加两条轨：`＋轨道` 现在弹三选一菜单（视频/音频/字幕），要再点一次菜单项。
   * 这是规范 §2.4「添加入口」的样子——比"点一下直接加视频轨"更明确。
   */
  for (let i = 0; i < 2; i += 1) {
    await page.session.evaluate('document.querySelector(\'[data-v="add-track"]\').click()');
    await sleep(250);
    await page.session.evaluate(`(() => {
      const item = Array.from(document.querySelectorAll('[data-v="context-menu"] button'))
        .find((button) => button.textContent.includes('添加视频轨'));
      if (item) item.click();
      return true;
    })()`);
    await sleep(400);
  }
  const layout = JSON.parse(
    await page.session.evaluate(
      [
        '(() => {',
        '  const scroll = document.querySelector("[data-v=\\"timeline-scroll\\"]");',
        '  const tracks = window.__VEDITOR_TEST__.tracks();',
        '  const beforeScroll = { scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight };',
        '  scroll.scrollTop = scroll.scrollHeight;',
        '  const last = tracks[tracks.length - 1];',
        '  // 视频轨是 hide-，音频轨是 mute-（按类型给不同按钮）',
        '  const button = document.querySelector(`[data-v="hide-${last.id}"], [data-v="mute-${last.id}"]`);',
        '  const rect = button === null ? null : button.getBoundingClientRect();',
        '  return JSON.stringify({ trackCount: tracks.length, lastName: last.name, beforeScroll,',
        '    afterScrollTop: scroll.scrollTop,',
        '    lastButtonVisible: rect === null ? false : rect.top >= 0 && rect.bottom <= window.innerHeight });',
        '})()',
      ].join('\n'),
    ),
  );
  report.check(
    `⑥ 加轨后可纵向滚动（内容 ${layout.beforeScroll.scrollHeight}px / 可视 ${layout.beforeScroll.clientHeight}px）`,
    layout.beforeScroll.scrollHeight > layout.beforeScroll.clientHeight,
  );
  report.check(
    `⑥ 滚到底后最后一条轨（${layout.lastName}）的按钮可见`,
    layout.afterScrollTop > 0 && layout.lastButtonVisible === true,
  );

  const errors = (await state()).errors;
  report.check(`⑦ 全程无错误条（${JSON.stringify(errors)}）`, errors.length === 0);

  report.summary('音量（dB）/ 峰值保护 / 轨道布局');
} finally {
  await page.close();
  dev.kill();
  await fixture.close();
}
