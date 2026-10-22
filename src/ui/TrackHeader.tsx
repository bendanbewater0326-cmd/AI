/**
 * 轨道头（DOM）。
 *
 * ## 为什么轨道头是 DOM、轨道内容却是 canvas
 *
 * 轨道头需要**无障碍标签、hover tooltip、双击改名、右键菜单**——这些在 canvas 上
 * 全要手写一遍（我们之前就是手写的：canvas 画文字 + 一层绝对定位的按钮，结果
 * 名字和按钮各画一半、高对比主题下还容易对不齐）。
 * 而轨道内容是高频重绘（缩略图/波形/把手/虚影），必须留在 canvas。
 *
 * 这条边界在 `docs/timeline-spec.md` §0.1 里定过：**轨道头 DOM，内容 canvas，浮层 DOM**。
 *
 * ## 图标为什么用 SVG 而不是文字
 *
 * 之前把 `M/H/L/×` 改成 `静/隐/锁/删`，是因为"静音/隐藏"这类图标每个软件都不一样，
 * 用户猜不出来。但**眼睛=显示、喇叭=静音、锁=锁定**是少数几个全行业统一的符号，
 * 而且这里每个图标都带 `aria-label` + `title`，猜不出来的情况有兜底。
 * 另外 130px 宽的头里，"图标 + 名称 + 4 个按钮"用文字按钮会挤爆。
 */
import type { ReactElement } from 'react';
import type { Track } from '../core/types';
import type { TrackRow } from '../core/trackLayout';

/* ---------------- 图标（16px，currentColor） ---------------- */

function FilmIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="1.5" y="3" width="13" height="10" rx="1.2" />
      <path d="M4.5 3v10M11.5 3v10M1.5 8h13" />
    </svg>
  );
}

function NoteIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M6 12.2V4.3l6.5-1.6v7.6" />
      <circle cx="4.4" cy="12.4" r="1.8" />
      <circle cx="10.9" cy="10.5" r="1.8" />
    </svg>
  );
}

function TextIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M3 3.5h10M8 3.5v9M5.5 12.5h5" />
    </svg>
  );
}

function EyeIcon({ off }: { off: boolean }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M1.5 8s2.4-3.8 6.5-3.8S14.5 8 14.5 8s-2.4 3.8-6.5 3.8S1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="1.7" />
      {off ? <path d="M2.5 13.5 13.5 2.5" /> : null}
    </svg>
  );
}

function SpeakerIcon({ off }: { off: boolean }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M3 6h2.2L8.5 3.6v8.8L5.2 10H3Z" />
      {off ? (
        <path d="M10.6 6.2l3 3M13.6 6.2l-3 3" />
      ) : (
        <path d="M10.4 6.1a2.6 2.6 0 0 1 0 3.8M12.2 4.7a5 5 0 0 1 0 6.6" />
      )}
    </svg>
  );
}

function LockIcon({ open }: { open: boolean }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="3.4" y="7" width="9.2" height="6.4" rx="1.2" />
      <path d={open ? 'M5.8 7V5.2a2.2 2.2 0 0 1 4.3-.7' : 'M5.8 7V5.4a2.2 2.2 0 0 1 4.4 0V7'} />
    </svg>
  );
}

function MoreIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">
      <circle cx="8" cy="3.4" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="8" cy="12.6" r="1.2" />
    </svg>
  );
}

/* ---------------- 组件 ---------------- */

export interface TrackHeaderProps {
  track: Track;
  row: TrackRow;
  selected: boolean;
  /** 正在改名时显示输入框。 */
  renaming: boolean;
  renameDraft: string;
  onRenameStart: () => void;
  onRenameDraft: (draft: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onToggleFlag: (flag: 'muted' | 'hidden' | 'locked' | 'solo', value: boolean) => void;
  onOpenMenu: (event: { clientX: number; clientY: number }) => void;
  /** 按下下边缘的高度热区（拖动改轨道高）。 */
  onResizeStart: (event: React.PointerEvent<HTMLElement>) => void;
  /** 在轨道头空白处按下（可能是拖拽排序的起点，也可能是双击改名）。 */
  onBodyPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
}

/**
 * 一条轨道的头。
 *
 * 视觉规范见 `docs/timeline-spec.md` §2：
 * 130px 宽、图标 16 / 名称 12 / 按钮 18、按类型分底色、四态（默认/悬停/选中/锁定）。
 */
export function TrackHeader({
  track,
  row,
  selected,
  renaming,
  renameDraft,
  onRenameStart,
  onRenameDraft,
  onRenameCommit,
  onRenameCancel,
  onToggleFlag,
  onOpenMenu,
  onResizeStart,
  onBodyPointerDown,
}: TrackHeaderProps): ReactElement {
  const isAudio = track.kind === 'audio';
  return (
    <div
      className="v-track-head"
      data-v={`track-head-${track.id}`}
      data-kind={track.kind}
      data-selected={selected}
      data-locked={track.locked}
      style={{ top: row.top, height: row.height }}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenMenu({ clientX: event.clientX, clientY: event.clientY });
      }}
      onPointerDown={(event) => {
        /**
         * 改名输入框里的按下不算"拖拽轨道"（否则选文字会变成拖轨）。
         * 按钮自己 `stopPropagation`，所以到不了这里。
         */
        if (event.target instanceof HTMLInputElement) return;
        onBodyPointerDown(event);
      }}
    >
      <span className="v-track-head__icon" data-v={`track-icon-${track.id}`}>
        {track.kind === 'video' ? <FilmIcon /> : isAudio ? <NoteIcon /> : <TextIcon />}
      </span>

      {renaming ? (
        <input
          className="v-track-head__rename"
          data-v="track-rename-input"
          value={renameDraft}
          aria-label="轨道名"
          autoFocus
          onChange={(event) => onRenameDraft(event.target.value)}
          onBlur={onRenameCommit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onRenameCommit();
            else if (event.key === 'Escape') onRenameCancel();
          }}
        />
      ) : (
        <span
          className="v-track-head__name"
          data-v={`track-name-${track.id}`}
          title={`${track.name}（双击重命名）`}
          onDoubleClick={onRenameStart}
        >
          {track.name}
        </span>
      )}

      {/* 视频/字幕轨 = 显示/隐藏；音频轨 = 静音/取消静音 */}
      <button
        type="button"
        className="v-track-head__btn"
        data-v={`${isAudio ? 'mute' : 'hide'}-${track.id}`}
        aria-pressed={isAudio ? track.muted : track.hidden}
        aria-label={`${track.name} ${isAudio ? (track.muted ? '取消静音' : '静音') : track.hidden ? '显示' : '隐藏'}`}
        title={isAudio ? (track.muted ? '取消静音' : '静音轨道') : track.hidden ? '显示轨道' : '隐藏轨道（不参与渲染与导出）'}
        onClick={(event) => {
          event.stopPropagation();
          onToggleFlag(isAudio ? 'muted' : 'hidden', isAudio ? !track.muted : !track.hidden);
        }}
      >
        {isAudio ? <SpeakerIcon off={track.muted} /> : <EyeIcon off={track.hidden} />}
      </button>

      <button
        type="button"
        className="v-track-head__btn"
        data-v={`lock-${track.id}`}
        aria-pressed={track.locked}
        aria-label={`${track.name} ${track.locked ? '解锁' : '锁定'}`}
        title={track.locked ? '解锁轨道' : '锁定轨道（锁定后不能改上面的片段）'}
        onClick={(event) => {
          event.stopPropagation();
          onToggleFlag('locked', !track.locked);
        }}
      >
        <LockIcon open={!track.locked} />
      </button>

      <button
        type="button"
        className="v-track-head__more"
        data-v={`track-more-${track.id}`}
        aria-label={`${track.name} 更多操作`}
        title="更多操作"
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          onOpenMenu({ clientX: rect.left, clientY: rect.bottom + 2 });
        }}
      >
        <MoreIcon />
      </button>

      {/**
        * 高度拖拽热区：轨道头**下边缘 5px**。
        *
        * 3px 太窄（规范写 3px，但实测 1080p 上鼠标很难精确压住 3 个物理像素，
        * 用户会以为"高度不能调"），放到 5px 并在 hover 时变主色，是可发现性与
        * 误触之间的折中——它只占下边缘，不影响上面任何按钮。
        */}
      <span
        className="v-track-head__resize"
        data-v={`track-resize-${track.id}`}
        role="separator"
        aria-label={`${track.name} 高度（拖动调整）`}
        aria-orientation="horizontal"
        title="拖动调整轨道高度"
        onPointerDown={onResizeStart}
        onDoubleClick={() => onToggleFlag('locked', track.locked)}
      />
    </div>
  );
}
