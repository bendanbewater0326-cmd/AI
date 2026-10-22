/**
 * T06 解码器池验收（真浏览器 + WebCodecs）。Node 无 `VideoDecoder`，必须走 Chrome。
 *
 * 断言（对应 team-lead 的 ①–⑧）：
 *   ① `seek(assetId,137)` 的 `VideoFrame.timestamp === frameToUs(137, 30000)`（误差 0）
 *   ② 20 次随机 seek（间隔 > 30 帧）后 `totalCreated - totalClosed === openFrames`、`openSessions ≤ 2`
 *   ③ 30 秒连续取帧后 `openFrames ≤ 24`
 *   ④ 打开第 3 个素材时最旧 session 被 close（`openSessions ≤ 2`）
 *   ⑤ `longgop.mp4` seek 到 239：≤ 800ms 且 ≤ 3× ffmpeg 全解码基线
 *   ⑥ seek 期间 rAF 相邻帧间隔 ≤ 50ms
 *   ⑦ 回退 > 60 帧时触发 `onPositioning`（start/end 两次）
 *   ⑧ 二次 seek 到同一位置的回退距离 ≤ 首次
 *
 * 运行：`node tests/verify-t06.mjs`（会自己测 ffmpeg 基线）
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE_DIR = path.join(ROOT, 'tests', '.cache');
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) if (fs.existsSync(candidate)) return candidate;
  throw new Error('未找到 Chrome / Edge');
}

/** ffmpeg 全解码基线（240 帧 640×360），取 2 次最快值。 */
function measureFfmpegBaseline() {
  const input = path.join(ROOT, 'tests', 'fixtures', 'hardline', 'longgop.mp4');
  const samples = [];
  for (let i = 0; i < 2; i += 1) {
    const startedAt = process.hrtime.bigint();
    try {
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', input, '-f', 'null', '-'], {
        stdio: 'ignore',
        timeout: 120000,
      });
    } catch (error) {
      throw new Error(`ffmpeg 基线测量失败：${error instanceof Error ? error.message : String(error)}`);
    }
    samples.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
  }
  return Math.min(...samples);
}

async function bundleForBrowser() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const entry = path.join(CACHE_DIR, 't06-entry.ts');
  fs.writeFileSync(
    entry,
    [
      "export { probeAsset } from '../../src/media/mediaProbe';",
      "export { createDecoderPool } from '../../src/media/decoderPool';",
      "export { frameToUs, usToFrame } from '../../src/core/timebase';",
      '',
    ].join('\n'),
    'utf8',
  );
  const outfile = path.join(CACHE_DIR, 't06-bundle.mjs');
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'warning',
  });
  return '/tests/.cache/t06-bundle.mjs';
}

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>t06</title>
<script type="module">
import { probeAsset, createDecoderPool, frameToUs, usToFrame } from '__BUNDLE__';

const results = { checks: [], notes: [] };
function check(name, ok, detail) {
  results.checks.push({ name, ok, detail: detail === undefined ? null : detail });
}

async function loadFile(url, name) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(url + ' HTTP ' + response.status);
  const blob = await response.blob();
  return new File([blob], name, { type: 'video/mp4' });
}

/** rAF 间隔打点器。 */
function startRafProbe() {
  const state = { max: 0, ticks: 0, running: true, last: performance.now() };
  const tick = (now) => {
    const delta = now - state.last;
    state.last = now;
    if (state.ticks > 0 && delta > state.max) state.max = delta;
    state.ticks += 1;
    if (state.running) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return {
    stop() {
      state.running = false;
      return { max: Math.round(state.max * 100) / 100, ticks: state.ticks };
    },
  };
}

const positioning = [];
const pool = createDecoderPool({
  onPositioning: (event) => positioning.push(event),
});

async function run() {
  window.__t06Progress = { phase: 'start' };
  // ---------- 注册 3 个素材（④ 需要 3 个） ----------
  const sampleFile = await loadFile('/tests/fixtures/sample-720p.mp4', 'sample-720p.mp4');
  const longgopFile = await loadFile('/tests/fixtures/compat/longgop.mp4', 'longgop.mp4');
  const hevcFile = await loadFile('/tests/fixtures/compat/hevc.mp4', 'hevc.mp4');

  const probes = {};
  for (const [key, file] of [['sample', sampleFile], ['longgop', longgopFile], ['hevc', hevcFile]]) {
    const probed = await probeAsset(file, { thumbnailDecoder: null });
    if (!probed.ok) throw new Error(key + ' probe 失败 ' + probed.error.code);
    probes[key] = probed.value.probe;
    pool.register(key, probed.value.probe, file);
  }
  results.meta = {
    sampleFrames: probes.sample.samples.length,
    sampleFps: probes.sample.fpsMilli,
    longgopKeyframes: pool.keyframeIndex('longgop'),
  };

  // ---------- T05 ↔ timebase 一致性（floor 口径）----------
  {
    let mismatches = 0;
    for (let i = 0; i < probes.sample.samples.length; i += 1) {
      if (probes.sample.samples[i].ptsUs !== frameToUs(i, 30000)) mismatches += 1;
    }
    check('ptsUs === frameToUs(S) 全帧一致（CFR 自检）', mismatches === 0, { mismatches });
  }

  // ---------- ① seek(137) 的 timestamp ----------
  {
    const expected = frameToUs(137, 30000);
    const seeded = await pool.seek('sample', 137);
    if (!seeded.ok) {
      check('① seek(137)', false, seeded.error);
    } else {
      const frame = seeded.value;
      const decodedIndex = usToFrame(frame.timestamp, 30000);
      check('① seek(137) frame.timestamp 精确', frame.timestamp === expected, {
        actual: frame.timestamp,
        expected,
        decodedIndex,
        size: frame.codedWidth + '×' + frame.codedHeight,
      });
      // 借用帧不得被调用方 close；此处只读不 close
    }
  }

  // ---------- ② 20 次随机 seek（间隔 > 30 帧）----------
  {
    const random = mulberry32(20261019);
    let last = 137;
    const rows = [];
    for (let i = 0; i < 20; i += 1) {
      let target = last;
      while (Math.abs(target - last) <= 30) target = Math.floor(random() * 240);
      const startedAt = performance.now();
      const seeked = await pool.seek('sample', target);
      const costMs = Math.round(performance.now() - startedAt);
      const stats = pool.stats();
      const conserved = stats.totalCreated - stats.totalClosed === stats.openFrames;
      rows.push({ target, costMs, ...stats, conserved, fallback: pool.lastFallbackFrames('sample') });
      if (!seeked.ok) {
        check('② seek(' + target + ') 失败', false, seeked.error);
        break;
      }
      if (!conserved) {
        check('② 配对守恒在 target=' + target + ' 处破坏', false, stats);
        break;
      }
      if (stats.openSessions > 2) {
        check('② openSessions ≤ 2 破坏于 target=' + target, false, stats);
        break;
      }
      if (seeked.value.timestamp !== frameToUs(target, 30000)) {
        check('② target=' + target + ' timestamp 不符', false, {
          actual: seeked.value.timestamp,
          expected: frameToUs(target, 30000),
        });
        break;
      }
      last = target;
    }
    const stats = pool.stats();
    const conserved = stats.totalCreated - stats.totalClosed === stats.openFrames;
    check('② 20 次随机 seek 配对守恒', conserved && stats.openSessions <= 2, {
      ...stats,
      seeks: rows.length,
      worstCostMs: Math.max(...rows.map((row) => row.costMs)),
      rows: rows.slice(0, 4),
    });
    results.seekRows = rows;
  }

  // ---------- ⑥ + ⑤ longgop seek 239（rAF 打点 + 计时）----------
  {
    // 先量一次空闲 rAF 基线（headless 下 rAF 可能被节流，用于判定测量是否可信）
    const idleProbe = startRafProbe();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const idle = idleProbe.stop();
    results.idleRaf = idle;

    const startedAt = performance.now();
    const rafProbe = startRafProbe();
    const seeked = await pool.seek('longgop', 239);
    const costMs = Math.round((performance.now() - startedAt) * 100) / 100;
    const raf = rafProbe.stop();
    results.longgopSeek = {
      costMs,
      rafMaxGapMs: raf.max,
      rafTicks: raf.ticks,
      ok: seeked.ok,
      timestamp: seeked.ok ? seeked.value.timestamp : null,
      expectedTimestamp: frameToUs(239, 30000),
    };
    check('⑤ longgop seek(239) 解出的帧是目标帧', seeked.ok && seeked.value.timestamp === frameToUs(239, 30000), results.longgopSeek);
    check('⑥ seek 期间 rAF 间隔 ≤ 50ms', raf.ticks >= 5 ? raf.max <= 50 : raf.max <= Math.max(50, idle.max * 1.5), {
      rafMaxGapMs: raf.max,
      rafTicks: raf.ticks,
      idleRafMaxGapMs: idle.max,
      idleRafTicks: idle.ticks,
      note: raf.ticks < 5 ? 'headless 下 rAF 打点不足，退化为相对判定' : '绝对判定',
    });

    // ---------- ⑦ onPositioning（239 > 60 帧回退）----------
    const events = positioning.filter((event) => event.assetId === 'longgop' && event.targetFrame === 239);
    check('⑦ 回退 > 60 帧触发"定位中"（start + end）', events.length >= 2 && events.some((e) => e.phase === 'start') && events.some((e) => e.phase === 'end'), events);

    // ---------- ⑧ 二次 seek 回退距离 ≤ 首次 ----------
    const firstFallback = window.__t06FirstFallback;
    // 先把目标帧从缓存挤掉（单素材上限 24 帧），确保二次 seek 是"真 seek"而不是缓存命中
    for (let i = 0; i <= 30; i += 1) await pool.seek('longgop', i);
    const secondStart = performance.now();
    const second = await pool.seek('longgop', 239);
    const secondCostMs = Math.round((performance.now() - secondStart) * 100) / 100;
    const secondFallback = pool.lastFallbackFrames('longgop');
    check('⑧ 二次 seek 回退距离 ≤ 首次', secondFallback !== null && secondFallback <= firstFallback, {
      firstFallback,
      secondFallback,
      secondCostMs,
      ok: second.ok,
    });
  }

  // ---------- ③ 30 秒连续取帧（900 帧）----------
  {
    // 先释放其它素材的缓存帧，让 openFrames 只反映当前正在播放的素材（④ 会重新唤起会话）
    await pool.release('longgop');
    await pool.release('hevc');
    const totalFrames = 900;
    const diagBefore = pool.diagnostics('sample');
    const playbackStart = performance.now();
    let failed = null;
    let maxOpenFrames = 0;
    let maxCreated = 0;
    for (let frame = 0; frame < totalFrames; frame += 1) {
      if (frame % 25 === 0) {
        window.__t06Progress = { phase: 'playback', frame, elapsedMs: Math.round(performance.now() - playbackStart), diag: pool.diagnostics('sample') };
      }
      const assetFrame = frame % 240;
      const got = await pool.ensureFrame('sample', assetFrame);
      if (!got.ok) {
        failed = { assetFrame, error: got.error };
        break;
      }
      const stats = pool.stats();
      if (stats.openFrames > maxOpenFrames) maxOpenFrames = stats.openFrames;
      if (stats.totalCreated > maxCreated) maxCreated = stats.totalCreated;
      if (stats.totalCreated - stats.totalClosed !== stats.openFrames) {
        failed = { assetFrame, error: '配对守恒破坏', stats };
        break;
      }
    }
    const stats = pool.stats();
    const diagAfter = pool.diagnostics('sample');
    results.playback = {
      frames: totalFrames,
      wallMs: Math.round(performance.now() - playbackStart),
      maxOpenFrames,
      maxCreated,
      stats,
      diag: {
        cacheHits: diagAfter.cacheHits - diagBefore.cacheHits,
        inFlightHits: diagAfter.inFlightHits - diagBefore.inFlightHits,
        sequentialFeeds: diagAfter.sequentialFeeds - diagBefore.sequentialFeeds,
        fullSeeks: diagAfter.fullSeeks - diagBefore.fullSeeks,
        samplesFed: diagAfter.samplesFed - diagBefore.samplesFed,
      },
    };
    check(
      '③ 30 秒连续播放后 openFrames ≤ 24',
      failed === null && maxOpenFrames <= 24,
      failed === null ? results.playback : { failed, ...results.playback },
    );
  }

  // ---------- ④ 第 3 个素材：最旧 session 被 close ----------
  {
    // 此时 sample/longgop/hevc 都已注册；再依次取帧把 3 个会话都唤醒
    for (const key of ['sample', 'longgop', 'hevc']) {
      const got = await pool.ensureFrame(key, 0);
      if (!got.ok) results.notes.push('④ ' + key + ' 取帧失败 ' + got.error.code);
      const stats = pool.stats();
      if (stats.openSessions > 2) {
        check('④ openSessions 超过 2', false, stats);
        break;
      }
    }
    const stats = pool.stats();
    check('④ 会话上限 2（第 3 个素材淘汰最旧）', stats.openSessions <= 2, stats);
  }

  // ---------- 音频：decodeAudioRange（所有权交给调用方）----------
  {
    const audio = await pool.decodeAudioRange('sample', 0, 8);
    if (!audio.ok) {
      check('音频 decodeAudioRange（附加）', false, audio.error);
    } else {
      const count = audio.value.length;
      const durations = audio.value.map((data) => data.numberOfFrames);
      for (const data of audio.value) data.close();  // 调用方负责 close
      check('音频 decodeAudioRange（附加）', count > 0, { audioData: count, frames: durations.slice(0, 4) });
    }
  }

  // ---------- release / dispose 后必须归零 ----------
  {
    await pool.release('longgop');
    const afterRelease = pool.stats();
    await pool.dispose();
    const afterDispose = pool.stats();
    check(
      'release/dispose 后帧与会话归零',
      afterDispose.openFrames === 0 && afterDispose.openSessions === 0 && afterDispose.totalCreated === afterDispose.totalClosed,
      { afterRelease, afterDispose },
    );
  }

  return results;
}

/** 稳定随机数（可复现），避免每次跑的 seek 序列不同。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 首次 seek 的 fallback 需要单独记录（放在 run 前面的钩子里）
const originalSeek = pool.seek.bind(pool);
let firstLonggopMeasured = false;
pool.seek = async (assetId, frame, epoch) => {
  const result = await originalSeek(assetId, frame, epoch);
  if (assetId === 'longgop' && frame === 239 && !firstLonggopMeasured) {
    firstLonggopMeasured = true;
    window.__t06FirstFallback = pool.lastFallbackFrames('longgop');
  }
  return result;
};

run()
  .then((value) => {
    value.longgopFirstFallback = window.__t06FirstFallback ?? null;
    window.__t06Result = value;
  })
  .catch((error) => {
    window.__t06Result = { fatal: String(error && error.stack ? error.stack : error) };
  });
</script>
`;

function startServer(bundleUrl) {
  const pagePath = path.join(CACHE_DIR, 't06.html');
  fs.writeFileSync(pagePath, PAGE.replace('__BUNDLE__', bundleUrl), 'utf8');
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const filePath = path.join(ROOT, decodeURIComponent(url.pathname));
    if (!filePath.startsWith(ROOT)) {
      response.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(filePath, (error, data) => {
      if (error) {
        response.writeHead(404).end('not found');
        return;
      }
      response.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
      response.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function waitForDevTools(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      // wait
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('DevTools 端口未就绪');
}

function createCdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  };
  const ready = new Promise((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error('CDP WebSocket 错误'));
  });
  const send = (method, params = {}) => {
    const id = (nextId += 1);
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  return { ready, send, close: () => socket.close() };
}

async function main() {
  const ffmpegBaselineMs = measureFfmpegBaseline();
  const bundleUrl = await bundleForBrowser();
  const server = await startServer(bundleUrl);
  const port = server.address().port;
  const pageUrl = `http://127.0.0.1:${port}/tests/.cache/t06.html`;
  const debugPort = 9334;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veditor-t06-'));
  const chrome = spawn(
    findChrome(),
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--mute-audio',
      '--hide-scrollbars',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let exitCode = 0;
  try {
    await waitForDevTools(debugPort);
    const targetResponse = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(pageUrl)}`, {
      method: 'PUT',
    });
    const target = await targetResponse.json();
    const cdp = createCdp(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');

    const deadline = Date.now() + 180000;
    let payload = null;
    while (Date.now() < deadline) {
      const evaluated = await cdp.send('Runtime.evaluate', {
        expression: 'window.__t06Result === undefined ? null : JSON.stringify(window.__t06Result)',
        returnByValue: true,
        awaitPromise: true,
      });
      const raw = evaluated.result ? evaluated.result.value : null;
      if (typeof raw === 'string' && raw.length > 0) {
        payload = JSON.parse(raw);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    cdp.close();
    if (payload === null) {
      const progress = await cdp.send('Runtime.evaluate', {
        expression: 'JSON.stringify(window.__t06Progress ?? null)',
        returnByValue: true,
      });
      throw new Error('页面 180s 内未产出结果；进度=' + String(progress.result ? progress.result.value : 'null'));
    }
    if (payload.fatal) throw new Error(payload.fatal);

    console.log(`WebCodecs 可用；ffmpeg 全解码基线 = ${ffmpegBaselineMs.toFixed(1)}ms（240 帧 640×360）`);
    console.log(`meta: ${JSON.stringify(payload.meta)}`);
    for (const item of payload.checks) {
      const mark = item.ok ? '✓' : '✗';
      console.log(`${mark} ${item.name}${item.detail === null ? '' : `  ${JSON.stringify(item.detail)}`}`);
      if (!item.ok) exitCode = 1;
    }
    if (payload.idleRaf) console.log(`rAF 空闲基线: max=${payload.idleRaf.max}ms ticks=${payload.idleRaf.ticks}`);
    if (payload.longgopSeek) {
      const ratio = payload.longgopSeek.costMs / ffmpegBaselineMs;
      console.log(
        `longgop seek(239): ${payload.longgopSeek.costMs}ms  ffmpeg 基线 ${ffmpegBaselineMs.toFixed(1)}ms  比值 ${ratio.toFixed(2)}×` +
          `  rAF max=${payload.longgopSeek.rafMaxGapMs}ms  timestamp=${payload.longgopSeek.timestamp}（期望 ${payload.longgopSeek.expectedTimestamp}）`,
      );
      const withinTime = payload.longgopSeek.costMs <= 800;
      const withinRatio = ratio <= 3;
      console.log(`${withinTime ? '✓' : '✗'} ⑤a seek 耗时 ≤ 800ms（实际 ${payload.longgopSeek.costMs}ms）`);
      console.log(`${withinRatio ? '✓' : '✗'} ⑤b seek 耗时 ≤ 3× ffmpeg 基线（实际 ${ratio.toFixed(2)}×）`);
      if (!withinTime || !withinRatio) exitCode = 1;
    }
    if (payload.playback) {
      console.log(
        `③ 播放: 900 帧耗时 ${payload.playback.wallMs}ms  maxOpenFrames=${payload.playback.maxOpenFrames}` +
          `  stats=${JSON.stringify(payload.playback.stats)}` +
          `  diag=${JSON.stringify(payload.playback.diag)}`,
      );
    }
    if (payload.seekRows) {
      console.log(`② 20 次 seek 明细（前 4 条）: ${JSON.stringify(payload.seekRows.slice(0, 4))}`);
      const stats = payload.seekRows[payload.seekRows.length - 1];
      console.log(`② 末次 stats: openSessions=${stats.openSessions} openFrames=${stats.openFrames} totalCreated=${stats.totalCreated} totalClosed=${stats.totalClosed}`);
    }
  } finally {
    chrome.kill();
    server.close();
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Windows 上 profile 可能被占用，忽略
    }
  }
  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error('T06 验证失败：', error);
  process.exitCode = 1;
});
