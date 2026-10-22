/**
 * 导出对话框（M3）：格式可选 + 进度 + 取消 + 可读失败原因。
 *
 * 设计约束（PRD §7.2）：不弹二级菜单、不堆参数。默认值即"能直接导"的那一套：
 * 整个时间线、跟随工程分辨率与帧率、MP4/H.264。
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { store, useDerived, useDoc } from '../core/store';
import { framesPerSecond } from '../core/timebase';
import { downloadExport, exportProject } from '../export/exporter';
import type { ExportFormat, ExportProgress } from '../export/exporter';
import { formatFps, formatTimecode } from './TopBar';

interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
}

type Phase = 'idle' | 'running' | 'done' | 'error';

const FORMAT_LABEL: Record<ExportFormat, string> = {
  mp4: 'MP4 视频',
  gif: 'GIF 动图',
  wav: 'WAV 音频',
  png: 'PNG 序列',
};

const FORMAT_HINT: Record<ExportFormat, string> = {
  mp4: 'H.264 + AAC，带声音，适合直接发布',
  gif: '无声音，适合贴图/表情，可调尺寸与帧率',
  wav: '只导声音，48kHz 立体声',
  png: '透明通道：RGBA 序列 + ZIP（不可直接播放）',
};

export function ExportDialog({ open, onClose }: ExportDialogProps): ReactElement | null {
  const doc = useDoc((value) => value);
  const derived = useDerived();
  const [format, setFormat] = useState<ExportFormat>('mp4');
  const [gifWidth, setGifWidth] = useState(480);
  const [gifFps, setGifFps] = useState(15);
  const [useRange, setUseRange] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<ExportProgress>({ ratio: 0, stage: '' });
  const [message, setMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    setPhase('idle');
    setProgress({ ratio: 0, stage: '' });
    setMessage(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && phase !== 'running') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, phase, onClose]);

  if (!open) return null;

  const ephemeral = store.getEphemeral();
  const markIn = ephemeral.markIn;
  const markOut = ephemeral.markOut;
  const rangeReady = markIn !== null && markOut !== null && markOut > markIn;
  const rangeStart = useRange && rangeReady ? markIn : 0;
  const rangeEnd = useRange && rangeReady ? markOut : derived.durationFrames;
  const totalFrames = Math.max(0, rangeEnd - rangeStart);
  // PNG 序列是内存里攒齐再打包的：超过上限直接拦住，别让用户等到 90% 才崩
  const PNG_FRAME_LIMIT = 600;
  const pngTooLarge = format === 'png' && totalFrames > PNG_FRAME_LIMIT;
  const canExport = totalFrames > 0 && phase !== 'running' && !pngTooLarge;

  async function run(): Promise<void> {
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('running');
    setMessage(null);
    setProgress({ ratio: 0, stage: '准备' });
    const current = store.getDoc();
    const result = await exportProject({
      doc: current,
      format,
      startFrame: rangeStart,
      endFrame: rangeEnd,
      ...(format === 'gif' ? { gifWidth, gifFps } : {}),
      signal: controller.signal,
      onProgress: (next) => setProgress(next),
    });
    abortRef.current = null;
    if (!result.ok) {
      setPhase('error');
      setMessage(result.error.message);
      return;
    }
    downloadExport(result.value);
    const sizeMb = result.value.blob.size / (1024 * 1024);
    setPhase('done');
    setProgress({ ratio: 1, stage: '完成' });
    setMessage(
      `${result.value.filename} · ${result.value.frames} 帧 · ${sizeMb.toFixed(1)}MB${
        result.value.hasAudio ? '' : ' · 无音轨'
      }`,
    );
  }

  return (
    <div className="v-dialog v-dialog--export" role="dialog" aria-modal="true" aria-label="导出" data-v="export-dialog">
      <div className="v-dialog__title">导出</div>

      <div className="v-export__formats" role="radiogroup" aria-label="导出格式">
        {(Object.keys(FORMAT_LABEL) as ExportFormat[]).map((key) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={format === key}
            data-v={`export-format-${key}`}
            className={`v-export__format${format === key ? ' v-export__format--on' : ''}`}
            onClick={() => setFormat(key)}
            disabled={phase === 'running'}
          >
            <strong>{FORMAT_LABEL[key]}</strong>
            <span>{FORMAT_HINT[key]}</span>
          </button>
        ))}
      </div>

      {format === 'gif' ? (
        <div className="v-export__row">
          <label className="v-dialog__field">
            <span>宽度</span>
            <select
              data-v="export-gif-width"
              value={gifWidth}
              disabled={phase === 'running'}
              onChange={(event) => setGifWidth(Number(event.target.value))}
            >
              <option value={480}>480</option>
              <option value={720}>720</option>
              <option value={1080}>1080</option>
            </select>
          </label>
          <label className="v-dialog__field">
            <span>帧率</span>
            <select
              data-v="export-gif-fps"
              value={gifFps}
              disabled={phase === 'running'}
              onChange={(event) => setGifFps(Number(event.target.value))}
            >
              <option value={10}>10</option>
              <option value={15}>15</option>
              <option value={24}>24</option>
            </select>
          </label>
        </div>
      ) : null}

      {format === 'png' ? (
        <div
          className={`v-dialog__detail${pngTooLarge ? '' : ' v-dialog__detail--dim'}`}
          data-v="export-png-hint"
        >
          {pngTooLarge
            ? `PNG 序列一次最多 ${PNG_FRAME_LIMIT} 帧（当前 ${totalFrames} 帧）——请先用 I / O 标记一段更短的区间`
            : `透明通道：${totalFrames} 个 RGBA PNG + frames.json 打包成 ZIP。不可直接播放；空白处 alpha=0`}
        </div>
      ) : null}

      <label className="v-export__range" data-v="export-range-label">
        <input
          type="checkbox"
          data-v="export-range"
          checked={useRange && rangeReady}
          disabled={!rangeReady || phase === 'running'}
          onChange={(event) => setUseRange(event.target.checked)}
        />
        <span>
          {rangeReady
            ? `仅导出标记区间（${formatTimecode(markIn, doc.fpsMilli)} – ${formatTimecode(markOut, doc.fpsMilli)}）`
            : '仅导出标记区间（先在时间线按 I / O 标记）'}
        </span>
      </label>

      <div className="v-dialog__detail v-dialog__detail--dim" data-v="export-summary">
        {`${doc.width}×${doc.height} · ${formatFps(doc.fpsMilli)}fps · 时长 ${(
          totalFrames / Math.max(1, framesPerSecond(doc.fpsMilli))
        ).toFixed(2)}s · ${totalFrames} 帧`}
      </div>

      {phase === 'running' ? (
        <div className="v-export__progress" data-v="export-progress">
          <div className="v-export__bar">
            <span style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
          </div>
          <div className="v-export__stage">
            {progress.stage} · {Math.round(progress.ratio * 100)}%
          </div>
        </div>
      ) : null}

      {message !== null ? (
        <div className={`v-export__message${phase === 'error' ? ' v-export__message--error' : ''}`} data-v="export-message">
          {message}
        </div>
      ) : null}

      <div className="v-dialog__actions">
        {phase === 'running' ? (
          <button
            type="button"
            data-v="export-cancel"
            onClick={() => {
              abortRef.current?.abort();
              setPhase('idle');
              setMessage('已取消');
            }}
          >
            取消
          </button>
        ) : (
          <button type="button" onClick={onClose}>
            关闭
          </button>
        )}
        <button
          type="button"
          className="v-dialog__primary"
          data-v="export-start"
          disabled={!canExport}
          onClick={() => void run()}
        >
          {phase === 'done' ? '再导一次' : '开始导出'}
        </button>
      </div>
    </div>
  );
}
