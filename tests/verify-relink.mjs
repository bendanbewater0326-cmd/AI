/**
 * 素材重链的回归测试（P0 手动重链 + 视觉标识 + 数据一致性）。
 *
 * ## 为什么"选文件"这一步不测
 *
 * CDP 无法操作系统文件选择框，所以 `showOpenFilePicker` / `<input type=file>`
 * 这一跳没法自动化。这里用 `relinkAssetFromUrl` 走**同一条**
 * `relinkAssetFromFile`，覆盖真正容易错的部分：
 * 探测新文件 → 写回同一个 assetId → 清解码缓存 → 立刻重绘。
 *
 * ## 重点断言"数据一致性"
 *
 * 重链最容易出的问题是"顺手把片段也改了"（比如按新时长重新算 durationFrames）。
 * 验收标准要求**片段属性一个都不能变**，所以这里逐字对比重链前后的 clips。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5243;
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

const assets = async () => JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.assets())'));
const clips = async () => JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.clips())'));
const exists = async (selector) =>
  page.session.evaluate(`document.querySelector(${JSON.stringify(selector)}) !== null`);

/** 读可见预览画布的非黑像素比例（花屏/黑屏都靠它判）。 */
const previewFilled = async () =>
  JSON.parse(
    await page.session.evaluate(`(() => {
      const canvas = document.querySelector('[data-v="preview-canvas"]');
      if (!canvas) return JSON.stringify({ ratio: 0 });
      const off = document.createElement('canvas');
      off.width = canvas.width;
      off.height = canvas.height;
      const ctx = off.getContext('2d');
      ctx.drawImage(canvas, 0, 0);
      const { data } = ctx.getImageData(0, 0, off.width, off.height);
      let nonBlack = 0;
      for (let i = 0; i + 3 < data.length; i += 4) {
        if (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2] > 6) nonBlack += 1;
      }
      return JSON.stringify({ ratio: nonBlack / (data.length / 4) });
    })()`),
  );

/** 读时间线某条片段区域的像素统计（灰蒙层 + 红角标都看这里）。 */
const clipPixels = async (clipId) =>
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
      const x = Math.round((layout.headerWidth + clip.startFrame * zoom - scrollX) * scale);
      const ctx = canvas.getContext('2d');
      /**
       * 只读**角标那一小块**（x+2 起 34px、y+18 起 12px）。
       *
       * 之前读整段 300px 宽：素材画面本身就有红色（实测偏红 1568 像素），
       * 角标只占几十个像素，信噪比太低 —— "角标消失"根本测不出来。
       * 判据也改成"红底"（r 高、g/b 低），而不是"偏红"。
       */
      const data = ctx.getImageData(
        Math.max(0, x + 2),
        Math.round((row.top + 18) * scale),
        Math.round(34 * scale),
        Math.round(12 * scale),
      ).data;
      let badge = 0;
      const total = data.length / 4;
      for (let i = 0; i + 3 < data.length; i += 4) {
        if (data[i] > 150 && data[i + 1] < 110 && data[i + 2] < 110) badge += 1;
      }
      return JSON.stringify({ badge, total });
    })()`),
  );

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 20000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 30000);
  await sleep(2500);

  const asset = (await assets())[0];
  const clip = (await clips())[0];
  report.check(
    `① 初始在线（${asset.name}，status=${asset.status}）`,
    asset.status === 'ok' || asset.status === 'memory',
  );
  report.check('①b 在线时没有离线条', (await exists('[data-v="offline-bar"]')) === false);

  // ---- ② 模拟离线 ----
  await page.session.evaluate(`window.__VEDITOR_TEST__.setAssetStatus('${asset.id}', 'offline')`);
  await sleep(1200);

  report.check('② 离线条出现', (await exists('[data-v="offline-bar"]')) === true);
  const barText = await page.session.evaluate(
    'document.querySelector(\'[data-v="offline-bar-text"]\')?.textContent ?? ""',
  );
  report.check(`②b 离线条写明数量和名字（"${String(barText).trim()}"）`, /1 个素材离线/.test(String(barText)));

  report.check('②c 素材卡有「离线」角标', (await exists('[data-v="asset-offline-badge"]')) === true);
  report.check('②d 预览区出现「素材已离线」提示', (await exists('[data-v="preview-offline-hint"]')) === true);

  const offlinePixels = await clipPixels(clip.id);
  report.check(
    `②e 时间线片段出现红色「离线」角标（红底像素 ${offlinePixels.badge}/${offlinePixels.total}）`,
    offlinePixels.badge > 30,
  );
  // 基线：角标区域里"素材画面本身的红"有多少（下面用相对差值判"角标消失了"）
  const badgeBaseline = offlinePixels.badge;

  const blackedPreview = await previewFilled();
  report.check(
    `②f 离线后预览变黑（非黑 ${(blackedPreview.ratio * 100).toFixed(1)}%）`,
    blackedPreview.ratio < 0.02,
  );

  // ---- ③ 离线素材的右键菜单有「重新链接…」----
  await page.session.evaluate(`(() => {
    const card = document.querySelector('[data-v="asset-card"]');
    if (!card) return false;
    const rect = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, clientX: rect.left + 8, clientY: rect.top + 8,
    }));
    return true;
  })()`);
  /**
   * **必须等一帧**：`contextmenu` 处理器只是 `setMenu(...)`，
   * React 18 的更新是异步的，dispatch 完立刻查 DOM 一定是空的
   * （第一次跑这里拿到 `[]`，差点误判成"菜单没做"）。
   */
  await sleep(300);
  const menuItems = JSON.parse(
    await page.session.evaluate(
      `JSON.stringify(Array.from(document.querySelectorAll('[data-v="context-menu"] button')).map((b) => b.textContent))`,
    ),
  );
  report.check(
    `③ 素材卡右键有「重新链接…」和「批量重新链接…」（${JSON.stringify(menuItems)}）`,
    menuItems.some((text) => String(text).startsWith('重新链接')) &&
      menuItems.some((text) => String(text).startsWith('批量重新链接')),
  );
  await page.session.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(300);

  // ---- ④ 重链（数据一致性是重点）----
  const clipsBefore = await clips();
  const result = await page.session.evaluate(
    `window.__VEDITOR_TEST__.relinkAssetFromUrl('${asset.id}', ${JSON.stringify(`${origin}/${FIXTURE}`)})`,
  );
  await sleep(1800);
  report.check(`④ 重链返回 ${JSON.stringify(result)}`, result === 'ok');

  const afterAsset = (await assets()).find((item) => item.id === asset.id);
  report.check(
    `④b 素材状态回到可用（status=${afterAsset?.status}）`,
    afterAsset?.status === 'ok' || afterAsset?.status === 'memory',
  );
  report.check('④c 离线条消失', (await exists('[data-v="offline-bar"]')) === false);
  report.check('④d 素材卡角标消失', (await exists('[data-v="asset-offline-badge"]')) === false);
  report.check('④e 预览提示消失', (await exists('[data-v="preview-offline-hint"]')) === false);

  const clipsAfter = await clips();
  report.check(
    `④f **片段属性逐字未变**（${clipsBefore.length} 个片段）`,
    JSON.stringify(clipsBefore) === JSON.stringify(clipsAfter),
    JSON.stringify({ before: clipsBefore[0], after: clipsAfter[0] }).slice(0, 300),
  );

  const restoredPreview = await previewFilled();
  report.check(
    `④g 预览画面回来（非黑 ${(restoredPreview.ratio * 100).toFixed(1)}%）`,
    restoredPreview.ratio > 0.1,
  );

  const restoredPixels = await clipPixels(clip.id);
  /**
   * 判据用**相对差值**而不是"绝对小于 5"：这一小块区域里本来就有素材画面的红
   * （实测恢复后仍有 144 个偏红像素），绝对值判据会把"正常画面"当成"角标还在"。
   */
  report.check(
    `④h 时间线角标消失（红底像素 ${badgeBaseline} → ${restoredPixels.badge}）`,
    restoredPixels.badge < badgeBaseline - 30,
  );

  // ---- ⑤ 重链不该进撤销栈 ----
  const undoLabel = await page.session.evaluate(
    `(() => { const entry = window.__VEDITOR_TEST__.lastUndoLabel?.(); return entry ?? ''; })()`,
  );
  report.check(
    `⑤ 重链不进撤销栈（最近一步：${JSON.stringify(undoLabel)}）`,
    !String(undoLabel).includes('重新链接'),
  );

  // ---- ⑥ 向下兼容：旧工程没有 contentHash/sourcePath 也能重链 ----
  await page.session.evaluate(`window.__VEDITOR_TEST__.setAssetStatus('${asset.id}', 'offline')`);
  await sleep(500);
  await page.session.evaluate(`window.__VEDITOR_TEST__.dispatch([], '占位')`);
  const legacyResult = await page.session.evaluate(
    `window.__VEDITOR_TEST__.relinkAssetFromUrl('${asset.id}', ${JSON.stringify(`${origin}/${FIXTURE}`)})`,
  );
  report.check(`⑥ 旧数据（无指纹/无路径）也能重链（${legacyResult}）`, legacyResult === 'ok');

  // ---- ⑦ 自动恢复闸门：恢复期间不弹离线条 ----
  await page.session.evaluate(`window.__VEDITOR_TEST__.setAssetStatus('${asset.id}', 'offline')`);
  await page.session.evaluate('window.__VEDITOR_TEST__.setAutoRestoreDone(false)');
  await sleep(500);
  const workingVisible = await exists('[data-v="offline-bar-working"]');
  const offlineBarVisible = await exists('[data-v="offline-bar"]');
  const workingText = await page.session.evaluate(
    'document.querySelector(\'[data-v="offline-bar-working"] .v-offlinebar__text\')?.textContent ?? ""',
  );
  report.check(
    `⑦ 自动恢复进行中 → 只显示"正在自动恢复"、**不弹离线条**（"${String(workingText).trim()}"）`,
    workingVisible === true && offlineBarVisible === false && /正在自动恢复/.test(String(workingText)),
  );
  report.check(
    '⑦b 恢复中的条没有手动按钮（不需要用户操作）',
    (await exists('[data-v="offline-relink"]')) === false,
  );

  // ---- ⑧ 恢复结束 → 才变成带按钮的离线条 ----
  await page.session.evaluate('window.__VEDITOR_TEST__.setAutoRestoreDone(true)');
  await sleep(500);
  report.check(
    '⑧ 恢复结束后才显示离线条与手动入口',
    (await exists('[data-v="offline-bar"]')) === true &&
      (await exists('[data-v="offline-relink"]')) === true &&
      (await exists('[data-v="offline-bar-working"]')) === false,
  );

  // 收尾：把它链回去，避免影响后续断言
  await page.session.evaluate(
    `window.__VEDITOR_TEST__.relinkAssetFromUrl('${asset.id}', ${JSON.stringify(`${origin}/${FIXTURE}`)})`,
  );
  await sleep(900);

  // ---- ⑨ 性能：重链后单帧渲染没退 ----
  const cost = Number(await page.session.evaluate('window.__VEDITOR_TEST__.renderCost(8)'));
  report.check(`⑨ 单帧渲染 ${cost.toFixed(2)}ms（未回退）`, cost < 8);
} finally {
  report.summary('素材重链（P0 手动重链 / 视觉标识 / 数据一致性）');
  await page.close();
  dev.kill();
  server.close();
}
