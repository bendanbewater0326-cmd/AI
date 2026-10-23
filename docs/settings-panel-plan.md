# 左栏「设置」面板方案

> 状态：**待确认**（2026-10-23 摸底完成）
> 目标：把散落的低频设置收拢到一个入口 + 快捷键说明自动生成
> 边界：**零底层改动**（唯一新增是"默认时长"这个原本不存在的偏好，见 §4）

---

## 1. 摸底结论

### 1.1 四类设置项的现状

| 项 | 实现 | 存哪 | 入口在哪 |
|---|---|---|---|
| **主题** | `ui/theme.ts`：`getTheme` / `toggleTheme` / `subscribeTheme` | localStorage | **顶栏按钮**（二态 light/dark）|
| **吸附开关** | `store.toggleSnap()` + `ephemeral.snapEnabled` | **会话级**（刷新回默认 `true`）| 时间线工具栏 + `N` 键 |
| **缓存管理** | `ui/CacheDialog.tsx`（`open`/`onClose` 弹窗）| IndexedDB（OPFS 缓存池）| **顶栏「缓存」按钮** |
| **默认时长** | ❌ **不存在** —— 只有常量 `TEXT_CLIP_SECONDS` | — | — |

### 1.2 快捷键：**已经集中定义，可以直接驱动说明页**

`src/core/keymap.ts` 的 `KEY_BINDINGS` 有 **17 条**，每条含 `id` / `label`（中文）/ `keys` / `primary` / `shift` / `alt`：

```
播放/暂停 (空格)      删除片段 (Delete)    波纹删除 (Shift+Delete)
切分片段 (Ctrl+B)     开关吸附 (N)         撤销 (Ctrl+Z)      重做 (Ctrl+Shift+Z)
后退/前进 1 帧 (←/→)  后退/前进 10 帧 (Shift+←/→)
导出 (Ctrl+E)         唤起 AI (Ctrl+K)     标记入点 (I) / 出点 (O) / 清除 (Alt+I)
退出编辑 (Esc)
```

**结论：说明页从 `KEY_BINDINGS` 自动生成，不手抄。** 以后加快捷键只需改 keymap 一处，说明页自动跟上。

**但有两处缺口**（都不需要改 keymap 逻辑）：

1. **没有 `category` 字段** —— 无法分组（播放 / 剪辑 / 时间线 / 全局）
2. **没有格式化函数** —— `primary: true` 要显示成 `Ctrl`（Win）或 `Cmd`（Mac）

**处理方式见 §3。**

---

## 2. 面板结构（5 组，与调节面板同一套折叠规范）

```
┌─ 设置 ──────────────────────────┐
│  ▼ 外观                          │
│     主题   [浅色] [深色]          │
│                                  │
│  ▶ 编辑偏好                      │
│  ▶ 缓存                          │
│  ▶ 快捷键                        │
│  ▶ 关于                          │
└──────────────────────────────────┘
```

| 组 | 内容 | 默认态 |
|---|---|---|
| **外观** | 主题（浅色 / 深色，二态切换）| 展开 |
| **编辑偏好** | 吸附开关 + 默认素材时长 | 折叠 |
| **缓存** | 已用大小 + 「打开缓存管理」按钮 | 折叠 |
| **快捷键** | 分类列表（自动生成）| 折叠 |
| **关于** | 版本 / 构建时间 / 隐私说明 | 折叠 |

复用 `CollapsibleSection`（`variant="panel"`），折叠态存 `veditor:settings:openGroups`（与调节面板同一套机制）。

---

## 3. 快捷键说明页（自动生成）

### 3.1 数据来源

直接遍历 `KEY_BINDINGS`（不新增任何数据结构）：

```ts
for (const binding of KEY_BINDINGS) {
  const group = CATEGORY_OF[binding.id];   // UI 层的 id → 分类映射
  render(binding.label, formatKeys(binding));
}
```

### 3.2 分类映射放 UI 层，还是给 keymap 加字段？

| 选项 | 做法 | 代价 |
|---|---|---|
| **A（推荐）先放 UI** | `ui/settings/keymapView.ts` 里一份 `id → 分类` 的映射（17 条） | 不改 keymap；但同一份信息两处（分类 vs 定义） |
| B. 给 `KeyBinding` 加 `category` | 改 `keymap.ts`（类型 1 行 + 17 条数据） | 单一数据源；但动了 core 文件 |

**我倾向 B 的长期收益更高**（分类是快捷键的固有属性，不是展示细节），但它违反"零底层改动"，所以**先按 A 做**，并在文件头注明"若以后分类变复杂，迁到 keymap"。

### 3.3 格式化（纯展示逻辑）

```ts
function formatKeys(binding, platform): string[] {
  // primary → 'Cmd'(mac) / 'Ctrl'(other)
  // shift  → 'Shift'；alt → 'Alt'
  // keys  → 显示名映射：' '→'空格'，'arrowleft'→'←'，'delete'→'Delete'，
  //          'backspace' 与 delete 同义只显示 'Delete'，字母 → 大写
  return [modifier, ...keyLabels];   // 用 <kbd> 渲染
}
```

**多键同义**（`delete`/`backspace`）只显示第一个 —— 显示 `Delete / Backspace` 会让行变长且没信息量。

### 3.4 视觉

分类标题 + 两列网格（每行：动作名 + `<kbd>` 键帽）。约 17 条 × 24px ≈ 400px，需要滚动（左栏本来就能滚）。

---

## 4. 默认素材时长（唯一的新能力）

### 4.1 现状

只有常量 `TEXT_CLIP_SECONDS`（文本面板加文字时的默认时长），**不可配**。
「默认时长」需求实际影响三处：加文字、拖图片/贴纸、导入纯音频。

### 4.2 存哪？

项目已有的偏好存储约定是 **localStorage + `veditor:` 前缀**：
`veditor:leftTab` / `veditor:caption:view` / `veditor:adjust:openGroups`

**建议新增**：`localStorage['veditor:prefs']`（JSON）

```ts
interface Prefs {
  /** 加文字 / 拖图片时的默认时长（秒）。 */
  defaultClipSeconds: number;   // 默认 3
}
```

**为什么不进 doc**：这是**用户偏好**，不是工程数据（换工程还该生效）。
**为什么不进 `store.ephemeral`**：那是会话级（吸附就是会话级，刷新就回默认）。

### 4.3 影响范围（要接线的三处）

| 位置 | 现状 | 改成 |
|---|---|---|
| 文本面板加文字 | `TEXT_CLIP_SECONDS` | `readPrefs().defaultClipSeconds` |
| 拖图片/贴纸到时间线 | 硬编码帧数 | 同上 |
| 导入纯音频 | 用素材本身时长 | **不改**（音频有自己的时长）|

> 这一项**确实要动 2 处业务代码**（读偏好而不是常量）。
> 如果嫌超出"零底层改动"，可以**先不做默认时长**（面板只做收拢 + 快捷键），
> 这是待确认 ②。

---

## 5. 文件清单

### 新增（4 个）

| 文件 | 职责 | 约行数 |
|---|---|---|
| `src/ui/settings/SettingsPanel.tsx` | 面板外壳（5 组）| 220 |
| `src/ui/settings/keymapView.ts` | 分类映射 + 键位格式化（**纯函数**）| 100 |
| `src/ui/settings/prefs.ts` | `readPrefs` / `writePrefs`（localStorage，带容错）| 60 |
| `tests/verify-settings.mjs` | E2E | 260 |

### 修改（2 个）

| 文件 | 改动 |
|---|---|
| `src/ui/LeftPanel.tsx` | `settings` Tab 从占位换成 `<SettingsPanel />` |
| `src/styles/app.css` | 末尾追加 `.v-settings-*` |

### 可选修改（若做默认时长，见待确认 ②）

`src/ui/TextPanel.tsx`、拖放落轨处 —— 各 1 行（常量 → 偏好读取）。

### 不动

`core/keymap.ts`（只读）、`core/store.ts`、`ui/theme.ts`（只调现有函数）、`ui/CacheDialog.tsx`（只在面板里触发打开）。

---

## 6. 分步计划

| 步 | 内容 | 验收 |
|---|---|---|
| **S1** | `prefs.ts` + `keymapView.ts`（纯函数）+ 单测 | 单测：键位格式化（mac/win）、多键同义只显示第一个、分类覆盖全部 17 条 |
| **S2** | 面板外壳 + 外观 / 缓存 / 关于 三组 | E2E：切主题生效、点缓存打开弹窗 |
| **S3** | 快捷键组（自动生成 + 分类 + kbd 渲染）| E2E：17 条全在、Cmd/Ctrl 随平台、搜不到手写表 |
| **S4** | 编辑偏好组（吸附开关 + 默认时长）+ 接线两处 | E2E：关吸附后拖动不吸、改默认时长后加文字时长跟着变 |

---

## 7. 待确认（4 项）

### ① 快捷键分类：UI 层映射 vs 给 keymap 加 `category`

- **A（推荐先做）**：UI 层映射（零底层改动），文件头注明"以后复杂了迁到 keymap"
- **B**：给 `keymap.ts` 加 `category`（单一数据源，但动 core）

### ② 默认时长要不要现在做？

这是本方案**唯一会碰业务代码**的项（文本面板 + 拖放处各 1 行）。

- **A（推荐）做**：用户列了这项，且成本就 2 行 + 1 个 prefs 模块
- **B. 先不做**：面板只做"收拢 + 快捷键"，默认时长留到后面

### ③ 主题只有浅/深二态，够吗？

现在 `theme.ts` 是二态（`light` / `dark`）。要不要加"跟随系统"？
- **A（推荐）先不加**：`theme.ts` 没有 `system` 分支，加要改它（底层）
- **B**：加（要动 theme.ts）

### ④ 「关于」组放什么？

- 版本号 + 构建时间（`__BUILD_TIME__`？需确认有没有）
- 隐私说明（"素材不上传，AI 只发指令文本 + 工程结构"）
- **A（推荐）**：这三条 + 一条「清空本地数据」（危险操作，需二次确认）

---

## 8. 验收标准

| 项 | 标准 |
|---|---|
| 零回归 | `npm test` 699 条全绿；现有 9 个 E2E 全绿 |
| 收拢 | 主题 / 缓存 / 吸附 / 默认时长 都能在面板内操作，且与顶栏/工具栏行为一致 |
| 快捷键 | 17 条全部展示、分类正确、**Cmd/Ctrl 随平台**、`<kbd>` 渲染 |
| 一致性 | 与调节面板同一套折叠组件与视觉 |
| 全中文 | 所有标签中文 |

---

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 主题切换后面板颜色不跟随 | `subscribeTheme` 订阅；面板内用 CSS 变量（已全项目统一）|
| 默认时长改了但已存在的片段被改 | **只影响新建**（拖动/加文字时读取），不改已有片段 |
| 快捷键表与说明页不同步 | 说明页**不手写**，遍历 `KEY_BINDINGS` |
| 折叠态与调节面板串味 | 用不同的 storage key（`veditor:settings:openGroups`）|

---

## 10. S2 落地记录（2026-10-23）

**状态：S2 完成** —— 外壳 + 外观 / 缓存 / 关于三组功能；编辑偏好只接了吸附开关；
快捷键组与「默认素材时长」留给 S3 / S4（**故意留空，不做半成品**：放了控件不接线，
就是项目里记过的"数据层有、界面没接"）。

### ⚠️ 口径更正：本项目没有「浅色 / 深色」，只有「默认 / 高对比」

S2 需求里写的是"浅色 / 深色二态"，但代码里的事实是：

| 事实 | 位置 |
|---|---|
| `Theme = 'default' \| 'contrast'`，就这两态 | `ui/theme.ts` |
| 一套明亮色板 + 一组 `:root[data-theme='contrast']` 深色覆盖 | `styles/app.css` §高对比主题（R-064） |

所以面板上的二态只能是**「默认 / 高对比」**，与顶栏「工程」菜单里的主题按钮是同一个开关。
真做"浅色 / 深色"= 给 3946 行 CSS 补一整套 dark 变量并逐屏核对，属独立任务（**待拍板**），
不在"零底层改动"范围内。

### 与本文前面方案的差异（3 处，都有理由）

1. `prefs.ts` 最终放在 `core/prefs.ts`（方案 §5 写的是 `ui/settings/prefs.ts`）：
   `store.ts` 初始化要读它，放 `persist/` 会与 `autosave → store` 成环。
2. 折叠组件新增可选 `storageKey`，**不复制**一份折叠实现：
   同一套交互、两个 key（`veditor:settings:openGroups` / `veditor:adjust:openGroups`）。
3. 缓存弹窗由面板自己渲染一个 `<CacheDialog>` 实例（组件原样复用），
   不把 `cacheOpen` 提到 App —— 提状态要改 TopBar 的 props，代价大于收益。

### 实现清单

| 文件 | 改动 |
|---|---|
| `ui/settings/SettingsPanel.tsx` | 新增：五组外壳 + 外观 / 缓存 / 关于 |
| `ui/settings/clearLocalData.ts` | 新增：清 localStorage（`veditor:` 前缀）+ IndexedDB 整库 + OPFS 缓存池 |
| `ui/adjust/CollapsibleSection.tsx` | 加 `storageKey?`（默认行为不变）|
| `ui/theme.ts` | 加 `setTheme()`，`toggleTheme` 委托给它 |
| `ui/TopBar.tsx` | 导出 `formatBuildTime`（关于组复用，不复刻）|
| `scripts/build.mjs` / `scripts/dev.mjs` | `define __APP_VERSION__`（源头 = `package.json`）|
| `styles/app.css` | +236 行 `.v-settings__*`（折叠直接复用 `.v-adjust__*`）|
| `tests/verify-settings.mjs` | 新增 **22 项** E2E |
| `tests/verify-left-tabs.mjs` | 修 **2 项过期断言**（字幕 / 调节早已不是占位，动手前它就是红的）|

### 验收（实测）

- `verify-settings` **22/22**（主题属性 / 顶栏按钮 / 分段高亮三者同步；刷新后主题、吸附、折叠态都记住；
  缓存显示真实占用；清空本地数据必须先确认、取消可退回、确认后工程名回到「未命名工程」）
- `npm test` **699** / `npm run check` **108 文件 0 违规**
- 回归：left-tabs / adjust / text-panel / effect-panel / caption / t11 / t14 / layout / timeline-height / panel-leak 全绿
- 构建 `main.js` 722.2 KB、`main.css` 50.6 KB

### 下一步（S3 / S4）

| 步 | 内容 | 现状 |
|---|---|---|
| S3 | 快捷键组（分类 + `<kbd>`）| 数据层 `keymapView` 已就绪、有 16 条单测，只差接线与 E2E |
| S4 | 编辑偏好里的「默认素材时长」+ 接线两处（文本面板加文字、拖图片/贴纸落轨）| `prefs.defaultClipSeconds` 已就绪，未接线 |

---

## 11. S3 + S4 落地记录（2026-10-23 夜）

**设置面板五组全部可用，S1–S4 收官。**

### S3：快捷键组

- 面板直接遍历 `keymap.KEY_BINDINGS`（经 `keymapView.groupBindings(detectPlatform())`），
  四分类 + `<kbd>` 键帽，**不手写表**：以后改键位，说明页自动跟上。
- 平台自适应：Mac 出 `⌘ / ⌥ / ⇧`，Windows 出 `Ctrl / Alt / Shift`，底部一行说明当前按哪套显示。
- 分类标题右侧带条数（5 / 6 / 1 / 5），一眼看出"这一类几条"。
- E2E ⑭–⑭e：四类顺序、17 条全列、修饰键、多键同义只显示第一个（Delete 而不是 Delete / Backspace）、
  特殊键显示名（空格 / ←）。

### S4：默认素材时长

| 项 | 做法 |
|---|---|
| UI | 复用 `AdjustRow`（滑块 + 数值框），0.5–60 秒、步进 0.5、默认 3 |
| 存储 | `localStorage['veditor:prefs']` 的 `defaultClipSeconds`（S1 已建好）|
| 读取点 | **`core/prefs.defaultClipSeconds()` —— 新增的唯一入口** |
| 删除 | `TEXT_CLIP_SECONDS` 常量（3 处引用全部改掉）|
| 接线 | 文本面板点模板 / 工具栏「文字」/ 拖模板到时间线（`planForTextDrop`）|

**为什么删常量而不是让它去读偏好**：留一个"名义上是 3 秒"的常量，后人一定会以为它还是唯一来源；
函数名 `defaultClipSeconds()` 本身就说明"这是读出来的偏好"。

**只影响新建**：该函数只在创建片段时调用，已有片段的 `durationFrames` 不动（E2E ⑮e 断言）。

### 一个顺带发现的真问题：单测写了，但没进回归网

`tests/settings.test.mjs`（S1 写的 17 条）**从来没被加进 `npm test` 的脚本列表**：
单跑是绿的，"699 条全绿"里其实一次都没跑过它。

已补进 `package.json` → 现在 **41 脚本 / 716 条**。

> 这是项目里记过的"数据层有、界面没接"的测试版：**代码写了，但没被回归覆盖**。
> 判据：新增 `tests/*.test.mjs` 后，`npm test` 的总条数必须变多；不变就是没接上。

### 验收（实测）

- `verify-settings` **34/34**（原 22 + S3 的 7 条断言 + S4 的 5 条断言）
- `npm test` **716 条 / 41 脚本**全绿
- 全量 E2E 64 个脚本：见 `.workbuddy/memory/2026-10-23.md` 收尾记录
- 构建 `main.js` **725.1 KB**（+2.9KB）、`main.css` 50.8 KB
- 截图：`settings-5-keymap.png`（四类 17 条）、`settings-6-editing.png`（吸附 + 默认时长）
