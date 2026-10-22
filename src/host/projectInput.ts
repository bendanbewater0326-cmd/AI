/**
 * 宿主送进来的工程 JSON → 可安全渲染的 `Project`（R-050 `setProject` 的安全闸门）。
 *
 * **为什么要归一化而不是直接 `replaceDoc`**：宿主手里那份 JSON 很可能是旧版本导出的
 * （没有 `keyframes` / `effects` / `audio` 字段，或 `transitionIn` 缺失）。渲染层假设这些字段存在，
 * 直接吃进去就会在 `clip.keyframes.filter(...)` 这类地方崩——2026-10-21 修过一次
 * "旧工程 keyframes 缺失导致播放/导出崩溃"，同一个坑不踩第二次。
 *
 * **策略：整份接受或整份拒绝**。返回 `null` 表示结构不可用；不做"能认多少认多少"——
 * 半份工程比没有更危险，用户会以为导入成功却在时间线上看不到片段。
 *
 * 本文件**只依赖 `core/types`**（不碰 store / DOM），所以能在 Node 里直接单测。
 */
import type {
  Asset,
  Clip,
  ClipAudio,
  Effect,
  Keyframe,
  Project,
  TextContent,
  Track,
  Transform,
  Transition,
} from '../core/types';
import { createAsset, createClip, createTrack, maxTransitionFrames, normalizeRotation } from '../core/types';
import { VOLUME_MAX_DB, dbToGain } from '../core/volume';

/** 工程 schema 版本（`ready` 事件与 `setProject` 响应都带它）。 */
export const HOST_SCHEMA_VERSION = 1;

/* ---------------- 基础判定 ---------------- */

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function int(value: unknown, fallback: number): number {
  return Math.trunc(num(value, fallback));
}

function nonNegInt(value: unknown, fallback: number): number {
  return Math.max(0, int(value, fallback));
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/* ---------------- 片段子结构 ---------------- */

function normalizeTransform(raw: unknown): Partial<Transform> {
  if (!isObject(raw)) return {};
  const blend = raw['blendMode'];
  const blendMode =
    blend === 'normal' || blend === 'overlay' || blend === 'screen' || blend === 'multiply'
      ? blend
      : 'normal';
  return {
    scale: Math.min(5, Math.max(0, num(raw['scale'], 1))),
    x: num(raw['x'], 0),
    y: num(raw['y'], 0),
    opacity: Math.min(1, Math.max(0, num(raw['opacity'], 1))),
    blendMode,
    // 旋转/翻转是 2026-10-22 加的：老工程没有这两个字段，必须给默认值而不是丢掉
    rotation: normalizeRotation(raw['rotation']),
    flipX: raw['flipX'] === true,
    flipY: raw['flipY'] === true,
  };
}

/** 增益上限：+12dB 对应的振幅。 */
const MAX_GAIN = dbToGain(VOLUME_MAX_DB);

function normalizeAudio(raw: unknown): Partial<ClipAudio> {
  if (!isObject(raw)) return {};
  return {
    /**
     * 上限夹到 +12dB 对应的振幅（≈3.98）。
     *
     * 为什么要有上限：`gain` 是线性振幅，理论上给多少都行；但界面上滑块只到 200%(+12dB)，
     * 手改工程文件塞一个 100 进去，就会得到 +40dB —— 播放时全是爆音，用户也不知道怎么坏的。
     */
    gain: Math.min(MAX_GAIN, Math.max(0, num(raw['gain'], 1))),
    fadeInFrames: nonNegInt(raw['fadeInFrames'], 0),
    fadeOutFrames: nonNegInt(raw['fadeOutFrames'], 0),
  };
}

export function normalizeKeyframes(raw: unknown): Keyframe[] {
  if (!Array.isArray(raw)) return [];
  const points: Keyframe[] = [];
  for (const item of raw) {
    if (!isObject(item)) continue;
    const property = str(item['property'], '');
    if (property === '') continue;
    const frame = nonNegInt(item['frame'], -1);
    if (frame < 0) continue;
    points.push({ frame, property, value: num(item['value'], 0), easing: 'linear' });
  }
  return points;
}

function normalizeText(raw: unknown): TextContent | null {
  if (!isObject(raw)) return null;
  const align = raw['align'];
  const strokeRaw = raw['stroke'];
  return {
    content: str(raw['content'], ''),
    fontSize: Math.max(1, int(raw['fontSize'], 72)),
    color: str(raw['color'], '#ffffff'),
    align: align === 'left' || align === 'right' ? align : 'center',
    x: num(raw['x'], 0),
    y: num(raw['y'], 0),
    background: str(raw['background'], ''),
    /**
     * `bold` / `stroke` 是 2026-10-23 新增的可选字段。
     * **必须显式归一化**：`createTextContent` 只写默认值，工程文件里丢了它
     * 就等于"存盘再打开，描边/粗体没了"——从界面上完全看不出来（见 §9.4 同款教训）。
     */
    ...(raw['bold'] === true ? { bold: true } : {}),
    ...(isObject(strokeRaw) && num(strokeRaw['width'], 0) > 0
      ? { stroke: { width: Math.max(0, Math.min(40, num(strokeRaw['width'], 0))), color: str(strokeRaw['color'], '#000000') } }
      : {}),
  };
}

function normalizeTransition(raw: unknown, clipDurationFrames: number): Transition | null {
  if (!isObject(raw)) return null;
  const type = raw['type'];
  if (type !== 'crossDissolve' && type !== 'fadeIn' && type !== 'fadeOut') return null;
  const durationFrames = nonNegInt(raw['durationFrames'], 0);
  if (durationFrames < 1) return null;
  // 夹到"片段长度的一半"（规则定义在 `core/types.maxTransitionFrames`）：
  // 宿主送来的工程可能是别的版本生成的，转场比片段还长会让画面永远半透明。
  return { type, durationFrames: Math.min(durationFrames, maxTransitionFrames({ durationFrames: clipDurationFrames })) };
}

function normalizeEffects(raw: unknown, clipId: string): Effect[] {
  if (!Array.isArray(raw)) return [];
  const effects: Effect[] = [];
  for (const item of raw) {
    if (!isObject(item)) continue;
    const type = str(item['type'], '');
    if (type === '') continue;
    const params: Record<string, number | string> = {};
    const paramsRaw = item['params'];
    if (isObject(paramsRaw)) {
      for (const [key, value] of Object.entries(paramsRaw)) {
        if (typeof value === 'number' || typeof value === 'string') params[key] = value;
      }
    }
    effects.push({
      id: str(item['id'], `fx_${clipId}_${type}`),
      clipId,
      type,
      params,
      keyframes: normalizeKeyframes(item['keyframes']),
      enabled: item['enabled'] !== false,
      order: int(item['order'], 0),
      source: item['source'] === 'ai' ? 'ai' : 'ui',
    });
  }
  return effects;
}

function normalizeClip(raw: unknown, trackId: string): Clip | null {
  if (!isObject(raw)) return null;
  // 起点/长度不用 `nonNegInt`：那个函数会把负数夹成 0（"静默挪位置"），
  // 而负帧号只可能来自坏数据 —— 直接判这个片段不合法，比悄悄挪到 0 更安全
  const startRaw = num(raw['startFrame'], -1);
  const durationRaw = num(raw['durationFrames'], 0);
  const startFrame = Math.trunc(startRaw);
  const durationFrames = Math.trunc(durationRaw);
  // 这两个是片段的"存在条件"：没有合法起点或长度，它在时间线上没有意义
  if (startFrame < 0 || durationFrames < 1) return null;
  const inFrame = nonNegInt(raw['inFrame'], 0);
  const outFrame = Math.max(inFrame + 1, nonNegInt(raw['outFrame'], inFrame + durationFrames));

  const clip = createClip({
    ...(typeof raw['id'] === 'string' && raw['id'] !== '' ? { id: raw['id'] } : {}),
    assetId: str(raw['assetId'], ''),
    trackId,
    startFrame,
    inFrame,
    outFrame,
    durationFrames,
    speedMilli: Math.max(1, int(raw['speedMilli'], 1000)),
    enabled: raw['enabled'] !== false,
    transform: normalizeTransform(raw['transform']),
    audio: normalizeAudio(raw['audio']),
    text: normalizeText(raw['text']),
    keyframes: normalizeKeyframes(raw['keyframes']),
    source: raw['source'] === 'ai' ? 'ai' : 'ui',
    /**
     * `role` / `freeze` / `reversed` 必须显式归一化：
     * `createClip` 只在参数里带了才写字段，**工程文件里丢了就等于"分离音频被还原成没分离"**
     * （画面和声音同时出现 = 音量翻倍）。这类"序列化漏字段"的 bug 从界面上看不出来，
     * 只有存盘再打开才会炸。
     */
    ...(raw['role'] === 'video' || raw['role'] === 'audio' ? { role: raw['role'] as 'video' | 'audio' } : {}),
    ...(raw['freeze'] === true ? { freeze: true } : {}),
    ...(raw['reversed'] === true ? { reversed: true } : {}),
  });
  // effects / transition 不在 createClip 的参数里，建好后再挂
  clip.effects = normalizeEffects(raw['effects'], clip.id);
  clip.transitionIn = normalizeTransition(raw['transitionIn'], durationFrames);
  clip.transitionOut = normalizeTransition(raw['transitionOut'], durationFrames);
  return clip;
}

function normalizeAsset(raw: unknown, fallbackFpsMilli: number): Asset | null {
  if (!isObject(raw)) return null;
  const name = str(raw['name'], '') === '' ? '素材' : str(raw['name'], '素材');
  const durationRaw = raw['durationFrames'];
  return createAsset({
    ...(typeof raw['id'] === 'string' && raw['id'] !== '' ? { id: raw['id'] } : {}),
    name,
    kind: raw['kind'] === 'audio' ? 'audio' : 'video',
    fpsMilli: Math.max(1, int(raw['fpsMilli'], fallbackFpsMilli)),
    durationFrames: typeof durationRaw === 'number' ? Math.max(0, Math.trunc(durationRaw)) : null,
    durationSec: num(raw['durationSec'], 0),
    sampleRate: Math.max(1, int(raw['sampleRate'], 48000)),
    channels: Math.max(1, int(raw['channels'], 2)),
    width: nonNegInt(raw['width'], 0),
    height: nonNegInt(raw['height'], 0),
    hasAudio: raw['hasAudio'] === true,
    thumbnailRef: null,
    container:
      raw['container'] === 'mp4' || raw['container'] === 'webm' ? raw['container'] : 'unknown',
    codecVideo: typeof raw['codecVideo'] === 'string' ? raw['codecVideo'] : null,
    codecAudio: typeof raw['codecAudio'] === 'string' ? raw['codecAudio'] : null,
    rotation: int(raw['rotation'], 0),
    exactSeek: raw['exactSeek'] === true,
    hashKey: str(raw['hashKey'], `${name}|0|0`),
    /**
     * 重链用的元数据。旧工程没有这两个字段 → `undefined`，
     * 匹配时降级到"文件名 + 大小 + 时长"（验收要求里的"向下兼容"）。
     */
    ...(typeof raw['sourcePath'] === 'string' && raw['sourcePath'] !== ''
      ? { sourcePath: raw['sourcePath'] }
      : {}),
    ...(typeof raw['contentHash'] === 'string' && raw['contentHash'] !== ''
      ? { contentHash: raw['contentHash'] }
      : {}),
    // 宿主传进来的只有元数据、没有字节：标 offline，等 importAsset 带 assetId 重连
    status: 'offline',
    sourceMode: 'memory',
    handleRef: null,
  });
}

/* ---------------- 工程 ---------------- */

/**
 * 归一化整份工程。返回 `null` = 整份拒绝。
 *
 * 拒绝条件只有三类（其余一律补默认值）：
 * 1. 不是对象，或 `tracks` 不是非空数组；
 * 2. `width` / `height` / `fpsMilli` 不是正整数；
 * 3. 所有轨道都不合法（归一化后一条不剩）。
 */
export function normalizeProjectInput(raw: unknown): Project | null {
  if (!isObject(raw)) return null;
  const tracksRaw = raw['tracks'];
  if (!Array.isArray(tracksRaw) || tracksRaw.length === 0) return null;

  const width = int(raw['width'], 0);
  const height = int(raw['height'], 0);
  const fpsMilli = int(raw['fpsMilli'], 0);
  if (width <= 0 || height <= 0 || fpsMilli <= 0) return null;

  const tracks: Track[] = [];
  for (const [index, trackRaw] of tracksRaw.entries()) {
    if (!isObject(trackRaw)) continue;
    const kind = trackRaw['kind'] === 'audio' ? 'audio' : 'video';
    const trackId = str(trackRaw['id'], '') === '' ? `trk_${index}` : str(trackRaw['id'], '');
    const clipsRaw = Array.isArray(trackRaw['clips']) ? trackRaw['clips'] : [];
    const clips: Clip[] = [];
    for (const clipRaw of clipsRaw) {
      const clip = normalizeClip(clipRaw, trackId);
      if (clip !== null) clips.push(clip);
    }
    // 不变式：轨道内片段按 startFrame 升序（types.ts 的 Track.clips 注释）
    clips.sort((a, b) => a.startFrame - b.startFrame);
    tracks.push(
      createTrack({
        id: trackId,
        kind,
        name: str(trackRaw['name'], kind === 'audio' ? 'A1' : `V${index + 1}`),
        order: int(trackRaw['order'], 0),
        locked: trackRaw['locked'] === true,
        muted: trackRaw['muted'] === true,
        hidden: trackRaw['hidden'] === true,
        clips,
      }),
    );
  }
  if (tracks.length === 0) return null;

  const assets: Asset[] = [];
  for (const assetRaw of Array.isArray(raw['assets']) ? raw['assets'] : []) {
    const asset = normalizeAsset(assetRaw, fpsMilli);
    if (asset !== null) assets.push(asset);
  }

  const now = Date.now();
  const durationFrames = tracks.reduce(
    (max, track) =>
      Math.max(max, ...track.clips.map((clip) => clip.startFrame + clip.durationFrames), 0),
    0,
  );

  return {
    id: str(raw['id'], '') === '' ? `prj_${now.toString(36)}` : str(raw['id'], ''),
    name: str(raw['name'], '') === '' ? '未命名工程' : str(raw['name'], ''),
    fpsMilli,
    width,
    height,
    sampleRate: 48000,
    frameMapPolicy: 'holdPrevious',
    durationRounding: 'halfUp',
    tracks,
    assets,
    playheadFrame: Math.min(nonNegInt(raw['playheadFrame'], 0), durationFrames),
    zoomLevel: Math.min(20, Math.max(1, int(raw['zoomLevel'], 5))),
    schemaVersion: HOST_SCHEMA_VERSION,
    createdAt: nonNegInt(raw['createdAt'], now),
    updatedAt: now,
  };
}

/* ---------------- 素材载荷 ---------------- */

const MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  aac: 'audio/aac',
};

export function guessMime(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** data URL → Blob（base64 与百分号编码都支持）。非法返回 null。 */
export function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (match === null) return null;
  const mime = match[1] === '' || match[1] === undefined ? 'application/octet-stream' : match[1];
  const payload = match[3] ?? '';
  try {
    if (match[2] !== ';base64') {
      return new Blob([decodeURIComponent(payload)], { type: mime });
    }
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
}
