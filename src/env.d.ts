/** 非代码文件的模块声明（esbuild 直接处理 CSS 导入，tsc 需要知道它存在）。 */
declare module '*.css';
declare module '*.svg';
declare module '*.webp';
declare module '*.png';
/** 内置音效（esbuild dataurl loader 内联，默认导出 data URL 字符串）。 */
declare module '*.m4a' {
  const dataUrl: string;
  export default dataUrl;
}

/**
 * 版本号由构建脚本注入（`scripts/build.mjs` / `scripts/dev.mjs` 的 esbuild `define`，
 * 值取自 `package.json` 的 `version`）—— 前端不再手写一份版本字符串。
 */
declare const __APP_VERSION__: string;

/**
 * `gifenc` 没有随包提供 .d.ts（也不在 DefinitelyTyped 上），这里只声明本项目用到的三个入口。
 * 参数按包内实现标注：`quantize(rgba, maxColors, opts)` → 调色板；`applyPalette(rgba, palette, format)`
 * → 每像素的索引；`GIFEncoder().writeFrame(index, w, h, opts)`。
 */
declare module 'gifenc' {
  export interface GifEncoderInstance {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      options?: {
        palette?: number[][];
        delay?: number;
        repeat?: number;
        transparent?: boolean;
        dispose?: number;
      },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
  }
  export function GIFEncoder(options?: { initialCapacity?: number; auto?: boolean }): GifEncoderInstance;
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: { format?: 'rgb565' | 'rgb444' | 'rgba4444'; oneBitAlpha?: boolean | number },
  ): number[][];
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: 'rgb565' | 'rgb444' | 'rgba4444',
  ): Uint8Array;
}
