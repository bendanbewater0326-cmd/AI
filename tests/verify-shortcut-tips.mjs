/**
 * 快捷键悬浮提示端到端验证。
 *
 * 覆盖：
 *   ① 顶栏撤销按钮 title 由 keymap 派生（撤销（Ctrl+Z））
 *   ② 顶栏分割按钮 title（在播放头处分割（B））
 *   ③ 控制栏播放按钮 title（播放/暂停（空格））
 *   ④ 右键菜单「分割」项带快捷键角标 B
 *   ⑤ 右键菜单「删除片段」项带角标 Delete、「波纹删除」带 Shift+Delete
 *   ⑥ 多选菜单的批量项同样带角标
 *
 * 平台断言按 headless 环境（Windows/Chromium → Ctrl 系）；mac 符号连写由
 * settings.test.mjs 的 shortcutHint 单测覆盖。
 * 运行：`node --experimental-websocket tests/verify-shortcut-tips.mjs`
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createReport, launchPage } from './cdp.mjs';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..');
const PORT = 5850;
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

/** 右键某条轨的 `frameSec` 秒处（或直接给画布坐标）。 */
const rightClickTrack = async (trackId, frameSecOrPoint) => {
  if (typeof frameSecOrPoint === 'object') {
    await ev(`(() => {
      const canvas = document.querySelector('[data-v="timeline-canvas"]');
      canvas.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: ${Math.round(frameSecOrPoint.x)}, clientY: ${Math.round(frameSecOrPoint.y)},
      }));
      return true;
    })()`);
    await sleep(250);
    return;
  }
  await ev(`(() => {
    const canvas = document.querySelector('[data-v="timeline-canvas"]');
    const layout = window.__VEDITOR_TEST__.timelineLayout();
    const row = layout.rows.find((item) => item.trackId === ${JSON.stringify(trackId)});
    const zoom = window.__VEDITOR_TEST__.zoomLevel();
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: Math.round(rect.left + layout.headerWidth + ${frameSecOrPoint} * 30 * zoom),
      clientY: Math.round(rect.top + row.top + row.height / 2),
    }));
    return true;
  })()`);
  await sleep(250);
};

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
  await sleep(500);

  // ---- ① 顶栏 title 由 keymap 派生 ----
  {
    const titles = await evalJson(`(() => ({
      undo: document.querySelector('[data-v="undo"]')?.title ?? null,
      redo: document.querySelector('[data-v="redo"]')?.title ?? null,
      split: document.querySelector('[data-v="split"]')?.title ?? null,
    }))()`);
    report.check(
      `① 顶栏 title：${JSON.stringify(titles)}`,
      titles.undo === '撤销（Ctrl+Z）' && titles.redo === '重做（Ctrl+Shift+Z）' &&
        titles.split === '在播放头处分割（Ctrl+B）',
    );
  }

  // ---- ③ 控制栏播放按钮 ----
  {
    const playTitle = await ev(
      `document.querySelector('[data-v="ctrlbar"] button')?.title ?? null`,
    );
    report.check(
      `③ 控制栏首帧/播放 title 含快捷键（播放按钮=${JSON.stringify(playTitle)}）`,
      playTitle !== null && (playTitle.includes('（空格）') || playTitle.includes('（←）')),
    );
  }

  // ---- ④⑤ 右键菜单快捷键角标 ----
  // 备一段内容：文字面板加一段
  await click('[data-v="left-tab-text"]');
  await page.session.waitFor(`document.querySelector('[data-v="text-add"]') !== null`, 8000);
  await click('[data-v="text-add"]');
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 1`, 8000);
  await sleep(300);
  {
    await rightClickTrack('trk_T1', 0.5);
    const shortcuts = await evalJson(`(() => {
      const menu = document.querySelector('[data-v="context-menu"]');
      if (menu === null) return null;
      return Array.from(menu.querySelectorAll('[role="menuitem"]')).map((item) => ({
        label: item.querySelector('.v-menu__item-label')?.textContent ?? '',
        shortcut: item.querySelector('.v-menu__shortcut')?.textContent ?? null,
      }));
    })()`);
    const byLabel = Object.fromEntries((shortcuts ?? []).map((item) => [item.label, item.shortcut]));
    report.check(
      `④ 菜单角标：分割=B、波纹删除=Shift+Delete、删除片段=Delete（${JSON.stringify(byLabel)}）`,
      byLabel['分割'] === 'Ctrl+B' && byLabel['波纹删除'] === 'Shift+Delete' && byLabel['删除片段'] === 'Delete',
    );
    // 无快捷键的项不渲染角标（复制不在 keymap 里）
    report.check(`⑤ 复制项无角标（不手写文案）`, byLabel['复制'] === null);
    // Esc 关闭
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await sleep(200);
  }

  // ---- ⑥ 多选菜单的批量项角标 ----
  {
    // 再加第二段（落在播放头=内容末尾）；两段都按 id 精确点名，不依赖固定帧位
    await click('[data-v="text-add"]');
    await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 2`, 8000);
    await sleep(300);
    const ids = await evalJson('window.__VEDITOR_TEST__.clips().map((item) => item.id)');
    await ev(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(ids[0])})`);
    await sleep(200);
    // Ctrl 加选第二段，然后右键第一段中心 → 多选菜单
    const centerOf = async (clipId) =>
      evalJson(`(() => {
        const clip = window.__VEDITOR_TEST__.clips().find((item) => item.id === ${JSON.stringify(clipId)});
        const canvas = document.querySelector('[data-v="timeline-canvas"]');
        const layout = window.__VEDITOR_TEST__.timelineLayout();
        const row = layout.rows.find((item) => item.trackId === clip.trackId);
        const zoom = window.__VEDITOR_TEST__.zoomLevel();
        const rect = canvas.getBoundingClientRect();
        return {
          x: Math.round(rect.left + layout.headerWidth + (clip.startFrame + clip.durationFrames / 2) * zoom),
          y: Math.round(rect.top + row.top + row.height / 2),
        };
      })()`);
    const secondPoint = await centerOf(ids[1]);
    await page.session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: secondPoint.x, y: secondPoint.y, button: 'left', clickCount: 1, modifiers: 2,
    });
    await page.session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: secondPoint.x, y: secondPoint.y, button: 'left', clickCount: 1, modifiers: 2,
    });
    await sleep(350);
    const firstPoint = await centerOf(ids[0]);
    await rightClickTrack('trk_T1', firstPoint);
    const shortcuts = await evalJson(`(() => {
      const menu = document.querySelector('[data-v="context-menu"]');
      if (menu === null) return null;
      return Array.from(menu.querySelectorAll('[role="menuitem"]')).map((item) => ({
        label: item.querySelector('.v-menu__item-label')?.textContent ?? '',
        shortcut: item.querySelector('.v-menu__shortcut')?.textContent ?? null,
      }));
    })()`);
    const byLabel = Object.fromEntries((shortcuts ?? []).map((item) => [item.label, item.shortcut]));
    report.check(
      `⑥ 多选批量项角标（${JSON.stringify(byLabel)}）`,
      byLabel['波纹删除 2 个片段'] === 'Shift+Delete' && byLabel['删除 2 个片段'] === 'Delete',
    );
  }

  report.summary('快捷键悬浮提示');
} finally {
  await page.close().catch(() => {});
  dev.kill();
}
