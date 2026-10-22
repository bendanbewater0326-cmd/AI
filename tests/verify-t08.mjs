/**
 * T08 Transport 验收（真浏览器：performance.now / rAF / visibilitychange）。
 *
 * 断言（team-lead 的 ①–⑥）：
 *   ① 无音频 play() 10 秒，currentFrame 与真实经过时间偏差 ≤ 1 帧
 *   ② document.hidden（注入 isHidden）触发 pause
 *   ③ seekTo(frame,'exact') 后 currentFrame() === 目标帧（容差 0）
 *   ④ 逐帧 ±1 / ±10 在首尾停住
 *   ⑤ 时钟源切换（audio → perf）帧号不跳变（连续采样差 ≤ 1）
 *   ⑥ scrub 连续 100 次 seek：每次都返回可显示帧，commitCount 增量 ≤ 1
 *   附加：播到末帧自动暂停且不回绕（R-007）
 *
 * 运行：`node tests/verify-t08.mjs`
 */
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { createReport, launchPage, startServer } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE_DIR = path.join(ROOT, 'tests', '.cache');

const entry = `
  import { createTransport } from '../../src/media/playbackClock.ts';
  window.__T08 = { createTransport };
`;

fs.mkdirSync(CACHE_DIR, { recursive: true });
await build({
  stdin: { contents: entry, resolveDir: CACHE_DIR, sourcefile: 't08-entry.ts', loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome110'],
  outfile: path.join(CACHE_DIR, 't08-bundle.js'),
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'silent',
});

const bundle = fs.readFileSync(path.join(CACHE_DIR, 't08-bundle.js'), 'utf8');
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>T08</title></head>
<body><script type="module" src="/bundle.js"></script></body></html>`;

const server = await startServer(
  new Map([
    ['/', { body: html, type: 'text/html; charset=utf-8' }],
    ['/bundle.js', { body: bundle, type: 'text/javascript; charset=utf-8' }],
  ]),
);
const page = await launchPage({ url: server.origin + '/', width: 1280, height: 720 });
// 注入竞态防护：等 bundle 真正执行、window.__T08 挂上后再求值
await page.session.waitFor("window.__T08 && typeof window.__T08.createTransport === 'function'", 5000);

const report = createReport();

try {
  const result = await page.session.evaluate(`(async () => {
    const { createTransport } = window.__T08;
    const FPS = 30000; // 30fps，毫帧率

    function makeAudioClock() {
      let running = false;
      let base = performance.now() / 1000;
      return {
        starts: 0,
        stops: 0,
        now() {
          if (!running) return base + (performance.now() - base * 1000) / 1000;
          return performance.now() / 1000;
        },
        hasAudibleAudioAt() {
          return true;
        },
        start() {
          running = true;
          this.starts += 1;
        },
        stop() {
          running = false;
          this.stops += 1;
        },
      };
    }

    // ① 10 秒漂移（无音频）
    const played = [];
    const t1 = createTransport({
      fpsMilli: FPS,
      durationFrames: () => 3600 * 30,
      onFrame: (frame, info) => {
        played.push({ frame, mode: info.mode, exact: info.exact });
      },
    });
    const startedAt = performance.now();
    t1.play();
    await new Promise((resolve) => setTimeout(resolve, 10000));
    const frameAfter10s = t1.currentFrame();
    const elapsedSec = (performance.now() - startedAt) / 1000;
    const expectedFrame = Math.floor(elapsedSec * 30);
    const drift = Math.abs(frameAfter10s - expectedFrame);
    t1.pause();
    const playCommits = played.length;
    t1.dispose();

    // ② hidden 自动暂停
    let hidden = false;
    const hiddenTransport = createTransport({
      fpsMilli: FPS,
      durationFrames: () => 3600 * 30,
      isHidden: () => hidden,
    });
    hiddenTransport.play();
    await new Promise((resolve) => setTimeout(resolve, 120));
    hidden = true;
    await new Promise((resolve) => setTimeout(resolve, 120));
    const pausedByHidden = hiddenTransport.playing === false;
    hiddenTransport.dispose();

    // ③ exact seek
    const seeks = [];
    const seekTransport = createTransport({
      fpsMilli: FPS,
      durationFrames: () => 240,
      onFrame: (frame, info) => {
        seeks.push({ frame, mode: info.mode, exact: info.exact });
      },
    });
    seekTransport.seekTo(137, 'exact');
    await seekTransport.whenIdle();
    const exactFrame = seekTransport.currentFrame();
    const exactInfo = seeks[seeks.length - 1];

    // ③b preview 模式：立即提交近似帧（exact=false），不 await
    const previewSeeks = [];
    const previewTransport = createTransport({
      fpsMilli: FPS,
      durationFrames: () => 240,
      onFrame: (frame, info) => {
        previewSeeks.push({ frame, mode: info.mode, exact: info.exact });
      },
    });
    const previewReturn = previewTransport.seekTo(50, 'preview');
    const previewInfo = previewSeeks[0] ?? null;
    const previewCommitCount = previewTransport.stats().commitCount;
    previewTransport.dispose();

    // ④ 逐帧边界
    seekTransport.seekTo(0, 'exact');
    await seekTransport.whenIdle();
    const stepNeg1 = seekTransport.step(-1);
    const stepNeg10 = seekTransport.step(-10);
    seekTransport.seekTo(239, 'exact');
    await seekTransport.whenIdle();
    const stepPos1 = seekTransport.step(1);
    const stepPos10 = seekTransport.step(10);
    seekTransport.dispose();

    // ⑤ 时钟源切换（audio → perf）
    const audioClock = makeAudioClock();
    const switched = createTransport({
      fpsMilli: FPS,
      durationFrames: () => 3600 * 30,
      audioClock,
    });
    switched.play();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const beforeSwitch = switched.currentFrame();
    const sourceBefore = switched.source;
    switched.setAudioClock(null);
    const afterSwitch = switched.currentFrame();
    const sourceAfter = switched.source;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterSwitchAdvance = switched.currentFrame() - afterSwitch;
    switched.pause();
    switched.dispose();

    // ⑤b notifyAudioLost（播放中丢音频）
    const audioClock2 = makeAudioClock();
    const lost = createTransport({
      fpsMilli: FPS,
      durationFrames: () => 3600 * 30,
      audioClock: audioClock2,
    });
    lost.play();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const beforeLost = lost.currentFrame();
    lost.notifyAudioLost();
    const afterLost = lost.currentFrame();
    lost.dispose();

    // ⑥ scrub 合并
    const scrub = createTransport({
      fpsMilli: FPS,
      durationFrames: () => 240,
      onFrame: () => {},
    });
    const commitsBefore = scrub.stats().commitCount;
    const returned = [];
    for (let index = 0; index < 100; index += 1) {
      returned.push(scrub.seekTo(index, 'scrub'));
    }
    const returnedAllValid =
      returned.length === 100 &&
      returned.every((frame) => Number.isInteger(frame) && frame >= 0 && frame <= 240);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const statsAfterScrub = scrub.stats();
    const scrubCommits = statsAfterScrub.commitCount - commitsBefore;
    scrub.dispose();

    // 附加：播放到末帧自动暂停（R-007，不回绕）
    const endTransport = createTransport({
      fpsMilli: FPS,
      durationFrames: () => 10,
    });
    endTransport.play();
    await new Promise((resolve) => setTimeout(resolve, 700));
    const endFrame = endTransport.currentFrame();
    const endPlaying = endTransport.playing;
    endTransport.dispose();

    return {
      drift: { frameAfter10s, expectedFrame, drift, elapsedSec, playCommits },
      hidden: { pausedByHidden },
      exact: { exactFrame, mode: exactInfo ? exactInfo.mode : null, exact: exactInfo ? exactInfo.exact : null },
      preview: { previewReturn, info: previewInfo, commitCount: previewCommitCount },
      steps: { stepNeg1, stepNeg10, stepPos1, stepPos10 },
      switch: {
        beforeSwitch,
        afterSwitch,
        jump: Math.abs(afterSwitch - beforeSwitch),
        sourceBefore,
        sourceAfter,
        afterSwitchAdvance,
      },
      lost: { beforeLost, afterLost, jump: Math.abs(afterLost - beforeLost) },
      scrub: { returnedAllValid, scrubCommits, coalesced: statsAfterScrub.coalescedSeeks },
      end: { endFrame, endPlaying },
    };
  })()`);

  const { drift, hidden, exact, steps, switch: clockSwitch, lost, scrub, end } = result;

  report.check(
    `① 10 秒漂移 ${drift.drift} 帧 ≤ 1（帧 ${drift.frameAfter10s} vs 期望 ${drift.expectedFrame}，实测 ${drift.elapsedSec.toFixed(3)}s）`,
    drift.drift <= 1,
    `播放期提交 ${drift.playCommits} 次`,
  );
  report.check('② document.hidden 触发 pause', hidden.pausedByHidden === true);
  report.check(
    `③ seekTo(137,'exact') → currentFrame=${exact.exactFrame}，mode=${exact.mode}，exact=${exact.exact}`,
    exact.exactFrame === 137 && exact.mode === 'exact' && exact.exact === true,
  );
  report.check(
    `③b preview 模式：立即提交（frame=${result.preview.previewReturn}，mode=${result.preview.info ? result.preview.info.mode : null}，exact=${result.preview.info ? result.preview.info.exact : null}）`,
    result.preview.previewReturn === 50 &&
      result.preview.info !== null &&
      result.preview.info.mode === 'preview' &&
      result.preview.info.exact === false &&
      result.preview.commitCount === 1,
  );
  // 末尾点由 duration-1(239) 改为 duration(240)：时间线需要一个"末尾位置"，
  // 否则在片尾追加片段时新片段会与上一段重叠 1 帧（2026-10-21 多素材组合测试暴露）。
  report.check(
    `④ 逐帧 ±1/±10 首尾停住（${steps.stepNeg1}/${steps.stepNeg10}，${steps.stepPos1}/${steps.stepPos10}）`,
    steps.stepNeg1 === 0 && steps.stepNeg10 === 0 && steps.stepPos1 === 240 && steps.stepPos10 === 240,
  );
  report.check(
    `⑤ 时钟源切换不跳帧：${clockSwitch.sourceBefore}→${clockSwitch.sourceAfter}，跳变 ${clockSwitch.jump} 帧 ≤ 1`,
    clockSwitch.sourceBefore === 'audio' &&
      clockSwitch.sourceAfter === 'perf' &&
      clockSwitch.jump <= 1 &&
      clockSwitch.afterSwitchAdvance >= 0,
  );
  report.check(`⑤b notifyAudioLost 不跳帧：跳变 ${lost.jump} 帧 ≤ 1`, lost.jump <= 1);
  report.check(
    `⑥ scrub 100 次全部返回可显示帧=${scrub.returnedAllValid}，commitCount 增量 ${scrub.scrubCommits} ≤ 1（合并 ${scrub.coalesced} 次）`,
    scrub.returnedAllValid === true && scrub.scrubCommits <= 1,
  );
  report.check(
    `附加：播到末帧自动暂停（frame=${end.endFrame}，playing=${end.endPlaying}，不回绕）`,
    // durationFrames=10 → 末尾点是 10（不是 9）：播放头停在末尾、不回绕
    end.endFrame === 10 && end.endPlaying === false,
  );

  report.summary('T08 Transport 验收');
} finally {
  await page.close();
  await server.close();
}
