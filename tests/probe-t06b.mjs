/**
 * T06 定位探针 B：分情况矩阵 —— 同一目标帧在"全新池"与"前序 seek 之后"的行为差异。
 * 目的：判定 seek150 的失败是「该帧本身不可达」还是「前序 seek 留下的状态污染」。
 *
 * 运行：node tests/probe-t06b.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, 'tests', '.cache');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const PAGE = `<!doctype html><meta charset="utf-8"><script type="module">
import { probeAsset, createDecoderPool, frameToUs } from '/tests/.cache/t06-bundle.mjs';
window.__T06_TRACE = true;
window.addEventListener('unhandledrejection', (e) => { window.__err = 'unhandled: ' + String(e.reason); });
const log = [];
window.__log = log;
window.__phase = 'boot';
const files = {};
const probes = {};
for (const [name, dir] of [['sample-720p.mp4', ''], ['longgop.mp4', 'hardline/']]) {
  const blob = await (await fetch('/tests/fixtures/' + dir + name)).blob();
  files[name] = new File([blob], name);
  const probed = await probeAsset(files[name], { thumbnailDecoder: null });
  probes[name] = probed.value.probe;
}

/** 全新池 + 指定 seek 序列 */
async function trial(name, targets, fixture = 'sample-720p.mp4') {
  console.log('### FIXTURE ' + fixture + ' TRIAL ' + name);
  const pool = createDecoderPool();
  const probe = probes[fixture];
  pool.register('s', probe, files[fixture]);
  const rows = [];
  for (const target of targets) {
    console.log('=== TRIAL ' + name + ' TARGET ' + target + ' ===');
    const t0 = performance.now();
    const r = await pool.seek('s', target);
    const frame = r.ok ? r.value : null;
    rows.push({
      target,
      ms: Math.round(performance.now() - t0),
      ok: r.ok,
      // 用 timestamp 反推实际拿到的帧号：这是"静默给错帧"的唯一证据
      gotFrame: frame ? Math.round((frame.timestamp / 1e6) * 30) : null,
      wantFrame: target,
      exact: frame ? Math.round((frame.timestamp / 1e6) * 30) === target : false,
      stats: pool.stats(),
    });
    if (frame) frame.close();
  }
  await pool.dispose();
  log.push({ trial: name, rows });
  window.__phase = 'more';
}

await trial('C_after137_150', [137, 150]);
await trial('G_720p_near_start', [10, 20]);
await trial('H_720p_137_then138', [137, 138]);
await trial('I_longgop_50_then200', [50, 200], 'longgop.mp4');
await trial('J_longgop_137_then239', [137, 239], 'longgop.mp4');
await trial('K_720p_0_then60', [0, 60]);
window.__phase = 'done';
</script>`;

fs.mkdirSync(CACHE, { recursive: true });
await build({
  entryPoints: [path.join(CACHE, 't06-entry.ts')],
  outfile: path.join(CACHE, 't06-bundle.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  logLevel: 'warning',
});
fs.writeFileSync(path.join(CACHE, 'probe.html'), PAGE);

const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  fs.readFile(p, (e, d) => {
    if (e) { res.writeHead(404).end('nf'); return; }
    const ext = path.extname(p);
    const mime = ext === '.mp4' ? 'video/mp4' : ext === '.mjs' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': mime });
    res.end(d);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-b-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-first-run', '--mute-audio', '--remote-debugging-port=9337', `--user-data-dir=${udd}`, 'about:blank'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));
const t = await (await fetch(`http://127.0.0.1:9337/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/tests/.cache/probe.html`)}`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
await new Promise((r) => { ws.onopen = r; });
const consoleLines = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'log') {
    consoleLines.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
});
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pend.set(i, r)); };
await send('Runtime.enable');
let out = null;
for (let i = 0; i < 300; i += 1) {
  const ev = await send('Runtime.evaluate', { expression: 'JSON.stringify({phase: window.__phase ?? null, err: window.__err ?? null, log: window.__log ?? null})', returnByValue: true });
  if (ev.result && ev.result.value) {
    const snap = JSON.parse(ev.result.value);
    if (snap.phase === 'done') { out = snap; break; }
  }
  await new Promise((r) => setTimeout(r, 250));
}
chrome.kill(); server.close();
console.log('--- 各 trial 结论 ---');
if (out?.err) console.log('页面错误:', out.err);
for (const block of out?.log ?? []) {
  console.log(`\n【${block.trial}】`);
  for (const row of block.rows) {
    const flag = row.ok ? (row.exact ? '✓' : '✗给错帧') : '✗失败';
    console.log(`  ${flag} 目标${row.target} → 实际${row.gotFrame ?? '-'}  ${row.ms}ms  created=${row.stats.totalCreated} closed=${row.stats.totalClosed} open=${row.stats.openFrames}`);
  }
}