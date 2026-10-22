/**
 * 透明通道导出端到端验证（R-062）。
 *
 * ## 这条链路有三个"看起来对、其实错"的地方
 *
 * 1. **合成器默认不透明**：`gl.clearColor(..., 1)`。不改的话 PNG 每帧都是不透明黑，
 *    用户拿到一堆"透明通道"文件却全是实底——而且不会报错。
 * 2. **文件名编号**：PRD 要求 `frame_000001.png` 起连续编号，补零到 6 位才能让字典序 == 帧序。
 * 3. **必须带 frames.json**：否则下游不知道该按几帧/秒回放（序列本身没有帧率信息）。
 *
 * 所以这里不看"导出了个文件"，而是把 ZIP 拆开逐项验：文件数、命名、清单字段、
 * **PNG 是不是真 RGBA**、**是否真的有 alpha=0 的像素**。
 *
 * 场景：删掉视频片段、只留一段文字 → 文字之外必须全透明。
 *
 * 运行：node tests/verify-png-export.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import zlib from 'node:zlib';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5210;
const TMP = path.join(ROOT, 'tests', '.tmp', 'png-export');

/* ---------------- 基建 ---------------- */

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
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
    });
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

/**
 * 用 Python 的 `zipfile`（stdlib）做**独立**的包校验：列表、CRC、清单内容。
 *
 * 不用 PIL —— 这台机器上的 Python 没装 Pillow，而"为了验个 alpha 去装依赖"不划算。
 * PNG 解码交给下面的 Node 实现（zlib + 逐行反滤波），同样是独立实现。
 */
const PY_CHECK = String.raw`
import json, sys, zipfile, os
zip_path = sys.argv[1]
out_dir = sys.argv[2]
with zipfile.ZipFile(zip_path) as archive:
    out = {
        "bad": archive.testzip(),
        "names": archive.namelist(),
        "hasManifest": "frames.json" in archive.namelist(),
    }
    if out["hasManifest"]:
        out["manifest"] = json.loads(archive.read("frames.json").decode("utf-8"))
    out["pngCount"] = len([n for n in out["names"] if n.endswith(".png")])
    archive.extractall(out_dir)
print(json.dumps(out))
`;

/* ---------------- 独立 PNG 解码（只为验 alpha，不依赖图像库） ---------------- */

/**
 * 解出 8bit RGBA PNG 的 alpha 统计。
 *
 * 只支持 `colorType = 6`（RGBA）/ `bitDepth = 8` —— 这正是浏览器 `toBlob('image/png')`
 * 对带透明画布的产物。遇到别的类型直接抛错，而不是"猜一个结果"。
 *
 * 反滤波（filter 0–4）按 PNG 规范逐行做；Paeth 用标准判定。
 */
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (header === null) throw new Error('缺 IHDR');
  if (header.colorType !== 6 || header.bitDepth !== 8) {
    throw new Error(`只支持 8bit RGBA，收到 colorType=${header.colorType} bitDepth=${header.bitDepth}`);
  }
  if (header.interlace !== 0) throw new Error('不支持隔行扫描');

  const bpp = 4;
  const stride = header.width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(header.height * stride);

  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const current = pixels.subarray(y * stride, (y + 1) * stride);
    const previous = y === 0 ? null : pixels.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? current[x - bpp] : 0;
      const up = previous === null ? 0 : previous[x];
      const upLeft = previous === null || x < bpp ? 0 : previous[x - bpp];
      let value = line[x];
      if (filter === 1) value = (value + left) & 0xff;
      else if (filter === 2) value = (value + up) & 0xff;
      else if (filter === 3) value = (value + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        value = (value + predictor) & 0xff;
      } else if (filter !== 0) {
        throw new Error(`未知 filter ${filter}`);
      }
      current[x] = value;
    }
  }

  let transparent = 0;
  let opaque = 0;
  let partial = 0;
  for (let i = 3; i < pixels.length; i += bpp) {
    const alpha = pixels[i];
    if (alpha === 0) transparent += 1;
    else if (alpha === 255) opaque += 1;
    else partial += 1;
  }
  return { ...header, transparent, opaque, partial };
}

function findPython() {
  const candidates = [
    'C:/Users/Administrator/.workbuddy-ai/binaries/python/versions/3.13.12/python.exe',
    'python',
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import zipfile; print("ok")'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

/* ---------------- 主流程 ---------------- */

const report = createReport();
const fixture = await startFixtureServer();
const dev = await startDevServer();
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const page = await launchPage({
  url: `http://127.0.0.1:${PORT}/?src=${fixture.origin}/sample-720p.mp4`,
  width: 1440,
  height: 900,
});

async function key(key, code, keyCode) {
  await page.session.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  });
  await page.session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  });
}

async function seekTo(frame) {
  const fps = 30;
  const total = Math.floor(frame / fps);
  const ff = String(frame % fps).padStart(2, '0');
  const timecode = `00:00:${String(total).padStart(2, '0')}:${ff}`;
  await page.session.evaluate(`document.querySelector('[data-v="timecode"]').click()`);
  await page.session.waitFor(`!!document.querySelector('[data-v="timecode-input"]')`, 3000);
  await page.session.evaluate(`(() => {
    const input = document.querySelector('[data-v="timecode-input"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(timecode)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(300);
}

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 15000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 20000);
  await page.session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: TMP });

  // ---- ① 删掉视频片段，只留文字：文字之外必须全透明 ----
  const clipId = await page.session.evaluate('window.__VEDITOR_TEST__.clips()[0].id');
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(clipId)})`);
  await sleep(200);
  await key('Delete', 'Delete', 46);
  await sleep(400);
  const afterDelete = await page.session.evaluate('window.__VEDITOR_TEST__.clips().length');
  report.check(`① 删除视频片段后时间线为空（片段 ${afterDelete}）`, afterDelete === 0);

  // ---- ② 加一段文字（3 秒 = 90 帧），透明背景上只有文字 ----
  await page.session.evaluate(`document.querySelector('[data-v="add-text"]').click()`);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length === 1', 5000);
  const textClip = JSON.parse(
    await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.clips()[0])'),
  );
  report.check(
    `② 文本片段已落在视频轨（${textClip.trackId} / ${textClip.durationFrames} 帧）`,
    textClip.text !== null && textClip.durationFrames >= 30,
  );

  // ---- ③ 标记 0–30 帧，只导这 1 秒 ----
  await seekTo(0);
  await key('i', 'KeyI', 73);
  await seekTo(30);
  await key('o', 'KeyO', 79);
  await sleep(300);
  const marks = JSON.parse(
    await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.marks())'),
  );
  report.check(`③ 入出点标记（${marks.in} – ${marks.out}）`, marks.in === 0 && marks.out === 30);

  // ---- ④ 导出 PNG 序列 ----
  await page.session.evaluate(`document.querySelector('[data-v="export-open"]').click()`);
  await page.session.waitFor(`!!document.querySelector('[data-v="export-dialog"]')`, 5000);
  await page.session.evaluate(`document.querySelector('[data-v="export-format-png"]').click()`);
  await sleep(200);
  // 先勾"仅导出标记区间"，提示里的帧数才会是区间帧数（30），否则显示整条时间线（90）
  await page.session.evaluate(`document.querySelector('[data-v="export-range"]').click()`);
  await sleep(200);
  const hint = await page.session.evaluate(
    `document.querySelector('[data-v="export-png-hint"]')?.textContent ?? ''`,
  );
  report.check(
    `④ 弹窗给出透明通道说明（${String(hint).slice(0, 30)}…）`,
    /RGBA|透明/.test(String(hint)) && String(hint).includes('30'),
  );
  await page.session.evaluate(`document.querySelector('[data-v="export-start"]').click()`);

  const deadline = Date.now() + 120000;
  let message = null;
  while (Date.now() < deadline) {
    message = await page.session.evaluate(
      `document.querySelector('[data-v="export-message"]')?.textContent ?? null`,
    );
    if (message !== null && String(message).length > 0) break;
    await sleep(800);
  }
  report.check(`④ 导出完成（${message}）`, message !== null && /帧/.test(String(message)));
  await sleep(1500);
  await page.screenshot({ path: path.join(ROOT, 'tests', 'screenshots', 'png-export.png') });

  // ---- ⑤ 拆包校验 ----
  const files = fs.readdirSync(TMP).filter((name) => name.endsWith('.zip'));
  report.check(`⑤ 下载到 ZIP（${files.join(', ') || '无'}）`, files.length === 1);

  if (files.length === 1) {
    const python = findPython();
    report.check('⑤ 环境里有 Python（stdlib zipfile）可做独立包校验', python !== null);
    if (python !== null) {
      const scriptPath = path.join(TMP, 'check.py');
      const extractDir = path.join(TMP, 'extracted');
      fs.writeFileSync(scriptPath, PY_CHECK, 'utf8');
      const run = spawnSync(python, [scriptPath, path.join(TMP, files[0]), extractDir], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      });
      let parsed = null;
      try {
        parsed = JSON.parse(run.stdout.trim());
      } catch {
        parsed = null;
      }
      if (parsed === null) {
        report.check(`⑤ Python 校验脚本可运行（stderr: ${(run.stderr ?? '').slice(0, 200)}）`, false);
      } else {
        report.check(`⑤ ZIP 完整（testzip=${parsed.bad}）`, parsed.bad === null);
        report.check(`⑤ PNG 数量 = 30（实际 ${parsed.pngCount}）`, parsed.pngCount === 30);
        report.check(
          `⑤ 命名从 frame_000001 起连续（首 ${parsed.names[0]}，末 ${parsed.names[parsed.pngCount - 1]}）`,
          parsed.names[0] === 'frame_000001.png' &&
            parsed.names[parsed.pngCount - 1] === 'frame_000030.png',
        );

        const manifest = parsed.manifest ?? {};
        report.check(
          `⑤ frames.json 记录帧率与起止帧（fps ${manifest.fps} / ${manifest.startFrame}–${manifest.endFrame} / ${manifest.frameCount} 帧）`,
          manifest.fps === 30 &&
            manifest.startFrame === 0 &&
            manifest.endFrame === 30 &&
            manifest.frameCount === 30,
        );

        // PNG 用本文件里的独立解码器（zlib + 逐行反滤波），不依赖任何图像库
        const first = decodePng(fs.readFileSync(path.join(extractDir, 'frame_000001.png')));
        const last = decodePng(fs.readFileSync(path.join(extractDir, 'frame_000030.png')));
        report.check(
          `⑤ PNG 是 8bit RGBA 且尺寸正确（colorType ${first.colorType} / ${first.width}×${first.height}）`,
          first.colorType === 6 && first.bitDepth === 8 && first.width === 1280 && first.height === 720,
        );
        report.check(
          `⑤ 真有透明像素（第 1 帧 alpha=0 占 ${first.transparent}，不透明 ${first.opaque}）`,
          first.transparent > 100000 && first.opaque > 1000,
        );
        report.check(
          `⑤ 边缘有半透明抗锯齿像素（${first.partial} 个）`,
          first.partial > 0,
        );
        report.check(
          `⑤ 末帧同样是 RGBA（alpha=0 占 ${last.transparent}）`,
          last.colorType === 6 && last.transparent > 100000,
        );
      }
    }
  }

  // ---- ⑥ 全程无页面错误 ----
  const errors = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.errors())'));
  report.check(`⑥ 全程无页面错误（${JSON.stringify(errors)}）`, Array.isArray(errors) && errors.length === 0);

  report.summary('透明通道导出（R-062）');
} finally {
  await page.close();
  dev.kill();
  await fixture.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
