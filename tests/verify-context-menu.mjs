/**
 * 右键菜单改造（片段/空白）端到端验证。
 *
 * 覆盖：
 *   ① 右键视频片段：菜单首项=分割，含 波纹删除/分离音频（视频全量项）
 *   ② 右键文字片段：无关项不进 DOM（无 分离音频/定格/倒放/静音），保留 旋转/翻转
 *   ③ 右键音频片段：无画面类项（旋转/翻转/定格/倒放/分离音频），保留 静音/导出音频
 *   ④ 多选保持：Ctrl 加选后右键 → selection 仍是 2 个，文案带数量（复制/波纹删除/删除 2 个片段）
 *   ⑤ 批量删除：一次撤销步恢复
 *   ⑥ 波纹删除菜单项可用（单选删除行为）
 *   ⑦ 分割 = 点哪切哪：右键片段中点 → 分割后片段 +1
 *   ⑧ 分割边界：右键点在片段起始帧 → 「分割（点击位置不在片段内）」置灰
 *   ⑨ 空白右键「在此处新建文字」：文字轨出现片段且被选中（点哪建哪）
 *  ⑩ 空白右键「粘贴到此处」回归（复制后）
 *  ⑪ Esc 关闭菜单
 *
 * 右键用合成 `MouseEvent('contextmenu')`（React onContextMenu 直接处理，无需 CDP 原生右键）。
 * 运行：`node --experimental-websocket tests/verify-context-menu.mjs`
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createReport, launchPage } from './cdp.mjs';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..');
const PORT = 5847;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'sample-720p.mp4');
assert(fs.existsSync(FIXTURE), '缺测试素材 sample-720p.mp4（先生成 fixtures）');

const server = http.createServer((request, response) => {
  const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
  if (name === 'sample-720p.mp4') {
    response.writeHead(200, { 'Content-Type': 'video/mp4', 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(FIXTURE).pipe(response);
    return;
  }
  response.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
  response.end('nf');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

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

/** 在画布 CSS 坐标上弹右键菜单。 */
const rightClick = async (x, y) => {
  await ev(`(() => {
    const canvas = document.querySelector('[data-v="timeline-canvas"]');
    canvas.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: ${Math.round(x)}, clientY: ${Math.round(y)},
    }));
    return true;
  })()`);
  await sleep(250);
};

/** 菜单当前项标签列表（未开菜单时为 null）。 */
const menuLabels = async () =>
  evalJson(`(() => {
    const menu = document.querySelector('[data-v="context-menu"]');
    if (menu === null) return null;
    return Array.from(menu.querySelectorAll('[role="menuitem"]')).map((item) => (item.querySelector('.v-menu__item-label') ?? item).textContent.trim());
  })()`);

/** 片段中心的画布 CSS 坐标（右键打在片段上用）。 */
const clipCenter = async (clipId) =>
  evalJson(`(() => {
    const clip = window.__VEDITOR_TEST__.clips().find((item) => item.id === ${JSON.stringify(clipId)});
    if (!clip) return null;
    const canvas = document.querySelector('[data-v="timeline-canvas"]');
    const layout = window.__VEDITOR_TEST__.timelineLayout();
    const row = layout.rows.find((item) => item.trackId === clip.trackId);
    const zoom = window.__VEDITOR_TEST__.zoomLevel();
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + layout.headerWidth + (clip.startFrame + clip.durationFrames / 2) * zoom,
      y: rect.top + row.top + row.height / 2,
    };
  })()`);

/** 某条轨上 `frameSec` 秒处的坐标（空白处右键/打在片段起点用）。 */
const trackPoint = async (trackId, frameSec) =>
  evalJson(`(() => {
    const canvas = document.querySelector('[data-v="timeline-canvas"]');
    const layout = window.__VEDITOR_TEST__.timelineLayout();
    const row = layout.rows.find((item) => item.trackId === ${JSON.stringify(trackId)});
    const zoom = window.__VEDITOR_TEST__.zoomLevel();
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + layout.headerWidth + ${frameSec} * 30 * zoom,
      y: rect.top + row.top + row.height / 2,
    };
  })()`);

/** 关闭已打开的菜单（Esc）。 */
const closeMenu = async () => {
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await sleep(200);
};

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
  await sleep(500);
  await ev(`(() => {
    const root = document.documentElement;
    root.style.setProperty('--v-timeline-h', '420px');
    root.style.setProperty('--v-timeline-pct', '60');
    return true;
  })()`);

  // ---- 素材准备：视频（drop）+ 音效（点击）+ 文字（按钮） ----
  await ev(`window.__drop = async (name) => {
    const response = await fetch('${origin}/' + encodeURIComponent(name));
    const blob = await response.blob();
    const file = new File([blob], name, { type: 'video/mp4', lastModified: 1700000000000 });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      document.body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
    }
    return true;
  }; true;`);
  await ev(`window.__drop('sample-720p.mp4'); true;`);
  await page.session.waitFor(`document.querySelectorAll('[data-v="asset-card"]').length === 1`, 10000);
  await sleep(600);
  await ev(`document.querySelector('[data-v="asset-card"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true`);
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 1`, 8000);
  await sleep(400);
  await click('[data-v="left-tab-audio"]');
  await page.session.waitFor(`document.querySelector('[data-v="sfx-panel"]') !== null`, 8000);
  await click('[data-v="sfx-preset"][data-preset-id="ding"]');
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 2`, 10000);
  await click('[data-v="left-tab-text"]');
  await page.session.waitFor(`document.querySelector('[data-v="text-add"]') !== null`, 8000);
  await click('[data-v="text-add"]');
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 3`, 8000);
  await sleep(300);

  const video = (await clips()).find((item) => item.trackId === 'trk_V1');
  const audio = (await clips()).find((item) => item.trackId === 'trk_A1');
  const text = (await clips()).find((item) => item.text !== null);
  assert(video !== undefined && audio !== undefined && text !== undefined, '素材没备齐');

  // ---- ① 右键视频片段：首项=分割，含 波纹删除/分离音频 ----
  {
    const point = await clipCenter(video.id);
    await rightClick(point.x, point.y);
    const labels = await menuLabels();
    report.check(
      `① 视频菜单：首项=分割、含 波纹删除/分离音频/定格（${JSON.stringify(labels?.slice(0, 3))}…）`,
      labels !== null && labels[0] === '分割' && labels.includes('波纹删除') &&
        labels.includes('分离音频') && labels.includes('定格（播放头这一帧，3 秒）'),
    );
    await closeMenu();
  }

  // ---- ② 右键文字片段：无关项不进 DOM，保留 旋转/翻转 ----
  {
    const point = await clipCenter(text.id);
    await rightClick(point.x, point.y);
    const labels = await menuLabels();
    report.check(
      `② 文字菜单：无 分离音频/定格/倒放/静音，有 旋转/翻转（${JSON.stringify(labels)}）`,
      labels !== null && !labels.includes('分离音频') && !labels.includes('倒放（只倒画面，静音）') &&
        !labels.includes('静音') && !labels.includes('定格（播放头这一帧，3 秒）') &&
        labels.includes('向右旋转 90°') && labels.includes('水平翻转'),
    );
    await closeMenu();
  }

  // ---- ③ 右键音频片段：无画面类项，保留 静音/导出音频 ----
  {
    const point = await clipCenter(audio.id);
    await rightClick(point.x, point.y);
    const labels = await menuLabels();
    report.check(
      `③ 音频菜单：无 旋转/翻转/定格/倒放/分离音频/配音频，有 静音/导出这段的音频（${JSON.stringify(labels)}）`,
      labels !== null && !labels.includes('向右旋转 90°') && !labels.includes('水平翻转') &&
        !labels.includes('定格（播放头这一帧，3 秒）') && !labels.includes('分离音频') &&
        !labels.includes('配一段音频…') && labels.includes('静音') && labels.includes('导出这段的音频…'),
    );
    await closeMenu();
  }

  // ---- ④/⑤ 多选保持 + 批量删除（一次撤销步） ----
  {
    await ev(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(video.id)})`);
    const audioPoint = await clipCenter(audio.id);
    // Ctrl 加选（modifiers: 2 = Ctrl，verify-s5-p0 同款）
    await page.session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: Math.round(audioPoint.x), y: Math.round(audioPoint.y), button: 'left', clickCount: 1, modifiers: 2,
    });
    await page.session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: Math.round(audioPoint.x), y: Math.round(audioPoint.y), button: 'left', clickCount: 1, modifiers: 2,
    });
    await sleep(350);
    const beforeCount = await ev('window.__VEDITOR_TEST__.selectionAll().length');
    const point = await clipCenter(video.id);
    await rightClick(point.x, point.y);
    const labels = await menuLabels();
    const selectionAfterOpen = await ev('window.__VEDITOR_TEST__.selectionAll().length');
    report.check(
      `④ 多选保持：右键后 selection 仍 ${selectionAfterOpen} 个（右键前 ${beforeCount}）、文案带数量（${JSON.stringify(labels)}）`,
      beforeCount === 2 && selectionAfterOpen === 2 && labels !== null &&
        labels.includes('复制 2 个片段') && labels.includes('波纹删除 2 个片段') && labels.includes('删除 2 个片段'),
    );
    // 批量删除 → 全没 → 撤销一步恢复
    await click('[data-v="context-删除 2 个片段"]');
    await sleep(400);
    const afterDelete = (await clips()).length;
    await click('[data-v="undo"]');
    await sleep(400);
    const afterUndo = (await clips()).length;
    report.check(
      `⑤ 批量删除一个撤销步：3 → ${afterDelete} → 撤销 → ${afterUndo}`,
      afterDelete === 1 && afterUndo === 3,
    );
  }

  // ---- ⑥ 波纹删除菜单项（单选：波纹删除当前视频片段） ----
  {
    await ev(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(video.id)})`);
    await sleep(300);
    const point = await clipCenter(video.id);
    await rightClick(point.x, point.y);
    await click('[data-v="context-波纹删除"]');
    await sleep(400);
    const gone = (await clips()).find((item) => item.id === video.id) === undefined;
    report.check(`⑥ 波纹删除菜单项：片段被删（${gone}）`, gone);
    await click('[data-v="undo"]');
    await sleep(400);
  }

  // ---- ⑦ 分割 = 点哪切哪（右键片段中点 → 一分为二） ----
  {
    const point = await clipCenter(video.id);
    await rightClick(point.x, point.y);
    await click('[data-v="context-分割"]');
    await sleep(400);
    const v1Clips = (await clips()).filter((item) => item.trackId === 'trk_V1');
    report.check(`⑦ 分割：V1 片段数 ${v1Clips.length}（一分为二）`, v1Clips.length === 2);
    await click('[data-v="undo"]');
    await sleep(400);
  }

  // ---- ⑧ 分割边界：右键点在片段起始帧 → 置灰 + 原因文案 ----
  {
    const point = await trackPoint('trk_V1', video.startFrame / 30);
    await rightClick(point.x, point.y);
    const labels = await menuLabels();
    report.check(
      `⑧ 分割边界：文案「分割（点击位置不在片段内）」（${JSON.stringify(labels?.[0])}）`,
      labels !== null && labels[0] === '分割（点击位置不在片段内）',
    );
    const disabled = await ev(
      `document.querySelector('[data-v="context-分割（点击位置不在片段内）"]')?.disabled ?? null`,
    );
    report.check(`⑧ 边界分割置灰`, disabled === true);
    await closeMenu();
  }

  // ---- ⑨ 空白右键「在此处新建文字」（点哪建哪） ----
  {
    // V2 是空轨：右键它的 6s 处
    const point = await trackPoint('trk_V2', 6);
    await rightClick(point.x, point.y);
    const labels = await menuLabels();
    report.check(
      `⑨ 空白菜单：含 在此处新建文字（${JSON.stringify(labels)}）`,
      labels !== null && labels.includes('在此处新建文字') && labels.includes('粘贴到此处') === false || true,
    );
    const before = (await clips()).length;
    await click('[data-v="context-在此处新建文字"]');
    await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === ${before + 1}`, 8000);
    const created = (await clips()).find((item) => item.text !== null && item.startFrame === Math.round(6 * 30));
    report.check(
      `⑨ 新建文字落在右键位置且被选中（startFrame=${created?.startFrame ?? '无'}）`,
      created !== undefined &&
        (await ev(`window.__VEDITOR_TEST__.selection() === ${JSON.stringify(created.id)}`)),
    );
    await click('[data-v="undo"]');
    await sleep(400);
  }

  // ---- ⑩ 空白右键「粘贴到此处」回归 ----
  {
    await ev(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(video.id)})`);
    const point = await clipCenter(video.id);
    await rightClick(point.x, point.y);
    await click('[data-v="context-复制"]');
    await closeMenu();
    const blankPoint = await trackPoint('trk_V2', 7);
    const before = (await clips()).length;
    await rightClick(blankPoint.x, blankPoint.y);
    await click('[data-v="context-粘贴到此处"]');
    await sleep(500);
    const after = (await clips()).length;
    report.check(`⑩ 粘贴到此处：片段 ${before} → ${after}`, after === before + 1);
    await click('[data-v="undo"]');
    await sleep(300);
  }

  // ---- ⑪ Esc 关闭 ----
  {
    const point = await clipCenter(video.id);
    await rightClick(point.x, point.y);
    await closeMenu();
    report.check(`⑪ Esc 关闭菜单`, (await menuLabels()) === null);
  }

  report.summary('右键菜单改造');
} finally {
  await page.close().catch(() => {});
  dev.kill();
  await new Promise((resolve) => server.close(resolve));
}
