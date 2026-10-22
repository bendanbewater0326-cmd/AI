const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FFPROBE = 'C:/Users/Administrator/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.2-full_build/bin/ffprobe.exe';
const DIR = 'D:/项目专用文件夹/剪辑工具/tests/fixtures/compat';
const EXTRA = ['D:/项目专用文件夹/剪辑工具/tests/fixtures/sample-720p.mp4'];

const ARG_DIR = process.argv[2];
const TARGET = ARG_DIR ? path.resolve(ARG_DIR) : DIR;
const EXTRA_FILES = ARG_DIR ? [] : EXTRA;

function scanTopLevelBoxes(buf) {
  const boxes = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (size === 1) {
      if (off + 16 > buf.length) break;
      size = Number(buf.readBigUInt64BE(off + 8));
    }
    if (size === 0) {
      boxes.push({ type, offset: off, size: buf.length - off });
      break;
    }
    if (size < 8) break;
    boxes.push({ type, offset: off, size });
    off += size;
  }
  return boxes;
}

const EBML_NAMES = {
  0x1a45dfa3: 'EBML',
  0x18538067: 'Segment',
  0x114d9b74: 'SeekHead',
  0x1549a966: 'Info',
  0x1654ae6b: 'Tracks',
  0x1f43b675: 'Cluster',
  0x1c53bb6b: 'Cues',
  0x1254c367: 'Tags',
  0x1043a770: 'Chapters',
  0x1941a469: 'Attachments',
};

function readVint(buf, off, isId) {
  if (off >= buf.length) return null;
  const first = buf[off];
  if (first === 0) return null;
  let mask = 0x80;
  let len = 1;
  while (len <= 8 && !(first & mask)) {
    mask >>= 1;
    len++;
  }
  if (len > 8) return null;
  let value = isId ? first : first & (mask - 1);
  for (let i = 1; i < len; i++) {
    if (off + i >= buf.length) return null;
    value = value * 256 + buf[off + i];
  }
  return { value, len };
}

function scanEbml(buf) {
  const out = [];
  let off = 0;
  while (off < buf.length) {
    const id = readVint(buf, off, true);
    if (!id) break;
    const size = readVint(buf, off + id.len, false);
    if (!size) break;
    const name = EBML_NAMES[id.value] || '0x' + id.value.toString(16);
    const dataOff = off + id.len + size.len;
    out.push({ name, offset: off, size: size.value });

    if (id.value === 0x18538067) {
      let p = dataOff;
      const end = Math.min(buf.length, dataOff + size.value);
      let clusters = 0;
      while (p < end) {
        const cid = readVint(buf, p, true);
        if (!cid) break;
        const csz = readVint(buf, p + cid.len, false);
        if (!csz) break;
        const cname = EBML_NAMES[cid.value] || '0x' + cid.value.toString(16);
        if (cname === 'Cluster') {
          clusters++;
          if (clusters > 3) {
            out.push({ name: 'Cluster(...)', offset: p, size: -1, insideSegment: true });
            break;
          }
        }
        out.push({ name: cname, offset: p, size: csz.value, insideSegment: true });
        const next = p + cid.len + csz.len + csz.value;
        if (next <= p) break;
        p = next;
        if (out.length > 300) break;
      }
      break;
    }
    off = dataOff + size.value;
    if (off <= 0) break;
  }
  return out;
}

function ebmlChildren(buf, start, end) {
  const out = [];
  let p = start;
  while (p < end) {
    const id = readVint(buf, p, true);
    if (!id) break;
    const sz = readVint(buf, p + id.len, false);
    if (!sz) break;
    const dataOff = p + id.len + sz.len;
    out.push({ id: id.value, offset: p, dataOff, dataEnd: Math.min(end, dataOff + sz.value), size: sz.value });
    const next = dataOff + sz.value;
    if (next <= p) break;
    p = next;
  }
  return out;
}

function ebmlReadUInt(buf, start, end) {
  let v = 0;
  for (let i = start; i < end; i++) v = v * 256 + buf[i];
  return v;
}

function ebmlReadFloat(buf, start, end) {
  const n = end - start;
  if (n === 4) return buf.readFloatBE(start);
  if (n === 8) return buf.readDoubleBE(start);
  return null;
}

function analyzeWebmDetail(buf) {
  const top = ebmlChildren(buf, 0, buf.length);
  const seg = top.find((e) => e.id === 0x18538067);
  if (!seg) return { error: 'no Segment' };

  const kids = ebmlChildren(buf, seg.dataOff, seg.dataEnd);
  const info = kids.find((e) => e.id === 0x1549a966);

  let timecodeScale = 1000000;
  let durationRaw = null;
  if (info) {
    for (const c of ebmlChildren(buf, info.dataOff, info.dataEnd)) {
      if (c.id === 0x2ad7b1) timecodeScale = ebmlReadUInt(buf, c.dataOff, c.dataEnd);
      if (c.id === 0x4489) durationRaw = ebmlReadFloat(buf, c.dataOff, c.dataEnd);
    }
  }

  const cuesEl = kids.find((e) => e.id === 0x1c53bb6b);
  const cueTimes = [];
  if (cuesEl) {
    for (const cp of ebmlChildren(buf, cuesEl.dataOff, cuesEl.dataEnd)) {
      if (cp.id !== 0xbb) continue;
      for (const f of ebmlChildren(buf, cp.dataOff, cp.dataEnd)) {
        if (f.id === 0xb3) cueTimes.push(ebmlReadUInt(buf, f.dataOff, f.dataEnd));
      }
    }
  }

  const scaleMs = timecodeScale / 1e6;

  return {
    timecodeScale,
    hasCues: !!cuesEl,
    cuePointCount: cueTimes.length,
    cueTimesMs: cueTimes.slice(0, 24).map((t) => Math.round(t * scaleMs)),
    clusterCount: kids.filter((e) => e.id === 0x1f43b675).length,
    durationFromInfoSec: durationRaw === null ? null : (durationRaw * timecodeScale) / 1e9,
    topLevelOrder: top.map((e) => EBML_NAMES[e.id] || '0x' + e.id.toString(16)),
  };
}

function probe(file) {
  return JSON.parse(
    execFileSync(
      FFPROBE,
      ['-v', 'error', '-of', 'json', '-show_format', '-show_streams', file],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    )
  );
}

function keyframeTimes(file, streamIndex) {
  try {
    const out = execFileSync(
      FFPROBE,
      ['-v', 'error', '-select_streams', String(streamIndex), '-skip_frame', 'nokey',
       '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    );
    return out.split('\n').map((s) => s.trim().replace(/,$/, '')).filter(Boolean).map(Number);
  } catch (e) {
    return [];
  }
}

const files = fs
  .readdirSync(TARGET)
  .filter((f) => f.endsWith('.mp4') || f.endsWith('.webm'))
  .map((f) => path.join(TARGET, f))
  .concat(EXTRA_FILES);

const result = { generatedAt: new Date().toISOString(), fixtures: [] };
const expected = {
  generatedAt: new Date().toISOString(),
  note: 'normalized 是测试唯一真相源；probe 为 ffprobe 原始输出，仅供追溯。keyframeIndex 为 0 起 presentation order 帧号；null 表示无索引可用（需运行时扫描 Cluster）。',
  files: {},
};

for (const file of files) {
  const ext = path.extname(file).toLowerCase();
  const info = probe(file);
  const v = info.streams.find((s) => s.codec_type === 'video');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  const buf = fs.readFileSync(file);

  const fpsStr = v ? v.r_frame_rate : null;
  const [num, den] = fpsStr && fpsStr.includes('/') ? fpsStr.split('/').map(Number) : [0, 1];
  const fpsMilli = num && den ? Math.round((num / den) * 1000) : null;

  let frameCount = v && v.nb_frames && Number(v.nb_frames) > 0 ? Number(v.nb_frames) : null;
  if (frameCount === null && fpsMilli && info.format && info.format.duration) {
    frameCount = Math.round(parseFloat(info.format.duration) * (fpsMilli / 1000));
  }

  let containerInfo;
  if (ext === '.mp4' || ext === '.mov') {
    const boxes = scanTopLevelBoxes(buf);
    const moovIdx = boxes.findIndex((b) => b.type === 'moov');
    const mdatIdx = boxes.findIndex((b) => b.type === 'mdat');
    containerInfo = {
      container: 'mp4',
      structure: boxes.map((b) => ({ type: b.type, offset: b.offset, size: b.size })),
      moovBeforeMdat: moovIdx >= 0 && mdatIdx >= 0 ? moovIdx < mdatIdx : null,
    };
  } else {
    const detail = analyzeWebmDetail(buf);
    containerInfo = {
      container: 'webm',
      hasCues: detail.hasCues,
      cuePointCount: detail.cuePointCount,
      cueTimesMs: detail.cueTimesMs,
      clusterCount: detail.clusterCount,
      durationFromInfoSec: detail.durationFromInfoSec,
      topLevelOrder: detail.topLevelOrder,
    };
  }

  if (containerInfo.container === 'webm') {
    if (!containerInfo.hasCues) {
      frameCount = null;
    } else {
      try {
        const cnt = execFileSync(
          FFPROBE,
          ['-v', 'error', '-select_streams', 'v:0', '-count_packets',
           '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file],
          { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
        );
        const n = parseInt(cnt.trim(), 10);
        if (Number.isFinite(n) && n > 0) frameCount = n;
      } catch (e) {
        // 保持 duration 推算值
      }
    }
  }

  const kf = v ? keyframeTimes(file, v.index) : [];

  let kfFrames;
  if (containerInfo.container === 'webm') {
    kfFrames = containerInfo.hasCues
      ? containerInfo.cueTimesMs.map((ms) => Math.round((ms * fpsMilli) / 1000000))
      : null;
  } else {
    kfFrames = kf.map((t) => Math.round((t * fpsMilli) / 1000));
  }

  expected.files[path.basename(file)] = {
    probe: info,
    normalized: {
      container: containerInfo.container,
      fpsMilli,
      durationFrames: frameCount,
      hasVideo: !!v,
      hasAudio: !!a,
      width: v ? v.width : null,
      height: v ? v.height : null,
      hasBFrames: v ? v.has_b_frames > 0 : false,
      keyframeIndex: kfFrames,
      keyframeCount: kfFrames ? kfFrames.length : null,
      hasCues: containerInfo.container === 'webm' ? containerInfo.hasCues : undefined,
      clusterCount: containerInfo.container === 'webm' ? containerInfo.clusterCount : undefined,
      exactSeekRequired: true,
      postScan:
        containerInfo.container === 'webm' && !containerInfo.hasCues
          ? {
              durationFrames: (() => {
                try {
                  const out = execFileSync(
                    FFPROBE,
                    ['-v', 'error', '-select_streams', 'v:0', '-count_packets',
                     '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file],
                    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
                  );
                  const n = parseInt(out.trim(), 10);
                  return Number.isFinite(n) && n > 0 ? n : null;
                } catch (e) {
                  return null;
                }
              })(),
              keyframeIndex: kf.map((t) => Math.round((t * fpsMilli) / 1000)),
              note: '探测阶段 keyframeIndex/durationFrames 必须为 null；扫描 Cluster 后应得此值（VP8 无 alt-ref，ffprobe 结果可靠）',
            }
          : undefined,
    },
  };

  result.fixtures.push({
    file: path.basename(file),
    relPath: path.relative('D:/项目专用文件夹/剪辑工具/tests/fixtures', file).replace(/\\/g, '/'),
    sizeBytes: buf.length,
    ...containerInfo,
    video: v
      ? {
          codec: v.codec_name,
          width: v.width,
          height: v.height,
          fpsMilli,
          frameCount,
          hasBFrames: v.has_b_frames > 0,
          pixFmt: v.pix_fmt,
          profile: v.profile || null,
        }
      : null,
    audio: a
      ? {
          codec: a.codec_name,
          sampleRate: Number(a.sample_rate),
          channels: a.channels,
        }
      : null,
    keyframeCount: kf.length,
    keyframeTimesSec: kf.slice(0, 20),
    keyframeFrames: kf.slice(0, 20).map((t) => Math.round(t * (fpsMilli / 1000))),
  });
}

const outPath = path.join(TARGET, 'baseline.json');
fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');

const expectedPath = path.join(TARGET, 'expected-meta.json');
fs.writeFileSync(expectedPath, JSON.stringify(expected, null, 2), 'utf8');

console.log('file'.padEnd(24), 'cont', 'codec'.padEnd(6), 'fps', 'frames', 'kf', 'audio');
for (const f of result.fixtures) {
  const v = f.video;
  console.log(
    f.file.padEnd(24),
    f.container.padEnd(4),
    (v ? v.codec : '-').padEnd(6),
    String(v ? v.fpsMilli : '-').padStart(5),
    String(v ? v.frameCount : '-').padStart(6),
    String(f.keyframeCount).padStart(2),
    f.audio ? `${f.audio.codec}@${f.audio.sampleRate}` : '-'
  );
}
console.log('\nbaseline written to', outPath);
