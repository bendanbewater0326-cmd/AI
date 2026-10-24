/**
 * 创作模板端到端验证（P1，2026-10-25）。
 *
 * 覆盖：
 *   ① 文本面板顶部出现「创作模板」行（4 chips 全中文）
 *   ② 有素材套「Vlog 开场」：文字×2 + 特效 + 转场全部落库（单 dispatch）
 *   ③ 撤销一步完整恢复（单撤销步）
 *   ④ 空工程套「好物展示」：降级只落文字 + 可读提示
 *   ⑤ 结尾模板锚点=时间线末尾
 *
 * 运行：`node --experimental-websocket tests/verify-templates.mjs`
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5867;
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
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('dev 未就绪')), 20000);
  dev.stdout.on('data', (chunk) => {
    if (String(chunk).includes(`127.0.0.1:${PORT}`)) {
      clearTimeout(timer);
      resolve();
    }
  });
});

let page = await launchPage({ url: `http://127.0.0.1:${PORT}/`, width: 1440, height: 900 });
const report = createReport();
const ev = async (expression) => page.session.evaluate(expression);
const evalJson = async (expression) => JSON.parse(await ev(`JSON.stringify(${expression})`));
const click = async (selector) => {
  await ev(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  await sleep(350);
};

async function importVideo() {
  const bytes = fs.readFileSync(FIXTURE);
  const b64 = bytes.toString('base64');
  await ev(`(async () => {
    const raw = atob('${b64}');
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    const file = new File([bytes], 's.mp4', { type: 'video/mp4', lastModified: 1700000000000 });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      document.body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
    }
    return true;
  })()`);
  await page.session.waitFor(`document.querySelectorAll('[data-v="asset-card"]').length === 1`, 10000);
  await sleep(600);
  await ev(`document.querySelector('[data-v="asset-card"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true`);
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 1`, 8000);
  await sleep(400);
}

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
  await sleep(500);
  await importVideo();

  // ---- ① 入口可见 ----
  await click('[data-v="left-tab-text"]');
  await page.session.waitFor(`document.querySelector('[data-v="template-row"]') !== null`, 8000);
  const chips = await evalJson(`Array.from(document.querySelectorAll('[data-v="template-row"] .v-textpanel__tplchip')).map((item) => ({ id: item.getAttribute('data-v'), name: item.textContent.trim() }))`);
  report.check(
    `① 创作模板 4 chips（${chips.map((item) => item.name).join('/')}）`,
    chips.length === 4 && chips.every((item) => /[\u4e00-\u9fa5]/.test(item.name)),
  );

  // ---- ② 套 Vlog 开场 ----
  await click('[data-v="template-tpl-vlog-open"]');
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 3`, 8000);
  await sleep(400);
  const state = await evalJson(`(() => {
    const texts = window.__VEDITOR_TEST__.clips().filter((item) => item.text !== null);
    const video = window.__VEDITOR_TEST__.clips().find((item) => item.trackId === 'trk_V1');
    return {
      textCount: texts.length,
      firstText: texts[0]?.text?.content ?? '',
      firstStart: texts[0]?.startFrame ?? -1,
      effects: video?.effects ?? [],
      transitionIn: video?.transitions?.in ?? null,
    };
  })()`);
  report.check(
    `② Vlog 开场：文字×2（首条「${state.firstText}」@${state.firstStart}）+ 特效${state.effects.join(',')} + 转场${state.transitionIn}`,
    state.textCount === 2 && state.firstStart === 0 && state.effects.includes('colorGrade') && state.transitionIn === 'fadeIn',
  );

  // ---- ③ 撤销一步完整恢复 ----
  const before = (await evalJson('window.__VEDITOR_TEST__.clips()')).length;
  await click('[data-v="undo"]');
  await sleep(400);
  const after = (await evalJson('window.__VEDITOR_TEST__.clips()')).length;
  const videoAfter = await evalJson(`(() => {
    const video = window.__VEDITOR_TEST__.clips().find((item) => item.trackId === 'trk_V1');
    return { effects: video.effects, transitionIn: video.transitions?.in ?? null };
  })()`);
  report.check(
    `③ 撤销一步：${before} → ${after} 片段、特效转场清空（${JSON.stringify(videoAfter)}）`,
    after === 1 && videoAfter.effects.length === 0 && videoAfter.transitionIn === null,
  );

  // ---- ⑤ 结尾模板锚点=末尾 ----
  await click('[data-v="template-tpl-short-end"]');
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 2`, 8000);
  await sleep(300);
  const endText = await evalJson(`(() => {
    const text = window.__VEDITOR_TEST__.clips().find((item) => item.text !== null);
    const video = window.__VEDITOR_TEST__.clips().find((item) => item.trackId === 'trk_V1');
    return { start: text.startFrame, transitionOut: video.transitions?.out ?? null };
  })()`);
  report.check(
    `⑤ 结尾模板：文字@${endText.start}（末尾 240−30）+ 尾段淡出=${endText.transitionOut}`,
    endText.start === 210 && endText.transitionOut === 'fadeOut',
  );

  // ---- ④ 空工程降级（重开页面） ----
  await page.close().catch(() => {});
  const page2 = await launchPage({ url: `http://127.0.0.1:${PORT}/`, width: 1440, height: 900 });
  page = page2;
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
  await sleep(600);
  await click('[data-v="left-tab-text"]');
  await page.session.waitFor(`document.querySelector('[data-v="template-tpl-goods"]') !== null`, 8000);
  await click('[data-v="template-tpl-goods"]');
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 1`, 8000);
  await sleep(400);
  const degraded = await evalJson(`(() => {
    const text = window.__VEDITOR_TEST__.clips()[0];
    const errors = window.__VEDITOR_TEST__.errors();
    return { hasText: text?.text?.content ?? '', errors: errors.slice(-1).map((item) => item.message) };
  })()`);
  report.check(
    `④ 空工程降级：文字落轨（${degraded.hasText.slice(0, 8)}…）+ 可读提示（${JSON.stringify(degraded.errors)}）`,
    degraded.hasText.includes('好物') && degraded.errors.some((item) => item.includes('没有视频片段')),
  );

  report.summary('创作模板');
} finally {
  await page.close().catch(() => {});
  dev.kill();
  await new Promise((resolve) => server.close(resolve));
}
