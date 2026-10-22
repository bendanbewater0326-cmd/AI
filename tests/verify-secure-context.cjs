const { chromium } = require('playwright-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FILE_URL = 'file:///D:/%E9%A1%B9%E7%9B%AE%E4%B8%93%E7%94%A8%E6%96%87%E4%BB%B6%E5%A4%B9/%E5%89%AA%E8%BE%91%E5%B7%A5%E5%85%B7/dist/index.html';

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage();
  const consoleMsgs = [];
  const pageErrors = [];
  page.on('console', (m) => consoleMsgs.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => pageErrors.push(e.message));

  const probes = {};

  const fileUrl = FILE_URL.replace(/^file:\/\/\//, 'file:///');
  try {
    await page.goto(fileUrl, { waitUntil: 'load', timeout: 15000 });
    await page.waitForTimeout(500);
    probes.fileProtocol = await page.evaluate(() => ({
      protocol: location.protocol,
      isSecureContext: window.isSecureContext,
      hasVideoDecoder: typeof VideoDecoder !== 'undefined',
      hasVideoEncoder: typeof VideoEncoder !== 'undefined',
      hasFilePicker: typeof showOpenFilePicker !== 'undefined',
      rootChildren: document.getElementById('root')?.children.length ?? -1,
      bodyText: (document.body.innerText || '').slice(0, 160).replace(/\s+/g, ' '),
    }));
  } catch (e) {
    probes.fileProtocol = { navigated: false, error: e.message };
  }

  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'load', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  probes.httpLocalhost = await page.evaluate(() => ({
    protocol: location.protocol,
    isSecureContext: window.isSecureContext,
    hasVideoDecoder: typeof VideoDecoder !== 'undefined',
    rootChildren: document.getElementById('root')?.children.length ?? -1,
  }));

  console.log(JSON.stringify({ probes, pageErrors, consoleMsgs: consoleMsgs.slice(0, 8) }, null, 2));
  await browser.close();
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
