/**
 * 裸 WebCodecs 对照实验：在浏览器里跑 tests/.cache/raw-decoder.html 并回收结果。
 * 用法：node tests/probe-raw-decoder.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

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
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-dec-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-first-run', '--mute-audio', '--remote-debugging-port=9338', `--user-data-dir=${udd}`, 'about:blank'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));
const t = await (await fetch(`http://127.0.0.1:9338/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/tests/.cache/raw-decoder.html`)}`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
await new Promise((r) => { ws.onopen = r; });
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pend.set(i, r)); };
await send('Runtime.enable');
const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? 'unknown');
  }
  if (m.method === 'Runtime.consoleAPICalled' && (m.params?.type === 'error' || m.params?.type === 'warning')) {
    errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
});
let out = null;
let partial = null;
for (let i = 0; i < 200; i += 1) {
  const ev = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({phase: window.__phase ?? null, out: window.__out ?? null, href: location.href, ready: document.readyState, err: window.__bootError ?? null})',
    returnByValue: true,
  });
  if (ev.result?.value) {
    const snap = JSON.parse(ev.result.value);
    partial = snap;
    if (snap.phase === 'done') { out = snap.out; break; }
  }
  await new Promise((r) => setTimeout(r, 250));
}
chrome.kill(); server.close();
if (errors.length) console.log('页面错误：', errors.slice(0, 3));
if (!out) { console.log('页面未完成，最后状态：', JSON.stringify(partial)); process.exit(1); }
console.log('素材：sample-720p.mp4 / 240 帧 / 关键帧仅 [0] / 含 B 帧');
for (const row of out) console.log(JSON.stringify(row));