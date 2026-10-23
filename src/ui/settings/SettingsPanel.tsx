/**
 * 左栏「设置」面板（S2 外壳，S3/S4 补齐后五组全部可用）。
 *
 * ## 五组结构（与调节面板同一套折叠规范）
 *
 * ```
 * ▼ 外观      主题（默认 / 高对比）
 * ▶ 编辑偏好  吸附开关 + 新建文字片段的默认时长
 * ▶ 缓存      占用统计 + 打开缓存管理
 * ▶ 快捷键    四个分类，从 KEY_BINDINGS 自动生成
 * ▶ 关于      版本 / 构建时间 / 隐私说明 / 清空本地数据
 * ```
 *
 * 默认展开「外观」，折叠态存 `veditor:settings:openGroups`（**不复用**调节面板的 key，
 * 否则两处折叠互相串味）。
 *
 * ## 这个面板**不发明**任何能力
 *
 * | 组 | 复用谁 |
 * |---|---|
 * | 外观 | `ui/theme` 的 `getTheme` / `setTheme` / `subscribeTheme`（与顶栏主题按钮同一个开关）|
 * | 缓存 | `ui/CacheDialog`（同一个组件，第二处入口）+ `media/draftCache.cacheStats` |
 * | 编辑偏好 | `core/store` 的 `setSnapEnabled`（S1 已把吸附改成持久化偏好）+ `core/prefs` 的默认时长 |
 * | 快捷键 | `core/keymap.KEY_BINDINGS` → `ui/settings/keymapView`（不手写表）|
 * | 关于 | `ui/settings/clearLocalData`（清 localStorage + IndexedDB + OPFS 缓存）|
 *
 * ## 关于「主题」的口径（重要）
 *
 * 项目**没有**浅色/深色两套配色。`app.css` 只有一套明亮色板 + 一组
 * `[data-theme='contrast']` 覆盖（R-064 高对比主题）。所以这里的二态是
 * 「默认 / 高对比」，不是「浅色 / 深色」—— 真做深色要给 3710 行 CSS 补一整套
 * 深色变量，属于独立任务，不在"零底层改动"范围内。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { store, useSnapEnabled } from '../../core/store';
import { detectPlatform } from '../../core/keymap';
import { MAX_DEFAULT_SECONDS, MIN_DEFAULT_SECONDS, readPrefs, writePrefs } from '../../core/prefs';
import { getTheme, setTheme, subscribeTheme } from '../theme';
import type { Theme } from '../theme';
import { CacheDialog, formatBytes } from '../CacheDialog';
import { cacheStats, isCacheAvailable } from '../../media/draftCache';
import type { CacheStats } from '../../media/draftCache';
import { CollapsibleSection } from '../adjust/CollapsibleSection';
import { AdjustRow } from '../adjust/AdjustRow';
import { groupBindings } from './keymapView';
import { clearLocalData, localDataKeys } from './clearLocalData';
// 构建时间的格式化只应有一份：直接用顶栏那两个（本文件不复刻一份 pad 逻辑）
import { formatBuildTime } from '../TopBar';

/** 折叠态存储键（**不能**用调节面板的 `veditor:adjust:openGroups`）。 */
const OPEN_GROUPS_KEY = 'veditor:settings:openGroups';

/**
 * 版本号来自 `package.json`（构建/开发脚本用 esbuild `define` 注入），
 * 不在前端再写一遍 —— 免得发版时两处对不上。
 */
const APP_VERSION: string = typeof __APP_VERSION__ === 'undefined' ? '开发版' : __APP_VERSION__;

export interface SettingsPanelProps {
  /** 构建时间戳（App 从 `dist/build-id.txt` 读一次后传下来，这里不重复 fetch）。 */
  buildId: string;
}

export function SettingsPanel(props: SettingsPanelProps): ReactElement {
  const { buildId } = props;

  /* ---------------- 外观 ---------------- */
  const [theme, setThemeState] = useState<Theme>(() => getTheme());
  useEffect(() => subscribeTheme(() => setThemeState(getTheme())), []);

  const pickTheme = useCallback((next: Theme): void => {
    void setTheme(next);
  }, []);

  /* ---------------- 编辑偏好 ---------------- */
  const snapEnabled = useSnapEnabled();

  /**
   * 默认素材时长：本地状态负责"拖动中的显示"，提交时才写盘。
   *
   * 初始值从偏好读（不写死 3）—— 老用户上次改过 5 秒，打开面板就该是 5。
   */
  const [clipSeconds, setClipSeconds] = useState<number>(() => readPrefs().defaultClipSeconds);
  const commitClipSeconds = useCallback((next: number): void => {
    // `writePrefs` 已经把范围夹到 0.5–60，回写后用它作为唯一显示值
    setClipSeconds(writePrefs({ defaultClipSeconds: next }).defaultClipSeconds);
  }, []);

  /* ---------------- 快捷键（纯展示，不手写表） ---------------- */
  const keyGroups = useMemo(() => groupBindings(detectPlatform()), []);
  const platform = useMemo(() => detectPlatform(), []);

  /* ---------------- 缓存 ---------------- */
  const [cacheOpen, setCacheOpen] = useState(false);
  const [stats, setStats] = useState<CacheStats | null>(null);
  const cacheAvailable = isCacheAvailable();

  const refreshCache = useCallback(async (): Promise<void> => {
    if (!isCacheAvailable()) {
      setStats(null);
      return;
    }
    setStats(await cacheStats());
  }, []);

  // 挂载读一次；关掉缓存弹窗再读一次（用户可能刚清空过）
  useEffect(() => {
    void refreshCache();
  }, [refreshCache]);
  useEffect(() => {
    if (!cacheOpen) void refreshCache();
  }, [cacheOpen, refreshCache]);

  /* ---------------- 关于 / 清空本地数据 ---------------- */
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const doClear = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await clearLocalData();
      const parts = [`清掉 ${result.storageKeys} 项偏好`];
      parts.push(result.idb ? '本地工程已删除' : '本地工程未能删除（可能有其它编辑窗口占用）');
      if (cacheAvailable) parts.push(result.cache ? '素材缓存已清空' : '素材缓存未能清空');
      setMessage(`${parts.join('、')}。正在重新加载…`);
      // 内存里的 store / 解码器池 / 缓存后端都握着已删数据的句柄，刷新是最干净的重置
      window.setTimeout(() => window.location.reload(), 800);
    } catch {
      setMessage('清空过程中出错，请刷新页面后重试。');
      setBusy(false);
    }
  }, [cacheAvailable]);

  const localKeys = localDataKeys();

  return (
    <div className="v-settings-panel" data-v="settings-panel">
      {/* ================= 外观 ================= */}
      <CollapsibleSection
        title="外观"
        groupKey="settings:appearance"
        defaultOpen
        testId="settings-group-appearance"
        storageKey={OPEN_GROUPS_KEY}
      >
        <div className="v-settings__row">
          <span className="v-settings__label">主题</span>
          <div className="v-settings__segmented" role="group" aria-label="主题">
            <button
              type="button"
              data-v="settings-theme-default"
              data-active={theme === 'default'}
              aria-pressed={theme === 'default'}
              onClick={() => pickTheme('default')}
            >
              默认
            </button>
            <button
              type="button"
              data-v="settings-theme-contrast"
              data-active={theme === 'contrast'}
              aria-pressed={theme === 'contrast'}
              onClick={() => pickTheme('contrast')}
            >
              高对比
            </button>
          </div>
        </div>
        <div className="v-settings__note" data-v="settings-theme-note">
          「默认」是标准浅色界面；「高对比」把底色换成深色并提高对比度（适合弱光环境、长时间剪辑）。
          与顶栏的「主题」按钮是同一个开关，改哪边另一处都跟着变。
        </div>
      </CollapsibleSection>

      {/* ================= 编辑偏好 ================= */}
      <CollapsibleSection
        title="编辑偏好"
        groupKey="settings:editing"
        testId="settings-group-editing"
        storageKey={OPEN_GROUPS_KEY}
      >
        <div className="v-settings__switch-row">
          <input
            id="settings-snap"
            data-v="settings-snap"
            type="checkbox"
            checked={snapEnabled}
            onChange={(event) => store.setSnapEnabled(event.target.checked)}
          />
          <label htmlFor="settings-snap">时间线吸附（对齐片段边缘与接缝）</label>
        </div>
        <div className="v-settings__note" data-v="settings-snap-note">
          关掉后拖动片段不再自动对齐，可自由挪动。这个设置会记住（重开还是关掉的状态），
          也可以随时按 <kbd className="v-settings__kbd">N</kbd> 切换。
        </div>
        {/* 默认时长：与吸附同一个组（都是"编辑行为偏好"），拖动中不写盘，松手才写 */}
        <AdjustRow
          label="时长"
          testId="settings-clip-seconds"
          ariaLabel="新建文字片段的默认时长（秒）"
          value={clipSeconds}
          min={MIN_DEFAULT_SECONDS}
          max={MAX_DEFAULT_SECONDS}
          step={0.5}
          onChange={(next) => setClipSeconds(next)}
          onCommit={commitClipSeconds}
        />
        <div className="v-settings__note" data-v="settings-clip-seconds-note">
          新建文字片段的默认时长（{clipSeconds} 秒）。点模板、工具栏「文字」、拖模板到时间线
          <strong>都读这一个值</strong>；只影响之后新建的片段，已有片段时长不变。
        </div>
      </CollapsibleSection>

      {/* ================= 缓存 ================= */}
      <CollapsibleSection
        title="缓存"
        groupKey="settings:cache"
        testId="settings-group-cache"
        storageKey={OPEN_GROUPS_KEY}
      >
        <div className="v-settings__row">
          <span className="v-settings__label">占用</span>
          <span className="v-settings__value" data-v="settings-cache-size">
            {cacheAvailable
              ? stats === null
                ? '读取中…'
                : `${formatBytes(stats.bytes)} · ${stats.count} 个文件`
              : '当前环境不支持'}
          </span>
        </div>
        <button
          type="button"
          className="v-settings__button"
          data-v="settings-cache-open"
          disabled={!cacheAvailable}
          onClick={() => setCacheOpen(true)}
        >
          打开缓存管理
        </button>
        <div className="v-settings__note" data-v="settings-cache-note">
          导入过的素材会在本机复制一份，刷新后不再依赖源文件还在原地。
          缓存会占磁盘，可以在缓存管理里清理未使用的文件或直接关掉自动缓存。
        </div>
      </CollapsibleSection>

      {/* ================= 快捷键 ================= */}
      <CollapsibleSection
        title="快捷键"
        groupKey="settings:keymap"
        testId="settings-group-keymap"
        storageKey={OPEN_GROUPS_KEY}
      >
        {/* 不手写表：直接遍历 keymap.KEY_BINDINGS（经 keymapView 分类 + 格式化） */}
        {keyGroups.map((group) => (
          <div className="v-settings__key-group" key={group.category} data-v={`settings-keys-${group.category}`}>
            <div className="v-settings__key-title">
              {group.label}
              <span className="v-settings__key-count">{group.rows.length}</span>
            </div>
            {group.rows.map((row) => (
              <div className="v-settings__key-row" key={row.id} data-v={`settings-key-${row.id}`}>
                <span className="v-settings__key-label">{row.label}</span>
                <span className="v-settings__caps">
                  {row.caps.map((cap, index) => (
                    <kbd className="v-settings__kbd" key={`${row.id}-${index}`}>
                      {cap}
                    </kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        ))}
        <div className="v-settings__note" data-v="settings-keymap-note">
          表格从键位表自动生成（改了快捷键这里会自动跟上）。
          {platform === 'mac' ? '当前按 Mac 键位显示：⌘ / ⌥ / ⇧。' : '当前按 Windows 键位显示：Ctrl / Alt / Shift（Mac 上会自动换成 ⌘ / ⌥ / ⇧）。'}
        </div>
      </CollapsibleSection>

      {/* ================= 关于 ================= */}
      <CollapsibleSection
        title="关于"
        groupKey="settings:about"
        testId="settings-group-about"
        storageKey={OPEN_GROUPS_KEY}
      >
        <div className="v-settings__row">
          <span className="v-settings__label">版本</span>
          <span className="v-settings__value" data-v="settings-version">
            {APP_VERSION}
          </span>
        </div>
        <div className="v-settings__row">
          <span className="v-settings__label">构建</span>
          <span className="v-settings__value" data-v="settings-build">
            {buildId === '' ? '—' : formatBuildTime(buildId)}
          </span>
        </div>
        <div className="v-settings__note" data-v="settings-privacy">
          <strong>隐私</strong>：素材不会上传。解码、渲染、导出全部在本机完成；
          使用 AI 功能时只发送你的指令文本与工程结构（轨道、片段、时长），
          <strong>不发送画面与音频</strong>。
        </div>

        {confirmClear ? (
          <div className="v-settings__confirm" data-v="settings-clear-confirm">
            <div className="v-settings__confirm-title">确认清空本地数据？</div>
            <ul className="v-settings__confirm-list">
              <li>本机保存的工程草稿与撤销历史（不可恢复）</li>
              <li>{localKeys.length} 项界面偏好（主题、上次停留的 Tab、折叠状态…）</li>
              <li>素材缓存副本、缩略图与代理文件</li>
            </ul>
            <div className="v-settings__note">
              素材<strong>原文件不受影响</strong>，清空后重新导入即可。清理完页面会自动刷新。
            </div>
            {message === '' ? null : (
              <div className="v-settings__note" data-v="settings-clear-message">
                {message}
              </div>
            )}
            <div className="v-settings__actions">
              <button
                type="button"
                className="v-settings__danger"
                data-v="settings-clear-do"
                disabled={busy}
                onClick={() => void doClear()}
              >
                确认清空
              </button>
              <button
                type="button"
                className="v-settings__button"
                data-v="settings-clear-cancel"
                disabled={busy}
                onClick={() => {
                  setConfirmClear(false);
                  setMessage('');
                }}
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <div className="v-settings__actions">
            <button
              type="button"
              className="v-settings__danger"
              data-v="settings-clear"
              onClick={() => setConfirmClear(true)}
            >
              清空本地数据
            </button>
          </div>
        )}
      </CollapsibleSection>

      {/*
        缓存的第二处入口：同一个 `CacheDialog`（不复刻弹窗）。
        顶栏那份与这份互斥使用，同时打开也不会互相干扰（各自独立开关）。
      */}
      <CacheDialog open={cacheOpen} onClose={() => setCacheOpen(false)} />
    </div>
  );
}
