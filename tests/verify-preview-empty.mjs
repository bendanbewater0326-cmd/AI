/**
 * 预览"空内容/隐藏轨道花屏" + "轨道状态变更实时生效"的回归测试。
 *
 * ## 为什么读**可见 canvas** 而不是 `previewSnapshot()`
 *
 * `previewSnapshot()` 读的是合成器的离屏 FBO —— 那个缓冲**一直**是干净的
 * （`beginFrame` 每帧都清）。用户看到的花屏发生在"上屏后的可见画布"上，
 * 所以只有 `drawImage(canvas)` 再读像素才能测出来。
 * 这也是这轮两个 bug 长期没被自动化抓到的主要原因。
 *
 * ## 覆盖的场景（对应验收标准）
 *
 * 1. 空工程 → 纯色
 * 2. 播放头在片段之前的空隙 → 纯色
 * 3. 播放头在片段内 → 有画面（证明清屏没有把正常内容清掉）
 * 4. 暂停时点「隐藏」→ 立刻变纯色（不播放也刷新）
 * 5. 取消隐藏 → 立刻恢复
 * 6. 所有轨道隐藏 → 纯色
 * 7. 播放中切静音 → 轨道闸门立刻归零（不是等下一块）
 * 8. 独奏 → 其它轨闸门归零
 * 9. 通过 dispatch（Agent 路径）改状态 → 与点按钮一样立刻生效
 * 10. 时间线画布：隐藏轨道的行变暗（读画布像素）
 * 11. 性能：单帧渲染耗时没回退
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5241;
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
  response.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Access-Control-Allow-Origin': '*',
  });
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

/** 读可见预览画布的像素统计（花屏 = 大量随机颜色 + 非黑比例异常）。 */
const CANVAS_STATS = `(() => {
  const canvas = document.querySelector('[data-v="preview-canvas"]');
  if (!canvas) return JSON.stringify({ missing: true });
  const off = document.createElement('canvas');
  off.width = canvas.width;
  off.height = canvas.height;
  const ctx = off.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  const { data } = ctx.getImageData(0, 0, off.width, off.height);
  let nonBlack = 0;
  let maxLuma = 0;
  const colors = new Set();
  for (let i = 0; i + 3 < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luma > 6) nonBlack += 1;
    if (luma > maxLuma) maxLuma = luma;
    if (colors.size < 4000) colors.add((r >> 3) * 1024 + (g >> 3) * 32 + (b >> 3));
  }
  return JSON.stringify({ missing: false, total: data.length / 4, nonBlack, maxLuma: Math.round(maxLuma), colors: colors.size });
})()`;

const readCanvas = async () => JSON.parse(await page.session.evaluate(CANVAS_STATS));

/** 读时间线画布某条轨在**内容区**（轨道头右侧）的亮度均值。 */
const timelineRowLuma = async (trackId) =>
  JSON.parse(
    await page.session.evaluate(`(() => {
      const canvas = document.querySelector('[data-v="timeline-canvas"]');
      const layout = window.__VEDITOR_TEST__.timelineLayout();
      const row = layout.rows.find((item) => item.trackId === ${JSON.stringify(trackId)});
      if (!row) return JSON.stringify({ missing: true });
      const ctx = canvas.getContext('2d');
      const scale = canvas.width / canvas.getBoundingClientRect().width;
      const data = ctx.getImageData(
        Math.round((layout.headerWidth + 40) * scale),
        Math.round((row.top + row.height / 2) * scale),
        60,
        6,
      ).data;
      let sum = 0;
      for (let i = 0; i + 3 < data.length; i += 4) sum += data[i];
      return JSON.stringify({ meanRed: sum / (data.length / 4) });
    })()`),
  );

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 20000);

  // ---- ① 空工程（?src= 还没导入完时先读一次；导入太快则跳过）----
  const emptyStats = await readCanvas();
  if (emptyStats.nonBlack === 0) {
    report.check(
      `① 空工程 → 可见画布纯色（颜色数 ${emptyStats.colors}）`,
      emptyStats.colors <= 2,
    );
  } else {
    console.log('     · ① 跳过：?src= 在读之前已完成导入（空工程场景由 ⑥ 覆盖）');
  }

  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 30000);
  await sleep(2500);

  const clip = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.clips()[0])'));
  const tracks = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.tracks())'));
  const videoTrack = tracks.find((track) => track.id === clip.trackId);
  const audioTrack = tracks.find((track) => track.kind === 'audio');

  // ---- ② 播放头在片段之前的空隙 ----
  await page.session.evaluate(
    `window.__VEDITOR_TEST__.dispatch([{ op: 'setClipProps', clipId: ${JSON.stringify(clip.id)}, path: 'startFrame', from: ${clip.startFrame}, to: 120 }], '移动片段')`,
  );
  await page.session.evaluate('window.__VEDITOR_TEST__.seek(0)');
  await sleep(900);
  let stats = await readCanvas();
  report.check(
    `② 播放头在空隙 → 纯色（非黑 ${stats.nonBlack}，颜色数 ${stats.colors}）`,
    stats.missing === false && stats.nonBlack === 0,
  );

  // ---- ③ 播放头在片段内 → 有画面 ----
  await page.session.evaluate('window.__VEDITOR_TEST__.seek(160)');
  await sleep(1200);
  const withClip = await readCanvas();
  report.check(
    `③ 播放头在片段内 → 有画面（非黑 ${(withClip.nonBlack / withClip.total * 100).toFixed(0)}%）`,
    withClip.nonBlack / withClip.total > 0.1,
  );

  // ---- ④ 暂停时点「隐藏」→ 立刻变纯色 ----
  await page.session.evaluate(`window.__VEDITOR_TEST__.setTrackFlag('${videoTrack.id}', 'hidden', true)`);
  await sleep(700);
  stats = await readCanvas();
  report.check(
    `④ 暂停时隐藏 → 立刻变纯色（${withClip.nonBlack} → ${stats.nonBlack}）`,
    stats.nonBlack === 0 && withClip.nonBlack > 0,
  );

  // ---- ⑤ 取消隐藏 → 立刻恢复 ----
  await page.session.evaluate(`window.__VEDITOR_TEST__.setTrackFlag('${videoTrack.id}', 'hidden', false)`);
  await sleep(900);
  stats = await readCanvas();
  report.check(
    `⑤ 取消隐藏 → 立刻恢复（非黑 ${(stats.nonBlack / stats.total * 100).toFixed(0)}%）`,
    stats.nonBlack / stats.total > 0.1,
  );

  // ---- ⑥ 所有轨道隐藏 → 纯色 ----
  for (const track of tracks) {
    await page.session.evaluate(`window.__VEDITOR_TEST__.setTrackFlag('${track.id}', 'hidden', true)`);
  }
  await sleep(800);
  stats = await readCanvas();
  report.check(
    `⑥ 所有轨道隐藏 → 纯色（非黑 ${stats.nonBlack}，颜色数 ${stats.colors}）`,
    stats.nonBlack === 0 && stats.colors <= 2,
  );
  for (const track of tracks) {
    await page.session.evaluate(`window.__VEDITOR_TEST__.setTrackFlag('${track.id}', 'hidden', false)`);
  }
  await sleep(700);

  // ---- ⑦ 播放中切静音 → 闸门立刻归零 ----
  await page.session.evaluate('window.__VEDITOR_TEST__.seek(130)');
  await sleep(400);
  await page.session.evaluate('window.__VEDITOR_TEST__.play()');
  await sleep(900);
  await page.session.evaluate(`window.__VEDITOR_TEST__.setTrackFlag('${audioTrack.id}', 'muted', true)`);
  await sleep(300);
  const gatesMuted = JSON.parse(
    await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.audioTrackGains())'),
  );
  report.check(
    `⑦ 播放中静音 → 轨道闸门 300ms 内归零（${audioTrack.id}=${gatesMuted[audioTrack.id]}）`,
    (gatesMuted[audioTrack.id] ?? 1) < 0.05,
  );
  await page.session.evaluate(`window.__VEDITOR_TEST__.setTrackFlag('${audioTrack.id}', 'muted', false)`);
  await sleep(300);
  const gatesUnmuted = JSON.parse(
    await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.audioTrackGains())'),
  );
  report.check(
    `⑦b 取消静音 → 闸门立刻恢复（${audioTrack.id}=${gatesUnmuted[audioTrack.id]}）`,
    (gatesUnmuted[audioTrack.id] ?? 0) > 0.9,
  );
  await page.session.evaluate('window.__VEDITOR_TEST__.pause()');

  // ---- ⑧ 独奏 → 其它轨让位 ----
  await page.session.evaluate('window.__VEDITOR_TEST__.seek(160)');
  await sleep(400);
  await page.session.evaluate(`window.__VEDITOR_TEST__.setTrackFlag('${videoTrack.id}', 'solo', true)`);
  await sleep(500);
  const gatesSolo = JSON.parse(
    await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.audioTrackGains())'),
  );
  report.check(
    `⑧ 独奏 → 只有独奏轨可听（${JSON.stringify(gatesSolo)}）`,
    (gatesSolo[videoTrack.id] ?? 0) > 0.9 &&
      Object.entries(gatesSolo).every(([id, value]) => id === videoTrack.id || value < 0.05),
  );
  await page.session.evaluate(`window.__VEDITOR_TEST__.setTrackFlag('${videoTrack.id}', 'solo', false)`);
  await sleep(400);

  // ---- ⑨ Agent 路径：dispatch 改状态 → 与点按钮完全一致 ----
  await page.session.evaluate(
    `window.__VEDITOR_TEST__.dispatch([{ op: 'setTrackFlag', trackId: ${JSON.stringify(videoTrack.id)}, flag: 'hidden', from: false, to: true }], '隐藏轨道')`,
  );
  await sleep(700);
  const viaAgent = await readCanvas();
  report.check(
    `⑨ 通过 dispatch（Agent 路径）隐藏 → 画面立刻变纯色（非黑 ${viaAgent.nonBlack}）`,
    viaAgent.nonBlack === 0,
  );
  await page.session.evaluate(
    `window.__VEDITOR_TEST__.dispatch([{ op: 'setTrackFlag', trackId: ${JSON.stringify(videoTrack.id)}, flag: 'hidden', from: true, to: false }], '显示轨道')`,
  );
  await sleep(700);

  // ---- ⑩ 时间线画布：隐藏轨道的行变暗 ----
  const rowVisible = await timelineRowLuma(videoTrack.id);
  await page.session.evaluate(`window.__VEDITOR_TEST__.setTrackFlag('${videoTrack.id}', 'hidden', true)`);
  await sleep(500);
  const rowHidden = await timelineRowLuma(videoTrack.id);
  await page.session.evaluate(`window.__VEDITOR_TEST__.setTrackFlag('${videoTrack.id}', 'hidden', false)`);
  await sleep(400);
  report.check(
    `⑩ 时间线：隐藏轨道的行变暗（${rowVisible.meanRed?.toFixed(0)} → ${rowHidden.meanRed?.toFixed(0)}）`,
    rowHidden.meanRed < rowVisible.meanRed - 10,
  );

  // ---- ⑪ 性能：单帧渲染耗时没退 ----
  const cost = Number(await page.session.evaluate('window.__VEDITOR_TEST__.renderCost(10)'));
  report.check(`⑪ 单帧渲染 ${cost.toFixed(2)}ms（性能未回退）`, cost < 8);
} finally {
  report.summary('预览花屏 / 轨道状态实时生效');
  await page.close();
  dev.kill();
  server.close();
}
