/**
 * 四区组合（T11 / PRD §7.1）：顶栏 32 / 左栏 110 / 中预览 + 控件条 36 / 右栏 110 / 时间线 220。
 *
 * 职责：
 *   - 组合 `TopBar` 与三块占位区（T12–T16 会换成真实面板）；
 *   - 接入 `Transport`（T08）做播放/暂停与逐帧，把帧号写回 store 的播放头总线；
 *   - 安装快捷键（`core/keymap`）；
 *   - 错误条（最多 3 条、可关闭）与 aria-live 播报；
 *   - 非生产构建注入只读测试钩子 `window.__VEDITOR_TEST__`（T16 用）。
 *
 * 本文件不做任何时基换算：时间码显示走 `formatTimecode`（UI 显示层），
 * 播放头推进走 `transport`（内部只用 `secondsToFrames`）。
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { Asset, DropGhost, EffectGhost, Project, TrackDrag, TransitionGhost } from '../core/types';
import { installKeymap } from '../core/keymap';
import { store, useDoc, useErrors, useFrame, useSelection } from '../core/store';
import { trackLayout } from '../core/trackLayout';
import { formatDb, formatPercent, positionToDb, positionToGain } from '../core/volume';
import { createTransport } from '../media/playbackClock';
import type { Transport } from '../media/playbackClock';
import {
  capturePreviewStats,
  ensurePreviewEngine,
  getExportProbe,
  getLastRenderError,
  getPreviewProbe,
  getProxyState,
  peekDecoderPool,
  peekPreviewEngine,
  renderPreviewFrame,
  repaintPreview,
  setPreferProxy,
} from '../media/previewSource';
import type { PreviewRegion } from '../media/previewSource';
import { createAudioScheduler } from '../media/audioEngine';
import type { AudioScheduler } from '../media/audioEngine';
import { attachAutosave, restoreSession } from '../persist/autosave';
import { isBackupDue, latestBackup, writeBackup, writeExitBackup } from '../persist/backup';
import { db as veditorDb } from '../persist/db';
import { shortcutHint } from './settings/keymapView';
import { probeMediaFile } from '../media/importPipeline';
import { relinkAssetFromFile } from '../media/relink';
import { autoRestoreFromDirectories, restoreFromCache, restoreFromHostPaths } from '../media/autoRestore';
import { cacheStats, currentBackend, isCacheAvailable, pendingCacheJobs } from '../media/draftCache';
import { unregisterPreviewSource } from '../media/previewSource';
import { getAIProvider, setAIProvider } from '../ai/registry';
import type { AIProvider } from '../ai/provider';
import { MemoryModeBanner } from './AssetPanel';
import { CommandBar } from './CommandBar';
import { InspectorPanel } from './InspectorPanel';
import { LeftPanel, getActiveLeftTab } from './LeftPanel';
import { Splitter, applyPanelWidth, hasStoredPct, readStoredCollapsed, readStoredPct, storeCollapsed, storePct } from './splitter';
import { Toast } from './Toast';
import type { ToastPayload } from './Toast';
import { TimelineView } from './TimelineView';
import { restoreTheme } from './theme';
import { TopBar, formatTimecode, parseTimecode } from './TopBar';

const selectFps = (doc: Project): number => doc.fpsMilli;
const selectAssets = (doc: Project): number => doc.assets.length;

/** 非生产构建的测试钩子（T16 验收用；只读，禁止改 doc）。 */
/** 一个区域的屏幕矩形（CSS 像素）。 */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface VeditorTestHooks {
  commitCount: number;
  docVersion: () => number;
  playheadFrame: () => number;
  lastFrameResult: () => unknown;
  openSessions: () => number;
  openFrames: () => number;
  /** 只读快照：每条轨上的片段（T12 上轨、T16 拖动验收用）。 */
  clips: () => Array<{
    id: string;
    trackId: string;
    assetId: string;
    startFrame: number;
    inFrame: number;
    outFrame: number;
    durationFrames: number;
    /** 是否可见/可渲染（多机位 R-057 靠它逐帧扫"当前哪个机位"）。 */
    enabled: boolean;
    /** 只取画面 / 只取声音（分离音频后设置）。 */
    role: 'video' | 'audio' | null;
    /** 文本片段的内容与样式（非文本片段为 null）。 */
    text: {
      content: string;
      fontSize: number;
      color: string;
      align: string;
      x: number;
      y: number;
      background: string;
      bold: boolean;
      stroke: { width: number; color: string } | null;
    } | null;
    /** 生效中的效果类型（C 批：colorGrade）。 */
    effects: string[];
    /**
     * 完整效果对象（含 `params` / `enabled`）。
     *
     * `effects` 只有类型字符串，断言不了"饱和度是不是 -100"、"是不是只剩一条"——
     * 特效面板的验收（同类型单例、参数正确）必须看到参数。
     */
    effectDetails: Array<{ type: string; params: Record<string, number | string>; enabled: boolean }>;
    /** 音量与淡化（C 批：R-037）。 */
    audio: { gain: number; fadeInFrames: number; fadeOutFrames: number };
    /** 转场（C2：R-033）。 */
    transitions: { in: string | null; out: string | null };
    /** 完整转场对象（含 durationFrames）；transitions 只给 type 字符串，保留兼容。 */
    transitionDetails: {
      in: { type: string; durationFrames: number } | null;
      out: { type: string; durationFrames: number } | null;
    };
  }>;
  /** 只读快照：素材条目（T12 导入/去重/音频判定验收用）。 */
  assets: () => Array<{
    id: string;
    name: string;
    kind: string;
    durationFrames: number | null;
    durationSec: number;
    fpsMilli: number;
    hasAudio: boolean;
    /** 音频参数（诊断"声音不对"时最关键的两个数：采样率错了会变调，声道数错了会变调/串音）。 */
    sampleRate: number;
    channels: number;
    /** 素材状态（R-054 迁入后为 offline，重连后变 memory）。 */
    status: string;
    /** 去重键（`name|size|lastModified`）。 */
    hashKey: string;
    /** 内容指纹（前 1MB），重链匹配与缓存键都靠它。 */
    contentHash?: string | null;
    /** 本地草稿缓存里的文件名（null = 没缓存）。 */
    cacheKey?: string | null;
  }>;
  /** 工程元信息（R-054 迁入/导出比对用）。 */
  projectMeta: () => { name: string; width: number; height: number; fpsMilli: number };
  /** 只读快照：轨道（T12 上轨落位、T15 绘制验收用）。 */
  tracks: () => Array<{
    id: string;
    kind: string;
    order: number;
    clips: number;
    name: string;
    muted: boolean;
    /** 隐藏（不参与渲染/导出）与锁定（不能改上面的片段）——轨道头开关验收用。 */
    hidden: boolean;
    locked: boolean;
  }>;
  /** 只读快照：当前错误条（T12 显式拒绝验收用）。 */
  errors: () => Array<{ code: string; message: string }>;
  /**
   * 清空错误条（E2E 用）。
   *
   * 断言"这一次操作有没有报错"之前必须先把之前的清掉 —— 否则读到的
   * `errors()[0]` 是几步之前留下的那条，测试会在"该报错时通过、不该报错时也通过"。
   */
  dismissAllErrors: () => void;
  /**
   * 测试用：给当前通道装一个"转写"能力（等价于宿主注入 `transcribe`）。
   *
   * 为什么要开这个口子：语音识别（R-059）的真实链路是"抽音频 → 宿主转写 → 落字幕"，
   * 中间那段（混音/下混/重采样到 16k）是本项目最该被验证的部分，而它**只有真浏览器里
   * 有 WebCodecs 才能跑**。没有注入点就只能用单测证明数学，证不了这条链路。
   * 它不修改 doc、只换一个通道，与"只读"约定不冲突；生产构建里不存在。
   */
  installTranscriber: (transcribe: AIProvider['transcribe']) => void;
  /** 预览画面像素统计（T13 验收用；走合成器 FBO 读回，不是 drawImage）。 */
  previewSnapshot: (region?: PreviewRegion) => Promise<{ nonBlack: number; total: number; maxLuma: number; meanLuma: number } | null>;
  /** 播放引擎统计（T19 诊断：decodeFailures/inexactCount）。 */
  previewStats: () => { renderCount: number; decodeFailures: number; inexactCount: number; maxInexactRun: number } | null;
  derived: () => { durationFrames: number; clipCount: number };
  /** 时间线缩放（px/帧）。E2E 要把帧号换算成点击坐标，硬编码会随默认值变化而失效。 */
  zoomLevel: () => number;
  /** 拖拽落点预览（null = 没有在拖）。 */
  dropGhost: () => DropGhost | null;
  /** 拖转场时的落点预览（null = 没在拖转场）。 */
  transitionGhost: () => TransitionGhost | null;
  /** 拖画面特效时的落点预览（null = 没在拖特效）。 */
  effectGhost: () => EffectGhost | null;
  /** 轨道排序拖拽预览（null = 没在拖）。 */
  trackDrag: () => TrackDrag | null;
  /**
   * **四区布局几何**（UI 重构的验收依据）。
   *
   * 为什么需要：布局从"固定 px"改成"百分比 + 可拖拽"之后，
   * 任何"断言顶栏 32px / 左栏 110px"的测试都会失效。
   * 测试应该断言**位置关系与合理范围**，而不是锁死某个数值 ——
   * 这个钩子就是那些断言的唯一来源。
   */
  uiLayout: () => {
    window: { w: number; h: number };
    workspace: Box | null;
    topbar: Box | null;
    left: Box | null;
    /** 左栏内部的 44px 图标条与 Tab 内容区（S1.3：图标条算在 25% 之内）。 */
    leftRail: Box | null;
    leftContent: Box | null;
    right: Box | null;
    stage: Box | null;
    ctrlbar: Box | null;
    timeline: Box | null;
    timelineViewport: Box | null;
    timelineCanvas: Box | null;
    previewCanvas: Box | null;
    /** 布局用的 CSS 变量当前值（px 或 %）。 */
    vars: Record<string, string>;
  };
  /** 左栏当前激活的 Tab（`media` / `audio` / … / `settings`），S1.3 验收用。 */
  leftTab: () => string;
  /** 时间线几何（E2E 坐标换算的唯一来源，别再硬编码 56/24）。 */
  timelineLayout: () => {
    headerWidth: number;
    rulerHeight: number;
    rows: Array<{ trackId: string; kind: string; name: string; top: number; height: number; index: number }>;
    totalHeight: number;
  };
  selectClip: (clipId: string) => void;
  /** 改轨道标志（隐藏/静音/锁定/独奏）—— 与按钮、右键菜单走**同一个** store 方法。 */
  setTrackFlag: (trackId: string, flag: 'muted' | 'hidden' | 'locked' | 'solo', value: boolean) => void;
  /** 提交一批操作（Agent/API 路径的替身：绕过 UI 直接改文档）。 */
  dispatch: (ops: Parameters<typeof store.dispatch>[0], label?: string) => void;
  /** 各轨音频闸门值（0..1）。验证"静音/独奏真的到了音频链路"。 */
  audioTrackGains: () => Record<string, number>;
  /** 把素材状态改成指定值（E2E 模拟"刷新后离线"，浏览器里没法真的刷）。 */
  setAssetStatus: (assetId: string, status: Asset['status']) => void;
  /**
   * 自动恢复阶段（E2E 用）。
   *
   * 真实的"刷新 → 恢复"在测试里没法触发（CDP 无法模拟 FS Access 授权），
   * 所以这里暴露 setter，让测试能验证"恢复期间不弹离线条"这条闸门逻辑。
   */
  setAutoRestoreDone: (done: boolean) => void;
  /** 本地草稿缓存池的状态（E2E / 自检用）。 */
  cacheInfo: () => Promise<{
    available: boolean;
    kind: 'opfs' | 'host' | null;
    count: number;
    bytes: number;
    /** 还在排队的拷贝任务数（0 = 后台已经写完，可以测性能了）。 */
    pending: number;
  }>;
  /** 手动触发"从缓存恢复"（E2E 用：验证缓存能独立救回素材）。 */
  restoreFromCacheNow: () => Promise<string[]>;
  /**
   * 用 URL 里的文件重链一个素材（E2E 专用）。
   *
   * 为什么要这个钩子：CDP 无法操作系统文件选择框，所以"选文件"这一步没法自动化。
   * 这里直接把 URL 变成 `File` 走**同一条** `relinkAssetFromFile`，
   * 覆盖的是真正容易错的部分（探测 / 写回 / 清缓存 / 重绘）。
   */
  relinkAssetFromUrl: (assetId: string, url: string) => Promise<string>;
  play: () => void;
  pause: () => void;
  /** 当前选中片段（null = 未选中）。交互类 E2E 用它判断点到了没有，比看属性栏 disabled 可靠。 */
  selection: () => string | null;
  /**
   * **全部**选中片段（主选 + 加选）。
   *
   * `selection()` 只返回主选 —— 多选是"主选 + 若干次选"，只测主选会漏掉
   * "Ctrl 点击后到底有没有真的多选一个"。
   */
  selectionAll: () => string[];
  /** 把播放头移到指定帧（自检/诊断用；走真实 transport，和用户点标尺等价）。 */
  seek: (frame: number) => void;
  /** 已排期 PCM 的波形统计（诊断"声音失真"：看削顶与峰值）。 */
  audioProbe: () => unknown;
  /** 时间线画布中心处**最上层**的 DOM 元素（诊断"点不动"：有没有透明遮罩挡着）。 */
  domProbe: () => unknown;
  docRepaintInfo: () => { repaints: number; clips: number; skipped: string };
  lastRenderError: () => string;
  /** 单帧解码诊断（T19：直接问解码器池要一帧，返回真实错误而不是被引擎吞掉）。 */
  decodeTest: (assetId: string, frame: number) => Promise<{ ok: boolean; detail: string } | null>;
  /** 音频调度器统计（验证 webm 播放是否有声音：chunks/pcmBytes/scheduledSeconds 均应 > 0）。 */
  audioStats: () => { chunks: number; pcmBytes: number; gaps: number; scheduledSeconds: number; audible: boolean } | null;
  /** 音频链路诊断：池/探针/音频样本表/一次真实 decodeAudioRange 的结果。 */
  audioDiag: () => Promise<{ hasPool: boolean; hasProbe: boolean; audioSamples: number; sampleRate: number; decode: string } | null>;
  /** AI 建议切点帧号（M4：建议模式只能写这里，不能写 doc）。 */
  overlayMarks: () => number[];
  /** 是否还有可撤销的操作（M4：一次 AI 操作 = 1 步）。 */
  canUndo: () => boolean;
  /** 撤销栈顶的标签（null = 栈空）。断言"某操作没进撤销栈"时必须前后各读一次。 */
  lastUndoLabel: () => string | null;
  undo: () => void;
  /** 入点/出点（C2：R-040）。 */
  marks: () => { in: number | null; out: number | null };
  /** 合成器统计（排查"黑屏但层数正常"）。 */
  compositorStats: () => { lastLayerCount: number; skippedLayers: number; lastGlError: number } | null;
  /** 代理状态（R-052）。 */
  proxyState: (assetId: string) => { status: string; ratio: number; width: number; height: number };
  /** 预览与导出各自实际用的素材宽度（验证"预览用代理、导出用原片"）。 */
  proxySources: (assetId: string) => { previewWidth: number | null; exportWidth: number | null };
  /** 开关"预览用代理"。 */
  setPreferProxy: (on: boolean) => void;
  /** 连续渲染 N 帧的平均耗时（毫秒/帧），用于对比代理开关的收益。 */
  renderCost: (frames: number) => Promise<number>;
}

declare global {
  interface Window {
    __VEDITOR_TEST__?: VeditorTestHooks;
  }
}

const testState: {
  commitCount: number;
  lastFrameResult: unknown;
  docRepaints?: number;
  docPaintClips?: number;
  docPaintSkipped?: string;
  /** 轨道状态（隐藏/静音/独奏）变更触发"强制重绘 + 闸门同步"的次数。 */
  trackStateSyncs?: number;
} = {
  commitCount: 0,
  lastFrameResult: null,
};

/** 时间码（高频通道：只有这个组件随播放头重渲染；点击可输入跳转 R-030）。 */
function Timecode({ onSeek }: { onSeek: (frame: number) => void }): ReactElement {
  const frame = useFrame();
  const fpsMilli = useFrameFps();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 进入编辑：预填当前时间码，全选，方便直接覆盖
  useEffect(() => {
    if (editing) {
      setDraft(formatTimecode(frame, fpsMilli));
      // 下一帧聚焦 + 全选（等 DOM 挂上）
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  function commit(): void {
    const parsed = parseTimecode(draft, fpsMilli);
    if (parsed === null) {
      // 非法输入：回退原值 + 保持焦点（R-030）
      setDraft(formatTimecode(frame, fpsMilli));
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }
    onSeek(parsed);
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="v-ctrlbar__timecode v-ctrlbar__timecode--editing"
        data-v="timecode-input"
        type="text"
        value={draft}
        inputMode="numeric"
        aria-label="时间码"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          // 失焦即提交；非法则回退（但已不保持焦点，符合"失焦"语义）
          const parsed = parseTimecode(draft, fpsMilli);
          if (parsed !== null) onSeek(parsed);
          setEditing(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          else if (event.key === 'Escape') setEditing(false);
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className="v-ctrlbar__timecode"
      data-v="timecode"
      aria-label="时间码（点击输入跳转）"
      onClick={() => setEditing(true)}
    >
      {formatTimecode(frame, fpsMilli)}
    </button>
  );
}

/** 帧率是低频值，用独立订阅避免时间码组件绑到 doc 通道。 */
function useFrameFps(): number {
  const [fpsMilli, setFpsMilli] = useState<number>(() => store.getDoc().fpsMilli);
  useEffect(() => store.subscribe(() => setFpsMilli(store.getDoc().fpsMilli)), []);
  return fpsMilli;
}

interface PreviewStageProps {
  playing: boolean;
  onToggle: () => void;
  onSeek: (frame: number) => void;
  /** 当前播放头（逐帧按钮用；与时间线/键盘走同一个 seek）。 */
  frame: number;
  /** 预览总音量（0..2）：只影响监听，不影响导出。 */
  volume: number;
  onVolume: (value: number) => void;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
}

/**
 * 逐帧按钮的图标（内联 SVG，不用 ⏮/⏭）。
 *
 * 理由同 S1.3 的 Tab 图标：这两个字符在 Windows 上会走彩色 emoji 字体，
 * 大小和基线都跟旁边的 ▶ 对不齐，看起来像两套图标混用。
 */
function FrameStepIcon({ dir }: { dir: 'prev' | 'next' }): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6 5v14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d={dir === 'prev' ? 'M19 5l-10 7 10 7z' : 'M5 5l10 7-10 7z'} fill="currentColor" />
    </svg>
  );
}

/** 中列：预览画布（T13 接 playbackEngine）+ 播放控件条。 */
/**
 * 顶部离线条：**离线素材的唯一总入口**。
 *
 * 为什么需要它：素材栏里的「离线」标签只在用户主动看素材栏时才发现，
 * 而"预览黑屏"才是用户真正会注意到的现象。把"有几个离线、怎么修"放在顶部，
 * 用户不需要知道"素材"这个概念也能修好。
 *
 * 三个按钮对应三条修法（都不是装饰）：
 * - **恢复访问**：句柄还在、只是权限过期（最常见，一步搞定，不用选文件）；
 * - **重新链接**：句柄丢了/文件改名了，手动选一个文件；
 * - **批量重链**：整个素材文件夹搬过位置，选一次文件夹全修好。
 */
function OfflineBanner({ autoRestoreDone }: { autoRestoreDone: boolean }): ReactElement | null {
  /**
   * 只订阅 `assets` 数组（引用稳定：doc 不变时是同一个数组），
   * 不订阅整份 doc —— 播放头每帧都在变，订阅整份会让这个条跟着抖。
   */
  const assets = useDoc((doc) => doc.assets);
  const offline = assets.filter((asset) => asset.status === 'offline');
  if (offline.length === 0) return null;
  /**
   * **自动恢复跑完之前不显示离线条**。
   *
   * 刷新后 `restoreSession` 会先把取不到文件的素材标成 offline，
   * 紧接着第二层会自动扫描目录把它们链回来。如果这时就弹离线条，
   * 用户会看到一条"1 个素材离线"闪一下又消失 —— 比不提示更让人不安。
   */
  if (!autoRestoreDone) {
    return (
      <div className="v-offlinebar v-offlinebar--working" data-v="offline-bar-working" role="status" aria-live="polite">
        <span className="v-offlinebar__dot" aria-hidden="true" />
        <span className="v-offlinebar__text">正在自动恢复 {offline.length} 个素材…</span>
      </div>
    );
  }
  const preview = offline.slice(0, 3).map((asset) => asset.name).join('、');
  const more = offline.length > 3 ? ` 等 ${offline.length} 个` : '';
  return (
    <div className="v-offlinebar" data-v="offline-bar" role="status" aria-live="polite">
      <span className="v-offlinebar__dot" aria-hidden="true" />
      <span className="v-offlinebar__text" data-v="offline-bar-text">
        {offline.length} 个素材离线（预览会黑屏）：{preview}
        {more}
      </span>
      <button
        type="button"
        className="v-offlinebar__btn v-offlinebar__btn--primary"
        data-v="offline-relink"
        onClick={() => {
          window.dispatchEvent(new CustomEvent('veditor:relink', { detail: { assetId: offline[0]?.id ?? null } }));
        }}
      >
        重新链接…
      </button>
      <button
        type="button"
        className="v-offlinebar__btn"
        data-v="offline-relink-batch"
        title="选一个文件夹，自动匹配里面的音视频文件"
        onClick={() => window.dispatchEvent(new CustomEvent('veditor:relink-batch'))}
      >
        批量重链…
      </button>
      <button
        type="button"
        className="v-offlinebar__btn"
        data-v="offline-restore"
        title="文件没动、只是权限过期时用这个（不必重新选文件）"
        onClick={() => window.dispatchEvent(new CustomEvent('veditor:relink-restore'))}
      >
        恢复访问
      </button>
    </div>
  );
}

/**
 * 预览区的「素材已离线」提示。
 *
 * 只在**当前播放头处确实有引用离线素材的片段**时显示 ——
 * 否则整条时间线上任意一个离线素材都会让提示常驻，反而变成噪声。
 */
function PreviewOfflineHint(): ReactElement | null {
  const doc = useDoc((current) => current);
  const frame = useFrame();
  const offlineIds = new Set(doc.assets.filter((asset) => asset.status === 'offline').map((asset) => asset.id));
  if (offlineIds.size === 0) return null;
  const hit = doc.tracks.some(
    (track) =>
      !track.hidden &&
      track.clips.some(
        (clip) =>
          offlineIds.has(clip.assetId) &&
          frame >= clip.startFrame &&
          frame < clip.startFrame + clip.durationFrames,
      ),
  );
  if (!hit) return null;
  return (
    <div className="v-stage__offline" data-v="preview-offline-hint">
      <span>素材已离线</span>
      <button
        type="button"
        className="v-stage__offline-btn"
        onClick={() => window.dispatchEvent(new CustomEvent('veditor:relink'))}
      >
        重新链接…
      </button>
    </div>
  );
}

function PreviewStage({ playing, onToggle, onSeek, frame, volume, onVolume, canvasRef }: PreviewStageProps): ReactElement {
  return (
    <section className="v-stage" data-v="stage" aria-label="预览">
      <div className="v-stage__viewport">
        <div className="v-stage__screen" data-v="preview">
          <canvas ref={canvasRef} className="v-stage__canvas" data-v="preview-canvas" />
          <PreviewOfflineHint />
          {/*
            S1.5：控制栏**叠在画面上**（绝对定位、底部居中），不再独占一行。
            这样预览区能多出 36px 高度；DOM 里放在 screen 内部，是为了让它跟着
            16:9 画面走（画面留黑边时也贴在画面底边，而不是整个舞台的底边）。
            内容与事件一个没动：播放/上一帧/下一帧/时间码/音量全在原处。
          */}
          <div className="v-ctrlbar" data-v="ctrlbar">
            {/*
              逐帧：与键盘 ←/→ 走**同一个** onSeek（transport.seekTo），不新增任何逻辑。
              夹到 0 只是防止负帧号，上界交给 transport。
            */}
            <button
              type="button"
              data-v="frame-prev"
              title={`上一帧（${shortcutHint("stepBack")}）`}
              aria-label="上一帧"
              onClick={() => onSeek(Math.max(0, frame - 1))}
            >
              <FrameStepIcon dir="prev" />
            </button>
            <button
              type="button"
              data-v="play-toggle"
              title={`${playing ? '暂停' : '播放'}（${shortcutHint('togglePlay')}）`}
              aria-label={playing ? '暂停' : '播放'}
              aria-pressed={playing}
              onClick={onToggle}
            >
              {playing ? '❚❚' : '▶'}
            </button>
            <button
              type="button"
              data-v="frame-next"
              title={`下一帧（${shortcutHint("stepForward")}）`}
              aria-label="下一帧"
              onClick={() => onSeek(frame + 1)}
            >
              <FrameStepIcon dir="next" />
            </button>
            <Timecode onSeek={onSeek} />
            <span className="v-ctrlbar__spacer" />
            {/* 预览音量：只听，不影响导出（片段音量在右侧属性栏「声音」组里，会写进导出） */}
            <label
              className="v-ctrlbar__volume"
              title="预览音量（只影响听感，不影响导出）：100% = 0dB，200% = +12dB"
            >
              <span aria-hidden="true">🔊</span>
              <input
                type="range"
                data-v="preview-volume"
                min={0}
                max={2}
                step={0.05}
                value={volume}
                aria-label="预览音量"
                onChange={(event) => onVolume(Number(event.target.value))}
              />
              <span className="v-ctrlbar__volume-value" data-v="preview-volume-value">
                {formatDb(positionToDb(volume))}
              </span>
              <span className="v-ctrlbar__volume-pct" data-v="preview-volume-percent">
                {formatPercent(volume)}
              </span>
            </label>
          </div>
        </div>
      </div>
    </section>
  );
}

/** 错误条（最多 3 条、可逐条关闭；用 assertive 播报）。 */
function ErrorBar(): ReactElement | null {
  const errors = useErrors();
  if (errors.length === 0) return null;
  return (
    <div className="v-errorbar" data-v="errorbar" role="alert" aria-live="assertive">
      {errors.slice(0, 3).map((error) => (
        <div className="v-errorbar__item" key={`${error.code}-${error.at}`} data-v="error-item">
          <span>
            {error.message}
            {error.detail ? <span className="v-errorbar__detail">{error.detail}</span> : null}
          </span>
          <button
            type="button"
            className="v-errorbar__close"
            aria-label="关闭错误提示"
            onClick={() => store.dismissError(error.at)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

/** 四区骨架 + 播放状态机 + 快捷键 + 测试钩子。 */
export function App(): ReactElement {
  const [playing, setPlaying] = useState(false);
  /**
   * 自动恢复阶段。
   *
   * - `running`：正在并行探测 / 扫描目录（离线条显示"正在自动恢复…"）
   * - `done`：全部尝试结束（这时才允许显示离线条与手动入口）
   *
   * 为什么需要这个状态：刷新后素材会**先**被标成 offline（取不到文件），
   * 再被自动恢复链回来。没有这个闸门，用户会看到离线条闪一下又消失。
   */
  const [autoRestoreDone, setAutoRestoreDone] = useState(true);
  /**
   * 三栏的可拖拽宽度与折叠态（S1.2）。
   *
   * 宽度**不进 React state**：拖拽时每秒 60+ 次 `pointermove`，每次 setState 都会让
   * 整个 App（含时间线/预览）重渲染，拖动会发涩。宽度只改根节点的 CSS 变量，
   * 浏览器自己重排；React 只负责折叠态的图标。
   *
   * 默认 25% / 50% / 25%（对齐 opencut-classic 的 PANEL_CONFIG）。
   */
  const bodyRef = useRef<HTMLDivElement | null>(null);
  /** 时间线高度按"工作区高度的百分比"算，所以拖拽换算要用工作区的 rect。 */
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useState(() => ({
    left: readStoredCollapsed('left'),
    right: readStoredCollapsed('right'),
  }));

  // 启动时把记住的宽度/折叠态写到 CSS 变量（否则刷新后回到默认 25%）
  useEffect(() => {
    for (const side of ['left', 'right'] as const) {
      if (readStoredCollapsed(side)) {
        applyPanelWidth(side, 0, true);
      } else if (hasStoredPct(side)) {
        // **只在拖过时才写行内值**：否则会盖掉媒体查询（窄屏 20% / 16% 收窄失效）
        applyPanelWidth(side, readStoredPct(side), false);
      }
    }
    /**
     * 时间线高度：同样只在"用户拖过"时才写行内值。
     *
     * 没拖过就不写 —— 让 `:root` 里的 `--v-timeline-pct: 50` 生效。
     * 这样以后加"矮窗口自动收窄时间线"的媒体查询时，不会被挂载时写死的
     * 行内值盖成死代码（S1.2 的窄屏 bug 就是这么来的）。
     */
    if (hasStoredPct('timeline')) applyPanelWidth('timeline', readStoredPct('timeline'), false);
  }, []);

  function togglePanel(side: 'left' | 'right'): void {
    setCollapsed((previous) => {
      const next = !previous[side];
      // 展开时回到"上次拖到的宽度"（不是回到 25%）
      applyPanelWidth(side, readStoredPct(side), next);
      storeCollapsed(side, next);
      return { ...previous, [side]: next };
    });
  }
  /** 屏幕阅读器播报文本（R-064）：只在播放头/选中变化后 400ms 更新一次。 */
  const [a11yStatus, setA11yStatus] = useState('');
  const frame = useFrame();
  const selection = useSelection();
  const [commandOpen, setCommandOpen] = useState(false);
  /** 构建时间戳（顶栏显示）：用来区分"代码没生效"和"页面没刷新"。 */
  const [buildId, setBuildId] = useState('');
  const [toast, setToast] = useState<ToastPayload | null>(null);
  /** 预览总音量（只影响听感，不影响导出）。 */
  /** 预览音量滑块的**位置**（0..2 → 0dB 在 1）。换算见 `core/volume`。 */
  const [volume, setVolume] = useState(1);
  /**
   * 音量的镜像 ref。
   *
   * 为什么需要：音频调度器在 effect 里只创建一次（`[]`），而 React 在开发模式下
   * 会双挂载、工程参数变化也可能让它重建——**新实例的 master 默认是 1**，
   * 用户之前设的 5% 就丢了（表现："我明明调小了，一重绘又变响"）。
   * 创建完立刻用 ref 里的当前值补一次。
   */
  const volumeRef = useRef(1);
  const toastSeq = useRef(0);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<AudioScheduler | null>(null);
  const [transport] = useState<Transport>(() =>
    createTransport({
      fpsMilli: store.getDoc().fpsMilli,
      durationFrames: () => store.getDerived().durationFrames,
      onFrame: (frame) => {
        // 帧 → 播放头（高频通道，不触发 doc 订阅者重渲染）
        store.setPlayheadFrame(frame);
        // 帧 → 预览上屏（T13）；exact 模式会 await，scrub 模式 fire-and-forget
        void renderPreviewFrame(store.getDoc(), frame);
        // 播放中维持音频预读窗口（分块排期，慢解码只造成空洞、不造成漂移）
        audioRef.current?.pump();
      },
      onPlayingChange: (next) => setPlaying(next),
    }),
  );
  const transportRef = useRef<Transport>(transport);

  useEffect(() => {
    transportRef.current = transport;
    const uninstall = installKeymap({
      transport,
      // 弹窗状态在 TopBar 里，快捷键只负责广播意图（避免 keymap 依赖 UI 组件）
      onExport: () => window.dispatchEvent(new CustomEvent('veditor:export')),
      onAI: () => window.dispatchEvent(new CustomEvent('veditor:ai')),
    });
    return () => {
      uninstall();
      transport.dispose();
    };
  }, [transport]);

  // 高对比主题（R-064）：启动时恢复上次选择
  useEffect(() => {
    void restoreTheme();
  }, []);

  /**
   * 无障碍播报（R-064）：播放头 + 选中片段。
   *
   * **必须节流**：播放时 playhead 每帧都在变，逐帧写 aria-live 会让读屏连续朗读、
   * 完全听不清。400ms 的静默窗口足够"停下来听一句"。
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      const doc = store.getDoc();
      let label = '未选中片段';
      if (selection !== null) {
        for (const track of doc.tracks) {
          const clip = track.clips.find((item) => item.id === selection);
          if (clip === undefined) continue;
          label = clip.text !== null && clip.text !== undefined
            ? '文字片段'
            : doc.assets.find((asset) => asset.id === clip.assetId)?.name ?? '片段';
          break;
        }
      }
      setA11yStatus(`播放头 ${formatTimecode(frame, doc.fpsMilli)}，${label}`);
    }, 400);
    return () => clearTimeout(timer);
  }, [frame, selection]);

  // Ctrl+K / 顶栏 ✦ 都只广播意图，由 App 决定开合
  useEffect(() => {
    const open = (): void => setCommandOpen(true);
    window.addEventListener('veditor:ai', open);
    return () => window.removeEventListener('veditor:ai', open);
  }, []);

  // 预览引擎 + 音频调度：canvas 挂载后创建。
  // 预览引擎的尺寸必须跟工程参数走（1080×1920 的工程不能拿 1280×720 的合成器出图），
  // 因此每次 doc 变化都调一次 ensurePreviewEngine（key 不变时是空操作），并重绘当前帧。
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (canvas === null) return;
    const doc = store.getDoc();
    ensurePreviewEngine({ canvas, width: doc.width, height: doc.height, fpsMilli: doc.fpsMilli });
    // 首帧渲染：早期版本只在 transport.onFrame 里画，导入后停在黑屏，动一下播放头才出画
    void renderPreviewFrame(doc, store.getPlayheadFrame());

    const audio = createAudioScheduler({
      fpsMilli: doc.fpsMilli,
      getDoc: () => store.getDoc(),
      // 每次排期时现取池：工程参数变化会重建引擎换新池，持有旧引用会让音频永久失联
      getPool: () => peekDecoderPool(),
      getProbe: (assetId) => {
        const probe = getPreviewProbe(assetId);
        // mp4 与 webm 都要放行：只认 mp4 会让 webm 片段「画面正常但播放无声」——
        // 音频调度器拿不到 probe 就直接跳过该片段，且不会报任何错。
        if (probe === undefined) return undefined;
if (
          probe.container !== 'mp4' &&
          probe.container !== 'webm' &&
          probe.container !== 'wav' &&
          probe.container !== 'mp3'
        ) {
          return undefined;
        }
        return probe as never;
      },
    });
    // 新实例的 master 默认 1：把用户当前设定的音量补回去（见 volumeRef 注释）
    audio.setMasterVolume(volumeRef.current);
    audioRef.current = audio;
    transport.setAudioClock(audio);
    return () => {
      audioRef.current = null;
      transport.setAudioClock(null);
      audio.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 轨道"可见/可听"状态的指纹。
   *
   * 用它判断"这次通知是不是轨道状态变了"——只有变了才需要**强制**重绘 + 重算闸门。
   * 为什么要指纹而不是每次都做：播放时 `notify()` 每帧都发，
   * 每帧都强制重绘等于把合并优化废掉（预览会重复渲染两次）。
   */
  const trackStateSignatureRef = useRef('');

  /**
   * 轨道状态（隐藏 / 静音 / 独奏）变更 → **画面与音频同时立刻生效**。
   *
   * ## 为什么要专门处理
   *
   * 用户报"点了眼睛/喇叭/独奏，画面和声音不立刻变，要暂停再播一次才生效"。
   * 两个原因：
   * 1. **画面**：`renderPreviewFrame` 有重试预算，预算耗尽后直接返回，**一帧都不画**；
   *    而且暂停时没有任何播放循环会再来画 —— 于是 canvas 停在上一次的内容上。
   * 2. **音频**：播放中的 PCM 是提前 1–3 秒排期的，改文档对已排期的块毫无影响。
   *
   * 所以这里做两件事：`repaintPreview()`（无视预算强制画一帧）+ `applyTrackGates()`
   * （改轨道闸门的 AudioParam，下一个音频量子就生效）。
   *
   * ## 为什么放在 store 订阅里
   *
   * 按钮、右键菜单、Agent/API 全都走 `store.setTrackFlag` / `dispatch`，
   * 最终都是同一次 `notify()`。**收敛在订阅点**才能保证"所有入口生效时机一致"，
   * 而不是在每个按钮的 onClick 里各写一遍（迟早漏一个）。
   */
  const syncTrackState = (): void => {
    const doc = store.getDoc();
    const signature = doc.tracks
      .map((track) => `${track.id}:${track.muted ? 1 : 0}${track.hidden ? 1 : 0}${track.solo === true ? 1 : 0}`)
      .join('|');
    if (signature === trackStateSignatureRef.current) return;
    trackStateSignatureRef.current = signature;
    // 音频：立刻掐/放（不打断在途的块，见 audioEngine 的 trackGates 注释）
    audioRef.current?.applyTrackGates();
    // 画面：强制重绘（暂停状态下也画）
    repaintPreview();
    testState.trackStateSyncs = (testState.trackStateSyncs ?? 0) + 1;
  };

  // doc 变化（导入/剪辑/改参数）→ 预览引擎对齐参数 + 重绘当前帧
  useEffect(
    () =>
      store.subscribe(() => {
        testState.docRepaints = (testState.docRepaints ?? 0) + 1;
        // 轨道状态优先处理：它需要"强制"重绘，不能被后面的普通重绘覆盖掉
        syncTrackState();
        const canvas = previewCanvasRef.current;
        if (canvas === null) {
          testState.docPaintSkipped = 'no-canvas';
          return;
        }
        const doc = store.getDoc();
        testState.docPaintClips = doc.tracks.reduce((sum, track) => sum + track.clips.length, 0);
        ensurePreviewEngine({ canvas, width: doc.width, height: doc.height, fpsMilli: doc.fpsMilli });
        void renderPreviewFrame(doc, store.getPlayheadFrame());
      }),
    [],
  );

  // fps 变化（改工程参数）时同步给 Transport，避免播放时钟按旧帧率推进
  useEffect(
    () =>
      store.subscribe(() => {
        const nextFps = store.getDoc().fpsMilli;
        transport.setFpsMilli(nextFps);
      }),
    [transport],
  );

  // 会话恢复 + 自动保存：先恢复（避免把空工程覆盖掉旧工程），再接 autosave（500ms 防抖）
  useEffect(() => {
    let cancelled = false;
    let detachAutosave: (() => void) | null = null;
    void (async () => {
      /**
       * **带 `?src=` 打开时不恢复上次会话**。
       *
       * 两条路会抢同一个 doc：`?src=` 的自动导入（host 侧，异步 fetch）与
       * `restoreSession()` → `replaceDoc()`（这里）。谁后到谁赢：
       * 恢复后到 → 刚导入的素材被整份替换掉，只剩"素材存在但没字节"的旧工程，
       * 于是预览报 `E_ASSET_OFFLINE: 素材未注册到解码器池`（用户实测踩到）。
       * `?src=` 是明确指令（"打开这个文件"），优先级高于"接着上次"。
       */
      const explicitSource = new URLSearchParams(window.location.search).get('src') !== null;
      const session = explicitSource ? { ok: true as const, value: null } : await restoreSession();
      if (cancelled) return;
      if (!session.ok) {
        store.pushError(session.error);
      } else if (session.value) {
        store.replaceDoc(session.value.project);
        /**
         * ---- 自动恢复编排（三层）----
         *
         * 1. **第一层**：权限已授予的素材 → 并行重新探测，重建解码缓存；
         * 2. **第二层**：还有离线的 → 静默扫描用户授权过的目录，自动链回去；
         * 3. **第三层**：仍然失败的 → 才显示顶部离线条（`autoRestoreDone = true`）。
         *
         * 全程**不阻塞 UI**：`replaceDoc` 之后页面已经可以操作（时间轴骨架可见），
         * 恢复在后台推进，每成功一个就自己重绘一帧。
         */
        setAutoRestoreDone(false);
        void (async () => {
          const snapshot = session.value;
          if (snapshot === null) {
            setAutoRestoreDone(true);
            return;
          }

          // ---- 第 0 层：本地草稿缓存（唯一不受外部条件影响的路径，最先试）----
          const cachedRestored = await restoreFromCache(store.getDoc().assets).catch((): string[] => []);
          if (cancelled) return;

          // ---- 第一层：并行探测（限并发 4，避免同时解 10 个 4K 的 moov）----
          // 已经由缓存恢复的素材跳过：缓存比句柄更可靠，不该被后到的句柄覆盖
          const probeQueue = snapshot.restorableFiles.filter(
            (item) => !cachedRestored.includes(item.assetId),
          );
          const probeOne = async (item: { assetId: string; file: File }): Promise<void> => {
            const probed = await probeMediaFile(item.file, null, item.assetId).catch(() => null);
            if (cancelled) return;
            if (probed === null || !probed.ok) {
              /**
               * 探测失败（文件损坏 / 权限刚被撤）：标成离线，交给第二层去扫。
               * 这里**必须显式标**，否则 asset 会停在 `ok` 但引擎里没有源 —— 黑屏且无提示。
               */
              store.updateAsset(item.assetId, { status: 'offline' });
            }
          };
          const worker = async (): Promise<void> => {
            for (;;) {
              const item = probeQueue.shift();
              if (item === undefined) return;
              await probeOne(item);
            }
          };
          await Promise.all([worker(), worker(), worker(), worker()]);
          if (cancelled) return;

          // ---- 第二层 a：宿主（Electron）按绝对路径直读（最可靠，优先）----
          let offline = store.getDoc().assets.filter((asset) => asset.status === 'offline');
          if (offline.length > 0) {
            await restoreFromHostPaths(offline).catch(() => null);
            if (cancelled) return;
          }

          // ---- 第二层 b：静默扫描授权目录（浏览器里的兜底自动路径）----
          offline = store.getDoc().assets.filter((asset) => asset.status === 'offline');
          if (offline.length > 0) {
            await autoRestoreFromDirectories({ offline }).catch(() => null);
            if (cancelled) return;
          }

          // ---- 第三层：交给离线条 ----
          setAutoRestoreDone(true);
        })();
      }
      detachAutosave = attachAutosave(store);
    })();
    return () => {
      cancelled = true;
      detachAutosave?.();
    };
  }, []);

  /**
   * 工程**历史备份**（与 500ms 自动保存并行：自动保存管"现在"，备份管"历史"）。
   * 每 60s 醒一次查"是否到了 5 分钟且内容有变化"（`isBackupDue` 是唯一判据）；
   * `pagehide` 时尽力写一份「退出前备份」（浏览器不保证卸载路径落盘，所以只是兜底不是契约）。
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      void (async () => {
        const doc = store.getDoc();
        const latest = await latestBackup(doc.id, veditorDb);
        if (latest.ok && isBackupDue(latest.value, doc, Date.now())) {
          void writeBackup(doc, 'auto', veditorDb);
        }
      })();
    }, 60_000);
    const onHide = (): void => {
      void writeExitBackup(store.getDoc(), veditorDb);
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('pagehide', onHide);
    };
  }, []);

  // 构建时间戳：dev server / 打包产物都会写 build-id.txt，页面启动时读一次显示在顶栏
  useEffect(() => {
    let cancelled = false;
    void fetch('/build-id.txt')
      .then((response) => (response.ok ? response.text() : ''))
      .then((text) => {
        if (!cancelled) setBuildId(text.trim());
      })
      .catch(() => {
        // 读不到就不显示（例如从 file:// 打开），不影响任何功能
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 每次 React commit +1（T16 用来证明"拖拽期间不重渲染"）
  useEffect(() => {
    testState.commitCount += 1;
  });

  // 测试钩子：仅非生产构建注入，只读
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    window.__VEDITOR_TEST__ = {
      get commitCount(): number {
        return testState.commitCount;
      },
      docVersion: () => store.getState().version,
      playheadFrame: () => store.getPlayheadFrame(),
      lastFrameResult: () => testState.lastFrameResult,
      openSessions: () => 0,
      openFrames: () => 0,
      clips: () => {
        const doc = store.getDoc();
        return doc.tracks.flatMap((track) =>
          track.clips.map((clip) => ({
            id: clip.id,
            trackId: clip.trackId,
            assetId: clip.assetId,
            startFrame: clip.startFrame,
            inFrame: clip.inFrame,
            outFrame: clip.outFrame,
            durationFrames: clip.durationFrames,
            // 多机位（R-057）验收要逐帧扫"可见机位"，靠的就是这个开关
            enabled: clip.enabled,
            role: clip.role ?? null,
            freeze: clip.freeze === true,
            reversed: clip.reversed === true,
            speedMilli: clip.speedMilli ?? 1000,
            transform: {
              scale: clip.transform.scale,
              x: clip.transform.x,
              y: clip.transform.y,
              opacity: clip.transform.opacity,
              blendMode: clip.transform.blendMode,
              // 旋转/翻转（E2E 要断言"转了没、翻回来没"）
              rotation: clip.transform.rotation,
              flipX: clip.transform.flipX,
              flipY: clip.transform.flipY,
            },
            text:
              clip.text === null || clip.text === undefined
                ? null
                : {
                    content: clip.text.content,
                    fontSize: clip.text.fontSize,
                    color: clip.text.color,
                    align: clip.text.align,
                    // 文本模板（左栏「文本」）验收要断言位置/底衬/粗体/描边，
                    // **钩子字段裁剪过一次就再也读不到**（assets() 加 cacheKey 时踩过）
                    x: clip.text.x,
                    y: clip.text.y,
                    background: clip.text.background,
                    bold: clip.text.bold === true,
                    stroke: clip.text.stroke ?? null,
                    // `origin` 必须导出：否则 E2E 无法验证"批量套模板后 AI 角标没被冲成 manual"
                    origin: clip.text.origin ?? null,
                  },
            effects: clip.effects.map((effect) => effect.type),
            effectDetails: clip.effects.map((effect) => ({
              type: effect.type,
              params: { ...effect.params },
              enabled: effect.enabled,
            })),
            audio: {
              gain: clip.audio.gain,
              fadeInFrames: clip.audio.fadeInFrames,
              fadeOutFrames: clip.audio.fadeOutFrames,
            },
            transitionDetails: {
              in: clip.transitionIn === null ? null : { type: clip.transitionIn.type, durationFrames: clip.transitionIn.durationFrames },
              out: clip.transitionOut === null ? null : { type: clip.transitionOut.type, durationFrames: clip.transitionOut.durationFrames },
            },
            transitions: {
              in: clip.transitionIn === null ? null : clip.transitionIn.type,
              out: clip.transitionOut === null ? null : clip.transitionOut.type,
            },
          })),
        );
      },
      assets: () =>
        store.getDoc().assets.map((asset) => ({
          hashKey: asset.hashKey,
          ...(asset.contentHash === undefined || asset.contentHash === null
            ? {}
            : { contentHash: asset.contentHash }),
          ...(asset.cacheKey === undefined || asset.cacheKey === null ? {} : { cacheKey: asset.cacheKey }),
          status: asset.status,
          id: asset.id,
          name: asset.name,
          kind: asset.kind,
          width: asset.width,
          height: asset.height,
          rotation: asset.rotation ?? 0,
          durationFrames: asset.durationFrames,
          durationSec: asset.durationSec,
          fpsMilli: asset.fpsMilli,
          hasAudio: asset.hasAudio,
          sampleRate: asset.sampleRate,
          channels: asset.channels,
        })),
      projectMeta: () => {
        const doc = store.getDoc();
        return { name: doc.name, width: doc.width, height: doc.height, fpsMilli: doc.fpsMilli };
      },
      tracks: () =>
        store.getDoc().tracks.map((track) => ({
          id: track.id,
          kind: track.kind,
          order: track.order,
          clips: track.clips.length,
          name: track.name,
          muted: track.muted,
          hidden: track.hidden,
          locked: track.locked,
          // 高度是 S3 的验收对象（拖动轨道头下边缘）
          height: track.height ?? null,
        })),
      errors: () =>
        store.getEphemeral().errors.map((error) => ({ code: error.code, message: error.message })),
      dismissAllErrors: () => store.clearErrors(),
      installTranscriber: (transcribe: AIProvider['transcribe']) => {
        setAIProvider({ ...getAIProvider(), transcribe });
      },
      previewSnapshot: (region?: PreviewRegion) => capturePreviewStats(region),
      derived: () => store.getDerived(),
      zoomLevel: () => store.getDoc().zoomLevel,
      // 拖拽落点预览（E2E 断言"看到的就是落到的"）
      dropGhost: () => store.getEphemeral().dropGhost,
      transitionGhost: () => store.getEphemeral().transitionGhost,
      effectGhost: () => store.getEphemeral().effectGhost,
      /** 轨道排序拖拽预览（null = 没在拖）。 */
      trackDrag: () => store.getEphemeral().trackDrag,
      /**
       * 时间线几何（E2E 用）。
       *
       * 为什么要有：以前测试把 `56` 写死在坐标换算里，于是"轨道头 56→130px"
       * 这种纯视觉改动会让 6 个测试一起红。现在测试一律从这里取几何。
       */
      uiLayout: () => {
        const box = (selector: string) => {
          const element = document.querySelector(selector);
          if (element === null) return null;
          const rect = element.getBoundingClientRect();
          return {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          };
        };
        const style = getComputedStyle(document.documentElement);
        const readVar = (name: string): string => style.getPropertyValue(name).trim();
        return {
          window: { w: window.innerWidth, h: window.innerHeight },
          workspace: box('[data-v="workspace"]'),
          topbar: box('[data-v="topbar"]'),
          left: box('[data-v="asset-panel"]'),
          leftRail: box('[data-v="left-tabbar"]'),
          leftContent: box('[data-v="left-content"]'),
          right: box('[data-v="inspector-panel"]'),
          stage: box('[data-v="stage"]'),
          ctrlbar: box('[data-v="ctrlbar"]'),
          timeline: box('[data-v="timeline"]'),
          timelineViewport: box('[data-v="timeline-scroll"]'),
          timelineCanvas: box('[data-v="timeline-canvas"]'),
          previewCanvas: box('[data-v="preview-canvas"]'),
          vars: {
            topbarH: readVar('--v-topbar-h'),
            leftW: readVar('--v-left-w'),
            rightW: readVar('--v-right-w'),
            splitterW: readVar('--v-splitter-w'),
            ctrlbarH: readVar('--v-ctrlbar-h'),
            timelineH: readVar('--v-timeline-h'),
            /** 时间线高度百分比（无单位，S1.4：默认 50，可拖 15–70）。 */
            timelinePct: readVar('--v-timeline-pct'),
          },
        };
      },
      timelineLayout: () => {
        const layout = trackLayout(store.getDoc());
        return { headerWidth: layout.headerWidth, rulerHeight: layout.rulerHeight, rows: layout.rows, totalHeight: layout.totalHeight };
      },
      /** 左栏激活的 Tab（S1.3：9 个 Tab 的切换与记忆）。 */
      leftTab: () => getActiveLeftTab(),
      // 选中片段（测试用：默认 zoom 下多片段工程后半段不可见，坐标点击不可靠）
      selectClip: (clipId: string) => store.setSelectedClipId(clipId),
      /** 改轨道标志（隐藏/静音/锁定/独奏）—— 与按钮、右键菜单走**同一个** store 方法。 */
      setTrackFlag: (trackId: string, flag: 'muted' | 'hidden' | 'locked' | 'solo', value: boolean) =>
        store.setTrackFlag(trackId, flag, value),
      /** 提交一批操作（Agent/API 路径的替身：绕过 UI 直接改文档）。 */
      dispatch: (ops: Parameters<typeof store.dispatch>[0], label?: string) => store.dispatch(ops, label ?? ''),
      /** 各轨音频闸门值（验证"静音/独奏真的到了音频链路"）。 */
      audioTrackGains: () => audioRef.current?.trackGains() ?? {},
      play: () => transport.play(),
      pause: () => transport.pause(),
      setAutoRestoreDone: (done) => setAutoRestoreDone(done),
      cacheInfo: async () => {
        const stats = await cacheStats();
        return {
          available: isCacheAvailable(),
          kind: currentBackend()?.kind ?? null,
          count: stats.count,
          bytes: stats.bytes,
          pending: pendingCacheJobs(),
        };
      },
      restoreFromCacheNow: () => restoreFromCache(store.getDoc().assets),
      setAssetStatus: (assetId, status) => {
        store.updateAsset(assetId, { status });
        /**
         * 模拟"真离线"：光改状态不够 —— 引擎里还有源，画面照样出得来。
         * 真实的离线是"刷新后 `previewSource` 的源表是空的"，所以这里也清掉。
         */
        if (status === 'offline') {
          unregisterPreviewSource(assetId);
          repaintPreview();
        }
      },
      relinkAssetFromUrl: async (assetId, url) => {
        const response = await fetch(url);
        const blob = await response.blob();
        const asset = store.getDoc().assets.find((item) => item.id === assetId);
        const file = new File([blob], asset?.name ?? url.split('/').pop() ?? 'asset.mp4', {
          type: blob.type || 'video/mp4',
        });
        const result = await relinkAssetFromFile({ assetId, file, handle: null });
        return result.ok ? 'ok' : result.error.message;
      },
      selection: () => store.getEphemeral().selectedClipId ?? null,
      selectionAll: () => store.getSelection(),
      seek: (frame: number) => {
        transportRef.current.seekTo(frame, 'exact');
      },
      audioProbe: () => audioRef.current?.pcmProbe() ?? null,
      domProbe: () => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-v="timeline-canvas"]');
        if (canvas === null) return { why: 'no-canvas' };
        const rect = canvas.getBoundingClientRect();
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height / 2);
        const top = document.elementFromPoint(x, y);
        // 画布内部坐标 → 帧号：用来判断"点击处是不是已经超出内容末尾"
        const scrollX = Number(canvas.dataset['scrollX'] ?? '0');
        const zoom = store.getDoc().zoomLevel;
        const scale = rect.width > 0 ? canvas.width / rect.width : 1;
        const laneX = (x - rect.left) * scale - 56 + scrollX;
        return {
          point: { x, y },
          scrollX,
          frameAtCenter: Math.round(laneX / Math.max(1, zoom)),
          topElement: top === null ? null : `${top.tagName}${top.getAttribute('data-v') === null ? '' : `[data-v=${top.getAttribute('data-v')}]`}`,
          canvasOnTop: top === canvas,
          playhead: store.getPlayheadFrame(),
          docVersion: store.getState().version,
          bodyPointerEvents: getComputedStyle(document.body).pointerEvents,
        };
      },
      docRepaintInfo: () => ({
        repaints: testState.docRepaints ?? 0,
        clips: testState.docPaintClips ?? -1,
        skipped: testState.docPaintSkipped ?? '',
      }),
      previewStats: () => {
        const engine = peekPreviewEngine();
        if (engine === null) return null;
        // 合并 compositor 统计：lastLayerCount / lastGlError 是"画面黑但层数正常"的关键区分
        return { ...engine.stats(), compositor: engine.compositor.stats() };
      },
      audioStats: () => audioRef.current?.stats() ?? null,
      audioDiag: async () => {
        const doc = store.getDoc();
        const clip = doc.tracks.flatMap((track) => track.clips)[0];
        if (clip === undefined) return null;
        const probe = getPreviewProbe(clip.assetId);
        const pool = peekDecoderPool();
        // getPreviewProbe 返回宽类型 MediaProbeResult（不含 audio）；真正的 audio 样本表
        // 由具体容器结果（Mp4/WebmProbeResult）提供，这里按结构取。
        const audioLike = probe === undefined
          ? null
          : ((probe as unknown as { audio?: { samples: ReadonlyArray<unknown>; sampleRate: number } }).audio ?? null);
        const audioSamples = audioLike?.samples.length ?? 0;
        let decode = 'skip（池/探针/样本表缺失）';
        if (pool !== null && audioSamples > 0) {
          const range = await pool.decodeAudioRange(clip.assetId, 0, Math.min(4, audioSamples));
          decode = range.ok
            ? `ok ${range.value.length} chunks`
            : `${range.error.code}: ${range.error.message} | ${range.error.detail ?? ''}`;
        }
        return {
          hasPool: pool !== null,
          hasProbe: probe !== undefined,
          audioSamples,
          sampleRate: audioLike?.sampleRate ?? 0,
          decode,
        };
      },
      decodeTest: async (assetId: string, frame: number) => {
        const pool = peekDecoderPool();
        if (pool === null) return null;
        const result = await pool.ensureFrame(assetId, frame);
        return result.ok
          ? {
              ok: true,
              detail: `assetFrame=${result.value.assetFrame} exact=${String(result.value.exact)} display=${result.value.frame.displayWidth}x${result.value.frame.displayHeight}`,
            }
          : { ok: false, detail: `${result.error.code}: ${result.error.message} | ${result.error.detail ?? ''}` };
      },
      overlayMarks: () => store.getEphemeral().overlayMarks.map((mark) => mark.frame),
      canUndo: () => store.canUndo(),
      lastUndoLabel: () => store.peekUndoLabel(),
      /** 撤销一步（S3 的"拖动只占一个撤销步"要靠它验证）。 */
      undo: () => store.undo(),
      marks: () => ({ in: store.getEphemeral().markIn, out: store.getEphemeral().markOut }),
      lastRenderError: () => getLastRenderError(),
      compositorStats: () => {
        const engine = peekPreviewEngine();
        if (engine === null) return null;
        const stats = engine.compositor.stats();
        return {
          lastLayerCount: stats.lastLayerCount,
          skippedLayers: stats.skippedLayers,
          lastGlError: stats.lastGlError,
        };
      },
      proxyState: (assetId) => {
        const state = getProxyState(assetId);
        return { status: state.status, ratio: state.ratio, width: state.width, height: state.height };
      },
      proxySources: (assetId) => ({
        previewWidth: getPreviewProbe(assetId)?.width ?? null,
        exportWidth: getExportProbe(assetId)?.width ?? null,
      }),
      setPreferProxy: (on) => setPreferProxy(on),
      renderCost: async (frames) => {
        const doc = store.getDoc();
        const total = Math.max(1, store.getDerived().durationFrames);
        const started = performance.now();
        for (let i = 0; i < frames; i += 1) {
          await renderPreviewFrame(doc, i % total);
        }
        return (performance.now() - started) / Math.max(1, frames);
      },
    };
    return () => {
      delete window.__VEDITOR_TEST__;
    };
  }, []);

  return (
    <div className="v-app" data-v="app">
      <MemoryModeBanner />
      <OfflineBanner autoRestoreDone={autoRestoreDone} />
      <TopBar buildId={buildId} />
      <div className="v-workspace" ref={workspaceRef} data-v="workspace">
        <ErrorBar />
        <div
          className="v-body"
          ref={bodyRef}
          data-left-collapsed={collapsed.left}
          data-right-collapsed={collapsed.right}
        >
          <LeftPanel buildId={buildId} onSeek={(frame) => transport.seekTo(frame, 'exact')} />
          <Splitter
            side="left"
            collapsed={collapsed.left}
            onToggleCollapse={() => togglePanel('left')}
            onResizeEnd={(pct) => storePct('left', pct)}
            containerRef={bodyRef}
          />
          <PreviewStage
            playing={playing}
            onToggle={() => transport.toggle()}
            onSeek={(target) => transport.seekTo(target, 'exact')}
            frame={frame}
            volume={volume}
            onVolume={(position) => {
              setVolume(position);
              // 位置 → 振幅：0dB 在 100%，+12dB 在 200%（与片段音量同一套曲线）
              const gain = positionToGain(position);
              volumeRef.current = gain;
              audioRef.current?.setMasterVolume(gain);
            }}
            canvasRef={previewCanvasRef}
          />
          <Splitter
            side="right"
            collapsed={collapsed.right}
            onToggleCollapse={() => togglePanel('right')}
            onResizeEnd={(pct) => storePct('right', pct)}
            containerRef={bodyRef}
          />
          <InspectorPanel />
        </div>
        {/*
          时间线分隔条：与左右栏**同一个组件**，只是轴换成 y、范围 15%–70%。
          它占 `.v-workspace` 的第 2 行（4px），正好压在"预览区/时间线"的边界上。
          不给折叠入口：时间线高度归零后没有任何替代入口能把它拉回来。
        */}
        <Splitter
          side="timeline"
          collapsed={false}
          onResizeEnd={(pct) => storePct('timeline', pct)}
          containerRef={workspaceRef}
        />
        <TimelineView transport={transport} />
      </div>
      <div className="v-sr-only" role="status" aria-live="polite" aria-atomic="true" data-v="a11y-status">
        {a11yStatus}
      </div>
      {/*
        **条件挂载**，不是常驻 + `open` 开关：
        常驻时"打开即重置"只能写在 effect 里，而 effect 在首帧之后才跑——
        用户（或测试）按完 Ctrl+K 立刻打字，重置会把刚输入的字符**清空**，
        表现就是"输入框里字自己没了 / 运行按钮一直是灰的"（实测：负载下 m4-ai、roughcut 两个 E2E 超时）。
        每次打开重新挂载，初始 state 天然干净，没有时序问题。
      */}
      {commandOpen ? (
        <CommandBar
          open
          onClose={() => setCommandOpen(false)}
          onApplied={(label) => {
            toastSeq.current += 1;
            setToast({ id: toastSeq.current, label });
          }}
        />
      ) : null}
      <Toast
        toast={toast}
        onUndo={() => {
          store.undo();
          setToast(null);
        }}
        onDismiss={() => setToast(null)}
      />
      <div className="v-sr-only" role="status" aria-live="polite" data-v="status-live">
        {playing ? '播放中' : '已暂停'}
      </div>
    </div>
  );
}

/** 供 T09 接入后回填（当前恒 null，测试钩子读它）。 */
export function setLastFrameResult(value: unknown): void {
  testState.lastFrameResult = value;
}

/** 供测试读取当前 commit 计数（不经 window）。 */
export function getCommitCount(): number {
  return testState.commitCount;
}

/** 供其他面板复用：当前素材数（避免直接读 doc）。 */
export function assetCountOf(doc: Project): number {
  return doc.assets.length;
}

/** 供其他面板复用：当前项目帧率。 */
export function fpsMilliOf(doc: Project): number {
  return doc.fpsMilli;
}

/** 未使用的选择器保留以稳定 useDoc 引用（T12 会用）。 */
export const selectors = { selectFps, selectAssets };
