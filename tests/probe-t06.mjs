/** 临时探针：小步重现 seek 失败（迭代用，定位完删掉）。 */
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
window.addEventListener('error', (e) => { window.__err = String(e.message) + ' @' + String(e.filename) + ':' + String(e.lineno); });
window.addEventListener('unhandledrejection', (e) => { window.__err = 'unhandled: ' + String(e.reason); });
const log = [];
window.__log = log;
const pool = createDecoderPool();
const blob = await (await fetch('/tests/fixtures/sample-720p.mp4')).blob();
const file = new File([blob], 's.mp4');
const probed = await probeAsset(file, { thumbnailDecoder: null });
pool.register('s', probed.value.probe, file);
async function step(label, fn) {
  window.__phase = label;
  const t0 = performance.now();
  const r = await fn();
  log.push({ label, ms: Math.round(performance.now() - t0), ok: r.ok, ts: r.ok ? r.value.timestamp : null,
    err: r.ok ? null : r.error, diag: pool.diagnostics('s'), stats: pool.stats(), lastErr: pool.lastDecoderError('s') });
}
await step('seek137', () => pool.seek('s', 137));
await step('seek137b', () => pool.seek('s', 137));
for (const f of [138, 139, 140, 141, 150, 160, 192]) await step('seek' + f, () => pool.seek('s', f));
window.__phase = 'done';
</script>`;

fs.mkdirSync(CACHE, { recursive: true });
await build({ entryPoints: [path.join(CACHE, 't06-entry.ts')], outfile: path.join(CACHE, 't06-bundle.mjs'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'warning' });
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
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-first-run', '--mute-audio', '--remote-debugging-port=9336', `--user-data-dir=${udd}`, 'about:blank'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));
const t = await (await fetch(`http://127.0.0.1:9336/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/tests/.cache/probe.html`)}`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
await new Promise((r) => { ws.onopen = r; });
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pend.set(i, r)); };
let out = null;
for (let i = 0; i < 240; i += 1) {
  const ev = await send('Runtime.evaluate', { expression: 'JSON.stringify({phase: window.__phase ?? null, err: window.__err ?? null, log: window.__log ?? null})', returnByValue: true });
  if (ev.result && ev.result.value) {
    const snap = JSON.parse(ev.result.value);
    if (snap.phase === 'done') { out = snap; break; }
    if (i % 20 === 19) console.log('progress', JSON.stringify(snap).slice(0, 400));
  }
  await new Promise((r) => setTimeout(r, 250));
}
chrome.kill(); server.close();
if (!out) { console.log('无结果（页面卡住）'); process.exit(1); }
for (const row of out.log) console.log(JSON.stringify(row));
console.log('expected192', out.expected192);
