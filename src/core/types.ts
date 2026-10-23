/**
 * veditor 领域类型 + 工厂函数 + 错误码 + 宿主协议类型（架构 §4.1 / §11.1）。
 *
 * 全局约定（不得违反）：
 *   - 数据层只有**整数帧**：项目帧（`*Frame` 属项目时基）与素材帧（`inFrame/outFrame`）。
 *   - 帧率一律是**整数毫帧率** `fpsMilli`：30000 / 29970 / 23976 / 25000 / 60000。
 *   - 秒（`*Sec`）只允许出现在校验字段 `durationSec`；毫秒（`*Ms`）只用于防抖/UI。
 *   - 换算只在 `core/timebase.ts` 发生；本文件**不含任何换算**。
 */

/* ---------- 基础 ---------- */

/** 整数毫帧率：30fps = 30000、29.97 = 29970、23.976 = 23976、25 = 25000、59.94 = 59940。 */
export type MilliFps = number;

/** 整数帧。命名后缀约定：项目帧 `*Frame/*Frames`，素材帧 `inFrame/outFrame`。 */
export type Frame = number;

/** 整数微秒，仅 `timebase` 与 WebCodecs 边界使用。 */
export type Us = number;

/** CSS 像素。 */
export type Px = number;

/** 项目音频时基固定 48kHz（R-032），禁止改动。 */
export const PROJECT_SAMPLE_RATE = 48000;

/** 空工程兜底帧率（R-001：30fps）。 */
export const DEFAULT_FPS_MILLI = 30000;

/** 默认工程分辨率。 */
export const DEFAULT_PROJECT_WIDTH = 1920;
export const DEFAULT_PROJECT_HEIGHT = 1080;

/** 撤销栈上限（架构 §7.4）。 */
export const MAX_UNDO_DEPTH = 50;

/** 缩放范围（px/帧，R-029）。 */
export const MIN_ZOOM_LEVEL = 1;
export const MAX_ZOOM_LEVEL = 20;
export const DEFAULT_ZOOM_LEVEL = 5;

/* ---------- 工程 ---------- */

export interface Project {
  id: string;
  name: string;
  /** 项目毫帧率（持久化字段，唯一帧率表示）。 */
  fpsMilli: MilliFps;
  width: number;
  height: number;
  /** 常量 48000。 */
  sampleRate: typeof PROJECT_SAMPLE_RATE;
  /** 常量：越界即 null，不做 clamp（frame-clock-spec §3）。 */
  frameMapPolicy: 'holdPrevious';
  /** 常量：时长换算半上取整。 */
  durationRounding: 'halfUp';
  tracks: Track[];
  assets: Asset[];
  playheadFrame: Frame;
  /** px/帧，1–20。 */
  zoomLevel: Px;
  schemaVersion: number;
  /** epoch ms，仅元数据，不参与剪辑运算。 */
  createdAt: number;
  updatedAt: number;
}

/** 派生值：不写盘、不参与撤销（由 store 计算并提供选择器）。 */
export interface ProjectDerived {
  durationFrames: Frame;
  clipCount: number;
  trackCounts: { video: number; audio: number };
  offlineAssetIds: string[];
}

/* ---------- 素材 ---------- */

export type AssetKind = 'video' | 'audio' | 'image';
export type AssetSourceMode = 'fs' | 'memory';
export type AssetStatus = 'ok' | 'offline' | 'memory';

export interface Asset {
  id: string;
  name: string;
  kind: AssetKind;
  /** FileSystemFileHandle 在 IDB `handles` 中的主键；null = 内存模式。 */
  handleRef: string | null;
  sourceMode: AssetSourceMode;
  /** 运行时探测后写回（不参与撤销）。 */
  status: AssetStatus;
  /** 素材自身毫帧率（VFR 取平均帧率）。 */
  fpsMilli: MilliFps;
  /**
   * **素材时基**整数帧。
   *
   * `null` = 时长无法确定（无 Cues 的 webm / 损坏的 moov，由 Element 兼容模式兜底）。
   * 消费方必须显式判 `null`（`x > null` 恒为 false，会静默跳过校验）。
   */
  durationFrames: Frame | null;
  /** 仅校验用，不参与运算。 */
  durationSec: number;
  sampleRate: number;
  channels: number;
  width: number;
  height: number;
  hasAudio: boolean;
  /** IDB `thumbs` 主键。 */
  thumbnailRef: string | null;
  container: 'mp4' | 'webm' | 'unknown';
  codecVideo: string | null;
  codecAudio: string | null;
  /**
   * 显示旋转（0/90/180/270，顺时针）。
   *
   * 来自 mp4 `tkhd` 变换矩阵：手机竖拍时存储仍是横的，靠这个矩阵告诉播放器要转过来。
   * WebCodecs 不解旋转，所以渲染层必须自己转。**可选**：旧持久化数据没有该字段，按 0 处理。
   */
  rotation?: number;
  /** true = 有 stss 可帧精确 seek；false = 走 Element 兼容模式。 */
  exactSeek: boolean;
  /** `${name}|${size}|${lastModified}`，用于去重（R-003）。 */
  hashKey: string;
  /**
   * 源文件的**路径**（重链时用来在"原文件同级目录"里找）。
   *
   * 浏览器里拿不到完整路径（安全限制），只有：
   * - Electron/宿主注入的工程能带 `absolutePath`；
   * - 用户在文件夹批量重链时，`webkitRelativePath` 能给出相对路径。
   * 所以是可选字段，缺失时降级为"只按文件名 + 大小 + 时长匹配"。
   */
  sourcePath?: string | null;
  /**
   * 文件**前 1MB** 的 SHA-256（十六进制）。
   *
   * 为什么只哈希前 1MB：全文件哈希 4K 素材要几秒到几十秒，而重链是"用户等着看结果"
   * 的交互。前 1MB 足以区分"同一个文件"和"另一个文件"（mp4 的 moov/ftyp 都在头部，
   * 同编码不同内容的文件头一定不同）。
   *
   * 旧工程没有这个字段 → `undefined`，匹配时降级到"名字 + 大小 + 时长"。
   */
  contentHash?: string | null;
  /**
   * 本地草稿缓存池里的**文件名**（`sha256-….mp4`）。
   *
   * 有它就代表"这份素材的字节已经复制进软件自己的存储"，
   * 恢复时**优先从这里读** —— 不再依赖源文件是否还在原地、权限是否过期。
   * `null` / `undefined` = 没缓存（或缓存被清理过），走原来的句柄/路径恢复。
   */
  cacheKey?: string | null;
}

/* ---------- 轨道 ---------- */

/**
 * 轨道类型。
 *
 * `text`（字幕轨）是 2026-10-22 新增的：字幕原先和画面挤在视频轨上，
 * 用户拖字幕时得先想"放哪条"，而且删画面容易连字幕一起删。
 * **默认工程不建字幕轨**（仍然是 V2/V1/A1），需要时从「＋添加轨道」里加。
 */
export type TrackKind = 'video' | 'audio' | 'text';

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  /** 0 起，越大越靠上/越后合成。 */
  order: number;
  locked: boolean;
  muted: boolean;
  hidden: boolean;
  /**
   * 独奏：只要有任意一条轨 `solo`，其它未独奏的轨就不出声也不出画。
   *
   * **判断必须走 `core/trackAudibility.isTrackAudible`**：渲染、预览音频、导出混音
   * 三处各写一遍 `muted || hidden` 的话，加 solo 之后必然出现"预览有、导出没有"。
   */
  solo?: boolean;
  /** 轨道高度（px）。缺省按类型：视频 60 / 音频 50 / 字幕 32（见 `core/trackLayout`）。 */
  height?: number;
  /** invariant：按 `startFrame` 升序。 */
  clips: Clip[];
}

/* ---------- 片段 ---------- */

export type BlendMode = 'normal' | 'overlay' | 'screen' | 'multiply';

/** 用户旋转只允许 90° 步进（任意角度会引入画面外黑边，见 `docs/nle-baseline.md` §6）。 */
export type Rotation = 0 | 90 | 180 | 270;

/** 任意数值 → 最近的合法旋转（负数和 360 的倍数都能吃掉）。 */
export function normalizeRotation(value: unknown): Rotation {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const wrapped = ((Math.round(num / 90) * 90) % 360 + 360) % 360;
  return (wrapped === 90 || wrapped === 180 || wrapped === 270 ? wrapped : 0) as Rotation;
}

export interface Transform {
  /** 1 = 100%，范围 0–5。 */
  scale: number;
  /** 相对画面中心的像素偏移（项目分辨率空间）。 */
  x: number;
  y: number;
  /** 0–1。 */
  opacity: number;
  blendMode: BlendMode;
  /**
   * 用户旋转（90° 步进）。
   *
   * **和 `Asset.rotation` 是两件事**：那个是容器元数据（手机竖拍要自动转正），
   * 这个是用户意图（"我想把它转过来"）。叠加顺序：先容器旋转，再这个，最后翻转。
   */
  rotation: Rotation;
  /** 水平翻转（镜像）。 */
  flipX: boolean;
  /** 垂直翻转。 */
  flipY: boolean;
}

export interface ClipAudio {
  /** 1 = 100%。 */
  gain: number;
  fadeInFrames: Frame;
  fadeOutFrames: Frame;
}

export interface Effect {
  id: string;
  clipId: string;
  type: string;
  params: Record<string, number | string>;
  keyframes: Keyframe[];
  enabled: boolean;
  order: number;
  source: 'ui' | 'ai';
}

export interface Keyframe {
  /** 相对片段入点的项目帧。 */
  frame: Frame;
  property: string;
  value: number;
  easing: 'linear';
}

export interface Transition {
  type: 'crossDissolve' | 'fadeIn' | 'fadeOut';
  durationFrames: Frame;
}

/**
 * 文本片段的内容与样式（R-034）。
 *
 * 文本不建"文字素材"，而是挂在 clip 上：这样复制/裁剪/移动/撤销全都复用片段那套逻辑，
 * 不需要为文字再造一套"素材"生命周期（刷新后素材句柄失效的问题也不会波及文字）。
 */
export interface TextContent {
  content: string;
  /** 相对项目高度的字号（默认 72 @1080p）。 */
  fontSize: number;
  color: string;
  align: 'left' | 'center' | 'right';
  /** 相对画面中心的像素偏移。 */
  x: number;
  y: number;
  /** 半透明底衬，空串 = 无。 */
  background: string;
  /**
   * 粗体（缺省 = 不加粗）。
   *
   * **可选字段必须全链路归一化**：`normalizeText`（工程文件 / 宿主输入）漏了它，
   * 就是"存盘再打开，粗体变回常规"——界面上完全看不出来，只有重开工程才会发现。
   */
  bold?: boolean;
  /**
   * 描边（缺省 = 无）。`width` 是**可见描边粗细**（项目像素），
   * 实现上用 `lineWidth = width * 2` 先描后填，让外侧留 `width`。
   */
  stroke?: { width: number; color: string } | null;
}

export interface Clip {
  id: string;
  assetId: string;
  trackId: string;
  /** **项目时基**起点。 */
  startFrame: Frame;
  /** **素材时基**（含）。 */
  inFrame: Frame;
  /** **素材时基**（不含，exclusive）。 */
  outFrame: Frame;
  /** 项目帧；invariant：=== projectSpanFrames(outFrame - inFrame, asset.fpsMilli, project.fpsMilli)。 */
  durationFrames: Frame;
  /** 1000 = 1x（M2 恒 1000）。 */
  speedMilli: number;
  enabled: boolean;
  transform: Transform;
  audio: ClipAudio;
  effects: Effect[];
  transitionIn: Transition | null;
  transitionOut: Transition | null;
  /** 非空 = 文本片段（`assetId` 为空串，不参与素材帧映射）。 */
  text?: TextContent | null;
  /**
   * 这段内容只取画面还是只取声音（"分离音频"用）。
   *
   * 缺省 = 两者都取（普通视频片段）。分离后：原片段 `video`、音频轨上那条 `audio`，
   * 渲染层跳过 `audio`、音频调度跳过 `video`，于是音画仍然严格同步。
   */
  role?: 'video' | 'audio';
  /**
   * 定格帧：画面永远取 `inFrame` 那一帧（`durationFrames` 可以远大于素材跨度）。
   *
   * 为什么用标记而不是"复制一张图片素材"：复制素材要重新编码一张图、进 IDB、
   * 占解码器；而"一直显示同一帧"本来就是一个映射规则，加一个布尔最省。
   */
  freeze?: boolean;
  /**
   * 倒放：画面按素材区间**反向**取帧。
   *
   * 实现上只改映射（`outFrame - 1 - offset`），**不反向解码**——
   * 反向解码要逐帧 seek，长片段会慢到不可用；而"读到的帧放到相反的时间点"
   * 效果完全一样，且解码器仍是顺序读。
   */
  reversed?: boolean;
  /** 关键帧（R-038）：同一属性 ≥ 2 个才产生动画。`frame` 相对片段起点。 */
  keyframes: Keyframe[];
  source: 'ui' | 'ai';
}

/* ---------- 变更单元（UI 与 AI 唯一载体） ---------- */

export interface ClipPlacement {
  trackId: string;
  startFrame: Frame;
}

export interface TrimState {
  inFrame: Frame;
  outFrame: Frame;
  startFrame: Frame;
  durationFrames: Frame;
}

export interface ProjectParams {
  fpsMilli: MilliFps;
  width: number;
  height: number;
}

/**
 * 轨道的三个布尔开关。
 *
 * - `muted`：不出声（渲染照常）；
 * - `hidden`：不参与渲染/音频/转场/导出（"临时关掉这条轨看看效果"）；
 * - `locked`：**不能改轨道上的片段**（增删改移切都不行），也不能删轨。
 *
 * 三个都走同一个 `setTrackFlag` 操作：它们是同一类东西（轨道布尔属性），
 * 各写一个操作会让 apply/inverse/文案 三处都重复三遍。
 */
export type TrackFlag = 'muted' | 'hidden' | 'locked' | 'solo';

export type ClipOperation =
  | { op: 'addClip'; clip: Clip }
  | { op: 'removeClip'; clipId: string; removed: Clip }
  | { op: 'moveClip'; clipId: string; from: ClipPlacement; to: ClipPlacement }
  | { op: 'trimClip'; clipId: string; from: TrimState; to: TrimState }
  | {
      op: 'splitClip';
      clipId: string;
      /** 切点（项目帧）。左半 = [startFrame, atProjectFrame)。 */
      atProjectFrame: Frame;
      left: TrimState;
      right: TrimState;
      newClipId: string;
    }
  | { op: 'setClipProps'; clipId: string; path: string; from: unknown; to: unknown }
  | {
      op: 'setClipEffect';
      clipId: string;
      effectType: string;
      /** null = 该片段此前没有这个效果（撤销时删除）。 */
      from: Effect | null;
      /** null = 删除该效果。 */
      to: Effect | null;
    }
  | { op: 'setClipText'; clipId: string; from: TextContent | null; to: TextContent | null }
  | { op: 'setClipKeyframes'; clipId: string; from: Keyframe[]; to: Keyframe[] }
  /** 变速：`from`/`to` 是 speedMilli（1000 = 1x），apply 时同步重算 durationFrames。 */
  | { op: 'setClipSpeed'; clipId: string; from: number; to: number }
  | {
      op: 'setClipTransition';
      clipId: string;
      /** `in` = 入场（淡入/交叉溶解），`out` = 出场（淡出）。 */
      side: 'in' | 'out';
      from: Transition | null;
      to: Transition | null;
    }
  | { op: 'addTrack'; track: Track }
  | { op: 'removeTrack'; trackId: string; removed: Track }
  | { op: 'renameTrack'; trackId: string; from: string; to: string }
  | { op: 'setTrackFlag'; trackId: string; flag: TrackFlag; from: boolean; to: boolean }
  /**
   * 轨道高度（拖动轨道头下边缘）。
   *
   * 写进文档而不是只放 ephemeral：高度是"这条轨在这个工程里有多高"，
   * 存盘再打开应该还是那个样子（剪映/PR 都保存轨道高度）。
   * 值在 `apply` 里夹到 24–120，**文档永远合法**，不依赖调用方夹。
   */
  | { op: 'setTrackHeight'; trackId: string; from: number; to: number }
  /**
   * 批量改轨道 `order`（排序/上移下移的唯一实现）。
   *
   * 为什么是**批量**而不是"单条改 order"：同类型轨道的 order 必须保持
   * `0..n-1` 的连续整数，单条改很容易撞号（两条轨同一个 order → 显示顺序
   * 退化成按 id 排，用户看到"拖了但没动"）。一次把整组的 order 重算完，
   * 顺便天然成为**一个撤销步**。
   */
  | { op: 'reorderTracks'; changes: Array<{ trackId: string; from: number; to: number }> }
  /**
   * 删除素材（连同引用它的片段，**一个撤销步**）。
   *
   * 为什么把片段一起带上：素材删了片段就没法解码，留着就是黑屏 + 报错；
   * 而且用户右键删素材时，意图就是"这段东西不要了"。
   */
  | { op: 'removeAsset'; assetId: string; removed: Asset; removedClips: Clip[] }
  /** `removeAsset` 的逆操作（素材与片段一起放回）。 */
  | { op: 'restoreAsset'; asset: Asset; clips: Clip[] }
  | { op: 'rippleShift'; shifts: Array<{ clipId: string; from: Frame; to: Frame }> }
  | { op: 'setProjectParams'; from: ProjectParams; to: ProjectParams };

/* ---------- 撤销 ---------- */

export interface UndoEntry {
  id: string;
  /** 可读描述，例如「移动片段」（R-046）。 */
  label: string;
  ops: ClipOperation[];
  /** 逆向操作，按数组顺序依次应用。 */
  inverses: ClipOperation[];
  source: 'ui' | 'ai';
  /**
   * 合并键（可选）。连续同键的 `dispatch` 会**覆盖同一条撤销记录**，
   * 于是"拖一次音量滑块"只占一个撤销步，而不是二十个。
   */
  mergeKey?: string;
  createdAt: number;
}

export interface UndoStack {
  past: UndoEntry[];
  future: UndoEntry[];
}

/* ---------- 事务（拖动合并的关键） ---------- */

export interface TransactionConfig {
  mergeKey: string;
  label: string;
  source?: 'ui' | 'ai';
}

export interface Transaction {
  id: string;
  label: string;
  source: 'ui' | 'ai';
  /** `move:<clipId>` / `trim:<clipId>:left` / `prop:<clipId>:transform.scale`。 */
  mergeKey: string;
  /** key = mergeKey + ':' + targetId；同 key **替换**而非追加。 */
  ops: Map<string, ClipOperation>;
  /** 只影响绘制，不改 doc。 */
  draft: DragDraft | null;
}

export interface DragDraft {
  kind: 'move' | 'trim';
  clipId: string;
  trackId: string;
  startFrame: Frame;
  inFrame: Frame;
  outFrame: Frame;
  durationFrames: Frame;
  snapLineFrame: Frame | null;
  /** false → 回弹（显示禁止光标）。 */
  valid: boolean;
}

/* ---------- 瞬时视图状态（不写盘、不进撤销） ---------- */

export interface EphemeralState {
  selectedClipId: string | null;
  /** 多选时主选之外的片段（Ctrl/Cmd+点击加入）。 */
  extraSelectedClipIds: string[];
  hoverClipId: string | null;
  drag: DragDraft | null;
  /** M4：AI 建议切点，纯绘制层。 */
  overlayMarks: OverlayMark[];
  /** 入点/出点标记（R-040，项目帧）；null = 未标记。 */
  markIn: Frame | null;
  markOut: Frame | null;
  isPlaying: boolean;
  busyLabel: string | null;
  errors: VEditorError[];
  /**
   * 拖动时是否吸附（`docs/nle-baseline.md` §5：默认开，`N` 切换，按住 `Alt` 临时关）。
   *
   * 放在 ephemeral 而不是 doc：它是"这台机器上我习惯怎么拖"，不该进工程文件、
   * 也不该产生撤销步（切换吸附不该让 Ctrl+Z 有事可做）。
   */
  snapEnabled: boolean;
  /**
   * 从左侧素材库**拖进时间轴**时的落点预览（剪映式拖拽）。
   *
   * 只画不写 doc：拖动期间不产生撤销步，松手才 `dispatch`。
   * `valid === false` 时画红块（视频拖到音频轨、轨道被锁等），松手给可读错误。
   */
  dropGhost: DropGhost | null;
  /** 拖转场时的落点预览（null = 没在拖转场）。 */
  transitionGhost: TransitionGhost | null;
  /** 拖画面特效时的落点预览（null = 没在拖特效）。 */
  effectGhost: EffectGhost | null;
  /**
   * 正在拖动轨道头排序（只画指示线，松手才提交）。
   *
   * 为什么不实时改 `order`：拖动中每次移动都 dispatch 会产生几十个撤销步，
   * 而且时间线要整体重排（片段位置全变），拖动会"抖"。指示线 + 松手提交
   * 是剪映/PR 的做法，也更好测。
   */
  trackDrag: TrackDrag | null;
}

/** 轨道头拖拽排序的预览状态。 */
export interface TrackDrag {
  trackId: string;
  /** 指示线画在哪一行**之前**（画布 y 坐标）。等于总高时画在最下面。 */
  indicatorTop: number;
  /** 松手后会落在第几行（同类型列表里的目标下标）。 */
  targetIndex: number;
}

/** 外部拖入的落点预览（与 `drag` 的区别：`drag` 是时间线内部移动已有片段）。 */
export interface DropGhost {
  trackId: string;
  startFrame: Frame;
  durationFrames: Frame;
  valid: boolean;
  /** 不可落时的可读原因（painter 不画，松手时报给用户）。 */
  reason?: string;
}

/**
 * 转场拖拽的落点预览。
 *
 * 与 `DropGhost` 分开：素材/文字的 ghost 是"在轨道上放一块内容"（有起点 + 时长），
 * 转场是"贴在某个片段的某一侧"（没有独立的时间跨度）—— 共用一个结构会逼着
 * painter 去猜 `durationFrames === 0` 是什么意思。
 */
export interface TransitionGhost {
  clipId: string;
  side: 'in' | 'out';
  /** 画出来的跨度（叠化取 D/2、淡出取 D），只用于视觉反馈 */
  durationFrames: Frame;
  valid: boolean;
  /** 不可落时的可读原因（painter 不画，松手时报给用户） */
  reason?: string;
}

/**
 * 拖**画面特效**时的落点预览。
 *
 * 与前两种 ghost 都不同：特效**没有时间跨度、也没有侧别** —— 它挂在整块片段上。
 * 所以这里只需要"哪一段"，painter 画的是整块片段的描边（绿=能加、红=不能加）。
 *
 * 共用一个结构会逼着 painter 去猜 `durationFrames === 0` / `side` 为空是什么意思。
 */
export interface EffectGhost {
  clipId: string;
  valid: boolean;
  /** 不可落时的可读原因（painter 不画，松手时报给用户） */
  reason?: string;
}

export interface OverlayMark {
  id: string;
  frame: Frame;
  kind: 'suggestedCut';
  label: string;
  actionable: boolean;
}

/* ---------- demux 层返回（运行时，不持久化；架构 §4.1） ---------- */

export interface MediaProbeResult {
  container: 'mp4' | 'webm';
  /** 纯音频 → false。 */
  hasVideo: boolean;
  hasAudio: boolean;
  /** 纯音频无画面尺寸。 */
  width: number | null;
  height: number | null;
  /** 无视频 / 无时长时为 null。 */
  fpsMilli: MilliFps | null;
  /**
   * 素材时基帧数。**null 是合法返回值**（webm 无 Duration 且未扫描 Cluster 时）。
   * 调用方必须显式 `=== null` 判断：不得填 0、不得用 `!` 断言、不得参与 `>`/`<`（`x > null` 恒 false）。
   */
  durationFrames: Frame | null;
  /** avc1.640028 / hvc1.1.6.L93.B0 / vp09.00.10.08。 */
  videoCodec: string | null;
  /** mp4a.40.2 / Opus / vorbis。 */
  audioCodec: string | null;
  sampleRate: number | null;
  channels: number | null;
  /** presentation order 中的关键帧序号；纯音频 = []；无 Cues 且未扫描 = null。 */
  keyframeIndex: number[] | null;
  /** 与 presentation order 一一对应。 */
  samples: SampleIndexEntry[];
  /** false = 无 stss，走 Element 兼容模式。 */
  exactSeek: boolean;
  /** true = 索引不可用，需异步全量扫描后回填（webm 无 Cues / 无 Duration）。 */
  needsIndexScan: boolean;
}

/**
 * 样本索引条目（presentation order）。
 *
 * `dtsUs` 与 `ptsUs` 必须**分别独立存储**：存在 B 帧时二者不同，
 * 把 stts 累加当 PTS 会让播放顺序错乱（架构 §8.2 / R1）。
 */
export interface SampleIndexEntry {
  /** presentation order 序号，== 素材帧号 S。 */
  index: number;
  offset: number;
  size: number;
  /** 解码时间戳（stts 累加）。 */
  dtsUs: number;
  /** 呈现时间戳（dtsUs + ctts offset）。 */
  ptsUs: number;
  /** 来自 stss。 */
  isKey: boolean;
}

/* ---------- 帧渲染结果 ---------- */

export interface FrameResult {
  presentedFrame: Frame;
  /** false = 复用了上一帧（缓存未命中）。 */
  exact: boolean;
  layers: number;
}

/* ---------- 错误 ---------- */

export type ErrorCode =
  | 'E_SECURE_CONTEXT'
  | 'E_NO_WEBCodecs'
  | 'E_UNSUPPORTED_CONTAINER'
  | 'E_UNSUPPORTED_VARIANT'
  | 'E_DECODE_FAILED'
  | 'E_ASSET_OFFLINE'
  | 'E_PERMISSION_DENIED'
  /** 空间不够：用户可清理旧缩略图/旧工程后重试。 */
  | 'E_QUOTA_EXCEEDED'
  /** 浏览器不给用 IndexedDB / 版本冲突 / 被其他标签页占用：重试与清理都无效，需要换运行环境。 */
  | 'E_IDB_UNAVAILABLE'
  /** @deprecated 旧口径，代码不再产生；保留仅为兼容既有文档与历史工程。 */
  | 'E_IDB_QUOTA'
  | 'E_AUDIO_UNAVAILABLE'
  | 'E_DECODER_EXHAUSTED'
  | 'E_INVALID_TIMECODE'
  | 'E_NO_MODEL'
  /** 宿主通道（R-050）：命令不认识 / 工程 JSON 不合法 / 载荷缺失 / 区间非法 / 格式不支持。 */
  | 'E_UNSUPPORTED_COMMAND'
  | 'E_INVALID_PROJECT'
  | 'E_INVALID_PAYLOAD'
  | 'E_INVALID_RANGE'
  | 'E_UNSUPPORTED_FORMAT';

export interface VEditorError {
  code: ErrorCode;
  message: string;
  detail?: string;
  at: number;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: VEditorError };

/* ---------- 宿主协议（§11.1；R-050） ---------- */

export interface InitialSource {
  url?: string;
  file?: File;
  name?: string;
}

/**
 * 宿主 → 编辑器的命令（postMessage 通道，R-050）。
 *
 * `id` 是**可选关联号**：宿主带什么就原样回什么，用来把响应和请求对上
 * （宿主可能同时发多条）。不带也能用，按 `type` 匹配即可。
 *
 * 为什么只有这四条：宿主需要的是"读工程 / 写工程 / 送素材 / 出片"，
 * 而不是直接操作内部状态。任何更细的操作都应该走 AI 白名单或 UI，
 * 否则宿主脚本会把撤销栈写坏（M4 的教训）。
 */
export type HostCommand =
  | { type: 'setProject'; id?: string; project: Project }
  | { type: 'getProject'; id?: string }
  | {
      type: 'importAsset';
      id?: string;
      /** 三选一：远程 URL（需目标站 CORS 允许）/ 内联 data URL / 直接给字节。 */
      url?: string;
      dataUrl?: string;
      buffer?: ArrayBuffer;
      name?: string;
      /**
       * 绑定到已有素材 id（R-054 "素材待重连"）：工程 JSON 里只有素材元数据，
       * 字节必须重新送进来。带上它，片段立刻恢复出画，而不是新建一个孤立素材。
       */
      assetId?: string;
    }
  | {
      type: 'export';
      id?: string;
      /**
       * `audio` 是 `wav` 的旧别名；`webm` 不支持（回 `E_UNSUPPORTED_FORMAT`）；
       * `png` = 透明通道的 RGBA 序列（回 ZIP 字节，R-062）。
       */
      format: 'mp4' | 'gif' | 'wav' | 'png' | 'audio' | 'webm';
      /** 导出区间（项目帧，`endFrame` 独占）；缺省为整条时间线。 */
      startFrame?: number;
      endFrame?: number;
      /** GIF 专用。 */
      gifWidth?: number;
      gifFps?: number;
    };

/** 编辑器 → 宿主的响应：每条命令恰好一条。 */
export type HostCommandResult =
  | {
      ok: true;
      project?: Project;
      assetId?: string;
      schemaVersion?: number;
      filename?: string;
      mime?: string;
      size?: number;
      /** 导出字节（postMessage 通道会 transfer 过去，不复制）。 */
      buffer?: ArrayBuffer;
    }
  | { ok: false; code: string; message: string };

/** 把结果回给命令发起方（非 postMessage 通道是 no-op）。 */
export type HostReply = (result: HostCommandResult) => void;

export type HostEvent =
  | { type: 'ready'; schemaVersion: number }
  | { type: 'projectChanged'; project: Project }
  | { type: 'error'; code: ErrorCode; message: string }
  | { type: 'exportProgress'; ratio: number; stage: string }
  | { type: 'exportDone'; filename: string; size: number };

/**
 * 宿主注入的模型端口（R-047）。
 *
 * `context` 是**已序列化的工程上下文 JSON 字符串**（不含素材字节），
 * 宿主可以完全忽略它，只用 `prompt`。
 */
/**
 * 语音识别请求（R-059）。
 *
 * 为什么是**单声道 16k Float32**：这是几乎所有 ASR 模型/服务的公共输入格式
 * （Whisper、云端接口、浏览器侧的 onnx 模型都一样）。宿主不需要关心我们的
 * 工程采样率与声道数——客户端负责混音、下混、重采样到这一种格式。
 */
export interface TranscribeRequest {
  audio: Float32Array;
  sampleRate: number;
  /** 语言提示：`zh` / `en` / `auto`（`auto` 交给宿主自己判）。 */
  language: string;
  /** 长音频分块进度（0..1），宿主可选实现。 */
  onProgress?: (ratio: number) => void;
}

/** 一段转写结果（秒，相对音频开头）。 */
export interface TranscriptSegment {
  startSec: number;
  endSec: number;
  text: string;
}

export interface Transcript {
  segments: TranscriptSegment[];
  /** 实际识别到的语言（宿主可选回传）。 */
  language?: string;
}

export interface AIModelPort {
  complete(request: {
    prompt: string;
    context: unknown;
  }): Promise<{ text: string; operations?: ClipOperation[] }>;
  /**
   * 语音识别（R-059 的可选能力）。
   *
   * **不实现 = 没有语音识别**：命令栏会给可读拒绝（"当前客户端未提供转写通道"），
   * 而不是假装能转写再给一份空字幕。纯前端没有本地 ASR 模型，这是硬边界。
   */
  transcribe?(request: TranscribeRequest): Promise<Transcript>;
}

export interface HostAdapter {
  readonly kind: 'null' | 'url-param' | 'postmessage' | 'webcomponent';
  getInitialSource(): Promise<InitialSource | null>;
  onCommand(callback: (command: HostCommand, reply: HostReply) => void): () => void;
  postEvent(event: HostEvent): void;
  getAIModel(): AIModelPort | null;
  dispose(): void;
}

export interface VeditorHandle {
  loadSource(source: InitialSource): Promise<Result<string>>;
  getProject(): Project;
  setProject(project: Project): Result<void>;
  destroy(): void;
}

/* ---------- 工厂函数 ---------- */

let idCounter = 0;

/** 生成稳定唯一 id（无 crypto 依赖，core 可在 Node 单测）。 */
export function createId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`;
}

/** 默认变换：100% / 无偏移 / 不透明 / 正常混合。 */
export function createTransform(overrides: Partial<Transform> = {}): Transform {
  return {
    scale: 1,
    x: 0,
    y: 0,
    opacity: 1,
    blendMode: 'normal',
    rotation: 0,
    flipX: false,
    flipY: false,
    ...overrides,
  };
}

/** 默认音频参数。 */
export function createClipAudio(overrides: Partial<ClipAudio> = {}): ClipAudio {
  return { gain: 1, fadeInFrames: 0, fadeOutFrames: 0, ...overrides };
}

/** 创建空轨道。 */
export function createTrack(overrides: Partial<Track> & { id?: string } = {}): Track {
  return {
    id: overrides.id ?? createId('trk'),
    kind: overrides.kind ?? 'video',
    name: overrides.name ?? 'V1',
    order: overrides.order ?? 0,
    locked: overrides.locked ?? false,
    muted: overrides.muted ?? false,
    hidden: overrides.hidden ?? false,
    ...(overrides.solo === true ? { solo: true } : {}),
    ...(typeof overrides.height === 'number' ? { height: overrides.height } : {}),
    clips: overrides.clips ? [...overrides.clips] : [],
  };
}

/**
 * 默认轨道：V2 / V1 / A1 三条空轨（架构 §7.6 / PRD §7.1）。
 *
 * 为什么必须有：四区骨架画的就是三条轨；双击素材上轨需要默认接收轨；
 * 若"首个片段时才建轨"，那一次建轨会额外产生一个撤销步，用户按 Ctrl+Z 会先撤销"建轨"。
 *
 * **数组顺序是「存储顺序」（order 升序、同 order 按 id），不是屏幕顺序**——
 * 屏幕自上而下必须是 V2 / V1 / A1（PRD R-023），由 `trackDisplayOrder()` 换算。
 * 两套顺序分开的原因：`sortTracks` 必须对 addTrack/removeTrack 幂等且可逆，
 * 而视觉层级要按 `order` 从高到低、音频轨永远垫底；把两者塞进同一个 sort 会让
 * 撤销后的数组顺序与初始不一致。
 */
export function createDefaultTracks(): Track[] {
  return [
    createTrack({ id: 'trk_A1', kind: 'audio', name: 'A1', order: 0 }),
    createTrack({ id: 'trk_V1', kind: 'video', name: 'V1', order: 0 }),
    createTrack({ id: 'trk_V2', kind: 'video', name: 'V2', order: 1 }),
  ];
}

/** 创建空工程（默认 30fps / 1920×1080 / 三条空轨 / 无素材）。 */
export function createProject(overrides: Partial<Project> = {}): Project {
  const now = Date.now();
  return {
    id: overrides.id ?? createId('prj'),
    name: overrides.name ?? '未命名工程',
    fpsMilli: overrides.fpsMilli ?? DEFAULT_FPS_MILLI,
    width: overrides.width ?? DEFAULT_PROJECT_WIDTH,
    height: overrides.height ?? DEFAULT_PROJECT_HEIGHT,
    sampleRate: PROJECT_SAMPLE_RATE,
    frameMapPolicy: 'holdPrevious',
    durationRounding: 'halfUp',
    tracks: overrides.tracks ? [...overrides.tracks] : createDefaultTracks(),
    assets: overrides.assets ? [...overrides.assets] : [],
    playheadFrame: overrides.playheadFrame ?? 0,
    zoomLevel: overrides.zoomLevel ?? DEFAULT_ZOOM_LEVEL,
    schemaVersion: overrides.schemaVersion ?? 1,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

/**
 * **合成顺序**（数字越大越后画 = 越靠上）：文字轨永远盖在视频轨之上。
 *
 * 与 `trackDisplayOrder`（时间线上的**屏幕**顺序）不是一回事：
 * 屏幕顺序是"文字轨排在最上面一行"，而合成顺序是"文字盖在画面上"——
 * 两者的方向相反，混用会让字幕被视频盖住。
 *
 * 为什么不能直接用 `track.order`：它只在**同类型**内唯一
 * （视频 0/1/2…、文字 0/1…），"文字 0"和"视频 0"会撞号，
 * 排序结果退化成按 startFrame/index —— 表现就是"加了字但画面上看不见"
 * （实测：文字落到新建的 T1 后，被 V2 盖住，预览像素一点没变）。
 */
export function trackCompositeOrder(track: Track): number {
  if (track.kind === 'text') return 10000 + track.order;
  if (track.kind === 'audio') return -10000 + track.order;
  return track.order;
}

/**
 * 屏幕顺序（自上而下）：视频轨按 `order` 从高到低，音频轨永远垫底（`order` 从高到低）。
 *
 * 时间线绘制与命中测试**必须**共用这个函数——两处各自排序一次就会出现
 * "画在第 1 行、点第 2 行才选中"的错位，而且只在多轨时暴露。
 */
export function trackDisplayOrder(tracks: readonly Track[]): Track[] {
  /**
   * 屏幕顺序：**字幕在最上、视频居中、音频垫底**（剪映/PR 都是这个层级）。
   *
   * 为什么字幕在最上：字幕是"贴在画面上的东西"，放最上面才能一眼看到"这段说了什么"；
   * 而且它高度最矮，放在顶部不占视线。
   */
  const rank = (track: Track): number => (track.kind === 'text' ? 0 : track.kind === 'audio' ? 2 : 1);
  return [...tracks].sort((left, right) => {
    const rankDiff = rank(left) - rank(right);
    if (rankDiff !== 0) return rankDiff;
    if (left.order !== right.order) return right.order - left.order;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

export interface CreateAssetParams {
  id?: string;
  name: string;
  kind?: AssetKind;
  handleRef?: string | null;
  sourceMode?: AssetSourceMode;
  status?: AssetStatus;
  fpsMilli: MilliFps;
  /** `null` = 时长不可知（webm 无 Cues 等），映射时跳过素材边界校验。 */
  durationFrames: Frame | null;
  durationSec?: number;
  sampleRate?: number;
  channels?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  thumbnailRef?: string | null;
  container?: 'mp4' | 'webm' | 'unknown';
  codecVideo?: string | null;
  codecAudio?: string | null;
  rotation?: number;
  exactSeek?: boolean;
  hashKey?: string;
  sourcePath?: string | null;
  contentHash?: string | null;
  cacheKey?: string | null;

}

/** 创建素材记录（探测结果落成 doc 内的 Asset）。 */
export function createAsset(params: CreateAssetParams): Asset {
  return {
    id: params.id ?? createId('ast'),
    name: params.name,
    kind: params.kind ?? 'video',
    handleRef: params.handleRef ?? null,
    sourceMode: params.sourceMode ?? 'memory',
    status: params.status ?? 'memory',
    fpsMilli: params.fpsMilli,
    durationFrames: params.durationFrames,
    durationSec: params.durationSec ?? 0,
    sampleRate: params.sampleRate ?? PROJECT_SAMPLE_RATE,
    channels: params.channels ?? 2,
    width: params.width ?? 0,
    height: params.height ?? 0,
    hasAudio: params.hasAudio ?? false,
    thumbnailRef: params.thumbnailRef ?? null,
    container: params.container ?? 'unknown',
    codecVideo: params.codecVideo ?? null,
    codecAudio: params.codecAudio ?? null,
    rotation: params.rotation ?? 0,
    exactSeek: params.exactSeek ?? false,
    hashKey: params.hashKey ?? `${params.name}|0|0`,
    ...(params.sourcePath === undefined ? {} : { sourcePath: params.sourcePath }),
    ...(params.contentHash === undefined ? {} : { contentHash: params.contentHash }),
    ...(params.cacheKey === undefined ? {} : { cacheKey: params.cacheKey }),
  };
}

export interface CreateClipParams {
  id?: string;
  assetId: string;
  trackId: string;
  startFrame: Frame;
  inFrame: Frame;
  outFrame: Frame;
  durationFrames: Frame;
  speedMilli?: number;
  enabled?: boolean;
  transform?: Partial<Transform>;
  audio?: Partial<ClipAudio>;
  text?: TextContent | null;
  keyframes?: Keyframe[];
  source?: 'ui' | 'ai';
  role?: 'video' | 'audio';
  freeze?: boolean;
  reversed?: boolean;
}

/**
 * 一个片段能挂多长的转场（帧）。
 *
 * 为什么是"片段长度的一半"而不是"不超过片段长度"：
 * 转场窗口是**以接缝为中心**的（`transitionPlan`：前半段在外、后半段在内），
 * 而且同一个片段可以同时挂 `transitionIn` 和 `transitionOut`。
 * 若允许各自等于片段长度，两段窗口会把整个片段吃满——中间**永远到不了不透明度 1**，
 * 画面一直半透明（看起来像"蒙了一层灰"，很难归因）。
 * 取一半则保证：即便进出都有转场，中间仍有一整段完全不透明的画面。
 *
 * 放在 `core/types` 是因为三处都要用（属性栏夹、工程导入夹、渲染兜底），
 * 而 `host/projectInput` 只允许依赖 core——规则只能有一个定义点。
 */
export function maxTransitionFrames(clip: Pick<Clip, 'durationFrames'>): Frame {
  return Math.max(1, Math.floor(clip.durationFrames / 2));
}

/** 创建片段（durationFrames 必须由调用方用 timebase 算好）。 */
export function createClip(params: CreateClipParams): Clip {
  return {
    id: params.id ?? createId('clp'),
    assetId: params.assetId,
    trackId: params.trackId,
    startFrame: params.startFrame,
    inFrame: params.inFrame,
    outFrame: params.outFrame,
    durationFrames: params.durationFrames,
    speedMilli: params.speedMilli ?? 1000,
    enabled: params.enabled ?? true,
    transform: createTransform(params.transform ?? {}),
    audio: createClipAudio(params.audio ?? {}),
    effects: [],
    transitionIn: null,
    transitionOut: null,
    text: params.text ?? null,
    keyframes: params.keyframes ? [...params.keyframes] : [],
    source: params.source ?? 'ui',
    ...(params.role === undefined ? {} : { role: params.role }),
    ...(params.freeze === true ? { freeze: true } : {}),
    ...(params.reversed === true ? { reversed: true } : {}),
  };
}

/** 默认文字样式（R-034：安全区内居中）。 */
export function createTextContent(overrides: Partial<TextContent> = {}): TextContent {
  return {
    content: '点击编辑文字',
    fontSize: 72,
    color: '#ffffff',
    align: 'center',
    x: 0,
    y: 0,
    background: '',
    ...overrides,
  };
}

/** 构造错误对象（`at` 自动填当前时间）。 */
export function makeError(code: ErrorCode, message: string, detail?: string): VEditorError {
  const error: VEditorError = { code, message, at: Date.now() };
  if (detail !== undefined) error.detail = detail;
  return error;
}

/** 成功结果。 */
export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

/** 失败结果。 */
export function fail<T>(error: VEditorError): Result<T> {
  return { ok: false, error };
}

/** 从 Result 取错误（用于日志）。 */
export function errorOf(result: Result<unknown>): VEditorError | null {
  return result.ok ? null : result.error;
}
