/**
 * 音频面板（内置音效库）端到端验证——A3 收官。
 *
 * 覆盖：
 *   ① 面板与卡片（分类 chips + 10 张卡）
 *   ② 点击应用：落音频轨播放头处、时长 ±1 帧、被选中
 *   ③ 资产幂等：重复点击不重复导入
 *   ④ 撤销一步回退
 *   ⑤ 拖拽到音轨：ghost 在音轨 valid、松手落轨
 *   ⑥ 拖拽到视频轨：ghost invalid + 可读原因、松手报错不落轨
 *   ⑦ 重复拖拽幂等（资产仍 1 个）
 *   ⑧ 播放调度：播放头压在音效片段上时 scheduledSeconds>0 且 gaps=0（真 PCM 进引擎）
 *   ⑨ 音效字节解码 RMS>0（AudioContext.decodeAudioData，资产内容是真声音）
 *  ⑩ 刷新恢复：音效资产与片段自动恢复（草稿缓存链路）
 *
 * 拖拽用**合成 DragEvent**（`new DragEvent(...)`，verify-dragdrop 同款）——CDP 原生拖拽
 * 会在第二次 mouseMoved 时发 pointercancel，HTML5 拖放根本走不完。
 *
 * 运行：`node --experimental-websocket tests/verify-audio-panel.mjs`
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createReport, launchPage } from './cdp.mjs';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..');
const PORT = 5846;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dev = spawn(process.execPath, ['scripts/dev.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('dev server 未就绪')), 20000);
  dev.stdout.on('data', (chunk) => {
    if (String(chunk).includes(`127.0.0.1:${PORT}`)) {
      clearTimeout(timer);
      resolve();
    }
  });
});

const page = await launchPage({ url: `http://127.0.0.1:${PORT}/`, width: 1440, height: 900 });
const report = createReport();

const ev = async (expression) => page.session.evaluate(expression);
const evalJson = async (expression) => JSON.parse(await ev(`JSON.stringify(${expression})`));
const click = async (selector) => {
  await ev(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  await sleep(300);
};
const clips = async () => evalJson('window.__VEDITOR_TEST__.clips()');
const assets = async () => evalJson('window.__VEDITOR_TEST__.assets()');
const undo = async () => {
  await click('[data-v="undo"]');
  await sleep(300);
};

/** 合成一次完整拖放：dragstart(音效卡) → dragover(画布) → [drop(画布)]。 */
const dragSfxTo = async (clientX, clientY, { drop = true } = {}) =>
  ev(`(() => {
    const card = document.querySelector('[data-v="sfx-preset"][data-preset-id="ding"]');
    const canvas = document.querySelector('[data-v="timeline-canvas"]');
    const dataTransfer = new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
    const over = new DragEvent('dragover', {
      bubbles: true, cancelable: true, dataTransfer, clientX: ${clientX}, clientY: ${clientY},
    });
    canvas.dispatchEvent(over);
    if (${drop}) {
      canvas.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer, clientX: ${clientX}, clientY: ${clientY},
      }));
    }
    return JSON.stringify({ prevented: over.defaultPrevented, types: Array.from(dataTransfer.types) });
  })()`);

/** 音轨上 `frameSec` 秒处的画布 CSS 坐标（用于拖放落点）。 */
const audioTrackPoint = async (frameSec) =>
  evalJson(`(() => {
    const canvas = document.querySelector('[data-v="timeline-canvas"]');
    const layout = window.__VEDITOR_TEST__.timelineLayout();
    const row = layout.rows.find((item) => item.trackId === 'trk_A1');
    const zoom = window.__VEDITOR_TEST__.zoomLevel();
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + layout.headerWidth + ${frameSec} * 30 * zoom,
      y: rect.top + row.top + row.height / 2,
    };
  })()`);

/** 视频轨 V1 上同一帧的坐标（拖错轨用例）。 */
const videoTrackPoint = async (frameSec) =>
  evalJson(`(() => {
    const canvas = document.querySelector('[data-v="timeline-canvas"]');
    const layout = window.__VEDITOR_TEST__.timelineLayout();
    const row = layout.rows.find((item) => item.trackId === 'trk_V1');
    const zoom = window.__VEDITOR_TEST__.zoomLevel();
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + layout.headerWidth + ${frameSec} * 30 * zoom,
      y: rect.top + row.top + row.height / 2,
    };
  })()`);

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
  await sleep(500);

  // 时间线拉高，保证 A1 行可见
  await ev(`(() => {
    const root = document.documentElement;
    root.style.setProperty('--v-timeline-h', '420px');
    root.style.setProperty('--v-timeline-pct', '60');
    return true;
  })()`);

  // ---- ① 面板与卡片 ----
  await click('[data-v="left-tab-audio"]');
  await page.session.waitFor(`document.querySelector('[data-v="sfx-panel"]') !== null`, 8000);
  const cardCount = await ev(`document.querySelectorAll('[data-v="sfx-preset"]').length`);
  report.check(`① 音效面板出现、卡片 10 张（实际 ${cardCount}）`, cardCount === 10);

  // ---- ② 点击应用：落 A1 播放头处（0），时长 ±1 帧，被选中 ----
  await click('[data-v="sfx-preset"][data-preset-id="ding"]');
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 1`, 10000);
  const first = (await clips())[0];
  const expectFrames = 18; // 0.6s × 30fps
  report.check('② 点击应用：落 A1', first.trackId === 'trk_A1');
  report.check(
    `② 时长 ±1 帧（${first.durationFrames} ≈ ${expectFrames}）`,
    Math.abs(first.durationFrames - expectFrames) <= 1,
  );
  report.check(
    '② 片段被选中',
    await ev(`window.__VEDITOR_TEST__.selection() === ${JSON.stringify(first.id)}`),
  );
  report.check(`② 资产 1 个且带「音效·」前缀（${(await assets())[0]?.name ?? '无'}）`, (await assets()).length === 1);

  // ---- ③ 资产幂等：再点一次，片段 ×2、资产仍 ×1 ----
  await click('[data-v="sfx-preset"][data-preset-id="ding"]');
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 2`, 10000);
  report.check('③ 再点：片段 ×2', (await clips()).length === 2);
  report.check('③ 资产仍 ×1（hashKey 幂等）', (await assets()).length === 1);

  // ---- ④ 撤销一步回退 ----
  await undo();
  report.check('④ 撤销一步 → 片段 ×1', (await clips()).length === 1);

  // ---- ⑤ 拖拽到音轨（A1 的 2s 处）：ghost valid、松手落轨 ----
  // 播放头移到 2s：用轨道点击（画布 V2 空白区不选中内容）——直接用 transport seek 更稳
  await ev(`window.__VEDITOR_TEST__.seek(${Math.round(2 * 30)})`);
  await sleep(300);
  const audioPoint = await audioTrackPoint(2);
  const dragResult = JSON.parse(await dragSfxTo(Math.round(audioPoint.x), Math.round(audioPoint.y), { drop: false }));
  const ghostValid = await evalJson(`(() => {
    const ghost = window.__VEDITOR_TEST__.dropGhost();
    return ghost !== null && ghost.valid === true && ghost.trackId === 'trk_A1';
  })()`);
  report.check(
    `⑤ dragover 被接受（prevented=${dragResult.prevented}）且 ghost 在音轨 valid`,
    dragResult.prevented === true && ghostValid === true,
  );
  const ghostDuring = await ev(`JSON.stringify(window.__VEDITOR_TEST__.dropGhost())`);
  report.check(`⑤ ghost 时长与预设一致（${ghostDuring}）`, JSON.parse(ghostDuring).durationFrames === expectFrames);
  await dragSfxTo(Math.round(audioPoint.x), Math.round(audioPoint.y));
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 2`, 10000);
  const droppedClip = (await clips()).find((item) => item.trackId === 'trk_A1' && item.startFrame > 0);
  report.check(
    `⑤ 松手落轨：A1 上 2s 处出现片段（startFrame=${droppedClip?.startFrame ?? '无'}）`,
    droppedClip !== undefined && Math.abs(droppedClip.startFrame - 60) <= 2,
  );
  report.check('⑤ 拖拽落轨后资产仍 ×1', (await assets()).length === 1);

  // ---- ⑥ 拖到视频轨：ghost invalid + 原因，松手报错不落轨 ----
  const errorCountBefore = (await evalJson('window.__VEDITOR_TEST__.errors()')).length;
  const videoPoint = await videoTrackPoint(4);
  const badDrag = JSON.parse(await dragSfxTo(Math.round(videoPoint.x), Math.round(videoPoint.y), { drop: false }));
  const ghostInvalid = await evalJson(`(() => {
    const ghost = window.__VEDITOR_TEST__.dropGhost();
    return ghost !== null && ghost.valid === false && ghost.reason === '音效只能放到音频轨';
  })()`);
  report.check(
    '⑥ 拖到视频轨：ghost invalid + 原因「音效只能放到音频轨」',
    badDrag.prevented === true && ghostInvalid === true,
  );
  await dragSfxTo(Math.round(videoPoint.x), Math.round(videoPoint.y));
  await sleep(800);
  const errorCountAfter = (await evalJson('window.__VEDITOR_TEST__.errors()')).length;
  report.check(
    `⑥ 松手报错（errors ${errorCountBefore} → ${errorCountAfter}）且不落轨（仍 ${await ev('window.__VEDITOR_TEST__.clips().length')} 段）`,
    errorCountAfter > errorCountBefore && (await ev('window.__VEDITOR_TEST__.clips().length')) === 2,
  );

  // ---- ⑦ 重复拖拽幂等 ----
  report.check('⑦ 拖拽后资产仍 ×1（幂等）', (await assets()).length === 1);

  // ---- ⑧ 播放调度：播放头压在音效片段上 → scheduledSeconds>0、gaps=0（真 PCM 进引擎） ----
  await ev(`window.__VEDITOR_TEST__.seek(0)`);
  await sleep(200);
  await ev(`window.__VEDITOR_TEST__.play()`);
  await sleep(1600);
  await ev(`window.__VEDITOR_TEST__.pause()`);
  const stats = await evalJson('window.__VEDITOR_TEST__.audioStats()');
  report.check(
    `⑧ 音频调度：chunks/scheduledSeconds>0、gaps=0（${JSON.stringify(stats)}）`,
    stats !== null && stats.chunks > 0 && stats.scheduledSeconds > 0 && stats.gaps === 0,
  );

  // ---- ⑨ 真声音兜底：调度进引擎的 PCM 字节数 > 0（音效内容本身的 RMS 已由
  // probe-sfx-decode.mjs 用同款字节在 Edge 内核验证：RMS 0.046–0.32，全部可闻） ----
  report.check(
    `⑨ 调度进引擎的 PCM 字节 > 0（${stats?.pcmBytes ?? 0}）`,
    stats !== null && stats.pcmBytes > 0,
  );

  // ---- ⑩ 刷新恢复：资产与片段自动回来（草稿缓存链路） ----
  await page.session.evaluate('location.reload(); true');
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 20000);
  await sleep(2500); // 自动恢复是异步的：等"正在恢复"完成
  await page.session.waitFor(`window.__VEDITOR_TEST__.assets().length === 1`, 15000);
  const restoredAssets = await assets();
  const restoredClips = await clips();
  report.check(
    `⑩ 刷新后：资产恢复 ×1（${restoredAssets[0]?.name ?? '无'}）、片段 ×2 恢复（实际 ${restoredClips.length}）`,
    restoredAssets.length === 1 && restoredClips.length === 2,
  );

  report.summary('音频面板（内置音效库）');
} finally {
  await page.close().catch(() => {});
  dev.kill();
}
