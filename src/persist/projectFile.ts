/**
 * 工程文件迁出（R-054）：把整份工程导出成**一个文件**，换个浏览器导入后完整还原。
 *
 * ## 为什么只带元数据、不带素材字节
 *
 * 一个 4K 工程带上素材是几个 GB，浏览器里既下载不动也读不进内存；而 PRD 的要求是
 * "**素材待重连**"——工程（轨道/片段/参数/关键帧/转场/文字）必须一字不差，
 * 素材按 `assetId` 重新绑定即可（`importAsset({ assetId })` 就是为此做的）。
 *
 * ## 为什么不用 ZIP 包
 *
 * 单文件 JSON 可以直接 diff、可以人工查看、可以贴进 issue；ZIP 只是多一层壳，
 * 反而让"这份工程到底存了什么"变得不可见。扩展名用 `.vedproj` 只是为了让系统别当成普通 txt。
 *
 * ## 版本策略
 *
 * `version` 是**文件格式**版本，与 `schemaVersion`（工程结构版本）分开：
 * 前者管"这个信封怎么读"，后者管"里面的 clip 字段怎么补"。读文件时两个都校验。
 */
import type { Project, Result } from '../core/types';
import { fail, makeError } from '../core/types';
import { normalizeProjectInput } from '../host/projectInput';

export const PROJECT_FILE_FORMAT = 'veditor-project';
export const PROJECT_FILE_VERSION = 1;
export const PROJECT_FILE_EXT = 'vedproj';
/** 与 `HOST_SCHEMA_VERSION` 对齐：超过它的文件不认（宁可拒绝，也不要读出错工程）。 */
export const PROJECT_FILE_SCHEMA = 1;

export interface ProjectFileEnvelope {
  format: string;
  version: number;
  /** 工程结构版本（与信封版本分开）。 */
  schemaVersion: number;
  exportedAt: number;
  app: 'veditor';
  /** 完整工程（含素材元数据）。 */
  project: Project;
  /** 素材清单：给人看、给重连用（`importAsset({ assetId })` 按 id 绑回）。 */
  assets: Array<{
    id: string;
    name: string;
    kind: string;
    width: number;
    height: number;
    fpsMilli: number;
    durationFrames: number | null;
    hasAudio: boolean;
    hashKey: string;
    /** 重链匹配用（可选：旧工程没有）。 */
    sourcePath?: string | null;
    contentHash?: string | null;
  }>;
}

/** 工程 → 文件文本（缩进 2 空格：要能 diff、能人读）。 */
export function serializeProjectFile(doc: Project, now: number = Date.now()): string {
  const envelope: ProjectFileEnvelope = {
    format: PROJECT_FILE_FORMAT,
    version: PROJECT_FILE_VERSION,
    schemaVersion: doc.schemaVersion,
    exportedAt: now,
    app: 'veditor',
    project: doc,
    assets: doc.assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      width: asset.width,
      height: asset.height,
      fpsMilli: asset.fpsMilli,
      durationFrames: asset.durationFrames,
      hasAudio: asset.hasAudio,
      hashKey: asset.hashKey,
      // 重链匹配的依据：路径用于"原文件同级目录"扫描，指纹用于精确匹配
      ...(asset.sourcePath === null || asset.sourcePath === undefined ? {} : { sourcePath: asset.sourcePath }),
      ...(asset.contentHash === null || asset.contentHash === undefined ? {} : { contentHash: asset.contentHash }),
    })),
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

/** 工程文件名（去掉路径非法字符，扩展名固定）。 */
export function projectFileName(doc: Project): string {
  const base = doc.name.trim().replace(/[\\/:*?"<>|]+/g, '_') || 'veditor';
  return `${base}.${PROJECT_FILE_EXT}`;
}

/**
 * 文件文本 → 工程。
 *
 * 失败一律给**可读原因**（"不是工程文件" / "版本过新" / "结构不合法"），
 * 因为用户拿到的可能是一个同名但内容不对的文件，报"解析失败"帮不上忙。
 */
export function parseProjectFile(text: string): Result<Project> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail(
      makeError('E_INVALID_PROJECT', '不是有效的工程文件（JSON 解析失败）', '可能选错了文件'),
    );
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail(makeError('E_INVALID_PROJECT', '不是有效的工程文件', '顶层不是对象'));
  }
  const envelope = raw as Partial<ProjectFileEnvelope>;
  if (envelope.format !== PROJECT_FILE_FORMAT) {
    return fail(
      makeError('E_INVALID_PROJECT', '不是 veditor 工程文件', `format=${String(envelope.format)}`),
    );
  }
  const version = typeof envelope.version === 'number' ? envelope.version : 0;
  if (version > PROJECT_FILE_VERSION) {
    return fail(
      makeError(
        'E_INVALID_PROJECT',
        `工程文件版本过新（v${version}），当前编辑器只支持到 v${PROJECT_FILE_VERSION}`,
        '请升级编辑器后再打开',
      ),
    );
  }

  // 结构校验与补全复用宿主通道那一套：宿主送工程 JSON 与读文件是同一种输入
  const project = normalizeProjectInput(envelope.project);
  if (project === null) {
    return fail(
      makeError(
        'E_INVALID_PROJECT',
        '工程结构不合法（缺少 tracks，或宽高/帧率不是正整数）',
        `文件版本 v${version}`,
      ),
    );
  }
  // 素材字节不在文件里：统一标 offline，由用户重连（或宿主 importAsset 绑回）
  return {
    ok: true,
    value: {
      ...project,
      assets: project.assets.map((asset) => ({
        ...asset,
        status: 'offline' as const,
        handleRef: null,
        thumbnailRef: null,
      })),
    },
  };
}
