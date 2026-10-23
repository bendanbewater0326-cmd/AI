/**
 * 剪辑操作层（架构 §2 / §7.4 / §7.6）。
 *
 * 三个纯函数 + 一个工程参数全量重算：
 *   - `applyOperation(doc, op)`  → 新 doc（不可变替换，不修改入参）
 *   - `invertOperation(op, doc)` → 逆向操作数组（按数组顺序应用即可还原）
 *   - `describeOperation(op)`    → 可读中文 label（R-046）
 *   - `recomputeProject(doc, params)` → 改工程帧率/尺寸后的全量重算（§7.6）
 *
 * 本文件不碰 DOM / IndexedDB / WebCodecs，可在纯 Node 环境单测。
 * `invertOperation` 对 `splitClip` 需要 doc 上下文（要还原被切开的两段），这是唯一带上下文的签名，
 * 其余操作自包含（op 内已带 `from` / `removed` / `track`），因此撤销栈无需快照整份 doc。
 */
import { TRACK_MAX_HEIGHT, TRACK_MIN_HEIGHT } from './trackLayout';
import type {
  Clip,
  ClipOperation,
  Frame,
  MilliFps,
  Project,
  ProjectParams,
  Track,
  TrimState,
} from './types';
import { projectSpanFrames } from './timebase';

/* ---------------- 内部工具 ---------------- */

/** 定位片段（跨轨查找）。 */
function findClip(doc: Project, clipId: string): { track: Track; clip: Clip } {
  for (const track of doc.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return { track, clip };
  }
  throw new Error(`operations: 片段不存在 ${clipId}`);
}

/** 定位轨道。 */
function findTrack(doc: Project, trackId: string): Track {
  const track = doc.tracks.find((candidate) => candidate.id === trackId);
  if (!track) throw new Error(`operations: 轨道不存在 ${trackId}`);
  return track;
}

/** 按 `startFrame` 升序插入（同帧用 id 稳定排序），并保证 id 不重复。 */
function insertClipSorted(clips: readonly Clip[], clip: Clip): Clip[] {
  const next = clips.filter((candidate) => candidate.id !== clip.id);
  next.push(clip);
  next.sort((left, right) => {
    if (left.startFrame !== right.startFrame) return left.startFrame - right.startFrame;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return next;
}

/** 用一次映射替换全部轨道（保持 doc 其他字段引用不变）。 */
function mapTracks(doc: Project, mapper: (track: Track) => Track): Project {
  return { ...doc, tracks: doc.tracks.map(mapper) };
}

/**
 * 轨道数组的规范顺序：按 `order` 升序，同 order 再按 id 稳定排序。
 *
 * 为什么需要：`addTrack` / `removeTrack` 必须互为精确逆操作（撤销后数组顺序也要一致），
 * 因此轨道数组始终维持这个规范顺序；**视觉层级只由 `order` 决定**（`orderTracks` 再排一次）。
 */
function sortTracks(tracks: readonly Track[]): Track[] {
  return [...tracks].sort((left, right) => {
    if (left.order !== right.order) return left.order - right.order;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/** 把某个片段写回它所在的轨道（按 startFrame 重新排序）。 */
function writeClip(doc: Project, clip: Clip): Project {
  return mapTracks(doc, (track) =>
    track.clips.some((candidate) => candidate.id === clip.id)
      ? { ...track, clips: insertClipSorted(track.clips, clip) }
      : track,
  );
}

/** 从 doc 中摘掉一个片段，返回新 doc 与被摘掉的片段。 */
function takeClip(doc: Project, clipId: string): { doc: Project; trackId: string; removed: Clip } {
  const { track, clip } = findClip(doc, clipId);
  const next = mapTracks(doc, (candidate) =>
    candidate.id === track.id
      ? { ...candidate, clips: candidate.clips.filter((item) => item.id !== clipId) }
      : candidate,
  );
  return { doc: next, trackId: track.id, removed: clip };
}

/** 断言：片段时长 ≥ 1 且不越素材边界（由调用方保证）。 */
function assertTrimState(state: TrimState, label: string): void {
  if (state.outFrame - state.inFrame < 1) {
    throw new Error(`operations: ${label} 的素材跨度必须 ≥ 1 帧`);
  }
  if (state.durationFrames < 1) {
    throw new Error(`operations: ${label} 的项目时长必须 ≥ 1 帧`);
  }
  if (state.startFrame < 0) {
    throw new Error(`operations: ${label} 的 startFrame 不允许为负`);
  }
}

/** 不可变地沿 `a.b.c` 路径写值（只克隆路径上的对象）。 */
function writePath(
  node: Record<string, unknown>,
  keys: string[],
  index: number,
  value: unknown,
): Record<string, unknown> {
  const key = keys[index];
  if (key === undefined) throw new Error('operations: setClipProps 的 path 为空');
  if (index === keys.length - 1) {
    return { ...node, [key]: value };
  }
  const child = node[key];
  if (child === null || typeof child !== 'object' || Array.isArray(child)) {
    throw new Error(`operations: setClipProps 的 path 无法穿透 "${keys.slice(0, index + 1).join('.')}"`);
  }
  return {
    ...node,
    [key]: writePath(child as Record<string, unknown>, keys, index + 1, value),
  };
}

/** 比率重标定（帧率×帧数的比例映射，不是帧↔时间换算，因此不进 timebase）。 */
function divRoundHalfUpRatio(a: number, b: number): number {
  return Math.floor((2 * a + b) / (2 * b));
}

/** 按新帧率等比映射一个帧号（half-up）。 */
function scaleFrame(frame: Frame, toMilliFps: MilliFps, fromMilliFps: MilliFps): Frame {
  if (toMilliFps === fromMilliFps) return frame;
  return divRoundHalfUpRatio(frame * toMilliFps, fromMilliFps);
}

/** 从片段当前状态取出 TrimState。 */
function trimStateOf(clip: Clip): TrimState {
  return {
    inFrame: clip.inFrame,
    outFrame: clip.outFrame,
    startFrame: clip.startFrame,
    durationFrames: clip.durationFrames,
  };
}

/* ---------------- apply ---------------- */

/**
 * 应用一条操作，返回**新** doc（不可变，入参 doc 不被修改）。
 *
 * 不做合法性兜底（重叠/跨轨类型由 timelineController 负责），但会校验结构性不变量：
 * 片段必须存在、轨道必须存在、素材跨度必须 ≥ 1 帧、切分两侧帧数之和必须守恒（R-016）。
 */
/**
 * 这个操作会动到哪些轨（**只对"改片段"的操作返回轨道**）。
 *
 * 用于锁定轨的中央守卫：`locked` 的语义是"这条轨上的片段不许改"，
 * 但它是**轨道属性**，散在每个操作里各判一次迟早漏（漏一个就等于锁是假的）。
 * 所以在这里列一张"操作 → 受影响轨"的表，`applyOperation` 入口统一判一次。
 *
 * 轨道级操作（`setTrackFlag` / `renameTrack` / `removeTrack`）**不返回轨道**：
 * 解锁、改名、删轨本身必须能在锁定状态下完成，否则锁上就再也解不开了。
 */
function clipTracksForOp(doc: Project, op: ClipOperation): Track[] {
  const byClipId = (clipId: string): Track[] => [findClip(doc, clipId).track];
  switch (op.op) {
    case 'addClip':
      return [findTrack(doc, op.clip.trackId)];
    case 'removeClip':
    case 'trimClip':
    case 'splitClip':
    case 'setClipProps':
    case 'setClipEffect':
    case 'setClipText':
    case 'setClipTransition':
    case 'setClipKeyframes':
    case 'setClipSpeed':
      return byClipId(op.clipId);
    case 'moveClip': {
      // 移出和移入的两条轨都要解锁：从锁定轨上"拿走"片段同样是改动
      const from = findClip(doc, op.clipId).track;
      const to = findTrack(doc, op.to.trackId);
      return from.id === to.id ? [from] : [from, to];
    }
    case 'rippleShift': {
      const tracks = new Set<Track>();
      for (const shift of op.shifts) tracks.add(findClip(doc, shift.clipId).track);
      return [...tracks];
    }
    default:
      return [];
  }
}

/**
 * 锁定轨导致的拒绝（**专门一个错误类型**）。
 *
 * 为什么要单独一个类：`store.record` 需要区分"用户操作被规则拒绝"（转成错误条给用户看）
 * 和"代码写错了"（必须抛出去，在测试里炸掉）。如果统一 catch，非法参数这类 bug
 * 会变成一条不起眼的错误条，测试再也抓不到——本项目最怕的就是"静默失败"。
 */
export class TrackLockedError extends Error {
  constructor(trackName: string) {
    super(`operations: 轨道 ${trackName} 已锁定，不能修改其上的片段`);
    this.name = 'TrackLockedError';
  }
}

/** 锁定轨上的片段不许改：抛错而不是静默忽略（静默会让用户以为操作生效了）。 */
function assertUnlocked(doc: Project, op: ClipOperation): void {
  for (const track of clipTracksForOp(doc, op)) {
    if (track.locked) throw new TrackLockedError(track.name);
  }
}

export function applyOperation(doc: Project, op: ClipOperation): Project {
  assertUnlocked(doc, op);
  switch (op.op) {
    case 'addClip': {
      findTrack(doc, op.clip.trackId);
      return mapTracks(doc, (track) =>
        track.id === op.clip.trackId
          ? { ...track, clips: insertClipSorted(track.clips, op.clip) }
          : track,
      );
    }

    case 'removeClip': {
      const result = takeClip(doc, op.clipId);
      return result.doc;
    }

    case 'moveClip': {
      const { track, clip } = findClip(doc, op.clipId);
      findTrack(doc, op.to.trackId);
      if (op.to.startFrame < 0) {
        throw new Error('operations: moveClip 的 startFrame 不允许为负');
      }
      if (track.id === op.to.trackId) {
        return writeClip(doc, { ...clip, startFrame: op.to.startFrame });
      }
      const stripped = mapTracks(doc, (candidate) =>
        candidate.id === track.id
          ? { ...candidate, clips: candidate.clips.filter((item) => item.id !== clip.id) }
          : candidate,
      );
      const moved: Clip = { ...clip, trackId: op.to.trackId, startFrame: op.to.startFrame };
      return mapTracks(stripped, (candidate) =>
        candidate.id === op.to.trackId
          ? { ...candidate, clips: insertClipSorted(candidate.clips, moved) }
          : candidate,
      );
    }

    case 'trimClip': {
      const { clip } = findClip(doc, op.clipId);
      assertTrimState(op.to, 'trimClip');
      if (op.to.inFrame < 0 || op.to.durationFrames < 1) {
        throw new Error('operations: trimClip 结果非法');
      }
      return writeClip(doc, {
        ...clip,
        inFrame: op.to.inFrame,
        outFrame: op.to.outFrame,
        startFrame: op.to.startFrame,
        durationFrames: op.to.durationFrames,
      });
    }

    case 'splitClip': {
      const { clip } = findClip(doc, op.clipId);
      assertTrimState(op.left, 'splitClip.left');
      assertTrimState(op.right, 'splitClip.right');
      if (op.left.durationFrames + op.right.durationFrames !== clip.durationFrames) {
        throw new Error(
          `operations: 切分帧数不守恒（${op.left.durationFrames} + ${op.right.durationFrames} ≠ ${clip.durationFrames}）`,
        );
      }
      if (op.right.startFrame !== op.left.startFrame + op.left.durationFrames) {
        throw new Error('operations: 切分右侧起点必须紧接左侧终点');
      }
      if (op.right.inFrame !== op.left.outFrame) {
        throw new Error('operations: 切分右侧入点必须等于左侧出点');
      }
      if (op.atProjectFrame !== op.right.startFrame) {
        throw new Error('operations: 切分点必须等于右侧起点');
      }
      const leftClip: Clip = {
        ...clip,
        inFrame: op.left.inFrame,
        outFrame: op.left.outFrame,
        startFrame: op.left.startFrame,
        durationFrames: op.left.durationFrames,
      };
      const rightClip: Clip = {
        ...clip,
        id: op.newClipId,
        inFrame: op.right.inFrame,
        outFrame: op.right.outFrame,
        startFrame: op.right.startFrame,
        durationFrames: op.right.durationFrames,
      };
      return mapTracks(doc, (track) => {
        if (track.id !== clip.trackId) return track;
        const withoutOriginal = track.clips.filter(
          (candidate) => candidate.id !== leftClip.id && candidate.id !== rightClip.id,
        );
        const withLeft = insertClipSorted(withoutOriginal, leftClip);
        return { ...track, clips: insertClipSorted(withLeft, rightClip) };
      });
    }

    case 'setClipProps': {
      const { clip } = findClip(doc, op.clipId);
      if (op.path.trim().length === 0) {
        throw new Error('operations: setClipProps 的 path 不能为空');
      }
      const keys = op.path.split('.').filter((key) => key.length > 0);
      const nextClip = writePath(
        clip as unknown as Record<string, unknown>,
        keys,
        0,
        op.to,
      ) as unknown as Clip;
      return writeClip(doc, nextClip);
    }

    case 'setClipEffect': {
      const { clip } = findClip(doc, op.clipId);
      const rest = clip.effects.filter((effect) => effect.type !== op.effectType);
      if (op.to === null) return writeClip(doc, { ...clip, effects: rest });
      // 同一类型只允许一个实例：调色是"一组参数"，不是可以叠加多份的滤镜链
      return writeClip(doc, { ...clip, effects: [...rest, { ...op.to, clipId: clip.id }] });
    }

    case 'setClipText': {
      const { clip } = findClip(doc, op.clipId);
      return writeClip(doc, { ...clip, text: op.to });
    }

    case 'setClipKeyframes': {
      const { clip } = findClip(doc, op.clipId);
      return writeClip(doc, { ...clip, keyframes: [...op.to] });
    }

    case 'setClipSpeed': {
      const { clip } = findClip(doc, op.clipId);
      if (!Number.isInteger(op.to) || op.to < 1) {
        throw new Error(`operations: setClipSpeed 的 speedMilli 必须是正整数，收到 ${String(op.to)}`);
      }
      const asset = doc.assets.find((item) => item.id === clip.assetId);
      if (asset === undefined) {
        throw new Error(`operations: setClipSpeed 找不到素材 ${clip.assetId}`);
      }
      // 变速只改"占用的项目时长"，素材起止点（in/out）绝不动——与 T17 的切分守恒同一条纪律：
      // 为了凑数字改 in/out 会让素材尾帧永久丢失。
      const durationFrames = projectSpanFrames(
        clip.outFrame - clip.inFrame,
        asset.fpsMilli,
        doc.fpsMilli,
        op.to,
      );
      return writeClip(doc, { ...clip, speedMilli: op.to, durationFrames });
    }

    case 'setClipTransition': {
      const { clip } = findClip(doc, op.clipId);
      return writeClip(
        doc,
        op.side === 'in' ? { ...clip, transitionIn: op.to } : { ...clip, transitionOut: op.to },
      );
    }

    case 'addTrack': {
      if (doc.tracks.some((track) => track.id === op.track.id)) {
        throw new Error(`operations: 轨道已存在 ${op.track.id}`);
      }
      return { ...doc, tracks: sortTracks([...doc.tracks, op.track]) };
    }

    case 'removeTrack': {
      findTrack(doc, op.trackId);
      return { ...doc, tracks: sortTracks(doc.tracks.filter((track) => track.id !== op.trackId)) };
    }

    case 'renameTrack': {
      findTrack(doc, op.trackId);
      return mapTracks(doc, (track) =>
        track.id === op.trackId ? { ...track, name: op.to } : track,
      );
    }

    case 'setTrackHeight': {
      const track = findTrack(doc, op.trackId);
      /**
       * 夹在 24–120（与 `core/trackLayout` 同一区间）。
       *
       * **在 apply 里夹而不是在 UI 里夹**：高度会进工程文件、也可能被 Agent 改，
       * 任何一条路径漏夹就会写进一个 5000px 的轨道，打开工程时整条时间线是空的
       * （内容全在视口外）。文档永远合法，比"每个调用方都记得夹"可靠。
       */
      const height = Math.min(TRACK_MAX_HEIGHT, Math.max(TRACK_MIN_HEIGHT, Math.round(op.to)));
      return mapTracks(doc, (item) => (item.id === track.id ? { ...item, height } : item));
    }

    case 'reorderTracks': {
      const next = new Map(op.changes.map((change) => [change.trackId, change.to]));
      for (const change of op.changes) findTrack(doc, change.trackId);
      return {
        ...doc,
        tracks: sortTracks(doc.tracks.map((track) => {
          const order = next.get(track.id);
          return order === undefined ? track : { ...track, order };
        })),
      };
    }

    case 'setTrackFlag': {
      findTrack(doc, op.trackId);
      return mapTracks(doc, (track) =>
        track.id === op.trackId ? { ...track, [op.flag]: op.to } : track,
      );
    }

    case 'removeAsset': {
      if (!doc.assets.some((asset) => asset.id === op.assetId)) {
        throw new Error(`operations: 素材不存在 ${op.assetId}`);
      }
      // 素材与其片段一起消失：留着片段就是"引用不存在的素材"，渲染层只会黑屏 + 报错
      let next = doc;
      for (const clip of op.removedClips) {
        next = mapTracks(next, (track) =>
          track.id === clip.trackId
            ? { ...track, clips: track.clips.filter((item) => item.id !== clip.id) }
            : track,
        );
      }
      return { ...next, assets: next.assets.filter((asset) => asset.id !== op.assetId) };
    }

    case 'restoreAsset': {
      if (doc.assets.some((asset) => asset.id === op.asset.id)) {
        throw new Error(`operations: 素材已存在 ${op.asset.id}`);
      }
      let next = { ...doc, assets: [...doc.assets, op.asset] };
      for (const clip of op.clips) {
        next = mapTracks(next, (track) =>
          track.id === clip.trackId ? { ...track, clips: insertClipSorted(track.clips, clip) } : track,
        );
      }
      return next;
    }

    case 'rippleShift': {
      const targets = new Map<string, Frame>();
      for (const shift of op.shifts) {
        if (shift.to < 0) throw new Error('operations: rippleShift 目标帧不允许为负');
        findClip(doc, shift.clipId); // 校验存在性（不存在即编程错误）
        targets.set(shift.clipId, shift.to);
      }
      if (targets.size === 0) return doc;
      return mapTracks(doc, (track) => {
        let touched = false;
        const clips = track.clips.map((clip) => {
          const nextStart = targets.get(clip.id);
          if (nextStart === undefined || nextStart === clip.startFrame) return clip;
          touched = true;
          return { ...clip, startFrame: nextStart };
        });
        if (!touched) return track;
        const sorted = [...clips].sort((left, right) =>
          left.startFrame !== right.startFrame
            ? left.startFrame - right.startFrame
            : left.id < right.id
              ? -1
              : 1,
        );
        return { ...track, clips: sorted };
      });
    }

    case 'setProjectParams': {
      return recomputeProject(doc, op.to).doc;
    }

    default: {
      const exhaustive: never = op;
      throw new Error(`operations: 未知操作 ${JSON.stringify(exhaustive)}`);
    }
  }
}

/* ---------------- invert ---------------- */

/**
 * 生成逆向操作（数组顺序即应用顺序）。
 *
 * 大部分操作返回 1 条；`splitClip` 返回 2 条（先把原片段恢复成完整跨度，再删掉右半段）。
 * `splitClip` 需要 `doc`（切分后）上下文来取右半段的完整片段对象。
 */
export function invertOperation(op: ClipOperation, doc?: Project): ClipOperation[] {
  switch (op.op) {
    case 'addClip':
      return [{ op: 'removeClip', clipId: op.clip.id, removed: op.clip }];

    case 'removeClip':
      return [{ op: 'addClip', clip: op.removed }];

    case 'moveClip':
      return [{ op: 'moveClip', clipId: op.clipId, from: op.to, to: op.from }];

    case 'trimClip':
      return [{ op: 'trimClip', clipId: op.clipId, from: op.to, to: op.from }];

    case 'splitClip': {
      if (!doc) {
        throw new Error('operations: splitClip 的逆操作需要 doc 上下文');
      }
      const rightClip = findClip(doc, op.newClipId).clip;
      const original: TrimState = {
        inFrame: op.left.inFrame,
        outFrame: op.right.outFrame,
        startFrame: op.left.startFrame,
        durationFrames: op.left.durationFrames + op.right.durationFrames,
      };
      return [
        { op: 'trimClip', clipId: op.clipId, from: op.left, to: original },
        { op: 'removeClip', clipId: op.newClipId, removed: rightClip },
      ];
    }

    case 'setClipProps':
      return [{ op: 'setClipProps', clipId: op.clipId, path: op.path, from: op.to, to: op.from }];

    case 'setClipSpeed':
      return [{ op: 'setClipSpeed', clipId: op.clipId, from: op.to, to: op.from }];

    case 'setClipEffect':
      return [
        {
          op: 'setClipEffect',
          clipId: op.clipId,
          effectType: op.effectType,
          from: op.to,
          to: op.from,
        },
      ];

    case 'setClipText':
      return [{ op: 'setClipText', clipId: op.clipId, from: op.to, to: op.from }];

    case 'setClipKeyframes':
      return [{ op: 'setClipKeyframes', clipId: op.clipId, from: op.to, to: op.from }];

    case 'setClipTransition':
      return [
        { op: 'setClipTransition', clipId: op.clipId, side: op.side, from: op.to, to: op.from },
      ];

    case 'addTrack':
      return [{ op: 'removeTrack', trackId: op.track.id, removed: op.track }];

    case 'removeTrack':
      return [{ op: 'addTrack', track: op.removed }];

    case 'renameTrack':
      return [{ op: 'renameTrack', trackId: op.trackId, from: op.to, to: op.from }];

    case 'setTrackFlag':
      return [{ op: 'setTrackFlag', trackId: op.trackId, flag: op.flag, from: op.to, to: op.from }];

    case 'setTrackHeight':
      return [{ op: 'setTrackHeight', trackId: op.trackId, from: op.to, to: op.from }];

    case 'reorderTracks':
      return [
        {
          op: 'reorderTracks',
          changes: op.changes.map((change) => ({
            trackId: change.trackId,
            from: change.to,
            to: change.from,
          })),
        },
      ];

    case 'removeAsset':
      return [{ op: 'restoreAsset', asset: op.removed, clips: op.removedClips }];

    case 'restoreAsset':
      return [
        { op: 'removeAsset', assetId: op.asset.id, removed: op.asset, removedClips: op.clips },
      ];

    case 'rippleShift':
      return [
        {
          op: 'rippleShift',
          shifts: op.shifts.map((shift) => ({
            clipId: shift.clipId,
            from: shift.to,
            to: shift.from,
          })),
        },
      ];

    case 'setProjectParams':
      return [{ op: 'setProjectParams', from: op.to, to: op.from }];

    default: {
      const exhaustive: never = op;
      throw new Error(`operations: 未知操作 ${JSON.stringify(exhaustive)}`);
    }
  }
}

/* ---------------- describe ---------------- */

/** 可读中文描述（撤销菜单/错误条用，R-046）。 */
export function describeOperation(op: ClipOperation): string {
  switch (op.op) {
    case 'addClip':
      return '添加片段';
    case 'removeClip':
      return '删除片段';
    case 'moveClip':
      return op.from.trackId === op.to.trackId ? '移动片段' : '跨轨移动片段';
    case 'trimClip':
      return '裁剪片段';
    case 'splitClip':
      return '切分片段';
    case 'setClipProps':
      return `修改${describePropertyPath(op.path)}`;
    case 'setClipEffect':
      return op.to === null ? '移除效果' : `调整${op.effectType === 'colorGrade' ? '调色' : op.effectType}`;
    case 'setClipText':
      return op.to === null ? '移除文字' : '编辑文字';
    case 'setClipTransition':
      return op.to === null ? '移除转场' : `设置转场（${op.to.type}）`;
    case 'setClipKeyframes':
      return op.to.length > op.from.length ? '添加关键帧' : '删除关键帧';
    case 'setClipSpeed': {
      // timebase-allow: 仅 UI 文案显示倍速，不参与任何帧换算
      const factor = (op.to / 1000).toFixed(2).replace(/\.?0+$/, '');
      return `修改速度 ${factor}x`;
    }
    case 'addTrack':
      return '添加轨道';
    case 'removeTrack':
      return '移除轨道';
    case 'renameTrack':
      return '重命名轨道';
    case 'removeAsset':
      return op.removedClips.length === 0
        ? '删除素材'
        : `删除素材（含 ${op.removedClips.length} 个片段）`;
    case 'restoreAsset':
      return '恢复素材';
    case 'setTrackFlag':
      return op.flag === 'muted'
        ? op.to
          ? '静音轨道'
          : '取消静音'
        : op.flag === 'hidden'
          ? op.to
            ? '隐藏轨道'
            : '显示轨道'
          : op.flag === 'solo'
            ? op.to
              ? '独奏轨道'
              : '取消独奏'
            : op.to
              ? '锁定轨道'
              : '解锁轨道';
    case 'setTrackHeight':
      return '调整轨道高度';
    case 'reorderTracks':
      return '调整轨道顺序';
    case 'rippleShift':
      return '波纹删除';
    case 'setProjectParams': {
      // timebase-allow: 仅用于 UI 文案显示帧率，不参与任何帧换算
      const fpsText = (op.to.fpsMilli / 1000).toFixed(3).replace(/\.?0+$/, '');
      return `修改工程参数（${op.to.width}×${op.to.height} · ${fpsText}fps）`;
    }
    default: {
      const exhaustive: never = op;
      throw new Error(`operations: 未知操作 ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** 属性路径 → 中文名。 */
function describePropertyPath(path: string): string {
  switch (path) {
    case 'transform.scale':
      return '缩放';
    case 'transform.x':
      return '位置 X';
    case 'transform.y':
      return '位置 Y';
    case 'transform.opacity':
      return '不透明度';
    case 'transform.blendMode':
      return '混合模式';
    case 'audio.gain':
      return '音量';
    case 'enabled':
      return '片段启用';
    default:
      return `属性 ${path}`;
  }
}

/* ---------------- 工程参数全量重算（§7.6） ---------------- */

export interface RecomputeResult {
  doc: Project;
  /** 等价的操作序列（1 条 setProjectParams + N 条 trimClip），便于整批进 1 个撤销步。 */
  ops: ClipOperation[];
}

/** `previewRecompute` 的结果：给 R-015 二次确认弹窗用的影响面 + 完整结果。 */
export interface RecomputePreview extends RecomputeResult {
  /** `startFrame` 或 `durationFrames` 会发生变化的片段数。 */
  affectedClipCount: number;
  /** 所有片段里 `|newStart - oldStart|` 的最大值（帧）。 */
  maxShiftFrames: number;
}

/** 工程总时长（项目帧）：所有轨道最后一个片段的末帧。 */
export function computeDurationFrames(doc: Project): Frame {
  let durationFrames = 0;
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      const end = clip.startFrame + clip.durationFrames;
      if (end > durationFrames) durationFrames = end;
    }
  }
  return durationFrames;
}

/**
 * 改工程参数的**预演**（不落地）：给 R-015 的二次确认弹窗提供两个有信息量的数字（§7.6）。
 *
 * 返回：
 *   - `affectedClipCount`：`startFrame` 或 `durationFrames` 会变化的片段数；
 *   - `maxShiftFrames`：所有片段里 `|newStart - oldStart|` 的最大值（帧）；
 *   - 以及完整结果 `doc` 与等价操作序列 `ops`（确认后可直接 dispatch）。
 *
 * 纯函数、不改入参；禁止 UI 自己写"已有片段将重新换算"这种无信息文案。
 */
export function previewRecompute(doc: Project, params: ProjectParams): RecomputePreview {
  const { doc: nextDoc, ops } = recomputeProject(doc, params);
  const beforeClips = new Map<string, Clip>();
  for (const track of doc.tracks) {
    for (const clip of track.clips) beforeClips.set(clip.id, clip);
  }
  let affectedClipCount = 0;
  let maxShiftFrames = 0;
  for (const track of nextDoc.tracks) {
    for (const clip of track.clips) {
      const previous = beforeClips.get(clip.id);
      if (!previous) continue;
      const shift = Math.abs(clip.startFrame - previous.startFrame);
      if (shift > 0 || clip.durationFrames !== previous.durationFrames) {
        affectedClipCount += 1;
      }
      if (shift > maxShiftFrames) maxShiftFrames = shift;
    }
  }
  return { affectedClipCount, maxShiftFrames, ops, doc: nextDoc };
}

/**
 * 改工程参数后的全量重算（R-015 / §7.6）。纯函数、幂等。
 *
 * 固定顺序（决策已冻结：**保间隙 + 只贴紧 + 不级联**，明确否决整轨右推）：
 *   1. 写入新 `fpsMilli / width / height`；
 *   2. 逐片段重算 `durationFrames = projectSpanFrames(outFrame - inFrame, asset.fpsMilli, newFps)`
 *      —— **素材跨度不变**（不丢帧），只有项目帧表示变化；
 *   3. `newStartFrame = divRoundHalfUp(oldStart * newFps, oldFps)`（**按绝对时间等比映射**，
 *      原有间隙自动保留；分子永远是**新帧率**，写反会把整条时间线拉长/压扁）；
 *   4. **只在取整冲突时贴紧**：`newStart < 同轨前一片段 newEnd` 时取 `newEnd`（位移 ≤ 1 帧），
 *      不做级联右推、不删间隙；
 *   5. `playheadFrame` 同向映射并 clamp 到 `[0, durationFrames - 1]`；
 *   6. 整批作为 1 条 `setProjectParams` 进撤销栈（由 store 保证）。
 *
 * 幂等性：同一 params 再算一次，所有值不变（数组顺序稳定）。
 */
export function recomputeProject(doc: Project, params: ProjectParams): RecomputeResult {
  if (!Number.isInteger(params.fpsMilli) || params.fpsMilli <= 0) {
    throw new Error(`operations: fpsMilli 必须是正整数，收到 ${params.fpsMilli}`);
  }
  if (!Number.isInteger(params.width) || params.width <= 0) {
    throw new Error(`operations: width 必须是正整数，收到 ${params.width}`);
  }
  if (!Number.isInteger(params.height) || params.height <= 0) {
    throw new Error(`operations: height 必须是正整数，收到 ${params.height}`);
  }

  const fromParams: ProjectParams = {
    fpsMilli: doc.fpsMilli,
    width: doc.width,
    height: doc.height,
  };
  const ops: ClipOperation[] = [{ op: 'setProjectParams', from: fromParams, to: params }];
  const assetsById = new Map(doc.assets.map((asset) => [asset.id, asset]));

  const tracks: Track[] = doc.tracks.map((track) => {
    const ordered = [...track.clips].sort((left, right) =>
      left.startFrame !== right.startFrame
        ? left.startFrame - right.startFrame
        : left.id < right.id
          ? -1
          : 1,
    );
    let previousEnd = 0;
    const clips: Clip[] = ordered.map((clip) => {
      const asset = assetsById.get(clip.assetId);
      const durationFrames = asset
        ? projectSpanFrames(clip.outFrame - clip.inFrame, asset.fpsMilli, params.fpsMilli, clip.speedMilli ?? 1000)
        : clip.durationFrames;
      let startFrame = scaleFrame(clip.startFrame, params.fpsMilli, doc.fpsMilli);
      if (startFrame < previousEnd) startFrame = previousEnd;
      previousEnd = startFrame + durationFrames;

      if (startFrame !== clip.startFrame || durationFrames !== clip.durationFrames) {
        ops.push({
          op: 'trimClip',
          clipId: clip.id,
          from: trimStateOf(clip),
          to: { inFrame: clip.inFrame, outFrame: clip.outFrame, startFrame, durationFrames },
        });
        return { ...clip, startFrame, durationFrames };
      }
      return clip;
    });
    return { ...track, clips };
  });

  const nextBase: Project = {
    ...doc,
    fpsMilli: params.fpsMilli,
    width: params.width,
    height: params.height,
    tracks,
  };
  const durationFrames = computeDurationFrames(nextBase);
  const mappedPlayhead = scaleFrame(doc.playheadFrame, params.fpsMilli, doc.fpsMilli);
  const maxPlayhead = durationFrames > 0 ? durationFrames - 1 : 0;
  const playheadFrame = Math.min(Math.max(mappedPlayhead, 0), maxPlayhead);

  return { doc: { ...nextBase, playheadFrame }, ops };
}

/* ---------------- R-001：首个素材跟随 ---------------- */

/**
 * 首个视频素材导入时改写工程参数（R-001）。
 *
 * 三条硬约束：
 * 1. **只有第一个素材能改写**——`doc.assets.length > 0` 直接返回 false，后续素材走 R-031 映射；
 * 2. **不弹窗、不进撤销栈**——用 `applyProjectParams` 静默写；
 * 3. **纯音频素材不改写任何参数**：没有画面；fps 对纯音频也没有意义
 *    （探测层对无视频轨的容器只能回退 `DEFAULT_FPS_MILLI`，"跟随"它 = 把工程 fps
 *    悄悄重置成 30——音频面板上线后首个内容是音效的概率大增，这条必须挡住）。
 *
 * 必须在 `store.addAsset()` **之前**调用（那时 assets 还是空）。
 */
export function applyFirstAssetParams(
  store: { getDoc(): Project; applyProjectParams(params: { width: number; height: number; fpsMilli: MilliFps }): void },
  asset: { width: number; height: number; fpsMilli: MilliFps; kind: string },
): boolean {
  const doc = store.getDoc();
  if (doc.assets.length > 0) return false;
  if (!Number.isInteger(asset.fpsMilli) || asset.fpsMilli <= 0) return false;
  const hasFrame = asset.width > 0 && asset.height > 0 && asset.kind !== 'audio';
  if (!hasFrame) return false;
  store.applyProjectParams({ width: asset.width, height: asset.height, fpsMilli: asset.fpsMilli });
  return true;
}
