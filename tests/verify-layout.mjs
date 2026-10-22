/**
 * S1.2 的回归测试：三栏百分比布局 / 拖拽 / 折叠 / 记忆。
 *
 * ## 为什么这些必须实测
 *
 * 三栏宽度是**布局的地基**：算错一点，预览画布、时间线、面板全部跟着错位，
 * 而"看起来还行"是最容易放过的那类问题（1920 和 1440 下的比例完全不同）。
 * 所以每条都读 `uiLayout()` 的实际像素，而不是读 CSS 变量。
 *
 * ## 三个容易踩的测试坑（本文件里已经避开）
 *
 * 1. **拖拽要拖够距离**：15%–40% 的范围在 1440 宽下是 216–576px，
 *    拖 20px 根本到不了边界，断言"clamp 到 15%"会失败；
 * 2. **折叠后元素宽度是 0，但 DOM 还在**：断言"元素存在"不等于"面板可见"，
 *    要断言 `w === 0`；
 * 3. **窄屏那条必须真的刷新**：被测的 bug 在挂载时的 `useEffect` 里，
 *    如果测试手动 `removeProperty` 掉行内值再断言，等于替 bug 擦屁股 ——
 *    带 bug 也是绿的。必须 `location.reload()` 让挂载路径真的跑一遍。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5251;
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

const layout = async () => JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.uiLayout())'));
const exists = async (selector) => page.session.evaluate(`document.querySelector(${JSON.stringify(selector)}) !== null`);
const pctOf = (box, total) => (box === null ? 0 : (box.w / total) * 100);

/** 拖某个分隔条：`dx` 为水平位移（正 = 往右）。 */
async function dragSplitter(side, dx) {
  const rect = JSON.parse(
    await page.session.evaluate(`(() => {
      const el = document.querySelector('[data-v="splitter-${side}"]');
      if (!el) return JSON.stringify(null);
      const r = el.getBoundingClientRect();
      // **必须避开顶部 8px 的折叠按钮**：按钮宽 12px 而条只有 4px，
      // 点在中间偏上会落到按钮上（只折叠、不拖拽）。用条的下半部分。
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height * 0.75 });
    })()`),
  );
  if (rect === null) return;
  await page.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  for (let step = 1; step <= 8; step += 1) {
    await page.session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: rect.x + (dx * step) / 8,
      y: rect.y,
      button: 'left',
    });
    await sleep(25);
  }
  await page.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x + dx, y: rect.y, button: 'left', clickCount: 1 });
  await sleep(350);
}

async function clickToggle(side) {
  await page.session.evaluate(`document.querySelector('[data-v="splitter-toggle-${side}"]')?.click()`);
  await sleep(400);
}

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 20000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 30000);
  await sleep(2000);

  // 从默认状态开始（上一次运行可能留下了自定义宽度）
  await page.session.evaluate(`(() => {
    localStorage.removeItem('veditor:leftPct');
    localStorage.removeItem('veditor:rightPct');
    localStorage.removeItem('veditor:leftCollapsed');
    localStorage.removeItem('veditor:rightCollapsed');
    document.documentElement.style.setProperty('--v-left-w', '25%');
    document.documentElement.style.setProperty('--v-right-w', '25%');
    return true;
  })()`);
  await sleep(400);

  // ---- ① 默认 25 / 50 / 25 ----
  let now = await layout();
  const bodyW = now.left.w + now.right.w + now.stage.w;
  report.check(
    `① 默认三栏 25/50/25（左 ${pctOf(now.left, bodyW).toFixed(1)}% · 中 ${pctOf(now.stage, bodyW).toFixed(1)}% · 右 ${pctOf(now.right, bodyW).toFixed(1)}%）`,
    Math.abs(pctOf(now.left, bodyW) - 25) < 1.5 &&
      Math.abs(pctOf(now.right, bodyW) - 25) < 1.5 &&
      Math.abs(pctOf(now.stage, bodyW) - 50) < 2,
  );
  report.check(
    `① 两条分隔条都在（${await exists('[data-v="splitter-left"]')} / ${await exists('[data-v="splitter-right"]')}）`,
    (await exists('[data-v="splitter-left"]')) === true && (await exists('[data-v="splitter-right"]')) === true,
  );

  // ---- ② 拖左分隔条往右 → 左栏变宽、预览变窄 ----
  const beforeDrag = await layout();
  await dragSplitter('left', 120);
  now = await layout();
  report.check(
    `② 拖左分隔条 +120px：左栏 ${beforeDrag.left.w} → ${now.left.w}，预览 ${beforeDrag.stage.w} → ${now.stage.w}`,
    now.left.w > beforeDrag.left.w + 60 && now.stage.w < beforeDrag.stage.w - 60,
  );

  // ---- ③ 拖到极限 → clamp 到 40% ----
  await dragSplitter('left', 700);
  now = await layout();
  const maxPct = pctOf(now.left, now.left.w + now.stage.w + now.right.w);
  report.check(
    `③ 往右拖到极限 → 左栏停在 40%（实测 ${maxPct.toFixed(1)}%）`,
    Math.abs(maxPct - 40) < 1.5,
  );

  // ---- ④ 往左拖到极限 → clamp 到 15% ----
  await dragSplitter('left', -800);
  now = await layout();
  const minPct = pctOf(now.left, now.left.w + now.stage.w + now.right.w);
  report.check(
    `④ 往左拖到极限 → 左栏停在 15%（实测 ${minPct.toFixed(1)}%）`,
    Math.abs(minPct - 15) < 1.5,
  );

  // ---- ⑤ 折叠左栏：宽度 0、按钮仍在、预览变宽 ----
  const beforeCollapse = await layout();
  await clickToggle('left');
  now = await layout();
  report.check(
    `⑤ 折叠左栏：宽度 ${beforeCollapse.left.w} → ${now.left.w}`,
    now.left.w === 0,
  );
  report.check(
    `⑤b 折叠后展开按钮仍在（不会被"折叠"一起藏掉）`,
    (await exists('[data-v="splitter-toggle-left"]')) === true,
  );
  report.check(
    `⑤c 折叠后预览变宽（${beforeCollapse.stage.w} → ${now.stage.w}）`,
    now.stage.w > beforeCollapse.stage.w + 100,
  );

  // ---- ⑥ 展开左栏：恢复折叠前的宽度（不是回到 25%） ----
  await clickToggle('left');
  now = await layout();
  report.check(
    `⑥ 展开后恢复上次宽度（${now.left.w}，折叠前 ${beforeCollapse.left.w}）`,
    Math.abs(now.left.w - beforeCollapse.left.w) <= 2,
  );

  // ---- ⑦ 折叠右栏 ----
  const beforeRight = await layout();
  await clickToggle('right');
  now = await layout();
  report.check(
    `⑦ 折叠右栏：宽度 ${beforeRight.right.w} → ${now.right.w}，预览 ${beforeRight.stage.w} → ${now.stage.w}`,
    now.right.w === 0 && now.stage.w > beforeRight.stage.w + 100,
  );
  await clickToggle('right');

  // ---- ⑧ 拖右分隔条：方向相反（往左拖右栏变宽） ----
  const beforeRightDrag = await layout();
  await dragSplitter('right', -120);
  now = await layout();
  report.check(
    `⑧ 右分隔条往左拖 → 右栏变宽（${beforeRightDrag.right.w} → ${now.right.w}）`,
    now.right.w > beforeRightDrag.right.w + 60,
  );

  // ---- ⑨ 刷新后记住宽度与折叠态 ----
  const beforeReload = await layout();
  await page.session.evaluate('location.reload()');
  await sleep(2500);
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 20000);
  await sleep(1200);
  now = await layout();
  report.check(
    `⑨ 刷新后宽度保持（左 ${beforeReload.left.w} → ${now.left.w}，右 ${beforeReload.right.w} → ${now.right.w}）`,
    Math.abs(now.left.w - beforeReload.left.w) <= 2 && Math.abs(now.right.w - beforeReload.right.w) <= 2,
  );

  // ---- ⑩ 布局不重叠、不越界 ----
  report.check(
    `⑩ 三栏不重叠（左 ${now.left.x}+${now.left.w} ≤ 预览 ${now.stage.x}；预览右 ${now.stage.x + now.stage.w} ≤ 右栏 ${now.right.x}）`,
    now.left.x + now.left.w <= now.stage.x + 1 && now.stage.x + now.stage.w <= now.right.x + 1,
  );
  report.check(
    `⑩b 右栏贴右边界（${now.right.x + now.right.w} ≤ 窗口 ${now.window.w}）`,
    now.right.x + now.right.w <= now.window.w,
  );

  // ---- ⑪ 性能：布局改动没让重绘退化 ----
  const cost = Number(await page.session.evaluate('window.__VEDITOR_TEST__.renderCost(8)'));
  report.check(`⑪ 单帧重绘 ${cost.toFixed(2)}ms（数量级未回退）`, cost < 25);

  /**
   * ---- ⑫ 窄屏：没拖过时媒体查询必须生效 ----
   *
   * 这一条是**回归保险**：`applyPanelWidth` 写的是行内 `style`，
   * 而媒体查询写在 `:root` 里 —— 行内优先级更高。只要挂载时无条件写一次 25%，
   * 窄屏收窄就永远是死代码（实测过：820px 窗口下左栏仍是 205px，缩略图挤成一列）。
   *
   * **必须真的刷新一次**（不能只删行内值）：挂载时的 `useEffect` 才是出问题的那段代码，
   * 手动 `removeProperty` 等于替它擦屁股，测出来永远是绿的。
   */
  await page.session.evaluate(`(() => {
    localStorage.removeItem('veditor:leftPct');
    localStorage.removeItem('veditor:rightPct');
    localStorage.removeItem('veditor:leftCollapsed');
    localStorage.removeItem('veditor:rightCollapsed');
    return true;
  })()`);
  await page.session.send('Emulation.setDeviceMetricsOverride', {
    width: 820,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.session.evaluate('location.reload()');
  await sleep(2500);
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 20000);
  await sleep(1200);
  now = await layout();
  const narrowTotal = now.left.w + now.stage.w + now.right.w;
  report.check(
    `⑫ 820px 窄屏自动收窄到 16%（实测 ${pctOf(now.left, narrowTotal).toFixed(1)}%，窗口 ${now.window.w}）`,
    Math.abs(pctOf(now.left, narrowTotal) - 16) < 1.5 && now.window.w <= 830,
  );
  await page.session.send('Emulation.clearDeviceMetricsOverride');
} finally {
  report.summary('S1.2：三栏百分比布局 / 拖拽 / 折叠 / 记忆');
  await page.close();
  dev.kill();
  server.close();
}
