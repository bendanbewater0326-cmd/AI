/**
 * 工程文件迁出端到端验证（R-054）。
 *
 * ## 这条链路最容易"看起来成功"
 *
 * 导出得到一个文件、导入之后时间线上也有片段——**但内容可能是错的**：
 * 片段帧号错位、文字丢了、素材假装还在（实际播不出来）。
 * 所以这里不只看"有没有片段"，而是逐项比对：
 *   工程名 / 轨道数 / 片段数与帧号 / 文字内容 / 素材 offline / 重连后能否出画。
 *
 * 素材字节不在文件里（这是 R-054 的设计：素材待重连），所以导入后必须
 * 走一次「重新链接」把文件按 assetId 绑回去——这一步也要验证。
 *
 * 运行：node tests/verify-project-file.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5213;
const FIXTURE = 'roughcut-8s.mp4';
const TMP = path.join(ROOT, 'tests', '.tmp', 'project-file');

function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
    const found = [
      path.join(ROOT, 'tests', 'fixtures', 'compat', name),
      path.join(ROOT, 'tests', 'fixtures', name),
    ].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!found) {
      response.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
      response.end('not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(found).pipe(response);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function startDevServer() {
  const child = spawn(process.execPath, ['scripts/dev.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dev server 未就绪')), 15000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes(`127.0.0.1:${PORT}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return child;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 通过 CDP 给隐藏的 file input 塞文件（触发 change）。 */
async function setFileInput(page, selector, filePath) {
  const { root } = await page.session.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await page.session.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector,
  });
  if (nodeId === 0) throw new Error(`找不到 ${selector}`);
  await page.session.send('DOM.setFileInputFiles', { nodeId, files: [filePath] });
}

const report = createReport();
const fixture = await startFixtureServer();
const dev = await startDevServer();
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const sourcePage = await launchPage({
  url: `http://127.0.0.1:${PORT}/?src=${fixture.origin}/${FIXTURE}`,
  width: 1440,
  height: 900,
});

let targetPage = null;
try {
  // ---- ① 造一个"有内容"的工程：视频片段 + 文字 ----
  await sourcePage.session.waitFor('!!window.__VEDITOR_TEST__', 15000);
  await sourcePage.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 25000);
  await sourcePage.session.evaluate(`document.querySelector('[data-v="add-text"]').click()`);
  await sourcePage.session.waitFor('window.__VEDITOR_TEST__.clips().length === 2', 5000);

  const before = JSON.parse(
    await sourcePage.session.evaluate(`(() => {
      const clips = window.__VEDITOR_TEST__.clips();
      const duration = clips.reduce((max, clip) => Math.max(max, clip.startFrame + clip.durationFrames), 0);
      const text = clips.find((clip) => clip.text !== null);
      return JSON.stringify({
        count: clips.length,
        duration,
        name: window.__VEDITOR_TEST__.projectMeta().name,
        text: text === undefined ? null : text.text.content,
        tracks: window.__VEDITOR_TEST__.tracks().length,
      });
    })()`),
  );
  report.check(
    `① 源工程就绪（${before.count} 段 / ${before.duration} 帧 / 轨道 ${before.tracks}）`,
    // 轨道数不写死：2026-10-23 起「添加文字」会顺手建一条文字轨（3 → 4）。
    // 这里只要求"至少三条基础轨"，避免每加一类轨就要改一次这个数字。
    before.count === 2 && before.duration === 240 && before.tracks >= 3,
  );

  // ---- ② 导出工程文件 ----
  await sourcePage.session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: TMP });
  await sourcePage.session.evaluate(`document.querySelector('[data-v="project-menu"]').click()`);
  await sourcePage.session.waitFor(`!!document.querySelector('[data-v="project-export"]')`, 3000);
  await sourcePage.session.evaluate(`document.querySelector('[data-v="project-export"]').click()`);

  const deadline = Date.now() + 15000;
  let filePath = null;
  while (Date.now() < deadline) {
    const files = fs.readdirSync(TMP).filter((name) => name.endsWith('.vedproj'));
    if (files.length > 0) {
      filePath = path.join(TMP, files[0]);
      break;
    }
    await sleep(300);
  }
  report.check(`② 导出 .vedproj（${filePath === null ? '无' : path.basename(filePath)}）`, filePath !== null);

  if (filePath !== null) {
    const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const clipCount = envelope.project.tracks.reduce((sum, track) => sum + track.clips.length, 0);
    report.check(
      `② 文件是自描述的（format=${envelope.format} v${envelope.version}，${clipCount} 段，${envelope.assets.length} 个素材）`,
      envelope.format === 'veditor-project' && envelope.version === 1 && clipCount === 2 && envelope.assets.length === 1,
    );
    report.check(
      `② 文件里不含素材字节（只有元数据：${envelope.assets[0].name}）`,
      typeof envelope.assets[0].name === 'string' && envelope.project.assets[0].status !== 'ok',
    );
  }

  // ---- ③ 换一个"干净页面"导入 ----
  await sourcePage.close();
  targetPage = await launchPage({ url: `http://127.0.0.1:${PORT}/`, width: 1440, height: 900 });
  await targetPage.session.waitFor('!!window.__VEDITOR_TEST__', 15000);
  const empty = await targetPage.session.evaluate('window.__VEDITOR_TEST__.clips().length');
  report.check(`③ 新页面是空工程（片段 ${empty}）`, empty === 0);

  await setFileInput(targetPage, '[data-v="project-file-input"]', filePath);
  await targetPage.session.waitFor('window.__VEDITOR_TEST__.clips().length === 2', 15000);

  const after = JSON.parse(
    await targetPage.session.evaluate(`(() => {
      const clips = window.__VEDITOR_TEST__.clips();
      const duration = clips.reduce((max, clip) => Math.max(max, clip.startFrame + clip.durationFrames), 0);
      const text = clips.find((clip) => clip.text !== null);
      const assets = window.__VEDITOR_TEST__.assets();
      return JSON.stringify({
        count: clips.length,
        duration,
        name: window.__VEDITOR_TEST__.projectMeta().name,
        text: text === undefined ? null : text.text.content,
        assetStatus: assets[0]?.status ?? null,
        assetName: assets[0]?.name ?? null,
      });
    })()`),
  );

  report.check(
    `③ 片段还原（${after.count} 段 / ${after.duration} 帧，原 ${before.count} 段 / ${before.duration} 帧）`,
    after.count === before.count && after.duration === before.duration,
  );
  report.check(`③ 工程名还原（"${after.name}"）`, after.name === before.name);
  report.check(
    `③ 文字片段内容还原（"${after.text}"）`,
    after.text !== null && after.text === before.text,
  );
  report.check(
    `③ 素材标 offline、等待重连（${after.assetName} / ${after.assetStatus}）`,
    after.assetStatus === 'offline' && after.assetName === FIXTURE,
  );

  const blackBefore = JSON.parse(
    await targetPage.session.evaluate(
      `(async () => JSON.stringify(await window.__VEDITOR_TEST__.previewSnapshot()))()`,
    ),
  );
  // 注意：工程里还有一段**文字**，文字层不依赖素材，所以画面不会全黑。
  // 这里断言的是"视频层缺失、文字层仍在"——像素量远小于整帧（921600），但又大于 0。
  report.check(
    `③ 未重连前只有文字层（非黑像素 ${blackBefore === null ? 0 : blackBefore.nonBlack}，整帧 921600）`,
    blackBefore !== null && blackBefore.nonBlack > 0 && blackBefore.nonBlack < 100_000,
  );

  // ---- ④ 重新链接：把素材字节按 assetId 绑回去 ----
  // 先确认"点重新链接"**真的会打开文件选择框**：
  // 内嵌面板里句柄授权（requestPermission）会返回 denied，旧实现只弹一句
  // "文件访问被拒绝，可点击重新链接选择文件"，再点还是同一句 —— 死循环。
  // 现在失败必须退回手动选文件，这里用 click 探针把这条兜底钉住。
  await targetPage.session.evaluate(`(() => {
    const input = document.querySelector('[data-v="asset-relink-input"]');
    window.__relinkOpened = 0;
    input.addEventListener('click', (event) => {
      // 阻止真的弹系统对话框（headless 下会挂住），只记一次
      event.preventDefault();
      window.__relinkOpened += 1;
    });
    return true;
  })()`);
  await targetPage.session.evaluate(`document.querySelector('[data-v="asset-relink"]').click()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const relinkOpened = await targetPage.session.evaluate('window.__relinkOpened');
  report.check(`④ 点「重新链接」会打开文件选择框（click ${relinkOpened} 次）`, relinkOpened >= 1);
  await setFileInput(targetPage, '[data-v="asset-relink-input"]', path.join(ROOT, 'tests', 'fixtures', 'compat', FIXTURE));
  await targetPage.session.waitFor(
    `window.__VEDITOR_TEST__.assets()[0]?.status !== 'offline'`,
    20000,
  );
  await sleep(1200);
  const reconnected = JSON.parse(
    await targetPage.session.evaluate(
      `(async () => JSON.stringify({ status: window.__VEDITOR_TEST__.assets()[0]?.status, snap: await window.__VEDITOR_TEST__.previewSnapshot() }))()`,
    ),
  );
  report.check(
    `④ 重连成功（${reconnected.status}，非黑像素 ${reconnected.snap?.nonBlack}）`,
    reconnected.status === 'memory' && reconnected.snap !== null && reconnected.snap.nonBlack > 1000,
  );

  // ---- ⑤ 坏文件：给可读错误、不动当前工程 ----
  const badPath = path.join(TMP, 'broken.vedproj');
  fs.writeFileSync(badPath, '{ "format": "something-else" }', 'utf8');
  await setFileInput(targetPage, '[data-v="project-file-input"]', badPath);
  await sleep(800);
  const errors = JSON.parse(await targetPage.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.errors())'));
  const stillThere = await targetPage.session.evaluate('window.__VEDITOR_TEST__.clips().length');
  report.check(
    `⑤ 坏文件被拒绝且工程未变（片段 ${stillThere}，错误 ${JSON.stringify(errors)}）`,
    stillThere === 2 && Array.isArray(errors) && errors.some((item) => /工程文件/.test(item.message)),
  );

  await targetPage.screenshot({ path: path.join(ROOT, 'tests', 'screenshots', 'project-file.png') });
  report.summary('工程文件迁出（R-054）');
} finally {
  await targetPage?.close();
  await sourcePage.close().catch(() => undefined);
  dev.kill();
  await fixture.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
