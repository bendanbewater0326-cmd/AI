/**
 * T12 素材栏验收（真浏览器 + 真 WebCodecs + 真 IndexedDB）。
 *
 * 覆盖 team-lead 的 7 条：
 *   1. 拖 sample-720p.mp4 到窗口 → 3 秒内出现 90×51 缩略图（首帧解码，非占位色块）
 *   2. 同一文件拖两次 → 只有 1 个条目（hashKey 去重，且不重新探测）
 *   3. 双击 → V1 出现片段，startFrame = 播放头
 *   4. 拖 audioonly.mp4 → 双击落 A1
 *   5. 拖 webm-vp9-opus.webm → 显示"暂不支持"，不留条目
 *   6. 空工程 → 左栏只有"＋ 导入媒体"
 *   7. 截图：无素材 / 有素材 / 拖拽高亮
 *
 * 额外：缩略图与 ref_000.png 的 90×51 比对（平均差 + 8×8 分块最大差）。
 *
 * 运行：`node tests/verify-t12.mjs`
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SHOTS = path.join(ROOT, 'tests', 'screenshots');
const DEV_PORT = 5185;

/** 素材服务器（带 CORS，页面要 fetch 字节并做像素比对）。 */
function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
    const candidates = [
      path.join(ROOT, 'tests', 'fixtures', name),
      path.join(ROOT, 'tests', 'fixtures', 'hardline', name),
      path.join(ROOT, 'tests', 'fixtures', 'compat', name),
      path.join(ROOT, 'tests', 'fixtures', 'ref', name),
    ];
    const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!found) {
      response.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
      response.end('not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': found.endsWith('.png') ? 'image/png' : 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(found).pipe(response);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

async function startDevServer() {
  const child = spawn(process.execPath, ['scripts/dev.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(DEV_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dev server 10 秒内未就绪')), 10000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes(`127.0.0.1:${DEV_PORT}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => {
      if (String(chunk).includes('EADDRINUSE')) {
        clearTimeout(timer);
        reject(new Error(`端口 ${DEV_PORT} 被占用`));
      }
    });
  });
  return child;
}

fs.mkdirSync(SHOTS, { recursive: true });
const fixtures = await startFixtureServer();
const devServer = await startDevServer();
const page = await launchPage({ url: `http://127.0.0.1:${DEV_PORT}/`, width: 1440, height: 900 });
const report = createReport();

/** 页面内工具：把 fixture 变成 File 并派发真实拖放事件。 */
const DROP_HELPER = `
  window.__t12 = {
    async drop(name) {
      const response = await fetch('${fixtures.origin}/' + encodeURIComponent(name));
      const blob = await response.blob();
      const file = new File([blob], name, { type: 'video/mp4', lastModified: 1700000000000 });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      window.__dropAt = performance.now();
      for (const type of ['dragenter', 'dragover', 'drop']) {
        document.body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
      }
      return true;
    },
    hover(name) {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([new Uint8Array([1])], name, { type: 'video/mp4' }));
      for (const type of ['dragenter', 'dragover']) {
        document.body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
      }
    },
    leave() {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([new Uint8Array([1])], 'x.mp4', { type: 'video/mp4' }));
      document.body.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer }));
    },
  };
  true;
`;

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 8000);
  await page.session.evaluate(DROP_HELPER);
  await new Promise((resolve) => setTimeout(resolve, 300));

  // ---- ⑥ 空态 ----
  const empty = await page.session.evaluate(`({
    emptyBox: !!document.querySelector('[data-v="asset-empty"]'),
    emptyText: document.querySelector('[data-v="asset-empty"]')?.textContent?.replace(/\\s+/g, ''),
    cards: document.querySelectorAll('[data-v="asset-card"]').length,
    hasSearch: !!document.querySelector('input[type="search"]'),
    addButton: !!document.querySelector('[data-v="asset-add"]'),
  })`);
  report.check(
    `⑥ 空态只有"＋ 导入媒体"（${empty.emptyText}）`,
    empty.emptyBox === true && empty.emptyText === '＋导入媒体' && empty.cards === 0 && empty.hasSearch === false && empty.addButton === false,
  );
  await page.screenshot({ path: path.join(SHOTS, 't12-empty.png') });

  // ---- ⑦ 拖拽高亮截图 ----
  await page.session.evaluate("window.__t12.hover('sample-720p.mp4'); true");
  await new Promise((resolve) => setTimeout(resolve, 120));
  const highlightVisible = await page.session.evaluate("!!document.querySelector('[data-v=\"dropzone\"]')");
  await page.screenshot({ path: path.join(SHOTS, 't12-drag-highlight.png') });
  await page.session.evaluate('window.__t12.leave(); true');

  // ---- ① 拖入 sample-720p.mp4（3 秒内出缩略图） ----
  await page.session.evaluate("window.__t12.drop('sample-720p.mp4')");
  await page.session.waitFor("document.querySelectorAll('[data-v=\"asset-card\"]').length === 1", 3000);
  const first = await page.session.evaluate(`(() => {
    const card = document.querySelector('[data-v="asset-card"]');
    const image = card?.querySelector('img');
    return {
      elapsedMs: performance.now() - window.__dropAt,
      title: card?.getAttribute('title'),
      status: card?.getAttribute('data-status'),
      thumb: image ? { width: image.getAttribute('width'), height: image.getAttribute('height'), naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight } : null,
      badge: !!card?.querySelector('[data-v="asset-badge"]'),
    };
  })()`);
  report.check(
    `① 3 秒内出现缩略图（${first.elapsedMs.toFixed(0)}ms，${first.thumb?.naturalWidth}×${first.thumb?.naturalHeight}）`,
    first.elapsedMs <= 3000 && first.thumb !== null && first.thumb.naturalWidth > 0,
  );
  report.check(
    `① 缩略图尺寸 90×51（attr ${first.thumb?.width}×${first.thumb?.height}）`,
    first.thumb?.width === '90' && first.thumb?.height === '51',
  );
  report.check(`拖拽高亮出现`, highlightVisible === true);

  // ---- ② 同一文件再拖一次 → 仍 1 条 ----
  await page.session.evaluate("window.__t12.drop('sample-720p.mp4')");
  await new Promise((resolve) => setTimeout(resolve, 800));
  const afterDuplicate = await page.session.evaluate(
    "document.querySelectorAll('[data-v=\"asset-card\"]').length",
  );
  report.check(`② 重复导入仍只有 1 条（${afterDuplicate}）`, afterDuplicate === 1);

  // ---- ③ 双击 → V1 片段，startFrame = 播放头 ----
  const clipCheck = await page.session.evaluate(`(async () => {
    const playhead = window.__VEDITOR_TEST__.playheadFrame();
    const card = document.querySelector('[data-v="asset-card"]');
    card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const clips = window.__VEDITOR_TEST__.clips();
    return { playhead, clips };
  })()`);
  const videoClip = clipCheck.clips[0];
  report.check(
    `③ 双击上 V1（track=${videoClip?.trackId} start=${videoClip?.startFrame} playhead=${clipCheck.playhead}）`,
    clipCheck.clips.length === 1 &&
      videoClip.trackId === 'trk_V1' &&
      videoClip.startFrame === clipCheck.playhead &&
      videoClip.inFrame === 0 &&
      videoClip.outFrame === 240 &&
      videoClip.durationFrames === 240,
  );

  // ---- ④ 导入 audioonly.mp4 → 落 A1 ----
  await page.session.evaluate("window.__t12.drop('audioonly.mp4')");
  await page.session.waitFor("document.querySelectorAll('[data-v=\"asset-card\"]').length === 2", 4000);
  const audioClip = await page.session.evaluate(`(async () => {
    const card = document.querySelector('[data-v="asset-card"][title="audioonly.mp4"]');
    card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    return window.__VEDITOR_TEST__.clips();
  })()`);
  const audioTarget = audioClip.find((clip) => clip.trackId === 'trk_A1');
  report.check(
    `④ 纯音频落 A1（track=${audioTarget?.trackId} out=${audioTarget?.outFrame}）`,
    audioTarget !== undefined && audioTarget.outFrame > 0,
  );

  // ---- ⑤ webm：T19 起正常导入（旧契约"显式拒绝 + 提示 T19"随 T19 交付作废）----
  const beforeWebm = await page.session.evaluate(
    "document.querySelectorAll('[data-v=\"asset-card\"]').length",
  );
  await page.session.evaluate("window.__t12.drop('webm-vp9-opus.webm')");
  await page.session.waitFor(
    `document.querySelectorAll('[data-v="asset-card"]').length > ${beforeWebm}`,
    10000,
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  const webm = await page.session.evaluate(`({
    cards: document.querySelectorAll('[data-v="asset-card"]').length,
    error: document.querySelector('[data-v="errorbar"]')?.textContent ?? '',
  })`);
  report.check(
    `⑤ webm 正常导入（卡片 ${beforeWebm} → ${webm.cards}，无错误条）`,
    webm.cards === beforeWebm + 1 && webm.error === '',
    webm.error.slice(0, 80),
  );

  await page.screenshot({ path: path.join(SHOTS, 't12-assets.png') });

  // ---- 缩略图 vs ref_000.png（跨链路：ffmpeg 参考帧 vs WebCodecs 出帧） ----
  // 口径见架构附录 B.1：跨链路用 avgDiff ≤ 15 + 8×8 分块 ≤ 35；
  // 这与 T12 ⑧ 的同链路比对（缩略图位图 vs 重算位图，maxCh ≤ 2）是两套阈值，不得互相引用。
  const compare = await page.session.evaluate(`(async () => {
    const load = (src, cross) => new Promise((resolve, reject) => {
      const image = new Image();
      if (cross) image.crossOrigin = 'anonymous';
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('图片加载失败 ' + src));
      image.src = src;
    });
    const thumbSrc = document.querySelector('[data-v="asset-card"] img')?.src;
    if (!thumbSrc) return { error: '没有缩略图' };
    const [reference, thumb] = await Promise.all([
      load('${fixtures.origin}/ref_000.png', true),
      load(thumbSrc, false),
    ]);
    const W = 90;
    const H = 51;
    const draw = (image) => {
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, W, H);
      return context.getImageData(0, 0, W, H).data;
    };
    const a = draw(reference);
    const b = draw(thumb);
    let sum = 0;
    for (let index = 0; index < a.length; index += 4) {
      sum += Math.abs(a[index] - b[index]) + Math.abs(a[index + 1] - b[index + 1]) + Math.abs(a[index + 2] - b[index + 2]);
    }
    const avgDiff = sum / (W * H * 3);
    let maxBlockDiff = 0;
    for (let by = 0; by < H; by += 8) {
      for (let bx = 0; bx < W; bx += 8) {
        let blockSum = 0;
        let count = 0;
        for (let y = by; y < Math.min(by + 8, H); y += 1) {
          for (let x = bx; x < Math.min(bx + 8, W); x += 1) {
            const i = (y * W + x) * 4;
            blockSum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
            count += 3;
          }
        }
        maxBlockDiff = Math.max(maxBlockDiff, blockSum / count);
      }
    }
    return { avgDiff, maxBlockDiff };
  })()`);
  report.check(
    `缩略图 vs ref_000.png：平均差 ${compare.avgDiff?.toFixed(2)} ≤ 15`,
    typeof compare.avgDiff === 'number' && compare.avgDiff <= 15,
  );
  report.check(
    `缩略图分块最大差 ${compare.maxBlockDiff?.toFixed(1)} ≤ 35`,
    typeof compare.maxBlockDiff === 'number' && compare.maxBlockDiff <= 35,
  );

  report.summary('T12 素材栏验收');
} finally {
  await page.close();
  devServer.kill();
  await fixtures.close();
  await new Promise((resolve) => setTimeout(resolve, 200));
}
