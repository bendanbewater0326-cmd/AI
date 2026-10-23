/**
 * 高对比主题（R-064）：一个属性 + 一组 CSS 变量，不引入主题框架。
 *
 * 为什么用 `data-theme` 属性而不是 class：画布绘制（时间线/预览）也要跟着换色，
 * 它读的是 `getComputedStyle` 里的 CSS 变量——属性选择器同样能改变变量值，
 * 一处切换、CSS 与 canvas 同时生效。
 */
import { STORE_SETTINGS, db as defaultDb } from '../persist/db';

export type Theme = 'default' | 'contrast';

const THEME_KEY = 'ui.theme';
let current: Theme = 'default';
const listeners = new Set<() => void>();

export function getTheme(): Theme {
  return current;
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 应用主题（幂等）。空字符串表示默认主题。 */
export function applyTheme(theme: Theme): void {
  current = theme;
  if (theme === 'contrast') {
    document.documentElement.setAttribute('data-theme', 'contrast');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  for (const listener of listeners) listener();
}

/**
 * 直接设置并持久化（设置面板的二态选择用它）。
 *
 * 以前只有 `toggleTheme`，设置面板要"点哪个就是哪个"，就得写
 * `if (getTheme() !== target) toggleTheme()` —— 那等于把"什么算切换"这条规则
 * 复制到面板里。统一走 `setTheme`，`toggleTheme` 也委托给它。
 */
export async function setTheme(theme: Theme): Promise<Theme> {
  applyTheme(theme);
  await defaultDb.put(STORE_SETTINGS, THEME_KEY, theme);
  return theme;
}

/** 切换并持久化（下次打开还记得）。 */
export async function toggleTheme(): Promise<Theme> {
  return setTheme(current === 'contrast' ? 'default' : 'contrast');
}

/** 启动时读取上次的主题（读不到就用默认）。 */
export async function restoreTheme(): Promise<Theme> {
  const stored = await defaultDb.get<Theme>(STORE_SETTINGS, THEME_KEY);
  const theme: Theme = stored.ok && stored.value === 'contrast' ? 'contrast' : 'default';
  applyTheme(theme);
  return theme;
}
