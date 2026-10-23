/**
 * 左栏「设置」面板 E2E（S2：外壳 + 外观 / 缓存 / 关于，含编辑偏好里的吸附开关）。
 *
 * ## 这个文件在防什么
 *
 * 1. **面板真接上了**：`settings` Tab 不再是 `TabPlaceholder`（有 `settings-panel` 且可见）；
 * 2. **五组结构 + 默认态**：外观展开、其余折叠（与调节面板同一套折叠组件，但**不同 storage key**）；
 * 3. **外观 = 同一个开关**：面板里切主题，顶栏按钮的 `aria-pressed` 要跟着变，
 *    `documentElement[data-theme]` 要真的变（只断言按钮样式是测不出主题没生效的）；
 * 4. **偏好持久化**：主题与吸附开关刷新后仍然生效（吸附走 S1 的 `veditor:prefs`）；
 * 5. **缓存组**：显示真实占用（不是"读取中"），「打开缓存管理」打开的是**同一个** `CacheDialog`；
 * 6. **折叠态互不串味**：设置面板写 `veditor:settings:openGroups`，不污染 `veditor:adjust:openGroups`；
 * 7. **清空本地数据必须先确认**：点一次只弹确认块、数据还在；取消可退回；确认后
 *    `veditor:prefs` 消失、工程名回到「未命名工程」（证明 IndexedDB 里的草稿真被删了）。
 *
 * 运行：`node tests/verify-settings.mjs`
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5271;
const FIXTURE = 'sample-720p.mp4';
const SHOTS = path.join(ROOT, 'tests', 'screenshots');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
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
  const timer = setTimeout(() => reject(new Error('dev server 启动超时')), 30000);
  dev.stdout.on('data', (chunk) => {
    if (String(chunk).includes(`127.0.0.1:${PORT}`)) {
      clearTimeout(timer);
      resolve();
    }
  });
});

const report = createReport();
const page = await launchPage({
  url: `http://127.0.0.1:${PORT}/?src=${encodeURIComponent(`${origin}/${FIXTURE}`)}`,
  width: 1440,
  height: 900,
});

const click = async (selector) => {
  await page.session.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await sleep(300);
};
const exists = async (selector) =>
  page.session.evaluate(`document.querySelector(${JSON.stringify(selector)}) !== null`);
const visible = async (selector) =>
  page.session.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return false;
    if (el.closest('[hidden]') !== null) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  })()`);
const text = async (selector) =>
  page.session.evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el === null ? '' : (el.textContent || '').trim(); })()`,
  );
const readStorage = async (key) =>
  page.session.evaluate(`window.localStorage.getItem(${JSON.stringify(key)})`);

async function screenshot(name) {
  const shot = await page.session.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(shot.data, 'base64'));
  console.log(`  · 截图：tests/screenshots/${name}`);
}

async function reload(label) {
  await page.session.evaluate('location.reload()');
  await sleep(1800);
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 25000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length === 1', 30000);
  await sleep(900);
  console.log(`  · 已刷新（${label}）`);
}

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 20000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length === 1', 30000);

  // 从干净态开始：上一次运行可能留下 Tab / 折叠态 / 偏好 / 主题
  await page.session.evaluate(`(() => {
    for (const key of ['veditor:leftTab','veditor:prefs','veditor:settings:openGroups','veditor:adjust:openGroups']) {
      localStorage.removeItem(key);
    }
    return true;
  })()`);
  await reload('清掉本地偏好');

  // ---- ① 切到「设置」：真面板，不是占位 ----
  await click('[data-v="left-tab-settings"]');
  const mounted = JSON.parse(
    await page.session.evaluate(`(() => {
      const panel = document.querySelector('[data-v="settings-panel"]');
      const slot = document.querySelector('[data-v="settings-content-slot"]');
      return JSON.stringify({
        panel: panel !== null,
        visible: panel !== null && panel.closest('[hidden]') === null,
        slotVisible: slot !== null && !slot.hasAttribute('hidden'),
        placeholder: document.querySelector('[data-v="tab-placeholder"]') !== null,
      });
    })()`),
  );
  report.check(
    `① 设置面板已挂载且可见（无占位）`,
    mounted.panel && mounted.visible && mounted.slotVisible && mounted.placeholder === false,
  );

  // ---- ② 五组齐全 + 默认只有外观展开 ----
  const groups = JSON.parse(
    await page.session.evaluate(`(() => {
      const read = (id) => {
        const el = document.querySelector('[data-v="settings-group-' + id + '"]');
        return el === null ? 'missing' : el.getAttribute('data-open');
      };
      return JSON.stringify({
        appearance: read('appearance'),
        editing: read('editing'),
        cache: read('cache'),
        keymap: read('keymap'),
        about: read('about'),
        titles: [...document.querySelectorAll('[data-v^="settings-group-"][data-open="true"] .v-adjust__title')].map((el) => (el.textContent || '').trim()),
      });
    })()`),
  );
  report.check(
    `② 五组齐全，默认只展开「外观」（${JSON.stringify(groups)}）`,
    groups.appearance === 'true' &&
      groups.editing === 'false' &&
      groups.cache === 'false' &&
      groups.keymap === 'false' &&
      groups.about === 'false' &&
      groups.titles.join('/') === '外观',
  );
  await screenshot('settings-1-appearance.png');

  // ---- ③ 外观：切「高对比」→ 属性 + 顶栏按钮 + 分段高亮一起变 ----
  await click('[data-v="settings-theme-contrast"]');
  await sleep(400);
  // 顶栏的主题开关在「工程」下拉里（S1.1 把低频项收进去了），要先展开菜单才能读到
  await click('[data-v="project-menu"]');
  await sleep(300);
  const afterContrast = JSON.parse(
    await page.session.evaluate(`(() => {
      const toggle = document.querySelector('[data-v="theme-toggle"]');
      return JSON.stringify({
        attr: document.documentElement.getAttribute('data-theme'),
        topbarPressed: toggle === null ? 'missing' : toggle.getAttribute('aria-pressed'),
        active: document.querySelector('[data-v="settings-theme-contrast"]')?.getAttribute('data-active'),
      });
    })()`),
  );
  await click('[data-v="project-menu"]');
  await sleep(200);
  // 高对比主题生效后的整页样子（证明「即时生效」，不是只改了个属性）
  await screenshot('settings-4-contrast.png');
  report.check(
    `③ 面板切高对比 → data-theme=${afterContrast.attr}、顶栏按钮 aria-pressed=${afterContrast.topbarPressed}、分段高亮=${afterContrast.active}`,
    afterContrast.attr === 'contrast' && afterContrast.topbarPressed === 'true' && afterContrast.active === 'true',
  );

  // ---- ④ 主题持久化：刷新后仍是高对比（主题存在 IndexedDB 的 settings store）----
  await reload('验证主题持久化');
  await click('[data-v="left-tab-settings"]');
  const afterReloadTheme = await page.session.evaluate("document.documentElement.getAttribute('data-theme')");
  report.check(`④ 刷新后仍是高对比（data-theme=${afterReloadTheme}）`, afterReloadTheme === 'contrast');

  // ---- ④b 切回「默认」→ 属性被移除（不是写成 default 字符串）----
  await click('[data-v="settings-theme-default"]');
  await sleep(300);
  const backDefault = await page.session.evaluate("document.documentElement.getAttribute('data-theme')");
  report.check(`④b 切回默认 → data-theme 被移除（实测 ${String(backDefault)}）`, backDefault === null);

  // ---- ⑤⑥ 缓存组：真实占用 + 打开同一个缓存弹窗 ----
  await click('[data-v="settings-group-cache-toggle"]');
  await sleep(600);
  const cacheSize = await text('[data-v="settings-cache-size"]');
  report.check(
    `⑤ 缓存组显示真实占用（「${cacheSize}」）`,
    cacheSize !== '' && cacheSize !== '读取中…' && cacheSize !== '当前环境不支持',
  );
  await screenshot('settings-2-cache.png');

  await click('[data-v="settings-cache-open"]');
  await sleep(500);
  const dialogOpen = await visible('[data-v="cache-dialog"]');
  await click('[data-v="cache-close"]');
  await sleep(300);
  const dialogClosed = await exists('[data-v="cache-dialog"]');
  report.check(
    `⑥ 「打开缓存管理」打开同一个缓存弹窗，关闭后消失（打开=${dialogOpen} / 关闭后存在=${dialogClosed}）`,
    dialogOpen === true && dialogClosed === false,
  );

  // ---- ⑦ 折叠态：刷新后保持展开，且写的是**设置面板自己的** key ----
  await reload('验证折叠态持久化');
  await click('[data-v="left-tab-settings"]');
  const collapsed = JSON.parse(
    await page.session.evaluate(`(() => {
      const el = document.querySelector('[data-v="settings-group-cache"]');
      return JSON.stringify({
        open: el === null ? 'missing' : el.getAttribute('data-open'),
        settingsKey: localStorage.getItem('veditor:settings:openGroups'),
        adjustKey: localStorage.getItem('veditor:adjust:openGroups'),
      });
    })()`),
  );
  const settingsKeyList = collapsed.settingsKey === null ? [] : JSON.parse(collapsed.settingsKey);
  const adjustKeyList = collapsed.adjustKey === null ? [] : JSON.parse(collapsed.adjustKey);
  report.check(
    `⑦ 刷新后缓存组仍是展开（data-open=${collapsed.open}），key=${collapsed.settingsKey}`,
    collapsed.open === 'true' && settingsKeyList.includes('settings:cache'),
  );
  report.check(
    `⑦b 没有污染调节面板的折叠记忆（adjust key=${collapsed.adjustKey}）`,
    !adjustKeyList.includes('settings:cache'),
  );

  // ---- ⑧ 编辑偏好：吸附开关与时间线工具栏是**同一个开关** ----
  await click('[data-v="settings-group-editing-toggle"]');
  await sleep(300);
  const snapBefore = JSON.parse(
    await page.session.evaluate(`(() => {
      const box = document.querySelector('[data-v="settings-snap"]');
      const bar = document.querySelector('[data-v="toggle-snap"]');
      return JSON.stringify({
        checked: box === null ? 'missing' : box.checked,
        bar: bar === null ? 'missing' : bar.getAttribute('aria-pressed'),
        prefs: localStorage.getItem('veditor:prefs'),
      });
    })()`),
  );
  await click('[data-v="settings-snap"]');
  await sleep(400);
  const snapAfter = JSON.parse(
    await page.session.evaluate(`(() => {
      const box = document.querySelector('[data-v="settings-snap"]');
      const bar = document.querySelector('[data-v="toggle-snap"]');
      return JSON.stringify({
        checked: box === null ? 'missing' : box.checked,
        bar: bar === null ? 'missing' : bar.getAttribute('aria-pressed'),
        prefs: localStorage.getItem('veditor:prefs'),
      });
    })()`),
  );
  const prefsAfter = snapAfter.prefs === null ? {} : JSON.parse(snapAfter.prefs);
  report.check(
    `⑧ 关掉吸附：复选框=${snapAfter.checked}、时间线工具栏 aria-pressed=${snapAfter.bar}、prefs.snapEnabled=${prefsAfter.snapEnabled}`,
    snapBefore.checked === true &&
      snapBefore.bar === 'true' &&
      snapAfter.checked === false &&
      snapAfter.bar === 'false' &&
      prefsAfter.snapEnabled === false,
  );

  // ---- ⑨ 吸附偏好持久化：刷新后仍是关 ----
  await reload('验证吸附持久化');
  await click('[data-v="left-tab-settings"]');
  // 刷新前编辑偏好组是展开的（折叠态会持久化）→ 先看状态再决定要不要点，
  // 否则«无脑点一下»就把刚展开的组又折回去，断言只能拿到 missing。
  const editingOpen = await page.session.evaluate(
    `document.querySelector('[data-v="settings-group-editing"]')?.getAttribute('data-open')`,
  );
  if (editingOpen !== 'true') await click('[data-v="settings-group-editing-toggle"]');
  await sleep(300);
  const snapRestored = JSON.parse(
    await page.session.evaluate(`(() => {
      const box = document.querySelector('[data-v="settings-snap"]');
      const bar = document.querySelector('[data-v="toggle-snap"]');
      return JSON.stringify({
        checked: box === null ? 'missing' : box.checked,
        bar: bar === null ? 'missing' : bar.getAttribute('aria-pressed'),
      });
    })()`),
  );
  report.check(
    `⑨ 刷新后吸附仍是关（复选框=${snapRestored.checked} / 工具栏=${snapRestored.bar}）`,
    snapRestored.checked === false && snapRestored.bar === 'false',
  );

  // ---- ⑩ 关于组：版本号与 package.json 一致、隐私说明、构建时间 ----
  await click('[data-v="settings-group-about-toggle"]');
  await sleep(400);
  const about = JSON.parse(
    await page.session.evaluate(`(() => {
      const read = (id) => {
        const el = document.querySelector('[data-v="' + id + '"]');
        return el === null ? '' : (el.textContent || '').trim();
      };
      return JSON.stringify({ version: read('settings-version'), build: read('settings-build'), privacy: read('settings-privacy') });
    })()`),
  );
  report.check(
    `⑩ 版本号取自 package.json（实测「${about.version}」，期望「${PKG.version}」）`,
    about.version === PKG.version,
  );
  report.check(
    `⑩b 构建时间已显示（「${about.build}」）`,
    about.build !== '' && about.build !== '—',
  );
  report.check(
    `⑩c 隐私说明写明"素材不会上传"（含「不会上传」=${about.privacy.includes('不会上传')}）`,
    about.privacy.includes('不会上传') && about.privacy.includes('不发送画面与音频'),
  );

  // ---- ⑪ 清空本地数据：先改个工程名，作为"草稿真被删掉"的证据 ----
  await page.session.evaluate(`document.querySelector('[data-v="project-name"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await sleep(250);
  await page.session.evaluate(`(() => {
    const el = document.querySelector('[data-v="project-name-input"]');
    if (el === null) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '清空测试工程');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(250);
  await page.session.evaluate(`document.querySelector('[data-v="project-name-input"]').blur()`);
  await sleep(1600); // 等自动保存落库
  const renamed = await text('[data-v="project-name"]');
  report.check(`⑪ 工程已改名为「${renamed}」（作为草稿存在的证据）`, renamed === '清空测试工程');

  // 点一次「清空本地数据」：只弹确认块，**不能**直接清
  await click('[data-v="settings-clear"]');
  await sleep(300);
  const confirmUi = JSON.parse(
    await page.session.evaluate(`(() => {
      const box = document.querySelector('[data-v="settings-clear-confirm"]');
      return JSON.stringify({
        shown: box !== null,
        prefs: localStorage.getItem('veditor:prefs') === null ? 'null' : 'kept',
        text: box === null ? '' : (box.textContent || '').replace(/\\s+/g, ' ').trim(),
      });
    })()`),
  );
  report.check(
    `⑪b 只弹二次确认、数据仍原样（prefs=${confirmUi.prefs}）`,
    confirmUi.shown === true && confirmUi.prefs === 'kept',
  );
  report.check(
    `⑪c 确认块说清影响范围（草稿/偏好/缓存 + 原文件不受影响）`,
    confirmUi.text.includes('工程草稿') &&
      confirmUi.text.includes('界面偏好') &&
      confirmUi.text.includes('素材缓存') &&
      confirmUi.text.includes('原文件不受影响'),
  );
  await screenshot('settings-3-confirm.png');

  // 取消 → 确认块消失、数据还在
  await click('[data-v="settings-clear-cancel"]');
  await sleep(300);
  const afterCancel = JSON.parse(
    await page.session.evaluate(`(() => {
      return JSON.stringify({
        box: document.querySelector('[data-v="settings-clear-confirm"]') !== null,
        button: document.querySelector('[data-v="settings-clear"]') !== null,
        prefs: localStorage.getItem('veditor:prefs') === null ? 'null' : 'kept',
      });
    })()`),
  );
  report.check(
    `⑪d 取消后回到未确认态，数据没动（confirm=${afterCancel.box} / 按钮=${afterCancel.button} / prefs=${afterCancel.prefs}）`,
    afterCancel.box === false && afterCancel.button === true && afterCancel.prefs === 'kept',
  );

  // ---- ⑫ 真确认：页面自动刷新，偏好清空、工程名回到默认 ----
  await click('[data-v="settings-clear"]');
  await sleep(250);
  await click('[data-v="settings-clear-do"]');
  await sleep(2500);
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 30000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length === 1', 30000);
  await sleep(1200);
  const cleared = JSON.parse(
    await page.session.evaluate(`(() => {
      const prefs = localStorage.getItem('veditor:prefs');
      const keys = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key !== null && key.startsWith('veditor:')) keys.push(key);
      }
      return JSON.stringify({
        prefs: prefs === null ? 'null' : prefs,
        keys,
        name: (document.querySelector('[data-v="project-name"]')?.textContent || '').trim(),
        theme: document.documentElement.getAttribute('data-theme'),
      });
    })()`),
  );
  report.check(
    `⑫ 清空后 veditor:prefs 已删（keys=${JSON.stringify(cleared.keys)}）`,
    cleared.prefs === 'null',
  );
  report.check(
    `⑫b 工程草稿已删除：工程名回到「未命名工程」（实测「${cleared.name}」）`,
    cleared.name === '未命名工程',
  );
  report.check(
    `⑫c 主题（存在 IndexedDB）一并重置（data-theme=${String(cleared.theme)}）`,
    cleared.theme === null || cleared.theme === 'default',
  );

  // ---- ⑬ 全程无错误条 ----
  const errors = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.errors())'));
  report.check(`⑬ 全程没有错误条（${errors.length} 条）`, errors.length === 0);
} finally {
  report.summary('S2：设置面板（外观 / 编辑偏好 / 缓存 / 快捷键 / 关于）');
  await page.close();
  dev.kill();
  server.close();
}
