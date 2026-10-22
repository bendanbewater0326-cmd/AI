/**
 * 时间线交互回归（**由真实用户操作反馈驱动**）。
 *
 * 2026-10-21 手工体验报了 7 条，其中 4 条是真问题、3 条是误判（程序层面正常）。
 * 这条 E2E 把**每一条**都钉住，包括被判定为"误判"的那些——这样下次有人说"裁剪坏了"，
 * 跑一遍就知道是真坏了还是操作方式不同。
 *
 *   ① 素材缩略图**不可**原生拖拽（否则拖卡片会把缩略图 PNG 当文件导入，报"不支持该格式"）
 *   ② 点标尺 → 播放头精确落到点击帧
 *   ③ 点片段 → 播放头也过来（旧实现只有 24px 标尺条能定位，用户根本找不到）
 *   ④ 片段**未选中**时抓右端也能裁剪（旧实现要求先选中，否则变成整体移动 → "裁剪坏了"）
 *   ⑤ 片段可左右双向移动（不是只能往右）
 *   ⑥ 播到末帧再按播放 → 回到开头重播（旧实现什么都不做）
 *   ⑦ 播完后仍能选中片段（属性栏不 disabled）
 *
 * 运行：node tests/verify-interaction.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5223;
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

/**
 * 画布几何：帧 → 屏幕坐标。
 *
 * 时间线画布的后备缓冲会随容器变化（实测 1401px），**必须换算**而不是假设 1:1；
 * 还要算上左侧 56px 轨道头。写死坐标会让这条 E2E 换个窗口宽度就全错。
 */
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
        // 几何一律从钩子取：轨道头 56→130px、轨道高 60/50/32 之后，硬编码必错
        layout: window.__VEDITOR_TEST__.timelineLayout(),
        scrollX: Number(canvas.dataset.scrollX ?? '0'),
      });
    })()`),
  );
}

/**
 * 重新读一次 scrollX。
 *
 * `xOfFrame()` 依赖开头读到的 scrollX，而**时间线会跟随播放头滚动**
 * （⑩ 点空白处 seek 之后就可能滚）。不刷新的话算出来的 x 会偏出屏幕，
 * 右键落到空白处 → 菜单不弹（实测随机失败，取决于那一次有没有滚动）。
 */
/** 画布几何（`refreshScroll` 会就地更新它的 scrollX）。 */
let geo = { left: 0, top: 0, cssWidth: 1, canvasWidth: 1, zoom: 5, scrollX: 0 };

async function refreshScroll() {
  geo.scrollX = await page.session.evaluate(
    `Number(document.querySelector('[data-v="timeline-canvas"]').dataset.scrollX ?? '0')`,
  );
}

/**
 * 等 scrollX **稳定下来**再读。
 *
 * 只 `refreshScroll()` 一次是不够的：播放头一旦离开可视区，下一帧绘制就会
 * `ensurePlayheadVisible` 把它滚回来 —— 于是"读 scrollX → 算坐标 → 点击"之间
 * 时间线又动了，点击落到偏左的位置（实测：期望第 80 帧，实际落在第 14 帧或第 0 帧）。
 * 这是产品**预期行为**（跟着播放头滚），所以测试要等它停下来。
 */
async function stableScroll(timeoutMs = 2000) {
  const read = () =>
    page.session.evaluate(
      `Number(document.querySelector('[data-v="timeline-canvas"]').dataset.scrollX ?? '0')`,
    );
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (Date.now() < deadline) {
    await sleep(120);
    const next = await read();
    if (next === last) {
      geo.scrollX = next;
      // 顺手重量几何：警告条出现/消失会把时间线整体推上推下，只刷新 scrollX 不够
      geo = { ...(await geometry()), scrollX: next };
      return;
    }
    last = next;
  }
  geo.scrollX = last;
}

const state = async () =>
  JSON.parse(
    await page.session.evaluate(`JSON.stringify({
      playhead: window.__VEDITOR_TEST__.playheadFrame(),
      clips: window.__VEDITOR_TEST__.clips().map((clip) => ({
        id: clip.id,
        trackId: clip.trackId,
        start: clip.startFrame,
        inFrame: clip.inFrame,
        duration: clip.durationFrames,
        role: clip.role,
      })),
      inspectorDisabled: document.querySelector('[data-v="inspector-scale"]')?.disabled ?? null,
      errors: window.__VEDITOR_TEST__.errors().map((item) => item.message),
    })`),
  );

async function mouse(type, x, y) {
  await page.session.send('Input.dispatchMouseEvent', {
    type,
    x: Math.round(x),
    y: Math.round(y),
    button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1,
  });
}

async function click(x, y) {
  await mouse('mousePressed', x, y);
  await mouse('mouseReleased', x, y);
  await sleep(220);
}

async function drag(fromX, fromY, toX, toY, steps = 10) {
  await mouse('mousePressed', fromX, fromY);
  for (let i = 1; i <= steps; i += 1) {
    await mouse('mouseMoved', fromX + ((toX - fromX) * i) / steps, fromY + ((toY - fromY) * i) / steps);
    await sleep(16);
  }
  await mouse('mouseReleased', toX, toY);
  await sleep(320);
}

async function key(code, keyName, keyCode) {
  for (const type of ['keyDown', 'keyUp']) {
    await page.session.send('Input.dispatchKeyEvent', { type, key: keyName, code, windowsVirtualKeyCode: keyCode });
  }
}

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 15000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 25000);
  await sleep(1500);

  geo = await geometry();
  /**
   * `scale` 必须是**函数**而不是常量：画布后备缓冲宽高会随容器变化，
   * 而 `stableScroll()` 会重新量一次几何（内存模式警告条出现/消失会把整个时间线推上推下）。
   * 早期把它算成常量，`geo.top` 一过期，坐标就整体偏一条轨 —— 表现是
   * "右键片段弹出来的是空白菜单"，而且**只在某些轮次复现**。
   */
  const sc = () => geo.cssWidth / geo.canvasWidth;
  const yOfTrack = (index) =>
    geo.top + (geo.layout.rows[index].top + geo.layout.rows[index].height / 2) * sc();
  const xOfFrame = (frame) =>
    geo.left + (geo.layout.headerWidth + frame * geo.zoom - geo.scrollX) * sc();

  // ---- ① 缩略图不可原生拖拽 ----
  const thumb = JSON.parse(
    await page.session.evaluate(`(() => {
      const img = document.querySelector('[data-v="asset-card"] img');
      return JSON.stringify({ exists: img !== null, draggable: img === null ? null : img.draggable });
    })()`),
  );
  report.check(
    `① 素材缩略图禁止原生拖拽（draggable=${thumb.draggable}）`,
    thumb.exists === true && thumb.draggable === false,
  );

  // 第二段素材（V1 已被占用 → 落到 V2），后面用它测移动
  await page.session.evaluate(
    `document.querySelector('[data-v="asset-card"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`,
  );
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length === 2', 10000);
  await sleep(500);

  // ---- ② 点标尺 → 播放头精确到帧 ----
  await page.session.evaluate('window.__VEDITOR_TEST__.selectClip(null)');
  await click(xOfFrame(60), geo.top + 10);
  const afterRuler = await state();
  report.check(
    `② 点标尺第 60 帧 → 播放头 ${afterRuler.playhead}（误差 ≤ 1 帧）`,
    Math.abs(afterRuler.playhead - 60) <= 1,
  );

  // ---- ③ 点片段 → 播放头也过来 ----
  await click(xOfFrame(120), yOfTrack(1));
  const afterClipClick = await state();
  report.check(
    `③ 点片段第 120 帧 → 播放头 ${afterClipClick.playhead}（旧实现停在 60）`,
    Math.abs(afterClipClick.playhead - 120) <= 1,
  );

  // ---- ④ 未选中时抓右端也能裁剪 ----
  // 先取消选中，确保测的是"没选中也能裁"
  await page.session.evaluate('window.__VEDITOR_TEST__.selectClip(null)');
  await sleep(150);
  const beforeTrim = (await state()).clips.find((clip) => clip.id === afterClipClick.clips[0].id) ?? (await state()).clips[0];
  const target = (await state()).clips.find((clip) => clip.start === 0 && clip.duration === 240);
  await drag(xOfFrame(target.start + target.duration) - 3, yOfTrack(1), xOfFrame(target.start + target.duration - 30), yOfTrack(1));
  const afterTrim = (await state()).clips.find((clip) => clip.id === target.id);
  report.check(
    `④ 未选中时拖右端 → 时长 ${target.duration} → ${afterTrim?.duration}，起点不变（${beforeTrim.start} → ${afterTrim?.start}）`,
    afterTrim !== undefined && afterTrim.duration < target.duration && afterTrim.start === target.start,
  );

  // ---- ⑤ 左右双向移动 ----
  const movable = (await state()).clips.find((clip) => clip.start === 0 && clip.id !== target.id);
  await drag(xOfFrame(60), yOfTrack(0), xOfFrame(120), yOfTrack(0));
  const movedRight = (await state()).clips.find((clip) => clip.id === movable.id)?.start;
  await drag(xOfFrame(120), yOfTrack(0), xOfFrame(60), yOfTrack(0));
  const movedBack = (await state()).clips.find((clip) => clip.id === movable.id)?.start;
  report.check(
    `⑤ 右移 60 → ${movedRight}，再左移 60 → ${movedBack}（双向都动）`,
    movedRight === 60 && movedBack === 0,
  );

  // ---- ⑥ 末帧按播放 → 回到开头 ----
  // **直接把播放头放到末帧**再按播放：不要"播 3 秒等它自然到结尾"——
  // 那依赖实时播放速度，机器一忙就还没播完（实测偶发：播到 200 就断言，结论全错）。
  // `maxFrame()` 是**duration 本身**（播放头可以停在 240 = 最后一帧之后），
  // 所以"在末帧按播放"要用 duration，而不是 duration-1（239 还能再播一帧，不该回绕）。
  const duration = await page.session.evaluate('window.__VEDITOR_TEST__.derived().durationFrames');
  const lastFrame = Math.max(1, duration);
  await click(xOfFrame(lastFrame), geo.top + 10);
  await sleep(300);
  const atEnd = await state();
  await key('Space', ' ', 32);
  await sleep(700);
  const afterReplay = await state();
  report.check(
    `⑥ 末帧（${lastFrame}）按播放 → ${afterReplay.playhead}（应回到开头附近）`,
    atEnd.playhead === lastFrame && afterReplay.playhead < Math.max(10, lastFrame - 100),
  );
  // 停下来，别影响后面的用例
  await key('Space', ' ', 32);
  await sleep(300);

  // ---- ⑦ 播完后仍能选中片段 ----
  await page.session.evaluate('window.__VEDITOR_TEST__.selectClip(null)');
  await sleep(200);
  const beforeSelect = await state();
  const beforeSelection = await page.session.evaluate('window.__VEDITOR_TEST__.selection()');
  await click(xOfFrame(30), yOfTrack(1));
  await sleep(200);
  const afterSelect = await state();
  const afterSelection = await page.session.evaluate('window.__VEDITOR_TEST__.selection()');
  report.check(
    `⑦ 播完后点片段能选中（selection：${beforeSelection} → ${afterSelection}；属性栏 disabled：${beforeSelect.inspectorDisabled} → ${afterSelect.inspectorDisabled}）`,
    beforeSelection === null && afterSelection !== null && afterSelect.inspectorDisabled === false,
  );

  // ---- ⑬ 播放头停在末尾时，时间线仍然可点（旧实现会滚到"右侧全是空白"，点哪都没反应）----
  const total = await page.session.evaluate('window.__VEDITOR_TEST__.derived().durationFrames');
  await page.session.evaluate(`window.__VEDITOR_TEST__.seek(${total})`);
  await sleep(600);
  const probe = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.domProbe())'));
  report.check(
    `⑬ 末尾时视口中心仍在内容内（中心帧 ${probe.frameAtCenter} < 总帧 ${total}，scrollX ${probe.scrollX}）`,
    typeof probe.frameAtCenter === 'number' && probe.frameAtCenter < total,
  );
  // 真的点一下中心：播放头应该回到那个帧（不是"一动不动"）
  await click(probe.point.x, probe.point.y);
  const afterEndClick = await state();
  report.check(
    `⑬ 末尾时点画布中心 → 播放头 ${afterEndClick.playhead}（应离开 ${total}）`,
    afterEndClick.playhead < total,
  );

  report.check(`⑧ 全程无错误条（${JSON.stringify(afterSelect.errors)}）`, afterSelect.errors.length === 0);

  // ---- ⑨ 应用内自检（给人用的那个面板，必须在客户端里就能跑通）----
  await page.session.evaluate(`document.querySelector('[data-v="self-check"]').click()`);
  await page.session.waitFor(`!!document.querySelector('[data-v="self-check-panel"]')`, 5000);
  await page.session.waitFor(
    `document.querySelectorAll('[data-v="self-check-panel"] li').length >= 5`,
    20000,
  );
  const selfCheck = JSON.parse(
    await page.session.evaluate(`JSON.stringify({
      summary: document.querySelector('[data-v="self-check-panel"] strong')?.textContent ?? '',
      bad: Array.from(document.querySelectorAll('.v-selfcheck__bad')).map((el) => el.textContent),
    })`),
  );
  report.check(
    `⑨ 应用内自检全部通过（"${selfCheck.summary}"${selfCheck.bad.length > 0 ? ` 失败：${JSON.stringify(selfCheck.bad)}` : ''}）`,
    /全部通过/.test(selfCheck.summary) && selfCheck.bad.length === 0,
  );
  await page.session.evaluate(`document.querySelector('[data-v="self-check-close"]').click()`);
  await sleep(300);

  // ---- ⑩ 点时间线空白处 → 播放头也过来（旧实现只取消选中）----
  /**
   * **必须先 `refreshScroll()`**：⑥ 播放到片尾时时间线会跟着播放头滚动，
   * 而 `xOfFrame()` 用的是开头读到的 `scrollX`。不刷新就会算到偏左的位置，
   * 点击落到别的帧上（实测：期望第 80 帧，实际落在第 14 帧，看起来像"点不动"）。
   * 这是**测试自己的坐标过期**，不是产品 bug——产品"跟着播放头滚动"是预期行为。
   */
  await stableScroll();
  await page.session.evaluate('window.__VEDITOR_TEST__.selectClip(null)');
  await click(xOfFrame(80), yOfTrack(2)); // A1 轨是空的
  const afterEmptyClick = await state();
  report.check(
    `⑩ 点空白轨第 80 帧 → 播放头 ${afterEmptyClick.playhead}`,
    Math.abs(afterEmptyClick.playhead - 80) <= 1,
  );

  // ---- ⑪ 右键片段 → 菜单里删除（真实鼠标；分离音频见 detach-audio 单测）----
  const beforeMenu = (await state()).clips.length;
  const clipForMenu = (await state()).clips.find((clip) => clip.trackId === 'trk_V1') ?? (await state()).clips[0];
  await stableScroll();
  {
    // 用**合成 contextmenu 事件**（和 ⑫ 素材卡同一套写法）：
    // CDP 的右键在"时间线刚滚动过"时会落空（几何算出来偏），合成事件只依赖 clientX/Y，
    // 仍然走真实的 `onContextMenu` 处理器与 hitTest。
    const rx = Math.round(xOfFrame(clipForMenu.start + Math.min(10, clipForMenu.duration - 1)));
    const ry = Math.round(yOfTrack(1));
    await page.session.evaluate(`(() => {
      const canvas = document.querySelector('[data-v="timeline-canvas"]');
      canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${rx}, clientY: ${ry} }));
      return true;
    })()`);
    await sleep(350);
  }
  const menuText = await page.session.evaluate(
    `document.querySelector('[data-v="context-menu"]')?.textContent ?? ''`,
  );
  // 诊断信息一起打出来：菜单空的时候，光看空字符串分不清"没弹"还是"弹的是空白菜单"
  const menuDiag = JSON.parse(
    await page.session.evaluate(`JSON.stringify({
      selection: window.__VEDITOR_TEST__.selection(),
      scrollX: Number(document.querySelector('[data-v="timeline-canvas"]').dataset.scrollX ?? '0'),
      clip: ${JSON.stringify({ id: clipForMenu.id, start: clipForMenu.start, duration: clipForMenu.duration, trackId: clipForMenu.trackId })},
    })`),
  );
  if (!/删除片段/.test(String(menuText))) {
    console.log(`      [诊断] 右键落点 frame=${clipForMenu.start + 10} 轨道=${clipForMenu.trackId} scrollX=${menuDiag.scrollX} 选中=${menuDiag.selection} 菜单="${String(menuText).trim()}"`);
  }
  report.check(
    `⑪ 右键片段弹出菜单（"${String(menuText).trim()}"）`,
    /删除片段/.test(String(menuText)) && /分离音频/.test(String(menuText)),
  );
  const menuRect = JSON.parse(
    await page.session.evaluate(`(() => {
      const menu = document.querySelector('[data-v="context-menu"]');
      if (menu === null) return JSON.stringify({ x: -1, y: -1 });
      const button = Array.from(menu.querySelectorAll('button')).find((item) => item.textContent.includes('删除片段'));
      if (button === undefined) return JSON.stringify({ x: -1, y: -1 });
      const rect = button.getBoundingClientRect();
      return JSON.stringify({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    })()`),
  );
  await click(menuRect.x, menuRect.y);
  await sleep(500);
  const afterClipDelete = (await state()).clips.length;
  report.check(`⑪ 菜单删除片段（${beforeMenu} → ${afterClipDelete} 段）`, afterClipDelete === beforeMenu - 1);
  await key('KeyZ', 'z', 90);
  await page.session.evaluate('document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }))');
  await sleep(400);
  report.check(
    `⑪ 撤销恢复片段（${afterClipDelete} → ${(await state()).clips.length} 段）`,
    (await state()).clips.length === beforeMenu,
  );

  // ---- ⑫ 右键素材卡 → 删除素材（连同片段）----
  await page.session.evaluate(`(() => {
    const card = document.querySelector('[data-v="asset-card"]');
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 200 }));
    return true;
  })()`);
  await sleep(400);
  const assetMenuText = await page.session.evaluate(
    `document.querySelector('[data-v="context-menu"]')?.textContent ?? ''`,
  );
  report.check(
    `⑫ 右键素材卡弹出菜单（"${String(assetMenuText).trim()}"）`,
    /删除素材/.test(String(assetMenuText)) && /添加到时间线/.test(String(assetMenuText)),
  );
  const assetMenuRect = JSON.parse(
    await page.session.evaluate(`(() => {
      const buttons = Array.from(document.querySelectorAll('[data-v="context-menu"] button'));
      const target = buttons.find((button) => button.textContent.includes('删除素材'));
      if (target === undefined) return JSON.stringify({ x: -1, y: -1 });
      const rect = target.getBoundingClientRect();
      return JSON.stringify({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    })()`),
  );
  await click(assetMenuRect.x, assetMenuRect.y);
  await sleep(500);
  const afterAssetDelete = JSON.parse(
    await page.session.evaluate(`JSON.stringify({
      assets: window.__VEDITOR_TEST__.assets().length,
      clips: window.__VEDITOR_TEST__.clips().length,
    })`),
  );
  report.check(
    `⑫ 删除素材连同片段（素材 ${afterAssetDelete.assets} / 片段 ${afterAssetDelete.clips}）`,
    afterAssetDelete.assets === 0 && afterAssetDelete.clips === 0,
  );

  report.summary('时间线交互');
} finally {
  await page.close();
  dev.kill();
  await fixture.close();
}
