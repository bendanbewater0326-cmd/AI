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
import { previewRecompute } from '../core/operations';

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
  /** 导出文件名（默认工程名；后缀从产物提取自动补全）。 */
  const [fileName, setFileName] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<ExportProgress>({ ratio: 0, stage: '' });
  const [message, setMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    setPhase('idle');
    setProgress({ ratio: 0, stage: '' });
    setMessage(null);
    setFileName(store.getDoc().name);
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

  /**
   * 出片规格预设（P1，2026-10-25）：一键设置工程参数（导出跟随工程参数，码率按分辨率自动算——
   * 复用 applyProjectParams/previewRecompute 全套链路，零导出层改动）。
   * 「自定义」不是按钮：手动在工程参数里改过即自动处于该状态。
   */
  const EXPORT_PRESETS = [
    { key: 'fhd', label: '1080P 高清', width: 1920, height: 1080 },
    { key: 'hd', label: '720P 流畅', width: 1280, height: 720 },
    { key: 'vertical', label: '竖屏短视频', width: 1080, height: 1920 },
  ] as const;
  const FPS_MILLI_PRESET = 30000;
  const activePreset = EXPORT_PRESETS.find(
    (preset) =>
      doc.width === preset.width && doc.height === preset.height && doc.fpsMilli === FPS_MILLI_PRESET,
  );
  const isCustom = activePreset === undefined;

  function applyPreset(preset: (typeof EXPORT_PRESETS)[number]): void {
    const current = store.getDoc();
    const next = { width: preset.width, height: preset.height, fpsMilli: FPS_MILLI_PRESET };
    const clipCount = current.tracks.reduce((sum, track) => sum + track.clips.length, 0);
    if (clipCount > 0 && (current.width !== next.width || current.height !== next.height || current.fpsMilli !== next.fpsMilli)) {
      // 与顶栏工程参数同一份影响面口径（R-015：禁止只说"将重新换算"）
      const preview = previewRecompute(current, next);
      const okToApply = window.confirm(
        `切换到「${preset.label}」会更新工程参数：${preview.affectedClipCount} 个片段的位置/时长会重新换算` +
          `（最大位移 ${preview.maxShiftFrames} 帧）。
预览画面会随之变化。继续吗？`,
      );
      if (!okToApply) return;
    }
    store.applyProjectParams(next);
  }

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
    // 文件名编辑（P1）：用户输入覆盖默认工程名；后缀从产物提取（PNG 序列实际是 .zip——不自己映射）
    const trimmed = fileName.trim().replace(/[\/:*?"<>|]+/g, '_');
    const ext = (/[.][a-z0-9]+$/i.exec(result.value.filename))?.[0] ?? '.mp4';
    const finalOutput = { ...result.value, filename: `${trimmed === '' ? current.name : trimmed}${ext}` };
    downloadExport(finalOutput);
    const sizeMb = finalOutput.blob.size / (1024 * 1024);
    setPhase('done');
    setProgress({ ratio: 1, stage: '完成' });
    setMessage(
      `${finalOutput.filename} · ${finalOutput.frames} 帧 · ${sizeMb.toFixed(1)}MB${
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

      {/*
        出片规格预设（P1）：导出分辨率/帧率跟随工程参数——预设即快捷设置工程参数；
        手动改参数后自动处于「自定义」（点它引导去工程参数，不另开第二套参数面板）。
      */}
      {format === 'mp4' ? (
        <div className="v-export__presets" role="group" aria-label="出片规格" data-v="export-presets">
          {EXPORT_PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              className="v-export__preset"
              data-v={`export-preset-${preset.key}`}
              data-active={activePreset?.key === preset.key}
              aria-pressed={activePreset?.key === preset.key}
              disabled={phase === 'running'}
              title={`${preset.label}（${preset.width}×${preset.height} · 30fps）`}
              onClick={() => applyPreset(preset)}
            >
              {preset.label}
            </button>
          ))}
          <button
            type="button"
            className="v-export__preset"
            data-v="export-preset-custom"
            data-active={isCustom}
            aria-pressed={isCustom}
            disabled={phase === 'running'}
            title="手动在「工程 → 工程参数」里调整分辨率与帧率"
            onClick={() => setMessage('分辨率与帧率在顶部「工程 → 工程参数」中调整，导出会跟随当前工程参数')}
          >
            自定义
          </button>
        </div>
      ) : null}

      {/* 文件名（默认工程名，后缀按导出类型自动补全） */}
      <div className="v-export__namerow">
        <label className="v-export__namelabel" htmlFor="v-export-filename">文件名</label>
        <input
          id="v-export-filename"
          className="v-export__nameinput"
          data-v="export-filename"
          type="text"
          value={fileName}
          maxLength={80}
          disabled={phase === 'running'}
          aria-label="导出文件名"
          onChange={(event) => setFileName(event.target.value)}
        />
      </div>

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
