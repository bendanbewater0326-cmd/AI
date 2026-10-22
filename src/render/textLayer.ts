/**
 * 文本层渲染（R-034）：把 `TextContent` 画成一张**项目分辨率**的透明底 canvas。
 *
 * ## 为什么画整张画布而不是"紧贴文字的小图"
 *
 * 合成器的 `fitSize` 会把任意源按 contain 缩放进项目画面。如果给小图，
 * 文字会被放大到铺满画面（字号立刻失真）。画成同尺寸透明底图，缩放恒等，
 * 文字的位置/字号就是用户设定值，预览与导出也完全一致。
 *
 * ## 缓存
 *
 * 同一段文字每帧都重画会让 4K 工程掉帧。按「尺寸 + 内容」缓存，
 * 只在内容/样式/分辨率变化时重画；上限 8 张（正常工程不会同时有 8 段不同文字在播）。
 */
import type { TextContent } from '../core/types';

const CACHE_LIMIT = 8;
const cache = new Map<string, HTMLCanvasElement>();

/** 清缓存（工程分辨率变化 / 测试用）。 */
export function clearTextLayerCache(): void {
  cache.clear();
}

function keyOf(text: TextContent, width: number, height: number): string {
  return `${width}x${height}|${text.content}|${text.fontSize}|${text.color}|${text.align}|${text.x}|${text.y}|${text.background}`;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** 把文本画进项目尺寸的透明画布（带缓存）。 */
export function renderTextLayer(text: TextContent, width: number, height: number): HTMLCanvasElement {
  const key = keyOf(text, width, height);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext('2d');
  if (ctx === null) return canvas;

  const fontSize = Math.max(8, text.fontSize);
  const lineHeight = fontSize * 1.28;
  const lines = text.content.split('\n');
  ctx.font = `${fontSize}px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = text.align;

  const anchorX = width / 2 + text.x;
  const blockHeight = lines.length * lineHeight;
  const firstY = height / 2 + text.y - blockHeight / 2 + lineHeight / 2;

  // 底衬：按最长行测宽，左右各留 0.45 字号的边距
  if (text.background.trim() !== '') {
    let maxWidth = 0;
    for (const line of lines) maxWidth = Math.max(maxWidth, ctx.measureText(line).width);
    const padX = fontSize * 0.45;
    const padY = fontSize * 0.28;
    const boxWidth = maxWidth + padX * 2;
    const boxHeight = blockHeight + padY * 2;
    const boxLeft =
      text.align === 'center' ? anchorX - boxWidth / 2 : text.align === 'right' ? anchorX - boxWidth : anchorX;
    ctx.fillStyle = text.background;
    roundRect(ctx, boxLeft, firstY - lineHeight / 2 - padY, boxWidth, boxHeight, fontSize * 0.18);
    ctx.fill();
  }

  ctx.fillStyle = text.color;
  lines.forEach((line, index) => {
    ctx.fillText(line, anchorX, firstY + index * lineHeight);
  });

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, canvas);
  return canvas;
}
