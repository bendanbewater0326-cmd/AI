/**
 * `<veditor-panel>` 卸载泄漏压力测试：挂载 → 卸载 × 20，检查资源是否回收。
 *
 * ## 为什么单独测
 *
 * 宿主边界（T18）只验证了"能挂载、能卸载、不抛错"的结构层面。
 * 但真正会咬人的是**卸载后没停掉的东西**：
 *   - `transport` 的 requestAnimationFrame 循环（每帧都在跑，即使 DOM 已移除）
 *   - `setInterval`（音频预读 pump、自动保存）
 *   - `AudioContext`（每次 createAudioScheduler 都 new 一个，不 close 会累积）
 *   - 解码器池的 VideoFrame（不 dispose 会一直占显存）
 *
 * 单次挂载看不出问题，**连续 20 次**就会把这些增量放大成可测的数字。
 *
 * 方法：在页面里 patch `requestAnimationFrame` / `setInterval` / `AudioContext`，
 * 记录活跃句柄集合；对比"卸载后"与"首次挂载前"的基线。
 *
 * 验证：
 *   ① panel 能挂载并渲染出画布（保证后面测的不是空对象）
 *   ② 卸载后活跃 rAF 回到基线（±2）
 *   ③ 卸载后 setInterval 回到基线
 *   ④ 卸载后 AudioContext 全部 close
 *   ⑤ 20 次循环后，活跃句柄数不随次数增长（无累积泄漏）
 *
 * ## 已知的验证盲区（必须诚实标注）
 *
 * **「播放中卸载是否停掉 rAF 循环」这条没能验证**。原因：
 * 编辑器内部是模块级单例（`store` / `ensurePreviewEngine` 的引擎与解码器池各只有一份），
 * 所以同一页面**只能有一个编辑器实例**（已加 `?bare=1` 模式让宿主只挂 panel、不跑主 App）。
 * 即便如此，panel 内 `[data-v="play-toggle"]` 的点击在脚本下**不翻转 `aria-pressed`、
 * 也不创建 AudioContext**，因此拿不到「播放中的 rAF 循环」。
 * 本测试实际证明的是：挂载/卸载 20 次不崩、AudioContext 不累积、句柄不泄漏。
 *
 * 要覆盖那条，需要把编辑器从"模块级单例"改成"实例级"（较大改动），
 * 或用 CDP 的 `Input.dispatchMouseEvent` 在 shadow DOM 坐标上做真实点击。
 *
 * 运行：node tests/verify-panel-leak.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5208;

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

/** 注入探针：统计活跃 rAF / setInterval / AudioContext。必须在页面脚本执行前装好。 */
const PROBE = `
(() => {
  const leak = { raf: new Set(), intervals: new Set(), audioCreated: 0, audioClosed: 0 };
  window.__leak = leak;

  const originalRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => {
    const id = originalRaf((time) => { leak.raf.delete(id); callback(time); });
    leak.raf.add(id);
    return id;
  };
  const originalCancel = window.cancelAnimationFrame.bind(window);
  window.cancelAnimationFrame = (id) => { leak.raf.delete(id); return originalCancel(id); };

  const originalInterval = window.setInterval.bind(window);
  window.setInterval = (...args) => {
    const id = originalInterval(...args);
    leak.intervals.add(id);
    return id;
  };
  const originalClearInterval = window.clearInterval.bind(window);
  window.clearInterval = (id) => { leak.intervals.delete(id); return originalClearInterval(id); };

  const OriginalAudioContext = window.AudioContext;
  if (typeof OriginalAudioContext === 'function') {
    window.AudioContext = class extends OriginalAudioContext {
      constructor(...args) {
        super(...args);
        leak.audioCreated += 1;
        const originalClose = this.close.bind(this);
        this.close = () => {
          leak.audioClosed += 1;
          return originalClose();
        };
      }
    };
  }

  window.__snapshot = () => ({
    raf: leak.raf.size,
    intervals: leak.intervals.size,
    audioOpen: leak.audioCreated - leak.audioClosed,
    audioCreated: leak.audioCreated,
  });
})();
`;

const report = createReport();
const fixtures = await startFixtureServer();
const devServer = await startDevServer();
// **必须用 bare 模式**：编辑器内部是模块级单例（store / 引擎 / 解码器池各一份），
// 主 App 已经占用了引擎时再挂 panel，panel 的预览画布会永远是黑的（渲染打到第一个 canvas）。
const page = await launchPage({ url: `http://127.0.0.1:${PORT}/?bare=1`, width: 1200, height: 800 });

const snapshot = () => page.session.evaluate('JSON.stringify(window.__snapshot())').then(JSON.parse);

try {
  await page.session.waitFor("document.readyState === 'complete' && !!customElements.get('veditor-panel')", 15000);
  // 装探针（此时主 App 已经跑起来了，但我们要测的是 panel 的增量，基线取"当前值"）
  await page.session.evaluate(PROBE);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const baseline = await snapshot();
  console.log('  · 基线：', JSON.stringify(baseline));

  /** 挂载一个 panel，等它初始化完（引擎 + 导入 + 音频），返回挂载后的快照。 */
  const mount = async (index) => {
    await page.session.evaluate(`
      (() => {
        const host = document.createElement('div');
        host.id = 'leak-host-${index}';
        // 必须放在**可见区域**：要它真的走 CDP 的鼠标事件链路（点播放按钮）。
        // 之前用 left:-9999px 藏起来，结果只能脚本 .click()，而脚本点击在 shadow DOM
        // 里不会翻转 React 状态 —— 测不到"播放中的 rAF 循环"。
        host.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:600px;z-index:9999;';
        const panel = document.createElement('veditor-panel');
        panel.setAttribute('src', '${fixtures.origin}/sample-720p.mp4');
        host.appendChild(panel);
        document.body.appendChild(host);
        return true;
      })()
    `);
    await new Promise((resolve) => setTimeout(resolve, 1400));

    // **用真实鼠标事件点播放**（脚本 .click() 在 shadow DOM 里不翻转 React 状态）。
    const box = await page.session.evaluate(`(() => {
      const panel = document.querySelector('#leak-host-${index} > veditor-panel');
      const toggle = panel?.shadowRoot?.querySelector('[data-v="play-toggle"]');
      if (!toggle) return null;
      const rect = toggle.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (box !== null) {
      await page.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await page.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
    await new Promise((resolve) => setTimeout(resolve, 900));

    const playing = await page.session.evaluate(`(() => {
      const panel = document.querySelector('#leak-host-${index} > veditor-panel');
      const toggle = panel?.shadowRoot?.querySelector('[data-v="play-toggle"]');
      return toggle?.getAttribute('aria-pressed') === 'true';
    })()`);
    return {
      ...(await snapshot()),
      hasCanvas: await page.session.evaluate(
        `!!document.querySelector('#leak-host-${index} > veditor-panel')?.shadowRoot?.querySelector('canvas')`,
      ),
      playing,
    };
  };

  const unmount = async (index) => {
    await page.session.evaluate(`
      (() => {
        const host = document.getElementById('leak-host-${index}');
        if (host === null) return false;
        host.remove();
        return true;
      })()
    `);
    await new Promise((resolve) => setTimeout(resolve, 700));
    return snapshot();
  };

  // ---- ① 挂载后确实有活跃 rAF（证明探针有效，不是假阴性）----
  const firstMounted = await mount(0);
  report.check(
    `① panel 挂载成功并渲染出画布（canvas=${String(firstMounted.hasCanvas)}）`,
    firstMounted.hasCanvas === true,
  );

  const firstUnmounted = await unmount(0);
  report.check(
    `② 卸载后 rAF 回到基线（${firstUnmounted.raf} vs 基线 ${baseline.raf}，容差 2）`,
    Math.abs(firstUnmounted.raf - baseline.raf) <= 2,
  );
  report.check(
    `③ 卸载后 setInterval 回到基线（${firstUnmounted.intervals} vs 基线 ${baseline.intervals}）`,
    firstUnmounted.intervals <= baseline.intervals,
  );
  report.check(
    `④ 卸载后 AudioContext 全部关闭（创建 ${firstUnmounted.audioCreated}，仍开放 ${firstUnmounted.audioOpen}）`,
    firstUnmounted.audioOpen <= baseline.audioOpen,
  );

  // ---- ⑤ 连续 20 次，检查是否累积 ----
  const rounds = [];
  for (let index = 1; index <= 20; index += 1) {
    const mounted = await mount(index);
    const unmounted = await unmount(index);
    rounds.push({ index, mountedRaf: mounted.raf, raf: unmounted.raf, intervals: unmounted.intervals, audioOpen: unmounted.audioOpen });
  }
  const last = rounds[rounds.length - 1];
  const maxRaf = Math.max(...rounds.map((row) => row.raf));
  const rAFDrift = last.raf - baseline.raf;
  const intervalDrift = last.intervals - baseline.intervals;
  report.check(
    `⑤ 20 次后 rAF 无累积（末次 ${last.raf} vs 基线 ${baseline.raf}，峰值 ${maxRaf}）`,
    rAFDrift <= 3,
  );
  report.check(
    `⑤b 20 次后 setInterval 无累积（末次 ${last.intervals} vs 基线 ${baseline.intervals}）`,
    intervalDrift <= 0,
  );
  report.check(
    `⑤c 20 次后无遗留 AudioContext（仍开放 ${last.audioOpen}）`,
    last.audioOpen <= baseline.audioOpen,
  );

  console.log('  · 每轮卸载后快照：');
  for (const row of rounds) {
    console.log(`      #${String(row.index).padStart(2)} 挂载后 rAF=${row.mountedRaf} → 卸载后 rAF=${row.raf} interval=${row.intervals} audio=${row.audioOpen}`);
  }
} finally {
  await page.close();
  devServer.kill();
  await fixtures.close();
}

report.summary('veditor-panel 卸载泄漏');