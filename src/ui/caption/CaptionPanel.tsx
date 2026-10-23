/**
 * 左栏「字幕」面板（C2 列表 + C3 工具条）。
 *
 * ## 与「文本」面板的分工
 *
 * | 面板 | 做什么 |
 * |---|---|
 * | 文本（已有） | 加**独立文字**：标题、花字、模板库 |
 * | **字幕（本面板）** | 管**整条字幕轨**：列表、逐条对文本、批量、导入导出、转写 |
 *
 * 数据完全同源（`clip.text` + `text` 轨）——在文本面板加的字会出现在这里，
 * 只是角标显示「文字」。**不造第二份数据。**
 *
 * ## 三个入口（C3）
 *
 * 顶部工具条：**AI 生成字幕 / 导入字幕 / 导出字幕**。
 * 实现在 `./actions.ts`，**顶栏也调同一份**——面板里的「导入」和顶栏菜单里的「导入」
 * 行为完全一致，不会出现"两处结果不同"。
 *
 * ## 为什么文件输入提到最外层
 *
 * C2 时 `<input type="file">` 只在空状态里渲染，于是"列表里想再导入一份"就没有入口。
 * 现在提到外层只渲染一次，空状态和工具条都只是**触发**它。
 *
 * ## 反馈放在面板内（不改 store）
 *
 * `Toast` 是 AI 操作专用的（由命令栏控制），store 也没有通用 toast 通道。
 * 为一个"已导入 3 条"去动 store 不值得，所以用面板内一行 notice，3.5 秒自动消失。
 * 失败仍然走 `store.pushError`（错误条是全局的，用户在哪都能看到）。
 *
 * ## 跳播放头为什么从外面传 `onSeek`
 *
 * 播放头真正的推进在 `transport`（App 里），`store.setPlayheadFrame` 只改 doc 字段、
 * 不驱动渲染。所以和 `TimelineView` 一样：由 App 注入 `onSeek(frame)`。
 *
 * ## 两种视图（C4）
 *
 * 同一条字幕轨，两种读法：
 *
 * | 视图 | 回答什么问题 |
 * |---|---|
 * | 列表（默认） | 每条字幕写了什么、怎么改字 |
 * | 时间轴 | 字幕怎么分布在时间上、这条要拖长还是拖短 |
 *
 * 两个视图**共用同一份 selection**（`store` 里那一个），所以"在时间轴点一条、
 * 切回列表它也是选中态"——不需要同步两份状态。
 *
 * 切换按钮放在**状态栏右侧**而不是新起一行：左栏高度只够 8 条列表
 * （E2E ⑤b 卡着这个数），多一行 22px 就会掉到 7 条。
 */
import { useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { store, useDoc, useSelection } from '../../core/store';
import { listCaptions } from '../../core/captions';
import type { CaptionRow } from '../../core/captions';
import type { Frame } from '../../core/types';
import { CaptionList } from './CaptionList';
import { CaptionTimeline } from './CaptionTimeline';
import { exportSrt, generateCaptions, hasTranscribeChannel, importSrtFile } from './actions';

/**
 * 视图切换的持久化 key。
 *
 * 存在 `localStorage` 而不是 doc 里：这是**用户的工作习惯**，
 * 不属于工程内容（不该跟着 .veditor 文件到处跑，也不该占一个撤销步）。
 */
const VIEW_STORAGE_KEY = 'veditor:caption:view';

/** 两种视图：列表（逐条对文本）/ 迷你时间轴（按真实时长拖时长）。 */
export type CaptionView = 'list' | 'timeline';

/** 读上次选的视图；读不到 / 存储不可用都退回「列表」。 */
function readStoredView(): CaptionView {
  try {
    return window.localStorage.getItem(VIEW_STORAGE_KEY) === 'timeline' ? 'timeline' : 'list';
  } catch {
    // 隐私模式 / 禁用存储：退回默认视图，功能不受影响
    return 'list';
  }
}

/** 记住用户的选择（存不下就算了，只是下次进来回到默认）。 */
function persistView(view: CaptionView): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // 忽略：存储配额 / 隐私模式
  }
}

/** 行数组的相等判断：`useDoc` 用 `Object.is`，返回新数组会无限重渲染。 */
function rowsEqual(left: CaptionRow[], right: CaptionRow[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (
      a.clipId !== b.clipId ||
      a.text !== b.text ||
      a.startFrame !== b.startFrame ||
      a.durationFrames !== b.durationFrames ||
      a.origin !== b.origin
    ) {
      return false;
    }
  }
  return true;
}

export interface CaptionPanelProps {
  /** 跳播放头（由 App 注入 transport.seekTo）。 */
  onSeek: (frame: Frame) => void;
}

export function CaptionPanel(props: CaptionPanelProps): ReactElement {
  const { onSeek } = props;
  const rows = useDoc((doc) => listCaptions(doc), rowsEqual);
  const selectedId = useSelection();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** 当前视图（默认「列表」，跨会话记住上次的选择）。 */
  const [view, setView] = useState<CaptionView>(readStoredView);

  const selectedIds = selectedId === null ? [] : [selectedId];
  const transcribeReady = hasTranscribeChannel();

  /** 切视图：先改本地（立即生效），再落盘（失败不影响本次切换）。 */
  function changeView(next: CaptionView): void {
    if (next === view) return;
    setView(next);
    persistView(next);
  }

  /** 显示一行反馈，3.5 秒后自动消失（新的会顶掉旧的）。 */
  function flash(text: string): void {
    setNotice(text);
    window.setTimeout(() => {
      setNotice((current) => (current === text ? null : current));
    }, 3500);
  }

  function pick(row: CaptionRow): void {
    store.setSelectedClipId(row.clipId);
    onSeek(row.startFrame);
  }

  async function onFile(file: File): Promise<void> {
    setBusy(true);
    try {
      const count = await importSrtFile(file);
      if (count !== null) flash(`已导入 ${count} 条字幕`);
    } finally {
      setBusy(false);
    }
  }

  async function onGenerate(): Promise<void> {
    setBusy(true);
    try {
      const result = await generateCaptions('auto');
      if (result !== null) {
        const droppedNote = result.dropped > 0 ? `，丢弃 ${result.dropped} 条无效片段` : '';
        flash(`已生成 ${result.count} 条字幕${droppedNote}`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function onExport(): Promise<void> {
    setBusy(true);
    try {
      const result = await exportSrt();
      if (result === null) return; // 已在 actions 里 pushError
      if (result.cancelled) {
        flash('已取消导出');
        return;
      }
      flash(`已导出 ${result.count} 条到 ${result.fileName ?? '下载目录'}`);
    } finally {
      setBusy(false);
    }
  }

  /** 空状态与工具条共用同一套 data-v —— 两者互斥，不会同时出现在 DOM 里。 */
  const entryButtons = (
    <>
      <button
        type="button"
        className="v-caption-btn v-caption-btn--primary"
        data-v="caption-generate"
        disabled={busy || !transcribeReady}
        title={transcribeReady ? '根据音频自动识别并生成字幕' : '当前客户端未提供语音识别通道'}
        onClick={() => void onGenerate()}
      >
        AI 生成字幕
      </button>
      <button
        type="button"
        className="v-caption-btn"
        data-v="caption-import"
        disabled={busy}
        title="导入 .srt 文件（整份替换现有字幕）"
        onClick={() => fileRef.current?.click()}
      >
        导入字幕
      </button>
    </>
  );

  const fileInput = (
    <input
      ref={fileRef}
      type="file"
      accept=".srt,text/plain"
      hidden
      data-v="caption-file"
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file !== undefined) void onFile(file);
      }}
    />
  );

  // ---- 空状态 ----
  if (rows.length === 0) {
    return (
      <div className="v-caption-panel" data-v="caption-panel" data-empty="true">
        <div className="v-caption-empty" data-v="caption-empty">
          <div className="v-caption-empty__title">还没有字幕</div>
          <div className="v-caption-empty__hint">
            导入一份 SRT，或者让 AI 听写音频。字幕会落在<strong>文字轨</strong>上，与手动添加的文字同轨。
          </div>
          <div className="v-caption-empty__actions">{entryButtons}</div>
          {transcribeReady ? null : (
            <div className="v-caption-empty__note" data-v="caption-no-asr">
              当前客户端没有语音识别通道，可先导入 SRT。
            </div>
          )}
          {notice === null ? null : (
            <div className="v-caption-empty__note" data-v="caption-notice">
              {notice}
            </div>
          )}
        </div>
        {fileInput}
      </div>
    );
  }

  // ---- 列表 ----
  return (
    <div className="v-caption-panel" data-v="caption-panel">
      <div className="v-caption-toolbar" data-v="caption-toolbar">
        {entryButtons}
        <button
          type="button"
          className="v-caption-btn"
          data-v="caption-export"
          disabled={busy}
          title="导出为 .srt 文件（可选择保存位置）"
          onClick={() => void onExport()}
        >
          导出字幕
        </button>
      </div>
      <div className="v-caption-statusbar">
        <span className="v-caption-panel__count" data-v="caption-count">
          共 {rows.length} 条
        </span>
        {notice === null ? null : (
          <span className="v-caption-statusbar__notice" data-v="caption-notice">
            {notice}
          </span>
        )}
        {/* 视图切换：靠右，占的是状态栏本来就有的 18px，不新增一行 */}
        <div className="v-caption-viewswitch" data-v="caption-viewswitch" role="group" aria-label="字幕视图">
          <button
            type="button"
            className="v-caption-viewbtn"
            data-v="caption-view-list"
            data-active={view === 'list' ? 'true' : 'false'}
            aria-pressed={view === 'list'}
            title="逐条列表：看时间码、改文本"
            onClick={() => changeView('list')}
          >
            列表
          </button>
          <button
            type="button"
            className="v-caption-viewbtn"
            data-v="caption-view-timeline"
            data-active={view === 'timeline' ? 'true' : 'false'}
            aria-pressed={view === 'timeline'}
            title="迷你时间轴：按真实时长摆放，拖把手调时长"
            onClick={() => changeView('timeline')}
          >
            时间轴
          </button>
        </div>
      </div>
      {view === 'timeline' ? (
        <CaptionTimeline rows={rows} selectedIds={selectedIds} onSeek={onSeek} />
      ) : (
        <CaptionList rows={rows} selectedIds={selectedIds} onPick={pick} focusId={selectedId} />
      )}
      {fileInput}
    </div>
  );
}
