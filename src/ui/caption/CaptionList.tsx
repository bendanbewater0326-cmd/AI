/**
 * 左栏「字幕」面板的**列表视图**（C2）。
 *
 * ## 一屏要能看 8–10 条
 *
 * 每条压到 52px 高：时间码一行（10px）、文本一行（12px，单行省略）。
 * 点开编辑时才展开成多行 textarea。这是"对字幕"场景的最优密度——
 * 每条做成 100px 的大卡片，一屏只能看 4 条，用户要滚半天。
 *
 * ## 播放高亮：**只在"跨到另一条"时重渲染**
 *
 * 直接订阅 `playheadBus` 并 `setState` 会 30fps 重渲染整个列表。
 * 这里在订阅回调里**比较当前字幕 id**，只有真的换了一条才 setState ——
 * 播放时列表几乎零重渲染。
 *
 * ## 内联编辑的撤销语义
 *
 * 一次编辑 = 一次 `setClipText` = **一个撤销步**（用户说的"不产生额外撤销步"就是指这个：
 * 不要因为"点进来 / 点出去 / 失焦"各产生一步）。
 * 文本没变时 `buildEditTextOps` 返回空数组 → 不 dispatch → 不留撤销步。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { store } from '../../core/store';
import type { CaptionRow } from '../../core/captions';
import { buildEditTextOps, formatCaptionMs } from '../../core/captions';
import { frameToMs } from '../../core/timebase';
import { findClipById } from '../../core/transitionTarget';
import type { TextOrigin } from '../../core/types';

/** 角标文案：SRT 导入**不标**（用户要求：避免视觉信息过载）。 */
const ORIGIN_BADGE: Record<TextOrigin, string | null> = {
  manual: '文字',
  caption: null,
  ai: 'AI',
};

export interface CaptionListProps {
  rows: CaptionRow[];
  /** 当前选中的片段 id（多选时是其中任意一个，用于"选中态"样式）。 */
  selectedIds: readonly string[];
  /** 点击一条：跳播放头 + 选中。 */
  onPick: (row: CaptionRow) => void;
}

export function CaptionList(props: CaptionListProps): ReactElement {
  const { rows, selectedIds, onPick } = props;

  /** 正在编辑的片段 id（null = 没有在编辑）。 */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /** 播放头所在的字幕（播放联动高亮）。 */
  const [activeId, setActiveId] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // 编辑态自动聚焦 + 光标移到末尾
  useEffect(() => {
    if (editingId === null) return;
    const node = inputRef.current;
    if (node === null) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, [editingId]);

  // 播放联动：只在"跨到另一条"时重渲染（不订阅 doc，避免每帧重渲染）
  useEffect(() => {
    let previous = '';
    const unsubscribe = store.playheadBus.subscribe((frame) => {
      const hit = rows.find(
        (row) => frame >= row.startFrame && frame < row.startFrame + row.durationFrames,
      );
      const next = hit?.clipId ?? '';
      if (next !== previous) {
        previous = next;
        setActiveId(next === '' ? null : next);
      }
    });
    return unsubscribe;
  }, [rows]);

  /** 提交编辑：走统一纯函数，空/未变都不产生撤销步。 */
  const commit = useCallback(
    (clipId: string, text: string, original: string): void => {
      setEditingId(null);
      if (text.trim() === original) return;
      const found = findClipById(store.getDoc(), clipId);
      if (found === null) return;
      const result = buildEditTextOps(found.clip, text);
      if (!result.ok) {
        store.pushError(result.error);
        return;
      }
      if (result.value.length === 0) return;
      store.dispatch(result.value, '编辑字幕');
    },
    [],
  );

  return (
    <div className="v-caption-list" data-v="caption-list">
      {rows.map((row) => {
        const selected = selectedIds.includes(row.clipId);
        const active = activeId === row.clipId;
        const editing = editingId === row.clipId;
        const badge = ORIGIN_BADGE[row.origin];
        const fpsMilli = store.getDoc().fpsMilli;
        const endMs = frameToMs(row.startFrame + row.durationFrames, fpsMilli);
        const startMs = frameToMs(row.startFrame, fpsMilli);

        return (
          <div
            key={row.clipId}
            className="v-caption-row"
            data-v="caption-row"
            data-clip-id={row.clipId}
            data-selected={selected ? 'true' : 'false'}
            data-active={active ? 'true' : 'false'}
            data-origin={row.origin}
            onClick={() => onPick(row)}
            onDoubleClick={() => {
              setEditingId(row.clipId);
              setDraft(row.text);
            }}
          >
            {/*
              **单行紧凑布局**：一屏才能放下 8–10 条（用户明确要求）。
              时间码只显示**起点**，终点放 `title`（悬停可见）+ 编辑态显示——
              两端都铺在一行会让时间码自己吃掉 32 个字符，行高被迫 46px，一屏只剩 3 条。
            */}
            <span
              className="v-caption-row__time"
              data-v="caption-time"
              title={`${formatCaptionMs(startMs)} → ${formatCaptionMs(endMs)}（${((endMs - startMs) / 1000).toFixed(2)} 秒）`}
            >
              {formatCaptionMs(startMs)}
            </span>
            {editing ? (
              <textarea
                ref={inputRef}
                className="v-caption-row__editor"
                data-v="caption-editor"
                value={draft}
                rows={2}
                onChange={(event) => setDraft(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onBlur={() => commit(row.clipId, draft, row.text)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    commit(row.clipId, draft, row.text);
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    setEditingId(null);
                  }
                }}
              />
            ) : (
              <>
                <span className="v-caption-row__text" data-v="caption-text" title="双击编辑">
                  {row.text}
                </span>
                {badge === null ? null : (
                  <span
                    className="v-caption-row__badge"
                    data-v="caption-badge"
                    data-origin={row.origin}
                  >
                    {badge}
                  </span>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
