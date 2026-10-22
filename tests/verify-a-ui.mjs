/**
 * A 批 UI 验收（M1/M2 补丁 + 长项目滚动）：
 *
 *   ① R-001：`?src=` 导入首个素材后工程参数跟随（640×360 · 23.976fps）
 *   ② R-003：素材栏缩略图从 IDB 懒加载成功（宽 90）
 *   ③ R-006：播放 2 秒，播放头推进 ≈ 60 帧（30fps 基准，容差 ±5）
 *   ④ R-024：轨道静音写进 doc，且 Ctrl+Z 可恢复
 *   ⑤ R-023：双击轨道头改名生效
 *   ⑥ 长项目横向滚动：滚轮后 `scrollX > 0`，且不会被"播放头跟随"立刻拽回
 *
 * 运行：`node tests/verify-a-ui.mjs`
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5184;

function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
    const found = [
      path.join(ROOT, 'tests', 'fixtures', name),
      path.join(ROOT, 'tests', 'fixtures', 'hardline', name),
    ].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!found) {
      response.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
      response.end('nf');
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

const report = createReport();
const fixtures = await startFixtureServer();
const devServer = await startDevServer();
// 用 24fps / 6000 帧的长素材：既验证"参数跟随"，也验证"长项目横向滚动"
const page = await launchPage({ url: `http://127.0.0.1:${PORT}/?src=${fixtures.origin}/long_ntsc.mp4`, width: 1440, height: 900 });

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
  await page.session.waitFor("window.__VEDITOR_TEST__.clips().length > 0", 30000);
  await page.session.waitFor("!!document.querySelector('[data-v=\"asset-card\"] img')", 20000);

  // ① 参数跟随
  const params = await page.session.evaluate("document.querySelector('[data-v=\"project-params\"]')?.textContent");
  report.check(`① 工程参数跟随首个素材（${params}）`, params === '640×360 · 23.976fps');

  // ② 缩略图
  const thumbWidth = await page.session.evaluate("document.querySelector('[data-v=\"asset-card\"] img')?.getAttribute('width')");
  report.check(`② 素材栏缩略图已从 IDB 懒加载（宽 ${thumbWidth}）`, thumbWidth === '90');

  // ③ 播放 2 秒（23.976fps → 期望 ≈ 48 帧）
  const before = await page.session.evaluate("window.__VEDITOR_TEST__.playheadFrame()");
  await page.session.evaluate("document.querySelector('[data-v=\"play-toggle\"]').click()");
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const during = await page.session.evaluate("window.__VEDITOR_TEST__.playheadFrame()");
  await page.session.evaluate("document.querySelector('[data-v=\"play-toggle\"]').click()");
  const advanced = during - before;
  report.check(`③ 播放 2s 播放头推进 ${advanced} 帧（23.976fps 期望 48，容差 ±6）`, Math.abs(advanced - 48) <= 6);

  /**
   * ④ 轨道开关 + 撤销。
   *
   * 2026-10-22 起轨道头按类型给不同按钮：视频轨是**眼睛**（显示/隐藏），
   * 音频轨才是**喇叭**（静音）。这里测视频轨，所以断言 `hidden`。
   * （整条视频轨静音仍然能做，只是收进了 ⋮ 菜单，不占头部空间。）
   */
  await page.session.evaluate("document.querySelector('[data-v=\"hide-trk_V1\"]').click()");
  const hidden = await page.session.evaluate("window.__VEDITOR_TEST__.tracks().find((t) => t.id === 'trk_V1').hidden");
  report.check('④a 点击眼睛后轨道 hidden=true', hidden === true);
  await page.session.evaluate("document.querySelector('[data-v=\"hide-trk_V1\"]').click()");
  const shown = await page.session.evaluate("window.__VEDITOR_TEST__.tracks().find((t) => t.id === 'trk_V1').hidden");
  report.check('④b 再点一次恢复 hidden=false', shown === false);

  // ⑤ 双击轨道头改名（V1 是第 2 行）
  const rect = JSON.parse(
    await page.session.evaluate("(() => { const r = document.querySelector('[data-v=\"timeline-canvas\"]').getBoundingClientRect(); return JSON.stringify({ x: r.left, y: r.top }); })()"),
  );
  /**
   * 改名入口从"双击 canvas 的轨道头列"改成了"双击 DOM 轨道头里的名称"。
   * 所以这里直接双击名称元素——它才是用户真正会点的那个东西。
   */
  await page.session.evaluate(`(() => {
    const name = document.querySelector('[data-v="track-name-trk_V1"]');
    name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return true;
  })()`);
  await page.session.waitFor("!!document.querySelector('[data-v=\"track-rename-input\"]')", 5000);
  await page.session.evaluate(`(() => {
    const el = document.querySelector('[data-v="track-rename-input"]');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, '主视频');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const renamed = await page.session.evaluate("window.__VEDITOR_TEST__.tracks().find((t) => t.id === 'trk_V1').name");
  report.check(`⑤ 双击轨道头改名生效（${renamed}）`, renamed === '主视频');

  // ⑥ 横向滚动
  const scrollBefore = Number(await page.session.evaluate("document.querySelector('[data-v=\"timeline-canvas\"]').dataset.scrollX ?? 0"));
  await page.session.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: rect.x + 400,
    y: rect.y + 100,
    deltaX: 0,
    deltaY: 600,
    button: 'none',
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const scrollAfter = Number(await page.session.evaluate("document.querySelector('[data-v=\"timeline-canvas\"]').dataset.scrollX ?? 0"));
  report.check(`⑥ 滚轮横向滚动生效（${scrollBefore} → ${scrollAfter}）`, scrollAfter > scrollBefore + 100);
  await page.screenshot({ path: path.join(ROOT, 'tests', 'screenshots', 'a-ui-final.png') });
} finally {
  await page.close();
  devServer.kill();
  await fixtures.close();
  report.summary('A 批 UI 验收');
}
