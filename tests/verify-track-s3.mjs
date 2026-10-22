/**
 * S3 回归测试：轨道高度拖拽 / 复制轨道 / 上移下移 / 拖拽排序。
 *
 * ## 为什么每条都要"读文档 + 读界面"
 *
 * 这一批操作的失败方式是"界面动了、文档没动"或反过来：
 * - 高度拖拽只改 DOM 的 `style.height` → 画面跟着变，但存盘后没了；
 * - 排序只画了指示线 → 松手没提交，看着"拖过"其实顺序没变；
 * - 复制轨道漏字段 → 片段数对、但效果丢了。
 *
 * 所以断言一律是 `tracks()`（文档）+ `timelineLayout()`（界面几何）双读。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5242;
const FIXTURE = 'sample-720p.mp4';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = http.createServer((request, response) => {
  const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
  const candidates = [
    path.join(ROOT, 'tests', 'fixtures', 'compat', name),
    path.join(ROOT, 'tests', 'fixtures', 'hardline', name),
  ];
  const found = candidates.find((item) => fs.existsSync(item)) ?? candidates[0];
  if (!fs.existsSync(found)) {
    response.writeHead(404);
    response.end('not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
  fs.createReadStream(found).pipe(response);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const dev = spawn(process.execPath, ['scripts/dev.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('dev server 启动超时')), 20000);
  dev.stdout.on('data', (chunk) => {
    if (String(chunk).includes(`127.0.0.1:${PORT}`)) {
      clearTimeout(timer);
      resolve();
    }
  });
});

const page = await launchPage({
  url: `http://127.0.0.1:${PORT}/?src=${origin}/${FIXTURE}`,
  width: 1440, height: 900,
});
const report = createReport();

/** 当前文档里的轨道（按显示顺序：上 → 下）。 */
const tracksInOrder = async () => {
  const layoutInfo = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.timelineLayout())'));
  const all = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.tracks())'));
  const byId = new Map(all.map((track) => [track.id, track]));
  return layoutInfo.rows.map((row) => ({ ...byId.get(row.trackId), top: row.top, rowHeight: row.height }));
};
const namesInOrder = async () => (await tracksInOrder()).map((track) => track.name);
const trackById = async (id) =>
  JSON.parse(await page.session.evaluate(`JSON.stringify(window.__VEDITOR_TEST__.tracks().find((t) => t.id === ${JSON.stringify(id)}))`));
const rectOf = async (selector) =>
  JSON.parse(
    await page.session.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return JSON.stringify(null);
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
    })()`),
  );

/** 用 ⋮ 菜单点某一项（按文案前缀匹配）。 */
async function clickTrackMenuItem(trackId, labelPrefix) {
  await page.session.evaluate(`document.querySelector('[data-v="track-more-${trackId}"]').click()`);
  await sleep(260);
  const clicked = await page.session.evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('[data-v="context-menu"] button'));
    const target = items.find((button) => button.textContent.startsWith(${JSON.stringify(labelPrefix)}));
    if (!target) return 'missing';
    if (target.disabled) return 'disabled';
    target.click();
    return 'ok';
  })()`);
  await sleep(450);
  return clicked;
}

/** 读 ⋮ 菜单里某一项的状态（文案 + 是否置灰），读完关掉菜单。 */
async function readTrackMenuItem(trackId, labelPrefix) {
  await page.session.evaluate(`document.querySelector('[data-v="track-more-${trackId}"]').click()`);
  await sleep(260);
  const info = JSON.parse(
    await page.session.evaluate(`(() => {
      const items = Array.from(document.querySelectorAll('[data-v="context-menu"] button'));
      const target = items.find((button) => button.textContent.startsWith(${JSON.stringify(labelPrefix)}));
      if (!target) return JSON.stringify({ found: false });
      return JSON.stringify({ found: true, disabled: target.disabled, text: target.textContent });
    })()`),
  );
  await page.session.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(200);
  return info;
}

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 20000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 30000);
  await sleep(2000);

  const before = await tracksInOrder();
  report.check(
    `① 初始顺序 ${JSON.stringify(before.map((t) => t.name))}`,
    before.length >= 3 && before[0].name === 'V2',
  );

  // ---- ② 拖轨道头下边缘 → 高度变大 ----
  const resizeRect = await rectOf('[data-v="track-resize-trk_V1"]');
  /**
   * 初始轨道**没有** `height` 字段（用类型默认值 60），所以这里取布局里的实际行高，
   * 否则断言会拿 `null` 去比数字（"撤销回 60 === null"永远失败）。
   */
  const layoutBefore = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.timelineLayout())'));
  const heightBefore = layoutBefore.rows.find((row) => row.trackId === 'trk_V1').height;
  await page.session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: resizeRect.cx, y: resizeRect.cy, button: 'left', clickCount: 1,
  });
  for (let step = 1; step <= 4; step += 1) {
    await page.session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: resizeRect.cx, y: resizeRect.cy + step * 10, button: 'left',
    });
    await sleep(40);
  }
  await page.session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: resizeRect.cx, y: resizeRect.cy + 40, button: 'left', clickCount: 1,
  });
  await sleep(500);
  const heightAfter = (await trackById('trk_V1')).height;
  const layoutAfter = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.timelineLayout())'));
  report.check(
    `② 拖下边缘 → 高度 ${heightBefore} → ${heightAfter}，画布总高 ${layoutBefore.totalHeight} → ${layoutAfter.totalHeight}`,
    heightAfter >= 90 && layoutAfter.totalHeight > layoutBefore.totalHeight,
  );

  // ---- ③ 撤销一步回到原高度 ----
  await page.session.evaluate('window.__VEDITOR_TEST__.undo()');
  await sleep(400);
  const heightUndone = (await trackById('trk_V1')).height;
  report.check(
    `③ 撤销一步回到原高度（${heightUndone}）`,
    heightUndone === heightBefore,
  );

  // ---- ④ 高度上限被夹住（拖 400px）----
  const resizeRect2 = await rectOf('[data-v="track-resize-trk_V1"]');
  await page.session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: resizeRect2.cx, y: resizeRect2.cy, button: 'left', clickCount: 1,
  });
  await page.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: resizeRect2.cx, y: resizeRect2.cy + 400, button: 'left',
  });
  await sleep(120);
  await page.session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: resizeRect2.cx, y: resizeRect2.cy + 400, button: 'left', clickCount: 1,
  });
  await sleep(500);
  const heightClamped = (await trackById('trk_V1')).height;
  report.check(`④ 高度被夹到 120 以内（${heightClamped}）`, heightClamped <= 120);
  await page.session.evaluate('window.__VEDITOR_TEST__.undo()');
  await sleep(400);

  // ---- ⑤ ⋮ → 复制轨道 ----
  const beforeCopy = await tracksInOrder();
  const clipsBefore = (await trackById('trk_V1')).clips;
  const dupResult = await clickTrackMenuItem('trk_V1', '复制轨道');
  const afterCopy = await tracksInOrder();
  const copyTrack = afterCopy.find((track) => track.name.includes('副本'));
  report.check(
    `⑤ 复制轨道：${beforeCopy.length} → ${afterCopy.length} 条，新轨「${copyTrack?.name ?? '缺失'}」`,
    dupResult === 'ok' && afterCopy.length === beforeCopy.length + 1 && copyTrack !== undefined,
  );
  report.check(
    `⑤b 片段一起复制（${clipsBefore} → ${copyTrack?.clips}），且插在原轨上方`,
    copyTrack?.clips === clipsBefore &&
      afterCopy.findIndex((track) => track.id === copyTrack?.id) ===
        afterCopy.findIndex((track) => track.id === 'trk_V1') - 1,
  );

  // ---- ⑥ 撤销复制（一步全回去）----
  await page.session.evaluate('window.__VEDITOR_TEST__.undo()');
  await sleep(450);
  const afterUndoCopy = await tracksInOrder();
  report.check(
    `⑥ 撤销一步把整条复制轨回退（${afterUndoCopy.length} 条）`,
    afterUndoCopy.length === beforeCopy.length,
  );

  // ---- ⑦ ⋮ → 上移 / 下移 ----
  const shiftUp = await clickTrackMenuItem('trk_V1', '上移');
  const afterUp = await namesInOrder();
  report.check(
    `⑦ 上移 V1：${JSON.stringify(beforeCopy.map((t) => t.name))} → ${JSON.stringify(afterUp)}`,
    shiftUp === 'ok' && afterUp[0] === 'V1' && afterUp[1] === 'V2',
  );
  const shiftDown = await clickTrackMenuItem('trk_V1', '下移');
  const afterDown = await namesInOrder();
  report.check(
    `⑦b 再下移回来：${JSON.stringify(afterDown)}`,
    shiftDown === 'ok' && afterDown[0] === 'V2' && afterDown[1] === 'V1',
  );

  // ---- ⑧ 边界：最上面的轨「上移」置灰且带原因 ----
  const topMost = (await tracksInOrder())[0];
  const upItem = await readTrackMenuItem(topMost.id, '上移');
  report.check(
    `⑧ 最上面的 ${topMost.name} 的「上移」置灰并说明原因（"${upItem.text ?? ''}"）`,
    upItem.found === true && upItem.disabled === true && /最上面/.test(String(upItem.text)),
  );

  // ---- ⑨ 拖轨道头排序（带指示线）----
  const orderBeforeDrag = await namesInOrder();
  const nameRect = await rectOf('[data-v="track-name-trk_V1"]');
  const rowsNow = await tracksInOrder();
  const v2Row = rowsNow.find((track) => track.id === 'trk_V2');
  const canvasRect = await rectOf('[data-v="timeline-canvas"]');
  /**
   * `trackLayout` 的 `top` 已经是**画布 CSS 像素**（从画布顶算起），
   * 所以屏幕 y = 画布 top + 行 top，**不要**再乘 DPR 比例
   * （乘了会落到标尺区，算出来的 targetIndex 永远是最上面那行）。
   */
  const targetY = canvasRect.y + v2Row.top + 2;
  await page.session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: nameRect.cx, y: nameRect.cy, button: 'left', clickCount: 1,
  });
  await sleep(60);
  await page.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: nameRect.cx, y: targetY, button: 'left',
  });
  await sleep(220);
  const dragState = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.trackDrag())'));
  report.check(
    `⑨ 拖动中出现指示线（targetIndex=${dragState?.targetIndex}，indicatorTop=${Math.round(dragState?.indicatorTop ?? -1)}）`,
    dragState !== null && dragState.trackId === 'trk_V1',
  );
  await page.session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: nameRect.cx, y: targetY, button: 'left', clickCount: 1,
  });
  await sleep(600);
  const orderAfterDrag = await namesInOrder();
  const dragCleared = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.trackDrag())'));
  report.check(
    `⑨b 松手提交：${JSON.stringify(orderBeforeDrag)} → ${JSON.stringify(orderAfterDrag)}`,
    orderAfterDrag[0] === 'V1' && orderAfterDrag[1] === 'V2' && dragCleared === null,
  );

  // ---- ⑩ 撤销排序 ----
  await page.session.evaluate('window.__VEDITOR_TEST__.undo()');
  await sleep(450);
  const orderUndone = await namesInOrder();
  report.check(
    `⑩ 撤销排序（${JSON.stringify(orderUndone)}）`,
    JSON.stringify(orderUndone) === JSON.stringify(orderBeforeDrag),
  );

  // ---- ⑪ 双击轨道名仍然能改名（4px 阈值没破坏双击）----
  const nameRect2 = await rectOf('[data-v="track-name-trk_V1"]');
  await page.session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: nameRect2.cx, y: nameRect2.cy, button: 'left', clickCount: 1,
  });
  await page.session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: nameRect2.cx, y: nameRect2.cy, button: 'left', clickCount: 1,
  });
  await page.session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: nameRect2.cx, y: nameRect2.cy, button: 'left', clickCount: 2,
  });
  await page.session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: nameRect2.cx, y: nameRect2.cy, button: 'left', clickCount: 2,
  });
  await sleep(400);
  const renameOpen = await page.session.evaluate('!!document.querySelector(\'[data-v="track-rename-input"]\')');
  report.check('⑪ 双击轨道名仍能进入改名（拖动阈值没吃掉双击）', renameOpen === true);
  await page.session.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(200);

  // ---- ⑫ 跨类型不越界：视频轨不能移到音频轨下面 ----
  const videoIds = (await tracksInOrder()).filter((track) => track.kind === 'video').map((track) => track.id);
  const bottomVideo = videoIds.at(-1);
  const downItem = await readTrackMenuItem(bottomVideo, '下移');
  report.check(
    `⑫ 最下面的视频轨「下移」置灰（不跨到音频轨下面）`,
    downItem.found === true && downItem.disabled === true,
  );
} finally {
  report.summary('S3：轨道高度 / 复制 / 排序');
  await page.close();
  dev.kill();
  server.close();
}
