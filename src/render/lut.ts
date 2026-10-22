/**
 * 3D LUT（R-058）：解析 `.cube` 并交给着色器做三线性插值。
 *
 * ## 为什么用 3D 纹理而不是"自己插值"
 *
 * LUT 的本质是"RGB → RGB 的三维查表"。CPU 上做三线性插值要每像素 8 次采样 + 加权，
 * 4K 一帧 800 万像素直接卡死；GPU 的 `sampler3D` + LINEAR 过滤**硬件就是干这个的**，
 * 一次采样搞定。所以这里只负责"把 .cube 变成 3D 纹理"，插值交给 GPU。
 *
 * ## 精度取舍
 *
 * 纹理用 `RGBA8` 而不是浮点：8bit 在 33³ 的格点精度下误差 < 0.5/255，肉眼不可见；
 * 而浮点纹理在部分设备上不支持 LINEAR 过滤（`OES_texture_float_linear`），
 * 会让 LUT 变成"块状"。**宁可少一点精度，也不要设备相关的不一致**。
 *
 * ## 边界
 *
 * 只支持 `LUT_3D_SIZE`（不支持 1D LUT）；`DOMAIN_MIN/MAX` 必须是 0..1（超出的按 0..1 处理）；
 * 明确**不做色彩空间转换**（sRGB↔P3 之类需要矩阵 + 传递函数，是另一件事）。
 */
import type { Clip } from '../core/types';
import { fail, ok } from '../core/types';
import type { Result } from '../core/types';

export const LUT_EFFECT = 'lut';
/** 允许的最大格点边长（64³ = 262144 个格点，纹理 1MB）。 */
export const MAX_LUT_SIZE = 64;
/** 允许的最大 .cube 文本长度（2MB，防止把工程文件撑爆）。 */
export const MAX_CUBE_CHARS = 2_000_000;

export interface LutData {
  size: number;
  title: string;
  /** `size³ * 3` 个 0..1 的浮点（RGB 顺序，R 变化最快）。 */
  data: Float32Array;
}

/** 解析 `.cube`。失败返回可读原因。 */
export function parseCube(text: string): Result<LutData> {
  if (text.length > MAX_CUBE_CHARS) {
    return fail({ code: 'E_INVALID_PROJECT', message: 'LUT 文件过大（>2MB）', at: Date.now() });
  }
  let size = 0;
  let title = '';
  const values: number[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const upper = line.toUpperCase();
    if (upper.startsWith('TITLE')) {
      const match = /TITLE\s+"?(.*?)"?\s*$/i.exec(line);
      title = match?.[1] ?? '';
      continue;
    }
    if (upper.startsWith('LUT_3D_SIZE')) {
      const match = /LUT_3D_SIZE\s+(\d+)/i.exec(line);
      size = match === null ? 0 : Number(match[1]);
      continue;
    }
    // 1D LUT / 域声明：明确不支持或忽略
    if (upper.startsWith('LUT_1D_SIZE')) {
      return fail({ code: 'E_INVALID_PROJECT', message: '只支持 3D LUT（LUT_3D_SIZE）', at: Date.now() });
    }
    if (upper.startsWith('DOMAIN_MIN') || upper.startsWith('DOMAIN_MAX')) continue;

    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const r = Number(parts[0]);
    const g = Number(parts[1]);
    const b = Number(parts[2]);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) continue;
    values.push(r, g, b);
  }

  if (!Number.isInteger(size) || size < 2 || size > MAX_LUT_SIZE) {
    return fail({
      code: 'E_INVALID_PROJECT',
      message: `LUT 尺寸不合法（需要 2–${MAX_LUT_SIZE}，收到 ${size || '未声明'}）`,
      at: Date.now(),
    });
  }
  const expected = size * size * size * 3;
  if (values.length !== expected) {
    return fail({
      code: 'E_INVALID_PROJECT',
      message: `LUT 数据量不符：需要 ${expected} 个数值，实际 ${values.length}`,
      at: Date.now(),
    });
  }
  return ok({ size, title, data: Float32Array.from(values) });
}

/** 生成一个"恒等"LUT（测试与占位用）。 */
export function identityCube(size = 2): string {
  const lines: string[] = [`TITLE "identity"`, `LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        const denom = Math.max(1, size - 1);
        lines.push(`${(r / denom).toFixed(6)} ${(g / denom).toFixed(6)} ${(b / denom).toFixed(6)}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

export interface LutEffect {
  cube: string;
  strength: number;
}

/** 从片段的 effects 里取 LUT（没有/被禁用返回 null）。 */
export function lutOf(clip: Clip): LutEffect | null {
  const effect = clip.effects.find((item) => item.type === LUT_EFFECT && item.enabled);
  if (effect === undefined) return null;
  const cube = effect.params['cube'];
  if (typeof cube !== 'string' || cube === '') return null;
  const rawStrength = effect.params['strength'];
  const strength = typeof rawStrength === 'number' ? Math.min(1, Math.max(0, rawStrength)) : 1;
  return { cube, strength };
}

/** 解析缓存：同一份 cube 文本只解析一次（33³ 是 35937 行，逐帧解析会卡死）。 */
const parseCache = new Map<string, LutData>();

/** 带缓存的解析（key 用文本长度 + 前 64 字符做粗指纹）。 */
export function parseCubeCached(cube: string): LutData | null {
  const key = `${cube.length}:${cube.slice(0, 64)}`;
  const cached = parseCache.get(key);
  if (cached !== undefined) return cached;
  const parsed = parseCube(cube);
  if (!parsed.ok) return null;
  // 缓存上限：LUT 通常只有几个，但防止长时间编辑积累
  if (parseCache.size > 8) parseCache.clear();
  parseCache.set(key, parsed.value);
  return parsed.value;
}
