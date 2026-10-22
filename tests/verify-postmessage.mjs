/**
 * postMessage 宿主通道端到端验证（R-050）。
 *
 * ## 为什么要单独一个 E2E
 *
 * T18 只验证了"`?src=` 与 `<veditor-panel>` 两条接入"，`postMessage` 的命令通道一直是
 * `{ error: 'not_implemented' }` —— 文档却写着"三种接入"。宿主按 PRD 接进来会**静默失败**，
 * 而且没有任何提示（比报错更难查）。本脚本把四条命令真的跑一遍：
 *
 *   ① `ready` 事件（带 schemaVersion）
 *   ② `getProject` 回工程（自动导入的素材与片段都在）
 *   ③ `setProject` 换工程（改名 + 播放头），再 `getProject` 能读回
 *   ④ `setProject` 非法 → `E_INVALID_PROJECT`，且**原工程不被破坏**
 *   ⑤ `importAsset` 带 buffer（transfer）→ 回 assetId，素材数 +1
 *   ⑥ **R-054 重连**：`setProject` 送一份"素材 offline"的工程 → 预览黑屏；
 *      `importAsset({ assetId })` 把字节绑回同一 id → 预览出画
 *   ⑦ `export` mp4 → 回 ArrayBuffer，落盘用 ffprobe 校验（h264 + 时长 2s）
 *   ⑧ 导出过程有 `exportProgress` 事件（宿主可做进度条）
 *   ⑨ `export` webm → `E_UNSUPPORTED_FORMAT`（明确拒绝，不假装支持）
 *   ⑩ 未知命令 → `E_UNSUPPORTED_COMMAND`
 *
 * 运行：node tests/verify-postmessage.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5209;
const TMP = path.join(ROOT, 'tests', '.tmp', 'postmessage');

/* ---------------- 基建 ---------------- */

function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
    const found = [
      path.join(ROOT, 'tests', 'fixtures', 'compat', name),
      path.join(ROOT, 'tests', 'fixtures', name),
      path.join(ROOT, 'tests', 'fixtures', 'hardline', name),
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

/** 宿主侧探针：消息收集 + 按 id 关联的 send。必须在 iframe 加载前注入。 */
const HOST_HARNESS = `
(() => {
  window.__msgs = [];
  window.__seq = 0;
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data !== null && typeof data === 'object' && typeof data.type === 'string') {
      window.__msgs.push(data);
    }
  });
  window.__send = (cmd, transfer) => new Promise((resolve, reject) => {
    const frame = document.getElementById('ed');
    if (frame === null || frame.contentWindow === null) {
      reject(new Error('iframe 未就绪'));
      return;
    }
    const id = 'h' + (window.__seq += 1);
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('命令超时：' + cmd.type));
    }, 90000);
    function onMessage(event) {
      const data = event.data;
      if (data === null || typeof data !== 'object' || data.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(data);
    }
    window.addEventListener('message', onMessage);
    frame.contentWindow.postMessage({ ...cmd, id }, '*', transfer ?? []);
  });
  return true;
})()
`;

/** 取 iframe 内的测试钩子（同源，可直接访问）。 */
const IFRAME_HOOK = "document.getElementById('ed').contentWindow.__VEDITOR_TEST__";

/* ---------------- 主流程 ---------------- */

const report = createReport();
const fixture = await startFixtureServer();
const dev = await startDevServer();
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const page = await launchPage({
  url: `http://127.0.0.1:${PORT}/?bare=1`,
  width: 1280,
  height: 820,
});

try {
  // 必须等**本次导航**完成再注入：launchPage 把 url 当命令行参数传给浏览器，
  // CDP 可能在 about:blank 阶段就接上，此时注入的 window.__msgs 会被导航清掉。
  await page.session.waitFor(
    `location.href.includes('127.0.0.1:${PORT}/') && document.readyState === 'complete' && !!document.body`,
    20000,
  );
  await page.session.evaluate(HOST_HARNESS);

  // iframe 指向编辑器（带 ?src= 自动导入一段 720p 素材）
  const editorUrl = `http://127.0.0.1:${PORT}/?src=${fixture.origin}/sample-720p.mp4`;
  await page.session.evaluate(`(() => {
    const frame = document.createElement('iframe');
    frame.id = 'ed';
    frame.style.cssText = 'width:1200px;height:800px;border:0';
    frame.src = ${JSON.stringify(editorUrl)};
    document.body.appendChild(frame);
    return true;
  })()`);

  // ① ready 事件
  await page.session.waitFor(
    `window.__msgs.some((m) => m.type === 'ready')`,
    20000,
  );
  const ready = JSON.parse(
    await page.session.evaluate(
      `JSON.stringify(window.__msgs.find((m) => m.type === 'ready') ?? null)`,
    ),
  );
  report.check(`① ready 事件带 schemaVersion（${ready?.schemaVersion}）`, ready?.schemaVersion === 1);

  // 等自动导入完成（片段数 > 0）
  const deadline = Date.now() + 30000;
  let initial = null;
  while (Date.now() < deadline) {
    const raw = await page.session.evaluate(
      `(async () => {
        const r = await window.__send({ type: 'getProject' });
        if (r.ok !== true) return JSON.stringify({ ok: false, code: r.code });
        const clips = r.project.tracks.reduce((n, t) => n + t.clips.length, 0);
        return JSON.stringify({
          ok: true,
          clips,
          tracks: r.project.tracks.length,
          assets: r.project.assets.length,
          width: r.project.width,
          name: r.project.name,
          id: r.id,
          project: clips > 0 ? r.project : null,
        });
      })()`,
    );
    initial = JSON.parse(raw);
    if (initial.ok && initial.clips > 0) break;
    await sleep(400);
  }
  report.check(
    `② getProject 回工程（片段 ${initial?.clips} / 轨道 ${initial?.tracks} / 素材 ${initial?.assets}）`,
    initial?.ok === true && initial.clips >= 1 && initial.tracks === 3 && initial.assets === 1,
  );
  report.check(`② 响应原样带回请求 id（${initial?.id}）`, typeof initial?.id === 'string' && initial.id.startsWith('h'));
  report.check(`② 参数跟随首个素材（${initial?.width}px）`, initial?.width === 1280);

  const project = initial.project;
  const originalName = project.name;

  // ③ setProject 往返
  const renamed = { ...project, name: '宿主改过的工程', playheadFrame: 42 };
  const setResult = JSON.parse(
    await page.session.evaluate(
      `(async () => JSON.stringify(await window.__send({ type: 'setProject', project: ${JSON.stringify(renamed)} })))()`,
    ),
  );
  const readBack = JSON.parse(
    await page.session.evaluate(
      `(async () => {
        const r = await window.__send({ type: 'getProject' });
        return JSON.stringify({ name: r.project.name, playhead: r.project.playheadFrame, clips: r.project.tracks.reduce((n, t) => n + t.clips.length, 0) });
      })()`,
    ),
  );
  report.check(
    `③ setProject 生效（${readBack.name} / 播放头 ${readBack.playhead} / 片段 ${readBack.clips}）`,
    setResult.ok === true &&
      setResult.schemaVersion === 1 &&
      readBack.name === '宿主改过的工程' &&
      readBack.playhead === 42 &&
      readBack.clips >= 1,
  );

  // ④ 非法工程被整份拒绝，且不破坏当前工程
  const badResult = JSON.parse(
    await page.session.evaluate(
      `(async () => JSON.stringify(await window.__send({ type: 'setProject', project: { tracks: [], width: 0 } })))()`,
    ),
  );
  const afterBad = JSON.parse(
    await page.session.evaluate(
      `(async () => JSON.stringify({ name: (await window.__send({ type: 'getProject' })).project.name }))()`,
    ),
  );
  report.check(
    `④ 非法工程回 E_INVALID_PROJECT（${badResult.code}）且工程未变（${afterBad.name}）`,
    badResult.ok === false && badResult.code === 'E_INVALID_PROJECT' && afterBad.name === '宿主改过的工程',
  );

  // ⑥ R-054 重连：换成"素材 offline"的工程（用新 id 模拟从另一台机器导入的工程）
  const remote = {
    ...project,
    name: '异地工程',
    assets: project.assets.map((asset) => ({ ...asset, id: 'ast_host', status: 'offline' })),
    tracks: project.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => ({ ...clip, assetId: 'ast_host' })),
    })),
  };
  await page.session.evaluate(
    `(async () => JSON.stringify(await window.__send({ type: 'setProject', project: ${JSON.stringify(remote)} })))()`,
  );
  await sleep(1200);
  const blackBefore = JSON.parse(
    await page.session.evaluate(
      `(async () => JSON.stringify(await (${IFRAME_HOOK}).previewSnapshot()))()`,
    ),
  );

  // 把字节绑回 ast_host
  const reconnect = JSON.parse(
    await page.session.evaluate(
      `(async () => {
        const response = await fetch(${JSON.stringify(`${fixture.origin}/sample-720p.mp4`)});
        const buffer = await response.arrayBuffer();
        return JSON.stringify(await window.__send({ type: 'importAsset', assetId: 'ast_host', name: 'sample-720p.mp4', buffer }, [buffer]));
      })()`,
    ),
  );
  await sleep(1500);
  const afterReconnect = JSON.parse(
    await page.session.evaluate(
      `(async () => {
        const stats = await (${IFRAME_HOOK}).previewSnapshot();
        const project = (await window.__send({ type: 'getProject' })).project;
        const asset = project.assets.find((a) => a.id === 'ast_host');
        return JSON.stringify({ nonBlack: stats === null ? 0 : stats.nonBlack, status: asset === undefined ? null : asset.status });
      })()`,
    ),
  );
  report.check(
    `⑥ 重连前黑屏（非黑像素 ${blackBefore === null ? 0 : blackBefore.nonBlack}）`,
    blackBefore === null || blackBefore.nonBlack < 1000,
  );
  report.check(
    `⑥ importAsset({assetId}) 重连成功（素材 ${afterReconnect.status}，非黑像素 ${afterReconnect.nonBlack}）`,
    reconnect.ok === true && reconnect.assetId === 'ast_host' && afterReconnect.status === 'memory' && afterReconnect.nonBlack > 1000,
  );

  // ⑤ 新素材导入（不带 assetId）→ 素材数 +1
  const imported = JSON.parse(
    await page.session.evaluate(
      `(async () => {
        const response = await fetch(${JSON.stringify(`${fixture.origin}/24fps.mp4`)});
        const buffer = await response.arrayBuffer();
        const result = await window.__send({ type: 'importAsset', name: '24fps.mp4', buffer }, [buffer]);
        const project = (await window.__send({ type: 'getProject' })).project;
        return JSON.stringify({ ok: result.ok, assetId: result.assetId, assets: project.assets.length });
      })()`,
    ),
  );
  report.check(
    `⑤ importAsset 新素材（assetId=${imported.assetId}，素材数 ${imported.assets}）`,
    imported.ok === true && typeof imported.assetId === 'string' && imported.assets >= 2,
  );

  // ⑦ 导出 mp4（0–60 帧 = 2s），字节回传后落盘校验
  const exported = JSON.parse(
    await page.session.evaluate(
      `(async () => {
        const result = await window.__send({ type: 'export', format: 'mp4', startFrame: 0, endFrame: 60 });
        if (result.ok !== true) return JSON.stringify({ ok: false, code: result.code, message: result.message });
        const bytes = new Uint8Array(result.buffer);
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        const head = Array.from(bytes.subarray(0, 12)).map((b) => String.fromCharCode(b)).join('');
        return JSON.stringify({
          ok: true,
          filename: result.filename,
          size: result.size,
          mime: result.mime,
          head,
          progress: window.__msgs.filter((m) => m.type === 'exportProgress').length,
          done: window.__msgs.some((m) => m.type === 'exportDone'),
          b64: btoa(binary),
        });
      })()`,
    ),
  );

  let probeOk = false;
  let duration = 0;
  let codecs = '';
  if (exported.ok === true) {
    const file = path.join(TMP, exported.filename ?? 'host.mp4');
    fs.writeFileSync(file, Buffer.from(exported.b64, 'base64'));
    const probe = spawnSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration:stream=codec_name,codec_type',
        '-of',
        'json',
        file,
      ],
      { encoding: 'utf8' },
    );
    const info = JSON.parse(probe.stdout || '{}');
    duration = Number(info.format?.duration ?? 0);
    codecs = (info.streams ?? []).map((stream) => `${stream.codec_type}:${stream.codec_name}`).join(',');
    probeOk = /video:h264/.test(codecs);
  }
  report.check(
    `⑦ 导出回传 ArrayBuffer（${exported.ok ? `${exported.size} bytes, ${exported.mime}` : exported.code}）`,
    exported.ok === true && exported.size > 10_000 && exported.head.includes('ftyp'),
  );
  report.check(`⑦ 产物是 h264（${codecs}）`, probeOk);
  report.check(
    `⑦ 导出区间生效（60 帧 = 2s，实测 ${duration.toFixed(3)}s）`,
    Math.abs(duration - 2) < 0.2,
  );
  report.check(
    `⑧ 导出过程有进度事件（${exported.ok ? exported.progress : 0} 条）+ exportDone`,
    exported.ok === true && exported.progress > 0 && exported.done === true,
  );

  // ⑨ webm 明确拒绝
  const webm = JSON.parse(
    await page.session.evaluate(
      `(async () => JSON.stringify(await window.__send({ type: 'export', format: 'webm' })))()`,
    ),
  );
  report.check(
    `⑨ export webm 明确拒绝（${webm.code}）`,
    webm.ok === false && webm.code === 'E_UNSUPPORTED_FORMAT' && /WebM/.test(webm.message ?? ''),
  );

  // ⑩ 未知命令
  const unknown = JSON.parse(
    await page.session.evaluate(
      `(async () => JSON.stringify(await window.__send({ type: 'launchMissiles' })))()`,
    ),
  );
  report.check(
    `⑩ 未知命令回 E_UNSUPPORTED_COMMAND（${unknown.message ?? ''}）`,
    unknown.ok === false && unknown.code === 'E_UNSUPPORTED_COMMAND' && /getProject/.test(unknown.message ?? ''),
  );

  // 附：整轮没有任何页面级异常
  const errors = JSON.parse(
    await page.session.evaluate(`JSON.stringify((${IFRAME_HOOK}).errors())`),
  );
  report.check(`⑪ 全程无页面错误（${JSON.stringify(errors)}）`, Array.isArray(errors) && errors.length === 0);

  await page.screenshot({ path: path.join(ROOT, 'tests', 'screenshots', 'postmessage-host.png') });
  report.summary('postMessage 宿主通道（R-050）');
} finally {
  await page.close();
  dev.kill();
  await fixture.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
