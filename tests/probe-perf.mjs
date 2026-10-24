/**
 * 长工程性能摸底探针（一次性，不进 npm test）。
 *
 * 方法：构造 0 / 150 / 500 片段三档工程（文字片段不需要素材，dispatch 一次造齐），
 * 页面内注入 rAF 采样器记录帧间隔，CDP 合成 滚动/缩放/拖拽/滑块 操作，
 * 输出各操作的 p50/p95 帧间隔（16.7ms = 60fps 基准）。
 *
 * 运行：`node --experimental-websocket tests/probe-perf.mjs`
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5858;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
const ev = async (expression) => page.session.evaluate(expression);

// 真音频素材（音量测试需要 hasAudio 片段——文字片段让 commitAudio 早退，测不到 dispatch）
import http from 'node:http';
import fs from 'node:fs';
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'sample-720p.mp4');
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

/** 注入/重置帧采样器（每次调用重启循环：上次 measure 结尾把 __rafOn 关了）。 */
const armSampler = () => ev(`(() => {
  window.__frames = [];
  window.__rafOn = true;
  const tick = (now) => {
    if (!window.__rafOn) return;
    window.__frames.push(now);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
})()`);
const readStats = async () => ev(`(() => {
  const frames = window.__frames ?? [];
  window.__frames = [];
  const gaps = [];
  for (let i = 1; i < frames.length; i += 1) gaps.push(frames[i] - frames[i - 1]);
  gaps.sort((a, b) => a - b);
  const at = (p) => (gaps.length === 0 ? -1 : Math.round(gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))] * 10) / 10);
  return { n: gaps.length, p50: at(0.5), p95: at(0.95), max: gaps.length === 0 ? -1 : Math.round(gaps[gaps.length - 1] * 10) / 10 };
})()`);

/** 造 N 段文字片段（一次 dispatch；startFrame 错开 90 帧）。 */
const seedClips = (count) => ev(`(() => {
  const doc = window.__VEDITOR_TEST__.docSnapshot ? null : null;
  // 直接构造 addClip 批量（文字片段不需要素材）
  const clips = [];
  for (let i = 0; i < ${count}; i += 1) {
    clips.push({
      op: 'addClip',
      clip: {
        id: 'perf_' + i, assetId: '', trackId: 'trk_V1',
        startFrame: i * 90, inFrame: 0, outFrame: 90, durationFrames: 90,
        speedMilli: 1000, enabled: true,
        transform: { scale: 1, x: 0, y: 0, opacity: 1, blendMode: 'normal', rotation: 0, flipX: false, flipY: false },
        audio: { gain: 1, fadeInFrames: 0, fadeOutFrames: 0 },
        effects: [], transitionIn: null, transitionOut: null,
        text: { content: '片段' + i, fontSize: 32, color: '#ffffff', align: 'center', x: 0, y: 0, background: '' },
        keyframes: [], source: 'ui',
      },
    });
  }
  window.__VEDITOR_TEST__.dispatch(clips, '性能造段');
  return true;
})()`);

const fmt = (stats) => `p50=${stats.p50}ms p95=${stats.p95}ms max=${stats.max}ms (n=${stats.n})`;

async function measure(label, action) {
  await armSampler();
  await sleep(100);
  const before = await readStats(); // 清掉 arm 到动作前的空转帧
  void before;
  await armSampler();
  await action();
  await sleep(500);
  const stats = await readStats();
  await ev(`window.__rafOn = false; true`);
  return { label, stats };
}

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
  await sleep(500);
  await ev(`(() => {
    const root = document.documentElement;
    root.style.setProperty('--v-timeline-h', '420px');
    root.style.setProperty('--v-timeline-pct', '60');
    return true;
  })()`);

  const canvasBox = async () => ev(`(() => {
    const rect = document.querySelector('[data-v="timeline-canvas"]').getBoundingClientRect();
    return { x: Math.round(rect.left + 300), y: Math.round(rect.top + 150), right: Math.round(rect.right) };
  })()`);

  for (const count of [2000]) {
    if (count > 0) {
      await seedClips(count);
      await sleep(400);
      const real = await ev('window.__VEDITOR_TEST__.clips().length');
      console.log(`  （实际片段数：${real}）`);
    }
    await sleep(400);
    console.log(`\n===== ${count} 片段 =====`);

    // 静止基线
    const idle = await measure('静止', async () => { await sleep(800); });
    console.log(`  静止基线   ${fmt(idle.stats)}`);

    // 滚动（40 次 wheel，每 16ms）
    const box = await canvasBox();
    const scroll = await measure('横向滚动×40', async () => {
      for (let i = 0; i < 40; i += 1) {
        await page.session.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 120, deltaY: 0 });
        await sleep(16);
      }
    });
    console.log(`  滚动       ${fmt(scroll.stats)}`);

    // 缩放（Ctrl+wheel ×12）
    const zoom = await measure('缩放×12', async () => {
      for (let i = 0; i < 12; i += 1) {
        await page.session.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: -120, modifiers: 2 });
        await sleep(50);
      }
    });
    console.log(`  缩放       ${fmt(zoom.stats)}`);
    // 缩放回去
    for (let i = 0; i < 12; i += 1) {
      await page.session.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: 120, modifiers: 2 });
      await sleep(30);
    }
    await sleep(200);

    // 音量滑块（change 即提交路径：每次 input 都 dispatch + 全链路通知）
    if (count > 0) {
      // 拖真视频（hasAudio）并选中——文字片段会让 commitAudio 早退
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
      await sleep(800);
      await ev(`document.querySelector('[data-v="asset-card"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true`);
      await sleep(600);
      const videoClipId = await ev(`window.__VEDITOR_TEST__.clips().find((item) => item.assetId !== '').id`);
      await ev(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify('VID')})`.replace('"VID"', JSON.stringify(videoClipId)));
      await sleep(300);
      const versionBefore = await ev('window.__VEDITOR_TEST__.docVersion()');
      const slider = await measure('音量滑块×20', async () => {
        await ev(`(() => {
          const slider = document.querySelector('[data-v="inspector-gain"]');
          if (slider === null) return 'no-slider';
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          for (let i = 0; i < 20; i += 1) {
            setter.call(slider, String(0.2 + i * 0.05));
            slider.dispatchEvent(new Event('input', { bubbles: true }));
          }
          return 'ok';
        })()`);
        await sleep(400);
      });
      const versionAfter = await ev('window.__VEDITOR_TEST__.docVersion()');
      console.log(`  滑块调节    ${fmt(slider.stats)} | 20 次 input → dispatch ${versionAfter - versionBefore} 次（合帧目标 1）`);
    }

    // 拖拽片段（CDP press → 8×move → release）
    if (count > 0) {
      const drag = await measure('拖拽片段', async () => {
        await page.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
        for (let step = 1; step <= 10; step += 1) {
          await page.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + step * 30, y: box.y, button: 'left' });
          await sleep(16);
        }
        await page.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + 300, y: box.y, button: 'left', clickCount: 1 });
      });
      console.log(`  拖拽       ${fmt(drag.stats)}`);
    }
  }

  console.log('\n（16.7ms ≈ 60fps；p95 > 33ms 即可感知掉帧）');
} finally {
  await page.close().catch(() => {});
  dev.kill();
  await new Promise((resolve) => server.close(resolve));
}
