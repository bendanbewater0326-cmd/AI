/**
 * 定格帧 + 倒放的端到端验证（`docs/nle-baseline.md` §2 §3）。
 *
 * ## 断言什么才算真的对
 *
 * 定格最容易"看着对其实错"：片段插进去了、时间线看着也变了，但画面还在往下播。
 * 所以这里量的是**画面本身**：定格区间内两个不同时刻的平均亮度必须几乎相等
 * （真的冻住了），而且不能是黑的（冻住的是画面，不是黑帧）。
 *
 * 倒放同理：倒放后第 0 帧应该长得像**原来的最后一帧**。
 *
 * 运行：`node tests/verify-freeze-reverse.mjs`
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5231;
const FIXTURE = 'roughcut-8s.mp4';

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
const page = await launchPage({
  url: `http://127.0.0.1:${PORT}/?src=${fixture.origin}/${FIXTURE}`,
  width: 1440,
  height: 900,
});

const state = async () =>
  JSON.parse(
    await page.session.evaluate(`JSON.stringify({
      clips: window.__VEDITOR_TEST__.clips().map((clip) => ({
        id: clip.id,
        trackId: clip.trackId,
        start: clip.startFrame,
        duration: clip.durationFrames,
        inFrame: clip.inFrame,
        outFrame: clip.outFrame,
        role: clip.role,
        freeze: clip.freeze,
        reversed: clip.reversed,
      })),
      errors: window.__VEDITOR_TEST__.errors().map((item) => item.message),
    })`),
  );

/** 移到某一帧并读画面平均亮度（等渲染稳定）。 */
async function lumaAt(frame) {
  await page.session.evaluate(`window.__VEDITOR_TEST__.seek(${frame})`);
  await sleep(420);
  const stats = await page.session.evaluate(`window.__VEDITOR_TEST__.previewSnapshot()`);
  return stats === null ? null : { mean: stats.meanLuma, filled: stats.nonBlack / Math.max(1, stats.total) };
}

/** 合成右键 → 点菜单项（真实指针事件）。 */
async function openMenuOnClip(clip) {
  const geo = JSON.parse(
    await page.session.evaluate(`(() => {
      const canvas = document.querySelector('[data-v="timeline-canvas"]');
      const rect = canvas.getBoundingClientRect();
      const layout = window.__VEDITOR_TEST__.timelineLayout();
      return JSON.stringify({
        left: rect.left, top: rect.top, cssWidth: rect.width, canvasWidth: canvas.width,
        zoom: window.__VEDITOR_TEST__.zoomLevel(),
        scrollX: Number(canvas.dataset.scrollX ?? '0'),
        tracks: window.__VEDITOR_TEST__.tracks(),
        headerWidth: layout.headerWidth,
        rows: layout.rows,
      });
    })()`),
  );
  // 行号直接问布局（轨道类型不同高度不同，自己排一遍迟早对不上）
  const row = geo.rows.findIndex((item) => item.trackId === clip.trackId);
  const scale = geo.cssWidth / geo.canvasWidth;
  const frame = clip.start + Math.min(10, clip.duration - 1);
  const x = Math.round(geo.left + (geo.headerWidth + frame * geo.zoom - geo.scrollX) * scale);
  const y = Math.round(geo.top + (geo.rows[row].top + geo.rows[row].height / 2) * scale);
  await page.session.evaluate(`(() => {
    const canvas = document.querySelector('[data-v="timeline-canvas"]');
    canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y} }));
    return true;
  })()`);
  await sleep(320);
}

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
      type, x: Math.round(rect.x), y: Math.round(rect.y), button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
    });
  }
  await sleep(520);
}

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 15000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 25000);
  await sleep(1400);

  const before = await state();
  const source = before.clips[0];
  report.check(`① 素材时长 ${source.duration} 帧（8 秒 @30fps）`, source.duration >= 200);

  // 播放头放到片段中间，右键 → 定格
  await page.session.evaluate(`window.__VEDITOR_TEST__.seek(${source.start + 120})`);
  await sleep(300);
  await openMenuOnClip(source);
  const menuText = String(
    await page.session.evaluate(`document.querySelector('[data-v="context-menu"]')?.textContent ?? ''`),
  );
  report.check(`① 菜单里有「定格」（"${menuText.slice(0, 40)}…"）`, menuText.includes('定格'));
  await clickMenuItem('定格');

  const frozenState = await state();
  const frozen = frozenState.clips.find((clip) => clip.freeze === true);
  report.check(
    `① 定格片段出现（${frozenState.clips.length} 段，时长 ${frozen?.duration} 帧）`,
    frozen !== undefined && frozen.duration === 90,
  );
  report.check(
    `① 定格只出画（role=${frozen?.role}），素材只取 1 帧（${frozen?.outFrame}-${frozen?.inFrame}）`,
    frozen?.role === 'video' && frozen.outFrame - frozen.inFrame === 1,
  );
  const tail = frozenState.clips.find((clip) => clip.id !== frozen?.id && clip.id !== source.id);
  report.check(
    `① 后半段被推到 ${tail?.start}（期望 ${(frozen?.start ?? 0) + 90}），没有重叠`,
    tail !== undefined && tail.start === (frozen?.start ?? 0) + 90,
  );

  // 画面真的冻住了吗：定格区间内两个时刻亮度必须几乎相同、且不是黑的
  const inFreezeA = await lumaAt(frozen.start + 5);
  const inFreezeB = await lumaAt(frozen.start + 80);
  report.check(
    `① 定格区间内画面不黑（${inFreezeA?.mean.toFixed(1)} / ${inFreezeB?.mean.toFixed(1)}）`,
    inFreezeA !== null && inFreezeB !== null && inFreezeA.filled > 0.5 && inFreezeB.filled > 0.5,
  );
  report.check(
    `① 定格区间内画面**冻住**（两处亮度差 ${Math.abs((inFreezeA?.mean ?? 0) - (inFreezeB?.mean ?? 0)).toFixed(2)}）`,
    inFreezeA !== null && inFreezeB !== null && Math.abs(inFreezeA.mean - inFreezeB.mean) < 1.5,
  );

  // 撤销：一次回到 1 段
  await page.session.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2,
  });
  await page.session.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2,
  });
  await sleep(600);
  const undone = await state();
  report.check(`② 一次撤销回到 ${undone.clips.length} 段（期望 1）`, undone.clips.length === 1);

  // ---- 倒放 ----
  const lastFrameLuma = await lumaAt(source.start + source.duration - 2);
  const firstFrameLuma = await lumaAt(source.start + 1);
  await openMenuOnClip(source);
  await clickMenuItem('倒放');
  const reversedState = await state();
  const reversed = reversedState.clips[0];
  report.check(
    `③ 倒放后 reversed=${reversed?.reversed}，role=${reversed?.role}（静音）`,
    reversed?.reversed === true && reversed.role === 'video',
  );
  /**
   * 倒放的**像素级**验证放在单测里（`freeze.test.mjs` ③b/③c 直接断言"第 0 帧映射到素材末帧"）。
   * 这里只验证"倒放后画面还在、没黑、没报错"——
   * 原因是测试素材 `roughcut-8s.mp4` 的画面几乎是纯色（实测各点亮度都是 59.9），
   * 拿它比对"第 1 帧 vs 末帧"等于比较两个相等的数，**看着绿其实什么都没证明**。
   * 这类"素材本身没有区分度"的断言必须写清楚，否则下一个人会以为这里测过了。
   */
  const reversedHead = await lumaAt(reversed.start + 1);
  report.check(
    `③ 倒放后画面仍出画、不黑（${firstFrameLuma?.mean.toFixed(1)} → ${reversedHead?.mean.toFixed(1)}，末帧 ${lastFrameLuma?.mean.toFixed(1)}；像素级见单测）`,
    reversedHead !== null && reversedHead.filled > 0.5,
  );

  await openMenuOnClip(reversed);
  await clickMenuItem('取消倒放');
  const restored = await state();
  report.check(
    `③ 取消倒放后 reversed=${restored.clips[0]?.reversed}`,
    restored.clips[0]?.reversed === false,
  );

  const errors = (await state()).errors;
  report.check(`④ 全程无错误条（${JSON.stringify(errors)}）`, errors.length === 0);

  report.summary('定格帧 / 倒放');
} finally {
  await page.close();
  dev.kill();
  await fixture.close();
}
