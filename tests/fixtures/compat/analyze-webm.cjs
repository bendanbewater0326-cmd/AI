const fs = require('fs');
const path = require('path');

const DIR = 'D:/项目专用文件夹/剪辑工具/tests/fixtures/compat';

const ID = {
  Segment: 0x18538067,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueClusterPosition: 0xf1,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Cluster: 0x1f43b675,
  Tracks: 0x1654ae6b,
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

function children(buf, start, end) {
  const out = [];
  let p = start;
  while (p < end) {
    const id = readVint(buf, p, true);
    if (!id) break;
    const sz = readVint(buf, p + id.len, false);
    if (!sz) break;
    const dataOff = p + id.len + sz.len;
    const dataEnd = Math.min(end, dataOff + sz.value);
    out.push({ id: id.value, offset: p, dataOff, dataEnd, size: sz.value });
    const next = dataOff + sz.value;
    if (next <= p) break;
    p = next;
  }
  return out;
}

function readUInt(buf, start, end) {
  let v = 0;
  for (let i = start; i < end; i++) v = v * 256 + buf[i];
  return v;
}

function readFloat(buf, start, end) {
  const n = end - start;
  if (n === 4) return buf.readFloatBE(start);
  if (n === 8) return buf.readDoubleBE(start);
  return null;
}

function analyze(file) {
  const buf = fs.readFileSync(file);
  const top = children(buf, 0, buf.length);
  const seg = top.find((e) => e.id === ID.Segment);
  if (!seg) return { file: path.basename(file), error: 'no Segment' };

  const segKids = children(buf, seg.dataOff, seg.dataEnd);

  const info = segKids.find((e) => e.id === ID.Info);
  let timecodeScale = 1000000;
  let duration = null;
  if (info) {
    for (const c of children(buf, info.dataOff, info.dataEnd)) {
      if (c.id === ID.TimecodeScale) timecodeScale = readUInt(buf, c.dataOff, c.dataEnd);
      if (c.id === ID.Duration) duration = readFloat(buf, c.dataOff, c.dataEnd);
    }
  }

  const clusterCount = segKids.filter((e) => e.id === ID.Cluster).length;

  const cuesEl = segKids.find((e) => e.id === ID.Cues);
  let cueTimes = [];
  if (cuesEl) {
    for (const cp of children(buf, cuesEl.dataOff, cuesEl.dataEnd)) {
      if (cp.id !== ID.CuePoint) continue;
      for (const f of children(buf, cp.dataOff, cp.dataEnd)) {
        if (f.id === ID.CueTime) cueTimes.push(readUInt(buf, f.dataOff, f.dataEnd));
      }
    }
  }

  const scaleMs = timecodeScale / 1e6;

  return {
    file: path.basename(file),
    timecodeScale,
    durationFromInfo: duration,
    durationSec: duration === null ? null : (duration * timecodeScale) / 1e9,
    hasCues: !!cuesEl,
    cuePointCount: cueTimes.length,
    cueTimesMs: cueTimes.slice(0, 24).map((t) => Math.round(t * scaleMs)),
    clusterCount,
    topLevelOrder: top.map((e) => Object.keys(ID).find((k) => ID[k] === e.id) || '0x' + e.id.toString(16)),
  };
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.webm'));
for (const f of files) {
  const r = analyze(path.join(DIR, f));
  console.log(JSON.stringify(r, null, 2));
  console.log('---');
}
