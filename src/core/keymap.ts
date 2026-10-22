/**
 * 快捷键表与匹配（T11 / R-026）。
 *
 * 三条硬规则：
 *   1. **输入框聚焦时，除 Esc 外全部屏蔽**（否则用户改工程名时按空格会开始播放）；
 *   2. 平台修饰键归一：mac 用 `Cmd`（metaKey），win/linux 用 `Ctrl`（ctrlKey），
 *      统一由 `primary` 一个语义位表达，不在各处写 `event.metaKey || event.ctrlKey`；
 *   3. `Delete` 与 `Backspace` 同义；方向键逐帧 `±1`，加 `Shift` 为 `±10`；
 *      `N` 开关吸附（跟剪映），拖动时按住 `Alt` 临时不吸附。
 *
 * 本文件只做"按键 → 语义动作"的映射，动作本身调用 store / transport 的公开 API。
 */
import type { Clip, ClipOperation, Frame, Project } from '../core/types';
import { createId } from '../core/types';
import { mapProjectFrameToAssetFrame } from '../core/timebase';
import type { Transport } from '../media/playbackClock';
import type { ProjectStore } from './store';
import { store as defaultStore } from './store';

export type Platform = 'mac' | 'other';

export interface KeyBinding {
  /** 语义动作 id（与处理函数一一对应）。 */
  id:
    | 'togglePlay'
    | 'deleteClip'
    | 'rippleDelete'
    | 'splitAtPlayhead'
    | 'toggleSnap'
    | 'undo'
    | 'redo'
    | 'stepBack'
    | 'stepForward'
    | 'stepBack10'
    | 'stepForward10'
    | 'export'
    | 'ai'
    | 'markIn'
    | 'markOut'
    | 'clearMarks'
    | 'escape';
  label: string;
  /** `KeyboardEvent.key`（字母用小写，空格是 `' '`）。 */
  keys: readonly string[];
  primary?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** 允许长按重复触发（方向键需要，Delete/切分不需要）。 */
  repeat?: boolean;
}

/** 快捷键表（顺序即优先级；同键不同修饰符靠精确匹配区分）。 */
export const KEY_BINDINGS: readonly KeyBinding[] = [
  { id: 'togglePlay', label: '播放/暂停', keys: [' '], repeat: false },
  { id: 'deleteClip', label: '删除片段', keys: ['delete', 'backspace'], repeat: false },
  { id: 'rippleDelete', label: '波纹删除', keys: ['delete', 'backspace'], shift: true, repeat: false },
  { id: 'splitAtPlayhead', label: '切分片段', keys: ['b'], primary: true, repeat: false },
  // 跟剪映：N 切换吸附（PR 是 S；中文用户更熟剪映）
  { id: 'toggleSnap', label: '开关吸附', keys: ['n'], repeat: false },
  { id: 'undo', label: '撤销', keys: ['z'], primary: true, repeat: true },
  { id: 'redo', label: '重做', keys: ['z'], primary: true, shift: true, repeat: true },
  { id: 'stepBack10', label: '后退 10 帧', keys: ['arrowleft'], shift: true, repeat: true },
  { id: 'stepForward10', label: '前进 10 帧', keys: ['arrowright'], shift: true, repeat: true },
  { id: 'stepBack', label: '后退 1 帧', keys: ['arrowleft'], repeat: true },
  { id: 'stepForward', label: '前进 1 帧', keys: ['arrowright'], repeat: true },
  { id: 'export', label: '导出', keys: ['e'], primary: true, repeat: false },
  { id: 'ai', label: '唤起 AI 命令栏', keys: ['k'], primary: true, repeat: false },
  { id: 'markIn', label: '标记入点', keys: ['i'], repeat: false },
  { id: 'markOut', label: '标记出点', keys: ['o'], repeat: false },
  { id: 'clearMarks', label: '清除入出点', keys: ['i'], alt: true, repeat: false },
  { id: 'escape', label: '退出编辑', keys: ['escape'], repeat: false },
];

/** 当前平台（mac 判定：优先 userAgent，其次 platform）。 */
export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  const source = `${navigator.userAgent} ${navigator.platform ?? ''}`;
  return /mac|iphone|ipad|ipod/i.test(source) ? 'mac' : 'other';
}

/** 主修饰键是否按下（mac = Cmd，其他 = Ctrl）。 */
export function hasPrimaryModifier(event: KeyboardEvent, platform: Platform): boolean {
  return platform === 'mac' ? event.metaKey === true : event.ctrlKey === true;
}

/** 事件是否发生在可编辑元素里（输入框/文本域/下拉/可编辑区）。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as HTMLElement & { tagName?: string; isContentEditable?: boolean };
  const tag = element.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return element.isContentEditable === true;
}

/**
 * 匹配单个绑定。
 *
 * 注意：`shift` 未声明时要求**没按** Shift（否则 `←` 会同时命中 `Shift+←` 的两条）。
 * 字母键统一小写比较（`event.key` 在按住 Shift 时是 `'B'`）。
 */
export function matchesKey(
  event: KeyboardEvent,
  binding: KeyBinding,
  platform: Platform,
): boolean {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase();
  if (!binding.keys.includes(key)) return false;
  const primary = binding.primary === true;
  if (hasPrimaryModifier(event, platform) !== primary) return false;
  const shift = binding.shift === true;
  if (event.shiftKey !== shift) return false;
  if (event.altKey !== (binding.alt === true)) return false;
  return true;
}

/** 在绑定表里找到第一条匹配项。 */
export function findBinding(
  event: KeyboardEvent,
  platform: Platform = detectPlatform(),
): KeyBinding | null {
  for (const binding of KEY_BINDINGS) {
    if (matchesKey(event, binding, platform)) return binding;
  }
  return null;
}

/** 在 doc 里按 id 找片段。 */
function findClip(doc: Project, clipId: string | null): Clip | null {
  if (!clipId) return null;
  for (const track of doc.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return clip;
  }
  return null;
}

/**
 * 删除**选中的全部片段**（R-017：原位留空，播放头不动）。
 *
 * 多选时合并成**一个撤销步** —— 用户按 Ctrl+Z 的期待是"把我刚删的那批找回来"，
 * 而不是"一次回来一个"。
 */
export function removeSelectedClip(store: ProjectStore = defaultStore): boolean {
  const doc = store.getDoc();
  const clips = store
    .getSelection()
    .map((clipId) => findClip(doc, clipId))
    .filter((clip): clip is Clip => clip !== null);
  if (clips.length === 0) return false;
  store.dispatch(
    clips.map((clip) => ({ op: 'removeClip' as const, clipId: clip.id, removed: clip })),
    clips.length === 1 ? '删除片段' : `删除 ${clips.length} 个片段`,
  );
  store.setSelectedClipId(null);
  return true;
}

/**
 * 波纹删除（Shift+Delete，R-018）：删除选中片段，同轨后续片段左移被删片段的时长，
 * **其他轨片段不动**。removeClip + rippleShift 两条 op 合并为 1 个撤销步。
 */
/**
 * 波纹删除（Shift+Delete，R-018）：删除选中片段，**同轨**后续片段左移被删时长，
 * 其他轨不动。多选时整批合成一个撤销步。
 *
 * 多选的位移量算法：对每个幸存片段，左移"**它前面所有被删片段的时长之和**"。
 * 这比"只移最后一个被删片段之后"更准确 —— 被删片段之间如果有间隔，
 * 那些间隔是用户故意留的，不该被吞掉（PR/剪映的波纹删除也是这个语义）。
 */
export function rippleDeleteSelectedClip(store: ProjectStore = defaultStore): boolean {
  const doc = store.getDoc();
  const ids = new Set(store.getSelection());
  if (ids.size === 0) return false;
  const doomedTotal = doc.tracks.reduce(
    (sum, track) => sum + track.clips.filter((clip) => ids.has(clip.id)).length,
    0,
  );
  if (doomedTotal === 0) return false;

  const ops: ClipOperation[] = [];
  for (const track of doc.tracks) {
    const doomed = track.clips.filter((clip) => ids.has(clip.id));
    if (doomed.length === 0) continue;
    const survivors = track.clips.filter((clip) => !ids.has(clip.id));
    const shifts: Array<{ clipId: string; from: number; to: number }> = [];
    for (const clip of survivors) {
      const shift = doomed
        .filter((item) => item.startFrame < clip.startFrame)
        .reduce((sum, item) => sum + item.durationFrames, 0);
      if (shift > 0) shifts.push({ clipId: clip.id, from: clip.startFrame, to: clip.startFrame - shift });
    }
    for (const clip of doomed) ops.push({ op: 'removeClip', clipId: clip.id, removed: clip });
    if (shifts.length > 0) ops.push({ op: 'rippleShift', shifts });
  }

  store.dispatch(ops, doomedTotal === 1 ? '波纹删除' : `波纹删除 ${doomedTotal} 个片段`);
  store.setSelectedClipId(null);
  return true;
}

/**
 * 生成"在项目帧 atFrame 处切分"的操作（R-016：帧数守恒）。
 *
 * 选中片段时只切它；未选中时切播放头下的**所有**片段（每个片段一条 op，同属一个撤销步）。
 * 切点必须严格落在片段内部（`startFrame < atFrame < end`），且在素材侧也必须是合法分界
 * （`inFrame < assetFrame < outFrame`），否则跳过该片段。
 */
export function buildSplitOperations(
  doc: Project,
  atFrame: Frame,
  selectedClipId: string | null = null,
): ClipOperation[] {
  const assets = new Map(doc.assets.map((asset) => [asset.id, asset]));
  const targets: Clip[] = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (selectedClipId !== null && clip.id !== selectedClipId) continue;
      if (clip.startFrame >= atFrame) continue;
      if (clip.startFrame + clip.durationFrames <= atFrame) continue;
      targets.push(clip);
    }
  }

  const operations: ClipOperation[] = [];
  for (const clip of targets) {
    const asset = assets.get(clip.assetId);
    if (!asset) continue;
    const assetFrame = mapProjectFrameToAssetFrame(atFrame, clip, asset, doc.fpsMilli);
    // 只判 null：0 是合法素材帧号
    if (assetFrame === null) continue;
    const leftDuration = atFrame - clip.startFrame;
    const rightDuration = clip.durationFrames - leftDuration;
    if (leftDuration < 1 || rightDuration < 1) continue;
    if (assetFrame <= clip.inFrame || assetFrame >= clip.outFrame) continue;
    operations.push({
      op: 'splitClip',
      clipId: clip.id,
      atProjectFrame: atFrame,
      left: {
        inFrame: clip.inFrame,
        outFrame: assetFrame,
        startFrame: clip.startFrame,
        durationFrames: leftDuration,
      },
      right: {
        inFrame: assetFrame,
        outFrame: clip.outFrame,
        startFrame: atFrame,
        durationFrames: rightDuration,
      },
      newClipId: createId('clp'),
    });
  }
  return operations;
}

/** 在播放头处切分（Ctrl/Cmd+B）。返回真正切开的片段数。 */
export function splitAtPlayhead(store: ProjectStore = defaultStore): number {
  const doc = store.getDoc();
  const operations = buildSplitOperations(doc, store.getPlayheadFrame(), store.getSelectedClipId());
  if (operations.length === 0) return 0;
  store.dispatch(operations, '切分片段');
  return operations.length;
}

export interface KeymapDeps {
  transport: Transport;
  store?: ProjectStore;
  /** 用于测试注入平台；缺省自动探测。 */
  platform?: Platform;
  /** 事件绑定的目标（缺省 window）。 */
  target?: EventTarget;
  /** 导出入口（Ctrl/Cmd+E）：UI 层注入，keymap 不直接持有弹窗状态。 */
  onExport?: () => void;
  /** AI 命令栏入口（Ctrl/Cmd+K）：同样由 UI 层注入。 */
  onAI?: () => void;
  /** 吸附开关变化（顶栏/时间线按钮要跟着变）。 */
  onSnapChange?: (enabled: boolean) => void;
}

/**
 * 安装快捷键监听，返回卸载函数。
 *
 * 输入框聚焦时：只有 Esc 生效（退出焦点），其余按键交给输入框本身。
 * 返回 `true` 表示本次事件被快捷键消费（已 preventDefault）。
 */
export function installKeymap(deps: KeymapDeps): () => void {
  const store = deps.store ?? defaultStore;
  const platform = deps.platform ?? detectPlatform();
  const target = deps.target ?? (typeof window !== 'undefined' ? window : null);
  if (!target) return () => undefined;

  const handler = (rawEvent: Event): void => {
    const event = rawEvent as KeyboardEvent;
    if (event.isComposing) return;

    // 输入框优先：除 Esc 外一律交给输入框自身（Esc 负责退出焦点）
    if (isEditableTarget(event.target)) {
      if (event.key === 'Escape') {
        const element = event.target as HTMLElement;
        element.blur();
      }
      return;
    }

    // 已被更上层处理过的事件不再重复触发（例如弹窗自己消费了 Esc）
    if (event.defaultPrevented) return;

    const binding = findBinding(event, platform);
    if (!binding) return;
    if (event.repeat && binding.repeat !== true) return;

    switch (binding.id) {
      case 'togglePlay':
        event.preventDefault();
        deps.transport.toggle();
        return;
      case 'deleteClip':
        event.preventDefault();
        removeSelectedClip(store);
        return;
      case 'rippleDelete':
        event.preventDefault();
        rippleDeleteSelectedClip(store);
        return;
      case 'splitAtPlayhead':
        event.preventDefault();
        splitAtPlayhead(store);
        return;
      case 'undo': {
        event.preventDefault();
        const result = store.undo();
        if (result) deps.transport.seekTo(store.getPlayheadFrame(), 'preview');
        return;
      }
      case 'redo': {
        event.preventDefault();
        const result = store.redo();
        if (result) deps.transport.seekTo(store.getPlayheadFrame(), 'preview');
        return;
      }
      case 'toggleSnap': {
        event.preventDefault();
        const enabled = store.toggleSnap();
        deps.onSnapChange?.(enabled);
        return;
      }
      case 'stepBack':
        event.preventDefault();
        deps.transport.step(-1);
        return;
      case 'export':
        event.preventDefault();
        deps.onExport?.();
        return;
      case 'ai':
        event.preventDefault();
        deps.onAI?.();
        return;
      case 'markIn':
        event.preventDefault();
        store.setMarkIn(store.getPlayheadFrame());
        return;
      case 'markOut':
        event.preventDefault();
        store.setMarkOut(store.getPlayheadFrame());
        return;
      case 'clearMarks':
        event.preventDefault();
        store.clearMarks();
        return;
      case 'stepForward':
        event.preventDefault();
        deps.transport.step(1);
        return;
      case 'stepBack10':
        event.preventDefault();
        deps.transport.step(-10);
        return;
      case 'stepForward10':
        event.preventDefault();
        deps.transport.step(10);
        return;
      case 'escape':
        return;
      default:
        return;
    }
  };

  target.addEventListener('keydown', handler);
  return () => target.removeEventListener('keydown', handler);
}
