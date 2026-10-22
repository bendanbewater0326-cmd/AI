/**
 * 素材重链（relink）：把一个**离线素材**重新指向一个真实文件。
 *
 * ## 为什么单独一个模块
 *
 * 重链有四个必须一起做完的步骤，少任何一步都会出现"看起来好了、其实没好"：
 *
 * 1. **探测新文件**（时长/分辨率/编码）→ 否则片段的越界判断用的是旧值；
 * 2. **写回同一个 `assetId`** → 所有片段的 `assetId` 都指向它，换 id 等于
 *    "工程里多了一个素材、旧片段还指着离线那份"；
 * 3. **重建解码缓存**（`registerPreviewSource` 内部先 unregister 再 register）
 *    → 不清的话，切源后取帧会命中**上一个源**留下的缓存帧，表现为
 *    "重链了但还是黑屏/还是旧画面"，而且永远不会自愈；
 * 4. **立刻重绘 + 重新授权持久化** → 不重绘要等下次播放才看到；不写 handle
 *    下次刷新又离线（这是"刷新必然离线"的一半原因）。
 *
 * 之前这些步骤散在 `ui/AssetPanel` 的 `relink()` 里，只做了 1 和 2，
 * 于是用户看到的正是"点了重新链接，提示没了，画面还是黑的"。
 *
 * ## 匹配打分为什么这么算
 *
 * 重链有两个场景，判据强度完全不同：
 * - **手动单选**：用户明确指了一个文件。只要探测成功就链（差异只给提示），
 *   否则"我选对了文件它还不让链"会让人抓狂；
 * - **批量/自动**：必须在无人确认的情况下决定，所以要求"指纹一致"或
 *   "名字 + 大小 + 时长"三项全对（>= `AUTO_LINK_SCORE`）。
 */
import type { Asset, Result } from '../core/types';
import { makeError } from '../core/types';
import { store } from '../core/store';
import type { FileHandlePort } from '../persist/autosave';
import { putHandle, putThumbnail } from '../persist/autosave';
import { hashFileHead } from './fileHash';
import { probeMediaFile } from './importPipeline';
import { repaintPreview } from './previewSource';

/** 自动重链的分数门槛（用户要求"匹配度超过 95% 自动静默重链"）。 */
export const AUTO_LINK_SCORE = 95;

export interface CandidateScore {
  /** 0–100。 */
  score: number;
  /** 是否**指纹一致**（唯一可以"完全不看别的条件"就链的情况）。 */
  hashMatched: boolean;
  /** 给人看的原因（批量重链的报告里会逐条列出）。 */
  reasons: string[];
}

/** 从 `hashKey`（`name|size|lastModified`）里取大小。取不到返回 null。 */
export function sizeFromHashKey(hashKey: string): number | null {
  const parts = hashKey.split('|');
  if (parts.length < 2) return null;
  const size = Number(parts[1]);
  return Number.isFinite(size) && size > 0 ? size : null;
}

/**
 * 给"某个离线素材 + 某个候选文件"打分。
 *
 * 权重：名字 40 / 大小 30 / 时长 30，指纹一致直接 100。
 * 为什么名字只给 40 而不是 60：用户重命名文件（`IMG_0001.mp4` → `片头.mp4`）
 * 是重链的**主要场景之一**，名字权重太高会让这种情况永远匹配不上。
 */
export function scoreCandidate(
  asset: Asset,
  file: { name: string; size: number },
  candidate: { durationSec?: number; contentHash?: string | null },
): CandidateScore {
  const reasons: string[] = [];
  const hashMatched =
    typeof asset.contentHash === 'string' &&
    typeof candidate.contentHash === 'string' &&
    asset.contentHash !== '' &&
    asset.contentHash === candidate.contentHash;

  if (hashMatched) {
    return { score: 100, hashMatched: true, reasons: ['内容指纹一致'] };
  }

  let score = 0;
  if (asset.name === file.name) {
    score += 40;
    reasons.push('文件名相同');
  } else if (baseName(asset.name) === baseName(file.name)) {
    // 扩展名不同但主名相同（转了封装格式）：给一半分
    score += 20;
    reasons.push('主文件名相同（扩展名不同）');
  }

  const expectedSize = sizeFromHashKey(asset.hashKey);
  if (expectedSize !== null) {
    const diff = Math.abs(file.size - expectedSize);
    if (diff === 0) {
      score += 30;
      reasons.push('文件大小完全一致');
    } else if (diff <= Math.max(1, expectedSize * 0.01)) {
      score += 20;
      reasons.push('文件大小相差 <1%');
    }
  }

  if (
    typeof candidate.durationSec === 'number' &&
    Number.isFinite(candidate.durationSec) &&
    asset.durationSec > 0
  ) {
    const diff = Math.abs(candidate.durationSec - asset.durationSec);
    if (diff <= 1 / 30) {
      score += 30;
      reasons.push('时长一致');
    } else if (diff <= Math.max(0.5, asset.durationSec * 0.01)) {
      score += 20;
      reasons.push('时长相差 <1%');
    }
  }

  return { score: Math.min(100, score), hashMatched, reasons };
}

/** 去掉扩展名（`a/b.mp4` → `b`）。 */
function baseName(name: string): string {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const base = slash >= 0 ? name.slice(slash + 1) : name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

export interface RelinkOutcome {
  assetId: string;
  /** 重链后的素材（已写回 store）。 */
  asset: Asset;
  thumbnailDataUrl: string | null;
  /** 非阻断的提示（文件名不同、时长变了…）。 */
  warnings: string[];
}

export interface RelinkOptions {
  assetId: string;
  file: File;
  /**
   * 新句柄。
   *
   * **`undefined` 与 `null` 语义不同**（这一条很关键）：
   * - `undefined`：不改变原来的句柄记录 —— 从**缓存池**恢复时用这个，
   *   因为缓存副本只是"多了一条保命路径"，原句柄没坏就该留着（下次还能走句柄层）；
   * - `null`：显式清掉句柄（用户手动选的文件走 `<input>`，拿不到句柄）。
   */
  handle?: FileHandlePort | null;
  /** 源路径（Electron 宿主 / 文件夹批量重链能提供）。 */
  sourcePath?: string | null;
  /**
   * 严格模式：要求 `score >= AUTO_LINK_SCORE` 才允许链（批量/自动匹配用）。
   * 手动单选默认 **false** —— 用户明确选了文件，不该被"名字不一样"挡住。
   */
  strict?: boolean;
}

/**
 * 用指定文件重链一个素材。
 *
 * 成功后：片段属性**一个都不改**（入点/出点/特效/音量/位置全保留），
 * 只换"这个素材的字节从哪来"。这也是验收标准里的"数据一致性"。
 */
export async function relinkAssetFromFile(options: RelinkOptions): Promise<Result<RelinkOutcome>> {
  const doc = store.getDoc();
  const before = doc.assets.find((asset) => asset.id === options.assetId);
  if (before === undefined) {
    return { ok: false, error: makeError('E_ASSET_OFFLINE', '工程里找不到这个素材', options.assetId) };
  }

  const handle = options.handle;
  const probed = await probeMediaFile(
    options.file,
    handle ?? null,
    options.assetId,
    /**
     * 不传 `sourcePath` 时**保留工程里记的原路径**（不是拿缓存文件名覆盖）：
     * 从缓存恢复只是"多了一条保命路径"，原路径对后续"按路径直读/目录扫描"仍然有用。
     */
    options.sourcePath ?? before.sourcePath ?? options.file.name,
  );
  if (!probed.ok) return probed;

  const { asset, thumbnailDataUrl, thumbnailBlob } = probed.value;
  const warnings: string[] = [];

  // ---- 一致性检查（只提示，不阻断手动重链）----
  const score = scoreCandidate(before, options.file, {
    durationSec: asset.durationSec,
    contentHash: asset.contentHash ?? null,
  });
  if (options.strict === true && score.score < AUTO_LINK_SCORE) {
    return {
      ok: false,
      error: makeError(
        'E_ASSET_OFFLINE',
        '文件与素材不匹配，已跳过',
        `${before.name}：${score.reasons.join('、') || '没有任何匹配项'}`,
      ),
    };
  }
  if (before.name !== options.file.name) {
    warnings.push(`文件名不同（原 ${before.name}，新 ${options.file.name}）`);
  }
  if (before.durationSec > 0 && asset.durationSec > 0) {
    const diff = Math.abs(asset.durationSec - before.durationSec);
    if (diff > 1 / 30) {
      const short = asset.durationSec < before.durationSec;
      warnings.push(
        `时长变了（${before.durationSec.toFixed(2)}s → ${asset.durationSec.toFixed(2)}s）${
          short ? '：新素材更短，超出部分会显示黑屏' : ''
        }`,
      );
    }
  }

  /**
   * 写回 store：**只换源引用与探测字段**，片段一个都不碰。
   *
   * 注意 `sourceMode` / `handleRef` 必须一起更新：
   * 旧实现重链后固定写 `memory` + `handleRef: null`，于是"重链成功 → 刷新 → 又离线"，
   * 用户看到的就是"重链根本没用"。
   */
  /**
   * 写回 store：**只换源引用与探测字段**，片段一个都不碰。
   *
   * `sourceMode` / `handleRef` 必须一起更新：旧实现重链后固定写
   * `memory` + `handleRef: null`，于是"重链成功 → 刷新 → 又离线"，
   * 用户看到的就是"重链根本没用"。
   *
   * **不能走 `dispatch`**：重链不是剪辑操作，不该出现在撤销栈里
   * （用户按 Ctrl+Z 期待撤销的是"上一刀"，不是"把素材变回离线"）。
   */
  store.updateAsset(options.assetId, {
    ...asset,
    id: options.assetId,
    // `undefined` = 保持原记录（从缓存恢复时不该把还能用的句柄丢掉）
    handleRef: handle === undefined ? before.handleRef : handle === null ? null : options.assetId,
    sourceMode: handle === undefined ? before.sourceMode : handle === null ? 'memory' : 'fs',
    status: handle === undefined ? 'ok' : handle === null ? 'memory' : 'ok',
    thumbnailRef: thumbnailBlob === null ? null : options.assetId,
    /**
     * **缓存键必须继承**：它不在 `probeMediaFile` 的探测结果里，
     * 不显式带上就会"重链一次，缓存记录丢了" —— 下次刷新又只能靠外部文件。
     */
    ...(before.cacheKey === undefined || before.cacheKey === null ? {} : { cacheKey: before.cacheKey }),
    /**
     * 内容指纹同理：探测结果里虽然有（`probeMediaFile` 会算），
     * 但旧工程/缓存恢复时可能算不出来，保留旧值更稳。
     */
    ...(asset.contentHash === undefined || asset.contentHash === null
      ? before.contentHash === undefined || before.contentHash === null
        ? {}
        : { contentHash: before.contentHash }
      : { contentHash: asset.contentHash }),
  });

  // 解码缓存已由 `probeMediaFile` → `registerPreviewSource` 重建（先 unregister 再 register）
  if (thumbnailBlob !== null) await putThumbnail(options.assetId, thumbnailBlob);
  if (handle !== undefined && handle !== null) await putHandle(options.assetId, handle);

  // 立刻重绘：暂停状态下也要看到画面回来（不等播放循环）
  repaintPreview();

  return { ok: true, value: { assetId: options.assetId, asset, thumbnailDataUrl, warnings } };
}

export interface BatchRelinkReport {
  /** 自动链成功的素材 id。 */
  linked: string[];
  /** 需要用户确认的候选（分数够但没到自动门槛）。 */
  pending: Array<{ assetId: string; assetName: string; candidate: string; score: number }>;
  /** 失败的（含原因）。 */
  failed: Array<{ assetId: string; assetName: string; reason: string }>;
}

/** 扫描到的候选文件（批量重链 / 自动扫描的输入）。 */
export interface RelinkCandidateFile {
  file: File;
  /** `webkitRelativePath` 或宿主给的绝对路径。 */
  path: string;
  /**
   * 该文件的句柄（能拿到就带上）。
   *
   * 为什么重要：批量重链如果只带 `File` 不带句柄，重链后会落 `memory` 模式 ——
   * 下次刷新又离线，用户会以为"批量重链没用"。从目录句柄扫出来的候选天然带句柄。
   */
  handle?: FileHandlePort | null;
}

/** 音视频扩展名（批量扫描时过滤；不做 MIME 判断——很多系统的 `.mkv` MIME 是空的）。 */
const MEDIA_EXTENSIONS = new Set([
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus',
]);

export function isMediaFileName(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return MEDIA_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * 批量重链：给一批离线素材 + 一批候选文件，尽量全部链上。
 *
 * 顺序很重要：**先算所有候选的指纹**（每个文件只读前 1MB），再逐个素材找最佳候选。
 * 反过来（对每个素材都去读一遍所有文件）会把 IO 放大成 O(n×m)，
 * 选一个文件夹 50 个文件 × 10 个离线素材就是 500 次读盘。
 */
export async function relinkFromFiles(
  offlineAssetIds: string[],
  files: RelinkCandidateFile[],
): Promise<BatchRelinkReport> {
  const report: BatchRelinkReport = { linked: [], pending: [], failed: [] };
  const doc = store.getDoc();
  const mediaFiles = files.filter((item) => isMediaFileName(item.file.name));

  // 候选指纹：并行但有上限（一次读 8 个，避免把磁盘打满）
  const hashed: Array<{ item: RelinkCandidateFile; contentHash: string | null }> = [];
  for (let index = 0; index < mediaFiles.length; index += 8) {
    const slice = mediaFiles.slice(index, index + 8);
    const results = await Promise.all(
      slice.map(async (item) => ({ item, contentHash: await hashFileHead(item.file).catch(() => null) })),
    );
    hashed.push(...results);
  }

  const used = new Set<number>();
  for (const assetId of offlineAssetIds) {
    const asset = doc.assets.find((item) => item.id === assetId);
    if (asset === undefined) continue;

    let best: { index: number; score: CandidateScore } | null = null;
    for (const [index, candidate] of hashed.entries()) {
      if (used.has(index)) continue;
      const score = scoreCandidate(
        asset,
        { name: candidate.item.file.name, size: candidate.item.file.size },
        // 时长要探测才有，这里先用"没有时长"打分（指纹 + 名字 + 大小已足够）
        { contentHash: candidate.contentHash },
      );
      if (best === null || score.score > best.score.score) best = { index, score };
      // 指纹一致就是最优，不必再比
      if (score.hashMatched) break;
    }

    if (best === null) {
      report.failed.push({ assetId, assetName: asset.name, reason: '候选文件夹里没有音视频文件' });
      continue;
    }
    const candidate = hashed[best.index];
    if (candidate === undefined) continue;

    if (best.score.score >= AUTO_LINK_SCORE) {
      const result = await relinkAssetFromFile({
        assetId,
        file: candidate.item.file,
        handle: candidate.item.handle ?? null,
        sourcePath: candidate.item.path,
        strict: false,
      });
      if (result.ok) {
        used.add(best.index);
        report.linked.push(assetId);
      } else {
        report.failed.push({
          assetId,
          assetName: asset.name,
          reason: result.error.message,
        });
      }
      continue;
    }

    if (best.score.score > 0) {
      report.pending.push({
        assetId,
        assetName: asset.name,
        candidate: candidate.item.file.name,
        score: best.score.score,
      });
    } else {
      report.failed.push({ assetId, assetName: asset.name, reason: '没有找到相似的文件' });
    }
  }
  return report;
}
