/**
 * 拖放协议（左侧素材库 → 时间轴）。
 *
 * ## 为什么用自定义 MIME，而不是 `text/plain`
 *
 * 素材栏已经有一个**整窗 drop 监听**（把文件拖进窗口就导入，`ui/AssetPanel`）。
 * 如果内部拖拽也塞 `text/plain` 或 `Files`，两者会打架：拖一张素材卡会同时
 * 触发"导入文件"和"上轨"。用一个自己的 MIME，两边各认各的，互不干扰。
 *
 * 顺带一个好处：`dataTransfer.types` 里能看到这个 MIME，于是"能不能接这次拖拽"
 * 是一眼可判的（dragover 时不能读数据，只能读 types —— 这是 HTML5 拖放的硬规则）。
 */
export const ASSET_MIME = 'application/x-veditor-asset';

/**
 * 正在拖的素材 id（页面内变量）。
 *
 * **为什么需要它**：`dragover` 阶段浏览器不允许读 `getData()`（安全限制，返回空串），
 * 而落点预览要提前知道"这段素材多长"才能画出 ghost 的宽度。
 * 同页面内的拖拽用一个模块变量传递是标准做法（Electron/WebView2 同样适用）。
 * `dragend` 与 `drop` 都要清掉，否则会残留上一次的 id。
 */
let draggingAssetId: string | null = null;

export function getDraggingAssetId(): string | null {
  return draggingAssetId;
}

export function clearDraggingAsset(): void {
  draggingAssetId = null;
}

/** 拖起一张素材卡。 */
export function setAssetDrag(dataTransfer: DataTransfer | null, assetId: string): void {
  draggingAssetId = assetId;
  if (dataTransfer === null) return;
  dataTransfer.setData(ASSET_MIME, assetId);
  // 有些浏览器（含 WebView2 的某些版本）在 `types` 里不认纯自定义 MIME，
  // 补一个 text/plain 的**同前缀标记**做兜底；读取时优先认自定义 MIME。
  dataTransfer.setData('text/plain', `veditor-asset:${assetId}`);
  dataTransfer.effectAllowed = 'copy';
}

/** 这次拖拽是不是素材卡（dragover 阶段只能用 types 判断）。 */
export function hasAssetDrag(dataTransfer: DataTransfer | null): boolean {
  if (dataTransfer === null) return false;
  return Array.from(dataTransfer.types).includes(ASSET_MIME);
}

/** 读出被拖的素材 id（drop 阶段才能读数据）。 */
export function readAssetDrag(dataTransfer: DataTransfer | null): string | null {
  if (dataTransfer === null) return null;
  const direct = dataTransfer.getData(ASSET_MIME);
  if (direct !== '') return direct;
  const fallback = dataTransfer.getData('text/plain');
  const prefix = 'veditor-asset:';
  return fallback.startsWith(prefix) ? fallback.slice(prefix.length) : null;
}
