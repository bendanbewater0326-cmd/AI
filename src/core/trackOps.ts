/**
 * 轨道级的"结构性"操作：复制轨道、上移/下移、拖拽排序。
 *
 * ## 为什么单独一个文件
 *
 * 这三个操作**都不是单个 op**：它们要么要新建一条轨 + 复制一堆片段（`addTrack` + N×`addClip`），
 * 要么要把整组 order 重算（`reorderTracks` 一次改多条）。
 * 把它们写成"生成一批 op 的纯函数"，好处是：
 * - 一次 dispatch = **一个撤销步**（复制一条带 20 个片段的轨，Ctrl+Z 一次全回去）；
 * - 纯函数可单测，不需要 DOM / store；
 * - UI 只负责"调用 + 报错"，不重复实现规则。
 *
 * ## 排序的两条硬规则
 *
 * 1. **只能在自己那一组里排**（视频/音频/字幕互不跨越）。跨组移动会让"字幕在最上、
 *    视频居中、音频垫底"的层级乱掉，而用户看不出为什么——剪映也不允许。
 * 2. **order 必须是连续的 0..n-1**。只交换两条轨的 order 会留下空洞，
 *    下次新建轨道时 `order = 同类型数量` 就可能撞上已有的值 → 显示顺序退化成按 id 排
 *    （用户看到"拖了但没动"）。所以一律"整组重算"。
 */
import type { Clip, ClipOperation, Project, Track } from './types';
import { createId, trackDisplayOrder } from './types';
import type { TimelineLayout } from './trackLayout';
import { TRACK_MAX_HEIGHT, TRACK_MIN_HEIGHT } from './trackLayout';

export interface TrackPlan {
  ops: ClipOperation[];
  /** 结果里"这条轨"的新 id（复制时是新轨，排序时是原轨）。 */
  trackId: string;
}

export interface TrackPlanFailure {
  message: string;
}

/** 同类型轨道的**显示顺序**（上 → 下）。排序只在这个列表里做。 */
export function tracksOfKind(doc: Project, kind: Track['kind']): Track[] {
  return trackDisplayOrder(doc.tracks).filter((track) => track.kind === kind);
}

/** 把 `trackId` 在这组里的位置换算成"能不能上移/下移"。 */
export function moveBlockReason(
  doc: Project,
  trackId: string,
  direction: -1 | 1,
): string | null {
  const track = doc.tracks.find((item) => item.id === trackId);
  if (track === undefined) return '轨道不存在';
  const group = tracksOfKind(doc, track.kind);
  const index = group.findIndex((item) => item.id === trackId);
  if (index < 0) return '轨道不存在';
  const target = index + direction;
  if (target < 0) return '已经在最上面';
  if (target >= group.length) return '已经在最下面';
  return null;
}

/**
 * 把一条轨移到同类型列表的第 `targetIndex` 位，生成 `reorderTracks`。
 *
 * 只在"位置真的变了"时返回 ops，否则返回空 ops（调用方可以直接 dispatch，是空操作）。
 */
export function buildMoveTrackOps(
  doc: Project,
  trackId: string,
  targetIndex: number,
): TrackPlan | TrackPlanFailure {
  const track = doc.tracks.find((item) => item.id === trackId);
  if (track === undefined) return { message: '轨道不存在' };

  const group = tracksOfKind(doc, track.kind);
  const from = group.findIndex((item) => item.id === trackId);
  if (from < 0) return { message: '轨道不存在' };

  const clamped = Math.min(group.length - 1, Math.max(0, targetIndex));
  if (clamped === from) return { ops: [], trackId };

  const reordered = [...group];
  reordered.splice(from, 1);
  reordered.splice(clamped, 0, track);

  /**
   * 重算 order：**显示顺序越靠上，order 越大**（与 `trackDisplayOrder` 一致）。
   * 只把真正变化的轨放进 changes，撤销记录才干净。
   */
  const changes: Array<{ trackId: string; from: number; to: number }> = [];
  for (const [index, item] of reordered.entries()) {
    const nextOrder = reordered.length - 1 - index;
    if (item.order !== nextOrder) {
      changes.push({ trackId: item.id, from: item.order, to: nextOrder });
    }
  }
  if (changes.length === 0) return { ops: [], trackId };
  return { ops: [{ op: 'reorderTracks', changes }], trackId };
}

/** 上移 / 下移（`direction`：-1 上移，1 下移）。 */
export function buildShiftTrackOps(
  doc: Project,
  trackId: string,
  direction: -1 | 1,
): TrackPlan | TrackPlanFailure {
  const blocked = moveBlockReason(doc, trackId, direction);
  if (blocked !== null) return { message: blocked };
  const track = doc.tracks.find((item) => item.id === trackId);
  if (track === undefined) return { message: '轨道不存在' };
  const group = tracksOfKind(doc, track.kind);
  const index = group.findIndex((item) => item.id === trackId);
  return buildMoveTrackOps(doc, trackId, index + direction);
}

/** 名字去重：`V1 副本` → `V1 副本 2` → `V1 副本 3`。 */
function uniqueName(doc: Project, base: string): string {
  const taken = new Set(doc.tracks.map((track) => track.name));
  if (!taken.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base} ${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/**
 * 复制一条轨（含它上面的所有片段）。
 *
 * 三条必须做的事：
 * 1. **片段 id 全部重新生成**——同 id 会让 `findClip` 命中旧片段，复制出来的轨
 *    跟着原轨一起动（这类 bug 极难看出原因）；
 * 2. 新轨插到原轨**上方**（`order = 原 order + 1`，上面的整体 +1），
 *    这样"复制一份放到上面调"符合直觉，也避免和原轨抢同一个 order；
 * 3. **锁定/静音/隐藏/独奏全部继承**：用户复制一条静音的轨，期待它还是静音的
 *    （剪映也是继承），否则复制完突然出声很吓人。
 */
export function buildDuplicateTrackOps(
  doc: Project,
  trackId: string,
): TrackPlan | TrackPlanFailure {
  const source = doc.tracks.find((item) => item.id === trackId);
  if (source === undefined) return { message: '轨道不存在' };

  const newTrackId = createId('trk');
  /** 新轨占 `source.order + 1`：原轨及其上方的同组轨都要 +1。 */
  const insertOrder = source.order + 1;
  const group = tracksOfKind(doc, source.kind);
  const changes: Array<{ trackId: string; from: number; to: number }> = [];
  for (const item of group) {
    if (item.order >= insertOrder) {
      changes.push({ trackId: item.id, from: item.order, to: item.order + 1 });
    }
  }

  const track: Track = {
    id: newTrackId,
    kind: source.kind,
    name: uniqueName(doc, `${source.name} 副本`),
    order: insertOrder,
    locked: source.locked,
    muted: source.muted,
    hidden: source.hidden,
    ...(source.solo === true ? { solo: true } : {}),
    ...(typeof source.height === 'number' ? { height: source.height } : {}),
    clips: [],
  };

  /**
   * 片段**整份深拷贝**，只换 `id` 与 `trackId`。
   *
   * 为什么不用 `createClip({...逐字段})`：`Clip` 有 15+ 个字段（`effects` / `keyframes` /
   * `transitionIn/Out` / `role` / `freeze` / `reversed` / `enabled` / `source` …），
   * 而 `CreateClipParams` 只覆盖其中一部分 —— 手写映射**必然漏字段**，
   * 而漏掉的那个恰好是"用户刚调过的那个效果"。深拷贝没有这个问题。
   *
   * 深拷贝而不是共享引用：虽然整个模型是不可变更新的，但"复制出来的轨和原轨共享
   * 同一个 effects 数组"是个定时炸弹（将来任何一处就地修改就会两条轨一起变）。
   */
  const clips: Clip[] = source.clips.map((clip) => ({
    ...(structuredClone(clip) as Clip),
    id: createId('clp'),
    trackId: newTrackId,
  }));

  const ops: ClipOperation[] = [];
  if (changes.length > 0) ops.push({ op: 'reorderTracks', changes });
  ops.push({ op: 'addTrack', track });
  for (const clip of clips) ops.push({ op: 'addClip', clip });
  return { ops, trackId: newTrackId };
}

/**
 * 拖拽排序时：指针的**画布 y** → 会落到第几行（同类型组内下标）+ 指示线画在哪。
 *
 * 判据是"行的中心线"：指针过了某一行的中线就认为插到它下面。
 * 用中线而不是"行的上边界"，是因为用户的目标通常是"放到这一行上面/下面"，
 * 中线给了两边的容错（高轨道尤其明显）。
 *
 * 只能落在**同类型**的行之间：跨类型移动会打乱"字幕→视频→音频"的层级，
 * 而且用户看不出原因。指针跑到别的类型区域时，取该组最近的边界（首/尾）。
 */
export function trackDropTarget(
  layout: TimelineLayout,
  doc: Project,
  trackId: string,
  canvasY: number,
): { targetIndex: number; indicatorTop: number } | null {
  const track = doc.tracks.find((item) => item.id === trackId);
  if (track === undefined) return null;
  const rows = layout.rows.filter((row) => row.kind === track.kind);
  if (rows.length === 0) return null;

  let targetIndex = rows.length;
  for (const [index, row] of rows.entries()) {
    if (canvasY < row.top + row.height / 2) {
      targetIndex = index;
      break;
    }
  }
  const targetRow = rows[targetIndex];
  const lastRow = rows[rows.length - 1];
  const indicatorTop =
    targetRow !== undefined ? targetRow.top : lastRow === undefined ? 0 : lastRow.top + lastRow.height;
  return { targetIndex, indicatorTop };
}

/** 高度夹取（UI 拖拽时用；`apply` 里还会再夹一次，这里是给"显示值"用的）。 */
export function clampTrackHeight(height: number): number {
  return Math.min(TRACK_MAX_HEIGHT, Math.max(TRACK_MIN_HEIGHT, Math.round(height)));
}

/**
 * 拖动轨道头下边缘时，把"指针 y 位移"换算成新高度。
 *
 * 起点高度 + 位移，再夹取。**不要用"指针绝对 y − 轨道 top"**：
 * 那样一开始拖就会跳到指针位置（用户点了下边缘 3px 处，轨道会瞬间缩 3px）。
 */
export function heightFromDrag(startHeight: number, deltaY: number): number {
  return clampTrackHeight(startHeight + deltaY);
}
