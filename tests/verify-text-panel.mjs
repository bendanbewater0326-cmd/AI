/**
 * 左栏「文本」面板 E2E（第一批：模板库 + 点击应用）。
 *
 * ## 这个文件在防什么
 *
 * 1. **"套样式"不能把用户写的字冲掉** —— 这是模板库最容易做错的一条：
 *    直接 `setClipText(presetToText(preset))` 就把 content 覆盖了。
 * 2. **新建必须落文字轨** —— 落在视频轨上时，用户之后新建 V3 就把文字盖住；
 *    而且"字幕和画面混在一条轨"是剪辑软件里最违背直觉的事。
 * 3. **建轨 + 落片必须是一个撤销步** —— 分两次 dispatch 会留下一条空的文字轨。
 * 4. **描边/粗体必须真的画出来** —— 只断言 `clip.text.stroke` 有值，
 *    `textLayer` 的缓存 key 漏加字段时照样是绿的（本项目已踩过"数据层有、界面没接"）。
 *    所以这里读**画面像素**：加描边后底部区域的亮度必须下降。
 *
 * ## 坐标约定
 *
 * `getBoundingClientRect()` 与 `uiLayout()` 都是 CSS 像素；`previewSnapshot` 的区域
 * 是 0..1 的归一化坐标（相对画面），不是像素。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5259;
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
  response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
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

const clips = async () => JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.clips())'));
const tracks = async () => JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.tracks())'));
const selected = async () => page.session.evaluate('window.__VEDITOR_TEST__.selection()');
const click = async (selector) => {
  await page.session.evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  await sleep(320);
};
const visible = async (selector) =>
  page.session.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    if (el.closest('[hidden]')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  })()`);
/** 当前可见的模板卡片（名称，按 DOM 顺序）。 */
const visiblePresets = async () =>
  JSON.parse(
    await page.session.evaluate(`(() => {
      const nodes = [...document.querySelectorAll('[data-v="text-preset"]')];
      return JSON.stringify(nodes
        .filter((el) => !el.closest('[hidden]') && el.getBoundingClientRect().height > 0)
        .map((el) => el.querySelector('.v-textcard__name')?.textContent ?? ''));
    })()`),
  );
const snapshot = async (region) =>
  JSON.parse(
    await page.session.evaluate(
      `(async () => JSON.stringify(await window.__VEDITOR_TEST__.previewSnapshot(${JSON.stringify(region)})))()`,
    ),
  );
/** 文字片段（`text !== null`）。 */
const textClips = async () => (await clips()).filter((clip) => clip.text !== null);
/**
 * 模板里的字号/位置是 **1080p 参考值**，落片时会按工程分辨率换算。
 * 这里按同样的规则算期望值，避免把测试写死在 1080p（`?src=` 的素材是 720p）。
 */
let projectSize = { width: 1920, height: 1080 };
const expectFont = (fontSize1080) => Math.max(8, Math.round((fontSize1080 * projectSize.height) / 1080));
const expectY = (y1080) => Math.round((y1080 * projectSize.height) / 1080);

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 20000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 30000);
  await sleep(1800);
  projectSize = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.projectMeta())'));

  // ---- ① 打开文本 Tab：10 张卡片、名称与顺序 ----
  await click('[data-v="left-tab-text"]');
  const names = await visiblePresets();
  report.check(
    `① 文本 Tab 显示 10 个模板（${names.join(' / ')}）`,
    names.length === 10,
  );
  report.check(
    '①b 名称与顺序符合模板库定义',
    JSON.stringify(names) ===
      JSON.stringify(['主标题', '副标题', '大标题', '主副标题', '底部字幕', '黑底白字条', '白底黑字条', '左上角标', '右下日期', '金句描边']),
  );
  report.check(
    '①c 五个分类 chip 都在，默认「全部」',
    (await page.session.evaluate("document.querySelectorAll('[data-v^=\"text-cat-\"]').length")) === 5 &&
      (await page.session.evaluate("document.querySelector('[data-v=\"text-cat-all\"]').getAttribute('aria-pressed')")) === 'true',
  );

  // ---- ② 分类筛选 ----
  const counts = {};
  for (const [key, label] of [['title', '标题'], ['caption', '字幕'], ['label', '标注'], ['quote', '金句'], ['all', '全部']]) {
    await click(`[data-v="text-cat-${key}"]`);
    counts[label] = (await visiblePresets()).length;
  }
  report.check(
    `② 分类筛选：标题 ${counts['标题']} / 字幕 ${counts['字幕']} / 标注 ${counts['标注']} / 金句 ${counts['金句']} / 全部 ${counts['全部']}`,
    counts['标题'] === 4 && counts['字幕'] === 3 && counts['标注'] === 2 && counts['金句'] === 1 && counts['全部'] === 10,
  );

  // ---- ③ 没选中时点「主标题」→ 新建在文字轨、自动选中 ----
  await page.session.evaluate('window.__VEDITOR_TEST__.selectClip(null)');
  await sleep(150);
  const beforeCreate = await clips();
  const tracksBefore = await tracks();
  await click('[data-v="text-preset"][data-preset-id="tpl-title-main"]');
  const afterCreate = await clips();
  const created = afterCreate.find((clip) => !beforeCreate.some((item) => item.id === clip.id));
  const tracksAfter = await tracks();
  const createdTrack = created === undefined ? undefined : tracksAfter.find((track) => track.id === created.trackId);
  report.check(
    `③ 点「主标题」新建 1 个片段（${beforeCreate.length} → ${afterCreate.length}）`,
    afterCreate.length === beforeCreate.length + 1 && created !== undefined,
  );
  report.check(
    `③b 内容/字号/粗体来自模板（content=${created?.text?.content} fontSize=${created?.text?.fontSize} 期望 ${expectFont(88)} bold=${created?.text?.bold}）`,
    created?.text?.content === '主标题' && created?.text?.fontSize === expectFont(88) && created?.text?.bold === true,
  );
  report.check(
    `③c 落在**文字轨**上（track=${createdTrack?.name} kind=${createdTrack?.kind}）`,
    createdTrack?.kind === 'text',
  );
  report.check(
    `③d 新建后自动选中（selection=${await selected()}）`,
    (await selected()) === created?.id,
  );
  report.check(
    `③e 自动建了 1 条轨（${tracksBefore.length} → ${tracksAfter.length}）`,
    tracksAfter.length === tracksBefore.length + 1,
  );

  // ---- ④ 一次撤销：片段与自动建的轨一起回退 ----
  await page.session.evaluate('window.__VEDITOR_TEST__.undo()');
  await sleep(450);
  const afterUndo = await clips();
  const tracksUndo = await tracks();
  report.check(
    `④ 一次撤销全部回退（片段 ${afterUndo.length}，轨道 ${tracksUndo.length}）`,
    afterUndo.length === beforeCreate.length && tracksUndo.length === tracksBefore.length,
  );

  // ---- ⑤ 套样式保留内容 ----
  await click('[data-v="text-add"]');
  const blank = (await textClips())[0];
  report.check(
    `⑤ 「＋ 添加文字」新建空白文字（content=${blank?.text?.content}）`,
    blank !== undefined && blank.text.content === '点击编辑文字',
  );
  // 用属性栏把内容改成「我的字」（走真实 UI，不是直接改 doc）
  const typed = await page.session.evaluate(`(() => {
    const el = document.querySelector('[data-v="inspector-text"]');
    if (!el) return false;
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, '我的字');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.blur();
    return true;
  })()`);
  await sleep(400);
  const edited = (await textClips()).find((clip) => clip.id === blank?.id);
  report.check(
    `⑤b 属性栏改内容生效（${typed} → ${edited?.text?.content}）`,
    typed === true && edited?.text?.content === '我的字',
  );
  await click('[data-v="text-preset"][data-preset-id="tpl-caption-bottom"]');
  const styled = (await textClips()).find((clip) => clip.id === blank?.id);
  report.check(
    `⑤c 套「底部字幕」后**内容仍是「我的字」**、样式已变（fontSize=${styled?.text?.fontSize}/${expectFont(44)} y=${styled?.text?.y}/${expectY(380)}）`,
    styled?.text?.content === '我的字' &&
      styled?.text?.fontSize === expectFont(44) &&
      styled?.text?.y === expectY(380),
  );
  report.check(
    `⑤d 套样式没有新增片段（仍 ${(await textClips()).length} 个文字片段）`,
    (await textClips()).length === 1,
  );

  // ---- ⑥ 选中视频片段时点模板 → 新建文字，不动视频 ----
  const videoClip = (await clips()).find((clip) => clip.text === null);
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(videoClip.id)})`);
  await sleep(150);
  const textCountBefore = (await textClips()).length;
  await click('[data-v="text-preset"][data-preset-id="tpl-title-big"]');
  const afterVideo = await clips();
  const videoAfter = afterVideo.find((clip) => clip.id === videoClip.id);
  report.check(
    `⑥ 选中视频片段时点模板 → 新增文字片段（${textCountBefore} → ${(await textClips()).length}），视频片段未变`,
    (await textClips()).length === textCountBefore + 1 && JSON.stringify(videoAfter) === JSON.stringify(videoClip),
  );

  // ---- ⑦ 缩略图与套用结果一致（颜色/字号同源）----
  const cardStyle = JSON.parse(
    await page.session.evaluate(`(() => {
      const card = document.querySelector('[data-v="text-preset"][data-preset-id="tpl-title-big"] .v-textcard__text');
      if (!card) return JSON.stringify(null);
      const cs = getComputedStyle(card);
      return JSON.stringify({ color: cs.color, weight: cs.fontWeight });
    })()`),
  );
  const bigClip = (await textClips()).find((clip) => clip.text?.content === '大标题');
  report.check(
    `⑦ 缩略图与落片样式同源（卡片 ${cardStyle?.color}/${cardStyle?.weight} vs 片段 ${bigClip?.text?.color}/bold=${bigClip?.text?.bold}）`,
    cardStyle?.color === 'rgb(255, 255, 255)' && bigClip?.text?.color === '#ffffff' && cardStyle?.weight === '700' && bigClip?.text?.bold === true,
  );

  // ---- ⑧ 描边/粗体真的画出来（读画面像素）----
  /**
   * 做法：**刷新回干净工程** → 隐藏视频轨（背景变纯黑）→ 套「白底黑字条」
   * （白色底衬 + 深色字）→ 勾「描边」→ 勾「加粗」，每一步底部区域的**平均亮度必须下降**
   * （白底衬面积不变，字越来越粗、又多了黑描边 → 暗像素变多）。
   *
   * 为什么必须刷新：前面几步已经在 y=380 的位置留了别的文字片段，
   * 同一区域会混进它们的像素，亮度变化就说明不了问题。
   *
   * 为什么不能只断言 `clip.text.stroke` 有值：`textLayer` 的缓存 key 漏加字段时，
   * doc 里有值、画面不变 —— 这正是本项目反复出现的"数据层有、界面没接"。
   */
  await page.session.evaluate('location.reload()');
  await sleep(2600);
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 20000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 30000);
  await sleep(1500);
  await click('[data-v="left-tab-text"]');
  await page.session.evaluate(`window.__VEDITOR_TEST__.setTrackFlag('trk_V1', 'hidden', true)`);
  await sleep(400);
  await click('[data-v="text-preset"][data-preset-id="tpl-caption-light"]');
  const light = (await textClips())[0];
  await sleep(1000);
  const REGION = { x: 0.2, y: 0.72, w: 0.6, h: 0.2 };
  const dbgFull = await snapshot();
  const base = await snapshot(REGION);
  await click('[data-v="inspector-textstroke"]');
  await sleep(1000);
  const withStroke = await snapshot(REGION);
  await click('[data-v="inspector-textbold"]');
  await sleep(1000);
  const withBold = await snapshot(REGION);
  report.check(
    `⑧ 描边真的画出来了（底部平均亮度 ${base?.meanLuma.toFixed(2)} → ${withStroke?.meanLuma.toFixed(2)}）`,
    base !== null && withStroke !== null && base.meanLuma > 1 && withStroke.meanLuma < base.meanLuma * 0.98,
  );
  report.check(
    `⑧b 加粗也真的生效（${withStroke?.meanLuma.toFixed(2)} → ${withBold?.meanLuma.toFixed(2)}）`,
    withBold !== null && withBold.meanLuma < withStroke.meanLuma - 0.05,
  );
  const finalText = (await textClips()).find((clip) => clip.id === light?.id);
  report.check(
    `⑧c 两个新字段都进了文档（bold=${finalText?.text?.bold} stroke=${JSON.stringify(finalText?.text?.stroke)}）`,
    finalText?.text?.bold === true &&
      finalText?.text?.stroke !== null &&
      finalText?.text?.stroke?.width === 6 &&
      finalText?.text?.stroke?.color === '#000000',
  );
  await page.session.evaluate(`window.__VEDITOR_TEST__.setTrackFlag('trk_V1', 'hidden', false)`);

  // ---- ⑨ 切走 Tab 再回来，分类保持 ----
  await click('[data-v="text-cat-caption"]');
  await click('[data-v="left-tab-media"]');
  await sleep(200);
  report.check('⑨ 切到素材 Tab 时文本面板不可见', (await visible('[data-v="text-panel"]')) === false);
  await click('[data-v="left-tab-text"]');
  const kept = await visiblePresets();
  report.check(`⑨b 切回来分类仍是「字幕」（${kept.length} 张）`, kept.length === 3);

  // ---- ⑩ 15% 窄栏不横向溢出 ----
  await click('[data-v="text-cat-all"]');
  await page.session.evaluate("document.documentElement.style.setProperty('--v-left-w', '15%')");
  await sleep(500);
  const overflow = JSON.parse(
    await page.session.evaluate(`(() => {
      const grid = document.querySelector('[data-v="text-grid"]');
      const panel = document.querySelector('[data-v="text-panel"]');
      return JSON.stringify({
        gridScroll: grid.scrollWidth,
        gridClient: grid.clientWidth,
        panelW: Math.round(panel.getBoundingClientRect().width),
        cols: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      });
    })()`),
  );
  report.check(
    `⑩ 15% 窄栏不横向溢出（面板 ${overflow.panelW}px · ${overflow.cols} 列 · 滚动 ${overflow.gridScroll} ≤ 可视 ${overflow.gridClient}）`,
    overflow.gridScroll <= overflow.gridClient + 1 && overflow.cols >= 1,
  );
  await page.session.evaluate("document.documentElement.style.removeProperty('--v-left-w')");
} finally {
  report.summary('文本面板：模板库 / 分类筛选 / 点击应用 / 落文字轨 / 描边像素');
  await page.close();
  dev.kill();
  server.close();
}
