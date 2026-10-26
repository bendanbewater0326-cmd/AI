/**
 * 新手引导的**状态与步骤解析**（纯函数，不碰 DOM，不依赖 React）。
 *
 * ## 存储为什么独立一个 key
 *
 * 不复用 `veditor:prefs`：prefs 的语义是"用户偏好"（默认时长、吸附），
 * 引导进度是**一次性状态机**，混在一起会让 prefs 变浑。
 * 也不写进 `doc`：换工程不该重新弹引导（引导是"这台机器上的这个人看过了"）。
 *
 * ## 为什么不做版本号
 *
 * 用户明确要求"不重复打扰"：内容以后改了也不让老用户再看一遍，
 * 需要时靠设置面板的「重新查看新手引导」手动唤起（手动唤起**不看标记**）。
 *
 * ## 容错（三条底线）
 *
 * 1. Node / 单测里没有 `localStorage` → 读返回 `null`（视为"没看过"），写静默失败；
 * 2. 隐私模式 `setItem` 会抛 → 静默吞掉，引导功能不生效但不能妨碍剪辑；
 * 3. 存的不是 `done` / `skipped`（脏数据、手改过的值）→ 当作没看过，不抛。
 */
import { ONBOARDING_STEPS } from './steps';
import type { OnboardingStep } from './steps';

/**
 * 引导的终态。两种都算"看过了"，区分只是为了事后统计（跳过率高说明引导太啰嗦）。
 * 没有"进行中"状态：中途关掉页面等于跳过，不记录步号（不做续播，见方案 §4.4）。
 */
export type OnboardingStatus = 'done' | 'skipped';

/** localStorage 的 key（项目约定 `veditor:` 前缀）。 */
export const ONBOARDING_STORAGE_KEY = 'veditor:onboarding';

/** 运行环境提供的 AI 通道能力（由 App 注入；`ai-open` 按钮是否存在等价于此）。 */
export interface OnboardingContext {
  /** 宿主是否提供 AI 通道。false 时 `requiresAI` 的步骤整条剔除。 */
  aiAvailable: boolean;
}

/**
 * 拿 localStorage（可能为 null）。
 *
 * 直接写 `localStorage` 在 Node 里是 ReferenceError，某些浏览器配置下访问属性也会抛，
 * 所以包一层 try。**每次调用都重新取**：单测会替换 `globalThis.localStorage`，
 * 缓存到模块作用域会让假对象失效。
 */
function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function isStatus(value: unknown): value is OnboardingStatus {
  return value === 'done' || value === 'skipped';
}

/**
 * 读引导状态。没看过 / 读不出来 → `null`。
 *
 * 先按裸字符串匹配（正常写入路径就是裸值），再兜一次 `JSON.parse`
 * （历史数据或手工调试写过 `"done"` 也能认）。两条路都不匹配就是 `null`。
 */
export function readOnboardingStatus(): OnboardingStatus | null {
  const store = storage();
  if (store === null) return null;

  let text: string | null;
  try {
    text = store.getItem(ONBOARDING_STORAGE_KEY);
  } catch {
    return null;
  }
  if (text === null) return null;

  const raw = text.trim();
  if (isStatus(raw)) return raw;

  // 兜底：曾经以 JSON 字符串形式写入（`"done"`），或值被引号包住
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isStatus(parsed)) return parsed;
  } catch {
    // 脏 JSON：不是错误，只是"没看过"
  }
  return null;
}

/**
 * 写引导状态（完成和跳过都写，区别只用于统计）。写失败静默降级。
 *
 * 存裸字符串（`done` / `skipped`）而不是 JSON：值只有两种情况，
 * 加一层 JSON 只会让手工排查变麻烦。
 */
export function markOnboardingFinished(status: OnboardingStatus): void {
  if (!isStatus(status)) return;
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(ONBOARDING_STORAGE_KEY, status);
  } catch {
    // 隐私模式 / 配额满：引导标记不生效，但不影响剪辑
  }
}

/** 清掉状态（设置面板「重新查看」后可配合使用；也是测试/调试入口）。 */
export function resetOnboarding(): void {
  const store = storage();
  if (store === null) return;
  try {
    store.removeItem(ONBOARDING_STORAGE_KEY);
  } catch {
    // 同上：清不掉也不该抛
  }
}

/**
 * 按运行条件过滤步骤——**本文件的核心纯函数**。
 *
 * 只做一件事：`aiAvailable === false` 时把 `requiresAI` 的步骤整条剔除。
 * 不碰 DOM、不读存储，所以能直接单测。
 *
 * 目标节点是否存在、尺寸是否为 0 这类**运行时**判断不在这里做：
 * 那是组件的容错（方案 §5：目标不存在就跳过该步），需要真实 DOM，
 * 放进纯函数会让这个文件变得不可测。
 *
 * @param context 运行环境能力（目前只有 AI 通道）。
 * @param steps 步骤表，默认用 `ONBOARDING_STEPS`（单测可传自定义表）。
 * @returns 新数组；全部被过滤掉时返回**空数组**，调用方据此不启动引导。
 */
export function resolveSteps(
  context: OnboardingContext,
  steps: readonly OnboardingStep[] = ONBOARDING_STEPS,
): OnboardingStep[] {
  // `=== true` 而不是真值判断：`aiAvailable` 缺失 / 为 undefined 时按"没有 AI"处理
  const aiAvailable = context.aiAvailable === true;
  return steps.filter((step) => step.requiresAI !== true || aiAvailable);
}
