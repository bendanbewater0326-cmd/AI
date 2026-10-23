/**
 * 字幕面板与顶栏共用的三个动作：**导入 SRT / 导出 SRT / AI 生成字幕**。
 *
 * ## 为什么单独成文件
 *
 * 这三个动作原来写在 `TopBar.tsx` 里（导入/导出）和 `CommandBar.tsx` 里（AI 生成）。
 * 字幕面板也要提供同样的入口（用户明确要"空状态给快捷入口"），
 * 如果再写一遍就是本项目最忌讳的"同一条规则两个定义点"。
 *
 * 所以收敛到这里：**顶栏、命令栏、字幕面板三处都调这一份**。
 *
 * ## 每个动作都自己 pushError
 *
 * 调用方（三个 UI 入口）不需要各自判断失败原因 —— 统一在这里给可读中文错误。
 * 返回值只表达"成没成 + 条数"，UI 拿它做成功提示。
 */
import { store } from '../../core/store';
import { makeError } from '../../core/types';
import { getAIProvider } from '../../ai/registry';
import { transcribeTimeline } from '../../ai/transcribe';
import {
  buildSubtitleReplaceOps,
  extractSubtitles,
  parseSrt,
  serializeSrt,
} from '../../subtitle/srt';

/** 导入 SRT（整段替换，一个撤销步）。成功返回条数，失败返回 null（错误已推送）。 */
export async function importSrtFile(file: File): Promise<number | null> {
  let text = '';
  try {
    text = await file.text();
  } catch {
    store.pushError(makeError('E_INVALID_PROJECT', '读取字幕文件失败', file.name));
    return null;
  }
  const parsed = parseSrt(text);
  if (parsed.cues.length === 0) {
    store.pushError(
      makeError('E_INVALID_PROJECT', '没有解析出字幕', `跳过 ${parsed.skipped} 个无效块`),
    );
    return null;
  }
  // 落轨规则收敛在 `core/placement.textTrackFor`：字幕与手动添加的文字同一条**文字轨**
  // （2026-10-23 之前这里落的是"最上面的视频轨"，用户会以为"字幕没导进来"）
  const plan = buildSubtitleReplaceOps(parsed.cues, store.getDoc(), 'caption');
  // 重叠 cue 会被截短尾巴（字幕不能同时出现两条），条数要说出来
  const truncatedNote = plan.truncated > 0 ? `，${plan.truncated} 条重叠已截短` : '';
  store.dispatch(plan.ops, `导入字幕（${parsed.cues.length} 条${truncatedNote}）`);
  return parsed.cues.length;
}

/** File System Access 的最小类型（TS 的 lib.dom 版本差异大，自己声明更稳）。 */
interface SaveFilePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<{
    createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }>;
    name: string;
  }>;
}

export interface ExportResult {
  count: number;
  /** 用户选的保存位置（走 `showSaveFilePicker` 时才有；走下载兜底时为 null）。 */
  fileName: string | null;
  /** 用户主动取消了保存对话框（**不是错误**，不提示）。 */
  cancelled: boolean;
}

/**
 * 导出 SRT。
 *
 * **优先让用户选保存路径**（File System Access 的 `showSaveFilePicker`）；
 * 浏览器不支持或被策略拦时，退回 `<a download>`（落到默认下载目录）。
 *
 * 取消对话框**不算失败**（用户就是不想导了），返回 `cancelled: true`，
 * 调用方据此不弹任何提示 —— 把"取消"报成错误是很常见的体验毛病。
 */
export async function exportSrt(): Promise<ExportResult | null> {
  const doc = store.getDoc();
  const cues = extractSubtitles(doc);
  if (cues.length === 0) {
    store.pushError(makeError('E_INVALID_PROJECT', '工程里还没有字幕片段'));
    return null;
  }
  const baseName = doc.name.trim() || 'veditor';
  const content = serializeSrt(cues);

  const picker = (window as unknown as SaveFilePickerWindow).showSaveFilePicker;
  if (typeof picker === 'function') {
    try {
      const handle = await picker({
        suggestedName: `${baseName}.srt`,
        types: [{ description: 'SRT 字幕文件', accept: { 'text/plain': ['.srt'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      return { count: cues.length, fileName: handle.name, cancelled: false };
    } catch (error) {
      // 用户点了取消：不是错误
      if (error instanceof DOMException && error.name === 'AbortError') {
        return { count: cues.length, fileName: null, cancelled: true };
      }
      // 其它失败（权限/策略）：静默降级到下载，不打断用户
    }
  }

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${baseName}.srt`;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { count: cues.length, fileName: `${baseName}.srt`, cancelled: false };
}

/** 是否有可用的语音识别通道（决定「AI 生成字幕」按钮是否可用）。 */
export function hasTranscribeChannel(): boolean {
  return getAIProvider().transcribe !== undefined;
}

/**
 * AI 生成字幕：抽音频 → 宿主转写 → 整段替换字幕轨（一个撤销步）。
 *
 * **没有通道时直接给可读拒绝**，不走模型那条路：
 * 模型拿不到音频，硬走只会编出没有时间戳的文本（`transcribe.ts` 文件头有完整说明）。
 *
 * @param onStage 阶段回调（"抽取音频…" / "识别中…"），供命令栏显示进度；面板可忽略。
 * @returns 生成条数；失败返回 null（错误已推送）。
 */
export async function generateCaptions(
  language: string,
  onStage?: (stage: string) => void,
): Promise<{ count: number; dropped: number; replaced: number } | null> {
  const provider = getAIProvider();
  if (provider.transcribe === undefined) {
    store.pushError(
      makeError(
        'E_INVALID_PROJECT',
        `当前客户端未提供语音识别通道，无法自动生成字幕（${provider.label}）`,
        '可以让宿主注入 transcribe()，或先用外部工具生成 SRT 再导入',
      ),
    );
    return null;
  }
  onStage?.('抽取音频');
  const outcome = await transcribeTimeline({
    doc: store.getDoc(),
    transcribe: provider.transcribe.bind(provider),
    language,
    onStage: (stage) => onStage?.(stage),
  });
  if (!outcome.ok) {
    store.pushError(outcome.error);
    return null;
  }
  const { cues, ops, dropped, replaced, durationSec } = outcome.value;
  const summary = `生成字幕（${cues.length} 条${dropped > 0 ? `，丢弃 ${dropped} 条坏片段` : ''}${
    replaced > 0 ? `，替换旧字幕 ${replaced} 条` : ''
  }）`;
  store.dispatch(ops, summary, 'ai');
  void durationSec;
  return { count: cues.length, dropped, replaced };
}
