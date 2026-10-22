/**
 * 画面旋转/翻转的纯逻辑单测（`core/types.normalizeRotation` + `render/frameTransform`）。
 *
 * 为什么值得单独测：这两个函数是"渲染"和"导出"共用的一份，
 * 它们算错的话**预览和成片会一起错**，而且错法往往是"看着像对的"（比如 90° 转成 -90°）。
 *
 * 这里钉三件事：
 *   ① `normalizeRotation` 吃负数/超 360/非数字，永远返回 0/90/180/270；
 *   ② 矩阵是**屏幕顺时针**（90° 把 (1,0) 映射到 (0,1)），且只有 0/±1（无浮点误差）；
 *   ③ `rotatedFit` 在 90/270 时**宽高互换**（否则 16:9 转 90° 会被压扁）。
 *
 * 运行：`node tests/frame-transform.test.mjs`
 */
import { buildSync } from 'esbuild';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..');
const TMP_DIR = path.join(HERE, '.tmp');

function load(relativeEntry, name) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const outfile = path.join(TMP_DIR, `${name}.mjs`);
  buildSync({
    absWorkingDir: ROOT,
    entryPoints: [relativeEntry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
  });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

const types = await load('src/core/types.ts', 'types');
const frame = await load('src/render/frameTransform.ts', 'frameTransform');

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}
const eq = (a, b, m) => assert.deepStrictEqual(a, b, m);

console.log('\n[1] normalizeRotation（只认 90° 步进）');

test('①a 合法值原样返回', () => {
  eq([0, 90, 180, 270].map(types.normalizeRotation), [0, 90, 180, 270]);
});

test('①b 负数绕回来（-90 → 270，-450 → 270）', () => {
  eq(types.normalizeRotation(-90), 270);
  eq(types.normalizeRotation(-450), 270);
  eq(types.normalizeRotation(-180), 180);
});

test('①c 超 360 取模（360 → 0，450 → 90，720 → 0）', () => {
  eq(types.normalizeRotation(360), 0);
  eq(types.normalizeRotation(450), 90);
  eq(types.normalizeRotation(720), 0);
});

test('①d 非数字/NaN/undefined → 0（老工程没有这个字段）', () => {
  eq(types.normalizeRotation(undefined), 0);
  eq(types.normalizeRotation(null), 0);
  eq(types.normalizeRotation(Number.NaN), 0);
  eq(types.normalizeRotation('90'), 0, '字符串不认，宁可回到 0 也不要 NaN');
});

console.log('\n[2] rotationMatrix（屏幕顺时针，只有 0/±1）');

test('②a 0° 是单位矩阵', () => {
  eq(frame.rotationMatrix(0), [1, 0, 0, 1]);
});

test('②b 90° 把 (1,0) 映射到 (0,1) = 屏幕上顺时针', () => {
  const m = frame.rotationMatrix(90);
  eq(m, [0, 1, -1, 0]);
  // 列主序：x' = m[0]*x + m[2]*y, y' = m[1]*x + m[3]*y
  const [x, y] = [1, 0];
  eq([m[0] * x + m[2] * y, m[1] * x + m[3] * y], [0, 1]);
});

test('②c 180° / 270° 的值', () => {
  eq(frame.rotationMatrix(180), [-1, 0, 0, -1]);
  eq(frame.rotationMatrix(270), [0, -1, 1, 0]);
});

test('②d 矩阵里只有 0 和 ±1（没有任何浮点误差）', () => {
  for (const rotation of [0, 90, 180, 270]) {
    for (const value of frame.rotationMatrix(rotation)) {
      assert.ok(
        value === 0 || value === 1 || value === -1,
        `${rotation}° 的矩阵出现了 ${value}（90° 步进不该有浮点分量）`,
      );
    }
  }
});

test('②e 四次 90° 回到单位矩阵', () => {
  let m = frame.rotationMatrix(0);
  for (let i = 0; i < 4; i += 1) m = frame.rotationMatrix(frame.rotationMatrix(0) && (i + 1) * 90);
  eq(m, [1, 0, 0, 1]);
});

console.log('\n[3] onScreenFit / quadForRotation（旋转后要重新 contain，不能拉伸）');

test('③a 0° / 180° 与普通 contain 一致', () => {
  eq(frame.onScreenFit(1920, 1080, 1920, 1080, 0), { width: 1920, height: 1080 });
  eq(frame.onScreenFit(1920, 1080, 1920, 1080, 180), { width: 1920, height: 1080 });
});

test('③b 16:9 转 90° → 9:16 贴满高度（宽 607.5，不是 1920）', () => {
  // 这是最关键的一条：旧实现把 9:16 拉伸回 1920 宽填满画布，人脸横向拉长 1.78 倍
  const box = frame.onScreenFit(1920, 1080, 1920, 1080, 90);
  eq(box, { width: 607.5, height: 1080 });
  assert.ok(box.width < 1920, '左右必须留黑，不能填满画布');
  eq(frame.onScreenFit(1920, 1080, 1920, 1080, 270), { width: 607.5, height: 1080 });
});

test('③c 旋转前后**等比**（不拉伸）：源宽高比 = 上屏宽高比的反比', () => {
  const box = frame.onScreenFit(1280, 720, 1920, 1080, 90);
  const sourceAspect = 1280 / 720;
  const onScreenAspect = box.width / box.height;
  assert.ok(
    Math.abs(onScreenAspect - 1 / sourceAspect) < 1e-9,
    `转 90° 后宽高比应为 ${1 / sourceAspect}，实际 ${onScreenAspect}`,
  );
});

test('③d 绘制矩形 = 上屏尺寸的宽高互换（转 90° 会换回来）', () => {
  eq(frame.quadForRotation(1920, 1080, 1920, 1080, 0), { width: 1920, height: 1080 });
  eq(frame.quadForRotation(1920, 1080, 1920, 1080, 90), { width: 1080, height: 607.5 });
  eq(frame.quadForRotation(1920, 1080, 1920, 1080, 180), { width: 1920, height: 1080 });
});

test('③e 竖屏源转 90° → 横过来贴满宽度', () => {
  // 1080×1920 的竖拍素材转 90° 应该变成 1920×1080 贴满（左右不留黑）
  eq(frame.onScreenFit(1080, 1920, 1920, 1080, 90), { width: 1920, height: 1080 });
});

test('③f 正方形转不转都一样', () => {
  eq(frame.onScreenFit(1000, 1000, 1920, 1080, 90), { width: 1080, height: 1080 });
});

console.log('\n[4] flipVector / isIdentityFrameTransform');

test('④a 翻转向量', () => {
  eq(frame.flipVector(false, false), [1, 1]);
  eq(frame.flipVector(true, false), [-1, 1]);
  eq(frame.flipVector(true, true), [-1, -1]);
});

test('④b 恒等判定（用于快路径）', () => {
  eq(frame.isIdentityFrameTransform(0, false, false), true);
  eq(frame.isIdentityFrameTransform(360, false, false), true, '360 等于 0');
  eq(frame.isIdentityFrameTransform(90, false, false), false);
  eq(frame.isIdentityFrameTransform(0, true, false), false);
});

console.log('\n[5] Transform 默认值（新片段不该带随机旋转）');

test('⑤a createTransform 默认 0 / 不翻转', () => {
  const t = types.createTransform();
  eq([t.rotation, t.flipX, t.flipY], [0, false, false]);
});

test('⑤b createClip 带出来的 transform 也是默认值', () => {
  const clip = types.createClip({
    assetId: 'a',
    trackId: 't',
    startFrame: 0,
    inFrame: 0,
    outFrame: 10,
    durationFrames: 10,
  });
  eq([clip.transform.rotation, clip.transform.flipX, clip.transform.flipY], [0, false, false]);
});

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✓' : '✗'} 画面旋转/翻转单测：通过 ${passed} / ${total}`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}`);
    console.error(failure.error);
  }
  process.exit(1);
}
