const { chromium } = require('playwright-core');
const http = require('http');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>preflight</title></head><body>ok</body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

(async () => {
  const { server, port } = await startServer();
  const url = `http://127.0.0.1:${port}/`;

  const browser = await chromium.launch({
    executablePath: EDGE,
    headless: true,
  });
  const page = await browser.newPage();
  await page.goto(url);
  await page.waitForTimeout(200);

  const report = await page.evaluate(async () => {
    const out = {
      origin: location.origin,
      isSecureContext: window.isSecureContext,
      hasVideoDecoder: typeof VideoDecoder !== 'undefined',
      hasVideoEncoder: typeof VideoEncoder !== 'undefined',
      hasAudioDecoder: typeof AudioDecoder !== 'undefined',
      hasAudioEncoder: typeof AudioEncoder !== 'undefined',
      hasFileSystemAccess: typeof showOpenFilePicker !== 'undefined',
      hasOffscreenCanvas: typeof OffscreenCanvas !== 'undefined',
      hasWebGL2: (() => {
        try {
          return !!new OffscreenCanvas(1, 1).getContext('webgl2');
        } catch (e) {
          return false;
        }
      })(),
      hasWebShare: typeof navigator.canShare !== 'undefined',
    };

    if (out.hasVideoDecoder) {
      out.decode = {};
      for (const [codec, w, h] of [
        ['avc1.42E01E', 1280, 720],
        ['avc1.640028', 1920, 1080],
        ['vp09.00.10.08', 1280, 720],
        ['av01.0.04M.08', 1280, 720],
        ['hvc1.1.6.L93.B0', 1280, 720],
      ]) {
        try {
          const s = await VideoDecoder.isConfigSupported({ codec, codedWidth: w, codedHeight: h });
          out.decode[codec] = !!s.supported;
        } catch (e) {
          out.decode[codec] = 'err: ' + e.message;
        }
      }

      out.encode = {};
      for (const [codec, w, h, br, fr, alpha] of [
        ['avc1.42001f', 1280, 720, 5000000, 30, false],
        ['avc1.640028', 1920, 1080, 8000000, 30, false],
        ['vp09.00.10.08', 1280, 720, 5000000, 30, false],
        ['vp09.00.10.08', 1280, 720, 5000000, 30, true],
      ]) {
        const key = codec + (alpha ? ':alpha' : '');
        try {
          const cfg = { codec, width: w, height: h, bitrate: br, framerate: fr };
          if (alpha) cfg.alpha = 'keep';
          const s = await VideoEncoder.isConfigSupported(cfg);
          out.encode[key] = !!s.supported;
        } catch (e) {
          out.encode[key] = 'err: ' + e.message;
        }
      }

      if (out.hasAudioEncoder) {
        for (const cfg of [
          { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 },
          { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 },
        ]) {
          try {
            const s = await AudioEncoder.isConfigSupported(cfg);
            out.encode[cfg.codec] = !!s.supported;
          } catch (e) {
            out.encode[cfg.codec] = 'err: ' + e.message;
          }
        }
      }
    }
    return out;
  });

  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  server.close();
})().catch((e) => {
  console.error('PREFLIGHT FAILED:', e.message);
  process.exit(1);
});
