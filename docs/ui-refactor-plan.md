# UI 重构方案 · 第一阶段：主布局骨架

> 对标基准：`OpenCut-app/OpenCut` + 它的可用版本 `OpenCut-app/opencut-classic`
>
> **本文所有"OpenCut 是这样"的结论都带源码出处**，不是推测。
> 核实时间：2026-10-22

---

## 0. 三处必须先纠正的前提

### ① 主仓库没有可参考的 UI，能参考的是 `opencut-classic`

`OpenCut-app/OpenCut` 的 README 原文：

> **OpenCut is being rewritten from the ground up.**
> We're not set up to take outside contributions yet while the architecture is being designed.
> You can still find the previous version at **opencut-app/opencut-classic**, which is the one to reach for today.

而且 classic 的 `apps/desktop/` 是 **GPUI，in progress**（README 原文："Native desktop app built with GPUI (in progress)"）。
`opencut.app` 现在跑的是 classic 的 **web 版**（Next.js）。

**所以"1:1 对齐 OpenCut 桌面端"要落成"对齐 opencut-classic 的 web 编辑器"** —— 这是唯一有真实 UI 可参照的对象。

### ② 左侧不是"7 个横向文字 Tab"，是 **9 个纵向图标**

`apps/web/src/components/editor/panels/assets/tabbar.tsx` 的容器类名：

```
className="scrollbar-hidden relative flex size-full p-1 flex-col items-center justify-start gap-0.5 overflow-y-auto"
```

`flex-col` + `items-center` = **竖排图标条**；每个按钮 `h-8 w-8`（32×32），`label` 只在 **tooltip 里显示**（`TooltipContent side="right"`）。

`assets-panel-store.tsx` 的 `TAB_KEYS` 原文顺序：

| # | key | 英文 label | 中文建议 |
|---|---|---|---|
| 1 | `media` | Media | 素材 |
| 2 | `sounds` | Sounds | 音频 |
| 3 | `text` | Text | 文本 |
| 4 | `stickers` | Stickers | 贴纸 |
| 5 | `effects` | Effects | 特效 |
| 6 | `transitions` | Transitions | 转场 |
| 7 | `captions` | Captions | 字幕 |
| 8 | `adjustment` | Adjustment | 调节 |
| 9 | `settings` | Settings | 设置 |

默认 `activeTab: "media"`。

**与需求清单的差异**（必须你拍板）：

| 需求写的 | 实际 | 说明 |
|---|---|---|
| 素材库、音频、文本、贴纸、转场、特效、**滤镜** | 素材、音频、文本、贴纸、**特效、转场**、字幕、调节、设置 | ① **顺序不同**：OpenCut 是 effects(5) 在 transitions(6) 之前，需求写的是"转场→特效"；② **没有独立"滤镜"**，OpenCut 把滤镜归在 effects 里；③ 需求漏了 **字幕 / 调节 / 设置** 三项 |

### ③ 面板尺寸是**百分比可拖拽**，不是固定 240/260px

`apps/web/src/app/editor/[project_id]/page.tsx` 的结构：

```
ResizablePanelGroup direction="vertical"          ← 上下两区
├─ mainContent  (min 30, max 85)
│   └─ ResizablePanelGroup direction="horizontal"  ← 三栏
│       ├─ tools       (min 15, max 40)  → AssetsPanel
│       ├─ ResizableHandle withHandle
│       ├─ preview     (min 30)          → PreviewPanel
│       ├─ ResizableHandle withHandle
│       └─ properties  (min 15, max 40)  → PropertiesPanel
├─ ResizableHandle withHandle
└─ timeline     (min 15, max 70)         → Timeline
```

`apps/web/src/panels/layout.ts` 的默认值：

```js
PANEL_CONFIG = { tools: 25, preview: 50, properties: 25, mainContent: 50, timeline: 50 }
```

| 需求写的 | OpenCut 实际 |
|---|---|
| 左栏 240px（min 180） | **25%**（min 15%，max 40%） |
| 右栏 260px | **25%**（min 15%，max 40%） |
| 中间自适应 | **50%** |
| 时间轴 40% 窗口高 | **50%**（min 15%，max 70%） |

百分比的好处：1920 宽下左栏 480px、1440 宽下 360px，窗口变大时面板跟着长——比固定 px 更符合"桌面端"的直觉。**建议照 OpenCut 用百分比**，接受"1920 下左栏 480px"这个事实（OpenCut 左栏里还有 44px 的图标条，内容区约 436px）。

---

## 1. 目标结构（四分区）

```
┌──────────────────────────────────────────────────────────────┐
│ 顶栏 48px：标识 · 工程名 · 撤销/重做/分割/选择 │ 比例·自检·工程·AI·导出 │
├────┬─────────────────────────────────────────────────┬───────┤
│图标│                                                  │       │
│条  │              预览（深灰底，画面居中）              │ 属性   │
│44px│        底部居中：播放控制条（叠在画面上）           │ 面板   │
│    │                                                  │       │
├────┴─────────────────────────────────────────────────┴───────┤
│ 时间轴（工具条：吸附·缩放·加轨 / 轨道头 + Canvas 内容）        │
└──────────────────────────────────────────────────────────────┘
        ↑ 左栏 = 图标条 44px + 内容面板（可折叠、可拖宽）
```

| 区域 | 尺寸 | 与 OpenCut 的对应 |
|---|---|---|
| 顶栏 | **48px 固定** | `EditorHeader` |
| 左栏 | **25%**（min 15% / max 40%），内含 **44px 图标条** | `tools` + `AssetsPanel`(含 tabbar) |
| 预览 | **50%**（min 30%） | `preview` |
| 右栏 | **25%**（min 15% / max 40%） | `properties` |
| 时间轴 | **50%**（min 15% / max 70%） | `timeline` |
| 面板间 | **4px 可拖拽手柄**（hover 变主色） | `ResizableHandle withHandle` |

---

## 2. 现有代码的落点（不碰底层）

| 现在 | 改成 | 改动量 |
|---|---|---|
| `--v-topbar-h: 32px` | `48px` + 重排按钮 | 中 |
| `--v-rail-w: 110px`（左右同宽） | 拆成 `--v-left-w` / `--v-right-w`，百分比 + 拖拽 | 中 |
| `v-body` = `rail \| 1fr \| rail` | 保留 grid，列宽改百分比变量 | 小 |
| 左栏只有 `AssetPanel` | 外层加 `LeftRail`（图标条 + 内容区），`AssetPanel` 变成 `media` Tab 的内容 | 大 |
| `v-ctrlbar` 在预览下方独占 36px | 改成**绝对定位叠在画面底部居中** | 中 |
| `--v-timeline-h: 220px` | `50%`（用 `grid-template-rows: 1fr 1fr` + 可拖分隔条） | 小 |
| 无左右折叠 | 加折叠按钮 + 状态记 localStorage | 小 |

**完全不动的部分**（这是硬约束）：`core/`、`media/`、`render/`、`export/`、`persist/`、`host/`、`ai/`、时间轴 canvas 内核（`timelinePainter` + `timelineController`）。

---

## 3. 分五步落地（每步可独立验收）

### S1.0 布局钩子 + 尺寸变量收敛（✅ 已完成 2026-10-22）

为什么必须先做：现有 54 个 E2E 里有一批**硬编码了布局数值**：

```bash
# 依赖 --v-rail-w / --v-timeline-h / 顶栏高度的测试
verify-interaction.mjs     # 坐标换算读 timelineLayout()，但画布 top 依赖上方区域高度
verify-dragdrop.mjs        # 同上
verify-clip-states.mjs     # 同上
verify-s5-p0.mjs           # 同上
verify-audio-controls.mjs  # 断言"加轨后能滚到最后一条轨"
verify-touch-a11y.mjs      # 断言"时间线可视区在视口内"
```

做法（和 S1 几何收敛同一个套路）：

1. 新增测试钩子 `uiLayout()` 返回各区域 rect：
   ```ts
   { topbar: {h}, left: {w, collapsed}, right: {w, collapsed},
     stage: {x,y,w,h}, timeline: {y,h}, previewCanvas: {x,y,w,h} }
   ```
2. 把上面 6 个测试里"靠 canvas.getBoundingClientRect 推"的地方改成读 `uiLayout()`
3. 先跑一遍全绿（此时尺寸**还没改**）→ 证明钩子没写错
4. 再改尺寸 → 测试只需保证"能读到新值"，不会因为布局变化而红

**已完成的部分**：

1. 新增测试钩子 `uiLayout()`（`ui/App.tsx`），返回：

   ```ts
   { window: {w,h}, topbar, left, right, stage, ctrlbar,
     timeline, timelineViewport, timelineCanvas, previewCanvas,
     vars: { topbarH, railW, ctrlbarH, timelineH } }
   ```

2. `verify-t11` 的 5 条硬编码尺寸断言（32/110/110/36/220）改成**结构性断言**：
   位置关系（贴顶/贴左/不重叠/不越界）+ 合理范围（顶栏 24–64、左右栏 100–560、
   时间轴占窗口 15%–70%）。范围**同时容纳重构前的 110px 和重构后的 25%**，
   所以这套断言在重构前后都成立 —— 这是 S1.0 的核心目的。

3. `verify-s5-p0` 里"拉高时间线"的写法同时设 `--v-timeline-h`（px）与
   `--v-timeline-pct`（百分比）。否则 S1.4 换成百分比后，那句 `setProperty`
   会**静默失效**，测试从"真的看到了多轨"退化成"假通过"。

**验收**：尺寸未变时 54/54 全绿 ✅

### S1.1 顶栏 32 → 48px（✅ 已完成 2026-10-22）

- 左：`veditor` 标识 · 工程名（可双击改）· 分隔线 · 撤销 / 重做 / 分割 / 选择
- 右：画布比例 · 自检 · 工程 · **AI 命令** · 导出
- 「主题」和「缓存」收进「工程」下拉（现在顶栏已经有 8 个按钮，48px 高会显得空但挤）

**已完成**：顶栏 48px；左侧 `veditor` 标识 + 工程名 + 参数 + `│` + 撤销/重做/分割；
右侧 自检 / 工程▾ / AI 命令 / 导出；**主题 / 缓存 / 构建时间收进「工程」下拉**。

**没做"选择工具"**：项目不做模式切换（`docs/ux-plan.md` §6），加一个点了什么都不变的
按钮就是死按钮。

**验收**：`verify-t11` 的"顶栏高度 24–64"（实测 48）+ 全量 54/54 全绿 ✅

### S1.2 三栏改百分比 + 可拖拽 + 可折叠

- 新增 `ui/splitter.tsx`（一个 4px 的拖拽条，复用 S3 的 pointer 拖拽模式）
- `v-body` 的列宽改成 `calc(var(--v-left-pct) * 1%)` 之类，或直接内联 style
- 左右面板加折叠按钮（折叠后宽度 0，图标条保留）
- 记住宽度/折叠状态（localStorage，不进工程文件）

**验收**：拖到 15% / 40% 边界会停住；折叠后预览变宽；刷新后状态保留。

### S1.3 左栏图标 Tab 条（9 个，先只有"素材"有内容）

- 新增 `ui/LeftRail.tsx`：44px 竖条 + 9 个图标按钮（tooltip 在右侧显示中文名）
- 中文命名按 §0② 的表格，**顺序照 OpenCut**
- 其余 8 个 Tab 先显示"即将开放"占位（**不给死按钮**：点了显示一句说明，而不是静默无反应）
- `AssetPanel` 变成 `media` Tab 的内容，内部结构不动

**验收**：9 个图标都能点、tooltip 显示中文；切到"素材"时现有素材栏功能完全正常（`verify-t12` 全绿）。

### S1.4 时间轴 50% + 可拖

- `v-workspace` 的 `grid-template-rows` 从 `1fr 220px` 改成 `var(--v-main-pct) 1fr`
- 复用现有的 `.v-timeline__splitter`（已经能拖），改成百分比语义

**验收**：默认 50/50；拖到 15% / 70% 边界停住；`verify-t15` 的 100 片段重绘仍 < 3ms。

### S1.5 预览控制栏叠到画面底部居中

- `v-ctrlbar` 从"grid 第二行"改成 `position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%)`
- 背景半透明黑 + 圆角（剪映/OpenCut 都是浮在画面上）
- 控制条内容不变（播放/时间码/音量）

**验收**：控制栏浮在画面上、不挡画面主体；`verify-a-ui` 的播放按钮仍可点。

---

## 4. 三处我建议偏离需求的地方

| 需求 | 建议 | 理由 |
|---|---|---|
| 7 个 Tab（含"滤镜"，无"字幕/调节/设置"） | **9 个，照 OpenCut 顺序** | "1:1 对齐"的核心就是分类与顺序；滤镜归进"特效"（OpenCut 就是这样） |
| 固定 240 / 260px | **百分比 25% / 25%** | OpenCut 就是百分比；窗口变大时面板跟着长才是桌面端手感 |
| 时间轴 40% | **50%** | OpenCut 的 `timeline: 50`；40% 在 900 高窗口下只有 360px，装 4 条轨仍要滚动（S5 摸底已经证明 191px 不够） |

如果你坚持固定 px，我可以做"默认 240/260px，但可拖到百分比"的混合方案 —— 代价是和 OpenCut 的手感不一致。

---

## 5. 回归风险

| 风险 | 影响面 | 对策 |
|---|---|---|
| 布局尺寸变化让坐标类 E2E 偏移 | 6 个测试 | S1.0 先加 `uiLayout()` 钩子 |
| 左栏从 110px 变 360px+，预览区变窄 | 预览画布尺寸跟着变 | 预览是 `min(100%, 16:9 contain)`，不会变形；但 `verify-t09`（像素比对）要确认画布尺寸断言 |
| 顶栏 48px 让可用高度减少 16px | 时间轴按百分比会自动适应 | 无 |
| 控制栏叠到画面上 | `verify-a-ui` 的按钮坐标 | 用 DOM 选择器点击，不依赖坐标 |

**底线**：54 个 E2E 必须全绿。任何一个因为"布局变了"而红，都算没做完。

---

## 6. 验收标准（第一阶段）

1. 四分区结构与比例与 OpenCut 一致（顶栏 48 / 三栏 25-50-25 / 时间轴 50）
2. 左右面板可拖拽（15%–40%）+ 可折叠；时间轴可拖（15%–70%）
3. 左栏 9 个中文图标 Tab，顺序与 OpenCut 一致，"素材"Tab 功能完整
4. 预览控制栏叠在画面底部居中
5. **全界面无残留英文**（除了 `veditor` 标识本身）
6. 54 个 E2E 全绿 + 单测 576 全绿
7. 底层一行不改（`core/` `media/` `render/` `export/` `persist/` `host/` `ai/` 零改动）

---

## 7. 需要你确认的三件事

1. **Tab 用 9 个（照 OpenCut）还是 7 个（照需求）？** 我建议 9 个，但"滤镜"要不要单独拆出来由你定。
2. **尺寸用百分比（照 OpenCut）还是固定 px（照需求）？** 我建议百分比。
3. **时间轴 50%（照 OpenCut）还是 40%（照需求）？** 我建议 50%，因为 40% 装不下 4 条轨。

确认后我从 **S1.0（布局钩子）** 开工——它不改任何视觉效果，只让后面四步不会把测试搞红。
