/**
 * 新建文字片段的共享构建（文本面板 / 时间线空白右键 / AI 文案意图共用的**唯一**入口）。
 *
 * 2026-10-24 从 ui/ 迁到 core/：AI 编译器（ai/intents.ts）也要用它，而 ai 只 import core
 * （层级约定）——迁移而不是复制，「新建文字」永远只有一个定义点。
 *
 * 抽出来的原因：`TextPanel.createText` 与右键「在此处新建文字」是同一件事的
 * 两个入口——建文字轨（不够则建）+ 落片要在**同一个撤销步**里，时长都走
 * `readPrefs().defaultClipSeconds`。复制一份就会造出"第二个新建文字实现"。
 */
import type { ClipOperation, Project, TextContent } from './types';
import { createClip } from './types';
import { ensureTextTrackOps } from './placement';
import { secondsToFrames } from './timebase';
import { defaultClipSeconds } from './prefs';

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
