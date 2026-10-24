/**
 * .vedpack 工程打包端到端验证（V3）。
 *
 * 覆盖：
 *   ① 工程菜单出现「导出工程包…（含素材）」与「导入工程包…」
 *   ② 导出：视频+音效工程 → 下载落盘（.vedpack，非空）
 *   ③ 重开干净页面（新 profile = 干净 IDB）→ 经「导入工程包…」入口载入
 *   ④ 素材在线 ×2（字节从包内绑回）、片段数一致、工程名还原
 *   ⑤ 播放调度 PCM>0（素材真的可用，不只是元数据）
 *   ⑥ 坏文件（.txt 假冒 .vedpack）→ 统一中文提示
 *
 * 运行：`node --experimental-websocket tests/verify-vedpack.mjs`
 * 前置：fixtures 已生成（sample-720p.mp4）
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createReport, launchPage } from './cdp.mjs';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..');
const PORT = 5857;
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
const DOWNLOAD_DIR = path.join(ROOT, 'tests', '.tmp-download');
fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

let page = await launchPage({ url: `http://127.0.0.1:${PORT}/`, width: 1440, height: 900 });
const ev = async (expression) => page.session.evaluate(expression);
const evalJson = async (expression) => JSON.parse(await ev(`JSON.stringify(${expression})`));
const click = async (selector) => {
  await ev(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  await sleep(350);
};

/** 整窗拖入素材。 */
const dropFile = async (fixturePath, name) => {
  const bytes = fs.readFileSync(fixturePath);
  const b64 = bytes.toString('base64');
  await ev(`(async () => {
    const raw = atob('${b64}');
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    const file = new File([bytes], ${JSON.stringify(name)}, { lastModified: 1700000000000 });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      document.body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
    }
    return true;
  })()`);
  await sleep(700);
};

const openProjectMenu = async () => {
  await ev(`(() => {
    const buttons = Array.from(document.querySelectorAll('[data-v="topbar"] button'));
    buttons.find((item) => item.textContent.trim() === '工程')?.click();
    return true;
  })()`);
  await sleep(250);
};

try {
  // ---- 准备工程：视频 + 音效，改工程名 ----
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
  await sleep(500);
  await dropFile(FIXTURE, 'sample-720p.mp4');
  await page.session.waitFor(`document.querySelectorAll('[data-v="asset-card"]').length === 1`, 10000);
  await ev(`document.querySelector('[data-v="asset-card"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true`);
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 1`, 8000);
  await sleep(400);
  await click('[data-v="left-tab-audio"]');
  await page.session.waitFor(`document.querySelector('[data-v="sfx-panel"]') !== null`, 8000);
  await click('[data-v="sfx-preset"][data-preset-id="ding"]');
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 2`, 10000);
  await sleep(300);
  const clipSnapshot = await evalJson(`window.__VEDITOR_TEST__.clips().map((item) => ({ trackId: item.trackId, startFrame: item.startFrame, durationFrames: item.durationFrames }))`);
  const projectName = await evalJson('window.__VEDITOR_TEST__.projectMeta().name');

  // ---- ① 菜单项 ----
  await openProjectMenu();
  report.check('① 菜单出现「导出工程包…（含素材）」', await ev(`document.querySelector('[data-v="project-export-pack"]') !== null`));
  report.check('① 菜单出现「导入工程包…」', await ev(`document.querySelector('[data-v="project-import-pack"]') !== null`));

  // ---- ② 导出 → 下载落盘 ----
  await page.session.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOAD_DIR });
  await click('[data-v="project-export-pack"]');
  await sleep(2500); // 收集+打包+下载
  const packFiles = fs.readdirSync(DOWNLOAD_DIR).filter((name) => name.endsWith('.vedpack'));
  report.check(`② 下载 .vedpack（${packFiles.join(', ') || '无'}）`, packFiles.length === 1);
  const packPath = path.join(DOWNLOAD_DIR, packFiles[0] ?? '');
  const packSize = fs.existsSync(packPath) ? fs.statSync(packPath).size : 0;
  report.check(`② 包非空且含素材字节（${(packSize / 1024).toFixed(0)}KB > 400KB）`, packSize > 400 * 1024);

  // ---- ③ 重开干净页面（新 profile = 干净 IDB）→ 导入工程包 ----
  await page.close().catch(() => {});
  page = await launchPage({ url: `http://127.0.0.1:${PORT}/`, width: 1440, height: 900 });
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
  await sleep(600);
  // 用 DOM.setFileInputFiles 给隐藏 input 喂包（verify-lut 的文件注入先例）
  await openProjectMenu();
  await click('[data-v="project-import-pack"]');
  await sleep(200);
  const { root } = await page.session.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await page.session.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: '[data-v="pack-file-input"]',
  });
  assert(nodeId !== 0, '找不到 pack-file-input');
  await page.session.send('DOM.setFileInputFiles', { nodeId, files: [packPath] });
  await page.session.waitFor(`window.__VEDITOR_TEST__.assets().length === 2`, 20000);
  await sleep(800);

  // ---- ④ 恢复断言 ----
  const restoredAssets = await evalJson('window.__VEDITOR_TEST__.assets()');
  report.check(
    `④ 素材 ×2 在线（${restoredAssets.map((item) => item.status).join(',')}）`,
    restoredAssets.length === 2 && restoredAssets.every((item) => item.status !== 'offline'),
  );
  const restoredClips = await evalJson(`window.__VEDITOR_TEST__.clips().map((item) => ({ trackId: item.trackId, startFrame: item.startFrame, durationFrames: item.durationFrames }))`);
  report.check(
    `④ 片段排布一致（${JSON.stringify(restoredClips)}）`,
    JSON.stringify(restoredClips) === JSON.stringify(clipSnapshot),
  );
  const restoredName = await evalJson('window.__VEDITOR_TEST__.projectMeta().name');
  report.check(`④ 工程名还原（${restoredName}）`, restoredName === projectName);

  // ---- ⑤ 播放调度（素材真可用） ----
  await ev(`window.__VEDITOR_TEST__.seek(0)`);
  await sleep(200);
  await ev(`window.__VEDITOR_TEST__.play()`);
  await sleep(1500);
  await ev(`window.__VEDITOR_TEST__.pause()`);
  const stats = await evalJson('window.__VEDITOR_TEST__.audioStats()');
  report.check(
    `⑤ 播放调度 PCM>0（pcmBytes=${stats?.pcmBytes ?? 0}）`,
    stats !== null && stats.pcmBytes > 0,
  );

  // ---- ⑥ 坏文件 → 中文提示 ----
  {
    const badPath = path.join(DOWNLOAD_DIR, 'fake.vedpack');
    fs.writeFileSync(badPath, '这不是一个工程包');
    await openProjectMenu();
    await click('[data-v="project-import-pack"]');
    await sleep(200);
    const { root: root2 } = await page.session.send('DOM.getDocument', { depth: -1 });
    const { nodeId: node2 } = await page.session.send('DOM.querySelector', {
      nodeId: root2.nodeId,
      selector: '[data-v="pack-file-input"]',
    });
    await page.session.send('DOM.setFileInputFiles', { nodeId: node2, files: [badPath] });
    await sleep(1000);
    const errors = await evalJson('window.__VEDITOR_TEST__.errors()');
    report.check(
      `⑥ 坏包中文提示（${JSON.stringify(errors.slice(-1).map((item) => item.message))}）`,
      errors.some((item) => item.message.includes('不是 veditor 工程包')),
    );
  }

  report.summary('.vedpack 工程打包');
} finally {
  await page.close().catch(() => {});
  dev.kill();
  await new Promise((resolve) => server.close(resolve));
}
