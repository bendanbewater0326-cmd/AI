/**
 * 键盘路径走查 v2（熟练用户视角）+ 误操作恢复（新手视角）。
 * 一次性诊断脚本（走查后删除，结论进 walk2-notes）。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { launchPage } from './cdp.mjs';
const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5868;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = path.join(ROOT, 'tests', 'screenshots');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'sample-720p.mp4');
const server = http.createServer((req, res) => {
  if (req.url === '/s.mp4') { res.writeHead(200, { 'Content-Type': 'video/mp4' }); fs.createReadStream(FIXTURE).pipe(res); return; }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const dev = spawn(process.execPath, ['scripts/dev.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('dev 超时')), 20000);
  dev.stdout.on('data', (c) => { if (String(c).includes(`127.0.0.1:${PORT}`)) { clearTimeout(timer); resolve(); } });
});
const page = await launchPage({ url: `http://127.0.0.1:${PORT}/`, width: 1440, height: 900 });
const ev = async (e) => page.session.evaluate(e);
const evalJson = async (e) => JSON.parse(await ev(`JSON.stringify(${e})`));
const notes = [];
const note = (t) => { notes.push(t); console.log(`  · ${t}`); };
const shot = async (n) => { await page.screenshot({ path: path.join(SHOTS, `walk2-${n}.png`) }); };
const key = async (k, opts = {}) => {
  const code = k === 'Delete' ? 'Delete' : k === ' ' ? 'Space' : k === 'Escape' ? 'Escape' : `Key${k.toUpperCase()}`;
  const vk = k === 'Delete' ? 46 : k === ' ' ? 32 : k === 'Escape' ? 27 : k.toUpperCase().charCodeAt(0);
  await page.session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: opts.modifiers ?? 0 });
  await page.session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: opts.modifiers ?? 0 });
  await sleep(opts.wait ?? 350);
};
const clips = () => evalJson('window.__VEDITOR_TEST__.clips()');
const errors = () => evalJson('window.__VEDITOR_TEST__.errors()');

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
  await sleep(500);
  await ev(`document.documentElement.style.setProperty('--v-timeline-h', '420px'); document.documentElement.style.setProperty('--v-timeline-pct', '60'); true`);

  const bytes = fs.readFileSync(FIXTURE);
  const b64 = bytes.toString('base64');
  await ev(`(async () => { const raw = atob('${b64}'); const bytes = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i); const file = new File([bytes], 's.mp4', { type: 'video/mp4' }); const dt = new DataTransfer(); dt.items.add(file); for (const t of ['dragenter','dragover','drop']) document.body.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt })); return true; })()`);
  await page.session.waitFor(`document.querySelectorAll('[data-v="asset-card"]').length === 1`, 10000);
  await sleep(600);
  await ev(`document.querySelector('[data-v="asset-card"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true`);
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 1`, 8000);
  await sleep(400);

  console.log('\n== 熟练用户路径（键盘） ==');
  await ev(`window.__VEDITOR_TEST__.seek(90)`);
  await sleep(200);
  await key('b', { modifiers: 2 }); // 分割是 Ctrl+B（keymap 单一来源；title 已修正过显示）
  note(`Ctrl+B 分割 → ${(await clips()).length} 段`);

  const firstId = (await clips())[0].id;
  await ev(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(firstId)})`);
  await sleep(200);
  await key('Delete');
  note(`Delete 删前段 → ${(await clips()).length} 段`);

  const secondId = (await clips())[0].id;
  await ev(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(secondId)})`);
  await sleep(150);
  await key('Delete', { modifiers: 8, wait: 450 });
  note(`Shift+Delete 波纹删除 → ${(await clips()).length} 段`);

  await key('z', { modifiers: 2, wait: 300 });
  await key('z', { modifiers: 2, wait: 300 });
  note(`Ctrl+Z ×2 恢复 → ${(await clips()).length} 段`);

  const before = await ev('window.__VEDITOR_TEST__.playheadFrame()');
  await key('ArrowRight', { wait: 100 });
  await key('ArrowRight', { modifiers: 8, wait: 150 });
  const after = await ev('window.__VEDITOR_TEST__.playheadFrame()');
  note(`方向键逐帧 + Shift×10：${before} → ${after}（差 ${after - before}，期望 11）`);

  await key('n', { wait: 250 });
  await key('n', { wait: 250 });
  note('N 吸附开关往返（无报错）');
  await shot('01-keyboard');

  console.log('\n== 新手误操作恢复 ==');
  const count = (await clips()).length;
  await ev(`window.__VEDITOR_TEST__.selectClip(window.__VEDITOR_TEST__.clips()[0].id)`);
  await sleep(150);
  await key('Delete', { wait: 400 });
  await key('z', { modifiers: 2, wait: 400 });
  const recovered = (await clips()).length;
  note(`误删 → Ctrl+Z：${count} → 恢复 ${recovered} ${recovered === count ? '✓ 找回' : '✗ 丢失'}`);

  await key('k', { modifiers: 2, wait: 450 });
  const cmdVisible = await evalJson(`(() => {
    const bars = Array.from(document.querySelectorAll('[data-v]'));
    const cmdbar = bars.find((el) => (el.getAttribute('data-v') ?? '').includes('cmd') || el.textContent.includes('命令'));
    return cmdbar !== undefined;
  })()`);
  await key('Escape', { wait: 300 });
  const cmdGone = await evalJson(`(() => {
    const bars = Array.from(document.querySelectorAll('[data-v]'));
    const cmdbar = bars.find((el) => (el.getAttribute('data-v') ?? '').includes('cmd'));
    return cmdbar === undefined;
  })()`);
  note(`Ctrl+K 命令栏（可见=${cmdVisible}）→ Esc 关闭（已关=${cmdGone}）`);
  await shot('02-recovery');

  console.log('\n== 新功能入口视觉 ==');
  await ev(`document.querySelector('[data-v="left-tab-text"]')?.click()`);
  await sleep(400);
  const panelState = await evalJson(`(() => ({
    templates: document.querySelectorAll('[data-v="template-row"] .v-textpanel__tplchip').length,
    aiBtn: document.querySelector('[data-v="text-ai-open"]') !== null,
  }))()`);
  note(`文本面板：创作模板 ${panelState.templates} chips + AI 文案 ${panelState.aiBtn}`);
  await shot('03-textpanel');
  await ev(`document.querySelector('[data-v="export-open"]')?.click()`);
  await page.session.waitFor(`document.querySelector('[data-v="export-dialog"]') !== null`, 5000);
  await sleep(300);
  const exportState = await evalJson(`(() => ({
    presets: document.querySelectorAll('[data-v="export-presets"] .v-export__preset').length,
    fileName: document.querySelector('[data-v="export-filename"]')?.value ?? '',
  }))()`);
  note(`导出面板：${exportState.presets} 预设 + 文件名「${exportState.fileName}」`);
  await shot('04-export');
  await ev(`document.querySelector('[data-v="export-cancel"]')?.click(); true`);

  const finalErrors = await errors();
  note(`全程错误条：${finalErrors.length} 条（${finalErrors.slice(0, 2).map((e) => e.message).join('；') || '无'}）`);

  fs.writeFileSync(path.join(SHOTS, 'walk2-notes.json'), JSON.stringify(notes, null, 2));
  console.log('\n✓ 键盘走查 v2 完成');
} finally {
  await page.close().catch(() => {});
  dev.kill();
  await new Promise((r) => server.close(r));
}
