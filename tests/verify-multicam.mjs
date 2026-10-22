/**
 * 多机位端到端验证（R-057）。
 *
 * 单测证明的是"操作序列自洽"；这里走**真实 UI 路径**：
 *
 *   ① 双击素材卡（播放头 0 已被 V1 占用）→ 第二段自动落到 **V2**（这就是"两条机位轨"）
 *   ② 时间线太短时给可读错误（"每 10 秒切一次" → 8 秒时间线一次都切不出来）
 *   ③ "多机位每 2 秒切一次" → 片段被切开（2 段 → 8 段）
 *   ④ 逐帧扫描：任意一帧**恰好一个机位可见**（两个都开=重影，两个都关=黑屏）
 *   ⑤ 相邻两段用的是不同机位（真的切了，不是只关掉一个）
 *   ⑥ 一次撤销整批回滚（切分 + 开关在同一个撤销步里）
 *   ⑦ 全程无页面错误
 *
 * ## ① 为什么要单独验
 *
 * 早先 `addToTimeline` 永远把片段塞进 `trk_V1`：播放头落在已有片段上时双击素材，
 * 会在**同一条轨上叠两段**（画面叠着、音量翻倍），而且用户根本没有办法把第二段素材
 * 放到第二条轨上——多机位在界面上**不可达**（旧版本这条 E2E 只能用 `setProject`
 * 硬造一个双轨工程，等于绕过了真正的入口）。现在落轨规则在 `core/placement`，
 * 这条 E2E 也就改成了真实的双击路径。
 *
 * 运行：node tests/verify-multicam.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5220;
const FIXTURE = 'sample-720p.mp4';

function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
    const found = [
      path.join(ROOT, 'tests', 'fixtures', 'compat', name),
      path.join(ROOT, 'tests', 'fixtures', name),
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
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
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

/** 打开命令栏（Ctrl+K）→ 输入 → 执行。 */
async function runCommand(page, text) {
  for (const type of ['keyDown', 'keyUp']) {
    await page.session.send('Input.dispatchKeyEvent', {
      type,
      key: 'k',
      code: 'KeyK',
      windowsVirtualKeyCode: 75,
      modifiers: 2,
    });
  }
  await page.session.waitFor(`!!document.querySelector('[data-v="command-input"]')`, 5000);
  await page.session.evaluate(`(() => {
    const input = document.querySelector('[data-v="command-input"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.session.waitFor(`document.querySelector('[data-v="command-run"]')?.disabled === false`, 5000);
  await page.session.evaluate(`document.querySelector('[data-v="command-run"]').click()`);
}

/** 逐帧扫"可见机位"（enabled 且覆盖该帧），把连续的相同结果合并成区间。 */
const SCAN = `(() => {
  const clips = window.__VEDITOR_TEST__.clips();
  const video = clips.filter((clip) => clip.trackId.startsWith('trk_angle') || clip.trackId.startsWith('trk_V'));
  let end = 0;
  for (const clip of video) end = Math.max(end, clip.startFrame + clip.durationFrames);
  const bad = [];
  const runs = [];
  for (let frame = 0; frame < end; frame += 1) {
    const visible = video
      .filter((clip) => clip.enabled && frame >= clip.startFrame && frame < clip.startFrame + clip.durationFrames)
      .map((clip) => clip.trackId);
    if (visible.length !== 1) bad.push({ frame, visible });
    const angle = visible.join(',');
    const last = runs[runs.length - 1];
    if (last !== undefined && last.angle === angle) last.to = frame + 1;
    else runs.push({ angle, from: frame, to: frame + 1 });
  }
  return JSON.stringify({ end, total: video.length, bad: bad.slice(0, 5), badCount: bad.length, runs });
})()`;

const report = createReport();
const fixture = await startFixtureServer();
const dev = await startDevServer();
const page = await launchPage({
  url: `http://127.0.0.1:${PORT}/?src=${fixture.origin}/${FIXTURE}`,
  width: 1440,
  height: 900,
});

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 15000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 30000);
  await sleep(1500);

  // ---- ① 双击素材卡 → 第二段落到 V2（真实入口，不是 setProject）----
  await page.session.evaluate(
    `document.querySelector('[data-v="asset-card"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`,
  );
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length === 2', 10000);
  await sleep(1500);
  const setup = JSON.parse(
    await page.session.evaluate(`(() => {
      const clips = window.__VEDITOR_TEST__.clips();
      const tracks = window.__VEDITOR_TEST__.tracks();
      const videoTracks = tracks.filter((track) => track.kind === 'video' && track.clips > 0);
      return JSON.stringify({
        clips: clips.length,
        trackIds: clips.map((clip) => clip.trackId),
        angles: videoTracks.length,
        // 同轨重叠 = 老 bug：两段都塞 V1
        overlapped: clips.length !== new Set(clips.map((clip) => clip.trackId)).size,
        names: videoTracks.map((track) => track.name),
      });
    })()`),
  );
  report.check(
    `① 双击素材（播放头 0 已被 V1 占用）→ 第二段落到 V2（${setup.trackIds.join(' / ')}）`,
    setup.clips === 2 && setup.angles === 2 && setup.overlapped === false && setup.trackIds.includes('trk_V2'),
  );

  const nonBlack = JSON.parse(
    await page.session.evaluate(`(async () => JSON.stringify(await window.__VEDITOR_TEST__.previewSnapshot()))()`),
  );
  report.check(
    `① 两条机位轨都能出画（非黑像素 ${nonBlack === null ? 0 : nonBlack.nonBlack}）`,
    nonBlack !== null && nonBlack.nonBlack > 1000,
  );

  // ---- ② 时间线太短 → 可读错误（不是"静默什么都不做"）----
  await runCommand(page, '多机位每 10 秒切一次');
  await page.session.waitFor(`!!document.querySelector('[data-v="command-error"]')`, 20000);
  const tooShort = await page.session.evaluate(
    `document.querySelector('[data-v="command-error"]').textContent`,
  );
  const afterTooShort = await page.session.evaluate(`window.__VEDITOR_TEST__.clips().length`);
  report.check(
    `② 时间太短给出可读错误（"${String(tooShort).trim().slice(0, 40)}"）`,
    /没有产生任何切换/.test(String(tooShort)) && /秒/.test(String(tooShort)),
  );
  report.check(`② 失败时不动时间线（仍是 ${afterTooShort} 段）`, afterTooShort === 2);
  await page.session.evaluate(`document.querySelector('[data-v="command-close"]')?.click()`);
  await sleep(400);

  // ---- ③ 真的切：每 2 秒一刀 ----
  await runCommand(page, '多机位每 2 秒切一次');
  const deadline = Date.now() + 30000;
  let clipCount = 0;
  while (Date.now() < deadline) {
    clipCount = await page.session.evaluate(`window.__VEDITOR_TEST__.clips().length`);
    if (clipCount > 2) break;
    await sleep(400);
  }
  await sleep(800);
  report.check(
    `③ 8 秒时间线按 2 秒切 → 片段数 ${clipCount}（2 条轨 × 4 段 = 8）`,
    clipCount === 8,
  );

  // ---- ④ 逐帧扫可见性 ----
  const scan = JSON.parse(await page.session.evaluate(SCAN));
  report.check(
    `④ 逐帧扫描 ${scan.end} 帧，每帧恰好一个机位可见（异常 ${scan.badCount} 帧）`,
    scan.badCount === 0 && scan.end > 200,
    scan.badCount === 0 ? undefined : JSON.stringify(scan.bad),
  );

  // ---- ⑤ 相邻两段机位不同 ----
  const angles = scan.runs.map((run) => run.angle);
  const alternating = angles.every((angle, index) => index === 0 || angle !== angles[index - 1]);
  report.check(
    `⑤ 4 段机位序列 ${JSON.stringify(scan.runs.map((run) => `${run.from}-${run.to}:${run.angle.replace('trk_', '')}`))}，相邻不同`,
    angles.length === 4 && alternating,
  );

  // ---- ⑥ 一次撤销整批回滚 ----
  for (const type of ['keyDown', 'keyUp']) {
    await page.session.send('Input.dispatchKeyEvent', {
      type,
      key: 'z',
      code: 'KeyZ',
      windowsVirtualKeyCode: 90,
      modifiers: 2,
    });
  }
  await sleep(1000);
  const undone = JSON.parse(
    await page.session.evaluate(`JSON.stringify({
      clips: window.__VEDITOR_TEST__.clips().length,
      enabled: window.__VEDITOR_TEST__.clips().filter((clip) => clip.enabled).length,
    })`),
  );
  report.check(
    `⑥ 一次撤销回到 2 段且都可见（片段 ${undone.clips} / 可见 ${undone.enabled}）`,
    undone.clips === 2 && undone.enabled === 2,
  );

  // ---- ⑦ 无页面错误 ----
  const errors = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.errors())'));
  report.check(`⑦ 全程无页面错误（${JSON.stringify(errors)}）`, Array.isArray(errors) && errors.length === 0);

  report.summary('多机位（R-057）');
} finally {
  await page.close();
  dev.kill();
  await fixture.close();
}
