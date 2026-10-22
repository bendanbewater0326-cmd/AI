/**
 * S1.5 的回归测试：预览控制栏叠在画面底部居中（不再独占一行）。
 *
 * ## 这个文件在防什么
 *
 * 1. **"叠在画面上" ≠ "浮在整个预览区底部"**：如果控制栏挂在 `.v-stage`（整块舞台）
 *    而不是 `.v-stage__screen`（16:9 画面），画面留黑边时它会漂到黑边上，
 *    看起来像"贴在面板底边"。所以断言是"bar 完全落在 preview 盒子里"。
 * 2. **必须真的不占布局高度**：只把 `position: absolute` 写上、忘了删
 *    `grid-template-rows` 的第二行，控制栏会既叠着又占 36px —— 预览反而没变大。
 *    所以断言 `viewport.h === stage.h`（舞台里只剩一行）。
 * 3. **透明度是"移出变淡、移入变实"**：只在 CSS 里写 `opacity: .55` 而不写 `:hover`
 *    恢复，用户会以为按钮被禁用了。这条必须用鼠标真的移进移出来测。
 * 4. **控件一个都不能少**：播放 / 上一帧 / 下一帧 / 时间码 / 音量，
 *    而且逐帧按钮要真的改播放头（不是画了个图标）。
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
const PORT = 5257;
/**
 * **必须用无音轨素材**。
 *
 * 有音轨的文件（如 `sample-720p.mp4`）在无头浏览器里会让播放头**纹丝不动**：
 * `play()` 选了音频时钟（`audioUsable` 为真），但 AudioContext 在无头里不推进，
 * `derivedFrame()` 永远算回 anchor 帧 —— 实测 aria-pressed 变 true、frame 2 → 2。
 * 这不是 S1.5 的问题（换静音素材立刻 2 → 62），但会让人误以为"播放键坏了"。
 */
const FIXTURE = 'silent-720p.mp4';
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
const playhead = async () => Number(await page.session.evaluate('window.__VEDITOR_TEST__.playheadFrame()'));
const opacity = async () => Number(await page.session.evaluate("Number(getComputedStyle(document.querySelector('[data-v=\"ctrlbar\"]')).opacity)"));
/** 读控制栏与画面盒子的几何 + 视觉样式。 */
const geom = async () =>
  JSON.parse(
    await page.session.evaluate(`(() => {
      const bar = document.querySelector('[data-v="ctrlbar"]');
      const screen = document.querySelector('[data-v="preview"]');
      const viewport = document.querySelector('.v-stage__viewport');
      if (!bar || !screen || !viewport) return JSON.stringify(null);
      const b = bar.getBoundingClientRect();
      const s = screen.getBoundingClientRect();
      const v = viewport.getBoundingClientRect();
      const cs = getComputedStyle(bar);
      const round = (n) => Math.round(n);
      return JSON.stringify({
        bar: { x: round(b.left), y: round(b.top), w: round(b.width), h: round(b.height), bottom: round(b.bottom) },
        screen: { x: round(s.left), y: round(s.top), w: round(s.width), h: round(s.height), bottom: round(s.bottom) },
        viewport: { x: round(v.left), y: round(v.top), w: round(v.width), h: round(v.height) },
        inside: b.top >= s.top - 1 && b.bottom <= s.bottom + 1 && b.left >= s.left - 1 && b.right <= s.right + 1,
        centered: Math.abs((b.left + b.width / 2) - (s.left + s.width / 2)) <= 1,
        bottomGap: round(s.bottom - b.bottom),
        position: cs.position,
        radius: cs.borderTopLeftRadius,
        bg: cs.backgroundColor,
        backdrop: cs.backdropFilter || cs.webkitBackdropFilter || 'none',
      });
    })()`),
  );

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 20000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 30000);
  await sleep(2000);

  // 回到默认布局（上一次运行可能拖过时间线高度）
  await page.session.evaluate(`(() => {
    localStorage.removeItem('veditor:timelinePct');
    localStorage.removeItem('veditor:leftPct');
    localStorage.removeItem('veditor:rightPct');
    return true;
  })()`);
  await page.session.evaluate('location.reload()');
  await sleep(2500);
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 20000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 30000);
  await sleep(1500);

  const g = await geom();

  // ---- ① 叠在"画面"里（不是舞台底部）----
  report.check(
    `① 控制栏完全落在预览画面内（bar ${g?.bar.y}..${g?.bar.bottom} ⊂ screen ${g?.screen.y}..${g?.screen.bottom}）`,
    g !== null && g.inside === true,
  );
  report.check(
    `①b 水平居中（bar 中心与画面中心差 ≤1px）`,
    g !== null && g.centered === true,
  );
  report.check(
    `①c 距画面底 12px（实测 ${g?.bottomGap}）`,
    g !== null && Math.abs(g.bottomGap - 12) <= 2,
  );

  // ---- ② 不再占布局高度：舞台里只剩一行 ----
  let now = await layout();
  report.check(
    `② 舞台只剩一行（舞台高 ${now.stage?.h} = 视口高 ${g?.viewport.h}）`,
    now.stage !== null && g !== null && Math.abs(now.stage.h - g.viewport.h) <= 1,
  );
  report.check(
    `②b 控制栏是绝对定位（${g?.position}）`,
    g?.position === 'absolute',
  );

  // ---- ③ 视觉：半透明黑 + 圆角 + 背景模糊 ----
  report.check(
    `③ 默认半透明（opacity=${await opacity()}，bg=${g?.bg}，radius=${g?.radius}）`,
    Math.abs((await opacity()) - 0.55) <= 0.06 && /rgba\(0, 0, 0, 0\.\d+\)/.test(g?.bg ?? '') && g?.radius === '8px',
  );

  // ---- ④ 悬停画面 → 变实；移出 → 变淡 ----
  await page.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: g.screen.x + g.screen.w / 2,
    y: g.screen.y + Math.round(g.screen.h * 0.3),
  });
  await sleep(400);
  const hoverOpacity = await opacity();
  await page.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: now.timeline.x + 300,
    y: now.timeline.y + 120,
  });
  await sleep(500);
  const idleOpacity = await opacity();
  report.check(
    `④ 鼠标移入画面变实、移出变淡（${hoverOpacity} → ${idleOpacity}）`,
    hoverOpacity >= 0.99 && Math.abs(idleOpacity - 0.55) <= 0.06,
  );

  // ---- ⑤ 五个控件都在 ----
  const controls = JSON.parse(
    await page.session.evaluate(`(() => {
      const has = (sel) => document.querySelector(sel) !== null;
      const bar = document.querySelector('[data-v="ctrlbar"]');
      return JSON.stringify({
        prev: has('[data-v="frame-prev"]'),
        play: has('[data-v="play-toggle"]'),
        next: has('[data-v="frame-next"]'),
        timecode: (bar?.querySelector('.v-ctrlbar__timecode')?.textContent || '').trim().length > 0,
        volume: has('[data-v="preview-volume"]'),
      });
    })()`),
  );
  report.check(
    `⑤ 控件齐全（上一帧/播放/下一帧/时间码/音量：${Object.entries(controls).map(([k, v]) => `${k}=${v}`).join(' ')}）`,
    Object.values(controls).every((value) => value === true),
  );

  // ---- ⑥ 逐帧按钮真的改播放头 ----
  await page.session.evaluate("document.querySelector('[data-v=\"frame-prev\"]').click()");
  await sleep(200);
  const atZero = await playhead();
  await page.session.evaluate("document.querySelector('[data-v=\"frame-next\"]').click()");
  await sleep(250);
  await page.session.evaluate("document.querySelector('[data-v=\"frame-next\"]').click()");
  await sleep(250);
  const afterNext = await playhead();
  report.check(
    `⑥ 上一帧夹到 0（${atZero}），连点两次下一帧 → ${afterNext}（期望 2）`,
    atZero === 0 && afterNext === 2,
  );

  // ---- ⑦ 播放键：用**真实鼠标点击**（不是 DOM .click()）----
  /**
   * 为什么必须走 `Input.dispatchMouseEvent`：
   *
   * 1. 控制栏现在叠在画面上，**必须证明它没被 canvas 盖住** ——
   *    `element.click()` 绕过命中测试，就算被盖住也是绿的；
   * 2. `element.click()` 不是可信用户手势，AudioContext 无法 resume，
   *    音频时钟不走 → 播放头不推进（实测：aria-pressed 变 true 但 frame 纹丝不动）。
   */
  const playRect = JSON.parse(
    await page.session.evaluate(`(() => {
      const el = document.querySelector('[data-v="play-toggle"]');
      if (!el) return JSON.stringify(null);
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return JSON.stringify({
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        hitSelf: hit === el || el.contains(hit),
      });
    })()`),
  );
  report.check('⑦a 播放键没被画面/其它元素盖住（elementFromPoint 命中自身）', playRect?.hitSelf === true);
  const beforePlay = await playhead();
  await page.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: playRect.x, y: playRect.y, button: 'left', clickCount: 1 });
  await page.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: playRect.x, y: playRect.y, button: 'left', clickCount: 1 });
  await sleep(2000);
  const pressed = await page.session.evaluate("document.querySelector('[data-v=\"play-toggle\"]').getAttribute('aria-pressed')");
  const duringPlay = await playhead();
  await page.session.evaluate("document.querySelector('[data-v=\"play-toggle\"]').click()");
  await sleep(200);
  report.check(
    `⑦b 播放键生效（aria-pressed=${pressed}，播放头 ${beforePlay} → ${duringPlay}）`,
    pressed === 'true' && duringPlay > beforePlay,
  );

  // ---- ⑧ 音量滑块仍在且真的生效 ----
  const volumeChanged = await page.session.evaluate(`(() => {
    const input = document.querySelector('[data-v="preview-volume"]');
    if (!input) return false;
    const before = document.querySelector('[data-v="preview-volume-percent"]')?.textContent ?? '';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '0.5');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const after = document.querySelector('[data-v="preview-volume-percent"]')?.textContent ?? '';
    return before !== after;
  })()`);
  report.check('⑧ 音量滑块仍在且改值后百分比变化', volumeChanged === true);

  // ---- ⑨ 只压住画面底部，不挡主体 ----
  report.check(
    `⑨ 控制栏只占画面底部（顶边 ${g?.bar.y} > 画面 60% 线 ${Math.round(g.screen.y + g.screen.h * 0.6)}）`,
    g !== null && g.bar.y > g.screen.y + g.screen.h * 0.6,
  );

  // ---- ⑩ 820px 窄屏：条不溢出画面 ----
  await page.session.send('Emulation.setDeviceMetricsOverride', {
    width: 820,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(600);
  const narrow = await geom();
  report.check(
    `⑩ 820px 下控制栏不溢出画面（bar ${narrow?.bar.w} ≤ screen ${narrow?.screen.w}，且仍在画面内）`,
    narrow !== null && narrow.bar.w <= narrow.screen.w && narrow.inside === true,
  );
  await page.session.send('Emulation.clearDeviceMetricsOverride');
  await sleep(300);
} finally {
  report.summary('S1.5：控制栏叠在画面底部居中');
  await page.close();
  dev.kill();
  server.close();
}
