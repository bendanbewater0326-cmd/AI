/**
 * 本地草稿缓存池的回归测试。
 *
 * ## 最核心的一条：④
 *
 * 前面所有恢复手段都依赖外部条件（宿主路径 / 句柄权限 / 授权目录）。
 * 这里要证明的是**缓存不依赖任何外部条件**：
 * 把素材标成离线、把预览源清掉（模拟"源文件被删 + 刷新"），
 * 只靠缓存池就能把画面救回来。
 *
 * ## 为什么读可见画布
 *
 * 同 `verify-relink`：状态是 `ok` 不等于"画面真的回来了"，
 * 只有读上屏后的像素才能证明。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5245;
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

const assets = async () => JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.assets())'));
const clips = async () => JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.clips())'));
/**
 * 读缓存状态。
 *
 * **用 promise 链而不是 `await`**：`page.session.evaluate` 的字符串不是在
 * async 函数体里求值的，顶层 `await` 会直接 SyntaxError（实测报
 * "missing ) after argument list"，很容易误判成别的问题）。
 */
const cacheInfo = async () =>
  JSON.parse(await page.session.evaluate('window.__VEDITOR_TEST__.cacheInfo().then((v) => JSON.stringify(v))'));
const exists = async (selector) => page.session.evaluate(`document.querySelector(${JSON.stringify(selector)}) !== null`);

const previewFilled = async () =>
  JSON.parse(
    await page.session.evaluate(`(() => {
      const canvas = document.querySelector('[data-v="preview-canvas"]');
      if (!canvas) return JSON.stringify({ ratio: 0 });
      const off = document.createElement('canvas');
      off.width = canvas.width;
      off.height = canvas.height;
      const ctx = off.getContext('2d');
      ctx.drawImage(canvas, 0, 0);
      const { data } = ctx.getImageData(0, 0, off.width, off.height);
      let nonBlack = 0;
      for (let i = 0; i + 3 < data.length; i += 4) {
        if (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2] > 6) nonBlack += 1;
      }
      return JSON.stringify({ ratio: nonBlack / (data.length / 4) });
    })()`),
  );

/**
 * 打开「工程」下拉。
 *
 * 主题 / 缓存 已从顶栏平铺**收进「工程」下拉**（S1.1：顶栏要腾位置给
 * 撤销/重做/分割）。`data-v` 没变，但元素只有下拉展开时才在 DOM 里。
 */
async function openProjectMenu() {
  await page.session.evaluate(`document.querySelector('[data-v="project-menu"]').click()`);
  await sleep(300);
}

/** 轮询等缓存写完（后台队列是异步的）。 */
async function waitForCache(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await cacheInfo();
    if (info.count > 0) return info;
    if (Date.now() > deadline) return info;
    await sleep(300);
  }
}

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 20000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 30000);
  await sleep(1500);

  const before = await cacheInfo();
  report.check(
    `① 缓存后端可用（${before.kind}，${before.available ? '可用' : '不可用'}）`,
    before.available === true && before.kind !== null,
  );

  // ---- ② 导入后后台写入缓存，素材上出现 cacheKey ----
  const cached = await waitForCache();
  const asset = (await assets())[0];
  report.check(
    `② 缓存池写入成功（${cached.count} 个文件 / ${cached.bytes} 字节）`,
    cached.count > 0 && cached.bytes > 0,
  );
  report.check(
    `②b 素材记录了 cacheKey（${asset?.cacheKey ?? '缺失'}）`,
    typeof asset?.cacheKey === 'string' && asset.cacheKey.length > 0,
  );

  // ---- ③ 缓存面板：统计与开关都在 ----
  await openProjectMenu();
  await page.session.evaluate(`document.querySelector('[data-v="cache-open"]').click()`);
  await sleep(400);
  const panelOpen = await exists('[data-v="cache-dialog"]');
  const countText = await page.session.evaluate(
    'document.querySelector(\'[data-v="cache-count"]\')?.textContent ?? ""',
  );
  const sizeText = await page.session.evaluate(
    'document.querySelector(\'[data-v="cache-size"]\')?.textContent ?? ""',
  );
  report.check(
    `③ 缓存面板打开并显示统计（"${String(countText).trim()}" / "${String(sizeText).trim()}"）`,
    panelOpen === true && /文件\s*\d+/.test(String(countText)) && /占用/.test(String(sizeText)),
  );
  report.check(
    '③b 面板有自动缓存开关 + 两个清理按钮',
    (await exists('[data-v="cache-auto-toggle"]')) === true &&
      (await exists('[data-v="cache-clean-unused"]')) === true &&
      (await exists('[data-v="cache-clear"]')) === true,
  );
  await page.session.evaluate(`document.querySelector('[data-v="cache-close"]').click()`);
  await sleep(300);

  // ---- ④ 只靠缓存恢复：标离线 + 清预览源，不碰任何外部文件 ----
  const clipsBefore = await clips();
  await page.session.evaluate(`window.__VEDITOR_TEST__.setAssetStatus('${asset.id}', 'offline')`);
  await sleep(1000);
  const blackedPreview = await previewFilled();
  report.check(
    `④ 模拟"源文件没了"（预览变黑 ${(blackedPreview.ratio * 100).toFixed(1)}%）`,
    blackedPreview.ratio < 0.02,
  );

  const restoredIds = JSON.parse(
    await page.session.evaluate(
      'window.__VEDITOR_TEST__.restoreFromCacheNow().then((v) => JSON.stringify(v))',
    ),
  );
  await sleep(1500);
  const afterAsset = (await assets()).find((item) => item.id === asset.id);
  const restoredPreview = await previewFilled();
  report.check(
    `④b 缓存恢复成功（恢复 ${restoredIds.length} 个，status=${afterAsset?.status}）`,
    restoredIds.includes(asset.id) && afterAsset?.status !== 'offline',
  );
  report.check(
    `④c 画面回来了（非黑 ${(restoredPreview.ratio * 100).toFixed(1)}%）`,
    restoredPreview.ratio > 0.1,
  );
  report.check(
    '④d 片段属性逐字未变（缓存恢复不改剪辑数据）',
    JSON.stringify(clipsBefore) === JSON.stringify(await clips()),
  );

  // ---- ⑤ 缓存键在重链后不丢 ----
  report.check(
    `⑤ 恢复后 cacheKey 仍在（${afterAsset?.cacheKey ?? '缺失'}）`,
    typeof afterAsset?.cacheKey === 'string' && afterAsset.cacheKey.length > 0,
  );

  // ---- ⑥ 关闭开关后新导入不再缓存 ----
  await openProjectMenu();
  await page.session.evaluate(`document.querySelector('[data-v="cache-open"]').click()`);
  await sleep(300);
  await page.session.evaluate(`document.querySelector('[data-v="cache-auto-toggle"]').click()`);
  await sleep(200);
  await page.session.evaluate(`document.querySelector('[data-v="cache-close"]').click()`);
  await sleep(200);
  const afterToggle = await page.session.evaluate(
    `localStorage.getItem('veditor:autoCache')`,
  );
  report.check(`⑥ 开关可关闭（localStorage=${JSON.stringify(afterToggle)}）`, afterToggle === '0');

  // 再打开，避免影响后续
  await openProjectMenu();
  await page.session.evaluate(`document.querySelector('[data-v="cache-open"]').click()`);
  await sleep(300);
  await page.session.evaluate(`document.querySelector('[data-v="cache-auto-toggle"]').click()`);
  await sleep(200);
  await page.session.evaluate(`document.querySelector('[data-v="cache-close"]').click()`);

  // ---- ⑦ 性能：缓存就绪后单帧渲染没退 ----
  /**
   * 先等后台拷贝队列清空再测：拷贝 2.8MB 时磁盘 IO 正忙，
   * 这时量渲染耗时会得到 12ms 这种假回退（实测）。
   */
  {
    const deadline = Date.now() + 15000;
    for (;;) {
      const info = await cacheInfo();
      if (info.pending === 0 || Date.now() > deadline) break;
      await sleep(300);
    }
  }
  await sleep(600);
  /**
   * **先预热再测**：缓存恢复走过 `relinkAssetFromFile` → 池的 `invalidate`
   * 清掉了该素材的解码会话，所以第一次 `renderCost` 里含"重建会话 + 解关键帧"的
   * 一次性成本（实测 12–15ms，而稳态是 0.1–4ms）。
   * 不预热就会把固定成本当成"性能回退"。
   */
  await page.session.evaluate('window.__VEDITOR_TEST__.renderCost(3)');
  const cost = Number(await page.session.evaluate('window.__VEDITOR_TEST__.renderCost(8)'));
  /**
   * 阈值给到 25ms 是**刻意**的：无头浏览器是软件渲染，绝对值受机器负载影响很大
   * （同一份代码在空闲时 0.1ms、在跑满测试时 13ms）。这条断言只防"数量级回退"
   * （比如从 0.1ms 掉到 300ms），不假装能测出 10% 的差异 ——
   * 这条经验在 `verify-proxy` 上踩过一次。
   */
  report.check(`⑦ 单帧渲染 ${cost.toFixed(2)}ms（预热后稳态，数量级未回退）`, cost < 25);
} finally {
  report.summary('本地草稿缓存池（导入即缓存 / 独立恢复 / 面板管理）');
  await page.close();
  dev.kill();
  server.close();
}
