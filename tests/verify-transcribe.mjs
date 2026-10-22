/**
 * 语音识别生成字幕（R-059）端到端验证。
 *
 * ## 这条 E2E 到底在验什么
 *
 * **不验 ASR**（客户端没有识别能力，识别在宿主侧）。验的是我们负责的那一段链路：
 *
 *   时间线 → 混音（48k 立体声）→ 下混单声道 → 重采样 16k → 宿主 → 字幕轨
 *
 * 中间那段只有真浏览器里有 WebCodecs 才能跑，单测证明不了——所以这里用
 * `__VEDITOR_TEST__.installTranscriber()` 装一个"假宿主"，它**检查自己收到的音频**
 * （采样率 / 时长 / 电平），再返回一批**故意带坏数据**的片段，看客户端怎么清洗。
 *
 *   ① 装了通道 → 一句话生成字幕（3 条好片段 + 2 条坏片段被丢弃）
 *   ② 宿主收到的音频确实是 16k 单声道、有声音、时长≈8 秒
 *   ③ 毫秒 → 帧的落点正确（1.5s→45 帧、2s→60 帧、6s→180 帧）
 *   ④ 再跑一次是**整段替换**（还是 3 条，不是 6 条）
 *   ⑤ 一次撤销回到上一次的字幕；再撤销回到没有字幕
 *   ⑥ 没有转写通道时给**可读拒绝**，不产出空字幕
 *
 * 运行：node tests/verify-transcribe.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5221;
const FIXTURE = 'sample-720p.mp4';

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
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
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

/** 假宿主：记录收到的音频，返回"好片段 + 坏片段"混合结果。 */
const INSTALL_FAKE_STT = `(() => {
  window.__stt = { calls: 0, sampleRate: 0, samples: 0, rms: 0, language: '' };
  window.__VEDITOR_TEST__.installTranscriber(async (request) => {
    const audio = request.audio;
    let sum = 0;
    for (let i = 0; i < audio.length; i += 1) sum += (audio[i] || 0) * (audio[i] || 0);
    window.__stt = {
      calls: window.__stt.calls + 1,
      sampleRate: request.sampleRate,
      samples: audio.length,
      rms: Math.sqrt(sum / Math.max(1, audio.length)),
      language: request.language,
    };
    if (typeof request.onProgress === 'function') request.onProgress(1);
    return {
      language: 'zh',
      segments: [
        { startSec: 0, endSec: 1.5, text: '第一句台词' },
        { startSec: 2, endSec: 3.5, text: '第二句台词' },
        // 坏数据：时间戳倒着 / 空文本 —— 客户端必须丢弃，不能让整条字幕轨错位
        { startSec: 5, endSec: 4, text: '时间倒着' },
        { startSec: 4, endSec: 5, text: '   ' },
        { startSec: 6, endSec: 7.2, text: '第三句台词' },
      ],
    };
  });
  return true;
})()`;

async function runCommand(page, text) {
  for (const type of ['keyDown', 'keyUp']) {
    await page.session.send('Input.dispatchKeyEvent', {
      type,
      key: 'k',
      code: 'KeyK',
      windowsVirtualKeyCode: 75,
      modifiers: 2,
    });
  }
  await page.session.waitFor(`!!document.querySelector('[data-v="command-input"]')`, 5000);
  await page.session.evaluate(`(() => {
    const input = document.querySelector('[data-v="command-input"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.session.waitFor(`document.querySelector('[data-v="command-run"]')?.disabled === false`, 5000);
  await page.session.evaluate(`document.querySelector('[data-v="command-run"]').click()`);
}

/** 字幕片段（文本片段）快照。 */
const TEXT_CLIPS = `JSON.stringify(window.__VEDITOR_TEST__.clips()
  .filter((clip) => clip.text !== null)
  .sort((a, b) => a.startFrame - b.startFrame)
  .map((clip) => ({ start: clip.startFrame, duration: clip.durationFrames, text: clip.text.content })))`;

const report = createReport();
const fixture = await startFixtureServer();
const dev = await startDevServer();
const page = await launchPage({
  url: `http://127.0.0.1:${PORT}/?src=${fixture.origin}/${FIXTURE}`,
  width: 1440,
  height: 900,
});

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 15000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 25000);
  await sleep(1200);
  await page.session.evaluate(INSTALL_FAKE_STT);

  // ---- ① 一句话生成字幕 ----
  await runCommand(page, '自动生成字幕');
  await page.session.waitFor(
    `window.__VEDITOR_TEST__.clips().filter((clip) => clip.text !== null).length > 0`,
    30000,
  );
  await sleep(600);
  const clips = JSON.parse(await page.session.evaluate(TEXT_CLIPS));
  report.check(
    `① 生成 3 条字幕（坏片段被丢弃）：${JSON.stringify(clips.map((clip) => clip.text))}`,
    clips.length === 3,
  );

  // ---- ② 宿主收到的音频 ----
  const stt = JSON.parse(await page.session.evaluate('JSON.stringify(window.__stt)'));
  const durationSec = stt.samples / Math.max(1, stt.sampleRate);
  report.check(
    `② 收到 16k 单声道（sampleRate=${stt.sampleRate}，${stt.samples} 个采样 ≈ ${durationSec.toFixed(2)}s）`,
    stt.calls === 1 && stt.sampleRate === 16000 && durationSec > 7.5 && durationSec < 8.5,
  );
  report.check(
    `② 音频有声音（rms=${stt.rms.toFixed(4)}）且语言提示为 ${stt.language}`,
    stt.rms > 0.001 && stt.language === 'zh',
  );

  // ---- ③ 毫秒 → 帧的落点 ----
  // 30fps：1.5s=45 帧、2s=60 帧、3.5s=105（时长 45）、6s=180、7.2s=216（时长 36）
  const expected = [
    { start: 0, duration: 45 },
    { start: 60, duration: 45 },
    { start: 180, duration: 36 },
  ];
  const framesOk = clips.every(
    (clip, index) =>
      clip.start === expected[index]?.start && clip.duration === expected[index]?.duration,
  );
  report.check(
    `③ 落点正确（${clips.map((clip) => `${clip.start}+${clip.duration}`).join(' / ')}，期望 0+45 / 60+45 / 180+36）`,
    framesOk,
  );

  const toast = await page.session.evaluate(
    `document.querySelector('[data-v="toast"]')?.textContent ?? ''`,
  );
  report.check(
    `③ toast 说明丢弃了几条坏片段（${String(toast).replace(/\\s+/g, ' ').trim().slice(0, 40)}）`,
    String(toast).includes('生成字幕') && String(toast).includes('丢弃'),
  );

  // ---- ④ 再跑一次 = 整段替换，不是追加 ----
  await runCommand(page, '重新识别字幕');
  await sleep(2500);
  const replaced = JSON.parse(await page.session.evaluate(TEXT_CLIPS));
  report.check(
    `④ 重复识别是整段替换（仍 ${replaced.length} 条，不是 6 条）`,
    replaced.length === 3,
  );

  // ---- ⑤ 两次撤销 ----
  for (const type of ['keyDown', 'keyUp']) {
    await page.session.send('Input.dispatchKeyEvent', { type, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
  }
  await sleep(800);
  const undoOnce = JSON.parse(await page.session.evaluate(TEXT_CLIPS));
  for (const type of ['keyDown', 'keyUp']) {
    await page.session.send('Input.dispatchKeyEvent', { type, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
  }
  await sleep(800);
  const undoTwice = JSON.parse(await page.session.evaluate(TEXT_CLIPS));
  report.check(
    `⑤ 一次撤销回到上一次结果（${undoOnce.length} 条），再撤销清空（${undoTwice.length} 条）`,
    undoOnce.length === 3 && undoTwice.length === 0,
  );

  // ---- ⑥ 没有转写通道 → 可读拒绝 ----
  await page.session.evaluate(`window.__VEDITOR_TEST__.installTranscriber(undefined)`);
  await runCommand(page, '自动生成字幕');
  await page.session.waitFor(`!!document.querySelector('[data-v="command-error"]')`, 20000);
  const errorText = await page.session.evaluate(
    `document.querySelector('[data-v="command-error"]').textContent`,
  );
  const afterFail = JSON.parse(await page.session.evaluate(TEXT_CLIPS));
  report.check(
    `⑥ 无通道时给可读拒绝（"${String(errorText).trim().slice(0, 30)}…"）`,
    /未提供语音识别通道/.test(String(errorText)),
  );
  report.check(`⑥ 拒绝时不产出空字幕（${afterFail.length} 条）`, afterFail.length === 0);

  const errors = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.errors())'));
  report.check(`⑦ 全程无页面错误（${JSON.stringify(errors)}）`, Array.isArray(errors) && errors.length === 0);

  report.summary('语音识别生成字幕（R-059）');
} finally {
  await page.close();
  dev.kill();
  await fixture.close();
}
