/**
 * T07 合成器验收（真浏览器：WebGL2 + Canvas2D）。
 *
 * 断言（team-lead 的 ①–⑥）：
 *   ① 两张纯色按 V1/V2 叠加，captureFrame 中心像素 = 上层颜色（±2）
 *   ② opacity=0.5 → 50% 混合（±2）
 *   ③ scale=2 → 中心区域放大（采样点比对：边框→中心色）
 *   ④ 强制 canvas2d 后 ①②③ 结果一致（±2）
 *   ⑤ 1080p 双 layer 连续 100 帧 endFrame() 平均 < 3ms
 *   ⑥ 空白帧全画面 RGB ≤ 2（逐像素查，不只边缘），且与彩色帧平均差 > 10
 *   附加：captureFrame 与上屏画布 maxCh ≤ 2（同源约束）
 *
 * 运行：`node tests/verify-t07.mjs`
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';
import { createReport, launchPage, startServer } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE_DIR = path.join(ROOT, 'tests', '.cache');

const entry = `
  import { createCompositor, supportsWebGl2, maxChannelDiff } from '../../src/render/compositor.ts';
  window.__T07 = { createCompositor, supportsWebGl2, maxChannelDiff };
`;

fs.mkdirSync(CACHE_DIR, { recursive: true });
await build({
  stdin: { contents: entry, resolveDir: CACHE_DIR, sourcefile: 't07-entry.ts', loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome110'],
  outfile: path.join(CACHE_DIR, 't07-bundle.js'),
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'silent',
});

const bundle = fs.readFileSync(path.join(CACHE_DIR, 't07-bundle.js'), 'utf8');
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>T07</title></head>
<body><div id="stage"></div><script type="module" src="/bundle.js"></script></body></html>`;

const files = new Map([
  ['/', { body: html, type: 'text/html; charset=utf-8' }],
  ['/bundle.js', { body: bundle, type: 'text/javascript; charset=utf-8' }],
]);

const server = await startServer(files);
const page = await launchPage({ url: server.origin + '/', width: 1600, height: 1000 });
// 注入竞态防护：等 bundle 真正执行、window.__T07 挂上后再求值
await page.session.waitFor("window.__T07 && typeof window.__T07.createCompositor === 'function'", 5000);

const report = createReport();

/** Node 侧的通道容差比较（页面内的同名函数不跨上下文）。 */
function near(actual, expected, tolerance) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return actual.every((channel, index) => Math.abs(channel - expected[index]) <= tolerance);
}

try {
  const result = await page.session.evaluate(`(async () => {
    const { createCompositor, supportsWebGl2, maxChannelDiff } = window.__T07;

    function transform(overrides = {}) {
      return { scale: 1, x: 0, y: 0, opacity: 1, blendMode: 'normal', ...overrides };
    }

    async function solid(r, g, b, size = 100) {
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
      ctx.fillRect(0, 0, size, size);
      return createImageBitmap(canvas);
    }

    async function borderRed(size = 100) {
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, size, size);
      const border = Math.round(size * 0.2);
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(border, border, size - border * 2, size - border * 2);
      return createImageBitmap(canvas);
    }

    function toPixels(bitmap) {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, canvas.width, canvas.height);
    }

    function canvasPixels(canvas) {
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const ctx = copy.getContext('2d');
      ctx.drawImage(canvas, 0, 0);
      return ctx.getImageData(0, 0, copy.width, copy.height);
    }

    function pixelAt(image, x, y) {
      const index = (y * image.width + x) * 4;
      return [image.data[index], image.data[index + 1], image.data[index + 2]];
    }

    function near(actual, expected, tolerance) {
      return actual.every((channel, index) => Math.abs(channel - expected[index]) <= tolerance);
    }

    async function basicCases(prefer) {
      const compositor = createCompositor({ width: 100, height: 100, prefer });
      const red = await solid(255, 0, 0);
      const blue = await solid(0, 0, 255);

      // ① V1 红 + V2 蓝，上层不透明 → 蓝
      compositor.beginFrame(0, true);
      compositor.drawLayer(red, transform(), { order: 0, startFrame: 0, index: 0 });
      compositor.drawLayer(blue, transform(), { order: 1, startFrame: 0, index: 0 });
      compositor.endFrame();
      const stacked = toPixels(await compositor.captureFrame());
      const centerStable = pixelAt(stacked, 50, 50);

      // ② 上层 opacity 0.5 → 50% 混合
      compositor.beginFrame(0, true);
      compositor.drawLayer(red, transform(), { order: 0, startFrame: 0, index: 0 });
      compositor.drawLayer(blue, transform({ opacity: 0.5 }), { order: 1, startFrame: 0, index: 0 });
      compositor.endFrame();
      const half = toPixels(await compositor.captureFrame());
      const centerHalf = pixelAt(half, 50, 50);

      // ③ scale=2 → 边框被推出画面，中心区域变成红色
      const bordered = await borderRed(100);
      compositor.beginFrame(0, true);
      compositor.drawLayer(bordered, transform(), { order: 0, startFrame: 0, index: 0 });
      compositor.endFrame();
      const scale1 = toPixels(await compositor.captureFrame());
      const edgeScale1 = pixelAt(scale1, 85, 50);

      compositor.beginFrame(0, true);
      compositor.drawLayer(bordered, transform({ scale: 2 }), { order: 0, startFrame: 0, index: 0 });
      compositor.endFrame();
      const scale2 = toPixels(await compositor.captureFrame());
      const edgeScale2 = pixelAt(scale2, 85, 50);

      // 层序：同 order 时 startFrame 更小者压上面
      const green = await solid(0, 255, 0);
      compositor.beginFrame(0, true);
      compositor.drawLayer(blue, transform(), { order: 0, startFrame: 0, index: 1 });
      compositor.drawLayer(green, transform(), { order: 0, startFrame: 10, index: 0 });
      compositor.endFrame();
      const orderTie = pixelAt(toPixels(await compositor.captureFrame()), 50, 50);

      // 空白帧
      compositor.beginFrame(0, true);
      compositor.endFrame();
      const blank = toPixels(await compositor.captureFrame());
      let blankMax = 0;
      let blankAlphaMin = 255;
      for (let index = 0; index < blank.data.length; index += 4) {
        blankMax = Math.max(blankMax, blank.data[index], blank.data[index + 1], blank.data[index + 2]);
        blankAlphaMin = Math.min(blankAlphaMin, blank.data[index + 3]);
      }
      let diffSum = 0;
      for (let index = 0; index < blank.data.length; index += 4) {
        diffSum += Math.abs(blank.data[index] - stacked.data[index]);
        diffSum += Math.abs(blank.data[index + 1] - stacked.data[index + 1]);
        diffSum += Math.abs(blank.data[index + 2] - stacked.data[index + 2]);
      }
      // 命名区分：这是"空白 vs 有内容"的语义判别，不是跨链路反例线（wrongFrameDiff）
      const blankVsContentDiff = diffSum / (blank.data.length / 4);

      // 同源：captureFrame vs 上屏 canvas
      compositor.beginFrame(0, true);
      compositor.drawLayer(red, transform(), { order: 0, startFrame: 0, index: 0 });
      compositor.drawLayer(blue, transform({ opacity: 0.5 }), { order: 1, startFrame: 0, index: 0 });
      compositor.endFrame();
      const captured = toPixels(await compositor.captureFrame());
      const onScreen = canvasPixels(compositor.canvas);
      const sameSourceMax = maxChannelDiff(captured, onScreen);
      let maxAt = null;
      let maxDiff = 0;
      for (let y = 0; y < captured.height; y += 1) {
        for (let x = 0; x < captured.width; x += 1) {
          const i = (y * captured.width + x) * 4;
          for (let c = 0; c < 4; c += 1) {
            const d = Math.abs(captured.data[i + c] - onScreen.data[i + c]);
            if (d > maxDiff) {
              maxDiff = d;
              maxAt = { x, y, c, captured: captured.data[i + c], screen: onScreen.data[i + c] };
            }
          }
        }
      }

      const kind = compositor.kind;
      compositor.dispose();

      return {
        kind,
        centerStable,
        centerHalf,
        edgeScale1,
        edgeScale2,
        orderTie,
        blankMax,
        blankAlphaMin,
        blankVsContentDiff,
        sameSourceMax,
        maxAt,
        lengths: [captured.data.length, onScreen.data.length],
        capturedSample: pixelAt(captured, 50, 50),
        onScreenSample: pixelAt(onScreen, 50, 50),
        canvasSize: [compositor.canvas.width, compositor.canvas.height],
        stacked,
      };
    }

    const webgl = supportsWebGl2() ? await basicCases('webgl2') : null;
    const canvas2d = await basicCases('canvas2d');

    // ⑤ 1080p 双 layer 连续 100 帧
    const wide = createCompositor({ width: 1920, height: 1080 });
    const bitmapA = await solid(255, 0, 0, 1920);
    const bitmapB = await solid(0, 0, 255, 1920);
    // 预热 3 帧
    for (let index = 0; index < 3; index += 1) {
      wide.beginFrame(0, true);
      wide.drawLayer(bitmapA, transform(), { order: 0, startFrame: 0, index: 0 });
      wide.drawLayer(bitmapB, transform({ opacity: 0.5 }), { order: 1, startFrame: 0, index: 0 });
      wide.endFrame();
    }
    const started = performance.now();
    for (let index = 0; index < 100; index += 1) {
      wide.beginFrame(index, true);
      wide.drawLayer(bitmapA, transform(), { order: 0, startFrame: 0, index: 0 });
      wide.drawLayer(bitmapB, transform({ opacity: 0.5 }), { order: 1, startFrame: 0, index: 0 });
      wide.endFrame();
    }
    const totalMs = performance.now() - started;
    const stats = wide.stats();
    wide.dispose();

    return {
      webglAvailable: supportsWebGl2(),
      webgl,
      canvas2d,
      perf: { totalMs, avgMs: totalMs / 100, statsAvgMs: stats.avgEndFrameMs, frames: stats.frames },
    };
  })()`);

  // ---- 断言 ----
  report.check('WebGL2 可用（主路径被真实执行）', result.webglAvailable === true);
  const webgl = result.webgl;
  if (webgl) {
    report.check(
      `① WebGL2 上层颜色覆盖（中心 ${JSON.stringify(webgl.centerStable)}）`,
      Array.isArray(webgl.centerStable) &&
        Math.abs(webgl.centerStable[2] - 255) <= 2 &&
        Math.abs(webgl.centerStable[0] - 0) <= 2,
    );
    report.check(
      `② opacity=0.5 → 50% 混合（中心 ${JSON.stringify(webgl.centerHalf)}）`,
      near(webgl.centerHalf, [127, 0, 127], 2),
    );
    report.check(
      `③ scale=2 中心放大（边框像素 ${JSON.stringify(webgl.edgeScale1)} → ${JSON.stringify(webgl.edgeScale2)}）`,
      webgl.edgeScale1[0] <= 40 && webgl.edgeScale2[0] >= 200,
    );
    report.check(
      `层序：同 order 时 startFrame 更小者压上面（${JSON.stringify(webgl.orderTie)}，期望蓝）`,
      webgl.orderTie[2] >= 250 && webgl.orderTie[1] <= 5,
    );
    report.check(`⑥ 空白帧最大通道值 ${webgl.blankMax} ≤ 2`, webgl.blankMax <= 2);
    report.check(
      `⑥ 空白帧 alpha 全为 255（min=${webgl.blankAlphaMin} ≥ 253）`,
      webgl.blankAlphaMin >= 253,
    );
    report.check(
      `⑥ 空白帧与彩色帧平均差 blankVsContentDiff=${webgl.blankVsContentDiff.toFixed(1)} > 10`,
      webgl.blankVsContentDiff > 10,
    );
    report.check(
      `同源约束：captureFrame 与上屏 maxCh=${webgl.sameSourceMax} ≤ 2`,
      webgl.sameSourceMax <= 2,
      `capture=${JSON.stringify(webgl.capturedSample)} screen=${JSON.stringify(webgl.onScreenSample)} maxAt=${JSON.stringify(webgl.maxAt)} lengths=${JSON.stringify(webgl.lengths)}`,
    );
  }

  const canvas2d = result.canvas2d;
  report.check(
    `④ Canvas2D 降级：① 结果一致（${JSON.stringify(canvas2d.centerStable)}）`,
    near(canvas2d.centerStable, webgl ? webgl.centerStable : [0, 0, 255], 2),
  );
  report.check(
    `④ Canvas2D 降级：② 结果一致（${JSON.stringify(canvas2d.centerHalf)}）`,
    near(canvas2d.centerHalf, [127, 0, 127], 2),
  );
  report.check(
    `④ Canvas2D 降级：③ 结果一致（${JSON.stringify(canvas2d.edgeScale1)} → ${JSON.stringify(canvas2d.edgeScale2)}）`,
    canvas2d.edgeScale1[0] <= 40 && canvas2d.edgeScale2[0] >= 200,
  );
  report.check(`⑥ Canvas2D 空白帧最大通道值 ${canvas2d.blankMax} ≤ 2`, canvas2d.blankMax <= 2);
  report.check(
    `⑥ Canvas2D 空白帧 alpha（min=${canvas2d.blankAlphaMin} ≥ 253）`,
    canvas2d.blankAlphaMin >= 253,
  );
  report.check(
    `同源约束：Canvas2D captureFrame 与上屏 maxCh=${canvas2d.sameSourceMax} ≤ 2`,
    canvas2d.sameSourceMax <= 2,
  );

  report.check(
    `⑤ 1080p 双 layer 100 帧 endFrame 平均 ${result.perf.avgMs.toFixed(3)}ms < 3ms`,
    result.perf.avgMs < 3,
    `stats.avg=${result.perf.statsAvgMs.toFixed(3)}ms`,
  );

  report.summary('T07 合成器验收');
} finally {
  await page.close();
  await server.close();
}
