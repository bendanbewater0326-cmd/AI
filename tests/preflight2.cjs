const { chromium } = require('playwright-core');
const http = require('http');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const HTML = '<!doctype html><html><head><meta charset="utf-8"></head><body>ok</body></html>';

function startServer() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);
    });
    s.listen(0, '127.0.0.1', () => resolve({ s, port: s.address().port }));
  });
}

(async () => {
  const { s, port } = await startServer();
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);

  const out = await page.evaluate(async () => {
    const r = { videoEncode: {}, audioEncode: {}, mediaRecorder: {}, avcFormat: {}, notes: [] };

    const vCfg = (codec, extra) =>
      Object.assign({ codec, width: 1280, height: 720, bitrate: 5000000, framerate: 30 }, extra || {});

    for (const [codec, extra] of [
      ['vp8', null],
      ['vp8', { alpha: 'keep' }],
      ['vp09.00.10.08', null],
      ['vp09.02.10.10', null],
      ['vp09.00.41.08', { alpha: 'keep' }],
      ['vp09.00.10.08', { alpha: 'keep', latencyMode: 'realtime' }],
    ]) {
      const key = codec + (extra ? ' ' + JSON.stringify(extra) : '');
      try {
        const s2 = await VideoEncoder.isConfigSupported(vCfg(codec, extra));
        r.videoEncode[key] = !!s2.supported;
      } catch (e) {
        r.videoEncode[key] = 'err: ' + e.message;
      }
    }

    for (const cfg of [
      { codec: 'avc1.42001f', avc: { format: 'avc' } },
      { codec: 'avc1.42001f', avc: { format: 'annexb' } },
      { codec: 'avc1.42001f', avc: { format: 'annexb' }, latencyMode: 'realtime' },
    ]) {
      const key = JSON.stringify(cfg.avc) + (cfg.latencyMode ? ' realtime' : '');
      try {
        const s2 = await VideoEncoder.isConfigSupported(vCfg(cfg.codec, cfg));
        r.avcFormat[key] = !!s2.supported;
      } catch (e) {
        r.avcFormat[key] = 'err: ' + e.message;
      }
    }

    for (const cfg of [
      { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 },
      { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000, format: 'opus' },
      { codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 2, bitrate: 128000 },
    ]) {
      const key = cfg.codec + '@' + cfg.sampleRate + (cfg.format ? '+' + cfg.format : '');
      try {
        const s2 = await AudioEncoder.isConfigSupported(cfg);
        r.audioEncode[key] = !!s2.supported;
      } catch (e) {
        r.audioEncode[key] = 'err: ' + e.message;
      }
    }

    for (const m of [
      'video/webm;codecs=vp8',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp09.00.10.08',
      'video/webm;codecs=av01.0.04M.08',
      'video/webm',
      'video/mp4;codecs=avc1.42E01E',
      'video/mp4;codecs=avc1',
      'video/x-matroska;codecs=avc1',
    ]) {
      try {
        r.mediaRecorder[m] = MediaRecorder.isTypeSupported(m);
      } catch (e) {
        r.mediaRecorder[m] = 'err';
      }
    }

    try {
      const cv = document.createElement('canvas');
      cv.width = 64;
      cv.height = 64;
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, 64, 64);
      ctx.fillStyle = 'rgba(255,0,0,0.5)';
      ctx.fillRect(0, 0, 64, 64);
      const track = cv.captureStream(30).getVideoTracks()[0];
      const chunks = [];
      const rec = new MediaRecorder(track.stream ? track.stream : cv.captureStream(30), {
        mimeType: 'video/webm;codecs=vp8',
      });
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.start(100);
      await new Promise((res) => setTimeout(res, 400));
      rec.stop();
      await new Promise((res) => (rec.onstop = res));
      const blob = new Blob(chunks, { type: 'video/webm' });
      r.notes.push('MediaRecorder canvas alpha test produced ' + blob.size + ' bytes');
      r.notes.push('captureStream track settings: ' + JSON.stringify(track.getSettings()));
    } catch (e) {
      r.notes.push('MediaRecorder alpha test err: ' + e.message);
    }

    try {
      const oc = new OffscreenCanvas(8, 8);
      oc.getContext('2d').fillRect(0, 0, 8, 8);
      const fr = new VideoFrame(oc, { timestamp: 0 });
      r.notes.push('VideoFrame from OffscreenCanvas ok, format=' + fr.format);
      fr.close();
    } catch (e) {
      r.notes.push('VideoFrame from OffscreenCanvas err: ' + e.message);
    }

    return r;
  });

  console.log(JSON.stringify(out, null, 2));
  await browser.close();
  s.close();
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
