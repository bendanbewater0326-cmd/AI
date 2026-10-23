/**
 * 用户偏好（跨工程、跨会话保留）。
 *
 * ## 为什么不放 doc / 不放 ephemeral
 *
 * - **doc**：工程数据。换一个工程，"默认时长"不该跟着变。
 * - **ephemeral**：会话级。刷新就回默认（吸附以前就是放这儿，用户会当成 bug）。
 *
 * 所以用 localStorage：项目已有的偏好约定就是 `veditor:` 前缀
 * （`veditor:leftTab` / `veditor:caption:view` / `veditor:adjust:openGroups`）。
 *
 * ## 为什么放 `core/` 而不是 `persist/`
 *
 * `store.ts` 初始化 `ephemeral.snapEnabled` 时要读它，而 `persist/` 依赖 `core/`（autosave 用 store）——
 * 反向引用会成环。这里是无依赖的纯读写（只用 localStorage），放 core 最干净。
 *
 * ## 容错
 *
 * 单测跑在 Node（没有 localStorage）、用户可能关掉存储、JSON 可能损坏 ——
 * 任何异常都**退回默认值**，绝不 throw（偏好读失败不该让编辑器起不来）。
 */
export interface Prefs {
  /** 新建文字 / 拖图片时的默认时长（秒）。 */
  defaultClipSeconds: number;
  /** 吸附开关（持久化：设置面板里关掉后，重开还是关）。 */
  snapEnabled: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  defaultClipSeconds: 3,
  snapEnabled: true,
};

/** `defaultClipSeconds` 的合法范围（秒）。0.1s 是 3 帧@30fps，60s 已经很长了。 */
export const MIN_DEFAULT_SECONDS = 0.5;
export const MAX_DEFAULT_SECONDS = 60;

const STORAGE_KEY = 'veditor:prefs';

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function clampSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_PREFS.defaultClipSeconds;
  const clamped = Math.min(MAX_DEFAULT_SECONDS, Math.max(MIN_DEFAULT_SECONDS, value));
  // 保留 1 位小数（0.5 的步进）
  return Math.round(clamped * 10) / 10;
}

/** 读偏好。任何异常/脏数据都退回默认（逐字段校验，不整份丢弃）。 */
export function readPrefs(): Prefs {
  const store = storage();
  if (store === null) return { ...DEFAULT_PREFS };
  let raw: unknown;
  try {
    const text = store.getItem(STORAGE_KEY);
    if (text === null) return { ...DEFAULT_PREFS };
    raw = JSON.parse(text);
  } catch {
    return { ...DEFAULT_PREFS };
  }
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_PREFS };
  const record = raw as Record<string, unknown>;
  return {
    defaultClipSeconds: clampSeconds(record['defaultClipSeconds']),
    snapEnabled: typeof record['snapEnabled'] === 'boolean' ? record['snapEnabled'] : DEFAULT_PREFS.snapEnabled,
  };
}

/** 写偏好（局部更新，返回写入后的完整值）。写失败静默降级（隐私模式下 localStorage 会抛）。 */
export function writePrefs(patch: Partial<Prefs>): Prefs {
  const next: Prefs = { ...readPrefs(), ...patch };
  const normalized: Prefs = {
    defaultClipSeconds: clampSeconds(next.defaultClipSeconds),
    snapEnabled: next.snapEnabled === true,
  };
  const store = storage();
  if (store !== null) {
    try {
      store.setItem(STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      // 配额满 / 隐私模式：偏好不生效但不影响剪辑
    }
  }
  return normalized;
}
