const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = 'C:/Users/Administrator/AppData/Local/Temp/ebtest/vtest';
const SHOT = 'D:/项目专用文件夹/剪辑工具/tests/screenshots/build-smoke.png';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

function startServer() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
      const full = path.join(ROOT, rel);
      if (!full.startsWith(path.normalize(ROOT))) {
        res.writeHead(403);
        return res.end('forbidden');
      }
      fs.readFile(full, (err, buf) => {
        if (err) {
          res.writeHead(404);
          return res.end('not found: ' + rel);
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
        res.end(buf);
      });
    });
    s.listen(0, '127.0.0.1', () => resolve({ s, port: s.address().port }));
  });
}

(async () => {
  fs.mkdirSync(path.dirname(SHOT), { recursive: true });
  const { s, port } = await startServer();
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });

  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForTimeout(300);

  const mounted = await page.evaluate(() => {
    const root = document.getElementById('root');
    const probe = document.getElementById('probe');
    return {
      rootChildren: root ? root.children.length : -1,
      hasBar: !!document.querySelector('.bar'),
      hasTimeline: !!document.querySelector('.timeline'),
      clipCount: document.querySelectorAll('.clip').length,
      probeFrame: probe ? probe.getAttribute('data-frame') : null,
      probeClips: probe ? probe.getAttribute('data-clips') : null,
      titleText: document.querySelector('.name')?.textContent || null,
    };
  });

  const before = await page.evaluate(() => document.getElementById('probe').getAttribute('data-frame'));
  await page.evaluate(() => {
    const el = document.querySelector('.scrub');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, '180');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => document.getElementById('probe').getAttribute('data-frame'));
  const playheadLeft = await page.evaluate(() => document.querySelector('.playhead').style.left);
  const tcText = await page.evaluate(() => document.querySelector('.tc').textContent);

  await page.screenshot({ path: SHOT, fullPage: false });

  const result = {
    mounted,
    interaction: { before, after, changed: before !== after, playheadLeft, tcText },
    consoleErrors: errors,
    screenshot: SHOT,
    verdict:
      mounted.rootChildren > 0 &&
      mounted.hasBar &&
      mounted.hasTimeline &&
      mounted.clipCount === 2 &&
      before !== after &&
      tcText === '00:00:06:00' &&
      playheadLeft === '360px' &&
      errors.length === 0
        ? 'PASS'
        : 'FAIL',
  };
  console.log(JSON.stringify(result, null, 2));

  await browser.close();
  s.close();
})().catch((e) => {
  console.error('SMOKE FAILED:', e.message);
  process.exit(1);
});
