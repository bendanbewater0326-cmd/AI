const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = 'D:/项目专用文件夹/剪辑工具/tests/screenshots';
const URL = 'http://127.0.0.1:5173/';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });

  await page.goto(URL, { waitUntil: 'load', timeout: 20000 });
  await page.waitForTimeout(800);

  const layout = await page.evaluate(() => {
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
    };
    const all = [...document.querySelectorAll('*')];
    const pick = (sel) => rect(document.querySelector(sel));

    const byText = (txt) =>
      rect(
        all.find((e) => e.children.length === 0 && (e.textContent || '').trim() === txt)
      );

    return {
      bodyClasses: document.body.className,
      rootChildren: document.getElementById('root')?.children.length,
      html: document.body.innerHTML.length,
      candidates: all.slice(0, 3).map((e) => e.tagName + '.' + e.className),
      textHits: {
        projectName: byText('未命名项目'),
        exportBtn: byText('导出'),
        importBtn: byText('+ 导入媒体'),
      },
    };
  });

  const structure = await page.evaluate(() => {
    const walk = (el, depth) => {
      if (depth > 3) return '';
      const r = el.getBoundingClientRect();
      const cls = (el.className || '').toString().slice(0, 40);
      const line = `${'  '.repeat(depth)}<${el.tagName.toLowerCase()}${cls ? ' class="' + cls + '"' : ''}> ${Math.round(r.width)}x${Math.round(r.height)}\n`;
      return line + [...el.children].map((c) => walk(c, depth + 1)).join('');
    };
    const root = document.getElementById('root');
    return root ? walk(root, 0).slice(0, 3000) : 'NO ROOT';
  });

  await page.screenshot({ path: path.join(OUT, 'm1-skeleton.png') });

  console.log(JSON.stringify({ layout, errors, screenshot: path.join(OUT, 'm1-skeleton.png') }, null, 2));
  console.log('=== DOM 结构（前 3000 字符）===');
  console.log(structure);

  await browser.close();
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
