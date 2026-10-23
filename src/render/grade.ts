/**
 * 调色的 JS 实现 —— `compositor.ts` 里 `GRADE_GLSL` 的**逐字对应版**。
 *
 * 用途只有一个：左栏「特效」面板的缩略图。缩略图必须和预览**看起来一样**，
 * 否则用户点完会觉得"和卡片上不是一个东西"。
 *
 * ## 为什么不能用 CSS `filter`
 *
 * CSS 的 `brightness()` 是**乘法**（1 = 不变，1.2 = 整体乘 1.2），
 * 着色器是 `c += brightness`（**加法**：+0.5 就是每个通道都加 0.5）。
 * `brightness(+18)` 在着色器里是"整体抬 0.09"，写成 `brightness(1.09)` 是
 * "暗部抬 9%、亮部几乎不动"—— 参数一样、结果差很远。
 *
 * contrast 也不等价：着色器是 `(c - 0.5) * k + 0.5`（围绕 0.5 做线性拉伸），
 * CSS 的 `contrast()` 用的是一条不同的曲线。所以这里**逐像素复算**，
 * 不做近似。
 *
 * ⚠️ 改这里必须同步改 `compositor.ts` 的 `GRADE_GLSL`（反之亦然）。
 * 两处公式一旦分叉，症状是"缩略图和预览不是一个颜色"，而且很难归因。
 */
import type { ColorGrade } from './compositor';

/** 着色器里的四个 uniform 值（与 `compositor.ts` 里那 4 行 `uniform1f` 一致）。 */
export interface GradeUniforms {
  brightness: number;
  contrast: number;
  saturation: number;
  temperature: number;
}

/**
 * 把 -100..100 的 UI 参数换算成着色器 uniform。
 *
 * 对照 `compositor.ts` 的 `gl.uniform1f` 四行：
 * brightness/200、1+contrast/100、1+saturation/100、temperature/100。
 */
export function gradeUniforms(grade: ColorGrade): GradeUniforms {
  return {
    brightness: grade.brightness / 200,
    contrast: 1 + grade.contrast / 100,
    saturation: 1 + grade.saturation / 100,
    temperature: grade.temperature / 100,
  };
}

/** 是否中性（全 0）：中性时一个像素都不用动。 */
export function isNeutral(grade: ColorGrade): boolean {
  return (
    grade.brightness === 0 && grade.contrast === 0 && grade.saturation === 0 && grade.temperature === 0
  );
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * 单像素调色（输入输出都是 0..1）。
 *
 * 中间过程**不夹取**，只有最后 `clamp` —— 与 `GRADE_GLSL` 完全一致：
 * 着色器里 `c += u_brightness` 之后可能 >1，接着还要参与对比度与亮度混合，
 * 每一步都夹的话亮部会"糊成一片白"，和预览对不上。
 */
export function applyGradeToRgb(
  r: number,
  g: number,
  b: number,
  uniforms: GradeUniforms,
): [number, number, number] {
  let cr = r + uniforms.brightness;
  let cg = g + uniforms.brightness;
  let cb = b + uniforms.brightness;

  cr = (cr - 0.5) * uniforms.contrast + 0.5;
  cg = (cg - 0.5) * uniforms.contrast + 0.5;
  cb = (cb - 0.5) * uniforms.contrast + 0.5;

  // mix(vec3(luma), c, saturation) === luma + (c - luma) * saturation
  const luma = cr * 0.299 + cg * 0.587 + cb * 0.114;
  cr = luma + (cr - luma) * uniforms.saturation;
  cg = luma + (cg - luma) * uniforms.saturation;
  cb = luma + (cb - luma) * uniforms.saturation;

  // 暖色：加红减蓝（0.15 是着色器里的系数）
  cr += uniforms.temperature * 0.15;
  cb -= uniforms.temperature * 0.15;

  return [clamp01(cr), clamp01(cg), clamp01(cb)];
}

/**
 * 就地处理一整块 RGBA 字节（`ImageData.data`）。
 *
 * 只动 RGB，**alpha 保持原样**（着色器也是只改 rgb，alpha 由混合模式决定）。
 */
export function applyGradeToPixels(data: Uint8ClampedArray, grade: ColorGrade): void {
  if (isNeutral(grade)) return;
  const uniforms = gradeUniforms(grade);
  for (let i = 0; i + 3 < data.length; i += 4) {
    const [r, g, b] = applyGradeToRgb(
      (data[i] ?? 0) / 255,
      (data[i + 1] ?? 0) / 255,
      (data[i + 2] ?? 0) / 255,
      uniforms,
    );
    data[i] = r * 255;
    data[i + 1] = g * 255;
    data[i + 2] = b * 255;
  }
}
