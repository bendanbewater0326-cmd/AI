/**
 * 快捷键说明页的**纯展示层**：把 `core/keymap.KEY_BINDINGS` 变成「分类 + 键帽」。
 *
 * ## 为什么不手写一份快捷键表
 *
 * 手写表一定会和实际按键漂移（改了 keymap 忘了改文档）。这里**遍历 `KEY_BINDINGS`**，
 * 数据只有一份。分类与格式化都在这个文件里，`keymap.ts` 一个字都不用改。
 *
 * ## 分类为什么放 UI 层
 *
 * 分类是**展示维度**（用户怎么找），不是按键语义。给 `KeyBinding` 加 `category` 会让
 * core 层混入界面概念。当前 17 条，映射在这里完全够用。
 * **约定**：快捷键超过 30 条、或出现多套 keymap 时，再把分类迁进 keymap 层。
 *
 * ## 格式化细节
 *
 * - 修饰键顺序按 Windows/Linux 习惯：`Ctrl` → `Alt` → `Shift` → 主键
 * - mac 的主修饰键显示 `⌘`（比 `Cmd` 短，行不易撑开）
 * - 多键同义（`delete` / `backspace`）**只显示第一个**：显示 "Delete / Backspace"
 *   会让每行变长，而信息量是零（两个键做同一件事）
 */
import { KEY_BINDINGS } from '../../core/keymap';
import type { KeyBinding, Platform } from '../../core/keymap';

export type KeyCategory = 'playback' | 'edit' | 'view' | 'global';

/** 分类顺序即展示顺序（用户指定：播放控制 → 编辑操作 → 视图调整 → 全局功能）。 */
export const CATEGORY_ORDER: readonly KeyCategory[] = ['playback', 'edit', 'view', 'global'];

export const CATEGORY_LABELS: Record<KeyCategory, string> = {
  playback: '播放控制',
  edit: '编辑操作',
  view: '视图调整',
  global: '全局功能',
};

/**
 * `id → 分类` 映射。
 *
 * 新增快捷键时**必须在这里补一条**（否则会掉进"全局功能"兜底）。
 * 这也是为什么 `groupBindings` 末尾要断言"条数对得上"——见单测。
 */
export const CATEGORY_OF: Record<KeyBinding['id'], KeyCategory> = {
  // 播放控制
  togglePlay: 'playback',
  stepBack: 'playback',
  stepForward: 'playback',
  stepBack10: 'playback',
  stepForward10: 'playback',
  // 编辑操作
  deleteClip: 'edit',
  rippleDelete: 'edit',
  splitAtPlayhead: 'edit',
  markIn: 'edit',
  markOut: 'edit',
  clearMarks: 'edit',
  // 视图调整（目前只有吸附；缩放之类以后加）
  toggleSnap: 'view',
  // 全局功能
  undo: 'global',
  redo: 'global',
  export: 'global',
  ai: 'global',
  escape: 'global',
};

/** 单个按键的显示名。未覆盖的键回退成大写字母 / 原样。 */
const KEY_LABELS: Record<string, string> = {
  ' ': '空格',
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  delete: 'Delete',
  backspace: 'Backspace',
  escape: 'Esc',
  enter: 'Enter',
};

function keyLabel(key: string): string {
  const mapped = KEY_LABELS[key];
  if (mapped !== undefined) return mapped;
  return key.length === 1 ? key.toUpperCase() : key;
}

/**
 * 把一条绑定格式化成键帽数组（按顺序渲染成 `<kbd>`）。
 *
 * @example
 * // win: ['Ctrl', 'Shift', 'Z']；mac: ['⌘', 'Shift', 'Z']
 * formatBindingKeys(redoBinding, 'other');
 */
export function formatBindingKeys(binding: KeyBinding, platform: Platform): string[] {
  const caps: string[] = [];
  if (binding.primary === true) caps.push(platform === 'mac' ? '⌘' : 'Ctrl');
  if (binding.alt === true) caps.push(platform === 'mac' ? '⌥' : 'Alt');
  if (binding.shift === true) caps.push(platform === 'mac' ? '⇧' : 'Shift');
  // 多键同义只显示第一个（delete / backspace 做的是同一件事）
  const first = binding.keys[0];
  if (first !== undefined) caps.push(keyLabel(first));
  return caps;
}

export interface KeyRow {
  id: KeyBinding['id'];
  label: string;
  caps: string[];
}

export interface KeyGroup {
  category: KeyCategory;
  label: string;
  rows: KeyRow[];
}

/**
 * 按分类分组（保持 `KEY_BINDINGS` 的原顺序，不重排）。
 *
 * 空分类**也会返回**（`rows: []`）—— 面板可以据此显示"这一类还没有快捷键"，
 * 比直接不渲染更容易发现"我加了快捷键但没分类"。
 */
export function groupBindings(platform: Platform, bindings: readonly KeyBinding[] = KEY_BINDINGS): KeyGroup[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    rows: bindings
      .filter((binding) => (CATEGORY_OF[binding.id] ?? 'global') === category)
      .map((binding) => ({
        id: binding.id,
        label: binding.label,
        caps: formatBindingKeys(binding, platform),
      })),
  }));
}

/** 未被分类覆盖的 id（单测用；运行时应为空数组）。 */
export function uncategorizedIds(bindings: readonly KeyBinding[] = KEY_BINDINGS): string[] {
  return bindings.filter((binding) => CATEGORY_OF[binding.id] === undefined).map((binding) => binding.id);
}
