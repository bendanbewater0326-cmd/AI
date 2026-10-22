/**
 * S5 P0 的回归测试：裁剪吸附 / Ctrl 加选 / 多选删除 / 拖出界提示。
 *
 * ## 为什么这四项要一起测
 *
 * 它们都是"接线 + 复用"的改动，风险不在实现而在**没接上**：
 * Ctrl 加选的数据层（`toggleSelection`）早就存在、单测也过，
 * 但 UI 零调用点，功能从上线起就没生效过（S4 的悬停态是同一个病）。
 *
 * 所以每一项都必须**走真实鼠标/键盘事件**，并断言"用户能看见的结果"
 * （片段位置、选中数量、错误提示），而不是只断言 store 字段。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5250;
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
  width: 1440,
  height: 900,
});
const report = createReport();

const clips = async () => JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.clips())'));
const selection = async () => JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.selectionAll())'));
const errors = async () => JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.errors())'));

/**
 * 片段某个边缘的屏幕坐标。
 *
 * `offset` 是相对该边缘的像素偏移（负 = 往左）。
 * **不乘除 DPR**：`layout` 与 `getBoundingClientRect()` 都是 CSS 像素。
 */
async function edgePoint(clipId, side, offsetPx = 0) {
  return JSON.parse(
    await page.session.evaluate(`(() => {
      const clip = window.__VEDITOR_TEST__.clips().find((item) => item.id === ${JSON.stringify(clipId)});
      if (!clip) return JSON.stringify(null);
      const canvas = document.querySelector('[data-v="timeline-canvas"]');
      const layout = window.__VEDITOR_TEST__.timelineLayout();
      const row = layout.rows.find((item) => item.trackId === clip.trackId);
      const zoom = window.__VEDITOR_TEST__.zoomLevel();
      const scrollX = Number(canvas.dataset.scrollX ?? '0');
      const rect = canvas.getBoundingClientRect();
      const frame = ${JSON.stringify(side)} === 'left' ? clip.startFrame : clip.startFrame + clip.durationFrames;
      return JSON.stringify({
        x: rect.left + layout.headerWidth + frame * zoom - scrollX + ${offsetPx},
        y: rect.top + row.top + row.height / 2,
        zoom,
      });
    })()`),
  );
}

/** 造出"两段首尾相接"的片段（splitClip，真实操作路径）。 */
async function splitAt(clipId, cutFrame) {
  await page.session.evaluate(`(() => {
    const clip = window.__VEDITOR_TEST__.clips().find((item) => item.id === ${JSON.stringify(clipId)});
    const cut = ${cutFrame};
    window.__VEDITOR_TEST__.dispatch([{
      op: 'splitClip',
      clipId: clip.id,
      atProjectFrame: clip.startFrame + cut,
      left: { inFrame: clip.inFrame, outFrame: clip.inFrame + cut, startFrame: clip.startFrame, durationFrames: cut },
      right: { inFrame: clip.inFrame + cut, outFrame: clip.outFrame, startFrame: clip.startFrame + cut, durationFrames: clip.durationFrames - cut },
      newClipId: 'clp_right_' + Date.now(),
    }], '切一刀');
    return true;
  })()`);
  await sleep(500);
}

async function drag(from, to, options = {}) {
  const modifiers = options.modifiers ?? 0;
  await page.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, modifiers });
  for (let i = 1; i <= 6; i += 1) {
    await page.session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x + ((to.x - from.x) * i) / 6,
      y: from.y + ((to.y - from.y) * i) / 6,
      button: 'left',
      modifiers,
    });
    await sleep(35);
  }
  await page.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1, modifiers });
  await sleep(450);
}

async function click(point, modifiers = 0) {
  await page.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1, modifiers });
  await page.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1, modifiers });
  await sleep(350);
}

async function pressKey(key, modifiers = 0) {
  const code = key === 'Delete' ? 'Delete' : `Key${key.toUpperCase()}`;
  const vk = key === 'Delete' ? 46 : key.toUpperCase().charCodeAt(0);
  await page.session.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers });
  await page.session.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
  await sleep(450);
}

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 20000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 30000);
  await sleep(2000);

  // 时间线区域拉高，保证 4 条轨都可见（默认 220px 装不下）
  await page.session.evaluate(`document.documentElement.style.setProperty('--v-timeline-h', '420px')`);
  await sleep(400);

  const base = (await clips())[0];
  await splitAt(base.id, Math.floor(base.durationFrames / 2));
  let parts = (await clips()).sort((a, b) => a.startFrame - b.startFrame);
  report.check(
    `① 准备两段首尾相接（${parts.map((c) => `${c.startFrame}..${c.startFrame + c.durationFrames}`).join(' / ')}）`,
    parts.length === 2 && parts[0].startFrame + parts[0].durationFrames === parts[1].startFrame,
  );

  // ---- ② 裁剪吸附：把第一段的右端往左拖，落在第二段起点附近应吸齐 ----
  const first = parts[0];
  const rightEdge = await edgePoint(first.id, 'right', -2);
  /**
   * 只往左拖 **1 帧**（5px）：吸附阈值是 8px，换算成帧约 1.6 帧。
   * 拖 12 帧（60px）离目标 10 帧远，**本来就不该吸** ——
   * 第一次写测试时拖太多，误判成"吸附没实现"。
   */
  const target = { x: rightEdge.x - 1 * rightEdge.zoom, y: rightEdge.y };
  await drag(rightEdge, target);
  parts = (await clips()).sort((a, b) => a.startFrame - b.startFrame);
  const firstEnd = parts[0].startFrame + parts[0].durationFrames;
  report.check(
    `② 裁剪吸附：右端落在 ${firstEnd}，第二段起点 ${parts[1].startFrame}（差 ${Math.abs(firstEnd - parts[1].startFrame)} 帧）`,
    firstEnd === parts[1].startFrame,
  );

  // ---- ③ Ctrl 加选 ----
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(null)`);
  await sleep(200);
  parts = (await clips()).sort((a, b) => a.startFrame - b.startFrame);
  const p1 = await edgePoint(parts[0].id, 'left', 30);
  const p2 = await edgePoint(parts[1].id, 'left', 30);
  await click(p1);
  const afterFirst = await selection();
  await click(p2, 2); // modifiers: 2 = Ctrl
  const afterCtrl = await selection();
  report.check(
    `③ Ctrl 加选：单选 ${afterFirst.length} 个 → Ctrl 点第二个 ${afterCtrl.length} 个`,
    afterFirst.length === 1 && afterCtrl.length === 2,
  );
  await click(p2, 2);
  const afterToggleOff = await selection();
  report.check(
    `③b 再 Ctrl 点一次取消加选（${afterToggleOff.length} 个）`,
    afterToggleOff.length === 1,
  );

  // ---- ④ 多选删除（一次撤销全回来）----
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(null)`);
  await sleep(200);
  parts = (await clips()).sort((a, b) => a.startFrame - b.startFrame);
  await click(await edgePoint(parts[0].id, 'left', 30));
  await click(await edgePoint(parts[1].id, 'left', 30), 2);
  const selectedBefore = await selection();
  const countBefore = (await clips()).length;
  await pressKey('Delete');
  const countAfter = (await clips()).length;
  await page.session.evaluate('window.__VEDITOR_TEST__.undo()');
  await sleep(450);
  const countUndone = (await clips()).length;
  report.check(
    `④ 多选删除：选中 ${selectedBefore.length} 个 → 删后 ${countAfter} 个（原 ${countBefore}）`,
    selectedBefore.length === 2 && countAfter === countBefore - 2,
  );
  report.check(`④b 一次撤销全部回来（${countUndone} 个）`, countUndone === countBefore);

  // ---- ⑤ 多选波纹删除：后续片段前移被删总时长 ----
  parts = (await clips()).sort((a, b) => a.startFrame - b.startFrame);
  // 再造一段，让"后面还有片段"可观察
  await splitAt(parts[1].id, Math.floor(parts[1].durationFrames / 2));
  parts = (await clips()).sort((a, b) => a.startFrame - b.startFrame);
  const tailBefore = parts[parts.length - 1];
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(null)`);
  await sleep(200);
  await click(await edgePoint(parts[0].id, 'left', 20));
  await click(await edgePoint(parts[1].id, 'left', 20), 2);
  const doomedDuration = parts[0].durationFrames + parts[1].durationFrames;
  await pressKey('Delete', 8); // modifiers: 8 = Shift
  const afterRipple = (await clips()).sort((a, b) => a.startFrame - b.startFrame);
  const tailAfter = afterRipple.find((item) => item.id === tailBefore.id);
  report.check(
    `⑤ 波纹删除：尾段 ${tailBefore.startFrame} → ${tailAfter?.startFrame ?? '没了'}（应左移 ${doomedDuration}）`,
    tailAfter !== undefined && tailAfter.startFrame === tailBefore.startFrame - doomedDuration,
  );
  await page.session.evaluate('window.__VEDITOR_TEST__.undo()');
  await sleep(450);

  // ---- ⑥ 拖出轨道区：位置不变 + 可读提示 ----
  await page.session.evaluate(`(() => { window.__VEDITOR_TEST__.dismissAllErrors?.(); return true; })()`);
  parts = (await clips()).sort((a, b) => a.startFrame - b.startFrame);
  const before = parts[0];
  const start = await edgePoint(before.id, 'left', 30);
  /**
   * 目标是**画布内的标尺区**（不是画布外）。
   *
   * 拖出画布会触发 `onPointerLeave` → `controller.cancel()`，那是"取消拖动"，
   * 本来就不该给提示；而"拖到标尺上松手"是"出界回弹"，必须说话。
   * 两者行为不同，测试要选对场景。
   */
  const rulerY = JSON.parse(
    await page.session.evaluate(`(() => {
      const canvas = document.querySelector('[data-v="timeline-canvas"]');
      const rect = canvas.getBoundingClientRect();
      return JSON.stringify({ y: rect.top + 8 });
    })()`),
  ).y;
  await drag(start, { x: start.x + 120, y: rulerY });
  const afterOut = (await clips()).find((item) => item.id === before.id);
  const errs = await errors();
  report.check(
    `⑥ 拖出轨道区：位置 ${before.startFrame} → ${afterOut?.startFrame}（应不变）`,
    afterOut !== undefined && afterOut.startFrame === before.startFrame,
  );
  report.check(
    `⑥b 给出可读提示（"${errs[errs.length - 1]?.message ?? '无'}")`,
    errs.some((error) => /轨道区域外/.test(error.message)),
  );

  // ---- ⑦ 性能：多选绘制与吸附没让重绘退化 ----
  const cost = Number(await page.session.evaluate('window.__VEDITOR_TEST__.renderCost(10)'));
  report.check(`⑦ 单帧重绘 ${cost.toFixed(2)}ms（数量级未回退）`, cost < 25);
} finally {
  report.summary('S5 P0：裁剪吸附 / Ctrl 加选 / 多选删除 / 拖出界提示');
  await page.close();
  dev.kill();
  server.close();
}
