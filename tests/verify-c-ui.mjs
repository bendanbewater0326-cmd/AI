/**
 * C 批 UI 验收：文字片段（R-034）+ 调色（R-035）+ 音量淡化（R-037）。
 *
 * 验证：
 *   ① 「＋ 文本」在播放头处生成 3 秒文本片段，落在最上层视频轨
 *   ② 文本真的画进了预览（白色文字 → 画面最大亮度接近 255）
 *   ③ 属性栏出现文字组，改内容/字号写回 doc
 *   ④ 选中视频片段后出现调色组；亮度拉到 -100，预览最大亮度显著下降
 *   ⑤ 调色是一次撤销步，撤销后画面恢复
 *   ⑥ 选中带音频的片段后出现音量/淡化组，改音量写回 doc
 *
 * 运行：`node tests/verify-c-ui.mjs`
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5180;

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
const page = await launchPage({ url: `http://127.0.0.1:${PORT}/?src=${fixtures.origin}/sample-720p.mp4`, width: 1440, height: 900 });

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
  await page.session.waitFor("window.__VEDITOR_TEST__.clips().length > 0", 15000);

  // 等首帧真的画出来（否则读到的是一片黑，后面所有亮度比较都没有意义）
  await page.session.waitFor("(async () => { const s = await window.__VEDITOR_TEST__.previewSnapshot(); return !!s && s.nonBlack > 1000; })()", 15000);
  const before = JSON.parse(await page.session.evaluate("(async () => JSON.stringify(await window.__VEDITOR_TEST__.previewSnapshot()))()"));

  // ① 加文本
  await page.session.evaluate("document.querySelector('[data-v=\"add-text\"]').click()");
  await new Promise((resolve) => setTimeout(resolve, 600));
  const clips = JSON.parse(await page.session.evaluate("JSON.stringify(window.__VEDITOR_TEST__.clips())"));
  const textClip = clips.find((clip) => clip.text !== null);
  report.check(`① 生成文本片段（${textClip ? textClip.text.content : '无'}）`, textClip !== undefined);
  report.check(`① 文本片段 90 帧（${textClip?.durationFrames}）`, textClip?.durationFrames === 90);
  const textTrack = await page.session.evaluate(
    `(() => { const c = window.__VEDITOR_TEST__.clips().find((x) => x.text); const t = window.__VEDITOR_TEST__.tracks().find((x) => x.id === c.trackId); return t.name; })()`,
  );
  report.check(`① 落在最上层视频轨（${textTrack}）`, textTrack === 'V2');

  // ② 预览出现白字
  const after = JSON.parse(await page.session.evaluate("(async () => JSON.stringify(await window.__VEDITOR_TEST__.previewSnapshot()))()"));
  report.check(
    `② 预览出现白字（最大亮度 ${before.maxLuma.toFixed(1)} → ${after.maxLuma.toFixed(1)}，平均 ${before.meanLuma.toFixed(1)} → ${after.meanLuma.toFixed(1)}）`,
    after.maxLuma > 250 && after.meanLuma > before.meanLuma,
  );

  // ③ 属性栏文字组
  const hasTextPanel = await page.session.evaluate("!!document.querySelector('[data-v=\"inspector-text\"]')");
  report.check('③ 选中文本片段后出现文字属性组', hasTextPanel === true);
  await page.session.evaluate(`(() => {
    const el = document.querySelector('[data-v="inspector-text"]');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(el, '标题来了');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    // React 的 onBlur 走 focusout 委托，直接派发 blur 不触发
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const content = await page.session.evaluate("window.__VEDITOR_TEST__.clips().find((c) => c.text)?.text.content");
  report.check(`③ 改文字内容写回 doc（${content}）`, content === '标题来了');

  // ④ 选回视频片段 → 调色
  await page.session.evaluate("window.__VEDITOR_TEST__.clips().length");
  const videoClipId = await page.session.evaluate("window.__VEDITOR_TEST__.clips().find((c) => c.text === null)?.id");
  // 通过时间线点击选中：直接调 store 会绕过 UI，这里用点击片段块（V1 第 0 帧）
  const rect = JSON.parse(
    await page.session.evaluate("(() => { const r = document.querySelector('[data-v=\"timeline-canvas\"]').getBoundingClientRect(); return JSON.stringify({ x: r.left, y: r.top }); })()"),
  );
  /**
   * 坐标一律从布局取：轨道头 130px、轨道高 60/50/32 之后，
   * 写死 `+120 / 24+56+28` 会点到轨道头或点错行。
   */
  const tlLayout = JSON.parse(
    await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.timelineLayout())'),
  );
  const clipClickX = rect.x + tlLayout.headerWidth + 60;
  const clipClickY = rect.y + tlLayout.rows[1].top + tlLayout.rows[1].height / 2;
  await page.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clipClickX, y: clipClickY, button: 'left', clickCount: 1 });
  await page.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clipClickX, y: clipClickY, button: 'left', clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const hasGrade = await page.session.evaluate("!!document.querySelector('[data-v=\"inspector-brightness\"]')");
  report.check('④ 选中视频片段后出现调色组', hasGrade === true);

  // 把亮度拉到 -100（React range：原生 setter + input + pointerup 才提交）
  await page.session.evaluate(`(() => {
    const el = document.querySelector('[data-v="inspector-brightness"]');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, '-100');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 800));
  const effects = await page.session.evaluate("JSON.stringify(window.__VEDITOR_TEST__.clips().find((c) => c.text === null)?.effects)");
  report.check(`④ 调色写入 clip.effects（${effects}）`, String(effects).includes('colorGrade'));
  const dim = JSON.parse(await page.session.evaluate("(async () => JSON.stringify(await window.__VEDITOR_TEST__.previewSnapshot()))()"));
  report.check(
    `④ 亮度 -100 后画面变暗（平均亮度 ${after.meanLuma.toFixed(1)} → ${dim.meanLuma.toFixed(1)}）`,
    dim.meanLuma < after.meanLuma - 20,
  );

  // ⑤ 撤销恢复
  await page.session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
  await page.session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
  await new Promise((resolve) => setTimeout(resolve, 600));
  const effectsAfterUndo = await page.session.evaluate("JSON.stringify(window.__VEDITOR_TEST__.clips().find((c) => c.text === null)?.effects)");
  const restored = JSON.parse(await page.session.evaluate("(async () => JSON.stringify(await window.__VEDITOR_TEST__.previewSnapshot()))()"));
  report.check(`⑤ 撤销后效果被移除（${effectsAfterUndo}）`, effectsAfterUndo === '[]');
  report.check(
    `⑤ 撤销后画面恢复（平均亮度 ${restored.meanLuma.toFixed(1)} vs 原 ${after.meanLuma.toFixed(1)}）`,
    Math.abs(restored.meanLuma - after.meanLuma) < 2,
  );

  // ⑥ 音量组
  await page.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clipClickX, y: clipClickY, button: 'left', clickCount: 1 });
  await page.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clipClickX, y: clipClickY, button: 'left', clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const hasGain = await page.session.evaluate("!!document.querySelector('[data-v=\"inspector-gain\"]')");
  report.check('⑥ 选中带音频片段后出现音量组', hasGain === true);
  await page.session.evaluate(`(() => {
    const el = document.querySelector('[data-v="inspector-gain"]');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, '0.5');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  /**
   * 滑块是**位置**不是振幅：0.5 位置 = -30dB = 0.0316 倍振幅（见 `core/volume`）。
   * 存进 doc 的仍是线性振幅，所以这里按振幅断言。
   */
  const audioGain = await page.session.evaluate("window.__VEDITOR_TEST__.clips().find((c) => c.text === null)?.audio.gain");
  const expectedGain = 10 ** (-30 / 20);
  report.check(
    `⑥ 音量写回 doc（位置 50% → -30dB → 振幅 ${Number(audioGain).toFixed(4)}）`,
    Math.abs(Number(audioGain) - expectedGain) < 1e-3,
  );

  await page.screenshot({ path: path.join(ROOT, 'tests', 'screenshots', 'c-batch.png') });
  void videoClipId;
} finally {
  await page.close();
  devServer.kill();
  await fixtures.close();
  report.summary('C 批 UI 验收');
}
