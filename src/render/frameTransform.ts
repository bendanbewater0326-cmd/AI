/**
 * 片段的画面旋转/翻转（用户意图）——纯函数，渲染与 2D 降级共用一份。
 *
 * ## 为什么是"90° 步进 + 矩阵"
 *
 * 任意角度会引入画面外黑边（用户第一反应是"怎么有黑边"），而且要用 cos/sin：
 * 在 90° 上 `Math.cos(Math.PI/2)` 得到 6.1e-17 而不是 0，于是边缘出现半像素缝。
 * 90° 步进只有 0/±1，**没有浮点误差**，也不产生黑边。取舍见 `docs/nle-baseline.md` §6。
 *
 * ## 与 `Asset.rotation` 的区别
 *
 * `Asset.rotation` 是**容器元数据**（手机竖拍必须自动转正，不是用户意图）；
 * 这里是**用户意图**。两者在渲染管线里是两步：容器旋转由
 * `playbackEngine.rotateSourceToCanvas` 在解码后处理，这里只处理用户旋转。
 *
 * 单独成文件是为了能在 Node 里直接单测（合成器本身要 WebGL，跑不了）。
 */
import type { Rotation } from '../core/types';
import { normalizeRotation } from '../core/types';

/**
 * 旋转 → GL 的 mat2（**列主序**，可直接喂 `uniformMatrix2fv`）。
 *
 * 正方向是**屏幕上顺时针**：`[0,1,-1,0]` 把 (1,0) 映射到 (0,1)，
 * 而 GL 的 y 轴在裁剪空间向上、屏幕向下，所以视觉上是顺时针。
 */
export function rotationMatrix(rotation: Rotation | number): [number, number, number, number] {
  const r = normalizeRotation(rotation);
  if (r === 90) return [0, 1, -1, 0];
  if (r === 180) return [-1, 0, 0, -1];
  if (r === 270) return [0, -1, 1, 0];
  return [1, 0, 0, 1];
}

/** 翻转 → `u_flip`（1 = 不翻，-1 = 翻）。 */
export function flipVector(flipX: boolean, flipY: boolean): [number, number] {
  return [flipX ? -1 : 1, flipY ? -1 : 1];
}

/**
 * 源宽高比 → 在项目画布上的"contain"基础尺寸（scale = 1 时）。
 *
 * 从合成器搬到这里，是因为"旋转后的尺寸"必须用同一份 fit 逻辑算，
 * 两边各写一份必然漂移（一个按宽 fit、一个按高 fit，画面大小对不上）。
 */
export function fitSize(
  width: number,
  height: number,
  canvasWidth: number,
  canvasHeight: number,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(canvasWidth / width, canvasHeight / height);
  return { width: width * scale, height: height * scale };
}

/**
 * 上屏占位（旋转之后画面的包围盒，已 contain 进画布）。
 *
 * 16:9 的片段转 90° 之后应该是 **9:16 地贴满高度**（左右留黑），
 * 不是"把 9:16 拉伸回 16:9 填满画布"——后者是这类实现最常见的错法：
 * 看起来"转成功了"，其实画面被横向拉长了 1.78 倍，人脸全部变形。
 */
export function onScreenFit(
  sourceWidth: number,
  sourceHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  rotation: Rotation | number,
): { width: number; height: number } {
  const r = normalizeRotation(rotation);
  return r === 90 || r === 270
    ? // 旋转后源的长边变成竖的：按 (高, 宽) 去 fit
      fitSize(sourceHeight, sourceWidth, canvasWidth, canvasHeight)
    : fitSize(sourceWidth, sourceHeight, canvasWidth, canvasHeight);
}

/**
 * 绘制矩形的尺寸（**旋转之前**的那个矩形）。
 *
 * 为什么需要"旋转之前"的尺寸：着色器/Canvas2D 都是"先按这个矩形画，再把整个矩形转过去"。
 * 想让旋转后的结果正好是 `onScreenFit`，旋转前的矩形就必须是它的**宽高互换**
 * （转 90° 会把宽高换过来）。纹理画进这个互换过的矩形时是均匀缩放的，
 * 转回来正好抵消，所以不会变形。
 */
export function quadForRotation(
  sourceWidth: number,
  sourceHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  rotation: Rotation | number,
): { width: number; height: number } {
  const onScreen = onScreenFit(sourceWidth, sourceHeight, canvasWidth, canvasHeight, rotation);
  const r = normalizeRotation(rotation);
  return r === 90 || r === 270
    ? { width: onScreen.height, height: onScreen.width }
    : { width: onScreen.width, height: onScreen.height };
}

/** 有没有旋转/翻转（没有就走快路径，省一次 uniform 上传）。 */
export function isIdentityFrameTransform(
  rotation: Rotation | number,
  flipX: boolean,
  flipY: boolean,
): boolean {
  return normalizeRotation(rotation) === 0 && !flipX && !flipY;
}
