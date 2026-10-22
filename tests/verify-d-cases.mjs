import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'D:/项目专用文件夹/剪辑工具';
const TMP = path.join(ROOT, 'tests/.tmp/timebase.mjs');
fs.mkdirSync(path.dirname(TMP), { recursive: true });

await build({
  entryPoints: [path.join(ROOT, 'src/core/timebase.ts')],
  bundle: true,
  format: 'esm',
  outfile: TMP,
  logLevel: 'silent',
});

const tb = await import(pathToFileURL(TMP).href + '?t=' + Date.now());

function makeClip(s0, i, o, fs, fp) {
  return {
    startFrame: s0,
    inFrame: i,
    outFrame: o,
    durationFrames: tb.projectSpanFrames(o - i, fs, fp),
  };
}
function makeAsset(fpsMilli, dur) {
  return { fpsMilli, durationFrames: dur };
}

const cases = [
  { id: 'D1', fs: 60000, fp: 30000, s0: 0, i: 0, o: 25, checks: [[1, 2], [2, 4], [3, 6], [12, 24]] },
  { id: 'D2', fs: 24000, fp: 30000, s0: 0, i: 0, o: 6, checks: [[5, 4]] },
  { id: 'D3', fs: 30000, fp: 24000, s0: 0, i: 0, o: 6, checks: [[4, 5]] },
  { id: 'D4', fs: 23976, fp: 29970, s0: 0, i: 0, o: 6, checks: [[5, 4]] },
  { id: 'D5', fs: 25000, fp: 30000, s0: 0, i: 0, o: 2, checks: [[1, 0]] },
  { id: 'T2', fs: 30000, fp: 24000, s0: 0, i: 0, o: 240, checks: [[5, 6]] },
  { id: 'T5', fs: 30000, fp: 30000, s0: 50, i: 100, o: 400, checks: [[60, 110]] },
];

let pass = 0;
let fail = 0;
const failures = [];

for (const c of cases) {
  const clip = makeClip(c.s0, c.i, c.o, c.fs, c.fp);
  const asset = makeAsset(c.fs, 100000);
  const rows = [];
  for (const [n, expect] of c.checks) {
    const got = tb.mapProjectFrameToAssetFrame(n, clip, asset, c.fp);
    const ok = got === expect;
    if (ok) pass++;
    else {
      fail++;
      failures.push({ case: c.id, N: n, expect, got, Lp: clip.durationFrames });
    }
    rows.push(`N=${n} 期望${expect} 实得${got} ${ok ? '✓' : '✗'}`);
  }
  console.log(`${c.id.padEnd(3)} fs=${String(c.fs).padStart(5)} fp=${String(c.fp).padStart(5)} Lp=${String(clip.durationFrames).padStart(4)} | ${rows.join('  ')}`);
}

const inv = cases.map((c) => {
  const clip = makeClip(c.s0, c.i, c.o, c.fs, c.fp);
  const asset = makeAsset(c.fs, 100000);
  let prev = -1;
  let monotonic = true;
  let inRange = true;
  for (let n = clip.startFrame; n < clip.startFrame + clip.durationFrames; n++) {
    const s = tb.mapProjectFrameToAssetFrame(n, clip, asset, c.fp);
    if (s === null) {
      inRange = false;
      break;
    }
    if (s < prev) monotonic = false;
    if (s < clip.inFrame || s >= clip.outFrame) inRange = false;
    prev = s;
  }
  return { id: c.id, monotonic, inRange };
});

console.log('\n不变量检查：');
for (const i of inv) console.log(`  ${i.id}: 单调不减=${i.monotonic} 落在[in,out)=${i.inRange}`);

// 边界：null 语义
const clipB = makeClip(20, 48, 288, 24000, 30000);
const assetB = makeAsset(24000, 10000);
const before = tb.mapProjectFrameToAssetFrame(19, clipB, assetB, 30000);
const afterEnd = tb.mapProjectFrameToAssetFrame(20 + clipB.durationFrames, clipB, assetB, 30000);

console.log('\n边界：', { 'N=19(应null)': before, 'N=s0+Lp(应null)': afterEnd });

const allInvOk = inv.every((i) => i.monotonic && i.inRange);
const edgeOk = before === null && afterEnd === null;

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
if (failures.length) console.log('失败明细：', JSON.stringify(failures, null, 1));
console.log(`不变量：${allInvOk ? 'OK' : 'FAIL'} ｜ 边界 null 语义：${edgeOk ? 'OK' : 'FAIL'}`);
console.log(fail === 0 && allInvOk && edgeOk ? '\n✓ D1–D5 + 不变量 + 边界 全部通过' : '\n✗ 仍有问题');
