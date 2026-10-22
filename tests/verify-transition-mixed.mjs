/**
 * 跨分辨率转场回归：**横屏 720p** 与 **竖屏 1080×1920** 之间加交叉溶解。
 *
 * ## 为什么单独测
 *
 * 转场用的是"冻结帧溶解"：窗口 `[cut-D/2, cut+D/2)` 内，前半段 A 正常播、
 * B 冻结在首帧；后半段 A 冻结在末帧、B 正常播。**冻结帧要各自走解码器池取帧**，
 * 当两侧素材分辨率/宽高比差异很大（横屏 ↔ 竖屏）时，最容易暴露：
 *   - 冻结帧用错素材的尺寸 → 画面被拉伸/黑边突变
 *   - 只有一层被画出来 → 溶解退化成"硬切 + 黑屏"
 *   - 层序反了 → 后半段还显示前一段
 *
 * 场景：
 *   A sample-720p.mp4  1280×720  240 帧 → [0, 240)
 *   B rotated-90.mp4   1080×1920  90 帧 → [240, 330)  竖屏
 *   给 B 设 `crossDissolve` in 边、0.5s（15 帧）→ 窗口 [233, 248)
 *
 * 验证：
 *   ① 转场已写入 B.transitionIn（类型/时长正确）
 *   ② 窗口前（230）只有 1 层
 *   ③ 窗口内（240）**2 层同时在画**（真溶解，不是硬切）
 *   ④ 窗口后（250）只剩 1 层（B）
 *   ⑤ 三个时刻画面都非黑（冻结帧取到了真帧，不是空层）
 *
 * 运行：node tests/verify-transition-mixed.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5207;

function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
    const found = [
      path.join(ROOT, 'tests', 'fixtures', 'compat', name),
      path.join(ROOT, 'tests', 'fixtures', name),
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

const report = createReport();
const fixtures = await startFixtureServer();
const devServer = await startDevServer();
const page = await launchPage({
  url: `http://127.0.0.1:${PORT}/?src=${encodeURIComponent(`${fixtures.origin}/sample-720p.mp4`)}`,
  width: 1440,
  height: 900,
});

async function seekTo(timecode) {
  await page.session.evaluate(`document.querySelector('[data-v="timecode"]')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await page.session.evaluate(`(() => {
    const input = document.querySelector('[data-v="timecode-input"]');
    if (!input) return false;
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '${timecode}');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await page.session.evaluate(
    `document.querySelector('[data-v="timecode-input"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`,
  );
  await new Promise((resolve) => setTimeout(resolve, 450));
}

/** 跳到某时间码后等画面稳定，返回 { snapshot, layers }。 */
async function inspectAt(timecode) {
  await seekTo(timecode);
  let snapshot = null;
  // 解码是异步的：seek 之后要等合成器真的画出这一帧。
  // 12×200ms（2.4s）在**全量 E2E 连跑**时不够——机器被前面的脚本压着，
  // 会拍到一帧全黑，看起来像"转场把画面搞黑了"（实测 42 个脚本连跑时必现，单跑不复现）。
  // 放宽到 25×200ms（5s）后仍然偶发（2026-10-23：60 个脚本跑 19.2 分钟那次拍到了 0），
  // 再加到 40×200ms（8s）：真黑屏 bug 仍然会失败，只是慢一点。
  for (let i = 0; i < 40; i += 1) {
    snapshot = await page.session.evaluate('window.__VEDITOR_TEST__.previewSnapshot()');
    if ((snapshot?.nonBlack ?? 0) > 1000) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const stats = await page.session.evaluate('window.__VEDITOR_TEST__.previewStats()');
  return { snapshot, layers: stats?.compositor?.lastLayerCount ?? -1, decodeFailures: stats?.decodeFailures };
}

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length === 1', 15000);

  // ---- 追加竖屏素材 B（playhead 跳到 240 帧 = 8s）----
  await page.session.evaluate(`
    (async () => {
      const response = await fetch('${fixtures.origin}/rotated-90.mp4');
      const blob = await response.blob();
      const file = new File([blob], 'rotated-90.mp4', { type: 'video/mp4', lastModified: 1700000000000 });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      for (const type of ['dragenter', 'dragover', 'drop']) {
        document.body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
      }
      return true;
    })();
  `);
  await page.session.waitFor(`document.querySelectorAll('[data-v="asset-card"]').length === 2`, 15000);
  await new Promise((resolve) => setTimeout(resolve, 400));

  const bIndex = await page.session.evaluate(
    "window.__VEDITOR_TEST__.assets().findIndex((asset) => asset.name === 'rotated-90.mp4')",
  );
  await seekTo('00:00:08:00'); // 240
  await page.session.evaluate(`(() => {
    document.querySelectorAll('[data-v="asset-card"]')[${bIndex}].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 600));

  const clips = await page.session.evaluate('window.__VEDITOR_TEST__.clips()');
  const bClip = clips.find((clip) => clip.startFrame === 240);
  if (bClip === undefined) throw new Error(`B 片段没落在 240（实际 ${JSON.stringify(clips.map((c) => c.startFrame))}）`);

  // ---- 给 B 设交叉溶解（in 边，0.5s = 15 帧）----
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip('${bClip.id}')`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await page.session.evaluate(`(() => {
    const select = document.querySelector('[data-v="inspector-transition"]');
    if (select === null) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(select, 'crossDissolve');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  // 时长 0.5：number input 的 onBlur 才提交，而 React 17+ 监听的是 **focusout**（不是 blur）
  await page.session.evaluate(`(() => {
    const input = document.querySelector('[data-v="inspector-transition-sec"]');
    if (input === null) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '0.5');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 500));

  const withTransition = await page.session.evaluate('window.__VEDITOR_TEST__.clips()');
  const bAfter = withTransition.find((clip) => clip.id === bClip.id);
  const trIn = bAfter?.transitionDetails?.in;
  report.check(
    `① 转场已写入（in=${trIn?.type ?? 'null'} / ${trIn?.durationFrames ?? 0} 帧）`,
    trIn?.type === 'crossDissolve' && Math.abs((trIn?.durationFrames ?? 0) - 15) <= 1,
  );

  // 窗口 = [240 - 7, 240 + 8) = [233, 248)
  const before = await inspectAt('00:00:07:20'); // 230
  report.check(
    `② 窗口前（230）只有 1 层（实际 ${before.layers}）`,
    before.layers === 1,
  );

  const during = await inspectAt('00:00:08:00'); // 240
  report.check(
    `③ 窗口内（240）两层同时绘制（实际 ${during.layers} 层）`,
    during.layers === 2,
  );

  const after = await inspectAt('00:00:08:10'); // 250
  report.check(
    `④ 窗口后（250）只剩 1 层（实际 ${after.layers}）`,
    after.layers === 1,
  );

  report.check(
    `⑤ 三个时刻画面都非黑（${before.snapshot?.nonBlack} / ${during.snapshot?.nonBlack} / ${after.snapshot?.nonBlack}）`,
    (before.snapshot?.nonBlack ?? 0) > 1000
      && (during.snapshot?.nonBlack ?? 0) > 1000
      && (after.snapshot?.nonBlack ?? 0) > 1000,
  );

  const errors = await page.session.evaluate('window.__VEDITOR_TEST__.errors()');
  report.check(`⑥ 全程无错误条（${JSON.stringify(errors)}）`, Array.isArray(errors) && errors.length === 0);

  const shot = await page.session.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.join(ROOT, 'tests', 'screenshots'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'tests', 'screenshots', 'transition-mixed.png'), Buffer.from(shot.data, 'base64'));

  // ---- ⑦ 导出：转场窗口内的帧必须是**混合**的，不能硬切到某一侧 ----
  const outDir = path.join(ROOT, 'tests', '.tmp', 'transition-export');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  await page.session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: outDir });
  await seekTo('00:00:00:00'); // 导出整个区间
  await page.session.evaluate(`document.querySelector('[data-v="export-open"]').click()`);
  await page.session.waitFor(`!!document.querySelector('[data-v="export-dialog"]')`, 5000);
  await page.session.evaluate(`document.querySelector('[data-v="export-format-mp4"]').click()`);
  await page.session.evaluate(`document.querySelector('[data-v="export-start"]').click()`);
  await page.session.waitFor(`!!document.querySelector('[data-v="export-message"]')`, 180000);

  const listMp4 = () => (fs.existsSync(outDir)
    ? fs.readdirSync(outDir).filter((name) => name.endsWith('.mp4') && !name.endsWith('.crdownload'))
    : []);
  let exported = listMp4();
  for (let i = 0; i < 40 && exported.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    exported = listMp4();
  }
  const mp4Path = exported.length > 0 ? path.join(outDir, exported[0]) : null;
  report.check(`⑦ 带转场的片子导出成功（${mp4Path === null ? '无产物' : path.basename(mp4Path)}）`, mp4Path !== null);

  if (mp4Path !== null) {
    // 抽 230(纯 A) / 240(窗口中心) / 250(纯 B) 三帧，比较 PSNR：
    // 若 240 是硬切，它会与某一侧几乎相同（PSNR 很高）；混合帧则与两侧都明显不同。
    const grab = (seconds, name) => {
      const target = path.join(outDir, name);
      execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(seconds), '-i', mp4Path, '-frames:v', '1', target]);
      return target;
    };
    const frameA = grab(230 / 30, 'f230.png');
    const frameMid = grab(240 / 30, 'f240.png');
    const frameB = grab(250 / 30, 'f250.png');

    const psnr = (left, right) => {
      const run = spawnSync('ffmpeg', [
        '-hide_banner', '-i', left, '-i', right,
        '-lavfi', '[0:v][1:v]psnr', '-f', 'null', '-',
      ], { encoding: 'utf8' });
      const match = /average:([\d.]+|inf)/.exec(String(run.stderr ?? ''));
      if (match === null) return Number.NaN;
      return match[1] === 'inf' ? 99 : Number(match[1]);
    };

    const midVsA = psnr(frameMid, frameA);
    const midVsB = psnr(frameMid, frameB);
    report.check(
      `⑦b 窗口中心帧与纯 A 明显不同（PSNR ${Number.isNaN(midVsA) ? 'NaN' : midVsA.toFixed(1)}dB < 35）`,
      midVsA < 35,
    );
    report.check(
      `⑦c 窗口中心帧与纯 B 明显不同（PSNR ${Number.isNaN(midVsB) ? 'NaN' : midVsB.toFixed(1)}dB < 35）`,
      midVsB < 35,
    );
  }
} finally {
  await page.close();
  devServer.kill();
  await fixtures.close();
}

report.summary('跨分辨率转场回归');