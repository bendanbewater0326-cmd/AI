/**
 * 定格帧（剪映的「定格」/ PR 的 `Add Frame Hold`）。
 *
 * ## 语义
 *
 * 播放头所在的那一帧，**冻住 3 秒**插到时间线上：
 *
 * ```
 * 原来：  [────── 片段 A ──────]
 *              ↑ 播放头
 * 之后：  [─ A 前半 ─][定格 3s][─ A 后半 ─]
 * ```
 *
 * ## 为什么是"切一刀 + 插一个片段"，而不是新建一张图片素材
 *
 * 新建图片素材要：编码一张 PNG → 进 IDB → 注册预览源 → 多一个解码器。
 * 而"一直显示同一帧"本来就是一个**映射规则**：`Clip.freeze = true` 时
 * `mapProjectFrameToAssetFrame` 恒返回 `inFrame`（见 `core/timebase`）。
 * 于是定格片段天然是一个普通片段——能拖、能裁、能删、能撤销、能套转场，
 * 不需要为它发明任何新概念。
 *
 * ## 为什么要 ripple（后面整体后移）
 *
 * 不后移就会和后半段**同轨重叠**（同轨重叠会让两段都被解码、音频叠两遍）。
 * 后移的是**所有轨**上 `startFrame >= 插入点` 的片段，而不只是本轨：
 * 只推本轨会让别的轨（配乐、字幕、第二条机位）相对错位，音画全散。
 * 代价是"整片后半段一起往后挪"，这与剪映/PR 的行为一致（插入即波纹）。
 *
 * ## 3 秒从哪来
 *
 * 跟剪映的默认值一致（`docs/nle-baseline.md` §2）。定格片段插入后是普通片段，
 * 想要多长就拖多长。
 */
import type { Clip, ClipOperation, Frame, Project } from './types';
import { createClip } from './types';
import { applyOperation } from './operations';
import { buildSplitOperations } from './keymap';
import { mapProjectFrameToAssetFrame, secondsToFrames } from './timebase';

/** 定格默认时长（秒）——与剪映一致。 */
export const FREEZE_SECONDS = 3;

export interface FreezePlan {
  ops: ClipOperation[];
  /** 定格片段 id（插入后选中它，方便立刻拖长短）。 */
  clipId: string;
  /** 定格片段时长（项目帧）。 */
  durationFrames: Frame;
  /** 冻结的是素材的第几帧。 */
  assetFrame: Frame;
}

export interface FreezeFailure {
  message: string;
}

/** 播放头不在片段上时给可读原因（右键菜单要能说清为什么点不动）。 */
export function freezeBlockReason(doc: Project, clip: Clip, atFrame: Frame): string | null {
  const end = clip.startFrame + clip.durationFrames;
  if (atFrame < clip.startFrame || atFrame > end) {
    return '播放头不在这段片段上，先把播放头放到要定格的位置';
  }
  if (clip.freeze === true) return '这已经是定格片段了';
  const asset = doc.assets.find((item) => item.id === clip.assetId);
  if (asset === undefined) return '找不到素材';
  return null;
}

/**
 * 生成「定格」的操作序列。
 *
 * 一次 dispatch 提交：切分 + 波纹后移 + 插入定格片段 —— 撤销一次全回来。
 */
export function buildFreezeOps(
  doc: Project,
  clipId: string,
  atFrame: Frame,
  freezeSeconds: number = FREEZE_SECONDS,
): FreezePlan | FreezeFailure {
  const clip = doc.tracks.flatMap((track) => track.clips).find((item) => item.id === clipId);
  if (clip === undefined) return { message: '片段不存在' };
  const blocked = freezeBlockReason(doc, clip, atFrame);
  if (blocked !== null) return { message: blocked };

  const asset = doc.assets.find((item) => item.id === clip.assetId);
  if (asset === undefined) return { message: '找不到素材' };

  const durationFrames = Math.max(1, secondsToFrames(freezeSeconds, doc.fpsMilli));
  // 播放头正好停在片段末尾（右开边界）时，冻结最后一帧——这是用户想要的"停在这一帧"
  const sampleFrame = Math.min(atFrame, clip.startFrame + clip.durationFrames - 1);
  const assetFrame = mapProjectFrameToAssetFrame(sampleFrame, clip, asset, doc.fpsMilli);
  if (assetFrame === null) return { message: '这一帧取不到画面' };

  const ops: ClipOperation[] = [];
  let sim = doc;

  // 1) 在插入点切一刀（插入点正好是片段起点时不用切）
  if (sampleFrame > clip.startFrame) {
    const split = buildSplitOperations(sim, sampleFrame, clip.id);
    for (const op of split) sim = applyOperation(sim, op);
    ops.push(...split);
  }

  // 2) 波纹后移：**所有轨**上从插入点开始的片段都往后挪，否则同轨重叠、跨轨错位
  const shifts = sim.tracks
    .flatMap((track) => track.clips)
    .filter((item) => item.startFrame >= sampleFrame)
    .map((item) => ({ clipId: item.id, from: item.startFrame, to: item.startFrame + durationFrames }));
  if (shifts.length > 0) {
    const shiftOp: ClipOperation = { op: 'rippleShift', shifts };
    sim = applyOperation(sim, shiftOp);
    ops.push(shiftOp);
  }

  // 3) 插入定格片段：1 帧素材、拉长到 3 秒、只出画不出声
  const freezeClip = createClip({
    assetId: clip.assetId,
    trackId: clip.trackId,
    startFrame: sampleFrame,
    inFrame: assetFrame,
    outFrame: assetFrame + 1,
    durationFrames,
    // 只出画：定格帧不该有声音（原声在后面的片段里继续）
    role: 'video',
    freeze: true,
  });
  ops.push({ op: 'addClip', clip: freezeClip });

  return { ops, clipId: freezeClip.id, durationFrames, assetFrame };
}
