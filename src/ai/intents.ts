/**
 * AI 意图 → 剪辑操作（M4 的安全闸门，R-046 / 用户决策 Q12）。
 *
 * ## 为什么不让模型直接输出 `ClipOperation[]`
 *
 * `ClipOperation` 是**带完整载荷**的变更单元（`removeClip` 要带 `removed` 整段、
 * `trimClip` 要带前后 `TrimState`）。让模型填这些载荷有三个必然后果：
 * ① 模型编造 clip 对象 → 撤销栈里躺着假数据，Ctrl+Z 直接崩；
 * ② 模型算错素材帧 → 帧精确承诺失效，且错得很隐蔽；
 * ③ 模型"顺手"多改一个字段 → 用户说不清哪里变了。
 *
 * 因此 AI 只被允许说**意图**（我要删这段、我要在这个帧切一刀），
 * 由本文件用 doc 现场补全载荷、校验合法性、编译成 `ClipOperation[]`。
 * 编译失败就整条拒绝，不做"尽力而为"的部分执行。
 *
 * ## 纯函数
 *
 * 不碰 store / DOM，可在 Node 里单测（`tests/ai-intents.test.mjs`）。
 */
import { applyOperation } from '../core/operations';
import { buildSplitOperations } from '../core/keymap';
import { assetFrameToProjectFrame, mapProjectFrameToAssetFrame, projectSpanFrames } from '../core/timebase';
import type {
  Asset,
  Clip,
  ClipOperation,
  Frame,
  OverlayMark,
  Project,
  Track,
} from '../core/types';
import { createId, createTrack } from '../core/types';

/** 允许 AI 使用的属性路径（白名单，越界即拒绝）。 */
export type AIPropertyPath =
  | 'transform.scale'
  | 'transform.x'
  | 'transform.y'
  | 'transform.opacity'
  | 'transform.blendMode'
  | 'audio.gain';

export type AIIntent =
  | { kind: 'removeClip'; clipId: string }
  | { kind: 'removeRange'; clipId: string; startFrame: Frame; endFrame: Frame }
  | { kind: 'splitAt'; frame: Frame; clipId?: string }
  | { kind: 'moveClip'; clipId: string; startFrame: Frame; trackId?: string }
  | { kind: 'trimClip'; clipId: string; inFrame?: Frame; outFrame?: Frame }
  | { kind: 'setProperty'; clipId: string; path: AIPropertyPath; value: number | string }
  | { kind: 'addTrack'; trackKind: 'video' | 'audio'; name?: string }
  | { kind: 'muteTrack'; trackId: string; muted: boolean }
  | { kind: 'suggestCut'; frame: Frame; label: string }
  /**
   * R-060 智能粗剪：去掉长停顿。
   *
   * **不是**由编译器落地的意图——"哪里是停顿"要读音频能量，模型给不出帧号。
   * 命令栏会在调用模型前用本地规则拦下这条指令；模型若返回它，
   * 这里给出可读错误而不是"未知意图"。
   */
  | { kind: 'removeSilence'; minSilenceFrames: Frame };

export interface CompileSuccess {
  ok: true;
  ops: ClipOperation[];
  marks: OverlayMark[];
  /** 一句话可读描述（toast 用，R-046 要求含可读操作描述）。 */
  summary: string;
  /** 被跳过/被钳制的意图说明（不影响其余意图执行）。 */
  notes: string[];
}

export interface CompileFailure {
  ok: false;
  error: string;
}

export type CompileResult = CompileSuccess | CompileFailure;

const BLEND_MODES = new Set(['normal', 'overlay', 'screen', 'multiply']);

function findClip(doc: Project, clipId: string): Clip | null {
  for (const track of doc.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip !== undefined) return clip;
  }
  return null;
}

function trackOf(doc: Project, clipId: string): Track | null {
  return doc.tracks.find((track) => track.clips.some((clip) => clip.id === clipId)) ?? null;
}

function assetOf(doc: Project, clip: Clip): Asset | null {
  return doc.assets.find((asset) => asset.id === clip.assetId) ?? null;
}

function clampFrame(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 轨道上是否与 `[start, start+duration)` 重叠（排除自身）。 */
function overlaps(track: Track, clipId: string, start: number, duration: number): boolean {
  return track.clips.some((clip) => {
    if (clip.id === clipId) return false;
    const clipEnd = clip.startFrame + clip.durationFrames;
    return start < clipEnd && start + duration > clip.startFrame;
  });
}

/**
 * 把「剪掉区间」编译成操作。
 *
 * ## 语义：片内 ripple（剪完不留缝）
 *
 * "剪掉开头 3 秒" 之后，用户期望的是**这段内容没了、后面的接上来**，
 * 而不是原地留一个 3 秒的黑洞。因此：
 * - 剪头 → 只改素材入点（`trimClip` 左边缘），`startFrame` 不变；
 * - 剪尾 → 只改素材出点（右边缘）；
 * - 剪中间 → 切成两段、删中间、把后半段左移，前后正好相接。
 *
 * 三个分支都**保留原片段 id**（剪头/剪尾直接改原片段），这样连续两条指令
 * 还能引用同一个 `clipId`——模型不会知道"切完之后 id 变了"。
 */
function compileRemoveRange(doc: Project, intent: { clipId: string; startFrame: Frame; endFrame: Frame }): CompileResult {
  const clip = findClip(doc, intent.clipId);
  if (clip === null) return { ok: false, error: `找不到片段 ${intent.clipId}` };
  const asset = assetOf(doc, clip);
  if (asset === null) return { ok: false, error: '片段对应的素材不在工程里' };

  const clipEnd = clip.startFrame + clip.durationFrames;
  const start = clampFrame(intent.startFrame, clip.startFrame, clipEnd);
  const end = clampFrame(intent.endFrame, clip.startFrame, clipEnd);
  if (end - start < 1) return { ok: false, error: '要剪掉的区间不足 1 帧' };

  // 整段剪掉
  if (start === clip.startFrame && end === clipEnd) {
    return {
      ok: true,
      ops: [{ op: 'removeClip', clipId: clip.id, removed: clip }],
      marks: [],
      summary: `删掉 1 段（${clip.durationFrames} 帧）`,
      notes: [],
    };
  }

  // 剪头：只改素材入点，起点不动（避免把片段整体左移）
  if (start === clip.startFrame) {
    const assetIn = mapProjectFrameToAssetFrame(end, clip, asset, doc.fpsMilli);
    if (assetIn === null) return { ok: false, error: '剪点落在素材边界外' };
    const durationFrames = projectSpanFrames(clip.outFrame - assetIn, asset.fpsMilli, doc.fpsMilli, clip.speedMilli ?? 1000);
    if (durationFrames < 1) return { ok: false, error: '剪完不足 1 帧' };
    return {
      ok: true,
      ops: [
        {
          op: 'trimClip',
          clipId: clip.id,
          from: {
            inFrame: clip.inFrame,
            outFrame: clip.outFrame,
            startFrame: clip.startFrame,
            durationFrames: clip.durationFrames,
          },
          to: { inFrame: assetIn, outFrame: clip.outFrame, startFrame: clip.startFrame, durationFrames },
        },
      ],
      marks: [],
      summary: `剪掉开头 ${end - start} 帧`,
      notes: [],
    };
  }

  // 剪尾：只改素材出点
  if (end === clipEnd) {
    const assetOut = mapProjectFrameToAssetFrame(start, clip, asset, doc.fpsMilli);
    if (assetOut === null) return { ok: false, error: '剪点落在素材边界外' };
    const durationFrames = projectSpanFrames(assetOut - clip.inFrame, asset.fpsMilli, doc.fpsMilli, clip.speedMilli ?? 1000);
    if (durationFrames < 1) return { ok: false, error: '剪完不足 1 帧' };
    return {
      ok: true,
      ops: [
        {
          op: 'trimClip',
          clipId: clip.id,
          from: {
            inFrame: clip.inFrame,
            outFrame: clip.outFrame,
            startFrame: clip.startFrame,
            durationFrames: clip.durationFrames,
          },
          to: { inFrame: clip.inFrame, outFrame: assetOut, startFrame: clip.startFrame, durationFrames },
        },
      ],
      marks: [],
      summary: `剪掉结尾 ${end - start} 帧`,
      notes: [],
    };
  }

  // 剪中间：split(start) → split(end) → 删中间 → 后半段左移
  const track = trackOf(doc, clip.id);
  if (track === null) return { ok: false, error: '片段不在任何轨道上' };
  const ops: ClipOperation[] = [];
  let sim = doc;

  const firstSplit = buildSplitOperations(sim, start, clip.id);
  if (firstSplit.length === 0) return { ok: false, error: `第 ${start} 帧无法切分` };
  for (const op of firstSplit) sim = applyOperation(sim, op);
  ops.push(...firstSplit);
  const middleId = firstSplit[0]?.op === 'splitClip' ? firstSplit[0].newClipId : null;
  if (middleId === null) return { ok: false, error: '切分失败' };

  const secondSplit = buildSplitOperations(sim, end, middleId);
  if (secondSplit.length === 0) return { ok: false, error: `第 ${end} 帧无法切分` };
  for (const op of secondSplit) sim = applyOperation(sim, op);
  ops.push(...secondSplit);
  const tailId = secondSplit[0]?.op === 'splitClip' ? secondSplit[0].newClipId : null;
  if (tailId === null) return { ok: false, error: '切分失败' };

  const middle = findClip(sim, middleId);
  if (middle === null) return { ok: false, error: '切分后找不到中间段' };
  const removeOp: ClipOperation = { op: 'removeClip', clipId: middle.id, removed: middle };
  sim = applyOperation(sim, removeOp);
  ops.push(removeOp);

  const tail = findClip(sim, tailId);
  if (tail === null) return { ok: false, error: '切分后找不到后段' };
  const span = end - start;
  const movedStart = tail.startFrame - span;
  // 重叠判定必须看"删掉中间之后"的轨道状态，否则中间段还在，永远判重叠
  const simTrack = sim.tracks.find((candidate) => candidate.id === track.id) ?? track;
  if (overlaps(simTrack, tail.id, movedStart, tail.durationFrames)) {
    return { ok: false, error: '左移后与前面的片段重叠（该轨后面还有别的片段）' };
  }
  ops.push({
    op: 'moveClip',
    clipId: tail.id,
    from: { trackId: track.id, startFrame: tail.startFrame },
    to: { trackId: track.id, startFrame: movedStart },
  });

  return {
    ok: true,
    ops,
    marks: [],
    summary: `剪掉中间 ${span} 帧`,
    notes: [],
  };
}

function compileTrim(doc: Project, intent: { clipId: string; inFrame?: Frame; outFrame?: Frame }): CompileResult {
  const clip = findClip(doc, intent.clipId);
  if (clip === null) return { ok: false, error: `找不到片段 ${intent.clipId}` };
  const asset = assetOf(doc, clip);
  if (asset === null) return { ok: false, error: '片段对应的素材不在工程里' };
  const assetSpan = asset.durationFrames ?? Number.MAX_SAFE_INTEGER;
  const inFrame = intent.inFrame === undefined ? clip.inFrame : clampFrame(intent.inFrame, 0, assetSpan - 1);
  const outFrame = intent.outFrame === undefined ? clip.outFrame : clampFrame(intent.outFrame, 1, assetSpan);
  if (outFrame - inFrame < 1) return { ok: false, error: '裁剪后片段不足 1 帧' };

  // 左边缘改动会改变 startFrame（与 T16 裁剪同一口径）
  const startFrame =
    inFrame === clip.inFrame
      ? clip.startFrame
      : assetFrameToProjectFrame(inFrame, clip, asset, doc.fpsMilli);
  const durationFrames = projectSpanFrames(outFrame - inFrame, asset.fpsMilli, doc.fpsMilli, clip.speedMilli ?? 1000);
  return {
    ok: true,
    ops: [
      {
        op: 'trimClip',
        clipId: clip.id,
        from: {
          inFrame: clip.inFrame,
          outFrame: clip.outFrame,
          startFrame: clip.startFrame,
          durationFrames: clip.durationFrames,
        },
        to: { inFrame, outFrame, startFrame, durationFrames },
      },
    ],
    marks: [],
    summary: `裁剪 1 段（${durationFrames} 帧）`,
    notes: [],
  };
}

function compileSetProperty(
  doc: Project,
  intent: { clipId: string; path: AIPropertyPath; value: number | string },
): CompileResult {
  const clip = findClip(doc, intent.clipId);
  if (clip === null) return { ok: false, error: `找不到片段 ${intent.clipId}` };

  const numeric = typeof intent.value === 'number' ? intent.value : Number(intent.value);
  const ranges: Record<string, [number, number]> = {
    'transform.scale': [0.1, 5],
    'transform.x': [-10000, 10000],
    'transform.y': [-10000, 10000],
    'transform.opacity': [0, 1],
    'audio.gain': [0, 2],
  };

  if (intent.path === 'transform.blendMode') {
    const mode = String(intent.value);
    if (!BLEND_MODES.has(mode)) return { ok: false, error: `不支持的混合模式 ${mode}` };
  } else {
    const range = ranges[intent.path];
    if (range === undefined) return { ok: false, error: `不允许 AI 修改属性 ${intent.path}` };
    if (!Number.isFinite(numeric)) return { ok: false, error: `属性 ${intent.path} 的值不是数字` };
    if (numeric < range[0] || numeric > range[1]) {
      return { ok: false, error: `${intent.path} 超出范围（${range[0]}–${range[1]}）` };
    }
  }

  const current = readProperty(clip, intent.path);
  return {
    ok: true,
    ops: [
      {
        op: 'setClipProps',
        clipId: clip.id,
        path: intent.path,
        from: current,
        to: intent.path === 'transform.blendMode' ? String(intent.value) : numeric,
      },
    ],
    marks: [],
    summary: `调整 1 个属性（${intent.path}）`,
    notes: [],
  };
}

function readProperty(clip: Clip, path: AIPropertyPath): unknown {
  switch (path) {
    case 'transform.scale':
      return clip.transform.scale;
    case 'transform.x':
      return clip.transform.x;
    case 'transform.y':
      return clip.transform.y;
    case 'transform.opacity':
      return clip.transform.opacity;
    case 'transform.blendMode':
      return clip.transform.blendMode;
    case 'audio.gain':
      return clip.audio.gain;
    default:
      return null;
  }
}

/** 编译单条意图；返回 null 表示"这条跳过但不算失败"。 */
function compileOne(doc: Project, intent: AIIntent): CompileResult | null {
  switch (intent.kind) {
    case 'removeClip': {
      const clip = findClip(doc, intent.clipId);
      if (clip === null) return { ok: false, error: `找不到片段 ${intent.clipId}` };
      return {
        ok: true,
        ops: [{ op: 'removeClip', clipId: clip.id, removed: clip }],
        marks: [],
        summary: `删掉 1 段（${clip.durationFrames} 帧）`,
        notes: [],
      };
    }
    case 'removeRange':
      return compileRemoveRange(doc, intent);
    case 'splitAt': {
      const ops = buildSplitOperations(doc, intent.frame, intent.clipId ?? null);
      if (ops.length === 0) return { ok: false, error: `第 ${intent.frame} 帧处没有可切分的片段` };
      return { ok: true, ops, marks: [], summary: `切分 ${ops.length} 段`, notes: [] };
    }
    case 'moveClip': {
      const clip = findClip(doc, intent.clipId);
      if (clip === null) return { ok: false, error: `找不到片段 ${intent.clipId}` };
      const fromTrack = trackOf(doc, clip.id);
      if (fromTrack === null) return { ok: false, error: '片段不在任何轨道上' };
      const targetTrack = intent.trackId === undefined ? fromTrack : doc.tracks.find((track) => track.id === intent.trackId);
      if (targetTrack === undefined) return { ok: false, error: `找不到轨道 ${intent.trackId}` };
      if (targetTrack.kind !== fromTrack.kind) return { ok: false, error: '视频片段不能放到音轨上（反之亦然）' };
      const start = clampFrame(intent.startFrame, 0, Number.MAX_SAFE_INTEGER);
      if (overlaps(targetTrack, clip.id, start, clip.durationFrames)) {
        return { ok: false, error: `第 ${start} 帧处会与已有片段重叠` };
      }
      return {
        ok: true,
        ops: [
          {
            op: 'moveClip',
            clipId: clip.id,
            from: { trackId: fromTrack.id, startFrame: clip.startFrame },
            to: { trackId: targetTrack.id, startFrame: start },
          },
        ],
        marks: [],
        summary: `移动 1 段到第 ${start} 帧`,
        notes: [],
      };
    }
    case 'trimClip':
      return compileTrim(doc, intent);
    case 'setProperty':
      return compileSetProperty(doc, intent);
    case 'addTrack': {
      const sameKind = doc.tracks.filter((track) => track.kind === intent.trackKind);
      const defaultName =
        intent.trackKind === 'video'
          ? `V${sameKind.length + 1}`
          : `A${sameKind.length + 1}`;
      const track = createTrack({
        id: createId('trk'),
        kind: intent.trackKind,
        name: intent.name ?? defaultName,
        order: sameKind.length,
      });
      return { ok: true, ops: [{ op: 'addTrack', track }], marks: [], summary: `新增 1 条轨道`, notes: [] };
    }
    case 'muteTrack': {
      const track = doc.tracks.find((candidate) => candidate.id === intent.trackId);
      if (track === undefined) return { ok: false, error: `找不到轨道 ${intent.trackId}` };
      if (track.muted === intent.muted) return null;
      return {
        ok: true,
        ops: [{ op: 'setTrackFlag', trackId: track.id, flag: 'muted', from: track.muted, to: intent.muted }],
        marks: [],
        summary: intent.muted ? '静音 1 条轨道' : '取消静音 1 条轨道',
        notes: [],
      };
    }
    case 'suggestCut': {
      const frame = clampFrame(intent.frame, 0, Number.MAX_SAFE_INTEGER);
      const mark: OverlayMark = {
        id: createId('mark'),
        frame,
        kind: 'suggestedCut',
        label: intent.label,
        actionable: true,
      };
      return { ok: true, ops: [], marks: [mark], summary: `建议在第 ${frame} 帧切`, notes: [] };
    }
    case 'removeSilence':
      return {
        ok: false,
        error: '「去掉停顿」需要先分析音频能量，不能直接编译；请用命令栏执行（本地分析）',
      };

    default: {
      const exhaustive: never = intent;
      return { ok: false, error: `未知意图 ${JSON.stringify(exhaustive)}` };
    }
  }
}

/**
 * 编译意图数组。
 *
 * 语义：**任一条意图非法即整条拒绝**（不做部分执行）。
 * 理由是"AI 改片"必须是全有或全无——部分执行会让用户看到半个结果，还说不清哪句没生效。
 */
export function compileIntents(doc: Project, intents: readonly AIIntent[]): CompileResult {
  if (intents.length === 0) return { ok: false, error: '没有可执行的修改' };
  const ops: ClipOperation[] = [];
  const marks: OverlayMark[] = [];
  const notes: string[] = [];
  const summaries: string[] = [];
  let sim = doc;

  for (const intent of intents) {
    const compiled = compileOne(sim, intent);
    if (compiled === null) continue;
    if (!compiled.ok) return { ok: false, error: compiled.error };
    // 同一批意图之间要串行叠加：后一条必须看到前一条的结果（否则两刀切在同一片段会打架）
    for (const op of compiled.ops) sim = applyOperation(sim, op);
    ops.push(...compiled.ops);
    marks.push(...compiled.marks);
    summaries.push(compiled.summary);
    notes.push(...compiled.notes);
  }

  if (ops.length === 0 && marks.length === 0) return { ok: false, error: '没有产生任何修改' };
  return { ok: true, ops, marks, summary: summaries.join('；'), notes };
}

/** 生成"采纳建议"时的操作：把建议切点变成真正的切分。 */
export function compileMarkAcceptance(doc: Project, frame: Frame): CompileResult {
  return compileIntents(doc, [{ kind: 'splitAt', frame }]);
}
