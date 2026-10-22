/**
 * S1.4 的回归测试：时间线高度百分比（默认 50%，可拖 15%–70%）。
 *
 * ## 这个文件在防什么
 *
 * 1. **50% 是"工作区"的 50%，不是"视口"的 50%** —— 顶栏 48px 不算在内。
 *    算错基准（比如按 `100vh` 算），1440×900 下会多出 24px，肉眼几乎看不出，
 *    但 `bottom: var(--v-timeline-h)` 的浮层（命令栏/toast）会全部错位。
 *    所以断言用 `timeline.h / (window.h - topbar.h)`。
 * 2. **没拖过时不能写行内变量** —— 挂载时无条件写一次 `--v-timeline-pct`，
 *    将来加"矮窗口自动收窄时间线"的媒体查询就会变成死代码（S1.2 的窄屏 bug 同款）。
 *    所以第 ⑧ 条断言的是"刷新后 `--v-timeline-pct` 行内值为空"。
 * 3. **分隔条必须真的在边界上**（stage 底 = splitter 顶 = timeline 顶 − 4），
 *    而且热区与左右栏一致（4px）。位置错 4px 看不出来，但"拖了没反应"往往就是
 *    热区被别的元素盖住了 —— 所以还要断言 `elementFromPoint` 命中的是分隔条本身。
 * 4. **业务逻辑零改动**：拖完高度后片段数不变、时间线仍能点、预览仍是 16:9。
 *
 * ## 坐标约定
 *
 * `getBoundingClientRect()` 与 `uiLayout()` 都是 **CSS 像素**，不要乘除 DPR。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5255;
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
/** 时间线占"工作区"（视口 − 顶栏）的百分比。 */
const pctOf = (now) => (now.timeline === null || now.topbar === null ? 0 : (now.timeline.h / (now.window.h - now.topbar.h)) * 100);
const inlinePct = async () =>
  page.session.evaluate("document.documentElement.style.getPropertyValue('--v-timeline-pct')");

/** 拖时间线分隔条：`dy` 为垂直位移（负 = 往上拖 = 时间线变高）。 */
async function dragSplitter(dy) {
  const rect = JSON.parse(
    await page.session.evaluate(`(() => {
      const el = document.querySelector('[data-v="splitter-timeline"]');
      if (!el) return JSON.stringify(null);
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.left + r.width * 0.5, y: r.top + r.height * 0.5 });
    })()`),
  );
  if (rect === null) return;
  await page.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  for (let step = 1; step <= 8; step += 1) {
    await page.session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: rect.x,
      y: rect.y + (dy * step) / 8,
      button: 'left',
    });
    await sleep(25);
  }
  await page.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y + dy, button: 'left', clickCount: 1 });
  await sleep(350);
}

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 20000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 30000);
  await sleep(2000);

  // 从默认态开始（上一次运行可能留下自定义高度）
  await page.session.evaluate(`(() => {
    localStorage.removeItem('veditor:timelinePct');
    localStorage.removeItem('veditor:leftPct');
    localStorage.removeItem('veditor:rightPct');
    localStorage.removeItem('veditor:leftCollapsed');
    localStorage.removeItem('veditor:rightCollapsed');
    return true;
  })()`);
  await page.session.evaluate('location.reload()');
  await sleep(2500);
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 20000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 30000);
  await sleep(1500);

  // ---- ① 默认 50%（基准是工作区，不是视口）----
  let now = await layout();
  const clipsBefore = Number(await page.session.evaluate('window.__VEDITOR_TEST__.clips().length'));
  report.check(
    `① 默认时间线占工作区 50%（时间线 ${now.timeline?.h} / 工作区 ${now.topbar === null ? '?' : now.window.h - now.topbar.h} = ${pctOf(now).toFixed(1)}%）`,
    Math.abs(pctOf(now) - 50) < 1.5,
  );
  report.check(
    `①b 顶栏 48 不算进去（时间线 ${now.timeline?.h} + 顶栏 ${now.topbar?.h} + 分隔条 4 + 预览区 = 视口 ${now.window.h}）`,
    now.timeline !== null &&
      now.topbar !== null &&
      Math.abs(now.timeline.h + now.timeline.y - now.window.h) <= 1,
  );

  // ---- ② 分隔条位置：正好在边界上、4px 热区、横轴语义 ----
  const splitter = JSON.parse(
    await page.session.evaluate(`(() => {
      const el = document.querySelector('[data-v="splitter-timeline"]');
      if (!el) return JSON.stringify(null);
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return JSON.stringify({
        top: Math.round(r.top),
        h: Math.round(r.height),
        w: Math.round(r.width),
        cursor: getComputedStyle(el).cursor,
        orientation: el.getAttribute('aria-orientation'),
        hitSelf: hit === el || el.contains(hit),
        hasToggle: document.querySelector('[data-v="splitter-toggle-timeline"]') !== null,
      });
    })()`),
  );
  report.check(
    `② 分隔条 4px、全宽（${splitter?.w}×${splitter?.h}）`,
    splitter !== null && splitter.h === 4 && splitter.w === now.window.w,
  );
  report.check(
    `②b 正好压在预览区与时间线之间（分隔条顶 ${splitter?.top} = 预览底 ${now.stage === null ? '?' : now.stage.y + now.stage.h}）`,
    splitter !== null && now.stage !== null && Math.abs(splitter.top - (now.stage.y + now.stage.h)) <= 1,
  );
  report.check(
    `②c 横轴语义与热区可命中（cursor=${splitter?.cursor} · orientation=${splitter?.orientation} · elementFromPoint 命中自身=${splitter?.hitSelf}）`,
    splitter?.cursor === 'row-resize' && splitter?.orientation === 'horizontal' && splitter?.hitSelf === true,
  );
  report.check('②d 时间线没有折叠按钮（高度归零后没有替代入口）', splitter?.hasToggle === false);

  // ---- ③ 往上拖 → 时间线变高、预览变矮 ----
  const before = await layout();
  await dragSplitter(-120);
  now = await layout();
  report.check(
    `③ 往上拖 120px：时间线 ${before.timeline?.h} → ${now.timeline?.h}，预览区 ${before.stage?.h} → ${now.stage?.h}`,
    now.timeline !== null && before.timeline !== null && now.timeline.h > before.timeline.h + 80 &&
      now.stage !== null && before.stage !== null && now.stage.h < before.stage.h - 80,
  );

  // ---- ④ 拖到极限（上）→ clamp 70% ----
  await dragSplitter(-800);
  now = await layout();
  report.check(
    `④ 往上拖到极限 → 停在 70%（实测 ${pctOf(now).toFixed(1)}%）`,
    Math.abs(pctOf(now) - 70) < 1.5,
  );

  // ---- ⑤ 拖到极限（下）→ clamp 15% ----
  await dragSplitter(900);
  now = await layout();
  report.check(
    `⑤ 往下拖到极限 → 停在 15%（实测 ${pctOf(now).toFixed(1)}%）`,
    Math.abs(pctOf(now) - 15) < 1.5,
  );
  report.check(
    `⑤b 15% 时时间线仍可用（工具栏/标尺/画布都在，高度 ${now.timeline?.h}）`,
    now.timeline !== null && now.timeline.h > 80 && (await page.session.evaluate('!!document.querySelector(\'[data-v="timeline-canvas"]\')')),
  );

  // ---- ⑥ 拖到中间值 → 刷新后保持 ----
  await dragSplitter(-100);
  const beforeReload = await layout();
  const storedRaw = await page.session.evaluate("localStorage.getItem('veditor:timelinePct')");
  report.check(
    `⑥ 松手后写入 localStorage（${storedRaw}，实测 ${pctOf(beforeReload).toFixed(1)}%）`,
    storedRaw !== null && Math.abs(Number(storedRaw) - pctOf(beforeReload)) < 1.5,
  );
  await page.session.evaluate('location.reload()');
  await sleep(2500);
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 20000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 30000);
  await sleep(1200);
  now = await layout();
  report.check(
    `⑥b 刷新后高度保持（${pctOf(now).toFixed(1)}%，刷新前 ${pctOf(beforeReload).toFixed(1)}%）`,
    Math.abs(now.timeline.h - beforeReload.timeline.h) <= 2,
  );

  // ---- ⑦ 业务逻辑零改动：片段数不变、预览仍 16:9 ----
  const clipsAfter = Number(await page.session.evaluate('window.__VEDITOR_TEST__.clips().length'));
  report.check(
    `⑦ 拖高度不影响文档（片段 ${clipsBefore} → ${clipsAfter}）`,
    clipsBefore === clipsAfter && clipsAfter > 0,
  );
  const ratio = Number(
    await page.session.evaluate(`(() => {
      const el = document.querySelector('[data-v="preview-canvas"]');
      if (!el) return 0;
      const r = el.getBoundingClientRect();
      return r.height === 0 ? 0 : r.width / r.height;
    })()`),
  );
  report.check(`⑦b 预览画布仍是 16:9（${ratio.toFixed(3)}）`, Math.abs(ratio - 16 / 9) < 0.05);

  // ---- ⑧ 没拖过时**不能**写行内变量（否则将来的媒体查询会变成死代码）----
  await page.session.evaluate("localStorage.removeItem('veditor:timelinePct')");
  await page.session.evaluate('location.reload()');
  await sleep(2500);
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 20000);
  await sleep(1200);
  now = await layout();
  report.check(
    `⑧ 清掉记忆后回到 50%，且根节点没有行内 --v-timeline-pct（实测「${await inlinePct()}」）`,
    Math.abs(pctOf(now) - 50) < 1.5 && (await inlinePct()) === '',
  );

  // ---- ⑨ 时间线仍可交互（点标尺定位播放头）----
  const seek = JSON.parse(
    await page.session.evaluate(`(() => {
      const el = document.querySelector('[data-v="timeline-canvas"]');
      if (!el) return JSON.stringify(null);
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.left + 260, y: r.top + 10 });
    })()`),
  );
  if (seek !== null) {
    await page.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: seek.x, y: seek.y, button: 'left', clickCount: 1 });
    await page.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: seek.x, y: seek.y, button: 'left', clickCount: 1 });
    await sleep(300);
  }
  const playhead = Number(await page.session.evaluate('window.__VEDITOR_TEST__.playheadFrame()'));
  report.check(`⑨ 点标尺仍能定位播放头（frame=${playhead}）`, playhead > 0);
} finally {
  report.summary('S1.4：时间线高度 50%（15%–70% 可拖）');
  await page.close();
  dev.kill();
  server.close();
}
