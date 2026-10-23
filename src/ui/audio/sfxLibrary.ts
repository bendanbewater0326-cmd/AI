/**
 * 内置音效库（音频面板数据层，docs/audio-panel-plan.md §2–§3）。
 *
 * ## 物理形态（方案 C，用户拍板）
 *
 * 构建期 ffmpeg 合成的纯音频 mp4（AAC）经 esbuild base64 loader 内联进 bundle，
 * 运行时解码成 `File` 走**现有导入管线**（`media/importAssetFile`）注册为真资产：
 * media 层零改动，草稿缓存 / 刷新恢复 / 素材栏复用全部免费获得。
 * 这里绝不绕过导入管线自己造资产——那是"第二条导入路径"的经典 bug 来源。
 *
 * ## 幂等（同一份规则只写一份的口径）
 *
 * 查重与素材栏同一份依据：`Asset.hashKey`（`文件名|字节数|lastModified`）。
 * 音效字节由构建固定，`File` 显式给 `lastModified: 0`，于是 hashKey 跨会话确定——
 * 按 hashKey 找到就复用，找不到才导入。**不改 importAssetFile**（素材栏的查重
 * 也在调用方，两条路径口径一致）。
 */

import type { Asset, Result } from '../../core/types';
import { fail, makeError, ok } from '../../core/types';

import dingDataUrl from './sfx/ding.m4a';
import dongDataUrl from './sfx/dong.m4a';
import beepDataUrl from './sfx/beep.m4a';
import doubleBeepDataUrl from './sfx/double-beep.m4a';
import whooshDataUrl from './sfx/whoosh.m4a';
import riserDataUrl from './sfx/riser.m4a';
import fallDataUrl from './sfx/fall.m4a';
import clickDataUrl from './sfx/click.m4a';
import noiseSoftDataUrl from './sfx/noise-soft.m4a';
import noiseStrongDataUrl from './sfx/noise-strong.m4a';

/* ---------------- 分类 ---------------- */

export type SfxCategory = 'cue' | 'transition' | 'ambience';

/** 面板分类 chips（`all` 只用于筛选，预设表里的 category 不含它）。 */
export const SFX_CATEGORIES = [
  { key: 'all', label: '全部' },
  { key: 'cue', label: '提示音' },
  { key: 'transition', label: '转场音' },
  { key: 'ambience', label: '底噪' },
] as const;

/* ---------------- 预设表 ---------------- */

export interface SfxPreset {
  /** 稳定 id（拖拽 MIME 载荷、测试锚点用它，不是名称）。 */
  id: string;
  /** 显示名（面板卡片）。 */
  name: string;
  /** 导入成资产后的文件名（素材栏显示），带「音效·」前缀便于一眼分辨。 */
  fileName: string;
  category: SfxCategory;
  /** 标称时长（秒）；真值以探测为准，这里只用于卡片角标与 ghost 预览。 */
  seconds: number;
  /** esbuild base64 loader 注入的 data URL（`data:xxx;base64,…`）。 */
  dataUrl: string;
}

export const SFX_PRESETS: SfxPreset[] = [
  { id: 'ding', name: '叮', fileName: '音效·叮.m4a', category: 'cue', seconds: 0.6, dataUrl: dingDataUrl },
  { id: 'dong', name: '咚', fileName: '音效·咚.m4a', category: 'cue', seconds: 0.7, dataUrl: dongDataUrl },
  { id: 'beep', name: '滴·短', fileName: '音效·滴短.m4a', category: 'cue', seconds: 0.15, dataUrl: beepDataUrl },
  {
    id: 'double-beep',
    name: '双响提示',
    fileName: '音效·双响提示.m4a',
    category: 'cue',
    seconds: 0.8,
    dataUrl: doubleBeepDataUrl,
  },
  { id: 'whoosh', name: '嗖', fileName: '音效·嗖.m4a', category: 'transition', seconds: 1.2, dataUrl: whooshDataUrl },
  { id: 'riser', name: '上扬', fileName: '音效·上扬.m4a', category: 'transition', seconds: 1.0, dataUrl: riserDataUrl },
  { id: 'fall', name: '下落', fileName: '音效·下落.m4a', category: 'transition', seconds: 1.0, dataUrl: fallDataUrl },
  { id: 'click', name: '咔哒', fileName: '音效·咔哒.m4a', category: 'transition', seconds: 0.4, dataUrl: clickDataUrl },
  {
    id: 'noise-soft',
    name: '白噪·柔',
    fileName: '音效·白噪柔.m4a',
    category: 'ambience',
    seconds: 2.5,
    dataUrl: noiseSoftDataUrl,
  },
  {
    id: 'noise-strong',
    name: '白噪·强',
    fileName: '音效·白噪强.m4a',
    category: 'ambience',
    seconds: 2.5,
    dataUrl: noiseStrongDataUrl,
  },
];

export function sfxPresetById(id: string): SfxPreset | null {
  return SFX_PRESETS.find((preset) => preset.id === id) ?? null;
}

/* ---------------- 字节解码（data URL → File 的原料） ---------------- */

const byteCache = new Map<string, Uint8Array<ArrayBuffer>>();

/** data URL → 原始字节。只取 `base64,` 之后的一段：**不信任内联 mime**（esbuild 按扩展名猜，可能不对）。 */
export function dataUrlToBytes(dataUrl: string): Uint8Array<ArrayBuffer> {
  const marker = 'base64,';
  const start = dataUrl.indexOf(marker);
  if (start < 0) return new Uint8Array(0);
  const binary = atob(dataUrl.slice(start + marker.length));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function sfxBytes(preset: SfxPreset): Uint8Array<ArrayBuffer> {
  const cached = byteCache.get(preset.id);
  if (cached !== undefined) return cached;
  const bytes = dataUrlToBytes(preset.dataUrl);
  byteCache.set(preset.id, bytes);
  return bytes;
}

/**
 * 与素材栏同一份查重依据：`Asset.hashKey` = `文件名|字节数|lastModified`。
 * `File` 显式 `lastModified: 0`，音效字节构建期固定 → hashKey 跨会话确定。
 */
export function sfxHashKey(preset: SfxPreset): string {
  return `${preset.fileName}|${sfxBytes(preset).length}|0`;
}

/* ---------------- 注册为真资产（走现有导入管线） ---------------- */

/** 依赖注入（Node 单测用）；缺省接真实 store 与导入管线（动态 import：测试注入时不拉起 store 全家桶）。 */
export interface SfxEnsureDeps {
  getAssets?: () => Asset[] | Promise<Asset[]>;
  importFile?: (file: File) => Promise<Result<string>>;
}

export interface SfxEnsureResult {
  assetId: string;
  /** true = 按 hashKey 复用了已有资产，没有产生新导入。 */
  reused: boolean;
}

/** 同一预设的进行中导入（连点两次卡片只导入一次）。 */
const inFlight = new Map<string, Promise<Result<SfxEnsureResult>>>();

async function defaultGetAssets(): Promise<Asset[]> {
  const { store } = await import('../../core/store');
  return store.getDoc().assets;
}

async function defaultImportFile(file: File): Promise<Result<string>> {
  const { importAssetFile } = await import('../../media/importAsset');
  return importAssetFile(file);
}

/**
 * 确保音效预设已成为工程资产：有（按 hashKey）就复用，没有才导入。
 * 导入走 `importAssetFile` 全链路（探测 / 草稿缓存 / 自动恢复），本函数不做第二份导入逻辑。
 */
export async function ensureSfxAsset(
  preset: SfxPreset,
  deps: SfxEnsureDeps = {},
): Promise<Result<SfxEnsureResult>> {
  const getAssets = deps.getAssets ?? defaultGetAssets;
  const importFile = deps.importFile ?? defaultImportFile;

  const existing = (await getAssets()).find((asset) => asset.hashKey === sfxHashKey(preset));
  if (existing !== undefined) return ok({ assetId: existing.id, reused: true });

  const pending = inFlight.get(preset.id);
  if (pending !== undefined) return pending;

  const task = (async (): Promise<Result<SfxEnsureResult>> => {
    const bytes = sfxBytes(preset);
    // lastModified 固定为 0：hashKey 里包含它，不固定则跨会话查重失效
    const file = new File([bytes], preset.fileName, { type: 'audio/mp4', lastModified: 0 });
    const result = await importFile(file);
    if (!result.ok) return result;
    // 导入完成后从文档里按 hashKey 找回素材 id：importAssetFile 返回的是
    // "这次导入产生的 id"，而查重口径是 hashKey——两边对上，下次进来就走复用分支
    const asset = (await getAssets()).find((item) => item.hashKey === sfxHashKey(preset));
    if (asset === undefined) {
      return fail(
        makeError('E_DECODE_FAILED', '音效导入后找不到资产', `${preset.fileName}（hashKey=${sfxHashKey(preset)}）`),
      );
    }
    return ok({ assetId: asset.id, reused: false });
  })();
  inFlight.set(preset.id, task);
  try {
    return await task;
  } finally {
    inFlight.delete(preset.id);
  }
}

/* ---------------- 试听（只听不进 doc，不碰音频引擎） ---------------- */

let previewAudio: HTMLAudioElement | null = null;
let previewPresetId: string | null = null;
const objectUrls = new Map<string, string>();

/** 每个 id 一个 Blob URL（10 个小文件，会话级缓存不 revoke——revoke 时机不值得复杂化）。 */
function sfxObjectUrl(preset: SfxPreset): string {
  const cached = objectUrls.get(preset.id);
  if (cached !== undefined) return cached;
  const url = URL.createObjectURL(new Blob([sfxBytes(preset)], { type: 'audio/mp4' }));
  objectUrls.set(preset.id, url);
  return url;
}

/** 当前是否在试听某个预设（面板用它点亮 ▶/■）。 */
export function sfxPreviewId(): string | null {
  return previewPresetId;
}

export function stopSfxPreview(): void {
  if (previewAudio !== null) {
    previewAudio.pause();
    previewAudio.onended = null;
    previewAudio = null;
  }
  previewPresetId = null;
}

/**
 * 点一下播放、再点停止；同一时间只允许一个（自动停掉上一个，避免混音混乱）。
 * 返回 true = 现在在播。纯 UI 反馈：不进 doc、不占音频引擎、不影响剪辑播放状态。
 */
export function toggleSfxPreview(preset: SfxPreset): boolean {
  if (previewPresetId === preset.id) {
    stopSfxPreview();
    return false;
  }
  stopSfxPreview();
  const audio = new Audio(sfxObjectUrl(preset));
  audio.onended = () => {
    if (previewAudio === audio) stopSfxPreview();
  };
  previewAudio = audio;
  previewPresetId = preset.id;
  // 用户手势路径不会被自动播放策略拦；万一失败静默回到停止态，不让试听卡死面板
  void audio.play().catch(() => {
    if (previewAudio === audio) stopSfxPreview();
  });
  return true;
}
