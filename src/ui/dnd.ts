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

/* ================= 文字模板（左栏「文本」→ 时间线） ================= */

/**
 * 文字模板的 MIME。
 *
 * 与素材**分开**是必须的：两者在时间线上的落点语义完全不同 ——
 * 素材要按"目标轨 + 占用避让"落，文字**永远落文字轨**（纵向位置由规则决定，
 * 只有横向的帧号听用户的）。同一个 MIME 会让 onDrop 里长出一堆 if。
 */
export const TEXT_MIME = 'application/x-veditor-text';

/** 正在拖的模板 id（dragover 阶段读不到 getData，只能靠模块变量）。 */
let draggingTextId: string | null = null;

export function getDraggingTextId(): string | null {
  return draggingTextId;
}

export function clearDraggingText(): void {
  draggingTextId = null;
}

/** 拖起一张文字模板卡。 */
export function setTextDrag(dataTransfer: DataTransfer | null, presetId: string): void {
  draggingTextId = presetId;
  if (dataTransfer === null) return;
  dataTransfer.setData(TEXT_MIME, presetId);
  // 同素材：某些 WebView2 版本在 `types` 里不认纯自定义 MIME，补一个带前缀的 text/plain 兜底
  dataTransfer.setData('text/plain', `veditor-text:${presetId}`);
  dataTransfer.effectAllowed = 'copy';
}

/** 这次拖拽是不是文字模板（dragover 阶段只能用 types 判断）。 */
export function hasTextDrag(dataTransfer: DataTransfer | null): boolean {
  if (dataTransfer === null) return false;
  return Array.from(dataTransfer.types).includes(TEXT_MIME);
}

/** 读出被拖的模板 id（drop 阶段）。 */
export function readTextDrag(dataTransfer: DataTransfer | null): string | null {
  if (dataTransfer === null) return null;
  const direct = dataTransfer.getData(TEXT_MIME);
  if (direct !== '') return direct;
  const fallback = dataTransfer.getData('text/plain');
  const prefix = 'veditor-text:';
  return fallback.startsWith(prefix) ? fallback.slice(prefix.length) : null;
}

/* ================= 转场预设（左栏「转场」→ 时间线） ================= */

/**
 * 转场的 MIME。
 *
 * 与前两种又不一样：转场**没有自己的时间跨度**，它是"贴在某个片段某一侧"的属性，
 * 落点要先换算成"接缝附近的片段"。所以必须单独一个 MIME。
 */
export const TRANSITION_MIME = 'application/x-veditor-transition';

export interface TransitionDragPayload {
  presetId: string;
  /** 面板上当前选的时长（秒）。**拖拽时一起带过来**，否则落库用的是旧值。 */
  seconds: number;
}

let draggingTransition: TransitionDragPayload | null = null;

export function getDraggingTransition(): TransitionDragPayload | null {
  return draggingTransition;
}

export function clearDraggingTransition(): void {
  draggingTransition = null;
}

/** 拖起一张转场卡。 */
export function setTransitionDrag(
  dataTransfer: DataTransfer | null,
  presetId: string,
  seconds: number,
): void {
  draggingTransition = { presetId, seconds };
  if (dataTransfer === null) return;
  const raw = `${presetId}|${seconds}`;
  dataTransfer.setData(TRANSITION_MIME, raw);
  dataTransfer.setData('text/plain', `veditor-transition:${raw}`);
  dataTransfer.effectAllowed = 'copy';
}

export function hasTransitionDrag(dataTransfer: DataTransfer | null): boolean {
  if (dataTransfer === null) return false;
  return Array.from(dataTransfer.types).includes(TRANSITION_MIME);
}

/** 解析 `预设id|秒`（坏数据返回 null，不让一次拖拽把面板状态带崩）。 */
function parseTransition(raw: string): TransitionDragPayload | null {
  const [presetId, secondsText] = raw.split('|');
  if (presetId === undefined || presetId === '') return null;
  const seconds = Number.parseFloat(secondsText ?? '');
  return { presetId, seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 0.5 };
}

export function readTransitionDrag(dataTransfer: DataTransfer | null): TransitionDragPayload | null {
  if (dataTransfer === null) return null;
  const direct = dataTransfer.getData(TRANSITION_MIME);
  if (direct !== '') return parseTransition(direct);
  const fallback = dataTransfer.getData('text/plain');
  const prefix = 'veditor-transition:';
  return fallback.startsWith(prefix) ? parseTransition(fallback.slice(prefix.length)) : null;
}

/* ================= 画面特效（左栏「特效」→ 时间线的片段上） ================= */

/**
 * 特效的 MIME。
 *
 * 第四种独立 MIME 了，理由是落点语义又不一样：
 * 素材是"按目标轨 + 占用避让"，文字是"永远落文字轨"，转场是"贴在片段某一侧"，
 * 而特效是**整块片段**（没有时间跨度、没有侧别）。共用一个 MIME 会让 onDrop 长出一堆 if。
 */
export const EFFECT_MIME = 'application/x-veditor-effect';

/** 正在拖的特效预设 id（dragover 阶段读不到 getData，只能靠模块变量）。 */
let draggingEffectId: string | null = null;

export function getDraggingEffectId(): string | null {
  return draggingEffectId;
}

export function clearDraggingEffect(): void {
  draggingEffectId = null;
}

/** 拖起一张特效卡。 */
export function setEffectDrag(dataTransfer: DataTransfer | null, presetId: string): void {
  draggingEffectId = presetId;
  if (dataTransfer === null) return;
  dataTransfer.setData(EFFECT_MIME, presetId);
  // 同前三种：某些 WebView2 版本在 `types` 里不认纯自定义 MIME，补一个带前缀的 text/plain 兜底
  dataTransfer.setData('text/plain', `veditor-effect:${presetId}`);
  dataTransfer.effectAllowed = 'copy';
}

/** 这次拖拽是不是特效卡（dragover 阶段只能用 types 判断）。 */
export function hasEffectDrag(dataTransfer: DataTransfer | null): boolean {
  if (dataTransfer === null) return false;
  return Array.from(dataTransfer.types).includes(EFFECT_MIME);
}

/** 读出被拖的特效预设 id（drop 阶段）。 */
export function readEffectDrag(dataTransfer: DataTransfer | null): string | null {
  if (dataTransfer === null) return null;
  const direct = dataTransfer.getData(EFFECT_MIME);
  if (direct !== '') return direct;
  const fallback = dataTransfer.getData('text/plain');
  const prefix = 'veditor-effect:';
  return fallback.startsWith(prefix) ? fallback.slice(prefix.length) : null;
}
