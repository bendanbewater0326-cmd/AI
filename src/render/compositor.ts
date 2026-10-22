/**
 * 多轨合成器（T07 / 架构 §8.3）—— WebGL2 主实现 + Canvas2D 降级，同一 `Compositor` 接口。
 *
 * 三条不可违反的约束：
 *
 * 1. **同源**：`endFrame()` 上屏与 `captureFrame()` **必须来自同一次绘制的同一张离屏缓冲**。
 *    所有层先合成到离屏 target，`endFrame()` 把它拷到可见 canvas，`captureFrame()` 从**同一张**
 *    离屏缓冲读回。禁止"captureFrame 再画一遍"，也禁止用 `preserveDrawingBuffer` 换实现
 *    （后者会拖慢上屏，且读回的是默认帧缓冲，语义不同）。
 *
 * 2. **空白帧必须整张清**：`gl.clearColor(0,0,0,1)` + 全画布 clear，不是局部 clear。
 *    "所有轨都返回 null"时合成器只清屏，绝不复用任意片段的帧（§5.3 / §8.2）。
 *
 * 3. **判空一律 `=== null`**：`0` 是合法帧号，`0 ?? x` / `0 || x` 都会走进"无画面"分支，
 *    典型症状是片段首帧不显示。本文件不使用 `??` / `||` / truthy 判定帧号。
 *
 * 层序（纯数据决定，禁止引入 `createdSeq`）：
 *   - 先按 `track.order` 升序（order 0 最底）；
 *   - 同 order（同轨）重叠 ≤1 帧时，`startFrame` 更小者**后**绘制（压在上面）；
 *   - `startFrame` 相等时，`index` 更大者后绘制。
 *
 * 混合模式：`normal` 单 pass（`SRC_ALPHA / ONE_MINUS_SRC_ALPHA`）；
 * `multiply / screen / overlay` 走 2 pass（先把已累积结果 blit 到第二张 FBO，再用混合 shader
 * 采样背景逐像素合成）——M2 明确采用 FBO 2 pass，不设计单 pass 多纹理方案（§8.3）。
 */
import type { BlendMode, Frame, Transform } from '../core/types';
import { normalizeRotation } from '../core/types';
import { applyCurveValue, isNeutralCurve } from './curve';
import { flipVector, quadForRotation, rotationMatrix } from './frameTransform';
import type { MaskParams } from './mask';
import type { CurveParams } from './curve';

/* ---------------- 公开类型 ---------------- */

export type CompositorKind = 'webgl2' | 'canvas2d';

/** 可上传为纹理 / 可 drawImage 的源。 */
export type LayerSource =
  | VideoFrame
  | ImageBitmap
  | HTMLVideoElement
  | HTMLCanvasElement
  | OffscreenCanvas;

/**
 * 层的合成位置信息（由调用方从 doc 里取，合成器只做排序，不反查 doc）。
 *
 * - `order`：`track.order`（越大越靠上）
 * - `startFrame`：片段的项目起点（同轨重叠时决定压盖次序）
 * - `index`：同轨片段的稳定序号（数组下标），最后兜底
 */
/**
 * 调色参数（R-035）：四项都按 -100..100 的"滑块值"表达，着色器里再归一化。
 *
 * 为什么放在合成器而不是在 CPU 上逐像素改：预览与导出共用同一条 GPU 路径，
 * 才能保证"预览看到的颜色 == 导出文件里的颜色"（CPU 与 GPU 的舍入不一样）。
 */
export interface ColorGrade {
  /** -100..100，0 = 不变。 */
  brightness: number;
  contrast: number;
  saturation: number;
  /** 负 = 冷，正 = 暖。 */
  temperature: number;
}

export const NEUTRAL_GRADE: ColorGrade = { brightness: 0, contrast: 0, saturation: 0, temperature: 0 };

/** 是否等于中性（全 0 时直接跳过 uniform 设置与滤镜）。 */
export function isNeutralGrade(grade: ColorGrade): boolean {
  return grade.brightness === 0 && grade.contrast === 0 && grade.saturation === 0 && grade.temperature === 0;
}

export interface LayerPlacement {
  order: number;
  startFrame: Frame;
  index: number;
}

export interface CompositorStats {
  /** 累计 endFrame 次数。 */
  frames: number;
  /** 最近一次 endFrame 的 JS 提交耗时（ms）。 */
  lastEndFrameMs: number;
  /** 平均 endFrame 的 JS 提交耗时（ms）。 */
  avgEndFrameMs: number;
  /** 最近一帧的层数。 */
  lastLayerCount: number;
  /** 最近一次 endFrame 期间的 GL 错误码（0 = 无错）；排查"画面黑但层数正常"用。 */
  lastGlError: number;
  /** 因层源失效（VideoFrame 已 close / 尺寸 0）被跳过的层数累计。 */
  skippedLayers: number;
}

export interface Compositor {
  readonly kind: CompositorKind;
  /** 可见画布（WebGL2 时是 WebGL canvas，Canvas2D 时是 2D canvas）。 */
  readonly canvas: HTMLCanvasElement;
  /** 合成分辨率（= 项目分辨率）。 */
  readonly width: number;
  readonly height: number;
  resize(width: number, height: number): void;
  beginFrame(projectFrame: Frame, clear: boolean): void;
  drawLayer(
    source: LayerSource,
    transform: Transform,
    placement: LayerPlacement,
    grade?: ColorGrade,
    curve?: CurveParams | null,
    lut?: LutLayer | null,
    mask?: MaskParams | null,
  ): void;
  endFrame(): void;
  /** 与上屏同源：读的是同一张离屏缓冲。 */
  captureFrame(): Promise<ImageBitmap>;
  stats(): CompositorStats;
  dispose(): void;
}

export interface CreateCompositorOptions {
  width: number;
  height: number;
  /** 强制实现（测试用）；缺省优先 WebGL2，不可用时降级 Canvas2D。 */
  prefer?: CompositorKind;
  /** 复用调用方提供的 canvas（必须是未取过其它 context 的 canvas）。 */
  canvas?: HTMLCanvasElement;
  /** 背景色（空白帧清屏色），默认黑。 */
  background?: readonly [number, number, number];
  /**
   * 透明背景（R-062）：清屏 alpha = 0，且 WebGL 上下文带 alpha 通道。
   *
   * 默认 false —— 预览与 MP4/GIF 导出必须是**不透明**的：
   * 视频编码器不保留 alpha，带透明度的帧会被合成到黑底，出现"预览亮、成片暗"。
   * 只有 PNG 序列导出需要 true。
   */
  alpha?: boolean;
}

/** 一层的 LUT（已解析好，纹理按 key 缓存）。 */
export interface LutLayer {
  size: number;
  /** 缓存键（同一份 cube 只上传一次）。 */
  key: string;
  /** `size³ * 3` 个 0..1 浮点。 */
  data: Float32Array;
  strength: number;
}

interface LayerEntry {
  source: LayerSource;
  transform: Transform;
  placement: LayerPlacement;
  grade: ColorGrade;
  /** 曲线（R-055）：null = 恒等。 */
  curve: CurveParams | null;
  /** 3D LUT（R-058）：null = 不做 LUT。 */
  lut: LutLayer | null;
  /** 蒙版（R-056）：null = 全画面。 */
  mask: MaskParams | null;
  seq: number;
}

/* ---------------- 公共工具 ---------------- */

/** 层序比较：返回值 < 0 表示 a 先画（在下面）。纯数据，不含创建顺序。 */
function compareLayers(left: LayerEntry, right: LayerEntry): number {
  if (left.placement.order !== right.placement.order) {
    return left.placement.order - right.placement.order;
  }
  // 同轨重叠：startFrame 更小者后画（压上面）→ 排序时大的在前
  if (left.placement.startFrame !== right.placement.startFrame) {
    return right.placement.startFrame - left.placement.startFrame;
  }
  // 仍相同：index 更大者后画
  return left.placement.index - right.placement.index;
}

/** 源的自然像素尺寸。 */
function sourceSize(source: LayerSource): { width: number; height: number } {
  if (typeof VideoFrame !== 'undefined' && source instanceof VideoFrame) {
    return { width: source.displayWidth, height: source.displayHeight };
  }
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    return { width: source.videoWidth, height: source.videoHeight };
  }
  const sized = source as { width?: number; height?: number };
  return { width: sized.width ?? 0, height: sized.height ?? 0 };
}

/** 源宽高比 → 在项目画布上的"contain"基础尺寸（scale = 1 时）。 */
function parseBackground(background: readonly [number, number, number] | undefined): {
  r: number;
  g: number;
  b: number;
} {
  const fallback = { r: 0, g: 0, b: 0 };
  if (!background) return fallback;
  const [r, g, b] = background;
  return { r: r / 255, g: g / 255, b: b / 255 };
}

/* ---------------- WebGL2 实现 ---------------- */

const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
uniform vec2 u_canvas;
uniform vec2 u_center;
uniform vec2 u_size;
/**
 * 旋转 + 翻转（用户意图，见 docs/nle-baseline.md §6）。
 *
 * 为什么用 mat2 而不是角度：只允许 90° 步进，矩阵里只有 0/±1，
 * **没有浮点误差**（用 cos/sin 在 90° 上会得到 6e-17，边缘会出现半像素缝）。
 * 翻转在旋转之后做 —— 也就是"显示空间"的镜像，符合用户说的"左右翻一下"。
 */
uniform mat2 u_rotate;
uniform vec2 u_flip;
out vec2 v_uv;
void main() {
  // **顺序不能换**：先按 u_size 缩放到像素空间，再旋转，最后翻转。
  // 先旋转是错的 —— 单位正方形转 90° 还是那个正方形（几何上恒等），
  // 于是画面看着"转成功了"（宽高互换生效了）却完全没转，是这类实现最常见的错法。
  vec2 local = (a_pos - 0.5) * u_size;
  local = u_rotate * local;
  local *= u_flip;
  vec2 px = local + u_canvas * 0.5 + u_center;
  vec2 clip = (px / u_canvas) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  // v = 0 必须对应图像的**顶行**：画布顶（a_pos.y = 0）取 v = 0，
  // captureFrame 的 readPixels 是 GL 自下而上、再逐行翻回左上原点，两者正好抵消。
  // 早先这里配的是 UNPACK_FLIP_Y_WEBGL = 1（把纹理上下翻转以补偿 -clip.y），
  // 结果与 captureFrame 的翻转移抵消成"整幅画上下颠倒"——T09 拿 ref_137.png
  // 比对时暴露（时间码跑到左下角）。T07 测不出来：它只做同链路自比对，
  // 上下颠倒对"captureFrame vs 上屏"是**不变量**。
  // 现改为不依赖 pixelStore 提示：不同源类型（VideoFrame / ImageBitmap / Canvas）
  // 对 UNPACK_FLIP_Y_WEBGL 的支持并不一致，去掉它才能保证三者朝向统一。
  //
  // **uv 不参与旋转/翻转**：旋转翻转的是"几何"，纹理内容跟着几何一起转，
  // 蒙版也定义在 uv（源坐标）上，于是蒙版跟着画面一起转——这才是"贴在画面上"的语义。
  v_uv = a_pos;
}`;

/**
 * 调色（R-035）。四个 uniform 的取值由 JS 归一化好，着色器只做纯数学：
 * - u_brightness: -0.5..0.5（亮度 ±100 映射到 ±0.5）
 * - u_contrast / u_saturation: 0..2（1 = 不变）
 * - u_temperature: -1..1（暖色加红减蓝）
 *
 * 中性值 = (0, 1, 1, 0)，与不加调色完全等价——所以老片段/老工程不会因为这次改动变色。
 */
const GRADE_GLSL = `
uniform float u_brightness;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_temperature;
vec3 applyGrade(vec3 c) {
  c += u_brightness;
  c = (c - 0.5) * u_contrast + 0.5;
  float luma = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(luma), c, u_saturation);
  c.r += u_temperature * 0.15;
  c.b -= u_temperature * 0.15;
  return clamp(c, 0.0, 1.0);
}
`;

/**
 * 曲线调色（R-055）：4 点分段线性，端点固定 (0,0)/(1,1)。
 * 与 `render/curve.ts` 的 `applyCurveValue` 是同一套公式——两边必须一起改。
 */
const CURVE_GLSL = `
uniform vec4 u_curve;
float curveChannel(float v) {
  if (v <= u_curve.x) {
    return u_curve.x <= 0.0001 ? u_curve.y : (v / u_curve.x) * u_curve.y;
  }
  if (v <= u_curve.z) {
    return mix(u_curve.y, u_curve.w, (v - u_curve.x) / max(0.0001, u_curve.z - u_curve.x));
  }
  return mix(u_curve.w, 1.0, (v - u_curve.z) / max(0.0001, 1.0 - u_curve.z));
}
vec3 applyCurve(vec3 c) {
  return vec3(curveChannel(c.r), curveChannel(c.g), curveChannel(c.b));
}
`;

/**
 * 3D LUT（R-058）：三线性插值交给 `sampler3D` 的硬件 LINEAR 过滤。
 *
 * 坐标要**半像素偏移**：3D 纹理的格点在 (i+0.5)/N，而颜色值是 0..1 的连续区间；
 * 直接拿 c*N 采样会整体偏半格（表现为"颜色整体偏一点"，很难发现）。
 */
const LUT_GLSL = `
// 采样器必须显式写精度：sampler3D 没有默认精度（sampler2D 有 lowp），
// 不写会编译失败——而着色器编译失败会让整个编辑器白屏（不是只丢 LUT）。
uniform mediump sampler3D u_lut;
uniform float u_lutSize;
uniform float u_lutStrength;
uniform int u_hasLut;
vec3 applyLut(vec3 c) {
  if (u_hasLut == 0) return c;
  vec3 coord = clamp(c, 0.0, 1.0);
  float scale = (u_lutSize - 1.0) / u_lutSize;
  float offset = 0.5 / u_lutSize;
  return mix(c, texture(u_lut, coord * scale + offset).rgb, u_lutStrength);
}
`;

/**
 * 蒙版（R-056）：矩形/椭圆 + 羽化。与 render/mask.ts 的 maskAlphaAt 同一套公式。
 *
 * 形状用 int 而不是 bool（GLSL ES 3.0 的 uniform bool 在某些驱动上有坑）。
 */
const MASK_GLSL = `
uniform vec4 u_mask;
uniform float u_maskFeather;
uniform int u_maskShape;
uniform int u_maskInvert;
uniform int u_maskOn;
float maskAlpha(vec2 uv) {
  if (u_maskOn == 0) return 1.0;
  float feather = max(0.0001, u_maskFeather);
  float distance;
  if (u_maskShape == 1) {
    vec2 center = vec2(u_mask.x + u_mask.z * 0.5, u_mask.y + u_mask.w * 0.5);
    vec2 norm = (uv - center) / max(vec2(0.0001), vec2(u_mask.z * 0.5, u_mask.w * 0.5));
    distance = 1.0 - length(norm);
  } else {
    distance = min(min(uv.x - u_mask.x, u_mask.x + u_mask.z - uv.x),
                   min(uv.y - u_mask.y, u_mask.y + u_mask.w - uv.y));
  }
  float t = clamp(distance / feather, 0.0, 1.0);
  float alpha = t * t * (3.0 - 2.0 * t);
  return u_maskInvert == 1 ? 1.0 - alpha : alpha;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform float u_opacity;
${GRADE_GLSL}
${CURVE_GLSL}
${LUT_GLSL}
${MASK_GLSL}
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec4 color = texture(u_tex, v_uv);
  outColor = vec4(applyLut(applyCurve(applyGrade(color.rgb))), color.a * u_opacity * maskAlpha(v_uv));
}`;

const BLEND_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
uniform sampler2D u_bg;
uniform sampler2D u_fg;
uniform float u_opacity;
uniform int u_mode;
${GRADE_GLSL}
${CURVE_GLSL}
${LUT_GLSL}
${MASK_GLSL}
in vec2 v_uv;
out vec4 outColor;

vec3 blendPixel(vec3 base, vec3 src) {
  if (u_mode == 1) {
    return base * src;                       // multiply
  }
  if (u_mode == 2) {
    return base + src - base * src;          // screen
  }
  // overlay: base < 0.5 ? 2*base*src : 1-2*(1-base)*(1-src)
  vec3 low = 2.0 * base * src;
  vec3 high = 1.0 - 2.0 * (1.0 - base) * (1.0 - src);
  return mix(low, high, step(vec3(0.5), base));
}

void main() {
  vec4 bg = texture(u_bg, v_uv);
  vec4 fg = texture(u_fg, v_uv);
  // 混合前先调色：调色是"这一层的颜色"，不是"混合后的整体颜色"
  vec3 blended = blendPixel(bg.rgb, applyLut(applyCurve(applyGrade(fg.rgb))));
  // 蒙版：遮住的区域露出背景（而不是变黑）
  blended = mix(bg.rgb, blended, maskAlpha(v_uv));
  float alpha = clamp(fg.a * u_opacity, 0.0, 1.0);
  outColor = vec4(mix(bg.rgb, blended, alpha), max(bg.a, alpha));
}`;

function blendModeCode(mode: BlendMode): number {
  if (mode === 'multiply') return 1;
  if (mode === 'screen') return 2;
  if (mode === 'overlay') return 3;
  return 0;
}

interface MaskUniforms {
  rect: WebGLUniformLocation;
  feather: WebGLUniformLocation;
  shape: WebGLUniformLocation;
  invert: WebGLUniformLocation;
  on: WebGLUniformLocation;
}

interface LutUniforms {
  tex: WebGLUniformLocation;
  size: WebGLUniformLocation;
  strength: WebGLUniformLocation;
  has: WebGLUniformLocation;
}

interface GradeUniforms {
  brightness: WebGLUniformLocation;
  contrast: WebGLUniformLocation;
  saturation: WebGLUniformLocation;
  temperature: WebGLUniformLocation;
}

interface WebGlResources {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  blendProgram: WebGLProgram;
  quad: WebGLBuffer;
  texture: WebGLTexture;
  layerTexture: WebGLTexture;
  fboMain: WebGLFramebuffer;
  textureMain: WebGLTexture;
  fboBack: WebGLFramebuffer;
  textureBack: WebGLTexture;
  aPosMain: number;
  aPosBlend: number;
  uniforms: {
    canvas: WebGLUniformLocation;
    center: WebGLUniformLocation;
    size: WebGLUniformLocation;
    /** 旋转 mat2 + 翻转 vec2（两套 program 各一份）。 */
    rotateMain: WebGLUniformLocation;
    rotateBlend: WebGLUniformLocation;
    flipMain: WebGLUniformLocation;
    flipBlend: WebGLUniformLocation;
    opacity: WebGLUniformLocation;
    tex: WebGLUniformLocation;
    bg: WebGLUniformLocation;
    fg: WebGLUniformLocation;
    mode: WebGLUniformLocation;
    /** 调色（两套 program 各有一份，按 program 前缀区分）。 */
    gradeMain: GradeUniforms;
    gradeBlend: GradeUniforms;
    /** 曲线（R-055）：vec4(x1,y1,x2,y2)。 */
    curveMain: WebGLUniformLocation;
    curveBlend: WebGLUniformLocation;
    /** 3D LUT（R-058）：纹理单元 3。 */
    lutMain: LutUniforms;
    lutBlend: LutUniforms;
    /** 蒙版（R-056）。 */
    maskMain: MaskUniforms;
    maskBlend: MaskUniforms;
  };
}

function createTexture(gl: WebGL2RenderingContext, width: number, height: number): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error('compositor: createTexture 失败');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  return texture;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('compositor: createShader 失败');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '(无日志)';
    gl.deleteShader(shader);
    throw new Error(`compositor: shader 编译失败 ${log}`);
  }
  return shader;
}

function linkProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error('compositor: createProgram 失败');
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertex);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragment);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? '(无日志)';
    gl.deleteProgram(program);
    throw new Error(`compositor: program 链接失败 ${log}`);
  }
  return program;
}

function createFramebuffer(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): { fbo: WebGLFramebuffer; texture: WebGLTexture } {
  const texture = createTexture(gl, width, height);
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error('compositor: createFramebuffer 失败');
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`compositor: FBO 不完整（0x${status.toString(16)}）`);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, texture };
}

class WebGl2Compositor implements Compositor {
  readonly kind: CompositorKind = 'webgl2';
  readonly canvas: HTMLCanvasElement;
  width: number;
  height: number;

  private readonly gl: WebGL2RenderingContext;
  private readonly uniforms: WebGlResources['uniforms'];
  private readonly program: WebGLProgram;
  private readonly blendProgram: WebGLProgram;
  private readonly quad: WebGLBuffer;
  private readonly layerTexture: WebGLTexture;
  /** 1×1×1 的占位 3D 纹理：sampler3D 必须绑一个完整纹理，否则整个 draw 会失效。 */
  private readonly lutDummy: WebGLTexture;
  /** 已上传的 LUT 纹理（key → texture）。 */
  private readonly lutTextures = new Map<string, WebGLTexture>();
  private fboMain: WebGLFramebuffer;
  private textureMain: WebGLTexture;
  private fboBack: WebGLFramebuffer;
  private textureBack: WebGLTexture;
  private readonly aPosMain: number;
  private readonly aPosBlend: number;
  private readonly blendCanvas: WebGLUniformLocation;
  private readonly blendCenter: WebGLUniformLocation;
  private readonly blendSize: WebGLUniformLocation;
  private readonly background: { r: number; g: number; b: number };
  /** 透明背景：清屏 alpha=0（仅 PNG 序列导出用）。 */
  private readonly transparent: boolean;

  private layers: LayerEntry[] = [];
  private seq = 0;
  private frameCount = 0;
  private lastMs = 0;
  private totalMs = 0;
  private lastLayerCount = 0;
  private lastGlError = 0;
  /** 因层源失效（尺寸 0）被跳过的层数。 */
  private skippedLayers = 0;
  private disposed = false;

  constructor(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    background: { r: number; g: number; b: number },
    transparent = false,
  ) {
    /**
     * `preserveDrawingBuffer: true` —— **不是**为了截图（截图走 FBO 读回，见文件头）。
     *
     * 2026-10-22 用户报"暂停时预览花屏（黑白噪点、横向条纹）"。根因是：
     * `preserveDrawingBuffer: false` 时，浏览器**合成过一次之后就不再保证
     * 绘制缓冲的内容有效**。而预览是"有变化才重绘"的（暂停时不画）——
     * 只要用户暂停后发生任何一次重新合成（窗口缩放、切主题、面板重排、切标签页回来），
     * 显示的就是那块**未定义内存**，表现为随机噪点/条纹。
     *
     * 两种修法：
     * 1. 常驻 rAF 每帧重画 —— 暂停时也白烧 GPU，笔记本风扇会响；
     * 2. 保留绘制缓冲 —— 只在有内容变化时画，暂停时画面天然稳定。
     * 选 2。代价是每帧多一次缓冲拷贝（1080p 约 0.1–0.3ms，且不随片段数增长），
     * 换来的是"暂停时画面绝对不会变成垃圾"这个硬保证。
     */
    const gl = canvas.getContext('webgl2', {
      alpha: transparent,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('compositor: WebGL2 不可用');
    this.gl = gl;
    this.canvas = canvas;
    this.width = width;
    this.height = height;
    this.background = background;
    this.transparent = transparent;
    this.program = linkProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this.blendProgram = linkProgram(gl, VERTEX_SHADER, BLEND_FRAGMENT_SHADER);
    this.quad = WebGl2Compositor.createQuad(gl);
    this.layerTexture = createTexture(gl, 1, 1);
    this.lutDummy = WebGl2Compositor.createDummyLut(gl);
    const main = createFramebuffer(gl, width, height);
    this.fboMain = main.fbo;
    this.textureMain = main.texture;
    const back = createFramebuffer(gl, width, height);
    this.fboBack = back.fbo;
    this.textureBack = back.texture;
    this.aPosMain = gl.getAttribLocation(this.program, 'a_pos');
    this.aPosBlend = gl.getAttribLocation(this.blendProgram, 'a_pos');
    this.blendCanvas = WebGl2Compositor.mustUniform(gl, this.blendProgram, 'u_canvas');
    this.blendCenter = WebGl2Compositor.mustUniform(gl, this.blendProgram, 'u_center');
    this.blendSize = WebGl2Compositor.mustUniform(gl, this.blendProgram, 'u_size');
    this.uniforms = {
      canvas: WebGl2Compositor.mustUniform(gl, this.program, 'u_canvas'),
      center: WebGl2Compositor.mustUniform(gl, this.program, 'u_center'),
      size: WebGl2Compositor.mustUniform(gl, this.program, 'u_size'),
      rotateMain: WebGl2Compositor.mustUniform(gl, this.program, 'u_rotate'),
      rotateBlend: WebGl2Compositor.mustUniform(gl, this.blendProgram, 'u_rotate'),
      flipMain: WebGl2Compositor.mustUniform(gl, this.program, 'u_flip'),
      flipBlend: WebGl2Compositor.mustUniform(gl, this.blendProgram, 'u_flip'),
      opacity: WebGl2Compositor.mustUniform(gl, this.program, 'u_opacity'),
      tex: WebGl2Compositor.mustUniform(gl, this.program, 'u_tex'),
      bg: WebGl2Compositor.mustUniform(gl, this.blendProgram, 'u_bg'),
      fg: WebGl2Compositor.mustUniform(gl, this.blendProgram, 'u_fg'),
      mode: WebGl2Compositor.mustUniform(gl, this.blendProgram, 'u_mode'),
      gradeMain: {
        brightness: WebGl2Compositor.mustUniform(gl, this.program, 'u_brightness'),
        contrast: WebGl2Compositor.mustUniform(gl, this.program, 'u_contrast'),
        saturation: WebGl2Compositor.mustUniform(gl, this.program, 'u_saturation'),
        temperature: WebGl2Compositor.mustUniform(gl, this.program, 'u_temperature'),
      },
      gradeBlend: {
        brightness: WebGl2Compositor.mustUniform(gl, this.blendProgram, 'u_brightness'),
        contrast: WebGl2Compositor.mustUniform(gl, this.blendProgram, 'u_contrast'),
        saturation: WebGl2Compositor.mustUniform(gl, this.blendProgram, 'u_saturation'),
        temperature: WebGl2Compositor.mustUniform(gl, this.blendProgram, 'u_temperature'),
      },
      curveMain: WebGl2Compositor.mustUniform(gl, this.program, 'u_curve'),
      curveBlend: WebGl2Compositor.mustUniform(gl, this.blendProgram, 'u_curve'),
      lutMain: {
        tex: WebGl2Compositor.mustUniform(gl, this.program, 'u_lut'),
        size: WebGl2Compositor.mustUniform(gl, this.program, 'u_lutSize'),
        strength: WebGl2Compositor.mustUniform(gl, this.program, 'u_lutStrength'),
        has: WebGl2Compositor.mustUniform(gl, this.program, 'u_hasLut'),
      },
      lutBlend: {
        tex: WebGl2Compositor.mustUniform(gl, this.blendProgram, 'u_lut'),
        size: WebGl2Compositor.mustUniform(gl, this.blendProgram, 'u_lutSize'),
        strength: WebGl2Compositor.mustUniform(gl, this.blendProgram, 'u_lutStrength'),
        has: WebGl2Compositor.mustUniform(gl, this.blendProgram, 'u_hasLut'),
      },
      maskMain: WebGl2Compositor.maskUniforms(gl, this.program),
      maskBlend: WebGl2Compositor.maskUniforms(gl, this.blendProgram),
    };
    canvas.width = width;
    canvas.height = height;
    // 刻意**不**开 UNPACK_FLIP_Y_WEBGL：着色器用 v_uv = a_pos（v=0 = 图像顶行）。
    // 开启会让 VideoFrame / ImageBitmap / Canvas 三类源朝向不一致。
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.disable(gl.DEPTH_TEST);
  }

  private static mustUniform(
    gl: WebGL2RenderingContext,
    program: WebGLProgram,
    name: string,
  ): WebGLUniformLocation {
    const location = gl.getUniformLocation(program, name);
    if (location === null) throw new Error(`compositor: 找不到 uniform ${name}`);
    return location;
  }

  private static createQuad(gl: WebGL2RenderingContext): WebGLBuffer {
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error('compositor: createBuffer 失败');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    // 两个三角形组成全屏 quad（a_pos ∈ [0,1]^2）
    const vertices = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    return buffer;
  }

  resize(width: number, height: number): void {
    if (this.disposed) return;
    if (width === this.width && height === this.height) return;
    const gl = this.gl;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    gl.deleteFramebuffer(this.fboMain);
    gl.deleteTexture(this.textureMain);
    gl.deleteFramebuffer(this.fboBack);
    gl.deleteTexture(this.textureBack);
    const main = createFramebuffer(gl, width, height);
    this.fboMain = main.fbo;
    this.textureMain = main.texture;
    const back = createFramebuffer(gl, width, height);
    this.fboBack = back.fbo;
    this.textureBack = back.texture;
  }

  beginFrame(_projectFrame: Frame, _clear: boolean): void {
    if (this.disposed) return;
    this.layers = [];
    this.seq = 0;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboMain);
    gl.viewport(0, 0, this.width, this.height);
    /**
     * **无条件整张清屏**（不再看 `clear` 参数）。
     *
     * 2026-10-22：用户报"空内容/隐藏轨道时预览花屏（黑白噪点、横条纹）"。
     * 根因是这条清屏被 `clear` 参数控制，而"有没有内容"和"要不要清"是两件事——
     * 空内容时恰恰**更**需要清（上一帧的像素还在 FBO 里）。任何一个调用方传了
     * `clear=false`，或者某条路径压根没走 beginFrame，FBO 里就是上一帧/未初始化内容，
     * 上屏后表现为花屏。清一次全屏填充的成本是每帧 0.05ms 级，远小于任何一次误判。
     *
     * 透明背景时 alpha 必须是 0：否则 PNG 序列全是不透明黑，等于没做透明通道。
     */
    gl.clearColor(this.background.r, this.background.g, this.background.b, this.transparent ? 0 : 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    // 颜色按 src alpha 混合；alpha 通道始终保持 1（项目背景不透明，避免 captureFrame 读出 191 这类脏 alpha）
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  drawLayer(
    source: LayerSource,
    transform: Transform,
    placement: LayerPlacement,
    grade?: ColorGrade,
    curve?: CurveParams | null,
    lut?: LutLayer | null,
    mask?: MaskParams | null,
  ): void {
    if (this.disposed) return;
    this.seq += 1;
    this.layers.push({
      source,
      transform,
      placement,
      grade: grade ?? NEUTRAL_GRADE,
      curve: curve ?? null,
      lut: lut ?? null,
      mask: mask ?? null,
      seq: this.seq,
    });
  }

  endFrame(): void {
    if (this.disposed) return;
    const started = performance.now();
    const gl = this.gl;
    const ordered = [...this.layers].sort(compareLayers);
    /**
     * 零图层时**再清一次**（保险）。
     *
     * `beginFrame` 已经清过，但如果某一帧的层全部因为"源失效"被跳过，
     * 或者上层提前 return 跳过了 beginFrame，FBO 里就可能残留上一帧/未初始化内容 ——
     * 表现是"该黑的地方出现花屏"（用户报过：片段放在后面时，前面播放出来是乱码）。
     * 多一次 clear 的代价是每帧一次全屏填充，只有零图层时才走，可以忽略。
     */
    if (ordered.length === 0) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboMain);
      gl.clearColor(this.background.r, this.background.g, this.background.b, this.transparent ? 0 : 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    const skippedBefore = this.skippedLayers;
    for (const layer of ordered) {
      this.drawOne(layer);
    }
    /**
     * **所有层都被跳过**（源失效 / 尺寸为 0 / 解码失败）时再清一次。
     *
     * `ordered.length > 0` 但每一层都被 `drawOne` 拒绝，是最容易漏的一格：
     * 层数组非空，看着"有内容"，实际一个像素都没画。此时 FBO 里若残留着上一次的
     * 内容（比如同一帧被重复提交、或 beginFrame 被跳过），上屏就是脏画面。
     * 判据用"本次跳过数 == 层数"，不额外加状态。
     */
    if (ordered.length > 0 && this.skippedLayers - skippedBefore >= ordered.length) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboMain);
      gl.clearColor(this.background.r, this.background.g, this.background.b, this.transparent ? 0 : 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    // 上屏：把同一张离屏缓冲 blit 到默认帧缓冲
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboMain);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(
      0,
      0,
      this.width,
      this.height,
      0,
      0,
      this.width,
      this.height,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // 记录 GL 错误：画面黑但层数正常时，这一行能区分"GL 拒绝"与"数据本身是全黑"
    this.lastGlError = gl.getError();
    this.lastMs = performance.now() - started;
    this.totalMs += this.lastMs;
    this.frameCount += 1;
    this.lastLayerCount = ordered.length;
  }

  private drawOne(layer: LayerEntry): void {
    const gl = this.gl;
    const { width: sourceWidth, height: sourceHeight } = sourceSize(layer.source);
    // **必须在任何 GL 调用之前判断**：失效层（VideoFrame 已 close → displayWidth=0）
    // 若先 texImage2D 再检查，会污染 GL 错误状态（GL_INVALID_OPERATION 1282），
    // 且调用方仍会继续 drawArrays，把上一次的旧纹理画上去。
    if (sourceWidth <= 0 || sourceHeight <= 0) {
      this.skippedLayers += 1;
      return;
    }
    // 旋转后的画面按"旋转后的画幅"重新 contain（16:9 转 90° → 9:16 贴满高度、左右留黑），
    // 而不是把 9:16 拉伸回 16:9 填满画布（那样人脸会横向拉长 1.78 倍）
    const quad = quadForRotation(
      sourceWidth,
      sourceHeight,
      this.width,
      this.height,
      layer.transform.rotation,
    );
    const scale = layer.transform.scale;
    const drawWidth = quad.width * scale;
    const drawHeight = quad.height * scale;
    const matrix = rotationMatrix(layer.transform.rotation);
    const flip = flipVector(layer.transform.flipX, layer.transform.flipY);
    const mode = blendModeCode(layer.transform.blendMode);

    if (mode !== 0) {
      // 2 pass：先把累积结果拷到 back，再用混合 shader 采样 back 作为背景
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboMain);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fboBack);
      gl.blitFramebuffer(
        0,
        0,
        this.width,
        this.height,
        0,
        0,
        this.width,
        this.height,
        gl.COLOR_BUFFER_BIT,
        gl.NEAREST,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboMain);
      gl.useProgram(this.blendProgram);
      this.uploadLayerTexture(layer.source, sourceWidth, sourceHeight);
      gl.uniform2f(this.blendCanvas, this.width, this.height);
      gl.uniform2f(this.blendCenter, layer.transform.x, layer.transform.y);
      gl.uniform2f(this.blendSize, drawWidth, drawHeight);
      gl.uniformMatrix2fv(this.uniforms.rotateBlend, false, matrix);
      gl.uniform2f(this.uniforms.flipBlend, flip[0], flip[1]);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.textureBack);
      gl.uniform1i(this.uniforms.bg, 2);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.layerTexture);
      gl.uniform1i(this.uniforms.fg, 1);
      gl.uniform1f(this.uniforms.opacity, layer.transform.opacity);
      gl.uniform1i(this.uniforms.mode, mode);
      this.setGrade(this.uniforms.gradeBlend, layer.grade);
      this.setCurve(this.uniforms.curveBlend, layer.curve);
      this.bindLut(this.uniforms.lutBlend, layer.lut);
      this.bindMask(this.uniforms.maskBlend, layer.mask);
      this.bindQuad(this.aPosBlend);
      gl.disable(gl.BLEND);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      return;
    }

    gl.useProgram(this.program);
    this.uploadLayerTexture(layer.source, sourceWidth, sourceHeight);
    gl.uniform2f(this.uniforms.canvas, this.width, this.height);
    gl.uniform2f(this.uniforms.center, layer.transform.x, layer.transform.y);
    gl.uniform2f(this.uniforms.size, drawWidth, drawHeight);
    gl.uniformMatrix2fv(this.uniforms.rotateMain, false, matrix);
    gl.uniform2f(this.uniforms.flipMain, flip[0], flip[1]);
    gl.uniform1f(this.uniforms.opacity, layer.transform.opacity);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.layerTexture);
    gl.uniform1i(this.uniforms.tex, 0);
    this.setGrade(this.uniforms.gradeMain, layer.grade);
    this.setCurve(this.uniforms.curveMain, layer.curve);
    this.bindLut(this.uniforms.lutMain, layer.lut);
    this.bindMask(this.uniforms.maskMain, layer.mask);
    this.bindQuad(this.aPosMain);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** 把 -100..100 的滑块值归一化后写进 uniform（中性值 0/1/1/0 = 恒等）。 */
  /** 曲线 uniform：恒等时写默认值（0.25/0.25/0.75/0.75），着色器里等价于 y=x。 */
  private setCurve(location: WebGLUniformLocation, curve: CurveParams | null): void {
    const gl = this.gl;
    if (curve === null) {
      gl.uniform4f(location, 0.25, 0.25, 0.75, 0.75);
      return;
    }
    gl.uniform4f(location, curve.x1, curve.y1, curve.x2, curve.y2);
  }

  private static maskUniforms(gl: WebGL2RenderingContext, program: WebGLProgram): MaskUniforms {
    return {
      rect: WebGl2Compositor.mustUniform(gl, program, 'u_mask'),
      feather: WebGl2Compositor.mustUniform(gl, program, 'u_maskFeather'),
      shape: WebGl2Compositor.mustUniform(gl, program, 'u_maskShape'),
      invert: WebGl2Compositor.mustUniform(gl, program, 'u_maskInvert'),
      on: WebGl2Compositor.mustUniform(gl, program, 'u_maskOn'),
    };
  }

  /** 绑定蒙版（没有就关掉）。 */
  private bindMask(uniforms: MaskUniforms, mask: MaskParams | null): void {
    const gl = this.gl;
    if (mask === null) {
      gl.uniform1i(uniforms.on, 0);
      return;
    }
    gl.uniform4f(uniforms.rect, mask.x, mask.y, mask.w, mask.h);
    gl.uniform1f(uniforms.feather, mask.feather);
    gl.uniform1i(uniforms.shape, mask.shape === 'ellipse' ? 1 : 0);
    gl.uniform1i(uniforms.invert, mask.invert ? 1 : 0);
    gl.uniform1i(uniforms.on, 1);
  }

  /** 1×1×1 的占位 3D 纹理（全黑，不参与计算，只为了 sampler3D 合法）。 */
  private static createDummyLut(gl: WebGL2RenderingContext): WebGLTexture {
    const texture = gl.createTexture();
    if (texture === null) throw new Error('compositor: 无法创建 LUT 纹理');
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    return texture;
  }

  /** 按 key 缓存上传 LUT（RGBA8：8bit 在 33³ 下误差 < 0.5/255，且不依赖浮点过滤扩展）。 */
  private lutTextureFor(lut: LutLayer): WebGLTexture {
    const cached = this.lutTextures.get(lut.key);
    if (cached !== undefined) return cached;
    const gl = this.gl;
    const size = lut.size;
    const cells = size * size * size;
    const bytes = new Uint8Array(cells * 4);
    for (let i = 0; i < cells; i += 1) {
      const src = i * 3;
      const dst = i * 4;
      bytes[dst] = Math.round(Math.min(1, Math.max(0, lut.data[src] ?? 0)) * 255);
      bytes[dst + 1] = Math.round(Math.min(1, Math.max(0, lut.data[src + 1] ?? 0)) * 255);
      bytes[dst + 2] = Math.round(Math.min(1, Math.max(0, lut.data[src + 2] ?? 0)) * 255);
      bytes[dst + 3] = 255;
    }
    const texture = gl.createTexture();
    if (texture === null) return this.lutDummy;
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, size, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    // 缓存上限：正常只有几个 LUT，多了就清（避免反复导入把显存占满）
    if (this.lutTextures.size > 6) {
      for (const old of this.lutTextures.values()) gl.deleteTexture(old);
      this.lutTextures.clear();
    }
    this.lutTextures.set(lut.key, texture);
    return texture;
  }

  /** 绑定 LUT（没有就绑占位纹理 + has=0）。 */
  private bindLut(uniforms: LutUniforms, lut: LutLayer | null): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_3D, lut === null ? this.lutDummy : this.lutTextureFor(lut));
    gl.uniform1i(uniforms.tex, 3);
    gl.uniform1f(uniforms.size, lut === null ? 2 : lut.size);
    gl.uniform1f(uniforms.strength, lut === null ? 1 : lut.strength);
    gl.uniform1i(uniforms.has, lut === null ? 0 : 1);
  }

  private setGrade(grade: GradeUniforms, value: ColorGrade): void {
    const gl = this.gl;
    gl.uniform1f(grade.brightness, value.brightness / 200);
    gl.uniform1f(grade.contrast, 1 + value.contrast / 100);
    gl.uniform1f(grade.saturation, 1 + value.saturation / 100);
    gl.uniform1f(grade.temperature, value.temperature / 100);
  }

  private bindQuad(attribLocation: number): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(attribLocation);
    gl.vertexAttribPointer(attribLocation, 2, gl.FLOAT, false, 0, 0);
  }

  private uploadLayerTexture(source: LayerSource, width: number, height: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.layerTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      source as unknown as TexImageSource,
    );
    // 兜底：正常路径已在 drawOne 开头拦截，这里只防御未来新增的调用方
    if (width <= 0 || height <= 0) {
      this.skippedLayers += 1;
    }
  }

  async captureFrame(): Promise<ImageBitmap> {
    if (this.disposed) throw new Error('compositor: 已释放');
    const gl = this.gl;
    const pixels = new Uint8Array(this.width * this.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboMain);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // GL 原点在左下，ImageData 原点在左上 → 逐行翻转
    const rowBytes = this.width * 4;
    const flipped = new Uint8ClampedArray(this.width * this.height * 4);
    for (let y = 0; y < this.height; y += 1) {
      const srcStart = (this.height - 1 - y) * rowBytes;
      flipped.set(pixels.subarray(srcStart, srcStart + rowBytes), y * rowBytes);
    }
    const imageData = new ImageData(flipped, this.width, this.height);
    return createImageBitmap(imageData);
  }

  stats(): CompositorStats {
    return {
      frames: this.frameCount,
      lastEndFrameMs: this.lastMs,
      avgEndFrameMs: this.frameCount === 0 ? 0 : this.totalMs / this.frameCount,
      lastLayerCount: this.lastLayerCount,
      lastGlError: this.lastGlError,
      skippedLayers: this.skippedLayers,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    gl.deleteFramebuffer(this.fboMain);
    gl.deleteTexture(this.textureMain);
    gl.deleteFramebuffer(this.fboBack);
    gl.deleteTexture(this.textureBack);
    gl.deleteTexture(this.layerTexture);
    gl.deleteBuffer(this.quad);
    gl.deleteProgram(this.program);
    gl.deleteProgram(this.blendProgram);
  }
}

/* ---------------- Canvas2D 降级实现 ---------------- */

class Canvas2dCompositor implements Compositor {
  readonly kind: CompositorKind = 'canvas2d';
  readonly canvas: HTMLCanvasElement;
  width: number;
  height: number;

  private readonly context: CanvasRenderingContext2D;
  private readonly buffer: HTMLCanvasElement;
  private readonly bufferContext: CanvasRenderingContext2D;
  private readonly background: { r: number; g: number; b: number };
  /** 透明背景：清屏 alpha=0（仅 PNG 序列导出用）。 */
  private readonly transparent: boolean;

  private layers: LayerEntry[] = [];
  private seq = 0;
  private frameCount = 0;
  private lastMs = 0;
  private totalMs = 0;
  private lastLayerCount = 0;
  private readonly lastGlError = 0; // Canvas2D 降级路径没有 GL 错误
  private skippedLayers = 0;
  private disposed = false;

  constructor(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    background: { r: number; g: number; b: number },
    transparent = false,
  ) {
    const context = canvas.getContext('2d', { alpha: transparent });
    if (!context) throw new Error('compositor: Canvas2D 不可用');
    this.context = context;
    this.canvas = canvas;
    this.width = width;
    this.height = height;
    this.background = background;
    this.transparent = transparent;
    canvas.width = width;
    canvas.height = height;
    this.buffer = document.createElement('canvas');
    this.buffer.width = width;
    this.buffer.height = height;
    const bufferContext = this.buffer.getContext('2d', { alpha: transparent });
    if (!bufferContext) throw new Error('compositor: Canvas2D 离屏缓冲不可用');
    this.bufferContext = bufferContext;
  }

  resize(width: number, height: number): void {
    if (this.disposed) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.buffer.width = width;
    this.buffer.height = height;
  }

  beginFrame(_projectFrame: Frame, _clear: boolean): void {
    if (this.disposed) return;
    this.layers = [];
    this.seq = 0;
    /** 与 WebGL 路径一致：**无条件整张清**（理由见 WebGl2Compositor.beginFrame）。 */
    const ctx = this.bufferContext;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (this.transparent) {
      // 透明背景必须 clearRect：填任何颜色都会把 alpha 写成 1
      ctx.clearRect(0, 0, this.width, this.height);
    } else {
      ctx.fillStyle = `rgb(${Math.round(this.background.r * 255)}, ${Math.round(
        this.background.g * 255,
      )}, ${Math.round(this.background.b * 255)})`;
      ctx.fillRect(0, 0, this.width, this.height);
    }
  }

  drawLayer(
    source: LayerSource,
    transform: Transform,
    placement: LayerPlacement,
    grade?: ColorGrade,
    curve?: CurveParams | null,
    lut?: LutLayer | null,
    mask?: MaskParams | null,
  ): void {
    if (this.disposed) return;
    this.seq += 1;
    this.layers.push({
      source,
      transform,
      placement,
      grade: grade ?? NEUTRAL_GRADE,
      curve: curve ?? null,
      lut: lut ?? null,
      mask: mask ?? null,
      seq: this.seq,
    });
  }

  endFrame(): void {
    if (this.disposed) return;
    const started = performance.now();
    const ctx = this.bufferContext;
    const ordered = [...this.layers].sort(compareLayers);
    const skippedBefore = this.skippedLayers;
    for (const layer of ordered) {
      this.drawOne(ctx, layer);
    }
    // 所有层都被跳过 → 重铺一次底色（与 WebGL 路径同一判据，理由见那边注释）
    if (ordered.length > 0 && this.skippedLayers - skippedBefore >= ordered.length && !this.transparent) {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = `rgb(${Math.round(this.background.r * 255)}, ${Math.round(
        this.background.g * 255,
      )}, ${Math.round(this.background.b * 255)})`;
      ctx.fillRect(0, 0, this.width, this.height);
    }
    // 上屏：把同一张离屏缓冲整张拷到可见 canvas（不重绘任何 layer）
    const visible = this.context;
    visible.globalAlpha = 1;
    visible.globalCompositeOperation = 'source-over';
    visible.drawImage(this.buffer, 0, 0);
    this.lastMs = performance.now() - started;
    this.totalMs += this.lastMs;
    this.frameCount += 1;
    this.lastLayerCount = ordered.length;
  }

  private drawOne(ctx: CanvasRenderingContext2D, layer: LayerEntry): void {
    const { width: sourceWidth, height: sourceHeight } = sourceSize(layer.source);
    if (sourceWidth <= 0 || sourceHeight <= 0) {
      // 与 WebGL 路径一致：层源失效时跳过该层，不打断整帧
      this.skippedLayers += 1;
      return;
    }
    /**
     * 2D 降级：几何变换交给 canvas 变换矩阵（与 GL 路径**逐字对应**）。
     *
     * 用的是 `quadForRotation`（**旋转之前**的矩形）：先按它 drawImage，再把整个矩形转过去，
     * 结果正好是旋转后的 contain 尺寸。顺序和 GL 那边一模一样，两条路径才不会一个变形一个不变。
     */
    const quad = quadForRotation(
      sourceWidth,
      sourceHeight,
      this.width,
      this.height,
      layer.transform.rotation,
    );
    const drawWidth = quad.width * layer.transform.scale;
    const drawHeight = quad.height * layer.transform.scale;
    const centerX = this.width / 2 + layer.transform.x;
    const centerY = this.height / 2 + layer.transform.y;
    ctx.save();
    ctx.globalAlpha = Math.min(Math.max(layer.transform.opacity, 0), 1);
    ctx.globalCompositeOperation = this.toCompositeOperation(layer.transform.blendMode);
    // canvas 的 rotate 正方向就是屏幕上顺时针，与 GL 路径的 mat2 一致
    ctx.translate(centerX, centerY);
    ctx.rotate((normalizeRotation(layer.transform.rotation) * Math.PI) / 180);
    ctx.scale(layer.transform.flipX ? -1 : 1, layer.transform.flipY ? -1 : 1);
    ctx.translate(-centerX, -centerY);
    // 2D 降级路径用 canvas filter 近似同一套调色（WebGL2 不可用时才会走到这里）
    if (layer.curve !== null && !isNeutralCurve(layer.curve)) {
      // 2D 降级没有着色器：先画到临时画布，再按 256 项 LUT 逐像素映射。
      // 只在"有曲线"时走这条慢路径，且只在 WebGL2 不可用时才会到这里。
      this.applyCurveFallback(layer);
      return;
    }
    if (!isNeutralGrade(layer.grade)) {
      const { brightness, contrast, saturation, temperature } = layer.grade;
      const warm = temperature >= 0 ? `sepia(${temperature / 400})` : `hue-rotate(${temperature / 8}deg)`;
      ctx.filter = `brightness(${1 + brightness / 200}) contrast(${1 + contrast / 100}) saturate(${
        1 + saturation / 100
      }) ${warm}`;
    }
    ctx.drawImage(
      layer.source as unknown as CanvasImageSource,
      centerX - drawWidth / 2,
      centerY - drawHeight / 2,
      drawWidth,
      drawHeight,
    );
    ctx.restore();
  }

  /** 2D 降级路径的曲线实现（LUT 逐像素，慢但正确）。 */
  private applyCurveFallback(layer: LayerEntry): void {
    const curve = layer.curve;
    if (curve === null) return;
    const width = Math.max(1, Math.round(layer.transform.scale * this.width));
    const height = Math.max(1, Math.round(layer.transform.scale * this.height));
    const temp = document.createElement('canvas');
    temp.width = this.width;
    temp.height = this.height;
    const tempCtx = temp.getContext('2d', { willReadFrequently: true });
    if (tempCtx === null) return;
    tempCtx.drawImage(layer.source as CanvasImageSource, 0, 0, width, height);
    const data = tempCtx.getImageData(0, 0, temp.width, temp.height);
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i += 1) {
      lut[i] = Math.round(applyCurveValue(i / 255, curve) * 255);
    }
    const pixels = data.data;
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = lut[pixels[i] ?? 0] ?? 0;
      pixels[i + 1] = lut[pixels[i + 1] ?? 0] ?? 0;
      pixels[i + 2] = lut[pixels[i + 2] ?? 0] ?? 0;
    }
    tempCtx.putImageData(data, 0, 0);
    const ctx = this.bufferContext;
    ctx.save();
    ctx.globalAlpha = Math.min(Math.max(layer.transform.opacity, 0), 1);
    ctx.globalCompositeOperation = this.toCompositeOperation(layer.transform.blendMode);
    ctx.drawImage(temp, 0, 0);
    ctx.restore();
  }

  private toCompositeOperation(mode: BlendMode): GlobalCompositeOperation {
    if (mode === 'multiply') return 'multiply';
    if (mode === 'screen') return 'screen';
    if (mode === 'overlay') return 'overlay';
    return 'source-over';
  }

  async captureFrame(): Promise<ImageBitmap> {
    if (this.disposed) throw new Error('compositor: 已释放');
    const imageData = this.bufferContext.getImageData(0, 0, this.width, this.height);
    return createImageBitmap(imageData);
  }

  stats(): CompositorStats {
    return {
      frames: this.frameCount,
      lastEndFrameMs: this.lastMs,
      avgEndFrameMs: this.frameCount === 0 ? 0 : this.totalMs / this.frameCount,
      lastLayerCount: this.lastLayerCount,
      lastGlError: this.lastGlError,
      skippedLayers: this.skippedLayers,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.layers = [];
  }
}

/* ---------------- 工厂 ---------------- */

/**
 * 创建合成器：优先 WebGL2，不可用/被强制时用 Canvas2D。
 *
 * @throws 两种实现都不可用时抛错（调用方应视为致命环境问题）。
 */
export function createCompositor(options: CreateCompositorOptions): Compositor {
  const background = parseBackground(options.background);
  const transparent = options.alpha === true;
  const canvas = options.canvas ?? document.createElement('canvas');
  if (options.prefer !== 'canvas2d') {
    try {
      return new WebGl2Compositor(canvas, options.width, options.height, background, transparent);
    } catch (error) {
      // 调用方指定了 canvas 时不能降级：同一个 canvas 取过 webgl2 context 后无法再取 2d
      if (options.prefer === 'webgl2' || options.canvas) throw error;
      return new Canvas2dCompositor(
        document.createElement('canvas'),
        options.width,
        options.height,
        background,
        transparent,
      );
    }
  }
  return new Canvas2dCompositor(canvas, options.width, options.height, background, transparent);
}

/** 测试用：判断环境是否支持 WebGL2（不创建 context）。 */
export function supportsWebGl2(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return canvas.getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

/** 供 T09 复用的自检：像素差（同源约束验收用，0–255）。 */
export function maxChannelDiff(left: ImageData, right: ImageData): number {
  if (left.width !== right.width || left.height !== right.height) {
    throw new Error('maxChannelDiff: 尺寸不一致');
  }
  let max = 0;
  for (let index = 0; index < left.data.length; index += 1) {
    const diff = Math.abs((left.data[index] ?? 0) - (right.data[index] ?? 0));
    if (diff > max) max = diff;
  }
  return max;
}

