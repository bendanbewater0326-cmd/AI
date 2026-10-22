/**
 * 拖拽上轨（P0-1：剪映式「把素材拖进时间轴」）。
 *
 * ## 为什么这条必须单独测
 *
 * 这是全项目**唯一一个"用户每天用几十次、之前完全做不到"**的入口：
 * 旧实现只能双击素材卡（落到 V1 的播放头位置），拖拽根本没接线。
 * 而 HTML5 拖放有一堆隐式规则（dragover 必须 preventDefault、dragover 阶段读不到
 * `getData()`、自定义 MIME 与"拖文件进窗口导入"会打架），任何一条错都表现为
 * **"拖了没反应"**——不测就只能等用户报。
 *
 * ## 覆盖
 *
 *   ① 素材卡可拖（`draggable`），拖起时带上自定义 MIME
 *   ② dragover → 出现落点预览，且**预览的轨道/帧就是最终落点**（WYSIWYG）
 *   ③ drop → 片段落在预览的位置（误差 ≤1 帧），一个撤销步
 *   ④ 视频拖到音频轨 → 预览变红（invalid）+ 松手给可读错误 + **不产生片段**
 *   ⑤ 拖到轨道头那一列 → 不接（没有落点、松手无事发生）
 *   ⑥ dragend（拖到画布外松手）→ 落点预览被清掉，不留残影
 *   ⑦ 全程无意外错误条
 *
 * 注：用**合成 DragEvent**（`new DragEvent(...)`）而不是 CDP 的原生拖拽：
 * 原生拖拽要 `Input.setInterceptDrags` 且无法注入 dataTransfer，跨平台不稳。
 * 合成事件走的仍是真实的 React 处理器与真实几何换算，覆盖的是我们自己的代码。
 *
 * 运行：`node tests/verify-dragdrop.mjs`
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5232;
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
const page = await launchPage({
  url: `http://127.0.0.1:${PORT}/?src=${fixture.origin}/${FIXTURE}`,
  width: 1440,
  height: 900,
});

let geo = { left: 0, top: 0, cssWidth: 1, canvasWidth: 1, zoom: 5, scrollX: 0 };

async function geometry() {
  return JSON.parse(
    await page.session.evaluate(`(() => {
      const canvas = document.querySelector('[data-v="timeline-canvas"]');
      const rect = canvas.getBoundingClientRect();
      const layout = window.__VEDITOR_TEST__.timelineLayout();
      return JSON.stringify({
        left: rect.left,
        top: rect.top,
        cssWidth: rect.width,
        canvasWidth: canvas.width,
        zoom: window.__VEDITOR_TEST__.zoomLevel(),
        scrollX: Number(canvas.dataset.scrollX ?? '0'),
        tracks: window.__VEDITOR_TEST__.tracks(),
        headerWidth: layout.headerWidth,
        rows: layout.rows,
      });
    })()`),
  );
}

/** 等 scrollX 稳定再量几何（时间线会跟着播放头滚，见 verify-interaction 的教训）。 */
async function stableGeometry() {
  const read = () =>
    page.session.evaluate(`Number(document.querySelector('[data-v="timeline-canvas"]').dataset.scrollX ?? '0')`);
  let last = await read();
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    await sleep(120);
    const next = await read();
    if (next === last) break;
    last = next;
  }
  geo = await geometry();
}

/** 轨道 id → 屏幕行号（显示顺序：视频在前，音频垫底）。 */
/** 轨道 id → 行号（直接问布局，不再自己排一遍）。 */
function rowOf(trackId) {
  return geo.rows.findIndex((row) => row.trackId === trackId);
}

const sc = () => geo.cssWidth / geo.canvasWidth;
// 几何从钩子取（轨道头 130px、轨道高 60/50/32），别再硬编码 56/24
const xOfFrame = (frame) => geo.left + (geo.headerWidth + frame * geo.zoom - geo.scrollX) * sc();
const yOfTrack = (index) =>
  geo.top + (geo.rows[index].top + geo.rows[index].height / 2) * sc();

const state = async () =>
  JSON.parse(
    await page.session.evaluate(`JSON.stringify({
      clips: window.__VEDITOR_TEST__.clips().map((clip) => ({
        id: clip.id, trackId: clip.trackId, start: clip.startFrame, duration: clip.durationFrames,
      })),
      errors: window.__VEDITOR_TEST__.errors().map((item) => item.message),
      ghost: window.__VEDITOR_TEST__.dropGhost(),
    })`),
  );

/**
 * 合成一次完整的拖放：dragstart(素材卡) → dragover(画布) → drop(画布)。
 *
 * `clientX/clientY` 用**画布 CSS 坐标**（React 处理器内部再换算成 canvas 内部坐标）。
 */
async function dragTo(clientX, clientY, options = {}) {
  const { drop = true } = options;
  return page.session.evaluate(`(() => {
    const card = document.querySelector('[data-v="asset-card"]');
    const canvas = document.querySelector('[data-v="timeline-canvas"]');
    const dataTransfer = new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
    const over = new DragEvent('dragover', {
      bubbles: true, cancelable: true, dataTransfer, clientX: ${clientX}, clientY: ${clientY},
    });
    canvas.dispatchEvent(over);
    if (${drop}) {
      canvas.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer, clientX: ${clientX}, clientY: ${clientY},
      }));
    }
    return JSON.stringify({ prevented: over.defaultPrevented, types: Array.from(dataTransfer.types) });
  })()`);
}

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 15000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 25000);
  await sleep(1400);
  await stableGeometry();

  // ---- ① 素材卡可拖 ----
  const card = JSON.parse(
    await page.session.evaluate(`(() => {
      const el = document.querySelector('[data-v="asset-card"]');
      return JSON.stringify({ draggable: el.draggable, imgDraggable: el.querySelector('img')?.draggable ?? null });
    })()`),
  );
  report.check(
    `① 素材卡可拖（draggable=${card.draggable}），缩略图仍禁止拖（${card.imgDraggable}）`,
    card.draggable === true && card.imgDraggable === false,
  );

  const before = await state();
  const v2Row = rowOf('trk_V2');
  report.check(`① 找到 V2 行号（${v2Row}）`, v2Row >= 0);

  // ---- ② dragover → 落点预览，且预览 = 最终落点 ----
  const targetFrame = 120;
  const dropX = xOfFrame(targetFrame);
  const dropY = yOfTrack(v2Row);
  const dragInfo = JSON.parse(await dragTo(dropX, dropY, { drop: false }));
  await sleep(200);
  const hovering = await state();
  report.check(
    `② dragover 被接管（prevented=${dragInfo.prevented}，types=${JSON.stringify(dragInfo.types)}）`,
    dragInfo.prevented === true && dragInfo.types.includes('application/x-veditor-asset'),
  );
  report.check(
    `② 出现落点预览（轨道 ${hovering.ghost?.trackId} 起点 ${hovering.ghost?.startFrame} 有效 ${hovering.ghost?.valid}）`,
    hovering.ghost !== null &&
      hovering.ghost.trackId === 'trk_V2' &&
      Math.abs(hovering.ghost.startFrame - targetFrame) <= 1 &&
      hovering.ghost.valid === true,
  );

  /**
   * ②b 落点预览**真的画在画布上**（不是只写进 state）。
   *
   * 为什么要量像素：`dropGhost` 只存在于 ephemeral，painter 完全可能忘了画它，
   * 而 E2E 读 state 会一路绿 —— 用户看到的是"拖了半天没反应"。
   * 判据用色相而不是精确色值：ghost 以 0.45 透明度压在轨道底色上，
   * 合成后的颜色不是 `#534ab7`，但"蓝明显多于红"这个特征稳定（底色是中性灰）。
   */
  const ghostPixels = JSON.parse(
    await page.session.evaluate(`(() => {
      const canvas = document.querySelector('[data-v="timeline-canvas"]');
      const ctx = canvas.getContext('2d');
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const x = Math.round((${dropX} - rect.left) * scaleX);
      const y = Math.round((${dropY} - rect.top) * scaleY);
      const box = ctx.getImageData(Math.max(0, x + 2), Math.max(0, y - 10), 24, 20).data;
      let bluish = 0;
      for (let i = 0; i + 3 < box.length; i += 4) {
        if (box[i + 2] - box[i] > 40) bluish += 1;
      }
      return JSON.stringify({ bluish, total: box.length / 4 });
    })()`),
  );
  report.check(
    `②b 落点预览真的画出来了（偏蓝像素 ${ghostPixels.bluish}/${ghostPixels.total}）`,
    ghostPixels.bluish > 20,
  );

  // ---- ③ drop → 片段落在预览的位置 ----
  await dragTo(dropX, dropY);
  await sleep(500);
  const dropped = await state();
  const added = dropped.clips.find((clip) => !before.clips.some((old) => old.id === clip.id));
  report.check(
    `③ 拖入产生新片段（${before.clips.length} → ${dropped.clips.length} 段）`,
    dropped.clips.length === before.clips.length + 1 && added !== undefined,
  );
  report.check(
    `③ 落在预览的位置（轨道 ${added?.trackId} 起点 ${added?.start}，预览是 ${hovering.ghost?.trackId}/${hovering.ghost?.startFrame}）`,
    added !== undefined &&
      added.trackId === hovering.ghost?.trackId &&
      Math.abs(added.start - (hovering.ghost?.startFrame ?? -1)) <= 1,
  );
  report.check(
    `③ 落点就是拖到的帧（误差 ≤1，期望 ${targetFrame}）`,
    added !== undefined && Math.abs(added.start - targetFrame) <= 1,
  );
  report.check(`③ 松手后预览被清掉（ghost=${JSON.stringify(dropped.ghost)}）`, dropped.ghost === null);

  // ---- 一次撤销能撤掉 ----
  await page.session.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2,
  });
  await page.session.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2,
  });
  await sleep(500);
  const undone = await state();
  report.check(
    `③ 一次撤销回到 ${undone.clips.length} 段（期望 ${before.clips.length}）`,
    undone.clips.length === before.clips.length,
  );

  // ---- ⑧ 落点吸附（拖到片段边缘会贴齐）----
  await stableGeometry();
  const v2RowSnap = rowOf('trk_V2');
  // V1 上那段是 0..240，拖到 239 附近应该被吸到 240（8px 阈值 / zoom）
  await dragTo(xOfFrame(239), yOfTrack(v2RowSnap), { drop: false });
  await sleep(200);
  const snappedGhost = await state();
  report.check(
    `⑧ 落点吸附到片段边缘（原始 239 → 预览 ${snappedGhost.ghost?.startFrame}，期望 240）`,
    snappedGhost.ghost?.startFrame === 240,
  );

  // 关掉吸附（N）后同样的位置不再贴齐
  await page.session.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78,
  });
  await page.session.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78,
  });
  await sleep(250);
  await dragTo(xOfFrame(239), yOfTrack(v2RowSnap), { drop: false });
  await sleep(200);
  const unsnapped = await state();
  report.check(
    `⑧ 关掉吸附后不贴齐（预览 ${unsnapped.ghost?.startFrame}，期望 239）`,
    Math.abs((unsnapped.ghost?.startFrame ?? -1) - 239) <= 1,
  );
  // 恢复吸附，后面的用例按默认行为断言
  await page.session.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78,
  });
  await page.session.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78,
  });
  await sleep(200);

  // ---- ④ 视频拖到音频轨 → 红块 + 可读错误 + 不产生片段 ----
  await stableGeometry();
  const a1Row = rowOf('trk_A1');
  const badX = xOfFrame(60);
  const badY = yOfTrack(a1Row);
  await dragTo(badX, badY, { drop: false });
  await sleep(200);
  const invalid = await state();
  report.check(
    `④ 视频拖到音频轨 → 预览无效（valid=${invalid.ghost?.valid}，原因"${invalid.ghost?.reason ?? ''}"）`,
    invalid.ghost !== null && invalid.ghost.valid === false && /视频只能放到视频轨/.test(String(invalid.ghost.reason)),
  );
  const invalidPixels = JSON.parse(
    await page.session.evaluate(`(() => {
      const canvas = document.querySelector('[data-v="timeline-canvas"]');
      const ctx = canvas.getContext('2d');
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const x = Math.round((${badX} - rect.left) * scaleX);
      const y = Math.round((${badY} - rect.top) * scaleY);
      const box = ctx.getImageData(Math.max(0, x + 2), Math.max(0, y - 10), 24, 20).data;
      let reddish = 0;
      for (let i = 0; i + 3 < box.length; i += 4) {
        if (box[i] - box[i + 2] > 50) reddish += 1;
      }
      return JSON.stringify({ reddish, total: box.length / 4 });
    })()`),
  );
  report.check(
    `④ 无效落点画成红色（偏红像素 ${invalidPixels.reddish}/${invalidPixels.total}）`,
    invalidPixels.reddish > 20,
  );

  const beforeBadDrop = (await state()).clips.length;
  await dragTo(badX, badY);
  await sleep(450);
  const afterBadDrop = await state();
  report.check(
    `④ 松手不产生片段（${beforeBadDrop} → ${afterBadDrop.clips.length} 段）`,
    afterBadDrop.clips.length === beforeBadDrop,
  );
  report.check(
    `④ 给出可读错误（${JSON.stringify(afterBadDrop.errors)}）`,
    afterBadDrop.errors.some((message) => /视频只能放到视频轨/.test(message)),
  );

  // ---- ⑤ 拖到轨道头那一列 → 不接 ----
  await dragTo(geo.left + 20 * sc(), yOfTrack(v2Row), { drop: false });
  await sleep(200);
  const headerDrop = await state();
  report.check(
    `⑤ 轨道头那一列没有落点（ghost=${JSON.stringify(headerDrop.ghost)}）`,
    headerDrop.ghost === null,
  );

  // ---- ⑥ dragend 兜底清理 ----
  await dragTo(xOfFrame(200), yOfTrack(v2Row), { drop: false });
  await sleep(150);
  const beforeEnd = await state();
  await page.session.evaluate(`(() => {
    const card = document.querySelector('[data-v="asset-card"]');
    card.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    return true;
  })()`);
  await sleep(250);
  const afterEnd = await state();
  report.check(
    `⑥ dragend 后预览被清掉（${JSON.stringify(beforeEnd.ghost)} → ${JSON.stringify(afterEnd.ghost)}）`,
    beforeEnd.ghost !== null && afterEnd.ghost === null,
  );

  const errors = (await state()).errors.filter((message) => !/视频只能放到视频轨/.test(message));
  report.check(`⑦ 无意外错误条（${JSON.stringify(errors)}）`, errors.length === 0);

  report.summary('拖拽上轨（P0-1）');
} finally {
  await page.close();
  dev.kill();
  await fixture.close();
}
