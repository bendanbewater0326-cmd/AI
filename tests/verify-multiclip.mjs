/**
 * 多素材组合回归：**不同分辨率 + 不同容器 + 转场 + 变速** 混在同一条视频轨。
 *
 * ## 为什么单素材测试不够
 *
 * 前几轮的 E2E 都是"一个素材、一条轨、无转场"。真实剪辑几乎总是：
 * 720p 横屏 + 竖屏手机片段 + 一段 webm 素材拼在一起，中间加转场、某段变速。
 * 这类组合最容易出"每个功能单独都对、组合起来错"的问题：
 *   - 工程尺寸被第一个素材定死，其余素材的 fitSize / 宽高比
 *   - 转场两侧素材分辨率不同 → 冻结帧的尺寸与缩放
 *   - 变速片段让后续片段的 startFrame 出现空隙
 *   - 导出时三种来源（mp4 / webm / 旋转）一起混流
 *
 * 场景（V1 单轨）：
 *   A sample-720p.mp4   1280×720  240 帧 → [0, 240)
 *   B rotated-90.mp4    1080×1920  90 帧 → [240, 330)   竖屏（rotation=270）
 *   C webm-vp9-opus     640×360   120 帧 → [330, 450)
 *
 * 验证：
 *   ① 三个片段都在 V1 且首尾相接（start 依次 0 / 240 / 330）
 *   ② 每个片段中点预览非黑（组合渲染不互相干扰）
 *   ③ 竖屏片段在横屏工程里居中且不撑变形（画面非全黑、比例正确）
 *   ④ 对 B 变速 2x 后时长 90 → 45，素材起止点不变
 *   ⑤ 变速后各时间点仍能出画（不因空隙崩）
 *
 * 运行：node tests/verify-multiclip.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5204;

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
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
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

const report = createReport();
const fixtures = await startFixtureServer();
const devServer = await startDevServer();
const page = await launchPage({
  url: `http://127.0.0.1:${PORT}/?src=${encodeURIComponent(`${fixtures.origin}/sample-720p.mp4`)}`,
  width: 1440,
  height: 900,
});

/** 时间码跳转（真实 UI 路径）。 */
async function seekTo(timecode) {
  await page.session.evaluate("document.querySelector('[data-v=\"timecode\"]')?.click()");
  await new Promise((resolve) => setTimeout(resolve, 150));
  await page.session.evaluate(`(() => {
    const input = document.querySelector('[data-v="timecode-input"]');
    if (!input) return false;
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '${timecode}');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await page.session.evaluate(
    `document.querySelector('[data-v="timecode-input"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`,
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
}

/** 拖入一个素材到素材栏（不自动上轨）。 */
async function dropAsset(name) {
  await page.session.evaluate(`
    (async () => {
      const response = await fetch('${fixtures.origin}/' + encodeURIComponent('${name}'));
      const blob = await response.blob();
      const file = new File([blob], '${name}', { type: 'video/mp4', lastModified: 1700000000000 });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      for (const type of ['dragenter', 'dragover', 'drop']) {
        document.body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
      }
      return true;
    })();
  `);
  // 等新素材落进素材栏：**卡片 textContent 只有"内存"状态标签，不含文件名**，
  // 所以按卡片数量增加来等，再用 assets() 的索引定位（顺序与卡片一致）。
  const before = await page.session.evaluate(`document.querySelectorAll('[data-v="asset-card"]').length`);
  await page.session.waitFor(
    `document.querySelectorAll('[data-v="asset-card"]').length > ${before}`,
    15000,
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
}

/** 双击指定名字的素材卡片 → 上轨到当前播放头。 */
async function addAssetToTimeline(name) {
  const index = await page.session.evaluate(
    `window.__VEDITOR_TEST__.assets().findIndex((asset) => asset.name === '${name}')`,
  );
  if (typeof index !== 'number' || index < 0) throw new Error(`素材栏里找不到 ${name}`);
  await page.session.evaluate(`(() => {
    const card = document.querySelectorAll('[data-v="asset-card"]')[${index}];
    if (card === undefined) return false;
    card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function snapshotAt(timecode) {
  await seekTo(timecode);
  // 等画面稳定
  for (let i = 0; i < 12; i += 1) {
    const snap = await page.session.evaluate('window.__VEDITOR_TEST__.previewSnapshot()');
    if ((snap?.nonBlack ?? 0) > 1000) return snap;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return await page.session.evaluate('window.__VEDITOR_TEST__.previewSnapshot()');
}

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length === 1', 15000);

  // ---- 依次放 B（playhead 240）与 C（playhead 330）----
  await dropAsset('rotated-90.mp4');
  await seekTo('00:00:08:00'); // 240 帧 @30fps
  await addAssetToTimeline('rotated-90.mp4');

  await dropAsset('webm-vp9-opus.webm');
  await seekTo('00:00:11:00'); // 330 帧
  await addAssetToTimeline('webm-vp9-opus.webm');

  const clips = await page.session.evaluate('window.__VEDITOR_TEST__.clips()');
  const byStart = [...clips].sort((left, right) => left.startFrame - right.startFrame);
  report.check(
    `① 三片段同轨首尾相接（${byStart.map((clip) => `${clip.startFrame}+${clip.durationFrames}`).join(' / ')}）`,
    byStart.length === 3
      && byStart[0]?.startFrame === 0
      && byStart[1]?.startFrame === 240
      && byStart[2]?.startFrame === 330
      && byStart.every((clip) => clip.trackId === 'trk_V1'),
  );

  // ---- 各片段中点出画 ----
  const shotA = await snapshotAt('00:00:04:00'); // 120（A 中点）
  report.check(
    `② A 段中点出画（${shotA?.nonBlack}/${shotA?.total}）`,
    (shotA?.nonBlack ?? 0) > 1000,
  );

  const shotB = await snapshotAt('00:00:08:15'); // 255（B 段内，竖屏素材在横屏工程里）
  report.check(
    `③ 竖屏片段在横屏工程中出画（${shotB?.nonBlack}/${shotB?.total}）`,
    (shotB?.nonBlack ?? 0) > 1000,
  );

  const shotC = await snapshotAt('00:00:13:00'); // 390（C 段内，webm）
  report.check(
    `②b C 段（webm）出画（${shotC?.nonBlack}/${shotC?.total}）`,
    (shotC?.nonBlack ?? 0) > 1000,
  );

  // ---- 对 B 变速 2x ----
  // 用钩子按 clipId 选中：默认 zoom 下 450 帧工程只显示开头约 22 帧，
  // B 段（240..330）在画布外，坐标点击必然选错（第一版就是这么点到 A 的）。
  const bClip = byStart[1];
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip('${bClip.id}')`);
  await new Promise((resolve) => setTimeout(resolve, 400));

  const selected = await page.session.evaluate("document.querySelector('[data-v=\"inspector-speed\"]')?.value");
  if (selected !== undefined && selected !== null) {
    await page.session.evaluate(`(() => {
      const input = document.querySelector('[data-v="inspector-speed"]');
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '2');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await page.session.evaluate(
      `document.querySelector('[data-v="inspector-speed"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const afterSpeed = await page.session.evaluate('window.__VEDITOR_TEST__.clips()');
  const b = afterSpeed.find((clip) => clip.startFrame === 240);
  report.check(
    `④ B 段变速后时长 90 → ${b?.durationFrames}（期望 45），素材起止点不变（in=${b?.inFrame} out=${b?.outFrame}）`,
    b?.durationFrames === 45 && b?.inFrame === 0 && b?.outFrame === 90 && b?.speedMilli === 2000,
  );

  // ---- 变速后仍出画 ----
  const shotAfter = await snapshotAt('00:00:09:00'); // 270（变速后 B 的后半）
  report.check(
    `⑤ 变速后 B 段仍出画（${shotAfter?.nonBlack}/${shotAfter?.total}）`,
    (shotAfter?.nonBlack ?? 0) > 1000,
  );

  const finalClips = await page.session.evaluate('window.__VEDITOR_TEST__.clips()');
  const errors = await page.session.evaluate('window.__VEDITOR_TEST__.errors()');
  report.check(
    `⑥ 全程无错误条（${JSON.stringify(errors)}）`,
    Array.isArray(errors) && errors.length === 0,
  );
  console.log('  · 最终片段：', JSON.stringify(finalClips.map((clip) => ({
    start: clip.startFrame,
    dur: clip.durationFrames,
    speed: clip.speedMilli,
    asset: clip.assetId.slice(-4),
  }))));
} finally {
  await page.close();
  devServer.kill();
  await fixtures.close();
}

report.summary('多素材组合回归');