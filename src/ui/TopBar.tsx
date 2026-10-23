/**
 * 顶栏（T11）：工程名重命名、工程参数入口（R-015 二次确认）、✦ 占位。
 *
 * 三条约定：
 *   1. 重命名**不进撤销栈**（不是内容编辑，避免 Cmd+Z 撤销掉改名）；
 *   2. 无片段时改参数**立即生效**；有片段时必须二次确认，并给出"受影响片段数 + 最大位移帧数"
 *      （数字来自 `previewRecompute`，禁止只写"已有片段将重新换算"）；
 *   3. ✦ 在 M1/M2 恒置灰（`getAIModel()` 返回 null），不出现任何 AI 文案。
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { Frame, MilliFps, Project, ProjectParams } from '../core/types';
import { makeError } from '../core/types';
import { previewRecompute } from '../core/operations';
import { framesPerSecond } from '../core/timebase';
import { store, useDerived, useDoc, useVersion } from '../core/store';
import { splitAtPlayhead } from '../core/keymap';
import { ExportDialog } from './ExportDialog';
import { SelfCheckPanel } from './SelfCheck';
import { CacheDialog } from './CacheDialog';
import { getAIProvider, isAIUsable } from '../ai/registry';
import { parseProjectFile, projectFileName, serializeProjectFile } from '../persist/projectFile';
import { resetPreviewSources } from '../media/previewSource';
import { getTheme, subscribeTheme, toggleTheme } from './theme';
import { exportSrt, importSrtFile } from './caption/actions';

/**
 * 构建时间戳 → 本地 `HH:MM:SS`。
 *
 * `build-id.txt` 里是 **UTC** 的 ISO 串（`2026-10-21T17:22:46Z`），
 * 直接 slice 出来显示会让东八区用户看到"比现在早 8 小时"的时间，
 * 误以为页面加载的是旧代码（实测被这个坑过一次）。
 */
function formatBuildTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(11, 19);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const selectName = (doc: Project): string => doc.name;
const selectFps = (doc: Project): MilliFps => doc.fpsMilli;
const selectWidth = (doc: Project): number => doc.width;
const selectHeight = (doc: Project): number => doc.height;

/** 显示用：毫帧率 → 帧率文本（30 / 29.97 / 23.976）。 */
export function formatFps(fpsMilli: MilliFps): string {
  const value = fpsMilli / 1000; // timebase-allow: 仅 UI 显示帧率，不参与任何帧换算
  return String(Number(value.toFixed(3)));
}

/** 输入用：帧率文本 → 毫帧率整数。 */
export function parseFps(text: string): MilliFps {
  const value = Number(text.trim());
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('帧率必须是正数');
  }
  return Math.round(value * 1000); // timebase-allow: 仅 UI 输入换算为毫帧率
}

interface ParamsPreview {
  affectedClipCount: number;
  maxShiftFrames: number;
}

/** 顶栏组件。 */
export function TopBar({ buildId = '' }: { buildId?: string } = {}): ReactElement {
  const name = useDoc(selectName);
  const fpsMilli = useDoc(selectFps);
  const width = useDoc(selectWidth);
  const height = useDoc(selectHeight);
  const derived = useDerived();

  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  /** 工程文件菜单（R-054）。 */
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [selfCheckOpen, setSelfCheckOpen] = useState(false);
  const [cacheOpen, setCacheOpen] = useState(false);
  /**
   * 订阅"任何状态变化"，让撤销/重做按钮的可用性跟着变。
   * `useDoc` 只在 doc 变化时重渲染，而 `canUndo` 依赖撤销栈深度（ephemeral 的一部分）。
   */
  useVersion();
  const canUndo = store.canUndo();
  const canRedo = store.canRedo();
  const [theme, setThemeState] = useState(getTheme());
  const projectFileRef = useRef<HTMLInputElement | null>(null);
  /** 字幕文件选择（R-059）。 */
  const subtitleInputRef = useRef<HTMLInputElement | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [draftFps, setDraftFps] = useState(formatFps(fpsMilli));
  const [draftWidth, setDraftWidth] = useState(String(width));
  const [draftHeight, setDraftHeight] = useState(String(height));
  const [pending, setPending] = useState<ParamsPreview | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  // 高对比主题（R-064）：订阅模块级状态，顶栏按钮反映当前值
  useEffect(() => subscribeTheme(() => setThemeState(getTheme())), []);

  // Ctrl/Cmd+E：快捷键广播意图，顶栏负责开弹窗（keymap 不持有 UI 状态）
  useEffect(() => {
    const open = (): void => setExportOpen(true);
    window.addEventListener('veditor:export', open);

  return () => window.removeEventListener('veditor:export', open);
  }, []);

  const startRename = (): void => {
    setDraftName(name);
    setRenaming(true);
  };

  const commitRename = (): void => {
    if (!renaming) return;
    setRenaming(false);
    store.setProjectName(draftName);
  };

  const cancelRename = (): void => {
    setRenaming(false);
    setDraftName(name);
  };

  const openDialog = (): void => {
    setDraftFps(formatFps(fpsMilli));
    setDraftWidth(String(width));
    setDraftHeight(String(height));
    setPending(null);
    setErrorText(null);
    setDialogOpen(true);
  };

  const buildParams = (): ProjectParams => {
    const parsedWidth = Number(draftWidth.trim());
    const parsedHeight = Number(draftHeight.trim());
    if (!Number.isInteger(parsedWidth) || parsedWidth <= 0 || !Number.isInteger(parsedHeight) || parsedHeight <= 0) {
      throw new Error('宽高必须是正整数');
    }
    return { fpsMilli: parseFps(draftFps), width: parsedWidth, height: parsedHeight };
  };

  const applyImmediately = (to: ProjectParams): void => {
    const doc = store.getDoc();
    store.dispatch(
      [
        {
          op: 'setProjectParams',
          from: { fpsMilli: doc.fpsMilli, width: doc.width, height: doc.height },
          to,
        },
      ],
      '修改工程参数',
    );
    setDialogOpen(false);
    setPending(null);
  };

  const handleApply = (): void => {
    let next: ProjectParams;
    try {
      next = buildParams();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : '参数不合法');
      return;
    }
    const unchanged =
      next.fpsMilli === fpsMilli && next.width === width && next.height === height;
    if (unchanged) {
      setDialogOpen(false);
      return;
    }
    if (derived.clipCount === 0) {
      applyImmediately(next);
      return;
    }
    // 有片段：先算影响面，再让用户确认（R-015）
    const preview = previewRecompute(store.getDoc(), next);
    setPending({
      affectedClipCount: preview.affectedClipCount,
      maxShiftFrames: preview.maxShiftFrames,
    });
  };

  const confirmApply = (): void => {
    let next: ProjectParams;
    try {
      next = buildParams();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : '参数不合法');
      return;
    }
    applyImmediately(next);
  };

  /** 导出工程文件（R-054）：单个 .vedproj，只带元数据，不带素材字节。 */
function exportProjectFile(): void {
  const doc = store.getDoc();
  const blob = new Blob([serializeProjectFile(doc)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = projectFileName(doc);
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}


/**
 * 导入工程文件（R-054）。
 *
 * 必须先 `resetPreviewSources()`：旧的素材源/代理还挂在注册表与引擎里，
 * 不清的话新工程会"借用"旧素材的字节——看起来能播，其实播的是上一个工程的内容。
 */
async function importProjectFile(file: File): Promise<void> {
  let text = '';
  try {
    text = await file.text();
  } catch {
    store.pushError(makeError('E_INVALID_PROJECT', '读取工程文件失败', file.name));
    return;
  }
  const parsed = parseProjectFile(text);
  if (!parsed.ok) {
    store.pushError(parsed.error);
    return;
  }
  resetPreviewSources();
  store.replaceDoc(parsed.value);
}

  return (
    <header className="v-topbar" data-v="topbar">
      {/* 软件标识：只做视觉锚点，不可点（点它没有任何合理动作） */}
      <span className="v-topbar__brand" data-v="brand" aria-hidden="true">
        veditor
      </span>

      {renaming ? (
        <input
          ref={inputRef}
          className="v-topbar__rename"
          data-v="project-name-input"
          value={draftName}
          aria-label="工程名"
          onChange={(event) => setDraftName(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitRename();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              cancelRename();
            }
          }}
        />
      ) : (
        <span
          className="v-topbar__name"
          data-v="project-name"
          title="双击重命名"
          onDoubleClick={startRename}
        >
          {name}
        </span>
      )}

      <button
        type="button"
        className="v-topbar__params"
        data-v="project-params"
        title="修改工程参数"
        onClick={openDialog}
      >
        {`${width}×${height} · ${formatFps(fpsMilli)}fps`}
      </button>

      <span className="v-topbar__divider" aria-hidden="true" />

      {/**
        * 高频编辑工具。
        *
        * **没有"选择工具"**：这个项目不做"选择/切割/手型"的模式切换
        * （`docs/ux-plan.md` §6 明确列为不做项）—— 时间线只有一种交互，
        * 加一个点了什么都不改变的按钮就是死按钮。
        */}
      <div className="v-topbar__tools" data-v="topbar-tools">
        <button
          type="button"
          className="v-topbar__tool"
          data-v="undo"
          disabled={!canUndo}
          title="撤销（Ctrl+Z）"
          aria-label="撤销"
          onClick={() => store.undo()}
        >
          ↶
        </button>
        <button
          type="button"
          className="v-topbar__tool"
          data-v="redo"
          disabled={!canRedo}
          title="重做（Ctrl+Shift+Z）"
          aria-label="重做"
          onClick={() => store.redo()}
        >
          ↷
        </button>
        <button
          type="button"
          className="v-topbar__tool"
          data-v="split"
          title="在播放头处分割（B）"
          aria-label="分割"
          onClick={() => {
            const count = splitAtPlayhead(store);
            if (count === 0) {
              store.pushError(makeError('E_INVALID_TIMECODE', '播放头位置没有可分割的片段', ''));
            }
          }}
        >
          ✂
        </button>
      </div>

      <span className="v-topbar__spacer" />

      <button
        type="button"
        className="v-topbar__theme"
        data-v="self-check"
        title="自检：在这台机器/这个面板里跑 6 项基础检查（解码 / 预览 / 音频 / 播放头）"
        onClick={() => setSelfCheckOpen(true)}
      >
        自检
      </button>

      <div className="v-topbar__menu">
        <button
          type="button"
          data-v="project-menu"
          title="工程文件（R-054）：整份工程存成一个 .vedproj，换浏览器导入后素材重新链接即可"
          aria-expanded={projectMenuOpen}
          onClick={() => setProjectMenuOpen((open) => !open)}
        >
          工程
        </button>
        {projectMenuOpen ? (
          <div className="v-topbar__dropdown" data-v="project-dropdown" role="menu">
            <button
              type="button"
              data-v="project-export"
              role="menuitem"
              onClick={() => {
                setProjectMenuOpen(false);
                exportProjectFile();
              }}
            >
              导出工程文件…
            </button>
            <button
              type="button"
              data-v="project-import"
              role="menuitem"
              onClick={() => {
                setProjectMenuOpen(false);
                projectFileRef.current?.click();
              }}
            >
              导入工程文件…
            </button>
            <button
              type="button"
              data-v="subtitle-import"
              role="menuitem"
              onClick={() => {
                setProjectMenuOpen(false);
                subtitleInputRef.current?.click();
              }}
            >
              导入字幕（SRT）…
            </button>
            <button
              type="button"
              data-v="subtitle-export"
              role="menuitem"
              onClick={() => {
                setProjectMenuOpen(false);
                void exportSrt();
              }}
            >
              导出字幕（SRT）
            </button>
            <div className="v-topbar__dropdown-sep" role="separator" />
            {/**
              * 主题 / 缓存 / 构建时间都收进这里。
              *
              * 它们原来在顶栏右侧平铺，占了 3 个位置但都是"偶尔用一次"的功能；
              * 顶栏要腾出位置给"撤销/重做/分割"这些真正高频的操作。
              * **`data-v` 保持不变**：E2E 靠它找元素，收进下拉不影响选择器。
              */}
            <button
              type="button"
              data-v="theme-toggle"
              role="menuitem"
              aria-pressed={theme === 'contrast'}
              onClick={() => {
                setProjectMenuOpen(false);
                void toggleTheme();
              }}
            >
              {theme === 'contrast' ? '切换回默认主题' : '切换到高对比主题'}
            </button>
            <button
              type="button"
              data-v="cache-open"
              role="menuitem"
              onClick={() => {
                setProjectMenuOpen(false);
                setCacheOpen(true);
              }}
            >
              素材缓存…
            </button>
            {buildId === '' ? null : (
              <span className="v-topbar__dropdown-stamp" data-v="build-stamp">
                {`构建于 ${formatBuildTime(buildId)}`}
              </span>
            )}
          </div>
        ) : null}
      </div>
      <input
        ref={subtitleInputRef}
        type="file"
        accept=".srt,text/plain"
        hidden
        data-v="subtitle-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file !== undefined) void importSrtFile(file);
        }}
      />
      <input
        ref={projectFileRef}
        type="file"
        accept=".vedproj,application/json"
        hidden
        data-v="project-file-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file !== undefined) void importProjectFile(file);
        }}
      />

      <button
        type="button"
        className="v-topbar__ai"
        data-v="ai-open"
        aria-disabled={!isAIUsable()}
        disabled={!isAIUsable()}
        title={
          isAIUsable()
            ? `AI 命令栏（Ctrl/Cmd+K）· ${getAIProvider().label}`
            : '当前客户端未提供模型'
        }
        onClick={() => window.dispatchEvent(new CustomEvent('veditor:ai'))}
      >
        ✦ AI 命令
      </button>
      <button
        type="button"
        data-v="export-open"
        title="导出（Ctrl/Cmd+E）"
        onClick={() => setExportOpen(true)}
        disabled={derived.durationFrames === 0}
      >
        导出
      </button>

      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
      <SelfCheckPanel open={selfCheckOpen} onClose={() => setSelfCheckOpen(false)} />
      <CacheDialog open={cacheOpen} onClose={() => setCacheOpen(false)} />

      {dialogOpen ? (
        <div className="v-dialog" role="dialog" aria-modal="true" aria-label="工程参数" data-v="params-dialog">
          {pending === null ? (
            <>
              <div className="v-dialog__title">工程参数</div>
              <label className="v-dialog__field">
                <span>帧率（fps）</span>
                <input
                  data-v="params-fps"
                  value={draftFps}
                  inputMode="decimal"
                  onChange={(event) => setDraftFps(event.target.value)}
                />
              </label>
              <label className="v-dialog__field">
                <span>宽度</span>
                <input
                  data-v="params-width"
                  value={draftWidth}
                  inputMode="numeric"
                  onChange={(event) => setDraftWidth(event.target.value)}
                />
              </label>
              <label className="v-dialog__field">
                <span>高度</span>
                <input
                  data-v="params-height"
                  value={draftHeight}
                  inputMode="numeric"
                  onChange={(event) => setDraftHeight(event.target.value)}
                />
              </label>
              {errorText ? <div className="v-dialog__error">{errorText}</div> : null}
              <div className="v-dialog__actions">
                <button type="button" onClick={() => setDialogOpen(false)}>
                  取消
                </button>
                <button type="button" className="v-dialog__primary" data-v="params-apply" onClick={handleApply}>
                  应用
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="v-dialog__title">确认修改工程参数</div>
              <div className="v-dialog__detail" data-v="params-impact">
                {`受影响片段 ${pending.affectedClipCount} 个 · 最大位移 ${pending.maxShiftFrames} 帧`}
              </div>
              <div className="v-dialog__detail v-dialog__detail--dim">
                改帧率不会改变素材跨度（不丢帧），原有间隙会保留。
              </div>
              <div className="v-dialog__actions">
                <button type="button" onClick={() => setPending(null)}>
                  返回
                </button>
                <button type="button" className="v-dialog__primary" data-v="params-confirm" onClick={confirmApply}>
                  确认应用
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </header>
  );
}

/** 供 T13 复用的时间码格式（HH:MM:SS:FF，基数 = round(fpsMilli/1000)）。 */
export function formatTimecode(frame: Frame, fpsMilli: MilliFps): string {
  const base = Math.max(1, Math.round(framesPerSecond(fpsMilli))); // 时间码基数 = round(fpsMilli/1000)
  const totalSeconds = Math.floor(frame / base);
  const ff = frame % base;
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

/**
 * 时间码解析（`formatTimecode` 的逆）：`HH:MM:SS:FF` → 帧号。
 *
 * - 接受 `HH:MM:SS:FF` / `MM:SS:FF` / `SS:FF` / 纯帧数，缺省高位补 0（R-030）
 * - 基数 `tcBase = round(fpsMilli / 1000)`，`FF` 必须 `< tcBase`，否则非法
 * - 返回 `null` 表示非法输入（调用方回退原值并保持焦点，R-030）
 */
export function parseTimecode(input: string, fpsMilli: MilliFps): Frame | null {
  const base = Math.max(1, Math.round(framesPerSecond(fpsMilli)));
  const trimmed = input.trim();
  if (trimmed === '') return null;

  const parts = trimmed.split(':');
  if (parts.some((part) => !/^\d+$/.test(part))) return null;
  if (parts.length > 4) return null;

  const nums = parts.map((part) => Number.parseInt(part, 10));
  if (nums.some((n) => !Number.isSafeInteger(n) || n < 0)) return null;

  // 单段数字 = 帧数（用户输入纯数字更可能是"跳到第 N 帧"）；多段按 HH:MM:SS:FF 补高位
  if (parts.length === 1) return nums[0] ?? null;

  // 补齐为 [HH, MM, SS, FF]
  while (nums.length < 4) nums.unshift(0);

  const [hh, mm, ss, ff] = nums as [number, number, number, number];
  if (mm >= 60 || ss >= 60 || ff >= base) return null;

  const totalSeconds = hh * 3600 + mm * 60 + ss;
  return totalSeconds * base + ff;
}
