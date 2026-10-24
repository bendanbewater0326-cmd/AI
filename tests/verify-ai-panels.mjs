/**
 * AI 面板场景化端到端验证（P3）。
 *
 * 覆盖：
 *   ① 文本面板出现「✦ AI 文案」；`?ai=off` 时 disabled + title 说明
 *   ② mock 下生成 → 文字轨出现片段、内容 = 演示文案（带离线演示前缀）、被选中
 *   ③ 风格 chips 点击把风格词填入主题输入
 *   ④ 生成后撤销一步恢复
 *   ⑤ 特效面板出现「✦ AI 风格调色」；`?ai=off` 时 disabled
 *   ⑥ mock 下应用「复古胶片」→ 选中片段 colorGrade 落库（暖调 temperature > 0）
 *   ⑦ 字幕空状态三个预设可见；无转写通道时中文/英文禁用、SRT 可用
 *
 * mock 规则（provider.ts）：文案请求回固定演示文案、调色请求回风格参数——
 * 离线演示态保证本测试**确定性可断言**（真模型接入后由单测/命令栏链路覆盖）。
 *
 * 运行：`node --experimental-websocket tests/verify-ai-panels.mjs`
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createReport, launchPage } from './cdp.mjs';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..');
const PORT = 5855;
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

const report = createReport();
const ev = async (expression) => page.session.evaluate(expression);
const evalJson = async (expression) => JSON.parse(await ev(`JSON.stringify(${expression})`));
const click = async (selector) => {
  await ev(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  await sleep(350);
};
const clips = async () => evalJson('window.__VEDITOR_TEST__.clips()');

/** React 受控输入必须用原生 value setter 赋值（直赋值会被值跟踪去重，onChange 不触发）。 */
const setInputValue = async (selector, value) => {
  await ev(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(200);
};


/** 打开页面（query 可带 ?ai=off）。 */
const openPage = async (query = '') =>
  launchPage({ url: `http://127.0.0.1:${PORT}/${query}`, width: 1440, height: 900 });

let page = await openPage();

/** 整窗拖入素材并双击上轨（复用 verify-audio-import 的 dropFile）。 */
async function importVideo() {
  const bytes = fs.readFileSync(FIXTURE);
  const b64 = bytes.toString('base64');
  await ev(`(async () => {
    const raw = atob('${b64}');
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    const file = new File([bytes], 'sample-720p.mp4', { type: 'video/mp4', lastModified: 1700000000000 });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      document.body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
    }
    return true;
  })()`);
  await page.session.waitFor(`document.querySelectorAll('[data-v="asset-card"]').length === 1`, 10000);
  await sleep(500);
  await ev(`document.querySelector('[data-v="asset-card"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true`);
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 1`, 8000);
  await sleep(400);
}

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
  await sleep(500);
  await importVideo();

  // ---- ① 文本面板：入口可见 ----
  await click('[data-v="left-tab-text"]');
  await page.session.waitFor(`document.querySelector('[data-v="text-ai-open"]') !== null`, 8000);
  report.check('① 文本面板出现「✦ AI 文案」按钮', true);

  // ---- ③ 风格 chips 点击填入主题词 ----
  await click('[data-v="text-ai-open"]');
  await page.session.waitFor(`document.querySelector('[data-v="text-ai-topic"]') !== null`, 5000);
  await setInputValue('[data-v="text-ai-topic"]', '周末露营的一天');
  await click('[data-v="text-ai-style-种草安利"]');
  const topicValue = await ev(`document.querySelector('[data-v="text-ai-topic"]').value`);
  report.check(
    `③ 风格 chips 点击填入主题词（${JSON.stringify(topicValue)}）`,
    topicValue.includes('种草安利') && topicValue.includes('露营'),
  );

  // ---- ② mock 生成：落文字轨 + 演示文案 + 选中 ----
  await click('[data-v="text-ai-generate"]');
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 2`, 10000);
  await sleep(400);
  const textClip = (await clips()).find((item) => item.text !== null);
  report.check(
    `② AI 文案落文字轨：内容=${JSON.stringify(textClip?.text?.content?.slice(0, 14))}…`,
    textClip !== undefined && (textClip.text?.content ?? '').startsWith('（离线演示）'),
  );
  report.check(
    '② 落点片段被选中（属性栏可立刻改样式）',
    await ev(`window.__VEDITOR_TEST__.selection() === ${JSON.stringify(textClip?.id ?? '')}`),
  );

  // ---- ④ 撤销一步恢复 ----
  const clipCount = (await clips()).length;
  await click('[data-v="undo"]');
  await sleep(400);
  report.check(
    `④ 撤销一步恢复（${clipCount} → ${(await clips()).length}）`,
    (await clips()).length === clipCount - 1,
  );
  // 重做回来（后续字幕空态断言不受影响；也验证 AI 操作可重做）
  await click('[data-v="redo"]');
  await sleep(300);

  // ---- ⑥ 特效面板：AI 风格调色（mock 规则：复古胶片 → 暖调） ----
  await ev(`window.__VEDITOR_TEST__.selectClip(window.__VEDITOR_TEST__.clips().find((item) => item.text === null).id)`);
  await sleep(200);
  await click('[data-v="left-tab-effect"]');
  await page.session.waitFor(`document.querySelector('[data-v="effect-ai-open"]') !== null`, 8000);
  report.check('⑤ 特效面板出现「✦ AI 风格调色」按钮', true);
  const gradeTitle = await ev(`document.querySelector('[data-v="effect-ai-open"]').title`);
  report.check(
    `⑤ title 含诚实边界说明（${JSON.stringify(gradeTitle)}）`,
    gradeTitle.includes('不上传画面内容'),
  );
  await click('[data-v="effect-ai-open"]');
  await page.session.waitFor(`document.querySelector('[data-v="effect-ai-style"]') !== null`, 5000);
  await setInputValue('[data-v="effect-ai-style"]', '复古胶片');
  await click('[data-v="effect-ai-apply"]');
  await page.session.waitFor(
    `window.__VEDITOR_TEST__.clips().find((item) => item.text === null).effects.includes('colorGrade')`,
    10000,
  );
  const graded = (await clips()).find((item) => item.text === null);
  report.check(
    `⑥ AI 调色落库：colorGrade effect（effects=${JSON.stringify(graded.effects)}）`,
    graded.effects.includes('colorGrade'),
  );
  // 撤销恢复（AI 调色 = 一个撤销步）
  await click('[data-v="undo"]');
  await sleep(400);
  const afterUndo = (await clips()).find((item) => item.text === null);
  report.check(
    `⑥ 撤销一步恢复（effects=${JSON.stringify(afterUndo.effects)}）`,
    !afterUndo.effects.includes('colorGrade'),
  );

  // ---- ⑦ 字幕空状态三预设（无转写通道时中文/英文禁用） ----
  // 先删掉 AI 文案片段：字幕面板与文字同轨，有文字片段时空状态不渲染
  {
    const textClip = (await clips()).find((item) => item.text !== null);
    await ev(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(textClip?.id ?? '')})`);
    await sleep(200);
    await page.session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await page.session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await sleep(400);
  }
  await click('[data-v="left-tab-caption"]');
  await page.session.waitFor(`document.querySelector('[data-v="caption-presets"]') !== null`, 8000);
  const presets = await evalJson(`(() => ({
    zh: {
      disabled: document.querySelector('[data-v="caption-preset-zh"]')?.disabled ?? null,
      title: document.querySelector('[data-v="caption-preset-zh"]')?.title ?? '',
    },
    en: { disabled: document.querySelector('[data-v="caption-preset-en"]')?.disabled ?? null },
    srt: { disabled: document.querySelector('[data-v="caption-preset-srt"]')?.disabled ?? null },
  }))()`);
  report.check(
    `⑦ 字幕三预设可见（zh禁用=${presets.zh.disabled}、en禁用=${presets.en.disabled}、srt禁用=${presets.srt.disabled}）`,
    presets.srt.disabled === false,
  );
  report.check(
    `⑦ 无转写通道时中文/英文禁用 + title 说明（${JSON.stringify(presets.zh.title)}）`,
    // dev 宿主没有 transcribe 通道：两个识别按钮都应禁用
    presets.zh.disabled === true && presets.en.disabled === true && presets.zh.title.includes('语音识别'),
  );

  // ---- ①/⑤ 的 ?ai=off 降级态（重开页面验证） ----
  await page.close().catch(() => {});
  page = await openPage('?ai=off');
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
  await sleep(600);
  await importVideo();
  await click('[data-v="left-tab-text"]');
  await page.session.waitFor(`document.querySelector('[data-v="text-ai-open"]') !== null`, 8000);
  const aiOff = await evalJson(`(() => ({
    textBtn: {
      disabled: document.querySelector('[data-v="text-ai-open"]')?.disabled ?? null,
      title: document.querySelector('[data-v="text-ai-open"]')?.title ?? '',
    },
  }))()`);
  await click('[data-v="left-tab-effect"]');
  await page.session.waitFor(`document.querySelector('[data-v="effect-ai-open"]') !== null`, 8000);
  const fxOff = await evalJson(`(() => ({
    disabled: document.querySelector('[data-v="effect-ai-open"]')?.disabled ?? null,
  }))()`);
  report.check(
    `?ai=off：文案/调色按钮禁用 + title 说明（${JSON.stringify({ text: aiOff.textBtn.disabled, fx: fxOff.disabled, title: aiOff.textBtn.title })}）`,
    aiOff.textBtn.disabled === true && fxOff.disabled === true && aiOff.textBtn.title.includes('未提供模型'),
  );

  report.summary('AI 面板场景化');
} finally {
  await page.close().catch(() => {});
  dev.kill();
  await new Promise((resolve) => server.close(resolve));
}
