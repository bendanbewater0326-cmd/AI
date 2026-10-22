/**
 * 宿主（Electron / WebView2 外壳）按**绝对路径**读文件的能力。
 *
 * ## 为什么需要这条通道
 *
 * 浏览器里恢复素材靠 `FileSystemFileHandle`（存在 IDB、刷新后查权限）。
 * 但桌面壳子里这件事本来更简单：**文件就在磁盘上的某个绝对路径**，
 * 直接读就行 —— 不受浏览器权限模型约束，也不会因为"权限过期"而失效。
 *
 * 宿主只需要在注入的 bridge 上提供一个方法：
 *
 * ```ts
 * window.veditorHost.readFileByPath = async (path) => {
 *   const bytes = await fs.readFile(path);           // 主进程
 *   return new Blob([bytes]);                        // 交回渲染进程
 * };
 * ```
 *
 * ## 没有宿主时
 *
 * 这个方法不存在 → `readFileViaHost` 返回 null → 恢复流程自动落到句柄路径
 * （再落到目录扫描，再落到手动重链）。**不需要任何分支判断散在业务代码里。**
 */
import type { Asset } from '../core/types';

/** 宿主 bridge 的最小契约（只声明我们用到的那一条）。 */
interface HostFileBridge {
  readFileByPath?: (path: string) => Promise<Blob | null>;
}

/**
 * 取宿主 bridge（不存在返回 null）。
 *
 * **必须判 `typeof window`**：这个模块也会在 Node（单测、构建期脚本）里被加载，
 * 直接读 `window.veditorHost` 会抛 `ReferenceError: window is not defined` ——
 * 而调用方只想知道"能不能按路径读"，不该为此崩掉整条恢复流程。
 */
function hostBridge(): HostFileBridge | null {
  if (typeof window === 'undefined') return null;
  const host = (window as unknown as { veditorHost?: HostFileBridge }).veditorHost;
  return host !== null && host !== undefined && typeof host.readFileByPath === 'function' ? host : null;
}

/** 当前环境是否支持"按路径读文件"（Electron 外壳装了 bridge 才有）。 */
export function hasHostFileAccess(): boolean {
  return hostBridge() !== null;
}

/**
 * 按绝对路径读一个文件；读不到返回 null。
 *
 * 返回 `File` 而不是 `Blob`：`relinkAssetFromFile` 需要文件名（匹配打分要用），
 * 而路径的末段就是文件名。
 */
export async function readFileViaHost(path: string): Promise<File | null> {
  const bridge = hostBridge();
  if (bridge === null || bridge.readFileByPath === undefined) return null;
  try {
    const blob = await bridge.readFileByPath(path);
    if (blob === null) return null;
    const name = path.split(/[\\/]/).pop() ?? 'asset.mp4';
    return new File([blob], name, { type: blob.type || 'video/mp4' });
  } catch {
    // 文件被删/路径失效：交给下一层
    return null;
  }
}

/** 该素材有没有可用的绝对路径（Electron 侧才可能有）。 */
export function hostPathOf(asset: Asset): string | null {
  const path = asset.sourcePath;
  if (typeof path !== 'string' || path === '') return null;
  // 相对路径（浏览器 `webkitRelativePath`）对宿主没意义，只认绝对路径
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? path : null;
}
