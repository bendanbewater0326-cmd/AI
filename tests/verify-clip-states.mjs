/**
 * S4：片段四态（默认 / 悬停 / 选中 / 锁定）的回归测试。
 *
 * ## 为什么四态必须读画布像素
 *
 * 四态**全是视觉**，没有任何 DOM 可断言。而这类"改了但没画出来"的 bug
 * 在 canvas 上极常见（S2 的压暗就被轨道头底色盖住过一次，代码明明加了、像素没变）。
 * 所以每一项都读像素：边框颜色、悬停亮度差、角标底色、四角锚点。
 *
 * ## 还顺带钉住三件容易漏的事
 *
 * 1. **悬停态曾经是死代码**：`ephemeral.hoverClipId` 从来没被写过，
 *    `drawClip` 里的 hover 分支永远走不到（S4 才发现并接上）；
 * 2. **锁定态必须真的拦住拖动**：之前 `timelineController` 里完全没有 `locked` 判断，
 *    锁定按钮"看起来有效、实际没拦住"；
 * 3. **锁定与离线/静音角标要能共存**：三者可能同时成立，位置必须错开。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5247;
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
const tracks = async () => JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.tracks())'));
const exists = async (selector) => page.session.evaluate(`document.querySelector(${JSON.stringify(selector)}) !== null`);

/** 片段在屏幕上的矩形（含 zoom / scroll 换算）。 */
const clipRect = async (clipId) =>
  JSON.parse(
    await page.session.evaluate(`(() => {
      const clip = window.__VEDITOR_TEST__.clips().find((item) => item.id === ${JSON.stringify(clipId)});
      if (!clip) return JSON.stringify(null);
      const canvas = document.querySelector('[data-v="timeline-canvas"]');
      const layout = window.__VEDITOR_TEST__.timelineLayout();
      const row = layout.rows.find((item) => item.trackId === clip.trackId);
      if (!row) return JSON.stringify(null);
      const zoom = window.__VEDITOR_TEST__.zoomLevel();
      const scrollX = Number(canvas.dataset.scrollX ?? '0');
      const rect = canvas.getBoundingClientRect();
      const scale = canvas.width / rect.width;
      const x = (layout.headerWidth + clip.startFrame * zoom - scrollX) * scale;
      const w = Math.min(clip.durationFrames * zoom, 240) * scale;
      return JSON.stringify({
        // 屏幕坐标（给 CDP 派发鼠标事件用）
        sx: rect.left + x / scale,
        sy: rect.top + (row.top + row.height / 2) / scale,
        // 画布坐标（给 getImageData 用）
        cx: x,
        cy: row.top * scale,
        cw: w,
        ch: row.height * scale,
        scale,
        rowTop: row.top,
        rowHeight: row.height,
        rightEdge: x + w,
      });
    })()`),
  );

/** 片段区域内的统计：平均亮度、主色像素数、红/灰/白底像素数。 */
const clipStats = async (clipId, region) =>
  JSON.parse(
    await page.session.evaluate(`(() => {
      const clip = window.__VEDITOR_TEST__.clips().find((item) => item.id === ${JSON.stringify(clipId)});
      if (!clip) return JSON.stringify({ missing: true });
      const canvas = document.querySelector('[data-v="timeline-canvas"]');
      const layout = window.__VEDITOR_TEST__.timelineLayout();
      const row = layout.rows.find((item) => item.trackId === clip.trackId);
      if (!row) return JSON.stringify({ missing: true });
      const zoom = window.__VEDITOR_TEST__.zoomLevel();
      const scrollX = Number(canvas.dataset.scrollX ?? '0');
      const scale = canvas.width / canvas.getBoundingClientRect().width;
      const x = (layout.headerWidth + clip.startFrame * zoom - scrollX) * scale;
      const w = Math.min(clip.durationFrames * zoom, 240) * scale;
      const h = row.height * scale;
      const y = row.top * scale;
      const region = ${JSON.stringify(region ?? null)};
      const rx = region === null ? x + 4 : x + region.dx * scale;
      const ry = region === null ? y + 6 : y + region.dy * scale;
      const rw = region === null ? Math.max(1, w - 8) : Math.max(1, region.dw * scale);
      const rh = region === null ? Math.max(1, h - 12) : Math.max(1, region.dh * scale);
      const data = canvas.getContext('2d').getImageData(rx, ry, rw, rh).data;
      let luma = 0;
      let accent = 0;
      let gray = 0;
      let white = 0;
      let red = 0;
      const total = data.length / 4;
      for (let i = 0; i + 3 < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        luma += 0.2126 * r + 0.7152 * g + 0.0722 * b;
        // 主色 #1677ff 附近（b 明显高于 r）
        if (b > 150 && b - r > 60 && g > 80) accent += 1;
        // 中灰（锁定描边 #8c8c8c / 锁定角标底）
        if (Math.abs(r - g) < 14 && Math.abs(g - b) < 14 && r > 110 && r < 175) gray += 1;
        if (r > 235 && g > 235 && b > 235) white += 1;
        // 离线角标底色 #d4380d
        if (r > 150 && g < 110 && b < 110) red += 1;
      }
      return JSON.stringify({ luma: luma / total, accent, gray, white, red, total });
    })()`),
  );

/** 派发鼠标移动（触发 hover）。 */
const moveTo = async (x, y) => {
  await page.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await sleep(220);
};

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 20000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 30000);
  await sleep(2000);

  const clip = (await clips())[0];
  const trackId = clip.trackId;
  const rect = await clipRect(clip.id);
  report.check(
    `① 找到测试片段（${clip.id.slice(0, 8)}… 在 ${trackId}，屏幕 ${Math.round(rect.sx)},${Math.round(rect.sy)}）`,
    rect !== null && rect.cw > 20,
  );

  // ---- ② 默认态：细边框 + 无主色 ----
  await moveTo(10, 10); // 先移开，确保没有残留 hover
  /**
   * 只读**左边缘 2px 列**：片段内容是素材缩略图（sample-720p 画面里本来就有蓝色），
   * 整块统计会把画面的蓝当成"主色描边"（实测 1265 个像素）。
   * 边框是否主色，只看边缘那一条才准。
   */
  const defaultEdge = await clipStats(clip.id, { dx: 0, dy: 4, dw: 2, dh: 40 });
  const defaultBody = await clipStats(clip.id);
  report.check(
    `② 默认态：边缘无主色描边（边缘主色像素 ${defaultEdge.accent}）`,
    defaultEdge.accent < 5,
  );

  // ---- ③ 悬停态：亮度提升 + 把手显现 ----
  await moveTo(rect.sx, rect.sy);
  const hoverBody = await clipStats(clip.id);
  const hoverEdge = await clipStats(clip.id, { dx: 0, dy: 2, dw: 8, dh: 40 });
  report.check(
    `③ 悬停态：整块变亮（${defaultBody.luma.toFixed(1)} → ${hoverBody.luma.toFixed(1)}）`,
    hoverBody.luma > defaultBody.luma + 1,
  );
  report.check(
    `③b 悬停态：左端把手显现（主色像素 ${hoverEdge.accent}）`,
    hoverEdge.accent > 20,
  );

  // ---- ④ 选中态：2px 主色描边 + 四角锚点 ----
  await page.session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: rect.sx, y: rect.sy, button: 'left', clickCount: 1,
  });
  await page.session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: rect.sx, y: rect.sy, button: 'left', clickCount: 1,
  });
  await sleep(400);
  const selected = await clipStats(clip.id);
  const corner = await clipStats(clip.id, { dx: 0, dy: 2, dw: 5, dh: 5 });
  report.check(
    `④ 选中态：出现主色描边（主色像素 ${selected.accent}，选中=${JSON.stringify(
      await page.session.evaluate('window.__VEDITOR_TEST__.selection()'),
    )}）`,
    selected.accent > 40,
  );
  report.check(
    `④b 选中态：左上角有锚点（主色像素 ${corner.accent}）`,
    corner.accent > 2,
  );

  // ---- ⑤ 锁定态：整体变暗 + 右上角「锁」角标 ----
  const beforeLock = await clipStats(clip.id);
  await page.session.evaluate(`window.__VEDITOR_TEST__.setTrackFlag('${trackId}', 'locked', true)`);
  await sleep(500);
  const locked = await clipStats(clip.id);
  /**
   * 锁角标画在**片段右端**（`x + width - badgeW`），而片段实际宽度是
   * `durationFrames × zoom`（240 帧 × 5 = 1200px，远宽于视口）。
   * 用固定偏移（如 dx:200）会读到片段中段的画面 —— 实测灰像素 0。
   */
  const clipWidth = clip.durationFrames * (await page.session.evaluate('window.__VEDITOR_TEST__.zoomLevel()'));
  const lockBadge = await clipStats(clip.id, { dx: clipWidth - 34, dy: 4, dw: 30, dh: 12 });
  report.check(
    `⑤ 锁定态：整块压暗（${beforeLock.luma.toFixed(1)} → ${locked.luma.toFixed(1)}）`,
    locked.luma < beforeLock.luma - 8,
  );
  report.check(
    `⑤b 锁定态：右上角有「锁」角标（灰底像素 ${lockBadge.gray}）`,
    lockBadge.gray > 8,
  );

  // ---- ⑥ 锁定态：不画主色描边与把手（不能暗示"可操作"）----
  const lockedEdge = await clipStats(clip.id, { dx: 0, dy: 2, dw: 8, dh: 40 });
  report.check(
    `⑥ 锁定态：即使选中也不显示主色把手（主色像素 ${lockedEdge.accent}）`,
    lockedEdge.accent < 20,
  );

  // ---- ⑦ 锁定态：光标 not-allowed ----
  await moveTo(rect.sx, rect.sy);
  const cursor = await page.session.evaluate(
    'document.querySelector(\'[data-v="timeline-canvas"]\').style.cursor',
  );
  report.check(`⑦ 锁定态：光标 ${JSON.stringify(cursor)}`, cursor === 'not-allowed');

  // ---- ⑧ 锁定态：拒绝拖动，并给出可读原因 ----
  const beforeDrag = (await clips())[0];
  await page.session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: rect.sx, y: rect.sy, button: 'left', clickCount: 1,
  });
  for (let step = 1; step <= 5; step += 1) {
    await page.session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: rect.sx + step * 12, y: rect.sy, button: 'left',
    });
    await sleep(40);
  }
  await page.session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: rect.sx + 60, y: rect.sy, button: 'left', clickCount: 1,
  });
  await sleep(500);
  const afterDrag = (await clips())[0];
  const errors = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.errors())'));
  report.check(
    `⑧ 锁定态：拖动被拒绝（startFrame ${beforeDrag.startFrame} → ${afterDrag.startFrame}）`,
    beforeDrag.startFrame === afterDrag.startFrame,
  );
  report.check(
    `⑧b 锁定态：给出可读原因（"${errors[0]?.message ?? '无'}")`,
    errors.some((error) => /锁定/.test(error.message)),
  );

  // ---- ⑨ 解锁后恢复可拖动 ----
  await page.session.evaluate(`window.__VEDITOR_TEST__.setTrackFlag('${trackId}', 'locked', false)`);
  await sleep(400);
  const unlockedStats = await clipStats(clip.id);
  report.check(
    `⑨ 解锁后不再压暗（${locked.luma.toFixed(1)} → ${unlockedStats.luma.toFixed(1)}）`,
    unlockedStats.luma > locked.luma + 8,
  );

  // ---- ⑩ 兼容：锁定 + 离线同时存在，两个角标都在 ----
  const assetId = clip.assetId;
  await page.session.evaluate(`window.__VEDITOR_TEST__.setAssetStatus('${assetId}', 'offline')`);
  await page.session.evaluate(`window.__VEDITOR_TEST__.setTrackFlag('${trackId}', 'locked', true)`);
  await sleep(600);
  const both = await clipStats(clip.id);
  const offlineBadge = await clipStats(clip.id, { dx: 2, dy: 18, dw: 30, dh: 12 });
  const lockBadge2 = await clipStats(clip.id, { dx: clipWidth - 34, dy: 4, dw: 30, dh: 12 });
  report.check(
    `⑩ 离线 + 锁定共存：两个角标都在（离线红底 ${offlineBadge.red}，锁定灰底 ${lockBadge2.gray}）`,
    both.luma > 0 && offlineBadge.red > 4 && lockBadge2.gray > 4,
  );
  await page.session.evaluate(`window.__VEDITOR_TEST__.setAssetStatus('${assetId}', 'ok')`);
  await page.session.evaluate(`window.__VEDITOR_TEST__.setTrackFlag('${trackId}', 'locked', false)`);
  await sleep(400);

  // ---- ⑪ 性能：四态绘制没有明显回退 ----
  const cost = Number(await page.session.evaluate('window.__VEDITOR_TEST__.renderCost(10)'));
  report.check(`⑪ 100 片段重绘中位 ${cost.toFixed(2)}ms（数量级未回退）`, cost < 25);

  // ---- ⑫ 无报错 ----
  const finalErrors = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.errors())'));
  report.check(
    `⑫ 全程无意外错误（${finalErrors.length} 条，含前面故意触发的锁定提示）`,
    finalErrors.every((error) => /锁定|离线/.test(error.message)),
  );
} finally {
  report.summary('S4：片段四态（默认 / 悬停 / 选中 / 锁定）');
  await page.close();
  dev.kill();
  server.close();
}
