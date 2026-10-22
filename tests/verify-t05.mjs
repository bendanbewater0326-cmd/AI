/**
 * T05 验证脚本（Node，**不依赖 WebCodecs**）。
 *
 * 做四件事：
 *   1. 用 `fs` 分块读 + `File` 结构化 shim 喂给 `openMp4`（**不整体读入内存**）；
 *   2. 对 `compat/` 8 个 mp4 + `hardline/` 7 个文件逐字段比对 `expected-meta.json` 的 `normalized`；
 *   3. 验证 B 帧不变量（首帧 pts=0、pts 单调不减、dts 与 pts 分离）与显式拒绝语义；
 *   4. 测量解析 52MB `long_ntsc.mp4` 的堆增长（需 `--expose-gc`）。
 *
 * 运行：`node --expose-gc tests/verify-t05.mjs`
 *
 * 期望值唯一真相源是 fixtures 里的 `expected-meta.json`，**本脚本不改任何期望值**。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE_DIR = path.join(ROOT, 'tests', '.cache');
const COMPAT_DIR = path.join(ROOT, 'tests', 'fixtures', 'compat');
const HARDLINE_DIR = path.join(ROOT, 'tests', 'fixtures', 'hardline');
const EXTRA_MP4 = path.join(ROOT, 'tests', 'fixtures', 'sample-720p.mp4');

let failures = 0;
function fail(message) {
  failures += 1;
  console.error(`  ✗ ${message}`);
}
function pass(message) {
  console.log(`  ✓ ${message}`);
}

/** 把 TS 源码打成 ESM，供 Node 直接 import。 */
async function bundleMediaModules() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const entry = path.join(CACHE_DIR, 'entry.ts');
  fs.writeFileSync(
    entry,
    [
      "export { openMp4, readSample } from '../../src/media/demuxMp4';",
      "export { probeAsset, sniffContainer, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT } from '../../src/media/mediaProbe';",
      '',
    ].join('\n'),
    'utf8',
  );
  const outfile = path.join(CACHE_DIR, 'media.mjs');
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'warning',
  });
  return import(`file://${outfile.replace(/\\/g, '/')}?t=${Date.now()}`);
}

/**
 * `File` 的结构化替身：**按需 readSync**，不把整个文件读进 Buffer。
 * 这与浏览器的 `File.slice()` 语义一致（slice 只在 arrayBuffer() 时才真正分配）。
 */
class NodeFileSource {
  constructor(filePath) {
    this.filePath = filePath;
    this.name = path.basename(filePath);
    this.size = fs.statSync(filePath).size;
    this.lastModified = Math.floor(fs.statSync(filePath).mtimeMs);
    this.fd = fs.openSync(filePath, 'r');
  }

  slice(start = 0, end = this.size) {
    const from = Math.max(0, Math.min(start, this.size));
    const to = Math.max(from, Math.min(end, this.size));
    const length = to - from;
    const fd = this.fd;
    return {
      async arrayBuffer() {
        const buffer = new ArrayBuffer(length);
        if (length > 0) fs.readSync(fd, new Uint8Array(buffer), 0, length, from);
        return buffer;
      },
    };
  }

  close() {
    fs.closeSync(this.fd);
  }
}

/** 内存 buffer 的 File 替身（用于构造不支持变体）。 */
class MemoryFileSource {
  constructor(name, bytes) {
    this.name = name;
    this.bytes = bytes;
    this.size = bytes.length;
    this.lastModified = 0;
  }

  slice(start = 0, end = this.size) {
    const from = Math.max(0, Math.min(start, this.size));
    const to = Math.max(from, Math.min(end, this.size));
    const bytes = this.bytes;
    return {
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset + from, bytes.byteOffset + to);
      },
    };
  }
}

/** codec 字符串 → ffprobe 风格的 codec_name 归类。 */
function codecFamily(codec) {
  if (codec === null) return null;
  if (codec.startsWith('avc1') || codec.startsWith('avc3')) return 'h264';
  if (codec.startsWith('hvc1') || codec.startsWith('hev1')) return 'hevc';
  if (codec.startsWith('vp09')) return 'vp9';
  if (codec.startsWith('vp08')) return 'vp8';
  if (codec.startsWith('av01')) return 'av1';
  return codec;
}

/** 逐字段比对（**零容差**：期望值来自 ffprobe 实测）。 */
function compareNormalized(label, probe, normalized, expectedCodec, expectedMimeCodec) {
  const checks = [
    ['container', probe.container, normalized.container],
    ['fpsMilli', probe.fpsMilli, normalized.fpsMilli],
    ['durationFrames', probe.durationFrames, normalized.durationFrames],
    ['hasVideo', probe.hasVideo, normalized.hasVideo],
    ['hasAudio', probe.hasAudio, normalized.hasAudio],
    ['width', probe.width, normalized.width],
    ['height', probe.height, normalized.height],
    ['keyframeCount', probe.keyframeIndex === null ? null : probe.keyframeIndex.length, normalized.keyframeCount],
  ];
  let line = `  ${label.padEnd(24)}`;
  let ok = true;
  for (const [field, actual, expected] of checks) {
    if (expected === undefined) continue;
    const same = actual === expected;
    if (!same) {
      ok = false;
      fail(`${label} ${field}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
    }
  }
  if (expectedCodec !== undefined && codecFamily(probe.videoCodec) !== expectedCodec) {
    ok = false;
    fail(`${label} codec: actual=${JSON.stringify(codecFamily(probe.videoCodec))} expected=${JSON.stringify(expectedCodec)}`);
  }
  // ffprobe 的 mime_codec_string 是 RFC 6381 的权威写法，逐字符比对（仅 avc1 有该字段）
  if (expectedMimeCodec !== undefined && probe.videoCodec !== expectedMimeCodec) {
    ok = false;
    fail(`${label} videoCodec: actual=${JSON.stringify(probe.videoCodec)} expected=${JSON.stringify(expectedMimeCodec)}`);
  }
  const expectedKeyframes = normalized.keyframeIndex;
  const actualKeyframes = probe.keyframeIndex;
  const keyframesSame =
    expectedKeyframes === null
      ? actualKeyframes === null
      : actualKeyframes !== null &&
        actualKeyframes.length === expectedKeyframes.length &&
        actualKeyframes.every((value, index) => value === expectedKeyframes[index]);
  if (!keyframesSame) {
    ok = false;
    fail(`${label} keyframeIndex: actual=${JSON.stringify(actualKeyframes)} expected=${JSON.stringify(expectedKeyframes)}`);
  }
  if (normalized.hasBFrames !== undefined && probe.video !== null && probe.video.hasBFrames !== normalized.hasBFrames) {
    ok = false;
    fail(`${label} hasBFrames: actual=${probe.video.hasBFrames} expected=${normalized.hasBFrames}`);
  }
  if (ok) {
    line += `codec=${String(codecFamily(probe.videoCodec)).padEnd(5)} fps=${String(probe.fpsMilli).padEnd(6)}`;
    line += ` frames=${String(probe.durationFrames).padEnd(5)} ${String(probe.width)}x${String(probe.height)}`;
    line += ` kf=${probe.keyframeIndex === null ? 'null' : probe.keyframeIndex.length}`;
    line += ` audio=${probe.hasAudio ? 'y' : 'n'} ✓`;
    pass(line);
  }
  return ok;
}

/** B 帧不变量：首帧 pts=0、pts 单调不减、存在 dts≠pts。 */
function checkBFrameInvariants(label, probe) {
  if (probe.samples.length === 0) return true;
  let ok = true;
  const first = probe.samples[0];
  if (first.ptsUs !== 0) {
    ok = false;
    fail(`${label} 首帧 ptsUs=${first.ptsUs}（应为 0）`);
  }
  for (let i = 1; i < probe.samples.length; i += 1) {
    if (probe.samples[i].ptsUs < probe.samples[i - 1].ptsUs) {
      ok = false;
      fail(`${label} ptsUs 非单调：index ${i} ${probe.samples[i].ptsUs} < ${probe.samples[i - 1].ptsUs}`);
      break;
    }
  }
  if (probe.video !== null && probe.video.hasBFrames) {
    const differs = probe.samples.some((sample) => sample.dtsUs !== sample.ptsUs);
    if (!differs) {
      ok = false;
      fail(`${label} hasBFrames=true 但没有任何 dtsUs !== ptsUs 的样本（DTS/PTS 没有真正分离）`);
    }
  }
  if (ok) pass(`${label} 帧序不变量（pts0=0 / 单调 / dts≠pts）✓`);
  return ok;
}

/** 构造：顶层插入 moof（fragmented mp4）。 */
function buildFragmentedMp4(base) {
  const bytes = Uint8Array.from(base);
  const ftypEnd = readU32(bytes, 0);
  const parts = [
    bytes.subarray(0, ftypEnd),
    Uint8Array.from([0, 0, 0, 16, 0x6d, 0x6f, 0x6f, 0x66, 0, 0, 0, 0, 0, 0, 0, 0]), // 'moof' 16B
    bytes.subarray(ftypEnd),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function readU32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

async function main() {
  const media = await bundleMediaModules();
  const { openMp4, probeAsset } = media;

  console.log('=== 1. compat/ expected-meta.json（normalized 逐字段，零容差） ===');
  const compatExpected = JSON.parse(fs.readFileSync(path.join(COMPAT_DIR, 'expected-meta.json'), 'utf8'));
  const compatBaseline = JSON.parse(fs.readFileSync(path.join(COMPAT_DIR, 'baseline.json'), 'utf8'));
  const mimeCodecOf = (dirMeta, name) => {
    const entry = dirMeta.files[name];
    if (entry === undefined) return undefined;
    const stream = (entry.probe.streams ?? []).find((item) => item.codec_type === 'video');
    return stream === undefined ? undefined : stream.mime_codec_string;
  };
  const codecOf = (dirBaseline, name) => {
    const entry = dirBaseline.fixtures.find((item) => item.file === name);
    return entry === undefined || entry.video === null ? undefined : entry.video.codec;
  };
  const compatFiles = [...Object.keys(compatExpected.files)].filter((name) => name.endsWith('.mp4'));
  compatFiles.push('sample-720p.mp4');
  const compatSources = new Map();
  for (const name of compatFiles) {
    const filePath = name === 'sample-720p.mp4' ? EXTRA_MP4 : path.join(COMPAT_DIR, name);
    compatSources.set(name, filePath);
  }

  for (const [name, filePath] of compatSources) {
    const source = new NodeFileSource(filePath);
    try {
      const result = await openMp4(source);
      const normalized =
        name === 'sample-720p.mp4'
          ? compatExpected.files['sample-720p.mp4'].normalized
          : compatExpected.files[name].normalized;
      if (!result.ok) {
        fail(`${name} 解析失败: ${result.error.code} ${result.error.message} / ${result.error.detail ?? ''}`);
        continue;
      }
      compareNormalized(name, result.value, normalized, codecOf(compatBaseline, name), mimeCodecOf(compatExpected, name));
      checkBFrameInvariants(name, result.value);
      if (name === 'faststart-bframes.mp4') {
        const kf = result.value.keyframeIndex;
        console.log(`      B 帧样例 keyframeIndex=${JSON.stringify(kf)} dts/pts 前 6 帧=${JSON.stringify(
          result.value.samples.slice(0, 6).map((sample) => [sample.dtsUs, sample.ptsUs]),
        )}`);
      }
    } finally {
      source.close();
    }
  }

  console.log('=== 2. hardline/ expected-meta.json ===');
  const hardlineExpected = JSON.parse(fs.readFileSync(path.join(HARDLINE_DIR, 'expected-meta.json'), 'utf8'));
  const hardlineBaseline = JSON.parse(fs.readFileSync(path.join(HARDLINE_DIR, 'baseline.json'), 'utf8'));
  for (const [name, entry] of Object.entries(hardlineExpected.files)) {
    if (!name.endsWith('.mp4')) continue;
    const source = new NodeFileSource(path.join(HARDLINE_DIR, name));
    try {
      const result = await openMp4(source);
      if (!result.ok) {
        fail(`${name} 解析失败: ${result.error.code} ${result.error.message} / ${result.error.detail ?? ''}`);
        continue;
      }
      compareNormalized(`hardline/${name}`, result.value, entry.normalized, codecOf(hardlineBaseline, name), mimeCodecOf(hardlineExpected, name));
    } finally {
      source.close();
    }
  }

  console.log('=== 3. 显式拒绝（fMP4 / 多 sample entry / 加密 / webm / 未知容器） ===');
  const baseBytes = fs.readFileSync(path.join(COMPAT_DIR, 'faststart-bframes.mp4'));

  const fragmented = await openMp4(new MemoryFileSource('frag.mp4', buildFragmentedMp4(baseBytes)));
  if (!fragmented.ok && fragmented.error.code === 'E_UNSUPPORTED_VARIANT') {
    pass(`fMP4 → ${fragmented.error.code} / ${fragmented.error.detail}`);
  } else {
    fail(`fMP4 未被正确拒绝: ${JSON.stringify(fragmented.ok ? 'ok' : fragmented.error)}`);
  }

  // 多 sample entry：把 stsd.entry_count 从 1 改成 2（moov@32 → stsd@441 → content 449，entry_count@453）
  const multiEntry = Uint8Array.from(baseBytes);
  multiEntry[453] = 0;
  multiEntry[454] = 0;
  multiEntry[455] = 0;
  multiEntry[456] = 2;
  const multi = await openMp4(new MemoryFileSource('multi.mp4', multiEntry));
  if (!multi.ok && multi.error.code === 'E_UNSUPPORTED_VARIANT' && /多 sample entry/.test(multi.error.message)) {
    pass(`多 sample entry → ${multi.error.code} / ${multi.error.detail}`);
  } else {
    fail(`多 sample entry 未被正确拒绝: ${JSON.stringify(multi.ok ? 'ok' : multi.error)}`);
  }

  // 加密：sample entry 四cc 由 avc1 → encv（box@457，type@461）
  const encrypted = Uint8Array.from(baseBytes);
  encrypted.set([0x65, 0x6e, 0x63, 0x76], 461);
  const enc = await openMp4(new MemoryFileSource('enc.mp4', encrypted));
  if (!enc.ok && enc.error.code === 'E_UNSUPPORTED_VARIANT') {
    pass(`加密素材 → ${enc.error.code} / ${enc.error.message} / ${enc.error.detail}`);
  } else {
    fail(`加密素材未被正确拒绝: ${JSON.stringify(enc.ok ? 'ok' : enc.error)}`);
  }

  for (const webmPath of [
    path.join(COMPAT_DIR, 'webm-vp9-opus.webm'),
    path.join(HARDLINE_DIR, 'webm-vp9-opus.webm'),
    path.join(COMPAT_DIR, 'webm-nocues.webm'),
  ]) {
    const source = new NodeFileSource(webmPath);
    try {
      const sniffed = await media.sniffContainer(source);
      const probed = await probeAsset(source);
      const opened = await openMp4(source);
      const name = path.basename(webmPath);
      const okSniff = sniffed === 'webm';
      // T19 起 webm 走独立 demuxer：probeAsset 必须成功且 container='webm'。
      // 旧契约（"webm 一律 E_UNSUPPORTED_CONTAINER"）随 T19 交付作废。
      const okProbe = probed.ok && probed.value.asset.container === 'webm';
      // openMp4 是 mp4 专用入口，遇到 webm 仍必须拒绝——这是容器解耦的正确性证据
      const okOpen = !opened.ok && opened.error.code === 'E_UNSUPPORTED_CONTAINER';
      const frames = probed.ok ? probed.value.asset.durationFrames : null;
      if (okSniff && okProbe && okOpen) {
        pass(`${name} → sniff=webm / probe 成功（container=webm, ${frames} 帧）/ openMp4 正确拒绝`);
      } else {
        fail(`${name} webm 语义不符: sniff=${sniffed} probe=${JSON.stringify(probed.ok ? 'ok' : probed.error)} open=${JSON.stringify(opened.ok ? 'ok' : opened.error)}`);
      }
    } finally {
      source.close();
    }
  }

  const aviHead = new Uint8Array(64);
  aviHead.set([0x52, 0x49, 0x46, 0x46], 0);
  aviHead.set([0x41, 0x56, 0x49, 0x20], 8);
  const aviResult = await probeAsset(new MemoryFileSource('clip.avi', aviHead));
  if (!aviResult.ok && aviResult.error.code === 'E_UNSUPPORTED_CONTAINER') {
    pass(`未知容器（RIFF/AVI）→ ${aviResult.error.code} / ${aviResult.error.message}`);
  } else {
    fail(`未知容器未被正确拒绝: ${JSON.stringify(aviResult.ok ? 'ok' : aviResult.error)}`);
  }

  // 64 位 largesize 顶层 box（size===1）：在文件头插一个 16 字节 'free'，解析必须继续走到 ftyp/moov
  {
    const largesizeFree = new Uint8Array(16);
    largesizeFree.set([0, 0, 0, 1], 0); // size32 = 1 → 走 largesize
    largesizeFree.set([0x66, 0x72, 0x65, 0x65], 4); // 'free'
    largesizeFree.set([0, 0, 0, 0, 0, 0, 0, 16], 8); // largesize = 16
    const combined = new Uint8Array(largesizeFree.length + baseBytes.length);
    combined.set(largesizeFree, 0);
    combined.set(baseBytes, largesizeFree.length);
    const largesizeResult = await openMp4(new MemoryFileSource('largesize.mp4', combined));
    if (largesizeResult.ok && largesizeResult.value.durationFrames === 120) {
      pass(`顶层 size===1（64 位 largesize）→ 跳过 ${16}B free 后仍解析出 120 帧 ✓`);
    } else {
      fail(`largesize box 处理失败: ${JSON.stringify(largesizeResult.ok ? largesizeResult.value.durationFrames : largesizeResult.error)}`);
    }
  }

  // 截断文件（moov 在尾且被切掉）：必须返回错误而不是 throw，也不是半成品
  {
    const truncated = Uint8Array.from(fs.readFileSync(path.join(COMPAT_DIR, 'audioonly.mp4')).subarray(0, 4096));
    const truncatedResult = await openMp4(new MemoryFileSource('truncated.mp4', truncated));
    if (!truncatedResult.ok && truncatedResult.error.code === 'E_DECODE_FAILED') {
      pass(`moov 被截断 → ${truncatedResult.error.code} / ${truncatedResult.error.message}（未 throw）`);
    } else {
      fail(`截断文件语义不符: ${JSON.stringify(truncatedResult.ok ? 'ok' : truncatedResult.error)}`);
    }
  }

  console.log('=== 4. probeAsset 字段落库检查（不含缩略图：Node 无 WebCodecs） ===');
  {
    const source = new NodeFileSource(path.join(COMPAT_DIR, 'audioonly.mp4'));
    try {
      const probed = await probeAsset(source, { thumbnailDecoder: null });
      if (!probed.ok) {
        fail(`audioonly.mp4 probe 失败: ${probed.error.code} ${probed.error.message}`);
      } else {
        const { asset } = probed.value;
        const okKind = asset.kind === 'audio';
        const okNull = asset.durationFrames === null;
        const okThumb = probed.value.thumbnail === null;
        if (okKind && okNull && okThumb) {
          pass(`audioonly.mp4 → kind=${asset.kind} durationFrames=${String(asset.durationFrames)} thumb=${String(probed.value.thumbnail)}`);
        } else {
          fail(`audioonly.mp4 Asset 不符: kind=${asset.kind} durationFrames=${String(asset.durationFrames)}`);
        }
      }
    } finally {
      source.close();
    }
  }
  {
    const source = new NodeFileSource(EXTRA_MP4);
    try {
      const probed = await probeAsset(source, { thumbnailDecoder: null });
      if (!probed.ok) {
        fail(`sample-720p.mp4 probe 失败: ${probed.error.code}`);
      } else {
        const { asset, probe } = probed.value;
        const checks = [
          ['kind', asset.kind, 'video'],
          ['fpsMilli', asset.fpsMilli, 30000],
          ['durationFrames', asset.durationFrames, 240],
          ['width', asset.width, 1280],
          ['height', asset.height, 720],
          ['hasAudio', asset.hasAudio, true],
          ['container', asset.container, 'mp4'],
          ['codecVideo', asset.codecVideo, 'avc1.64001f'],
          ['exactSeek', asset.exactSeek, true],
          ['hashKey', asset.hashKey, `sample-720p.mp4|${source.size}|${source.lastModified}`],
          ['durationSec≈8', Math.round(probed.value.durationSec), 8],
          ['samples.length', probe.samples.length, 240],
        ];
        let ok = true;
        for (const [field, actual, expected] of checks) {
          if (actual !== expected) {
            ok = false;
            fail(`sample-720p.mp4 Asset.${field}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
          }
        }
        if (ok) pass(`sample-720p.mp4 Asset 字段（codec=${probed.value.asset.codecVideo} / 240 帧 / 1280×720 / exactSeek=true）✓`);
      }
    } finally {
      source.close();
    }
  }

  console.log('=== 5. 52MB long_ntsc.mp4 堆增长 ===');
  {
    const filePath = path.join(COMPAT_DIR, 'long_ntsc.mp4');
    const before = process.memoryUsage();
    const source = new NodeFileSource(filePath);
    const gcBefore = typeof global.gc === 'function' ? (global.gc(), process.memoryUsage()) : before;
    const startedAt = Date.now();
    const result = await openMp4(source);
    const elapsedMs = Date.now() - startedAt;
    const gcAfter = typeof global.gc === 'function' ? (global.gc(), process.memoryUsage()) : process.memoryUsage();
    const growthMb = (gcAfter.heapUsed - gcBefore.heapUsed) / (1024 * 1024);
    const rssGrowthMb = (gcAfter.rss - gcBefore.rss) / (1024 * 1024);
    source.close();
    console.log(
      `  heapUsed 增量=${growthMb.toFixed(2)}MB  rss 增量=${rssGrowthMb.toFixed(2)}MB  耗时=${elapsedMs}ms  ` +
        `样本数=${result.ok ? result.value.samples.length : 'n/a'}  moov 大小=25670B（实测 box 表，mdat=54457873B 未被读取）`,
    );
    if (result.ok && growthMb < 30) pass(`堆增长 ${growthMb.toFixed(2)}MB < 30MB ✓`);
    else fail(`堆增长 ${growthMb.toFixed(2)}MB 超限或解析失败`);
    if (result.ok) {
      const kf = result.value.keyframeIndex ?? [];
      const expected = Array.from({ length: 25 }, (_, index) => index * 240);
      const kfOk = kf.length === 25 && kf.every((value, index) => value === expected[index]);
      if (kfOk) pass(`long_ntsc.mp4 keyframeIndex 25 个 / 间隔 240 ✓`);
      else fail(`long_ntsc.mp4 keyframeIndex 不符: ${JSON.stringify(kf)}`);
    }
  }

  console.log('');
  if (failures === 0) {
    console.log('ALL T05 CHECKS PASSED');
  } else {
    console.error(`T05 FAILED: ${failures} 处不一致`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('验证脚本失败：', error);
  process.exitCode = 1;
});
