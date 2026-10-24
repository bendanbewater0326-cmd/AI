/**
 * 预设端到端验证（R-053）。
 *
 * ## 这条链路要证明的三件事
 *
 * 1. **抓的是"样式"不是"片段"**：套用后目标片段的帧号/素材不变，只有样式变了；
 * 2. **一次撤销步**：套用后按一次 Ctrl+Z 就回到套用前，而不是逐字段撤销；
 * 3. **预设跨片段、可持久化**：存在 settings 里，不是挂在某个片段上。
 *
 * 场景：把一段素材切成两段 → 给第一段调不透明度/亮度/音量 → 存成预设 → 套到第二段。
 *
 * 运行：node tests/verify-preset.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5214;
const FIXTURE = 'sample-720p.mp4';

function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
    const found = [
      path.join(ROOT, 'tests', 'fixtures', 'compat', name),
      path.join(ROOT, 'tests', 'fixtures', name),
      path.join(ROOT, 'tests', 'fixtures', 'hardline', name),
    ].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!found) {
      response.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
      response.end('not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(found).pipe(response);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
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
const page = await launchPage({
  url: `http://127.0.0.1:${PORT}/?src=${fixture.origin}/${FIXTURE}`,
  width: 1440,
  height: 900,
});

async function key(keyName, code, keyCode, modifiers = 0) {
  for (const type of ['keyDown', 'keyUp']) {
    await page.session.send('Input.dispatchKeyEvent', {
      type,
      key: keyName,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    });
  }
}

/** 拖动一个 range 控件：先 input（改 React 状态），再 pointerup（触发提交）。 */
async function setRange(selector, value) {
  await page.session.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(120);
  await page.session.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  })()`);
  await sleep(120);
}

async function seekTo(frame) {
  const seconds = Math.floor(frame / 30);
  const timecode = `00:00:${String(seconds).padStart(2, '0')}:${String(frame % 30).padStart(2, '0')}`;
  await page.session.evaluate(`document.querySelector('[data-v="timecode"]').click()`);
  await page.session.waitFor(`!!document.querySelector('[data-v="timecode-input"]')`, 3000);
  await page.session.evaluate(`(() => {
    const input = document.querySelector('[data-v="timecode-input"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(timecode)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(300);
}

async function clipState(index) {
  return JSON.parse(
    await page.session.evaluate(`(() => {
      const clip = window.__VEDITOR_TEST__.clips()[${index}];
      return JSON.stringify({
        id: clip.id,
        startFrame: clip.startFrame,
        durationFrames: clip.durationFrames,
        opacity: clip.transform.opacity,
        scale: clip.transform.scale,
        effects: clip.effects,
        gain: clip.audio.gain,
      });
    })()`),
  );
}

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 15000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 25000);

  // ---- ① 切成两段，得到"同素材的两个片段" ----
  await seekTo(60);
  const firstId = await page.session.evaluate('window.__VEDITOR_TEST__.clips()[0].id');
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(firstId)})`);
  await sleep(200);
  await key('b', 'KeyB', 66, 2);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length === 2', 5000);
  report.check('① 片段已切成两段', (await page.session.evaluate('window.__VEDITOR_TEST__.clips().length')) === 2);

  // ---- ② 给第一段调样式：不透明度 50% / 亮度 -100 / 音量 50% ----
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(firstId)})`);
  await sleep(300);
  // 不透明度的 range 是 0–1（不是 0–100）：写 50 会被浏览器夹成 1
  await setRange('[data-v="inspector-opacity"]', 0.5);
  await setRange('[data-v="inspector-brightness"]', -100);
  await setRange('[data-v="inspector-gain"]', 0.5);
  const styled = await clipState(0);
  // 音量滑块是位置（0.5 → -30dB → 0.0316 倍振幅），见 core/volume
  const expectedGain = 10 ** (-30 / 20);
  report.check(
    `② 第一段样式已生效（opacity ${styled.opacity} / 效果 ${styled.effects.join(',')} / gain ${Number(styled.gain).toFixed(4)}）`,
    Math.abs(styled.opacity - 0.5) < 1e-6 &&
      styled.effects.includes('colorGrade') &&
      Math.abs(styled.gain - expectedGain) < 1e-3,
  );

  // ---- ③ 存为预设 ----
  await page.session.evaluate(`(() => {
    const input = document.querySelector('[data-v="preset-name"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '冷色调 50%');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(150);
  await page.session.evaluate(`document.querySelector('[data-v="preset-save"]').click()`);
  await page.session.waitFor(`document.querySelectorAll('[data-v="preset-apply"]').length === 1`, 5000);
  const presetLabel = await page.session.evaluate(
    `document.querySelector('[data-v="preset-apply"]').textContent`,
  );
  report.check(`③ 预设已保存并出现在列表（"${presetLabel}"）`, presetLabel === '冷色调 50%');

  // ---- ④ 套到第二段 ----
  const secondId = await page.session.evaluate('window.__VEDITOR_TEST__.clips()[1].id');
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(secondId)})`);
  await sleep(300);
  const beforeApply = await clipState(1);
  report.check(
    `④ 第二段套用前是默认样式（opacity ${beforeApply.opacity} / 效果 ${beforeApply.effects.length} / gain ${beforeApply.gain}）`,
    beforeApply.opacity === 1 && beforeApply.effects.length === 0 && beforeApply.gain === 1,
  );

  await page.session.evaluate(`document.querySelector('[data-v="preset-apply"]').click()`);
  await sleep(500);
  const applied = await clipState(1);
  // 预设里存的 gain 是线性振幅（滑块位置 0.5 = -30dB = 0.0316 倍），见 core/volume
  report.check(
    `④ 套用后样式一致（opacity ${applied.opacity} / 效果 ${applied.effects.join(',')} / gain ${Number(applied.gain).toFixed(4)}）`,
    Math.abs(applied.opacity - 0.5) < 1e-6 &&
      applied.effects.includes('colorGrade') &&
      Math.abs(applied.gain - expectedGain) < 1e-3,
  );
  report.check(
    `④ 只改样式、不改时间（${beforeApply.startFrame}+${beforeApply.durationFrames} → ${applied.startFrame}+${applied.durationFrames}）`,
    applied.startFrame === beforeApply.startFrame && applied.durationFrames === beforeApply.durationFrames,
  );

  // ---- ⑤ 一次 Ctrl+Z 回到套用前 ----
  await key('z', 'KeyZ', 90, 2);
  await sleep(500);
  const undone = await clipState(1);
  report.check(
    `⑤ 一次撤销回到默认（opacity ${undone.opacity} / 效果 ${undone.effects.length} / gain ${undone.gain}）`,
    undone.opacity === 1 && undone.effects.length === 0 && undone.gain === 1,
  );

  // ---- ⑥ 删除预设 ----
  await page.session.evaluate(`document.querySelector('[data-v="preset-delete"]').click()`);
  await page.session.waitFor(`document.querySelectorAll('[data-v="preset-apply"]').length === 0`, 5000);
  const empty = await page.session.evaluate(
    `document.querySelector('[data-v="preset-empty"]')?.textContent ?? ''`,
  );
  report.check(`⑥ 预设已删除（空态："${empty}"）`, empty.includes('暂无自定义预设'));

  await page.screenshot({ path: path.join(ROOT, 'tests', 'screenshots', 'preset.png') });
  const errors = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.errors())'));
  report.check(`⑦ 全程无页面错误（${JSON.stringify(errors)}）`, Array.isArray(errors) && errors.length === 0);

  report.summary('预设（R-053）');
} finally {
  await page.close();
  dev.kill();
  await fixture.close();
}
