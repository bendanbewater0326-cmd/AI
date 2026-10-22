/**
 * 画面旋转 / 翻转的端到端验证（`docs/nle-baseline.md` §6）。
 *
 * ## 为什么用"黑边"而不是"内容比对"
 *
 * 旋转这类变换，最容易被写成的错法是**把旋转后的画面拉伸回原画幅**——
 * 看起来"转成功了"，其实人脸横向拉长 1.78 倍。这种错法用"内容相似度"很难抓，
 * 但用**黑边**一眼就能抓：16:9 的片段转 90° 之后必须是 9:16 贴满高度、左右留黑；
 * 若左右不黑，说明它被拉伸填满了。
 *
 * 这条断言与素材内容无关，换任何素材都成立。
 *
 * ## 覆盖
 *
 *   ① 转 90° → 左右变黑、中间仍是画面（= 真的转了，且没拉伸）
 *   ② 连点四次右转 → 回到 0°（**功能不是一次性的**，用户 2026-10-22 的明确要求）
 *   ③ 水平翻转 → 状态 + 按钮 aria-pressed + 再点一次取消
 *   ④ 还原画面：旋转/翻转/缩放一次复位（一个撤销步），Ctrl+Z 能整批回来
 *
 * 运行：`node tests/verify-transform.mjs`
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5225;
const FIXTURE = 'plain-1080p.mp4';

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

/** 采样一块区域，返回"非黑像素占比"。 */
async function region(region) {
  const stats = await page.session.evaluate(
    `window.__VEDITOR_TEST__.previewSnapshot(${JSON.stringify(region)})`,
  );
  if (stats === null) return null;
  return {
    filled: stats.total === 0 ? 0 : stats.nonBlack / stats.total,
    mean: stats.meanLuma,
  };
}

const LEFT = { x: 0, y: 0.4, w: 0.08, h: 0.2 };
const RIGHT = { x: 0.92, y: 0.4, w: 0.08, h: 0.2 };
const CENTER = { x: 0.45, y: 0.4, w: 0.1, h: 0.2 };
const TOP = { x: 0.4, y: 0.02, w: 0.2, h: 0.08 };

async function transformOf() {
  return JSON.parse(
    await page.session.evaluate(`JSON.stringify(window.__VEDITOR_TEST__.clips()[0].transform)`),
  );
}

/** 点属性栏的按钮（真实指针事件，不是 element.click()）。 */
async function clickInspector(name) {
  const rect = JSON.parse(
    await page.session.evaluate(`(() => {
      const button = document.querySelector('[data-v="${name}"]');
      if (button === null) return JSON.stringify({ x: -1, y: -1 });
      const box = button.getBoundingClientRect();
      return JSON.stringify({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
    })()`),
  );
  if (rect.x < 0) throw new Error(`找不到按钮 ${name}`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.session.send('Input.dispatchMouseEvent', {
      type,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: 1,
    });
  }
  await sleep(420);
}

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 15000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 25000);
  await sleep(1200);

  // 选中片段（属性栏才有内容）——用测试钩子选中，坐标点击在窄轨上不稳
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(window.__VEDITOR_TEST__.clips()[0].id)`);
  await page.session.waitFor(`!!document.querySelector('[data-v="inspector-rotate-right"]')`, 5000);
  await sleep(400);

  // ---- 基线：16:9 素材在 16:9 工程里应该铺满（左右都不黑） ----
  const baseLeft = await region(LEFT);
  const baseCenter = await region(CENTER);
  report.check(
    `① 基线：左右都出画（左 ${baseLeft?.filled.toFixed(3)} / 中 ${baseCenter?.filled.toFixed(3)}）`,
    baseLeft !== null && baseLeft.filled > 0.5 && baseCenter !== null && baseCenter.filled > 0.5,
  );

  // ---- ① 右转 90° ----
  await clickInspector('inspector-rotate-right');
  const afterRotate = await transformOf();
  report.check(`① 右转后 rotation=${afterRotate.rotation}（期望 90）`, afterRotate.rotation === 90);

  const rotLeft = await region(LEFT);
  const rotRight = await region(RIGHT);
  const rotCenter = await region(CENTER);
  const rotTop = await region(TOP);
  report.check(
    `① 转 90° 后左右留黑（左 ${rotLeft?.filled.toFixed(3)} / 右 ${rotRight?.filled.toFixed(3)}）`,
    rotLeft !== null && rotLeft.filled < 0.05 && rotRight !== null && rotRight.filled < 0.05,
  );
  report.check(
    `① 中间与顶部仍是画面（中 ${rotCenter?.filled.toFixed(3)} / 顶 ${rotTop?.filled.toFixed(3)}）`,
    rotCenter !== null && rotCenter.filled > 0.5 && rotTop !== null && rotTop.filled > 0.5,
  );
  report.check(
    `① 画面**没被拉伸**（左右黑 → 9:16 贴满高度，而不是拉回 16:9 填满）`,
    rotLeft !== null && rotLeft.filled < 0.05 && rotCenter !== null && rotCenter.filled > 0.5,
  );

  // ---- ② 连点四次右转 → 回到 0°（功能不是一次性的） ----
  for (let i = 0; i < 3; i += 1) await clickInspector('inspector-rotate-right');
  const fullTurn = await transformOf();
  const backLeft = await region(LEFT);
  report.check(
    `② 连点四次右转 → rotation=${fullTurn.rotation}（期望 0，说明不是一次性）`,
    fullTurn.rotation === 0,
  );
  report.check(
    `② 转满一圈后画面恢复铺满（左 ${backLeft?.filled.toFixed(3)}）`,
    backLeft !== null && backLeft.filled > 0.5,
  );

  // ---- ③ 水平翻转 ----
  const beforeFlipLeft = await region(LEFT);
  const beforeFlipRight = await region(RIGHT);
  await clickInspector('inspector-flip-x');
  const flipped = await transformOf();
  const pressed = await page.session.evaluate(
    `document.querySelector('[data-v="inspector-flip-x"]').getAttribute('aria-pressed')`,
  );
  const afterFlipLeft = await region(LEFT);
  const afterFlipRight = await region(RIGHT);
  report.check(
    `③ 水平翻转后 flipX=${flipped.flipX}，按钮 aria-pressed=${pressed}`,
    flipped.flipX === true && pressed === 'true',
  );
  // 左右区域互换（素材左右近似对称时这条偏弱，但仍然能抓"完全没翻"）
  const swapped =
    beforeFlipLeft !== null &&
    beforeFlipRight !== null &&
    afterFlipLeft !== null &&
    afterFlipRight !== null &&
    Math.abs(afterFlipLeft.mean - beforeFlipRight.mean) < 6 &&
    Math.abs(afterFlipRight.mean - beforeFlipLeft.mean) < 6;
  report.check(
    `③ 翻转后左右互换（左 ${beforeFlipLeft?.mean.toFixed(1)}→${afterFlipLeft?.mean.toFixed(1)}，右 ${beforeFlipRight?.mean.toFixed(1)}→${afterFlipRight?.mean.toFixed(1)}）`,
    swapped,
  );

  await clickInspector('inspector-flip-x');
  const unflipped = await transformOf();
  report.check(`③ 再点一次取消翻转（flipX=${unflipped.flipX}）`, unflipped.flipX === false);

  // ---- ④ 还原画面：一个撤销步 ----
  await clickInspector('inspector-rotate-right');
  await clickInspector('inspector-flip-y');
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(window.__VEDITOR_TEST__.clips()[0].id)`);
  const dirty = await transformOf();
  report.check(
    `④ 弄乱后 rotation=${dirty.rotation} flipY=${dirty.flipY}`,
    dirty.rotation === 90 && dirty.flipY === true,
  );
  await clickInspector('inspector-frame-reset');
  const reset = await transformOf();
  report.check(
    `④ 还原画面 → rotation=${reset.rotation} flipX=${reset.flipX} flipY=${reset.flipY} scale=${reset.scale}`,
    reset.rotation === 0 && reset.flipX === false && reset.flipY === false && reset.scale === 1,
  );

  await page.session.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2,
  });
  await page.session.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2,
  });
  await sleep(500);
  const undone = await transformOf();
  report.check(
    `④ 一次撤销把旋转+翻转一起回退（rotation=${undone.rotation} flipY=${undone.flipY}）`,
    undone.rotation === 90 && undone.flipY === true,
  );

  const errors = JSON.parse(
    await page.session.evaluate(`JSON.stringify(window.__VEDITOR_TEST__.errors())`),
  );
  report.check(`⑤ 全程无错误条（${JSON.stringify(errors)}）`, errors.length === 0);

  report.summary('画面旋转 / 翻转');
} finally {
  await page.close();
  dev.kill();
  await fixture.close();
}
