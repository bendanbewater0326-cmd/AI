/**
 * 分离音频（剪映/PR 里的"分离音频"，右键菜单第一项）。
 *
 * ## 语义
 *
 * 一个视频片段同时贡献画面和声音。分离之后：
 * - 原片段只留画面（`role: 'video'`）——渲染照常，音频调度跳过它；
 * - 新建一个**同素材、同区间、同速度**的片段放在音频轨（`role: 'audio'`）——
 *   画面渲染跳过它，音频调度照常。
 *
 * 于是"画面"和"声音"从此可以分别拖动、分别删除、分别调音量，而**听感和画面完全不变**。
 *
 * ## 为什么用 role 而不是新建一条"只音频素材"
 *
 * 素材只有一份字节（同一个 `assetId`）。再造一个素材等于复制解码器与会话，
 * 而且两个素材的音画同步要靠帧号硬对——一条 `role` 字段就把"这段内容只取画面/只取声音"
 * 说清楚了，渲染与音频各读一次，天然同步。
 *
 * ## "分离过"不是一次性状态（2026-10-22 用户实测反馈）
 *
 * 第一版把"分离过"判成 `clip.role === 'video'`，于是：
 * 分离 → 把音频片段删掉 → **再也不能分离了**（永远提示"音频已经分离过了"），
 * 而这段素材的声音其实已经彻底消失，用户只能撤销才能救回来。
 *
 * 用户的原话："删除音频等这些功能不是一次性，不是你使用过就无法继续使用的了。"
 *
 * 所以判据改成**派生**的：`role === 'video'` 只说明"这个片段不出声"，
 * 声音在不在要看**时间线上还有没有对应的音频片段**（`findDetachedAudioClip`）：
 * - 有 → 拒绝（否则会叠出第二份声音）；
 * - 没有（被删掉了）→ 允许，重新造一份出来。
 *
 * 这条规矩适用于所有"用过的功能"：**能不能再做一次，要看当前状态，不看历史动作**。
 *
 * ## 一次 dispatch
 *
 * 三条操作（建轨 + 改 role + 加片段）合成一批，撤销一次全回来。
 */
import type { Clip, ClipOperation, Project, Track } from './types';
import { createClip } from './types';
import { nextTrackFor, trackRangeFree } from './placement';

export interface DetachAudioPlan {
  ops: ClipOperation[];
  /** 声音落到哪条音频轨（给 UI 提示用）。 */
  trackId: string;
  /** 分离出的音频片段 id。 */
  audioClipId: string;
}

export interface DetachAudioFailure {
  message: string;
  detail?: string;
}

/**
 * 这段画面"已经分离出来的声音"（同素材 + **源区间相交**的音频片段）。
 *
 * 为什么按源区间而不是按时间线区间：
 * 用户把音频片段拖到别处之后，它仍然是"这段素材的这部分声音"，
 * 再分离一次就会有两份同样的声音。按源区间相交判断，拖走/裁短都还能认出来。
 */
export function findDetachedAudioClip(doc: Project, clip: Clip): Clip | null {
  if (clip.role === 'audio') return null;
  for (const track of doc.tracks) {
    if (track.kind !== 'audio') continue;
    for (const candidate of track.clips) {
      if (candidate.role !== 'audio') continue;
      if (candidate.assetId !== clip.assetId) continue;
      // 源区间相交（左闭右开）：[inFrame, outFrame)
      if (candidate.inFrame < clip.outFrame && clip.inFrame < candidate.outFrame) return candidate;
    }
  }
  return null;
}

/** 该片段能不能分离音频。返回 null = 可以；否则给可读原因。 */
export function detachAudioBlockReason(doc: Project, clip: Clip): string | null {
  if (clip.role === 'audio') return '这已经是音频片段了';
  const asset = doc.assets.find((item) => item.id === clip.assetId);
  if (asset === undefined) return '找不到素材';
  if (!asset.hasAudio) return '这段素材没有音频';
  // 派生判断：声音还在时间线上才拦（删掉之后要能重新分离）
  const existing = findDetachedAudioClip(doc, clip);
  if (existing !== null) {
    const track = doc.tracks.find((item) => item.id === existing.trackId);
    return `声音已经在 ${track?.name ?? '音频轨'} 上，删掉它就能重新分离`;
  }
  return null;
}

/** 找一条能放这段音频的轨：优先已有音频轨，都占用就新建一条。 */
function pickAudioTrack(doc: Project, clip: Clip): { track: Track; create: boolean } {
  const candidates = doc.tracks
    .filter((track) => track.kind === 'audio' && !track.locked && !track.hidden)
    .sort((left, right) => left.order - right.order);
  for (const track of candidates) {
    if (trackRangeFree(track, clip.startFrame, clip.durationFrames)) {
      return { track, create: false };
    }
  }
  return { track: nextTrackFor(doc, 'audio'), create: true };
}

/**
 * 生成"分离音频"的操作序列。
 *
 * 失败时返回可读原因（而不是抛错）：右键菜单里点不动要能说清为什么。
 */
export function buildDetachAudioOps(
  doc: Project,
  clipId: string,
): DetachAudioPlan | DetachAudioFailure {
  const clip = doc.tracks.flatMap((track) => track.clips).find((item) => item.id === clipId);
  if (clip === undefined) return { message: '片段不存在' };
  const blocked = detachAudioBlockReason(doc, clip);
  if (blocked !== null) return { message: blocked };

  const { track, create } = pickAudioTrack(doc, clip);
  const audioClip = createClip({
    assetId: clip.assetId,
    trackId: track.id,
    startFrame: clip.startFrame,
    inFrame: clip.inFrame,
    outFrame: clip.outFrame,
    durationFrames: clip.durationFrames,
    speedMilli: clip.speedMilli,
    // 音量/淡化跟着声音走（它们本来就只影响声音）；变换/效果/转场留在画面那边
    audio: { ...clip.audio },
    role: 'audio',
  });

  const ops: ClipOperation[] = [];
  if (create) ops.push({ op: 'addTrack', track });
  // role 已经是 'video' 时（声音被删掉了、想再分离一次）不用再改一次：
  // 多一条 no-op 的 setClipProps 只会让撤销栈多一步没意义的状态
  if (clip.role !== 'video') {
    ops.push({
      op: 'setClipProps',
      clipId: clip.id,
      path: 'role',
      from: clip.role,
      to: 'video',
    });
  }
  ops.push({ op: 'addClip', clip: audioClip });
  return { ops, trackId: track.id, audioClipId: audioClip.id };
}
