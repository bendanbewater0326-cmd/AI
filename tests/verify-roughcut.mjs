/**
 * 智能粗剪端到端验证（R-060）：一句话去掉长停顿。
 *
 * ## 为什么要单独一个 E2E
 *
 * 单测只能证明"给定 PCM，检测和删除是对的"；真正会坏的是**接线**：
 * 命令栏有没有在调模型前拦下这条指令、分析期间 UI 有没有反馈、
 * 结果是不是**一个撤销步**、失败时给的是不是可读原因。
 *
 * 素材是 ffmpeg 合成的：**3 秒 440Hz 音 + 2 秒数字静音 + 3 秒音**（8 秒 @30fps）。
 * 期望：剪掉中间 2 秒（收 0.1 秒余量后约 54 帧），片段从 1 段变 2 段，
 * 总时长 240 → 约 186 帧，**一次 Ctrl+Z 全部还原**。
 *
 * 运行：node tests/verify-roughcut.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5211;
const FIXTURE = 'roughcut-8s.mp4';

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

const report = createReport();
const fixture = await startFixtureServer();
const dev = await startDevServer();
const page = await launchPage({
  url: `http://127.0.0.1:${PORT}/?src=${fixture.origin}/${FIXTURE}`,
  width: 1440,
  height: 900,
});

/** 读时间线快照：片段布局 + 总时长（由片段算，不依赖内部派生值）。 */
async function snapshot() {
  return JSON.parse(
    await page.session.evaluate(`(() => {
      const clips = window.__VEDITOR_TEST__.clips();
      const duration = clips.reduce((max, clip) => Math.max(max, clip.startFrame + clip.durationFrames), 0);
      return JSON.stringify({ count: clips.length, duration, clips });
    })()`),
  );
}

async function openCommandBar(text) {
  await page.session.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'k',
    code: 'KeyK',
    windowsVirtualKeyCode: 75,
    modifiers: 2,
  });
  await page.session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'k',
    code: 'KeyK',
    windowsVirtualKeyCode: 75,
    modifiers: 2,
  });
  await page.session.waitFor(`!!document.querySelector('[data-v="command-input"]')`, 5000);
  await page.session.evaluate(`(() => {
    const input = document.querySelector('[data-v="command-input"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  // 等按钮从 disabled 变可点再点：`input` 事件里 setState 是异步的，
  // 紧接着 click 会点在还是 disabled 的按钮上被浏览器吞掉（表现为"什么都没发生 + 超时"）。
  await page.session.waitFor(`document.querySelector('[data-v="command-run"]')?.disabled === false`, 10000);
  await page.session.evaluate(`document.querySelector('[data-v="command-run"]').click()`);
}

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 15000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 25000);
  const initial = await snapshot();
  report.check(
    `① 素材已上轨（${initial.count} 段 / ${initial.duration} 帧 = ${(initial.duration / 30).toFixed(1)}s）`,
    initial.count === 1 && initial.duration === 240,
  );

  // ---- ② 说一句话：去掉超过 1 秒的停顿 ----
  await openCommandBar('去掉超过 1 秒的停顿');
  const deadline = Date.now() + 30000;
  let after = initial;
  while (Date.now() < deadline) {
    after = await snapshot();
    if (after.count > initial.count) break;
    await sleep(300);
  }

  const removed = initial.duration - after.duration;
  report.check(
    `② 停顿被剪掉（片段 ${initial.count} → ${after.count}，总时长 ${initial.duration} → ${after.duration} 帧）`,
    after.count === 2 && removed > 0,
  );
  report.check(
    `② 剪掉的是中间 2 秒（实测 ${removed} 帧 ≈ ${(removed / 30).toFixed(2)}s，含 0.1s 余量）`,
    removed >= 45 && removed <= 65,
  );
  const firstEnd = after.clips[0].startFrame + after.clips[0].durationFrames;
  report.check(
    `② 第一段结束于约第 93 帧（实测 ${firstEnd}），第二段紧接其后（${after.clips[1]?.startFrame}）`,
    Math.abs(firstEnd - 93) <= 4 && after.clips[1]?.startFrame === firstEnd,
  );

  // ---- ③ toast 给可读描述 + 撤销入口 ----
  const toast = await page.session.evaluate(
    `document.querySelector('[data-v="toast"]')?.textContent ?? ''`,
  );
  report.check(`③ toast 说明剪了什么（${String(toast).slice(0, 28)}…）`, /去掉\s*1\s*段停顿/.test(String(toast)));
  report.check('③ toast 带撤销入口', /撤销/.test(String(toast)));

  await page.screenshot({ path: path.join(ROOT, 'tests', 'screenshots', 'roughcut.png') });

  // ---- ④ 一次 Ctrl+Z 全部还原（一个撤销步） ----
  await page.session.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'z',
    code: 'KeyZ',
    windowsVirtualKeyCode: 90,
    modifiers: 2,
  });
  await page.session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'z',
    code: 'KeyZ',
    windowsVirtualKeyCode: 90,
    modifiers: 2,
  });
  await sleep(600);
  const restored = await snapshot();
  report.check(
    `④ 一次撤销完全还原（${restored.count} 段 / ${restored.duration} 帧）`,
    restored.count === 1 && restored.duration === 240,
  );

  // ---- ⑤ 没有足够长的停顿 → 可读原因，不改时间线 ----
  await openCommandBar('去掉超过 5 秒的停顿');
  await page.session.waitFor(`!!document.querySelector('[data-v="command-error"]')`, 30000);
  const errorText = await page.session.evaluate(
    `document.querySelector('[data-v="command-error"]')?.textContent ?? ''`,
  );
  const untouched = await snapshot();
  report.check(
    `⑤ 无长停顿时给出可读原因（${String(errorText).slice(0, 30)}…）`,
    /没有找到超过 5 秒的停顿/.test(String(errorText)),
  );
  report.check(`⑤ 失败时时间线未被改动（${untouched.count} 段 / ${untouched.duration} 帧）`, untouched.count === 1 && untouched.duration === 240);

  // ---- ⑥ 提问式不执行 ----
  await page.session.evaluate(`document.querySelector('[data-v="command-close"]')?.click()`);
  // 必须等命令栏真的从 DOM 消失再开：否则 Ctrl+K 打在"还开着"的栏上，
  // 输入框里的旧文字还在，后面的 set 值会被 React 的 open 副作用覆盖掉
  await page.session.waitFor(`!document.querySelector('[data-v="command-bar"]')`, 5000);
  await openCommandBar('这里的停顿怎么处理');
  await page.session.waitFor(
    `!!document.querySelector('[data-v="command-suggestion"]') || !!document.querySelector('[data-v="command-error"]')`,
    30000,
  );
  const afterQuestion = await snapshot();
  report.check(
    `⑥ 提问式只给建议、不改时间线（${afterQuestion.count} 段 / ${afterQuestion.duration} 帧）`,
    afterQuestion.count === 1 && afterQuestion.duration === 240,
  );

  const errors = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.errors())'));
  report.check(`⑦ 全程无页面错误（${JSON.stringify(errors)}）`, Array.isArray(errors) && errors.length === 0);

  report.summary('智能粗剪（R-060）');
} finally {
  await page.close();
  dev.kill();
  await fixture.close();
}
