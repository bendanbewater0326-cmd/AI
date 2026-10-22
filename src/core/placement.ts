/**
 * 片段落轨规则（"这个片段该放到哪条轨"）。
 *
 * ## 为什么需要单独一个模块
 *
 * 原来的规则是 `defaultTrackId()` 里的一句"视频永远 trk_V1、音频永远 trk_A1"。
 * 这在"只放一段素材"时够用，但一旦播放头位置**已经被占用**，它就会把第二个片段
 * **叠在第一段上面**（同一条轨两个片段重叠）——渲染层会把两段都解出来画一遍，
 * 音频还会混两遍（音量翻倍），而且时间线上看不出异常（后画的盖住前面的）。
 *
 * 更糟的是它把多机位（R-057）堵死了：多机位要求"每条视频轨是一个机位"，
 * 而用户根本没有办法把第二段素材放到第二条轨上（界面里双击素材永远落 V1）。
 *
 * ## 规则
 *
 * 1. 先看"首选轨"（视频 `trk_V1` / 音频 `trk_A1`）：区间空闲就用它——
 *    保持"第一段素材落 V1"这个可预期的行为；
 * 2. 否则按屏幕顺序找同类型、未锁定、未隐藏、**区间空闲**的轨；
 * 3. 都没有 → 返回 `null`，调用方新建一条轨（而不是硬塞进去重叠）。
 *
 * 区间判定用**左闭右开**：`[start, start+duration)` 相邻不算重叠
 * （前一段的结束点正好是后一段的起点，是正常剪辑）。
 *
 * 纯函数、只依赖 `core/types`，可以在 Node 里直接单测。
 */
import type { Asset, ClipOperation, Frame, Project, Track, TrackKind } from './types';
import { createClip, trackDisplayOrder } from './types';
import { projectSpanFrames, secondsToFrames } from './timebase';

/** 首选轨（保持"第一段素材落 V1 / 纯音频落 A1 / 字幕落 T1"的既有预期）。 */
const PREFERRED_VIDEO_ID = 'trk_V1';
const PREFERRED_AUDIO_ID = 'trk_A1';
const PREFERRED_TEXT_ID = 'trk_T1';

/** 区间 `[startFrame, startFrame + durationFrames)` 在该轨上是否空闲。 */
export function trackRangeFree(
  track: Track,
  startFrame: Frame,
  durationFrames: Frame,
): boolean {
  const end = startFrame + durationFrames;
  for (const clip of track.clips) {
    const clipEnd = clip.startFrame + clip.durationFrames;
    // 左闭右开：clipEnd === startFrame 或 clip.startFrame === end 都不算重叠
    if (clip.startFrame < end && startFrame < clipEnd) return false;
  }
  return true;
}

/** 该轨能不能放东西（隐藏/锁定的轨不参与自动落轨）。 */
function usable(track: Track, kind: TrackKind): boolean {
  return track.kind === kind && !track.locked && !track.hidden;
}

/**
 * 挑一条能放下该区间的轨；没有就返回 `null`（调用方新建轨）。
 */
export function pickTrackForInsert(
  doc: Project,
  kind: TrackKind,
  startFrame: Frame,
  durationFrames: Frame,
  /**
   * 首选轨（拖拽落点用）。
   *
   * 给了它，就**先试这一条**；这条被占用了再按屏幕顺序找同类型的空闲轨
   * （而不是退回 V1/A1 —— 用户明明拖到了 V2，落点却跳到 V1 会很怪）。
   * 不给就保持老行为：V1/A1 优先，然后屏幕顺序。
   */
  preferId?: string,
): string | null {
  if (preferId !== undefined) {
    const dropped = doc.tracks.find((track) => track.id === preferId);
    if (dropped !== undefined && usable(dropped, kind) && trackRangeFree(dropped, startFrame, durationFrames)) {
      return dropped.id;
    }
    for (const track of trackDisplayOrder(doc.tracks)) {
      if (track.id === preferId) continue;
      if (!usable(track, kind)) continue;
      if (trackRangeFree(track, startFrame, durationFrames)) return track.id;
    }
    return null;
  }
  const preferredId = kind === 'video' ? PREFERRED_VIDEO_ID : kind === 'audio' ? PREFERRED_AUDIO_ID : PREFERRED_TEXT_ID;
  const preferred = doc.tracks.find((track) => track.id === preferredId);
  if (
    preferred !== undefined &&
    usable(preferred, kind) &&
    trackRangeFree(preferred, startFrame, durationFrames)
  ) {
    return preferred.id;
  }
  for (const track of trackDisplayOrder(doc.tracks)) {
    if (!usable(track, kind)) continue;
    if (trackRangeFree(track, startFrame, durationFrames)) return track.id;
  }
  return null;
}

/**
 * 文字片段落到哪条轨（**手动新建文字 / SRT 导入 / AI 转写共用这一份规则**）。
 *
 * 文字必须落在**文字轨**上，不能借用视频轨：
 * 1. 借用视频轨时，用户之后在它上面新建 V3，文字就被画面盖住（真问题）；
 * 2. 剪辑软件的通用认知就是"字幕有自己的轨"，混在视频轨里拖动/裁剪时极易误删。
 *
 * 返回 `ops` 里可能包含一条 `addTrack`——调用方把它和 `addClip` **一起 dispatch**，
 * 这样"建轨 + 放字"是一个撤销步，不会留下一条空的文字轨。
 */
export function ensureTextTrackOps(
  doc: Project,
  startFrame: Frame,
  durationFrames: Frame,
  preferId?: string,
): { ops: ClipOperation[]; trackId: string } {
  const found = pickTrackForInsert(doc, 'text', startFrame, durationFrames, preferId);
  if (found !== null) return { ops: [], trackId: found };
  const track = nextTrackFor(doc, 'text');
  return { ops: [{ op: 'addTrack', track }], trackId: track.id };
}

/**
 * 轨道能否删除（不能删时返回**可读原因**，`null` = 可以删）。
 *
 * 规则只有两条，但都很重要：
 * 1. **至少要留一条视频轨**：删光之后素材无处可放（`pickTrackForInsert` 返回 null 会去新建，
 *    但字幕落轨 `buildSubtitleReplaceOps` 需要现成的视频轨，直接失败），用户会以为编辑器坏了；
 * 2. **锁定的轨不能删**：锁定就是"别动这条轨"，删除是最彻底的"动"。
 *
 * 有内容的轨**可以删**（片段随轨道一起消失）——因为撤销栈能整体回退，
 * 拦着不让删反而逼用户一个个删片段，更糟。调用方要在文案里带上片段数。
 */
export function trackRemoveBlockReason(doc: Project, trackId: string): string | null {
  const track = doc.tracks.find((item) => item.id === trackId);
  if (track === undefined) return '轨道不存在';
  if (track.locked) return '轨道已锁定，先解锁再删除';
  if (track.kind === 'video' && doc.tracks.filter((item) => item.kind === 'video').length <= 1) {
    return '至少要保留一条视频轨';
  }
  return null;
}

/**
 * 生成一条新的视频/音频轨（**不 dispatch**，调用方与 `addClip` 一起提交）。
 *
 * 命名沿用界面「＋ 轨道」按钮的规则：`V{n}` / `A{n}`，`order` 取同类轨数量。
 * 与 `TimelineView.addTrack` 共用这一份实现——两处各自算一次就会出现
 * "点按钮建出 V3、自动落轨建出 V2" 这种重名。
 */
export function nextTrackFor(doc: Project, kind: TrackKind): Track {
  const sameKind = doc.tracks.filter((track) => track.kind === kind);
  const prefix = kind === 'video' ? 'V' : kind === 'audio' ? 'A' : 'T';
  const maxNum = sameKind.reduce((max, track) => {
    const match = new RegExp(`^${prefix}(\\d+)$`).exec(track.name);
    return match ? Math.max(max, Number.parseInt(match[1] ?? '0', 10)) : max;
  }, 0);
  const num = maxNum + 1;
  return {
    id: `trk_${prefix}${num}`,
    kind,
    name: `${prefix}${num}`,
    order: sameKind.length,
    locked: false,
    muted: false,
    hidden: false,
    clips: [],
  } as Track;
}

/* ---------------- 素材上轨（唯一实现） ---------------- */

export interface PlaceAssetPlan {
  ops: ClipOperation[];
  trackId: string;
  clipId: string;
  /** 落到时间线上的时长（项目帧）。 */
  durationFrames: Frame;
  /** 新建了轨道时给名字（用于撤销步标题与提示）。 */
  newTrackName: string | null;
}

export interface PlaceAssetFailure {
  message: string;
}

/**
 * 把**一个素材**放到时间线上某处（双击上轨 / 拖到播放头 / 配一段音频都走这里）。
 *
 * ## 为什么必须只有一份
 *
 * 这段逻辑原来只写在素材栏的 `addToTimeline()` 里。多加一个"给片段配音频"的入口时，
 * 若在那边再写一遍，就必然出现"素材栏双击落 A1、右键配音频落 A2"这种不一致；
 * 更糟的是漏掉某一处校验（时长未知、无空闲轨）时，**只有其中一个入口会崩**。
 *
 * ## 时长口径
 *
 * 纯音频素材没有视频帧栅格（`durationFrames === null`），用 `secondsToFrames` 按素材毫帧率
 * 折算；随后一律走 `projectSpanFrames` 换成项目帧——**不在调用方另算一遍**。
 *
 * 失败返回可读原因（`message`）而不是抛错：入口都是 UI，说不清为什么就等于不能用。
 */
export function buildPlaceAssetOps(
  doc: Project,
  asset: Asset,
  startFrame: Frame,
  options: { kind?: TrackKind; trackId?: string } = {},
): PlaceAssetPlan | PlaceAssetFailure {
  const assetSpan =
    asset.durationFrames !== null
      ? asset.durationFrames
      : secondsToFrames(asset.durationSec, asset.fpsMilli);
  if (!Number.isFinite(assetSpan) || assetSpan < 1) {
    return { message: '素材时长未知，暂时无法上轨' };
  }
  const durationFrames = projectSpanFrames(assetSpan, asset.fpsMilli, doc.fpsMilli);
  const kind: TrackKind = options.kind ?? (asset.kind === 'audio' ? 'audio' : 'video');

  /**
   * 拖拽落点：先把"这条轨能不能放"说清楚，再谈放哪。
   *
   * 为什么必须在这里拦（而不是让 `pickTrackForInsert` 自己找别的轨）：
   * 把视频拖到音频轨上，用户**明确**指着那条轨；偷偷换个轨放进去，
   * 比直接说"视频不能放到音频轨"更让人困惑（剪映也是拒绝）。
   */
  if (options.trackId !== undefined) {
    const target = doc.tracks.find((track) => track.id === options.trackId);
    if (target === undefined) return { message: '目标轨道不存在' };
    if (target.kind !== kind) {
      return {
        message:
          kind === 'audio' ? '音频只能放到音频轨' : kind === 'text' ? '字幕只能放到字幕轨' : '视频只能放到视频轨',
      };
    }
    if (target.locked) return { message: `轨道 ${target.name} 已锁定` };
    if (target.hidden) return { message: `轨道 ${target.name} 已隐藏` };
  }

  const existing = pickTrackForInsert(doc, kind, startFrame, durationFrames, options.trackId);
  const newTrack = existing === null ? nextTrackFor(doc, kind) : null;
  const trackId = existing ?? newTrack?.id ?? '';
  if (trackId === '') return { message: '没有可用的轨道' };

  const clip = createClip({
    assetId: asset.id,
    trackId,
    startFrame,
    inFrame: 0,
    outFrame: assetSpan,
    durationFrames,
  });
  // 新建轨与片段在**同一批操作**里：用户点一次撤销就能整体回退
  const ops: ClipOperation[] =
    newTrack === null
      ? [{ op: 'addClip', clip }]
      : [{ op: 'addTrack', track: newTrack }, { op: 'addClip', clip }];
  return { ops, trackId, clipId: clip.id, durationFrames, newTrackName: newTrack?.name ?? null };
}
