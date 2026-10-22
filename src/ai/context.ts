/**
 * 发给模型的上下文（M4）：只带**结构**，不带素材字节（PRD §9 隐私）。
 *
 * 原则：
 * 1. 帧号一律整数帧，且标明这是"项目帧栅格"——模型最常犯的错就是把秒当帧；
 * 2. 只给"能改的东西"：片段 id / 位置 / 时长 / 素材帧跨度 / 属性；
 * 3. 不带文件名以外的任何用户隐私（本项目本来也没有）。
 *
 * 大小控制：一条 100 片段的工程约 6KB JSON，远小于模型上下文上限；
 * 但仍做截断（最多 60 个片段 + 明示"已截断"），避免长工程把上下文撑爆。
 */
import type { Project } from '../core/types';

const MAX_CLIPS = 60;

export interface ClipSummary {
  id: string;
  name: string;
  track: string;
  startFrame: number;
  durationFrames: number;
  inFrame: number;
  outFrame: number;
  scale: number;
  opacity: number;
}

export interface ProjectContext {
  project: {
    name: string;
    width: number;
    height: number;
    fps: string;
    durationFrames: number;
    playheadFrame: number;
    selectedClipId: string | null;
  };
  tracks: Array<{ id: string; name: string; kind: string; muted: boolean; clipCount: number }>;
  clips: ClipSummary[];
  truncated: boolean;
}

function fpsText(fpsMilli: number): string {
  // timebase-allow: 仅用于给模型看的显示文本（"30" / "23.976"），不参与任何帧换算
  return String(Number((fpsMilli / 1000).toFixed(3)));
}

/** 生成上下文对象（结构可测）。 */
export function buildProjectContext(doc: Project, selectedClipId: string | null): ProjectContext {
  const clips: ClipSummary[] = [];
  let truncated = false;
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clips.length >= MAX_CLIPS) {
        truncated = true;
        break;
      }
      const asset = doc.assets.find((item) => item.id === clip.assetId);
      clips.push({
        id: clip.id,
        name: asset?.name ?? '(素材缺失)',
        track: track.name,
        startFrame: clip.startFrame,
        durationFrames: clip.durationFrames,
        inFrame: clip.inFrame,
        outFrame: clip.outFrame,
        scale: clip.transform.scale,
        opacity: clip.transform.opacity,
      });
    }
    if (truncated) break;
  }

  let duration = 0;
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      duration = Math.max(duration, clip.startFrame + clip.durationFrames);
    }
  }

  return {
    project: {
      name: doc.name,
      width: doc.width,
      height: doc.height,
      fps: fpsText(doc.fpsMilli),
      durationFrames: duration,
      playheadFrame: doc.playheadFrame,
      selectedClipId,
    },
    tracks: doc.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      kind: track.kind,
      muted: track.muted,
      clipCount: track.clips.length,
    })),
    clips,
    truncated,
  };
}

/** 序列化成给模型的紧凑 JSON。 */
export function serializeContext(context: ProjectContext): string {
  return JSON.stringify(context);
}
