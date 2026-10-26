/**
 * GIF 规格预设 E2E（P1，2026-10-26）。
 *
 * ## 这文件在防什么
 *
 * 1. **三档预设真的能一键设值**（宽度 + 帧率同时变，不是只改一个）
 * 2. **`select` 里有对应选项**——预设设 360/240/20 时，若 `<option>` 缺失，
 *    `select` 会显示空白（值设进去了但用户看不见）。这条最容易被漏测。
 * 3. **高亮是"反查"出来的**（width+fps 匹配），不是另存一个 `selectedPreset`。
 *    所以手动改输入框时要能自动落到「自定义」——这条证明没有第二份状态。
 * 4. **GIF 预设不碰工程参数**（与 MP4 预设的本质区别）：
 *    切完 GIF 预设后 `doc.width/height/fpsMilli` 必须原封不动。
 * 5. **有片段时不弹确认**（GIF 参数零副作用，弹窗才是 bug）。
 *
 * 运行：`node tests/verify-gif-preset.mjs`
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5870;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'sample-720p.mp4');
assert(fs.existsSync(FIXTURE), '缺 sample-720p.mp4');

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
await new Promise((resolve) => {
  dev.stdout.on('data', (chunk) => {
    if (String(chunk).includes(`127.0.0.1:${PORT}`)) resolve();
  });
});

const report = createReport();
const page = await launchPage({
  url: `http://127.0.0.1:${PORT}/?src=${encodeURIComponent(`${origin}/sample-720p.mp4`)}`,
  width: 1600,
  height: 950,
});

/** 读 GIF 区块的当前状态。 */
const readGif = () =>
  page.session.evaluate(`(() => {
    const width = document.querySelector('[data-v="export-gif-width"]');
    const fps = document.querySelector('[data-v="export-gif-fps"]');
    const chips = Array.from(document.querySelectorAll('[data-v^="export-gif-preset-"]'));
    return JSON.stringify({
      width: width === null ? null : Number(width.value),
      fps: fps === null ? null : Number(fps.value),
      widthOptions: width === null ? [] : Array.from(width.options).map((o) => Number(o.value)),
      fpsOptions: fps === null ? [] : Array.from(fps.options).map((o) => Number(o.value)),
      chips: chips.map((chip) => ({
        key: (chip.getAttribute('data-v') ?? '').replace('export-gif-preset-', ''),
        label: (chip.textContent ?? '').trim(),
        active: chip.getAttribute('data-active') === 'true',
        disabled: chip.disabled,
      })),
    });
  })()`).then(JSON.parse);

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
  await sleep(1200);

  // 打开导出对话框，切到 GIF
  await page.session.evaluate(`document.querySelector('[data-v="export-open"]').click()`);
  await sleep(600);
  await page.session.evaluate(`document.querySelector('[data-v="export-format-gif"]').click()`);
  await sleep(500);

  // ① 四个 chips 存在（3 预设 + 自定义）
  const initial = await readGif();
  report.check(
    `① GIF 区块有 4 个规格按钮（${initial.chips.map((chip) => chip.label).join(' / ')}）`,
    initial.chips.length === 4 &&
      initial.chips[0].label === '高清动图' &&
      initial.chips[1].label === '竖屏动图' &&
      initial.chips[2].label === '表情包' &&
      initial.chips[3].label === '自定义',
  );

  // ② 默认 480/15 不属于任何预设 → 自定义高亮（反查逻辑生效）
  report.check(
    `② 默认 480px/15fps 落在「自定义」（自定义高亮=${initial.chips[3].active}，预设高亮数=${initial.chips.filter((chip) => chip.active).length - (initial.chips[3].active ? 1 : 0)}）`,
    initial.width === 480 &&
      initial.fps === 15 &&
      initial.chips[3].active === true &&
      initial.chips.slice(0, 3).every((chip) => chip.active === false),
  );

  // ③ `select` 里必须有预设用到的选项（否则设了值显示空白）
  report.check(
    `③ 宽度选项含 240/360/720、帧率选项含 20（宽 ${initial.widthOptions.join('/')} · 帧 ${initial.fpsOptions.join('/')}）`,
    initial.widthOptions.includes(240) &&
      initial.widthOptions.includes(360) &&
      initial.widthOptions.includes(720) &&
      initial.fpsOptions.includes(20),
  );

  // ④ 三档预设逐一点击：宽度 + 帧率同时变，且高亮跟随
  const cases = [
    { key: 'hd', label: '高清动图', width: 720, fps: 20 },
    { key: 'vertical', label: '竖屏动图', width: 360, fps: 15 },
    { key: 'sticker', label: '表情包', width: 240, fps: 10 },
  ];
  for (const item of cases) {
    await page.session.evaluate(`document.querySelector('[data-v="export-gif-preset-${item.key}"]').click()`);
    await sleep(300);
    const state = await readGif();
    const activeChip = state.chips.find((chip) => chip.active);
    report.check(
      `④ 点「${item.label}」→ ${state.width}px / ${state.fps}fps，高亮=${activeChip?.label ?? '无'}`,
      state.width === item.width &&
        state.fps === item.fps &&
        activeChip !== undefined &&
        activeChip.key === item.key,
    );
  }

  // ⑤ 手动改输入框 → 预设自动全灭、落到自定义（证明只有一份状态）
  await page.session.evaluate(`(() => {
    const el = document.querySelector('[data-v="export-gif-width"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(el, '1080');
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  const afterManual = await readGif();
  report.check(
    `⑤ 手动改成 1080 后落到「自定义」（预设高亮数=${afterManual.chips.slice(0, 3).filter((chip) => chip.active).length}，自定义=${afterManual.chips[3].active}）`,
    afterManual.width === 1080 &&
      afterManual.chips.slice(0, 3).every((chip) => chip.active === false) &&
      afterManual.chips[3].active === true,
  );

  /*
   * ⑥ GIF 预设**零副作用**：用 `docVersion()` 而不是读宽高。
   *
   * 版本号只在 doc 真的变更时递增（`store.getState().version`），
   * 所以"版本号不变"比"宽高没变"更本质——后者只能证明三个字段没动，
   * 前者能证明**整份 doc 一个字节都没改**（这正是 GIF 预设与 MP4 预设的根本区别）。
   */
  const versionBefore = await page.session.evaluate(`window.__VEDITOR_TEST__.docVersion()`);
  await page.session.evaluate(`document.querySelector('[data-v="export-gif-preset-hd"]').click()`);
  await sleep(400);
  const versionAfter = await page.session.evaluate(`window.__VEDITOR_TEST__.docVersion()`);
  report.check(
    `⑥ 切 GIF 预设不动 doc（版本号 ${versionBefore} → ${versionAfter}）`,
    versionBefore === versionAfter,
  );

  // ⑦ 有片段时切 GIF 预设不弹确认（零副作用，弹窗才是 bug）
  const dialogAppeared = await page.session.evaluate(`(() => {
    let appeared = false;
    const original = window.confirm;
    window.confirm = () => { appeared = true; return true; };
    document.querySelector('[data-v="export-gif-preset-sticker"]').click();
    window.confirm = original;
    return appeared;
  })()`);
  report.check(`⑦ 有片段时切 GIF 预设不弹确认（confirm 被调用=${dialogAppeared}）`, dialogAppeared === false);

  // 截图（对话框里的 GIF 预设）
  const shot = await page.session.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.join(ROOT, 'tests', 'screenshots'), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, 'tests', 'screenshots', 'export-gif-presets.png'),
    Buffer.from(shot.data, 'base64'),
  );
  console.log('  · 截图：tests/screenshots/export-gif-presets.png');
} finally {
  await page.close();
  dev.kill();
  await new Promise((resolve) => server.close(resolve));
}

report.summary('GIF 规格预设');
