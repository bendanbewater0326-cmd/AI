/**
 * S1.3 的回归测试：左栏 44px 图标条 + 9 个中文 Tab + 「功能开发中」占位。
 *
 * ## 这个文件在防什么
 *
 * 1. **图标条算不算在 25% 之内**（用户拍板的 A 方案）——
 *    如果哪天有人把图标条写成"25% 之外"，左栏实际占宽会变成 25% + 44px，
 *    中间预览区被额外挤压，而 1440 下肉眼几乎看不出来（少 44px 只占 3%）。
 *    所以断言必须落到**像素关系**：`内容区宽 = 左栏宽 − 44`。
 * 2. **9 个 Tab 的顺序与中文名**——顺序错了（比如"转场"跑到"特效"前面）不报错、
 *    也不影响功能，但和 OpenCut/剪映的心智模型不一致，用户会找错地方。
 * 3. **未实现的 Tab 不能是 disabled**——用户明确要求"不置灰、可点击、给友好提示"。
 *    这条最容易被"顺手加个 disabled"改回去，且测试如果只断言"点了没崩"是绿的。
 * 4. **切走再切回来不能丢素材状态**——素材面板如果被卸载，
 *    已解析的缩略图/正在进行的导入/隐藏的 file input 全没了，
 *    表现为"切个 Tab 回来素材要重新解析一遍"。
 *
 * ## 坐标约定（踩过的坑）
 *
 * `getBoundingClientRect()` 与 `uiLayout()` 都是 **CSS 像素**，不要乘除 DPR。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5253;
const FIXTURE = 'sample-720p.mp4';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 期望的 9 个 Tab：key + 中文名，**顺序即规范**。 */
const EXPECTED = [
  ['media', '素材'],
  ['audio', '音频'],
  ['text', '文本'],
  ['sticker', '贴纸'],
  ['effect', '特效'],
  ['transition', '转场'],
  ['caption', '字幕'],
  ['adjust', '调节'],
  ['settings', '设置'],
];

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

const layout = async () => JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.uiLayout())'));
const leftTab = async () => page.session.evaluate('window.__VEDITOR_TEST__.leftTab()');
const exists = async (selector) => page.session.evaluate(`document.querySelector(${JSON.stringify(selector)}) !== null`);
const click = async (selector) => {
  await page.session.evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  await sleep(260);
};
/** 元素是否**真的可见**（`hidden`/`display:none`/零尺寸都算不可见）。 */
const visible = async (selector) =>
  page.session.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    if (el.closest('[hidden]')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  })()`);

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 20000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 30000);
  await sleep(2000);

  // 从默认态开始（上一次运行可能把 Tab / 宽度记在 localStorage 里）
  await page.session.evaluate(`(() => {
    localStorage.removeItem('veditor:leftTab');
    localStorage.removeItem('veditor:leftPct');
    localStorage.removeItem('veditor:rightPct');
    localStorage.removeItem('veditor:leftCollapsed');
    localStorage.removeItem('veditor:rightCollapsed');
    return true;
  })()`);
  await page.session.evaluate('location.reload()');
  await sleep(2500);
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 20000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 30000);
  await sleep(1500);

  // ---- ① 9 个 Tab 的顺序与中文名 ----
  const domTabs = JSON.parse(
    await page.session.evaluate(`(() => {
      const nodes = [...document.querySelectorAll('[data-v="left-tabbar"] button')];
      return JSON.stringify(nodes.map((el) => ({
        key: (el.getAttribute('data-v') || '').replace('left-tab-', ''),
        label: (el.querySelector('.v-tabbar__label')?.textContent || '').trim(),
        title: el.getAttribute('title'),
        disabled: el.disabled === true,
        ariaDisabled: el.getAttribute('aria-disabled'),
      })));
    })()`),
  );
  report.check(
    `① 9 个 Tab 数量与顺序（${domTabs.map((tab) => tab.label).join(' / ')}）`,
    domTabs.length === 9 && domTabs.every((tab, index) => tab.key === EXPECTED[index][0]),
  );
  report.check(
    `①b 9 个 Tab 全为中文名（${domTabs.map((tab) => tab.label).join('')}）`,
    domTabs.every((tab, index) => tab.label === EXPECTED[index][1]),
  );
  report.check(
    `①c 悬浮提示也是中文（首项 title=「${domTabs[0]?.title}」）`,
    domTabs.every((tab, index) => tab.title === EXPECTED[index][1]),
  );
  report.check(
    '①d 未实现的 Tab 没有 disabled / aria-disabled（不置灰）',
    domTabs.every((tab) => tab.disabled === false && tab.ariaDisabled === null),
  );

  // ---- ② 44px 图标条在 25% 左栏**之内** ----
  let now = await layout();
  const railW = now.leftRail?.w ?? 0;
  const gapToContent = now.leftContent === null || now.leftRail === null ? -1 : now.leftContent.x - (now.leftRail.x + now.leftRail.w);
  report.check(
    `② 图标条宽 44px（实测 ${railW}px）`,
    Math.abs(railW - 44) <= 1,
  );
  report.check(
    `②b 图标条贴在左栏最左侧（rail.x=${now.leftRail?.x} / left.x=${now.left?.x}）`,
    now.leftRail !== null && now.left !== null && Math.abs(now.leftRail.x - now.left.x) <= 1,
  );
  report.check(
    `②c 内容区紧跟图标条、且**不超出**左栏（左栏 ${now.left?.w} = 44 + ${now.leftContent?.w}，间隙 ${gapToContent}）`,
    now.left !== null &&
      now.leftContent !== null &&
      Math.abs(now.leftContent.w - (now.left.w - railW)) <= 1 &&
      Math.abs(gapToContent) <= 1,
  );
  report.check(
    `②d 图标条 + 内容区 = 左栏宽（未把 44px 加到 25% 之外）`,
    now.left !== null && now.leftContent !== null && Math.abs(now.leftRail.w + now.leftContent.w - now.left.w) <= 1,
  );

  // ---- ③ 默认激活「素材」，素材面板可见 ----
  report.check(`③ 默认激活 media（实测 ${await leftTab()}）`, (await leftTab()) === 'media');
  report.check(
    '③b 默认能看到素材面板（空态按钮或素材卡）',
    (await visible('[data-v="asset-empty"]')) || (await visible('[data-v="asset-card"]')),
  );
  report.check('③c 默认没有「功能开发中」占位', (await exists('[data-v="tab-placeholder"]')) === false);

  const cardsBefore = Number(await page.session.evaluate('document.querySelectorAll(\'[data-v="asset-card"]\').length'));

  // ---- ④ 点未实现的 Tab：占位可见、素材面板隐藏 ----
  await click('[data-v="left-tab-audio"]');
  report.check(`④ 点「音频」→ 激活态切换（实测 ${await leftTab()}）`, (await leftTab()) === 'audio');
  const audioTitle = await page.session.evaluate(
    'document.querySelector(\'[data-v="tab-placeholder-title"]\')?.textContent || ""',
  );
  report.check(`④b 占位文案为「音频功能开发中」（实测「${audioTitle}」）`, String(audioTitle).trim() === '音频功能开发中');
  report.check('④c 占位**可见**（不是只存在于 DOM）', (await visible('[data-v="tab-placeholder"]')) === true);
  report.check('④d 素材面板已隐藏（不占位、不可点）', (await visible('[data-v="asset-empty"]')) === false && (await visible('[data-v="asset-card"]')) === false);

  // ---- ⑤ 未实现的 Tab 逐个点：都要给出对应的中文提示 ----
  /**
   * 「文本」已经换成真面板（2026-10-23 文本模板库），不再走占位 —— 它单独验（⑤b）。
   * 每做完一个 Tab 就把这里减一个，别让"占位列表"和实际实现脱节。
   */
  const placeholders = [];
  for (const [key, label] of EXPECTED.slice(1).filter(([tabKey]) => tabKey !== 'text')) {
    await click(`[data-v="left-tab-${key}"]`);
    const text = await page.session.evaluate(
      'document.querySelector(\'[data-v="tab-placeholder-title"]\')?.textContent || ""',
    );
    placeholders.push(`${label}:${String(text).trim() === `${label}功能开发中` ? '✓' : `✗(${text})`}`);
  }
  report.check(
    `⑤ 7 个未实现 Tab 各自给出「功能开发中」（${placeholders.join(' ')}）`,
    placeholders.every((item) => item.endsWith('✓')),
  );

  // ---- ⑤b「文本」是已实现的面板：没有占位、有模板卡片 ----
  await click('[data-v="left-tab-text"]');
  const textPanel = JSON.parse(
    await page.session.evaluate(`(() => {
      const panel = document.querySelector('[data-v="text-panel"]');
      const rect = panel ? panel.getBoundingClientRect() : null;
      return JSON.stringify({
        visible: panel !== null && panel.closest('[hidden]') === null && (rect?.width ?? 0) > 0,
        cards: document.querySelectorAll('[data-v="text-preset"]').length,
        placeholder: document.querySelector('[data-v="tab-placeholder"]') !== null,
      });
    })()`),
  );
  report.check(
    `⑤b 「文本」Tab 显示模板库（${textPanel.cards} 个模板，无占位）`,
    textPanel.visible === true && textPanel.cards === 10 && textPanel.placeholder === false,
  );

  // ---- ⑥ 切回「素材」：面板回来且素材不丢 ----
  await click('[data-v="left-tab-media"]');
  const cardsAfter = Number(await page.session.evaluate('document.querySelectorAll(\'[data-v="asset-card"]\').length'));
  report.check(
    `⑥ 切回素材：面板可见、素材数量不变（${cardsBefore} → ${cardsAfter}）`,
    (await visible('[data-v="asset-card"]')) === true && cardsBefore === cardsAfter && cardsAfter > 0,
  );
  report.check('⑥b 切回后占位消失', (await exists('[data-v="tab-placeholder"]')) === false);

  // ---- ⑦ 记住上次停留的 Tab（刷新后仍在原处）----
  await click('[data-v="left-tab-caption"]');
  await page.session.evaluate('location.reload()');
  await sleep(2500);
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 20000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 30000);
  await sleep(1200);
  report.check(
    `⑦ 刷新后仍停在「字幕」（实测 ${await leftTab()}）`,
    (await leftTab()) === 'caption' && (await visible('[data-v="tab-placeholder"]')) === true,
  );

  // ---- ⑧ 折叠左栏：图标条一起消失（不能只藏内容区）----
  await click('[data-v="left-tab-media"]');
  await page.session.evaluate('document.querySelector(\'[data-v="splitter-toggle-left"]\')?.click()');
  await sleep(400);
  now = await layout();
  report.check(
    `⑧ 折叠左栏后图标条也归零（left ${now.left?.w} / rail ${now.leftRail?.w}）`,
    now.left !== null && now.left.w === 0 && (now.leftRail === null || now.leftRail.w === 0),
  );
  await page.session.evaluate('document.querySelector(\'[data-v="splitter-toggle-left"]\')?.click()');
  await sleep(400);
  now = await layout();
  report.check(`⑧b 展开后图标条回来（${now.leftRail?.w}px）`, Math.abs((now.leftRail?.w ?? 0) - 44) <= 1);

  // ---- ⑨ 820px 窄屏：图标条与缩略图同步收窄，内容区不溢出 ----
  await page.session.send('Emulation.setDeviceMetricsOverride', {
    width: 820,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(500);
  now = await layout();
  const cardW = Number(
    await page.session.evaluate('(() => { const el = document.querySelector(\'[data-v="asset-card"]\'); return el ? Math.round(el.getBoundingClientRect().width) : 0; })()'),
  );
  report.check(
    `⑨ 820px：图标条 40（实测 ${now.leftRail?.w}）、内容区 ${now.leftContent?.w} ≥ 卡片 ${cardW}`,
    now.leftRail !== null &&
      Math.abs(now.leftRail.w - 40) <= 1 &&
      now.leftContent !== null &&
      now.leftContent.w >= cardW,
  );
  await page.session.send('Emulation.clearDeviceMetricsOverride');
  await sleep(300);
} finally {
  report.summary('S1.3：左栏 44px 图标条 / 9 个中文 Tab / 功能开发中占位');
  await page.close();
  dev.kill();
  server.close();
}
