/**
 * 唯一写入口：doc 读写 + 事务合并 + 逆向撤销栈 + 选择态 + 播放头总线 + React hooks。
 * （架构 §2 / §7；核心约束：core/ 不碰 DOM / WebCodecs / IndexedDB）
 *
 * 三条写路径（§7.3）：
 *   1) `store.dispatch(ops, label, source)` —— 离散操作（切分/删除/波纹/加轨/改属性确认）
 *   2) `store.beginTransaction({ mergeKey, label })` → `upsert` → `commit` —— 连续操作
 *      （拖动/裁剪/滑块）：**同 mergeKey 后写覆盖前写**，因此"一次拖拽 = 1 个撤销步"
 *   3) `store.undo() / store.redo()` —— 逆向命令栈（上限 50，新操作清空 future）
 *
 * 双通道订阅（§7.5）：
 *   - doc 通道：`subscribe` + `useDoc(selector)`（低频，每次 commit/dispatch）
 *   - 播放头通道：`playheadBus`（60Hz，不经过 React 全量渲染）
 *
 * 唯一允许的 React 依赖：`useSyncExternalStore`（仅此一个符号，架构 §1.2 例外条款）。
 */
import { useSyncExternalStore } from 'react';
import type {
  Asset,
  Clip,
  ClipOperation,
  DragDraft,
  DropGhost,
  EffectGhost,
  TrackDrag,
  TransitionGhost,
  EphemeralState,
  Frame,
  MilliFps,
  OverlayMark,
  Project,
  ProjectDerived,
  Px,
  Track,
  TrackFlag,
  TransactionConfig,
  UndoEntry,
  UndoStack,
  VEditorError,
} from './types';
import {
  MAX_ZOOM_LEVEL,
  MAX_UNDO_DEPTH,
  MIN_ZOOM_LEVEL,
  createId,
  createProject,
  makeError,
} from './types';
import {
  TrackLockedError,
  applyOperation,
  computeDurationFrames,
  describeOperation,
  invertOperation,
} from './operations';

/* ---------------- 事件总线（§14.4：总线只在 store 内实现） ---------------- */

export interface Bus<T> {
  subscribe(listener: (value: T) => void): () => void;
  emit(value: T): void;
  get(): T;
}

/** 极简同步总线：同值不发、遍历快照（监听器内增删不丢事件）。 */
export function createBus<T>(initial: T): Bus<T> {
  let value = initial;
  const listeners = new Set<(next: T) => void>();
  return {
    subscribe(listener: (next: T) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(next: T): void {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of [...listeners]) listener(value);
    },
    get(): T {
      return value;
    },
  };
}

/* ---------------- 状态形状 ---------------- */

export interface StoreState {
  doc: Project;
  undo: UndoStack;
  ephemeral: EphemeralState;
  /** doc 或 ephemeral 的可见变更计数（React 订阅用）。 */
  version: number;
}

export interface UndoResult {
  label: string;
  opCount: number;
}

export type OperationSource = 'ui' | 'ai';

/** 事务句柄：同一 mergeKey 的重复 upsert 是**替换**而非追加。 */
export interface TransactionHandle {
  readonly id: string;
  readonly mergeKey: string;
  readonly label: string;
  readonly source: OperationSource;
  readonly committed: boolean;
  upsert(op: ClipOperation, mergeKey?: string): void;
  setDraft(draft: DragDraft | null): void;
  commit(): UndoEntry | null;
  cancel(): void;
}

export interface ProjectStore {
  readonly playheadBus: Bus<Frame>;
  getState(): StoreState;
  getDoc(): Project;
  getDerived(): ProjectDerived;
  getEphemeral(): EphemeralState;
  /**
   * 提交一批操作。
   *
   * `options.mergeKey`：**连续同键操作合并成一个撤销步**（滑块拖动用）。
   * 合并窗口 1 秒——停手超过 1 秒再拖就是新的一步。
   */
  dispatch(
    ops: ClipOperation[],
    label?: string,
    source?: OperationSource,
    options?: { mergeKey?: string },
  ): UndoEntry | null;
  beginTransaction(config: TransactionConfig): TransactionHandle;
  undo(): UndoResult | null;
  redo(): UndoResult | null;
  canUndo(): boolean;
  canRedo(): boolean;
  /**
   * 撤销栈顶那一步的标签（null = 栈空）。**只读，不移动栈**。
   *
   * 用来断言"某个操作**没有**进撤销栈"（比如重新链接素材）：
   * 只比较操作前后的栈顶标签是否一致，才能证明这一步真的什么都没记。
   * 没有这个接口时，测试只能断言"最近一步不叫 X" —— 那是恒真的（栈顶可能是几步之前的）。
   */
  peekUndoLabel(): string | null;
  subscribe(listener: () => void): () => void;
  setSnapEnabled(enabled: boolean): void;
  /** 拖入落点预览（null = 清掉）。**只在值真的变了才通知**，否则拖拽时每秒几十次重绘。 */
  setDropGhost(ghost: DropGhost | null): void;
  /** 拖转场时的落点预览（null = 清掉）。与 `setDropGhost` 同一套"值不变不通知"。 */
  setTransitionGhost(ghost: TransitionGhost | null): void;
  /** 拖画面特效时的落点预览（null = 没在拖特效）。 */
  setEffectGhost(ghost: EffectGhost | null): void;
  /** 轨道排序拖拽预览（null = 没在拖）。同样只在值变了才通知。 */
  setTrackDrag(drag: TrackDrag | null): void;
  /**
   * 悬停片段（null = 没悬停）。
   *
   * **只在值真的变了才 notify**：指针在同一片段内移动时每帧都会调这里，
   * 无条件 notify 会让整条时间线每个 mousemove 都重绘一次。
   */
  setHoverClipId(clipId: string | null): void;
  /** 切换吸附，返回切换后的状态（给 toast / 按钮读）。 */
  toggleSnap(): boolean;
  setSelectedClipId(clipId: string | null): void;
  getSelectedClipId(): string | null;
  /** 当前选中的全部片段（主选在首位）；删除/复制等批量操作以它为准。 */
  getSelection(): string[];
  /** Ctrl/Cmd+点击：加入或移出选择集。 */
  toggleSelection(clipId: string): void;
  /**
   * 写拖动草稿（`ephemeral.drag`）。**不 notify doc 通道**（拖动期间 React 不重渲染，
   * §9.4 铁律），画布由 `requestPaint` 主动读。松手 `commit` 前由调用方清空。
   */
  setDrag(draft: DragDraft | null): void;
  /** 写 AI 建议切点（纯绘制层，不进撤销栈、不改 doc，R-045）。 */
  setOverlayMarks(marks: OverlayMark[]): void;
  clearOverlayMarks(): void;
  /** 入点/出点（R-040）：会话级标记，不进撤销栈、不写盘。 */
  setMarkIn(frame: Frame | null): void;
  setMarkOut(frame: Frame | null): void;
  clearMarks(): void;
  setPlayheadFrame(frame: Frame): void;
  getPlayheadFrame(): Frame;
  setZoomLevel(zoomLevel: Px): void;
  setProjectName(name: string): void;
  /** 轨道开关（静音 / 隐藏 / 锁定，R-024 + 时间线交互）：走撤销栈，可 Ctrl+Z 恢复。 */
  setTrackFlag(trackId: string, flag: TrackFlag, value: boolean): void;
  /**
   * 静默改写工程参数（R-001：首个素材自动跟随，不弹窗、不进撤销栈）。
   *
   * 与 `dispatch(setProjectParams)` 的区别：那条是用户主动改参数（有确认、要能撤销），
   * 这条是初始化（"空工程跟随第一个素材"），撤销它没有意义——用户按 Ctrl+Z
   * 期望撤的是剪辑，不是"工程尺寸变回 1920×1080"。
   */
  applyProjectParams(params: { width: number; height: number; fpsMilli: MilliFps }): void;
  setBusy(label: string | null): void;
  pushError(error: VEditorError): void;
  /** 关闭单条错误（按 `at` 时间戳定位）。 */
  dismissError(at: number): void;
  clearErrors(): void;
  /**
   * 导入素材（**不进撤销栈**：与 §7.4 的"首个素材改写工程参数"同属初始化，
   * 撤销栈只记录内容编辑；否则用户第一次按 Ctrl+Z 会撤销"导入"而不是剪辑）。
   */
  addAsset(asset: Asset): void;
  /** 更新素材运行时字段（status/thumbnailRef/handleRef），不产生撤销步。 */
  updateAsset(assetId: string, patch: Partial<Asset>): void;
  getAsset(assetId: string): Asset | null;
  /** 恢复会话/宿主注入整份工程（不产生撤销步）。 */
  replaceDoc(next: Project): void;
  dispose(): void;
}

/* ---------------- 派生值 ---------------- */

/** 派生、不写盘、不参与撤销（架构 §4.1 `ProjectDerived`）。 */
export function computeProjectDerived(doc: Project): ProjectDerived {
  let durationFrames = 0;
  let clipCount = 0;
  let videoTracks = 0;
  let audioTracks = 0;
  for (const track of doc.tracks) {
    if (track.kind === 'video') videoTracks += 1;
    else audioTracks += 1;
    for (const clip of track.clips) {
      clipCount += 1;
      const end = clip.startFrame + clip.durationFrames;
      if (end > durationFrames) durationFrames = end;
    }
  }
  const offlineAssetIds = doc.assets
    .filter((asset) => asset.status === 'offline')
    .map((asset) => asset.id);
  return {
    durationFrames,
    clipCount,
    trackCounts: { video: videoTracks, audio: audioTracks },
    offlineAssetIds,
  };
}

/* ---------------- 内部：比较与 no-op 判定 ---------------- */

/** 结构相等（仅用于操作是否为空转的判定，作用于纯数据）。 */
function isPlainEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

/** 空转操作不入栈（例如拖回原位）。 */
function isNoopOperation(op: ClipOperation): boolean {
  switch (op.op) {
    case 'moveClip':
      return isPlainEqual(op.from, op.to);
    case 'trimClip':
      return isPlainEqual(op.from, op.to);
    case 'setClipProps':
      return isPlainEqual(op.from, op.to);
    case 'setProjectParams':
      return isPlainEqual(op.from, op.to);
    case 'rippleShift':
      return op.shifts.every((shift) => shift.from === shift.to);
    default:
      return false;
  }
}

/** 合并 key 的 target 部分（同一 mergeKey 下不同目标互不覆盖）。 */
function targetIdOf(op: ClipOperation): string {
  switch (op.op) {
    case 'addClip':
      return op.clip.id;
    case 'removeClip':
    case 'moveClip':
    case 'trimClip':
    case 'splitClip':
    case 'setClipProps':
    case 'setClipEffect':
    case 'setClipText':
    case 'setClipTransition':
    case 'setClipKeyframes':
      return op.clipId;
    case 'setClipSpeed':
      return op.clipId;
    case 'addTrack':
      return op.track.id;
    case 'removeTrack':
    case 'renameTrack':
    case 'setTrackFlag':
    case 'setTrackHeight':
      return op.trackId;
    case 'reorderTracks':
      // 合并键用整组 id：连续拖同一条轨的排序才合并，拖别的轨另起一步
      return op.changes.map((change) => change.trackId).join(',');
    case 'rippleShift':
      return op.shifts.map((shift) => shift.clipId).join(',');
    case 'removeAsset':
      return op.assetId;
    case 'restoreAsset':
      return op.asset.id;
    case 'setProjectParams':
      return 'project';
    default: {
      const exhaustive: never = op;
      throw new Error(`store: 未知操作 ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * 替换式合并时**保留最初的 from / removed**：
 * 否则一次拖拽的中间态会污染撤销起点（"拖回去"就变成不可撤销）。
 */
function withPreservedOrigin(next: ClipOperation, previous: ClipOperation): ClipOperation {
  if (next.op === 'moveClip' && previous.op === 'moveClip') {
    return { ...next, from: previous.from };
  }
  if (next.op === 'trimClip' && previous.op === 'trimClip') {
    return { ...next, from: previous.from };
  }
  if (next.op === 'setClipProps' && previous.op === 'setClipProps') {
    return { ...next, from: previous.from };
  }
  if (next.op === 'setProjectParams' && previous.op === 'setProjectParams') {
    return { ...next, from: previous.from };
  }
  return next;
}

/** 同键合并的时间窗口（毫秒）：停手超过它再动就是新的一步。 */
const MERGE_WINDOW_MS = 1000;

/* ---------------- store 工厂 ---------------- */

const EMPTY_EPHEMERAL: EphemeralState = {
  selectedClipId: null,
  hoverClipId: null,
  drag: null,
  overlayMarks: [],
  extraSelectedClipIds: [],
  markIn: null,
  markOut: null,
  isPlaying: false,
  busyLabel: null,
  errors: [],
  snapEnabled: true,
  dropGhost: null,
  transitionGhost: null,
  effectGhost: null,
  trackDrag: null,
};

/** 创建独立 store（测试用；应用内使用下方单例 `store`）。 */
export function createStore(initialDoc?: Project): ProjectStore {
  let doc: Project = initialDoc ?? createProject();
  const past: UndoEntry[] = [];
  const future: UndoEntry[] = [];
  let ephemeral: EphemeralState = { ...EMPTY_EPHEMERAL };
  let version = 0;
  const listeners = new Set<() => void>();
  const playheadBus = createBus<Frame>(doc.playheadFrame);
  let derivedCache: { doc: Project; value: ProjectDerived } | null = null;

  /** 通知 doc 通道订阅者（低频；播放头不走这里）。 */
  function notify(): void {
    version += 1;
    for (const listener of [...listeners]) listener();
  }

  /** 顺序应用一组操作。 */
  function applyMany(base: Project, ops: readonly ClipOperation[]): Project {
    return ops.reduce((current, op) => applyOperation(current, op), base);
  }

  /** 把播放头夹到合法区间并同步总线（不通知 doc 通道）。 */
  function syncPlayhead(preferred?: Frame): void {
    const durationFrames = computeDurationFrames(doc);
    // 上限 = 总时长本身（时间线的"末尾点"），与 playbackClock.maxFrame 保持一致。
    // 若这里用 duration-1，用户在片尾追加片段时播放头会被压回最后一帧，
    // 新片段就与前一段重叠 1 帧 —— 两处 clamp 必须是同一条规则，否则互相打架。
    const maxPlayhead = durationFrames > 0 ? durationFrames : 0;
    const target = preferred ?? doc.playheadFrame;
    const clamped = Math.min(Math.max(target, 0), maxPlayhead);
    if (clamped !== doc.playheadFrame) {
      doc = { ...doc, playheadFrame: clamped };
    }
    playheadBus.emit(clamped);
  }

  /**
   * 提交一个撤销步：应用 ops、生成逆向 ops、入栈、清空 future。
   * @returns 入栈条目；全为空转时返回 null（不产生撤销步）。
   */
  function record(
    label: string,
    ops: readonly ClipOperation[],
    source: OperationSource,
    mergeKey?: string,
  ): UndoEntry | null {
    const applicable = ops.filter((op) => !isNoopOperation(op));
    if (applicable.length === 0) return null;

    const inverseGroups: ClipOperation[][] = [];
    let cursor = doc;
    for (const op of applicable) {
      // 先应用再求逆：`splitClip` 的逆需要"已存在右半段"的 doc 才能取出完整片段对象；
      // 其余操作自包含（op 里带 from/removed/track），传 after 不影响结果。
      let after: Project;
      try {
        after = applyOperation(cursor, op);
      } catch (error) {
        // **只**把"锁定轨拒绝"转成错误条（用户操作被规则挡下，要有可读反馈）；
        // 其它异常照旧抛出去——非法参数、缺失片段这类是代码 bug，必须让测试炸掉，
        // 统一 catch 会把它变成一条不起眼的错误条（"静默失败"最难查）。
        if (!(error instanceof TrackLockedError)) throw error;
        // error 已收窄为 TrackLockedError
        ephemeral = {
          ...ephemeral,
          errors: [...ephemeral.errors, makeError('E_INVALID_PROJECT', '轨道已锁定，先解锁再修改', error.message)].slice(-3),
        };
        notify();
        return null;
      }
      inverseGroups.push(invertOperation(op, after));
      cursor = after;
    }
    // 逆向必须"反序、且每组内部保持顺序"
    const inverses: ClipOperation[] = [];
    for (let index = inverseGroups.length - 1; index >= 0; index -= 1) {
      const group = inverseGroups[index];
      if (group) inverses.push(...group);
    }

    const entry: UndoEntry = {
      id: createId('undo'),
      label: label.trim().length > 0 ? label : applicable.map(describeOperation).join(' / '),
      ops: [...applicable],
      inverses,
      source,
      createdAt: Date.now(),
    };

    doc = cursor;

    /**
     * 连续同键操作合并成一条撤销记录。
     *
     * 为什么需要：音量/缩放这类滑块一次拖动会发几十个 `change`，
     * 每个都压一条撤销记录的话，用户按 Ctrl+Z 要按二十下才退回拖动前。
     * 合并规则：
     *   - 键相同、且距上一条不超过 `MERGE_WINDOW_MS`；
     *   - **保留最早那一条的 `inverses`**（撤销要回到拖动开始前的值）；
     *   - `ops` 用新的一条，但 `from` 保留最早的原值（`withPreservedOrigin`），
     *     这样重做时是"从原值直接到最终值"。
     */
    const previousEntry = past[past.length - 1];
    const canMerge =
      mergeKey !== undefined &&
      previousEntry !== undefined &&
      previousEntry.mergeKey === mergeKey &&
      Date.now() - previousEntry.createdAt <= MERGE_WINDOW_MS;
    if (canMerge && previousEntry !== undefined) {
      const mergedOps = applicable.map((op) => {
        const previousOp = previousEntry.ops.find(
          (item) =>
            item.op === op.op &&
            targetIdOf(item) === targetIdOf(op) &&
            (!('path' in item) || !('path' in op) || item.path === op.path),
        );
        return previousOp === undefined ? op : withPreservedOrigin(op, previousOp);
      });
      past[past.length - 1] = {
        ...entry,
        id: previousEntry.id,
        ops: mergedOps,
        inverses: previousEntry.inverses,
        mergeKey,
      };
    } else {
      past.push(mergeKey === undefined ? entry : { ...entry, mergeKey });
      if (past.length > MAX_UNDO_DEPTH) {
        past.splice(0, past.length - MAX_UNDO_DEPTH);
      }
    }
    future.length = 0;
    syncPlayhead();
    notify();
    return past[past.length - 1] ?? entry;
  }

  /** 事务句柄。 */
  function beginTransaction(config: TransactionConfig): TransactionHandle {
    const id = createId('tx');
    const source: OperationSource = config.source ?? 'ui';
    const ops = new Map<string, ClipOperation>();
    let state: 'open' | 'committed' | 'cancelled' = 'open';

    const handle: TransactionHandle = {
      id,
      mergeKey: config.mergeKey,
      label: config.label,
      source,
      get committed(): boolean {
        return state === 'committed';
      },
      upsert(op: ClipOperation, mergeKey?: string): void {
        if (state !== 'open') {
          throw new Error('store: 事务已结束，不能再 upsert');
        }
        const key = `${mergeKey ?? config.mergeKey}:${targetIdOf(op)}`;
        const previous = ops.get(key);
        ops.set(key, previous ? withPreservedOrigin(op, previous) : op);
      },
      setDraft(draft: DragDraft | null): void {
        if (state !== 'open') return;
        // 只写 ephemeral.drag（供画布绘制），不触发 doc 通道通知（铁律：拖动期间 React 不重渲染）
        ephemeral = { ...ephemeral, drag: draft };
      },
      commit(): UndoEntry | null {
        if (state !== 'open') {
          throw new Error('store: 事务已结束，不能重复 commit');
        }
        state = 'committed';
        if (ephemeral.drag !== null) ephemeral = { ...ephemeral, drag: null };
        return record(config.label, [...ops.values()], source);
      },
      cancel(): void {
        if (state !== 'open') return;
        state = 'cancelled';
        ops.clear();
        if (ephemeral.drag !== null) ephemeral = { ...ephemeral, drag: null };
      },
    };
    return handle;
  }

  const storeApi: ProjectStore = {
    playheadBus,

    getState(): StoreState {
      return {
        doc,
        undo: { past: [...past], future: [...future] },
        ephemeral,
        version,
      };
    },

    getDoc(): Project {
      return doc;
    },

    getDerived(): ProjectDerived {
      if (!derivedCache || derivedCache.doc !== doc) {
        derivedCache = { doc, value: computeProjectDerived(doc) };
      }
      return derivedCache.value;
    },

    getEphemeral(): EphemeralState {
      return ephemeral;
    },

    dispatch(
      ops: ClipOperation[],
      label = '',
      source: OperationSource = 'ui',
      options?: { mergeKey?: string },
    ): UndoEntry | null {
      if (ops.length === 0) return null;
      return record(label, ops, source, options?.mergeKey);
    },

    beginTransaction,
    canUndo(): boolean {
      return past.length > 0;
    },
    canRedo(): boolean {
      return future.length > 0;
    },

    peekUndoLabel(): string | null {
      const entry = past[past.length - 1];
      return entry === undefined ? null : entry.label;
    },

    undo(): UndoResult | null {
      const entry = past.pop();
      if (!entry) return null;
      doc = applyMany(doc, entry.inverses);
      future.push(entry);
      syncPlayhead();
      notify();
      return { label: entry.label, opCount: entry.ops.length };
    },

    redo(): UndoResult | null {
      const entry = future.pop();
      if (!entry) return null;
      doc = applyMany(doc, entry.ops);
      past.push(entry);
      if (past.length > MAX_UNDO_DEPTH) {
        past.splice(0, past.length - MAX_UNDO_DEPTH);
      }
      syncPlayhead();
      notify();
      return { label: entry.label, opCount: entry.ops.length };
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setDropGhost(ghost: DropGhost | null): void {
      const previous = ephemeral.dropGhost;
      if (previous === ghost) return;
      if (
        previous !== null &&
        ghost !== null &&
        previous.trackId === ghost.trackId &&
        previous.startFrame === ghost.startFrame &&
        previous.durationFrames === ghost.durationFrames &&
        previous.valid === ghost.valid
      ) {
        // 位置没变：只更新 reason（避免每帧都 notify）
        return;
      }
      ephemeral = { ...ephemeral, dropGhost: ghost };
      notify();
    },

    setTransitionGhost(ghost: TransitionGhost | null): void {
      const previous = ephemeral.transitionGhost;
      if (previous === ghost) return;
      if (
        previous !== null &&
        ghost !== null &&
        previous.clipId === ghost.clipId &&
        previous.side === ghost.side &&
        previous.durationFrames === ghost.durationFrames &&
        previous.valid === ghost.valid
      ) {
        // 落点没变：只更新 reason（避免每帧都 notify）
        return;
      }
      ephemeral = { ...ephemeral, transitionGhost: ghost };
      notify();
    },

    setEffectGhost(ghost: EffectGhost | null): void {
      const previous = ephemeral.effectGhost;
      if (previous === ghost) return;
      if (
        previous !== null &&
        ghost !== null &&
        previous.clipId === ghost.clipId &&
        previous.valid === ghost.valid
      ) {
        // 落点没变：只更新 reason（避免每帧都 notify）
        return;
      }
      ephemeral = { ...ephemeral, effectGhost: ghost };
      notify();
    },

    setHoverClipId(clipId: string | null): void {
      if (ephemeral.hoverClipId === clipId) return;
      ephemeral = { ...ephemeral, hoverClipId: clipId };
      notify();
    },

    setTrackDrag(drag: TrackDrag | null): void {
      const previous = ephemeral.trackDrag;
      if (previous === drag) return;
      if (
        previous !== null &&
        drag !== null &&
        previous.trackId === drag.trackId &&
        previous.indicatorTop === drag.indicatorTop &&
        previous.targetIndex === drag.targetIndex
      ) {
        return;
      }
      ephemeral = { ...ephemeral, trackDrag: drag };
      notify();
    },

    setSnapEnabled(enabled: boolean): void {
      if (ephemeral.snapEnabled === enabled) return;
      ephemeral = { ...ephemeral, snapEnabled: enabled };
      notify();
    },

    toggleSnap(): boolean {
      const next = !ephemeral.snapEnabled;
      ephemeral = { ...ephemeral, snapEnabled: next };
      notify();
      return next;
    },

    setSelectedClipId(clipId: string | null): void {
      if (clipId !== null) {
        const exists = doc.tracks.some((track) =>
          track.clips.some((clip) => clip.id === clipId),
        );
        if (!exists) return;
      }
      if (ephemeral.selectedClipId === clipId && ephemeral.extraSelectedClipIds.length === 0) return;
      // 单选 API：清掉多选，避免"点了别的片段还留着上次的多选"
      ephemeral = { ...ephemeral, selectedClipId: clipId, extraSelectedClipIds: [] };
      notify();
    },

    getSelection(): string[] {
      const all = [ephemeral.selectedClipId, ...ephemeral.extraSelectedClipIds].filter(
        (id): id is string => id !== null,
      );
      const existing = new Set(
        doc.tracks.flatMap((track) => track.clips.map((clip) => clip.id)),
      );
      return all.filter((id) => existing.has(id));
    },

    toggleSelection(clipId: string): void {
      const exists = doc.tracks.some((track) => track.clips.some((clip) => clip.id === clipId));
      if (!exists) return;
      if (ephemeral.selectedClipId === clipId) {
        // 取消主选：把第一个次选提升为主选
        const [next, ...rest] = ephemeral.extraSelectedClipIds;
        ephemeral = { ...ephemeral, selectedClipId: next ?? null, extraSelectedClipIds: rest };
        notify();
        return;
      }
      if (ephemeral.extraSelectedClipIds.includes(clipId)) {
        ephemeral = {
          ...ephemeral,
          extraSelectedClipIds: ephemeral.extraSelectedClipIds.filter((id) => id !== clipId),
        };
        notify();
        return;
      }
      /**
       * 主选为空时这次 toggle 会**成为主选**，此时**不能再压进 extra**。
       *
       * 原实现无条件 `[...extra, clipId]` + `selectedClipId ?? clipId`：
       * 清空选择后连续 toggle 会得到 `[a, a, b, c...]` —— 同一片段既是主选又是次选，
       * `getSelection()` 出现重复 id（多选计数比实际多 1；批量操作会重复处理同一条）。
       * 触发路径：字幕面板的 Shift 范围选（先 `setSelectedClipId(null)` 再逐个 toggle）。
       */
      const becomesPrimary = ephemeral.selectedClipId === null;
      ephemeral = {
        ...ephemeral,
        selectedClipId: becomesPrimary ? clipId : ephemeral.selectedClipId,
        extraSelectedClipIds: becomesPrimary
          ? ephemeral.extraSelectedClipIds
          : [...ephemeral.extraSelectedClipIds, clipId],
      };
      notify();
    },

    getSelectedClipId(): string | null {
      return ephemeral.selectedClipId;
    },

    setOverlayMarks(marks: OverlayMark[]): void {
      // 只判长度与首帧不够：同一帧的建议可能换理由，直接比较引用更省事
      ephemeral = { ...ephemeral, overlayMarks: marks };
      notify();
    },

    setMarkIn(frame: Frame | null): void {
      if (frame !== null && (!Number.isInteger(frame) || frame < 0)) return;
      ephemeral = { ...ephemeral, markIn: frame };
      notify();
    },

    setMarkOut(frame: Frame | null): void {
      if (frame !== null && (!Number.isInteger(frame) || frame < 0)) return;
      ephemeral = { ...ephemeral, markOut: frame };
      notify();
    },

    clearMarks(): void {
      if (ephemeral.markIn === null && ephemeral.markOut === null) return;
      ephemeral = { ...ephemeral, markIn: null, markOut: null };
      notify();
    },

    clearOverlayMarks(): void {
      if (ephemeral.overlayMarks.length === 0) return;
      ephemeral = { ...ephemeral, overlayMarks: [] };
      notify();
    },

    setDrag(draft: DragDraft | null): void {
      // 不 notify：拖动期间 React 不重渲染（铁律 §9.4），画布靠 rAF 合帧读最新 ephemeral
      ephemeral = { ...ephemeral, drag: draft };
    },

    setPlayheadFrame(frame: Frame): void {
      if (!Number.isInteger(frame)) {
        throw new Error(`store: playheadFrame 必须是整数，收到 ${frame}`);
      }
      if (frame < 0) {
        throw new Error(`store: playheadFrame 不允许为负，收到 ${frame}`);
      }
      // 播放头不进撤销栈、不写 zoomLevel，只走高频总线（§7.4 明确写死）
      syncPlayhead(frame);
    },

    getPlayheadFrame(): Frame {
      return doc.playheadFrame;
    },

    setZoomLevel(zoomLevel: Px): void {
      const clamped = Math.min(Math.max(zoomLevel, MIN_ZOOM_LEVEL), MAX_ZOOM_LEVEL);
      if (clamped === doc.zoomLevel) return;
      doc = { ...doc, zoomLevel: clamped };
      notify();
    },

    setProjectName(name: string): void {
      const trimmed = name.trim();
      if (trimmed.length === 0 || trimmed === doc.name) return;
      doc = { ...doc, name: trimmed };
      notify();
    },

    setTrackFlag(trackId: string, flag: TrackFlag, value: boolean): void {
      const track = doc.tracks.find((item) => item.id === trackId);
      if (track === undefined || track[flag] === value) return;
      const label =
        flag === 'muted'
          ? value
            ? '静音轨道'
            : '取消静音'
          : flag === 'hidden'
            ? value
              ? '隐藏轨道'
              : '显示轨道'
            : flag === 'solo'
              ? value
                ? '独奏轨道'
                : '取消独奏'
              : value
                ? '锁定轨道'
                : '解锁轨道';
      // `solo` 是可选字段（老工程没有），`from` 统一收敛成布尔
      record(label, [{ op: 'setTrackFlag', trackId, flag, from: track[flag] === true, to: value }], 'ui');
    },

    applyProjectParams(params: { width: number; height: number; fpsMilli: MilliFps }): void {
      if (
        params.width === doc.width &&
        params.height === doc.height &&
        params.fpsMilli === doc.fpsMilli
      ) {
        return;
      }
      doc = { ...doc, width: params.width, height: params.height, fpsMilli: params.fpsMilli };
      notify();
    },

    setBusy(label: string | null): void {
      if (ephemeral.busyLabel === label) return;
      ephemeral = { ...ephemeral, busyLabel: label };
      notify();
    },

    pushError(error: VEditorError): void {
      // 只保留最近 3 条，避免错误条堆积
      const errors = [...ephemeral.errors, error].slice(-3);
      ephemeral = { ...ephemeral, errors };
      notify();
    },

    dismissError(at: number): void {
      if (ephemeral.errors.length === 0) return;
      const errors = ephemeral.errors.filter((error) => error.at !== at);
      if (errors.length === ephemeral.errors.length) return;
      ephemeral = { ...ephemeral, errors };
      notify();
    },

    clearErrors(): void {
      if (ephemeral.errors.length === 0) return;
      ephemeral = { ...ephemeral, errors: [] };
      notify();
    },

    addAsset(asset: Asset): void {
      if (doc.assets.some((candidate) => candidate.id === asset.id)) return;
      doc = { ...doc, assets: [...doc.assets, asset] };
      notify();
    },

    updateAsset(assetId: string, patch: Partial<Asset>): void {
      const index = doc.assets.findIndex((candidate) => candidate.id === assetId);
      if (index < 0) return;
      const assets = doc.assets.map((candidate, position) =>
        position === index ? { ...candidate, ...patch } : candidate,
      );
      doc = { ...doc, assets };
      notify();
    },

    getAsset(assetId: string): Asset | null {
      return doc.assets.find((candidate) => candidate.id === assetId) ?? null;
    },

    replaceDoc(next: Project): void {
      doc = next;
      past.length = 0;
      future.length = 0;
      ephemeral = { ...ephemeral, selectedClipId: null, drag: null };
      syncPlayhead(next.playheadFrame);
      notify();
    },

    dispose(): void {
      listeners.clear();
    },
  };

  return storeApi;
}

/* ---------------- 应用单例 ---------------- */

/** 应用内唯一 store 实例。 */
export const store: ProjectStore = createStore();

/** 播放头专用高频总线（60Hz，不经过 React 全量渲染）。 */
export const playheadBus: Bus<Frame> = store.playheadBus;

/* ---------------- React hooks（仅 useSyncExternalStore） ---------------- */

/**
 * 选择器快照缓存：同一 selector 在同一 doc 上返回**同一引用**，
 * 避免 `useSyncExternalStore` 因每次返回新对象而无限重渲染。
 *
 * 约束（架构 §7.5）：selector 必须返回原始值或稳定引用，禁止在 selector 里 new 对象/数组。
 */
const snapshotCache = new WeakMap<Function, { doc: Project; value: unknown }>();

/** 带相等性兜底的选择器求值（保证引用稳定）。 */
function selectWithEquality<T>(
  doc: Project,
  selector: (current: Project) => T,
  isEqual: (left: T, right: T) => boolean,
): T {
  const cached = snapshotCache.get(selector);
  if (cached && cached.doc === doc) {
    return cached.value as T;
  }
  const next = selector(doc);
  if (cached && isEqual(cached.value as T, next)) {
    cached.doc = doc;
    return cached.value as T;
  }
  snapshotCache.set(selector, { doc, value: next });
  return next;
}

/**
 * 订阅 doc 上的派生选择（低频）。
 *
 * 注意：`getSnapshot` 每次渲染都会新建闭包，因此 `selector` 应当是**模块级稳定函数**
 * （内联箭头函数也能工作，但会带来额外的重新订阅）。
 */
export function useDoc<T>(
  selector: (doc: Project) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const getSnapshot = (): T => selectWithEquality(store.getDoc(), selector, isEqual);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/** 当前选中片段 id（null = 未选中，R-014）。 */
/**
 * 吸附开关（boolean 快照）。
 *
 * **不要用 `useVersion()`**：那会让时间线在**任何**状态变化（拖动、播放头、错误条）时
 * 全量重渲染——时间线是全应用最重的组件，一帧多渲染几次就掉帧。
 * `useSyncExternalStore` 拿 boolean 做快照，只有真的翻转时才重渲染。
 */
export function useSnapEnabled(): boolean {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getEphemeral().snapEnabled,
  );
}

export function useSelection(): string | null {
  return useSyncExternalStore(
    store.subscribe,
    () => store.getSelectedClipId(),
    () => null,
  );
}

/** 播放头帧（高频通道，供时间码文字使用；不要在播放头里做重活）。 */
export function useFrame(): Frame {
  return useSyncExternalStore(playheadBus.subscribe, playheadBus.get, playheadBus.get);
}

/** 错误条列表。 */
export function useErrors(): VEditorError[] {
  return useSyncExternalStore(
    store.subscribe,
    () => store.getEphemeral().errors,
    () => EMPTY_EPHEMERAL.errors,
  );
}

/** 派生值（时长/片段数/离线素材）。 */
export function useDerived(): ProjectDerived {
  return useSyncExternalStore(store.subscribe, () => store.getDerived(), () => store.getDerived());
}

/** 变更计数（需要"任意变更就重渲染"的粗粒度订阅）。 */
export function useVersion(): number {
  return useSyncExternalStore(
    store.subscribe,
    () => store.getState().version,
    () => 0,
  );
}

/** 当前选中片段对象（无选中返回 null）。 */
export function selectedClipOf(doc: Project, clipId: string | null): Clip | null {
  if (!clipId) return null;
  for (const track of doc.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return clip;
  }
  return null;
}

/** 按 order 升序的轨道视图（合成顺序：order 0 最底）。 */
export function orderTracks(tracks: readonly Track[]): Track[] {
  return [...tracks].sort((left, right) => left.order - right.order);
}
