/**
 * 宿主命令通道（R-050）：把 postMessage 的四条命令落成真实动作。
 *
 * ## 三条硬约束
 *
 * 1. **只做四件事**：`getProject` / `setProject` / `importAsset` / `export`。
 *    宿主能读工程、换工程、送素材、出片就够了；再细的操作走 UI 或 AI 白名单，
 *    否则宿主脚本会绕过撤销栈直接改 doc（M4 那条教训的同一类问题）。
 * 2. **入站工程必须归一化**（`projectInput.ts`）：宿主传的很可能是旧版本 JSON，
 *    直接 `replaceDoc` 会让渲染层读到 `undefined` 而崩。归一化失败就**整份拒绝**。
 * 3. **导出走同一条编码路径**：直接用 `exportProject`，不另开"宿主专用导出"，
 *    否则预览 / UI 导出 / 宿主导出会出现三套颜色与时长口径。
 */
import type {
  HostCommand,
  HostCommandResult,
  HostEvent,
  Project,
  Result,
} from '../core/types';
import { fail, makeError, ok } from '../core/types';
import { computeProjectDerived } from '../core/store';
import { exportProject } from '../export/exporter';
import type { ExportFormat } from '../export/exporter';
import { dataUrlToBlob, guessMime, normalizeProjectInput } from './projectInput';

export { HOST_SCHEMA_VERSION, normalizeProjectInput } from './projectInput';

export interface HostCommandContext {
  reply: (result: HostCommandResult) => void;
  postEvent: (event: HostEvent) => void;
  getDoc: () => Project;
  replaceDoc: (project: Project) => void;
  /** 与 `?src=` 完全相同的导入路径（探针 → 参数跟随 → 上 V1 → 缩略图落 IDB）。 */
  importFile: (file: File, assetId?: string) => Promise<Result<string>>;
}

function int(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

/* ---------------- 素材载荷 ---------------- */

async function fileFromCommand(cmd: {
  url?: string;
  dataUrl?: string;
  buffer?: ArrayBuffer;
  name?: string;
}): Promise<Result<File>> {
  const name = typeof cmd.name === 'string' && cmd.name !== '' ? cmd.name : 'asset.mp4';

  // 优先级：字节 > dataUrl > url。字节最可靠（不受 CORS 与 base64 体积影响）
  if (cmd.buffer instanceof ArrayBuffer) {
    return ok(new File([cmd.buffer], name, { type: guessMime(name) }));
  }
  if (typeof cmd.dataUrl === 'string' && cmd.dataUrl !== '') {
    const blob = dataUrlToBlob(cmd.dataUrl);
    if (blob === null) {
      return fail(makeError('E_INVALID_PAYLOAD', 'dataUrl 解析失败', 'importAsset'));
    }
    return ok(new File([blob], name, { type: blob.type || guessMime(name) }));
  }
  if (typeof cmd.url === 'string' && cmd.url !== '') {
    try {
      const response = await fetch(cmd.url);
      if (!response.ok) {
        return fail(
          makeError('E_ASSET_OFFLINE', '素材拉取失败', `HTTP ${response.status} ${cmd.url}`),
        );
      }
      const blob = await response.blob();
      const fallbackName = decodeURIComponent(cmd.url.split('/').pop() ?? '') || 'asset.mp4';
      const finalName = typeof cmd.name === 'string' && cmd.name !== '' ? cmd.name : fallbackName;
      return ok(new File([blob], finalName, { type: blob.type || guessMime(finalName) }));
    } catch (error) {
      return fail(
        makeError(
          'E_ASSET_OFFLINE',
          '素材拉取失败（跨域或网络）',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
  return fail(
    makeError('E_INVALID_PAYLOAD', 'importAsset 需要 buffer / dataUrl / url 之一', 'importAsset'),
  );
}

/* ---------------- 导出 ---------------- */

/** `audio` 是早期协议里的旧名（等价 wav）；`webm` 单独返回，用于给出可读拒绝。 */
function normalizeExportFormat(format: unknown): ExportFormat | 'webm' | null {
  if (format === 'mp4' || format === 'gif' || format === 'wav' || format === 'png') return format;
  if (format === 'audio') return 'wav';
  if (format === 'webm') return 'webm';
  return null;
}

/* ---------------- 命令分发 ---------------- */

/**
 * 执行一条宿主命令，并通过 `ctx.reply` 回**恰好一条**结果。
 *
 * 永远不抛：任何异常都转成 `{ok:false, code:'E_INTERNAL'}`，
 * 否则宿主会一直等一个不会来的响应（比报错更难查）。
 */
export async function runHostCommand(
  cmd: HostCommand,
  ctx: HostCommandContext,
): Promise<void> {
  try {
    switch (cmd.type) {
      case 'getProject': {
        ctx.reply({ ok: true, project: ctx.getDoc() });
        return;
      }

      case 'setProject': {
        const project = normalizeProjectInput(cmd.project);
        if (project === null) {
          ctx.reply({
            ok: false,
            code: 'E_INVALID_PROJECT',
            message:
              '工程结构不合法：需要非空 tracks、正整数 width/height/fpsMilli，以及合法的片段帧号',
          });
          return;
        }
        ctx.replaceDoc(project);
        ctx.reply({ ok: true, schemaVersion: project.schemaVersion });
        return;
      }

      case 'importAsset': {
        const file = await fileFromCommand(cmd);
        if (!file.ok) {
          ctx.reply({ ok: false, code: file.error.code, message: file.error.message });
          return;
        }
        const imported = await ctx.importFile(file.value, cmd.assetId);
        if (!imported.ok) {
          ctx.reply({ ok: false, code: imported.error.code, message: imported.error.message });
          return;
        }
        ctx.reply({ ok: true, assetId: imported.value });
        return;
      }

      case 'export': {
        const format = normalizeExportFormat(cmd.format);
        if (format === 'webm') {
          // 明确拒绝，而不是"导成 mp4 再改扩展名"——后者会让宿主以为拿到了 webm
          ctx.reply({
            ok: false,
            code: 'E_UNSUPPORTED_FORMAT',
            message: '不提供 WebM 导出（浏览器编码器能力所限），请用 mp4 / gif / wav',
          });
          return;
        }
        if (format === null) {
          ctx.reply({
            ok: false,
            code: 'E_UNSUPPORTED_FORMAT',
            message: `不支持的导出格式：${String(cmd.format)}（可用 mp4 / gif / wav / png）`,
          });
          return;
        }

        const doc = ctx.getDoc();
        const durationFrames = computeProjectDerived(doc).durationFrames;
        const startFrame = Math.max(0, int(cmd.startFrame, 0));
        const endFrame = Math.max(0, int(cmd.endFrame, durationFrames));
        if (endFrame <= startFrame) {
          ctx.reply({
            ok: false,
            code: 'E_INVALID_RANGE',
            message: `导出区间不合法：${startFrame} → ${endFrame}（需要 end > start）`,
          });
          return;
        }

        // 进度节流：编码器逐帧回调，逐帧 postMessage 会把宿主淹没
        let lastRatio = -1;
        let lastStage = '';
        const result = await exportProject({
          doc,
          format,
          startFrame,
          endFrame,
          ...(cmd.gifWidth === undefined ? {} : { gifWidth: Math.max(64, int(cmd.gifWidth, 480)) }),
          ...(cmd.gifFps === undefined ? {} : { gifFps: Math.max(1, int(cmd.gifFps, 15)) }),
          onProgress: (progress) => {
            const stageChanged = progress.stage !== lastStage;
            if (!stageChanged && progress.ratio - lastRatio < 0.05) return;
            lastRatio = progress.ratio;
            lastStage = progress.stage;
            ctx.postEvent({ type: 'exportProgress', ratio: progress.ratio, stage: progress.stage });
          },
        });
        if (!result.ok) {
          ctx.reply({ ok: false, code: result.error.code, message: result.error.message });
          return;
        }

        const buffer = await result.value.blob.arrayBuffer();
        ctx.postEvent({
          type: 'exportDone',
          filename: result.value.filename,
          size: result.value.blob.size,
        });
        ctx.reply({
          ok: true,
          filename: result.value.filename,
          mime: result.value.blob.type,
          size: result.value.blob.size,
          buffer,
        });
        return;
      }

      default: {
        const type = (cmd as { type?: unknown }).type;
        ctx.reply({
          ok: false,
          code: 'E_UNSUPPORTED_COMMAND',
          message: `未知命令：${String(type)}（可用 getProject / setProject / importAsset / export）`,
        });
      }
    }
  } catch (error) {
    ctx.reply({
      ok: false,
      code: 'E_INTERNAL',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
