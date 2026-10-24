/**
 * 时间轴 S5 第二阶段端到端验证（框选 / 时长气泡 / 跨轨指示线 / Shift 波纹裁剪 / 边缘自动滚动）。
 *
 * 覆盖：
 *   ① 空白拖框选（相交判定）：只压到片段一半也选中
 *   ② 框选清空旧选择
 *   ③ Ctrl+框选 = 加选（保留已选）
 *   ④ 拖动时长气泡：拖动中出现且含「时长」，松手隐藏
 *   ⑤ 跨轨指示线：拖到别的轨时出现在目标轨上缘，松手消失
 *   ⑥ Shift+右缘裁剪 = 波纹裁剪：后续片段左移恰为减少量，一个撤销步
 *   ⑦ 不按 Shift 的右缘裁剪：后续片段不动（回归）
 *   ⑧ 拖到画布右缘 → 自动滚动（scrollX > 0）
 *
 * 交互模拟用 CDP 原生鼠标事件（verify-s5-p0 同款）——时间线是 pointer 交互
 * （不是 HTML5 drag），CDP 事件能走完整个 press/move/up 链路。
 * 运行：`node --experimental-websocket tests/verify-s5-phase2.mjs`
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createReport, launchPage } from './cdp.mjs';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..');
const PORT = 5851;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'sample-720p.mp4');
assert(fs.existsSync(FIXTURE), '缺测试素材 sample-720p.mp4');

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
const selection = async () => evalJson('window.__VEDITOR_TEST__.selectionAll()');

/** CDP 鼠标序列（modifiers：2=Ctrl 4=Shift）。 */
const mouse = async (type, x, y, modifiers = 0) => {
  await page.session.send('Input.dispatchMouseEvent', {
    type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0, modifiers,
  });
  await sleep(60);
};

const press = async (x, y, modifiers = 0) => mouse('mousePressed', x, y, modifiers);
const moveTo = async (x, y, modifiers = 0) => mouse('mouseMoved', x, y, modifiers);
const release = async (x, y, modifiers = 0) => mouse('mouseReleased', x, y, modifiers);

/** 画布坐标：某条轨 `frameSec` 秒处。 */
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
      rowTop: rect.top + row.top,
    };
  })()`);

/** 片段右缘内侧 4px 的坐标（裁剪手柄，verify-s5-p0 的 edgePoint 同款）。 */
const edgePoint = async (clipId, side, offsetPx = 0) =>
  evalJson(`(() => {
    const clip = window.__VEDITOR_TEST__.clips().find((item) => item.id === ${JSON.stringify(clipId)});
    if (!clip) return null;
    const canvas = document.querySelector('[data-v="timeline-canvas"]');
    const layout = window.__VEDITOR_TEST__.timelineLayout();
    const row = layout.rows.find((item) => item.trackId === clip.trackId);
    const zoom = window.__VEDITOR_TEST__.zoomLevel();
    const rect = canvas.getBoundingClientRect();
    const frame = ${JSON.stringify(side)} === 'left' ? clip.startFrame : clip.startFrame + clip.durationFrames;
    return {
      x: rect.left + layout.headerWidth + frame * zoom - scrollOffset() + ${JSON.stringify(offsetPx)},
      y: rect.top + row.top + row.height / 2,
    };
    function scrollOffset() {
      return Number(canvas.dataset.scrollX ?? '0');
    }
  })()`);

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
  await sleep(500);
  await ev(`(() => {
    const root = document.documentElement;
    root.style.setProperty('--v-timeline-h', '420px');
    root.style.setProperty('--v-timeline-pct', '60');
    return true;
  })()`);

  // 素材：视频（V1）+ 两段文字（T1，相邻）
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
  await click('[data-v="left-tab-text"]');
  await page.session.waitFor(`document.querySelector('[data-v="text-add"]') !== null`, 8000);
  await click('[data-v="text-add"]');
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 2`, 8000);
  await click('[data-v="text-add"]');
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 3`, 8000);
  await sleep(300);

  // ---- ①/②/③ 框选：从空白的 V2 行起手，向下框到文字轨（相交判定） ----
  // 框选 Y 范围 = V2 行中心 → 第一条文字轨行中心：罩住 T2/T1 两行（两段文字可能被
  // ensureTextTrackOps 排到不同文字轨），但不碰 V1 行（视频不入选）。
  const marqueeFrom = await trackPoint('trk_V2', 0.3);
  const marqueeTo = await (async () => {
    const point = await trackPoint('trk_T1', 4);
    const textTop = await evalJson(`(() => {
      const layout = window.__VEDITOR_TEST__.timelineLayout();
      const rows = layout.rows.filter((item) => item.trackId.startsWith('trk_T')).map((item) => item.top);
      return Math.min(...rows);
    })()`);
    const rectTop = await ev(`document.querySelector('[data-v="timeline-canvas"]').getBoundingClientRect().top`);
    const textTopViewport = rectTop + textTop + 8;    // **视口坐标**（release 走 CDP client 坐标；textTop 是画布坐标，要加 rect.top）
    return { x: point.x, y: textTopViewport };
    
  })();

  // ① 空白拖框选（无修饰键）：相交选中 2 段文字
  {
    await ev(`window.__VEDITOR_TEST__.selectClip(null)`);
    await sleep(200);
    await press(marqueeFrom.x, marqueeFrom.y);
    await moveTo((marqueeFrom.x + marqueeTo.x) / 2, marqueeTo.y);
    await moveTo(marqueeTo.x, marqueeTo.y);
    // 可见性必须在**拖动中**读（松手即隐藏）
    const marqueeDebug = await ev(
      `JSON.stringify((() => {
        const el = document.querySelector('[data-v="tl-marquee"]');
        if (el === null) return { exists: false };
        const rect = el.getBoundingClientRect();
        return { exists: true, hidden: el.hidden, widthStyle: el.style.width, rectW: Math.round(rect.width), rectH: Math.round(rect.height), top: Math.round(rect.top), left: Math.round(rect.left) };
      })())`,
    );
    const marqueeVisible = JSON.parse(marqueeDebug).exists === true && JSON.parse(marqueeDebug).hidden === false && Number(JSON.parse(marqueeDebug).rectW) > 0;
    await release(marqueeTo.x, marqueeTo.y);
    await sleep(300);
    const selected = await selection();
    report.check(
      `① 框选：选框=${marqueeVisible}、相交选中 2 段文字（selection=${JSON.stringify(selected)}）`,
      marqueeVisible === true && selected.length === 2,
    );
  }

  // ② 框选清空旧选择：先单选视频，再框选 → 旧选择被替换
  {
    await ev(`window.__VEDITOR_TEST__.selectClip(window.__VEDITOR_TEST__.clips().find((item) => item.trackId === 'trk_V1').id)`);
    await sleep(200);
    await press(marqueeFrom.x, marqueeFrom.y);
    await moveTo(marqueeTo.x, marqueeTo.y);
    await release(marqueeTo.x, marqueeTo.y);
    await sleep(300);
    const selected = await selection();
    const videoId = (await clips()).find((item) => item.trackId === 'trk_V1').id;
    report.check(
      `② 框选清空旧选择（selection=${selected.length}，不含视频=${!selected.includes(videoId)}）`,
      selected.length === 2 && !selected.includes(videoId),
    );
  }

  // ③ Ctrl+框选 = 加选/减选：视频已选中 → 框过它 = 减选，两段文字 = 加选
  {
    await ev(`window.__VEDITOR_TEST__.selectClip(window.__VEDITOR_TEST__.clips().find((item) => item.trackId === 'trk_V1').id)`);
    await sleep(200);
    await press(marqueeFrom.x, marqueeFrom.y, 2); // Ctrl
    await moveTo(marqueeTo.x, marqueeTo.y, 2);
    await release(marqueeTo.x, marqueeTo.y, 2);
    await sleep(300);
    const selected = await selection();
    const videoId = (await clips()).find((item) => item.trackId === 'trk_V1').id;
    report.check(
      `③ Ctrl+框选纯加选：视频不在框内保持选中 + 2 段文字加选（selection=${selected.length}）`,
      selected.length === 3 && selected.includes(videoId),
    );
  }

  // ---- ④ 拖动时长气泡 ----
  {
    await ev(`window.__VEDITOR_TEST__.selectClip(null)`);
    await sleep(200);
    const v1 = (await clips()).find((item) => item.trackId === 'trk_V1');
    const from = await trackPoint('trk_V1', (v1.startFrame + v1.durationFrames / 2) / 30);
    await press(from.x, from.y);
    await moveTo(from.x + 40, from.y);
    await moveTo(from.x + 60, from.y);
    const bubble = await evalJson(`(() => {
      const el = document.querySelector('[data-v="tl-bubble"]');
      return el === null ? null : { hidden: el.hidden, text: el.textContent };
    })()`);
    await release(from.x + 60, from.y);
    await sleep(300);
    report.check(
      `④ 拖动气泡：出现且含「时长」（${JSON.stringify(bubble)}）`,
      bubble !== null && bubble.hidden === false && bubble.text.includes('时长') &&
        bubble.text.includes('起点') && bubble.text.includes('结束'),
    );
    const bubbleAfter = await ev(`document.querySelector('[data-v="tl-bubble"]')?.hidden ?? null`);
    report.check(`④ 松手后气泡隐藏（${bubbleAfter}）`, bubbleAfter === true);
    await click('[data-v="undo"]');
    await sleep(300);
  }

  // ---- ⑤ 跨轨指示线：V1 片段拖到 V2 ----
  {
    const v1 = (await clips()).find((item) => item.trackId === 'trk_V1');
    const from = await trackPoint('trk_V1', (v1.startFrame + v1.durationFrames / 2) / 30);
    const to = await trackPoint('trk_V2', (v1.startFrame + v1.durationFrames / 2) / 30);
    await press(from.x, from.y);
    await moveTo((from.x + to.x) / 2, (from.y + to.y) / 2);
    await moveTo(to.x, to.y);
    const indicator = await evalJson(`(() => {
      const el = document.querySelector('[data-v="tl-track-indicator"]');
      if (el === null || el.hidden) return null;
      const rowTop = ${JSON.stringify((await trackPoint('trk_V2', 0)).rowTop)};
      const rect = el.getBoundingClientRect();
      return { top: Math.round(rect.top), expectedTop: Math.round(rowTop), width: Math.round(rect.width) };
    })()`);
    await release(to.x, to.y);
    await sleep(400);
    const moved = (await clips()).find((item) => item.id === v1.id);
    report.check(
      `⑤ 跨轨指示线：出现在 V2 行上缘（${JSON.stringify(indicator)}）`,
      indicator !== null && Math.abs(indicator.top - indicator.expectedTop) <= 2 && indicator.width > 100,
    );
    report.check(
      `⑤ 松手后跨轨落位（trackId=${moved?.trackId}）+ 指示线消失`,
      moved?.trackId === 'trk_V2' &&
        (await ev(`document.querySelector('[data-v="tl-track-indicator"]').hidden`)) === true,
    );
    await click('[data-v="undo"]');
    await sleep(300);
  }

  // ---- ⑥/⑦ Shift 波纹裁剪：分割出相邻两段 → Shift+右缘裁剪 ----
  {
    const v1 = (await clips()).find((item) => item.trackId === 'trk_V1');
    assert(v1 !== undefined, 'V1 片段丢了');
    await ev(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(v1.id)})`);
    await sleep(200);
    // 分割（右键菜单 = 点哪切哪）：片段中点
    const center = await trackPoint('trk_V1', (v1.startFrame + v1.durationFrames / 2) / 30);
    await ev(`(() => {
      const canvas = document.querySelector('[data-v="timeline-canvas"]');
      canvas.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: ${Math.round(center.x)}, clientY: ${Math.round(center.y)},
      }));
      return true;
    })()`);
    await sleep(250);
    await click('[data-v="context-分割"]');
    await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 4`, 8000);
    await sleep(300);
    const parts = (await clips()).filter((item) => item.trackId === 'trk_V1').sort((a, b) => a.startFrame - b.startFrame);
    const rightEdge = await edgePoint(parts[0].id, 'right', -4);
    const shift = 8; // CDP 修饰键位：Alt1 / Ctrl2 / Meta4 / Shift8
    await press(rightEdge.x, rightEdge.y, shift);
    await moveTo(rightEdge.x - 15, rightEdge.y, shift);
    await moveTo(rightEdge.x - 30, rightEdge.y, shift);
    await release(rightEdge.x - 30, rightEdge.y, shift);
    await sleep(400);
    const after = (await clips()).filter((item) => item.trackId === 'trk_V1').sort((a, b) => a.startFrame - b.startFrame);
    const shrunk = after[0].durationFrames;
    const rippleDelta = parts[0].durationFrames - shrunk;
    report.check(
      `⑥ Shift 波纹裁剪：首段 ${parts[0].durationFrames}→${shrunk}，后续左移 ${parts[1].startFrame - after[1].startFrame}（期望 ${rippleDelta}）`,
      rippleDelta > 0 && parts[1].startFrame - after[1].startFrame === rippleDelta,
    );
    // 一个撤销步：波纹 + 裁剪一起回退
    await click('[data-v="undo"]');
    await sleep(200);
    await sleep(400);
    const restored = (await clips()).filter((item) => item.trackId === 'trk_V1').sort((a, b) => a.startFrame - b.startFrame);
    report.check(
      `⑥ 一个撤销步恢复（${restored.length} 段、首段 ${restored[0]?.durationFrames}）`,
      restored.length === 2 && restored[0].durationFrames === parts[0].durationFrames,
    );
    // ⑦ 不按 Shift：后续片段不动
    const edge2 = await edgePoint(restored[0].id, 'right', -4);
    await press(edge2.x, edge2.y);
    await moveTo(edge2.x - 30, edge2.y);
    await release(edge2.x - 30, edge2.y);
    await sleep(400);
    const afterPlain = (await clips()).filter((item) => item.trackId === 'trk_V1').sort((a, b) => a.startFrame - b.startFrame);
    report.check(
      `⑦ 普通裁剪：后续片段不动（${parts[1].startFrame} → ${afterPlain[1].startFrame}）`,
      afterPlain[1].startFrame === parts[1].startFrame && afterPlain[0].durationFrames < restored[0].durationFrames,
    );
    await click('[data-v="undo"]');
    await sleep(300);
  }

  // ---- ⑧ 边缘自动滚动：放大到内容超宽 → 拖片段到右缘 → scrollX > 0 ----
  {
    // Ctrl+滚轮放大（onWheel 以播放头为锚）：多次 deltaY<0
    for (let index = 0; index < 6; index += 1) {
      await page.session.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 500, deltaX: 0, deltaY: -240, modifiers: 2 });
      await sleep(80);
    }
    const zoom = await ev('window.__VEDITOR_TEST__.zoomLevel()');
    const v1 = (await clips()).find((item) => item.trackId === 'trk_V1');
    const from = await trackPoint('trk_V1', (v1.startFrame + v1.durationFrames / 2) / 30);
    const canvasRect = await evalJson(`(() => {
      const rect = document.querySelector('[data-v="timeline-canvas"]').getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    })()`);
    await press(from.x, from.y);
    // 分几步挪到右缘内侧 <40px，然后停在边缘区让自动滚动接管
    await moveTo(canvasRect.right - 120, from.y);
    await moveTo(canvasRect.right - 30, from.y);
    await sleep(200);
    const scrollBefore = await ev(`Number(document.querySelector('[data-v="timeline-canvas"]').dataset.scrollX ?? '0')`);
    await sleep(600); // 自动滚动 rAF 持续推进
    const scrollAfter = await ev(`Number(document.querySelector('[data-v="timeline-canvas"]').dataset.scrollX ?? '0')`);
    await release(canvasRect.right - 30, from.y);
    await sleep(300);
    report.check(
      `⑧ 边缘自动滚动：zoom=${Math.round(zoom / 1000) / 1000}x，scrollX ${scrollBefore} → ${scrollAfter}`,
      scrollAfter > scrollBefore,
    );
  }

  report.summary('时间轴 S5 第二阶段');
} finally {
  await page.close().catch(() => {});
  dev.kill();
  await new Promise((resolve) => server.close(resolve));
}
