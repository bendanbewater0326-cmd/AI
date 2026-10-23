/**
 * 属性栏动态分组（2026-10-24 改造）E2E。
 *
 * 覆盖：
 *   ① 未选中：基础变换组展开、控件禁用（R-014 原貌）
 *   ② 视频片段：分组集合正确（基础变换/画面调节展开，曲线/LUT/蒙版/混合/音频效果折叠，无文字组）
 *   ③ 音频片段：画面类分组完全不渲染（直接不进 DOM），音量/淡入淡出展开、音频效果折叠
 *   ④ 文字片段：文字内容/文字样式展开、位置变换折叠、画面类分组不渲染
 *   ⑤ 切换片段：分组集合随类型同步切换
 *   ⑥ 折叠交互：点标题折叠/展开，内容随之消失/出现
 *   ⑦ 折叠态不跨片段继承：切换片段后回到该类型默认态
 *   ⑧ 混合多选：只有基础变换（视频侧）+ 音量调节（音频侧），类型专属分组不渲染
 *   ⑨ 像素级回归：画面调节的亮度滑块改 −100 → 预览画布平均亮度真的下降，撤销后恢复
 *  ⑩ 批量定向：混合选择改不透明度 → 只作用于视频片段，音频片段的 transform 不动
 *
 * 运行：`node --experimental-websocket tests/verify-inspector-groups.mjs`（需先有 tests/fixtures/sample-720p.mp4）
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createReport, launchPage } from './cdp.mjs';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..');
const PORT = 5841;
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

const evalJson = async (expression) => JSON.parse(await page.session.evaluate(`JSON.stringify(${expression})`));
const click = async (selector) => {
  await page.session.evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  await sleep(280);
};
const selectClip = async (clipId) => {
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(clipId)})`);
  await sleep(350);
};

/** 属性栏分组状态快照：存在性 + 展开态 + 关键控件存在性。 */
const groups = async () =>
  evalJson(`(() => {
    const state = (id) => {
      const el = document.querySelector('[data-v="' + id + '"]');
      return el === null ? null : el.getAttribute('data-open');
    };
    return {
      kind: document.querySelector('[data-v="inspector-panel"]').getAttribute('data-selection-kind'),
      transform: state('inspector-group-transform'),
      grade: state('inspector-section-grade'),
      curve: state('inspector-section-curve'),
      lut: state('inspector-section-lut'),
      mask: state('inspector-section-mask'),
      blend: state('inspector-group-blend'),
      volume: state('inspector-group-volume'),
      fade: state('inspector-group-fade'),
      denoise: state('inspector-group-denoise'),
      textContent: state('inspector-group-text-content'),
      textStyle: state('inspector-group-text-style'),
      textPos: state('inspector-group-text-pos'),
      hasScale: document.querySelector('[data-v="inspector-scale"]') !== null,
      hasBrightness: document.querySelector('[data-v="inspector-brightness"]') !== null,
      hasText: document.querySelector('[data-v="inspector-text"]') !== null,
    };
  })()`);

/** 时间线画布上某片段中心的屏幕坐标（Ctrl 多选用）。 */
const centerPoint = async (clipId) =>
  evalJson(`(() => {
    const clip = window.__VEDITOR_TEST__.clips().find((item) => item.id === ${JSON.stringify(clipId)});
    if (!clip) return null;
    const canvas = document.querySelector('[data-v="timeline-canvas"]');
    const layout = window.__VEDITOR_TEST__.timelineLayout();
    const row = layout.rows.find((item) => item.trackId === clip.trackId);
    const zoom = window.__VEDITOR_TEST__.zoomLevel();
    const scrollX = Number(canvas.dataset.scrollX ?? '0');
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + layout.headerWidth + (clip.startFrame + clip.durationFrames / 2) * zoom - scrollX,
      y: rect.top + row.top + row.height / 2,
    };
  })()`);

const canvasClick = async (point, modifiers = 0) => {
  await page.session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1, modifiers,
  });
  await page.session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1, modifiers,
  });
  await sleep(400);
};

  // JSON.stringify 必须在 async IIFE **内部** await：否则序列化的是 Promise 本身（得 "{}"）
  const snapshot = async () =>
    JSON.parse(
      await page.session.evaluate('(async () => JSON.stringify(await window.__VEDITOR_TEST__.previewSnapshot()))()'),
    );

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
  await sleep(500);

  // ---- ① 未选中：基础变换组展开、变换控件禁用（R-014 原貌） ----
  {
    const state = await groups();
    report.check(
      `① 未选中：kind=none、基础变换展开、缩放禁用（${state.kind}/${state.transform}/${state.hasScale}）`,
      state.kind === 'none' && state.transform === 'true' && state.hasScale,
      );
    const disabled = await page.session.evaluate(
      `document.querySelector('[data-v="inspector-scale"]').disabled`,
    );
    report.check(`① 未选中时缩放控件 disabled`, disabled === true);
  }

  // ---- 导入视频（页面内合成 drop，与 verify-t14 同一条路） ----
  await page.session.evaluate(`
    window.__drop = async (name) => {
      const response = await fetch('${origin}/' + encodeURIComponent(name));
      const blob = await response.blob();
      const file = new File([blob], name, { type: 'video/mp4', lastModified: 1700000000000 });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      for (const type of ['dragenter', 'dragover', 'drop']) {
        document.body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
      }
      return true;
    };
    true;
  `);
  await page.session.evaluate("window.__drop('sample-720p.mp4'); true");
  await page.session.waitFor(`document.querySelectorAll('[data-v="asset-card"]').length === 1`, 10000);
  await sleep(600);
  await page.session.evaluate(`document.querySelector('[data-v="asset-card"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true`);
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 1`, 8000);
  await sleep(500);
  const videoClipId = await page.session.evaluate('window.__VEDITOR_TEST__.clips()[0].id');
  await selectClip(videoClipId);

  // ---- ② 视频片段：分组集合与默认展开态 ----
  {
    const state = await groups();
    report.check(
      `② 视频：kind=video、基础变换/画面调节/音量/淡入淡出展开（${state.transform}/${state.grade}/${state.volume}/${state.fade}）`,
      state.kind === 'video' &&
        state.transform === 'true' && state.grade === 'true' &&
        state.volume === 'true' && state.fade === 'true',
    );
    report.check(
      `② 视频：曲线/LUT/蒙版/混合/音频效果存在但折叠（${state.curve}/${state.lut}/${state.mask}/${state.blend}/${state.denoise}）`,
      state.curve === 'false' && state.lut === 'false' && state.mask === 'false' &&
        state.blend === 'false' && state.denoise === 'false',
    );
    report.check(`② 视频：无文字控件（无关分组不进 DOM）`, state.hasText === false);
  }

  // ---- ③ 音频片段（音效面板添加，自动选中）：画面类分组完全不渲染 ----
  await click('[data-v="left-tab-audio"]');
  await page.session.waitFor(`document.querySelector('[data-v="sfx-panel"]') !== null`, 8000);
  await click('[data-v="sfx-preset"][data-preset-id="ding"]');
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 2`, 10000);
  await sleep(500);
  const audioClipRaw = await page.session.evaluate(
    `JSON.stringify(window.__VEDITOR_TEST__.clips().find((item) => item.trackId === 'trk_A1'))`,
  );
  const audioClip = JSON.parse(audioClipRaw);
  assert(audioClip !== undefined, '音效没有落到 A1');
  {
    const state = await groups();
    report.check(
      `③ 音频：kind=audio、画面类分组全不渲染（scale=${state.hasScale} grade=${state.grade} mask=${state.mask} lut=${state.lut} blend=${state.blend}）`,
      state.kind === 'audio' && state.hasScale === false && state.grade === null &&
        state.mask === null && state.lut === null && state.blend === null,
    );
    report.check(
      `③ 音频：音量/淡入淡出展开、音频效果折叠（${state.volume}/${state.fade}/${state.denoise}）`,
      state.volume === 'true' && state.fade === 'true' && state.denoise === 'false',
    );
  }

  // ---- ④ 文字片段：文字内容/样式展开、位置变换折叠、画面类不渲染 ----
  await click('[data-v="left-tab-text"]');
  await page.session.waitFor(`document.querySelector('[data-v="text-add"]') !== null`, 8000);
  await click('[data-v="text-add"]');
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 3`, 8000);
  await sleep(400);
  {
    const state = await groups();
    report.check(
      `④ 文字：kind=text、内容/样式展开、位置变换折叠（${state.textContent}/${state.textStyle}/${state.textPos}）`,
      state.kind === 'text' && state.textContent === 'true' && state.textStyle === 'true' && state.textPos === 'false',
    );
    report.check(
      `④ 文字：无缩放、无画面类分组（scale=${state.hasScale} grade=${state.grade} blend=${state.blend}）`,
      state.hasScale === false && state.grade === null && state.blend === null,
    );
  }

  // ---- ⑤ 切换片段：分组随类型同步切换（文字 → 视频） ----
  {
    await selectClip(videoClipId);
    const state = await groups();
    report.check(
      `⑤ 切回视频：缩放回来了、文字组消失（scale=${state.hasScale} text=${state.hasText} kind=${state.kind}）`,
      state.kind === 'video' && state.hasScale === true && state.hasText === false,
    );
  }

  // ---- ⑥ 折叠交互：点画面调节标题 → 内容消失；再点 → 回来 ----
  {
    await click('[data-v="inspector-section-grade-toggle"]');
    const folded = await groups();
    report.check(
      `⑥ 折叠画面调节：data-open=false 且亮度滑块消失（${folded.grade}）`,
      folded.grade === 'false' && folded.hasBrightness === false,
    );
    await click('[data-v="inspector-section-grade-toggle"]');
    const expanded = await groups();
    report.check(
      `⑥ 再展开：亮度滑块回来（${expanded.grade}）`,
      expanded.grade === 'true' && expanded.hasBrightness === true,
    );
  }

  // ---- ⑦ 折叠态不跨片段继承：折叠后切走再切回，恢复默认展开 ----
  {
    await click('[data-v="inspector-section-grade-toggle"]'); // 折叠
    await selectClip(audioClip.id);
    await selectClip(videoClipId);
    const state = await groups();
    report.check(`⑦ 切换后重置：画面调节恢复展开（${state.grade}）`, state.grade === 'true');
  }

  // ---- ⑧ 混合多选（视频 + 音效）：只有基础变换 + 音量调节 ----
  {
    // 时间线拉高，保证 A1 行可见（与 verify-s5-p0 同款，同时设两种变量防布局重构失配）
    await page.session.evaluate(`(() => {
      const root = document.documentElement;
      root.style.setProperty('--v-timeline-h', '420px');
      root.style.setProperty('--v-timeline-pct', '60');
      return true;
    })()`);
    await sleep(400);
    await selectClip(videoClipId);
    const audioPoint = await centerPoint(audioClip.id);
    assert(
      audioPoint !== null,
      `找不到音效片段的画布坐标：clips=${await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.clips().map((item) => ({ id: item.id, trackId: item.trackId })))')}`,
    );
    await canvasClick(audioPoint, 2); // modifiers: 2 = Ctrl（加选）
    const selectionCount = await page.session.evaluate(`window.__VEDITOR_TEST__.selectionAll().length`);
    const state = await groups();
    report.check(
      `⑧ 混合多选：选中 2 个、kind=mixed（实际 ${selectionCount}）`,
      selectionCount === 2 && state.kind === 'mixed',
    );
    report.check(
      `⑧ 混合：基础变换/音量调节展开，画面调节/淡入淡出/文字组不渲染（${state.transform}/${state.volume}/${state.grade}/${state.fade}）`,
      state.transform === 'true' && state.volume === 'true' &&
        state.grade === null && state.fade === null && state.textContent === null,
    );
  }

  // ---- ⑨ 像素级回归：亮度 −100 → 画布平均亮度真的下降，撤销恢复 ----
  {
    await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(videoClipId)})`);
    await sleep(350);
    // 混合选择后折叠态被重置；确保画面调节是展开的
    const gradeOpen = (await groups()).grade;
    if (gradeOpen !== 'true') await click('[data-v="inspector-section-grade-toggle"]');
    await page.session.waitFor(`(async () => (await window.__VEDITOR_TEST__.previewSnapshot()) !== null)()`, 8000);
    await sleep(400);
    const before = await snapshot();
    // React 受控输入必须用**原生 value setter** 赋值：直接 `el.value=` 会被 React 的
    // 值跟踪去重掉（onChange 不触发），这是 verify-adjust 的 dragRange 同款套路
    await page.session.evaluate(`(() => {
      const slider = document.querySelector('[data-v="inspector-brightness"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(slider, '-100');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      return true;
    })()`);
    await sleep(900);
    const after = await snapshot();
    report.check(
      `⑨ 亮度 −100 生效于画面（${before.meanLuma.toFixed(1)} → ${after.meanLuma.toFixed(1)}，应显著下降）`,
      after.meanLuma < before.meanLuma - 15,
    );
    await click('[data-v="undo"]');
    await sleep(700);
    const restored = await snapshot();
    report.check(
      `⑨ 撤销后画面恢复（${restored.meanLuma.toFixed(1)}）`,
      Math.abs(restored.meanLuma - before.meanLuma) < 6,
    );
  }

  // ---- ⑩ 批量定向：混合选择改不透明度 → 只作用于视频片段 ----
  {
    await selectClip(videoClipId);
    const audioPoint = await centerPoint(audioClip.id);
    await canvasClick(audioPoint, 2);
    const kindNow = (await groups()).kind;
    await page.session.evaluate(`(() => {
      const slider = document.querySelector('[data-v="inspector-opacity"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(slider, '0.5');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      return true;
    })()`);
    await sleep(600);
    const pair = JSON.parse(
      await page.session.evaluate(`JSON.stringify((() => {
        const find = (id) => window.__VEDITOR_TEST__.clips().find((item) => item.id === id);
        const video = find(${JSON.stringify(videoClipId)});
        const audio = find(${JSON.stringify(audioClip.id)});
        return { video: video === undefined ? null : video.transform.opacity, audio: audio === undefined ? null : audio.transform.opacity };
      })())`),
    );
    report.check(
      `⑩ 批量定向：混合选择下不透明度只作用视频（video=${pair.video} audio=${pair.audio}，kind=${kindNow}）`,
      kindNow === 'mixed' && Math.abs(pair.video - 0.5) < 0.001 && Math.abs(pair.audio - 1) < 0.001,
    );
  }

  report.summary('属性栏动态分组');
} finally {
  await page.close().catch(() => {});
  dev.kill();
  await new Promise((resolve) => server.close(resolve));
}
