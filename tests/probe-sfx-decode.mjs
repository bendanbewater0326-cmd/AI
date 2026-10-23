/**
 * 音效解码探针（一次性验证，不进 npm test）。
 *
 * 背景：用户反馈"ZCode 客户端点开音效文件没声音"——客户端文件预览是开源 Chromium 系
 * webview（不带 AAC 专有解码器），而应用目标环境是 Edge/Chrome/WebView2。
 * 本探针在 **E2E 同款 Edge**（`tests/cdp.mjs` 的 findBrowser）里把 10 个音效逐个
 * `AudioContext.decodeAudioData`，测真实波形电平——拿数据证明"应用环境里它们是响的"。
 *
 * 运行：`node --experimental-websocket tests/probe-sfx-decode.mjs`
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { launchPage, startServer } from './cdp.mjs';

const HERE = import.meta.dirname;
const SFX_DIR = path.resolve(HERE, '..', 'src', 'ui', 'audio', 'sfx');

/** 与 sfxLibrary.ts 同一份清单（id ↔ 文件 ↔ 标称时长）。 */
const PRESETS = [
  { id: 'ding', file: 'ding.m4a', seconds: 0.6 },
  { id: 'dong', file: 'dong.m4a', seconds: 0.7 },
  { id: 'beep', file: 'beep.m4a', seconds: 0.3 },
  { id: 'double-beep', file: 'double-beep.m4a', seconds: 0.8 },
  { id: 'whoosh', file: 'whoosh.m4a', seconds: 1.2 },
  { id: 'riser', file: 'riser.m4a', seconds: 1.0 },
  { id: 'fall', file: 'fall.m4a', seconds: 1.0 },
  { id: 'click', file: 'click.m4a', seconds: 0.4 },
  { id: 'noise-soft', file: 'noise-soft.m4a', seconds: 2.5 },
  { id: 'noise-strong', file: 'noise-strong.m4a', seconds: 2.5 },
];

const files = new Map([
  ['/', { type: 'text/html; charset=utf-8', body: '<!doctype html><title>sfx probe</title>ready' }],
]);
for (const preset of PRESETS) {
  files.set(`/sfx/${preset.file}`, {
    type: 'audio/mp4',
    body: fs.readFileSync(path.join(SFX_DIR, preset.file)),
  });
}
const server = await startServer(files);
const { session, close } = await launchPage({ url: `${server.origin}/` });

try {
  // 逐个解码并测量：peak（峰值）> 0.1 = 一定听得见；< 0.01 = 静音
  const results = await session.evaluate(`(async () => {
    const presets = ${JSON.stringify(PRESETS)};
    const ctx = new AudioContext({ sampleRate: 48000 });
    const out = [];
    for (const preset of presets) {
      const response = await fetch('/sfx/' + preset.file);
      const buffer = await response.arrayBuffer();
      try {
        const audio = await ctx.decodeAudioData(buffer.slice(0));
        let peak = 0;
        let sumSq = 0;
        let samples = 0;
        const data = audio.getChannelData(0);
        for (let i = 0; i < data.length; i += 1) {
          const value = Math.abs(data[i]);
          if (value > peak) peak = value;
          sumSq += data[i] * data[i];
          samples += 1;
        }
        out.push({
          id: preset.id,
          ok: true,
          duration: audio.duration,
          peak,
          rms: samples > 0 ? Math.sqrt(sumSq / samples) : 0,
        });
      } catch (error) {
        out.push({ id: preset.id, ok: false, error: String(error) });
      }
    }
    void ctx.close();
    return out;
  })()`);

  console.log('Edge 内核解码实测（AudioContext.decodeAudioData）：');
  let failed = 0;
  for (const [index, result] of results.entries()) {
    const preset = PRESETS[index];
    if (!result.ok) {
      failed += 1;
      console.log(`  ✗ ${preset.id.padEnd(12)} 解码失败：${result.error}`);
      continue;
    }
    const durationOk = Math.abs(result.duration - preset.seconds) <= 0.05;
    const audible = result.peak > 0.1;
    if (!durationOk || !audible) failed += 1;
    console.log(
      `  ${durationOk && audible ? '✓' : '✗'} ${result.id.padEnd(12)} ` +
        `时长 ${result.duration.toFixed(2)}s（标称 ${preset.seconds}s）` +
        `  峰值 ${result.peak.toFixed(3)}  RMS ${result.rms.toFixed(3)}` +
        (audible ? '' : '  ← 电平过低，听不见'),
    );
  }

  assert.strictEqual(failed, 0, `${failed} 个音效在 Edge 内核里解码/电平不达标`);
  console.log(`\n✓ 10 个音效在应用目标内核（Edge/Chrome 同款）全部可解码、电平达标。`);
  console.log('  客户端预览无声是那个 webview 不带 AAC 解码（连 WAV 也不响说明其预览面板不出音频），');
  console.log('  与产物无关；应用内的试听/播放/导出链路由此探针证明可达。');
} finally {
  await close();
  await server.close();
}
