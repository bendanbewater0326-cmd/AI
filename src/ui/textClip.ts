/**
 * 新建文字片段的共享构建（左栏「文本」面板与时间线空白右键共用的**唯一**入口）。
 *
 * 抽出来的原因：`TextPanel.createText` 与右键「在此处新建文字」是同一件事的
 * 两个入口——建文字轨（不够则建）+ 落片要在**同一个撤销步**里，时长都走
 * `readPrefs().defaultClipSeconds`。复制一份就会造出"第二个新建文字实现"。
 */
import type { ClipOperation, Project, TextContent } from '../core/types';
import { createClip } from '../core/types';
import { ensureTextTrackOps } from '../core/placement';
import { secondsToFrames } from '../core/timebase';
import { defaultClipSeconds } from '../core/prefs';

export interface NewTextPlan {
  ops: ClipOperation[];
  clipId: string;
  trackId: string;
  durationFrames: number;
}

/** 在 `startFrame` 处建一段文字（建轨与落片同批 = 一个撤销步）。 */
export function buildNewTextOps(doc: Project, startFrame: number, text: TextContent): NewTextPlan {
  const durationFrames = Math.max(1, secondsToFrames(defaultClipSeconds(), doc.fpsMilli));
  const placement = ensureTextTrackOps(doc, startFrame, durationFrames);
  const clip = createClip({
    assetId: '',
    trackId: placement.trackId,
    startFrame,
    inFrame: 0,
    outFrame: durationFrames,
    durationFrames,
    text,
  });
  return {
    ops: [...placement.ops, { op: 'addClip' as const, clip }],
    clipId: clip.id,
    trackId: placement.trackId,
    durationFrames,
  };
}
