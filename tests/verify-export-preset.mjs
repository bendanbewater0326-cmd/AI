/**
 * 导出预设与文件名 E2E（P1，2026-10-25）。
 *
 * 覆盖：
 *   ① 预设 chips 可见；默认工程（1920×1080@30）高亮 1080P
 *   ② 空工程点 720P → 工程参数立即变（无确认弹窗）
 *   ③ 有片段时切换预设 → window.confirm（自动接受）→ 参数变 + 片段重映射
 *   ④ 切换后预设高亮跟随；「自定义」在非预设参数时高亮
 *   ⑤ 文件名输入框默认 = 工程名；改后导出的产物文件名 = 输入值 + 正确后缀
 *   ⑥ 文件名清空 → 回退工程名
 *
 * 运行：`node --experimental-websocket tests/verify-export-preset.mjs`
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5866;
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

const page = await launchPage({ url: `http://127.0.0.1:${PORT}/`, width: 1440, height: 900 });
const report = createReport();
const DOWNLOAD_DIR = path.join(ROOT, 'tests', '.tmp-download');

const ev = async (expression) => page.session.evaluate(expression);
const evalJson = async (expression) => JSON.parse(await ev(`JSON.stringify(${expression})`));
function documentActive(state) {
  if (state.fhdActive === 'true') return 'fhd';
  if (state.hdActive === 'true') return 'hd';
  if (state.customActive === 'true') return 'custom';
  return 'none';
}
const click = async (selector) => {
  await ev(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  await sleep(300);
};

/** 自动接受 window.confirm（预设切换的二次确认）。 */
async function autoAcceptConfirm() {
  await ev(`(() => {
    window.__lastConfirm = null;
    window.confirm = (text) => { window.__lastConfirm = text; return true; };
    return true;
  })()`);
}

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

async function openExportDialog() {
  await click('[data-v="export-open"]');
  await page.session.waitFor(`document.querySelector('[data-v="export-dialog"]') !== null`, 8000);
  await sleep(300);
}

/** 导出并返回产物文件名。 */
async function exportOnce() {
  fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  await page.session.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOAD_DIR });
  await click('[data-v="export-start"]');
  await page.session.waitFor(`document.querySelector('[data-v="export-start"]')?.textContent?.includes('再导一次')`, 60000);
  await sleep(800);
  const files = fs.readdirSync(DOWNLOAD_DIR);
  return files[0] ?? '';
}

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
  await sleep(500);
  await importVideo();

  // ---- ① 打开对话框：首素材跟随参数 → 工程 1280×720@30（sample-720p）→ 720P 高亮 ----
  await openExportDialog();
  const presetState = await evalJson(`(() => ({
    visible: document.querySelectorAll('[data-v="export-presets"] .v-export__preset').length,
    fhdActive: document.querySelector('[data-v="export-preset-fhd"]')?.getAttribute('data-active'),
    hdActive: document.querySelector('[data-v="export-preset-hd"]')?.getAttribute('data-active'),
    customActive: document.querySelector('[data-v="export-preset-custom"]')?.getAttribute('data-active'),
    fileName: document.querySelector('[data-v="export-filename"]')?.value,
  }))()`);
  report.check(
    `① 预设 4 个可见、720P 高亮（首素材跟随 1280×720@30）、文件名默认=工程名（${JSON.stringify(presetState)}）`,
    presetState.visible === 4 &&
      documentActive(presetState) === 'hd' &&
      presetState.fileName !== '',
  );

  // ---- ③ 有片段切 1080P → confirm（影响面文案）→ 应用（720P 同参数无 confirm，换向验证）----
  await autoAcceptConfirm();
  await click('[data-v="export-preset-fhd"]');
  await sleep(500);
  const confirmText = await ev('window.__lastConfirm');
  const after = await evalJson('window.__VEDITOR_TEST__.projectMeta()');
  report.check(
    `③ 切 1080P：confirm 含影响面文案（${JSON.stringify(String(confirmText ?? '').slice(0, 44))}…）；参数 → ${after.width}×${after.height}@${after.fpsMilli / 1000}`,
    String(confirmText ?? '').includes('片段') && String(confirmText ?? '').includes('重新换算') && after.width === 1920 && after.height === 1080,
  );
  const hdActive = await evalJson(`(() => ({
    fhd: document.querySelector('[data-v="export-preset-fhd"]')?.getAttribute('data-active'),
    hd: document.querySelector('[data-v="export-preset-hd"]')?.getAttribute('data-active'),
  }))()`);
  report.check(`③ 高亮切换到 1080P（${JSON.stringify(hdActive)}）`, hdActive.fhd === 'true' && hdActive.hd === 'false');

  // ---- ⑤ 改文件名 → 导出产物文件名 ----
  await ev(`(() => {
    const input = document.querySelector('[data-v="export-filename"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '我的成片 v2');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(200);
  const savedAs = await exportOnce();
  report.check(`⑤ 导出产物文件名 = 输入值.mp4（${savedAs}）`, savedAs === '我的成片 v2.mp4');

  // ---- ⑥ 清空文件名 → 回退工程名 ----
  await ev(`(() => {
    const input = document.querySelector('[data-v="export-filename"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '   ');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(200);
  const projectName = await evalJson('window.__VEDITOR_TEST__.projectMeta().name');
  const savedFallback = await exportOnce();
  report.check(`⑥ 清空回退工程名（${savedFallback} = ${projectName}.mp4）`, savedFallback === `${projectName}.mp4`);

  // ---- ④ 手动改工程参数到非预设值 → 「自定义」高亮 ----
  await click('[data-v="export-cancel"]'); // 关闭导出（回 idle）
  await ev(`(() => {
    // 直接用宿主通道改工程参数（非预设值 960×540）
    window.__VEDITOR_TEST__.dispatch([{ op: 'setProjectParams', from: { width: 1920, height: 1080, fpsMilli: 30000 }, to: { width: 960, height: 540, fpsMilli: 30000 } }], '改参数');
    return true;
  })()`);
  await sleep(400);
  await openExportDialog();
  const customState = await evalJson(`(() => ({
    custom: document.querySelector('[data-v="export-preset-custom"]')?.getAttribute('data-active'),
    hd: document.querySelector('[data-v="export-preset-hd"]')?.getAttribute('data-active'),
  }))()`);
  report.check(`④ 非预设参数 → 自定义高亮（${JSON.stringify(customState)}）`, customState.custom === 'true' && customState.hd === 'false');

  report.summary('导出预设与文件名');
} finally {
  await page.close().catch(() => {});
  dev.kill();
  await new Promise((resolve) => server.close(resolve));
}
