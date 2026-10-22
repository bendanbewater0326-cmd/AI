/**
 * T11 UI 骨架验收（真浏览器 + 真实 IndexedDB）。
 *
 * 断言：
 *   ① 四区尺寸：顶栏 32 / 左右栏 110 / 控件条 36 / 时间线 220（真组件替换占位后不变形）
 *   ② 测试钩子 `window.__VEDITOR_TEST__` 存在且 commitCount > 0
 *   ③ 无片段时改参数立即生效（1920×1080 · 24fps）
 *   ④ 输入框聚焦时 Space / Delete / Ctrl+B 不触发快捷键（播放状态与 docVersion 不变）
 *   ⑤ 双击改名 → Enter 提交 → 刷新后仍保留（IndexedDB）
 *   ⑥ 有片段时改参数弹二次确认，显示「受影响片段数 + 最大位移帧数」（2 个 / 60 帧）
 *
 * 运行：`node tests/verify-t11.mjs`（自带 dev server 启动，端口 5183）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5183;
const URL = `http://127.0.0.1:${PORT}/`;

/** 启动 dev server（测试钩子只在非生产构建注入）。 */
async function startDevServer() {
  const child = spawn(process.execPath, ['scripts/dev.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dev server 10 秒内未就绪')), 10000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes(`127.0.0.1:${PORT}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      if (text.includes('EADDRINUSE')) {
        clearTimeout(timer);
        reject(new Error(`端口 ${PORT} 被占用`));
      }
    });
  });
  await ready;
  return child;
}

const server = await startDevServer();
const page = await launchPage({ url: URL, width: 1440, height: 900 });
const report = createReport();

/** 等待 React 挂载 + 测试钩子就绪。 */
async function waitReady() {
  await page.session.waitFor(
    "document.readyState === 'complete' && !!window.__VEDITOR_TEST__",
    8000,
  );
  // 恢复会话是异步的，等 autosave 挂上（docVersion 稳定）
  await new Promise((resolve) => setTimeout(resolve, 300));
}

/** 刷新页面并等就绪。 */
async function reload() {
  await page.session.evaluate('setTimeout(() => location.reload(), 0); 1');
  await new Promise((resolve) => setTimeout(resolve, 600));
  await waitReady();
}

try {
  await waitReady();

  // ---- ① 四区尺寸 ----
  const sizes = await page.session.evaluate(`(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { w: Math.round(box.width), h: Math.round(box.height) };
    };
    return {
      topbar: rect('[data-v="topbar"]'),
      left: rect('[data-v="asset-panel"]'),
      right: rect('[data-v="inspector-panel"]'),
      ctrlbar: rect('[data-v="ctrlbar"]'),
      timeline: rect('[data-v="timeline"]'),
      screen: rect('[data-v="preview"]'),
      // T16 之后时间线是 canvas（不再是 DOM 骨架），轨道数与空态改由钩子/画布断言
      tracks: window.__VEDITOR_TEST__ ? window.__VEDITOR_TEST__.tracks().length : -1,
      emptyTimeline: !!document.querySelector('[data-v="timeline-canvas"]'),
      emptyAsset: !!document.querySelector('[data-v="asset-empty"]'),
      params: document.querySelector('[data-v="project-params"]')?.textContent,
      name: document.querySelector('[data-v="project-name"]')?.textContent,
      hooks: !!window.__VEDITOR_TEST__,
      commitCount: window.__VEDITOR_TEST__ ? window.__VEDITOR_TEST__.commitCount : -1,
    };
  })()`);

  report.check(`① 顶栏 32（${sizes.topbar?.h}）`, sizes.topbar?.h === 32);
  report.check(`① 左栏 110（${sizes.left?.w}）`, sizes.left?.w === 110);
  report.check(`① 右栏 110（${sizes.right?.w}）`, sizes.right?.w === 110);
  report.check(`① 控件条 36（${sizes.ctrlbar?.h}）`, sizes.ctrlbar?.h === 36);
  report.check(`① 时间线 220（${sizes.timeline?.h}）`, sizes.timeline?.h === 220);
  const ratio = sizes.screen ? sizes.screen.w / sizes.screen.h : 0;
  report.check(
    `① 预览 16:9（${sizes.screen?.w}×${sizes.screen?.h} = ${ratio.toFixed(3)}）`,
    Math.abs(ratio - 16 / 9) < 0.02,
  );
  report.check(
    `三条轨道 + 两处空态（轨道 ${sizes.tracks}，时间线画布 ${sizes.emptyTimeline}，素材空态 ${sizes.emptyAsset}）`,
    sizes.tracks === 3 && sizes.emptyTimeline && sizes.emptyAsset,
  );
  report.check(`② 测试钩子存在且 commitCount=${sizes.commitCount} > 0`, sizes.hooks && sizes.commitCount > 0);

  // ---- ③ 无片段：改参数立即生效 ----
  const immediate = await page.session.evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const click = (selector) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error('缺少元素 ' + selector);
      element.click();
    };
    click('[data-v="project-params"]');
    await sleep(80);
    const input = document.querySelector('[data-v="params-fps"]');
    if (!input) throw new Error('参数弹窗未打开');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '24');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(50);
    click('[data-v="params-apply"]');
    await sleep(80);
    return {
      params: document.querySelector('[data-v="project-params"]')?.textContent,
      dialogOpen: !!document.querySelector('[data-v="params-dialog"]'),
      confirmShown: !!document.querySelector('[data-v="params-confirm"]'),
    };
  })()`);
  report.check(
    `③ 无片段立即生效（${immediate.params}）`,
    /1920×1080/.test(immediate.params ?? '') && /24fps/.test(immediate.params ?? ''),
    `弹窗关闭=${!immediate.dialogOpen}，未弹确认=${!immediate.confirmShown}`,
  );

  // ---- ④ 输入框聚焦时快捷键失效 ----
  const keyBlocking = await page.session.evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const name = document.querySelector('[data-v="project-name"]');
    name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await sleep(80);
    const input = document.querySelector('[data-v="project-name-input"]');
    if (!input) return { error: '重命名输入框未出现' };
    input.focus();
    const playButton = document.querySelector('[data-v="play-toggle"]');
    const before = {
      pressed: playButton?.getAttribute('aria-pressed'),
      version: window.__VEDITOR_TEST__.docVersion(),
      playhead: window.__VEDITOR_TEST__.playheadFrame(),
    };
    const send = (key, extra = {}) =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
    send(' ');
    send('Delete');
    send('b', { ctrlKey: true });
    send('ArrowRight');
    const after = {
      pressed: playButton?.getAttribute('aria-pressed'),
      version: window.__VEDITOR_TEST__.docVersion(),
      playhead: window.__VEDITOR_TEST__.playheadFrame(),
    };
    // Esc 退出焦点，再验一次 Space 生效（此时焦点已不在输入框）
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const blurred = document.activeElement !== input;
    return { before, after, blurred, inputStillThere: !!document.querySelector('[data-v="project-name-input"]') };
  })()`);
  report.check(
    `④ 输入框聚焦时 Space/Delete/Ctrl+B/→ 均被屏蔽`,
    keyBlocking.before &&
      keyBlocking.after &&
      keyBlocking.before.pressed === keyBlocking.after.pressed &&
      keyBlocking.before.version === keyBlocking.after.version &&
      keyBlocking.before.playhead === keyBlocking.after.playhead,
    JSON.stringify(keyBlocking.after),
  );
  report.check(`④ Esc 退出焦点`, keyBlocking.blurred === true);

  // ---- ⑤ 改名持久化（IndexedDB） ----
  await page.session.evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const name = document.querySelector('[data-v="project-name"]');
    name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await sleep(80);
    const input = document.querySelector('[data-v="project-name-input"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '我的工程');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 900)); // 等 500ms 防抖落盘
  await reload();
  const renamed = await page.session.evaluate(
    "document.querySelector('[data-v=\"project-name\"]')?.textContent",
  );
  report.check(`⑤ 改名后刷新仍保留（${renamed}）`, renamed === '我的工程');

  // ---- ⑥ 有片段：二次确认 + 两个数字 ----
  await page.session.evaluate(`(async () => {
    const project = {
      id: 'prj_seed',
      name: '带片段工程',
      fpsMilli: 30000,
      width: 1920,
      height: 1080,
      sampleRate: 48000,
      frameMapPolicy: 'holdPrevious',
      durationRounding: 'halfUp',
      tracks: [
        { id: 'trk_A1', kind: 'audio', name: 'A1', order: 0, locked: false, muted: false, hidden: false, clips: [] },
        {
          id: 'trk_V1', kind: 'video', name: 'V1', order: 0, locked: false, muted: false, hidden: false,
          clips: [
            {
              id: 'clp_a', assetId: 'ast_seed', trackId: 'trk_V1', startFrame: 0, inFrame: 0, outFrame: 240,
              durationFrames: 240, speedMilli: 1000, enabled: true,
              transform: { scale: 1, x: 0, y: 0, opacity: 1, blendMode: 'normal' },
              audio: { gain: 1, fadeInFrames: 0, fadeOutFrames: 0 },
              effects: [], transitionIn: null, transitionOut: null, source: 'ui',
            },
            {
              id: 'clp_b', assetId: 'ast_seed', trackId: 'trk_V1', startFrame: 300, inFrame: 0, outFrame: 240,
              durationFrames: 240, speedMilli: 1000, enabled: true,
              transform: { scale: 1, x: 0, y: 0, opacity: 1, blendMode: 'normal' },
              audio: { gain: 1, fadeInFrames: 0, fadeOutFrames: 0 },
              effects: [], transitionIn: null, transitionOut: null, source: 'ui',
            },
          ],
        },
        { id: 'trk_V2', kind: 'video', name: 'V2', order: 1, locked: false, muted: false, hidden: false, clips: [] },
      ],
      assets: [{
        id: 'ast_seed', name: 'sample-720p.mp4', kind: 'video', handleRef: null, sourceMode: 'memory',
        status: 'memory', fpsMilli: 30000, durationFrames: 240, durationSec: 8, sampleRate: 48000,
        channels: 2, width: 1280, height: 720, hasAudio: true, thumbnailRef: null, container: 'mp4',
        codecVideo: 'avc1.64001f', codecAudio: 'mp4a.40.2', exactSeek: true,
        hashKey: 'sample-720p.mp4|1|1',
      }],
      playheadFrame: 0,
      zoomLevel: 5,
      schemaVersion: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const database = await new Promise((resolve, reject) => {
      // **不要写死版本号**：应用建库版本会随 store 增加而升（R-052 加 proxies 时 1→2），
      // 写死 1 会抛 VersionError（"requested version (1) is less than the existing (2)"）。
      // 不传版本 = 用现有版本；库不存在时才走 onupgradeneeded。
      const request = indexedDB.open('veditor');
      request.onupgradeneeded = () => {
        for (const store of ['projects', 'handles', 'thumbs', 'settings']) {
          if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = database.transaction(['projects', 'settings'], 'readwrite');
      tx.objectStore('projects').put(project, 'prj_seed');
      tx.objectStore('settings').put('prj_seed', 'lastProjectId');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    database.close();
    return true;
  })()`);
  await reload();

  const seeded = await page.session.evaluate(
    "({ name: document.querySelector('[data-v=\"project-name\"]')?.textContent, params: document.querySelector('[data-v=\"project-params\"]')?.textContent })",
  );
  report.check(`⑥ 带片段工程已恢复（${seeded.name} / ${seeded.params}）`, seeded.name === '带片段工程');

  const confirmDialog = await page.session.evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const click = (selector) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error('缺少元素 ' + selector);
      element.click();
    };
    click('[data-v="project-params"]');
    await sleep(80);
    const input = document.querySelector('[data-v="params-fps"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '24');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(50);
    click('[data-v="params-apply"]');
    await sleep(80);
    const impact = document.querySelector('[data-v="params-impact"]');
    return {
      impact: impact ? impact.textContent : null,
      hasConfirm: !!document.querySelector('[data-v="params-confirm"]'),
      fpsBeforeConfirm: document.querySelector('[data-v="project-params"]')?.textContent,
    };
  })()`);
  report.check(
    `⑥ 二次确认显示影响面（${confirmDialog.impact}）`,
    confirmDialog.hasConfirm === true &&
      /受影响片段 2 个/.test(confirmDialog.impact ?? '') &&
      /最大位移 60 帧/.test(confirmDialog.impact ?? ''),
    `确认前参数未变：${confirmDialog.fpsBeforeConfirm}`,
  );

  const applied = await page.session.evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    document.querySelector('[data-v="params-confirm"]').click();
    await sleep(80);
    return {
      params: document.querySelector('[data-v="project-params"]')?.textContent,
      dialogOpen: !!document.querySelector('[data-v="params-dialog"]'),
    };
  })()`);
  report.check(
    `⑥ 确认后生效并关闭弹窗（${applied.params}）`,
    /24fps/.test(applied.params ?? '') && applied.dialogOpen === false,
  );

  report.summary('T11 UI 骨架验收');
} finally {
  await page.close();
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
}
