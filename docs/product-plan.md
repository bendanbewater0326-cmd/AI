# 产品与技术方案（2026-10-22）

> 角色：产品与技术顾问。约束：**只基于指定开源项目的真实行为 + 本仓库现有代码**，不臆造。
> 本文所有"参考"都标注了**学什么 / 不学什么 / 落到哪个文件**；所有"现状"都对着代码核过。
>
> 相关文档：`docs/PROJECT-STATUS.md`（全史与踩坑）、`docs/nle-baseline.md`（剪映/PR 行为基线）、
> `docs/architecture.md`（任务表）、`docs/PRD.md`（64 条需求）。

---

## 0. 先纠正三个前提（否则后面全错）

在给方案之前，必须先说清三件与原始要求不一致的事实。这不是抬杠，是因为**照着一个不存在的东西做对标，会得到一套没法落地的方案**。

### 0.1 OpenCut 重写版现在**没有可参考的 UI**

`OpenCut-app/OpenCut` 的 README「Status」原文：

> **OpenCut is being rewritten from the ground up.** What's coming: An Editor API / First-class third
> party plugins (plugin-first architecture) / Desktop, mobile, and browser from one codebase (Rust core) /
> MCP server (for AI agents) / Headless mode / A scripting tab directly in the editor.
>
> "We're not set up to take outside contributions yet **while the architecture is being designed**."
>
> You can still find the previous version at **opencut-app/opencut-classic**, which is the one to reach for today.

也就是说：**你要学的"三栏布局 / 拖拽时间轴 / 预设化特效展示"在重写版里还没有**（它连桌面端都在 scaffold 阶段）。
能看的只有 classic 版。Rust core、Editor API、MCP server 是它的**目标**，不是它的现状——**不能当"成熟实现"抄**。

**修正后的对标方式**：

| 想学的东西 | 去哪看 | 怎么用 |
|---|---|---|
| 剪映式三栏 / 拖拽 / 预设化展示 | **剪映本身** + `opencut-classic` | 抄"入口组织"，不抄视觉细节 |
| Rust core + 前端 UI 分离 | OpenCut 的**目录结构**（`apps/web`、`apps/desktop`、`crates/media`） | 只学"边界怎么划"，不学具体实现 |
| Editor API / plugin-first / MCP / headless | OpenCut README 的**规划** | 当"路线图佐证"，不当"实现参考" |

### 0.2 video-use 的"原子工具"不是 Function Call schema

`browser-use/video-use` 的真实形态是：**一个 agent skill（`SKILL.md` 提示词）+ `helpers/` 下的 shell 脚本 + ffmpeg + ElevenLabs**。
它没有 JSON Schema 工具定义，靠的是"把脚本放进 agent 能读的目录，让模型自己组合命令"。

它真正值得抄的是**流程与 token 经济学**（原文）：

> **Layer 1 — Audio transcript (always loaded).** … All takes pack into a single ~12KB `takes_packed.md` — the LLM's primary reading view.
> **Layer 2 — Visual composite (on demand).** `timeline_view` produces a filmstrip + waveform + word labels PNG … Called only at decision points.
> Naive approach: 30,000 frames × 1,500 tokens = **45M tokens of noise**. Video Use: **12KB text + a handful of PNGs**.
>
> Pipeline: `Transcribe → Pack → LLM Reasons → **EDL** → Render → Self-Eval`（自检最多重渲 3 次）
> 设计原则：`Ask → confirm → execute → self-eval → persist`

**结论**：我们要自己定义 schema（这活没人替我们干），但**中间层必须是 EDL**（见 §4.4），
并且**永远不要把帧喂给模型**。

### 0.3 你的"桌面端"与现有代码是 Web 内核，这个决定要先做掉

现有仓库是 **TypeScript + React 19 + WebCodecs + WebGL2**，纯前端、无服务端，`dist/` 直接跑。
"桌面端"目前靠浏览器/内嵌面板；`persist/autosave.ts` 已经用 File System Access API 做真实文件读写。

**建议：不要现在换 Rust 内核。** 理由是成本/收益（§7.1 有完整论证）：
换内核 = 重写解码、合成、导出、音频四条主线，约等于把已经交付的 64 条需求推倒；
而**用户感知的差距不在内核，在入口组织**。桌面化用 **Tauri** 包一层即可（§7.2）。

---

## 1. 现状盘点（对着代码，不是对着想象）

### 1.1 已经有的（不要重做）

| 能力 | 位置 | 说明 |
|---|---|---|
| 四区骨架（素材 / 预览 / 时间线 / 属性） | `ui/App.tsx` + `ui/AssetPanel.tsx` + `ui/TimelineView.tsx` + `ui/InspectorPanel.tsx` | 已是剪映式布局，**不是三栏是四区**（属性栏独立） |
| 事务化撤销 | `core/store.ts` + `core/operations.ts` | 一次 `dispatch` = 一个撤销步，`invertOperation` 精确可逆 |
| **19 种**原子操作 | `core/types.ts` `ClipOperation` | `addClip / removeClip / moveClip / trimClip / splitClip / setClipProps / setClipEffect / setClipText / setClipKeyframes / setClipSpeed / setClipTransition / addTrack / removeTrack / renameTrack / setTrackFlag / removeAsset / restoreAsset / rippleShift / setProjectParams` |
| 唯一时基换算 | `core/timebase.ts`（`scripts/check-timebase.mjs` 静态守卫） | 所有帧↔时间换算只有一处，70 文件 0 违规 |
| 工程文件 | `persist/projectFile.ts`（`.vedproj`，`PROJECT_FILE_VERSION = 1`） | 已有信封（version/schemaVersion）+ 拒收过新版本 |
| 宿主命令 | `host/commands.ts`（postMessage：`getProject / setProject / importAsset / export`） | Agent 通道的雏形 |
| 自然语言 → 操作 | `ai/intents.ts`（10 种 intent）+ `ai/context.ts` | `compileIntents()` 已经产出 ops，**这就是 Agent 工具的现成编译层** |
| 导出 | `export/exporter.ts`（mp4 / gif / wav / png-zip） | 浏览器内编码 |
| 高频功能 | 字幕 SRT+ASR、粗剪（静音检测）、降噪、曲线/LUT/蒙版、多机位、代理、预设 | P0/P1/P2 共 64 条已交付 |
| 自检 | `ui/SelfCheck.tsx` + `__VEDITOR_TEST__` | 页面内 8 项体检 |

**关键判断**：功能面已经"够剪"。用户说的"不像剪映"，**不是功能缺失，是入口组织缺失**。

### 1.2 真正的缺口（按用户目标对齐）

| # | 缺口 | 对应目标 | 证据 |
|---|---|---|---|
| G1 | **时间轴没有 `onDrop`**：素材只能双击上轨，拖不进去 | 目标1-2 全拖拽 | `TimelineView.tsx` 无 drop 处理；`AssetPanel` 的 drop 是"整窗导入文件" |
| G2 | 左侧只有「素材」一个面板，没有 特效/字幕/音频/贴纸 分类 | 目标1-1 分类面板 | `ui/AssetPanel.tsx` 单一职责 |
| G3 | 特效/转场/文字样式没有**可视化缩略图预设库**（只有"存/套样式"的 preset） | 目标1-3 预设化 | `core/preset.ts` 是"抓取当前片段样式"，不是"素材库" |
| G4 | 属性栏默认就把曲线/LUT/蒙版/降噪/关键帧全摊开 | 目标1-3 默认隐藏专业参数 | `ui/InspectorPanel.tsx` 平铺所有分组 |
| G5 | Agent 工具没有**稳定契约**（只有 4 个 postMessage 命令 + NL intent） | 目标2-1/3 原子工具 | `host/commands.ts` 4 个 case |
| G6 | **没有无头渲染**：导出必须在页面里跑 | 目标2-2 Agent 只生成工程文件 | `export/exporter.ts` 依赖 `document`/`WebCodecs` |
| G7 | 工程文件只有"快照"，没有**操作日志**（Agent 改了什么无法审计/回放） | 目标2-2/3 | `projectFile.ts` 只序列化 `Project` |
| G8 | 没有 MCP server / 工具清单，豆包、DeepSeek Harness、WorkBuddy 无从发现能力 | 目标2-1 | 无 |

---

## 2. 参考项目逐项映射（学什么 / 不学什么 / 落到哪）

| 参考项目 | 学什么（原文依据） | 落到本仓库 | **明确不学** |
|---|---|---|---|
| **OpenCut（重写版）** | 仓库结构：`apps/web`(TanStack Start+React19+Vite) / `apps/api`(Elysia) / `apps/desktop`(GPUI) / `crates/media`(FFmpeg) → **UI 与媒体内核分属不同 crate，只通过 API 通信** | 保留现有 `ui/ ↔ core/ ↔ media/` 三层；新增 `agent/` 层只依赖 `core/`，**绝不 import `ui/`**（用 ESLint 规则钉死） | 它的 Rust 内核（还没写完）、它的功能细节、它的 GPUI 桌面端 |
| **OpenCut classic** | 剪映式三栏、时间轴交互密度、素材/属性分区 | 只补 G1/G2（拖拽 + 分类面板） | 视觉风格、小众功能 |
| **MLT Framework** | ① XML 图模型：`<producer>`(源) → `<playlist>`(顺序) → `<tractor>`(多轨叠加+`<transition>`) + `<filter>` 挂在任意节点；② `melt` CLI 无头渲染；③ 服务发现 = 插件目录 + metadata | ① 给 `Project` 定"图"的语义（§4.2）；② G6 无头渲染的 CLI 形态照 `melt`（`veditor render project.vedproj -o out.mp4`）；③ 插件 manifest 形状（§4.5） | 它的 C/SDL 架构、它"一切皆 service"的抽象（对我们过度） |
| **MoviePy** | 剪辑 API 的**简洁抽象**：`clip.subclip(t1,t2)`、`concatenate([a,b])`、`CompositeVideoClip`、`with_effects` —— **每个方法就是一句人话** | Agent 工具命名与签名直接照这个风格（`trim_clip` / `concat_clips` / `add_subtitle`），见 §5.2 | Python 实现、逐帧 numpy 内存模型 |
| **libopenshot** | ① `Keyframe` 是**一等对象**（点 + 左右贝塞尔手柄 + 插值模式），任何数值属性都可绑关键帧；② `Json()/SetJson()` 把整条时间线序列化成 JSON；③ 预览与离线渲染**共用同一个 `Frame` 管线** | ① 现有 `core/keyframes.ts` 是"每属性一串点"，升级成 libopenshot 式统一 `Keyframe`（§4.3）；② 工程文件用 JSON（已满足）；③ 预览/导出共用 `playbackEngine.renderFrame`（已满足，写进约束） | Qt 依赖、C++ API |
| **AutoCut** | "**字幕即剪辑清单**"：转写→生成 SRT/MD→你删掉不要的句子→按剩下的字幕行切视频 | G2 的「字幕」Tab + 文本剪辑视图（§3.4）：改文本 = 改时间线 | whisper 绑定、命令行形态 |
| **LosslessCut** | 基于 `ffmpeg -c copy` 的**无损裁剪**：只在关键帧切；非关键帧处需"智能剪切"（重编一小段）；同时支持音轨/字幕轨无损抽取 | ① 导出加「快速导出（不重编码）」模式；② 关键帧边界可视化（时间线画 I 帧刻度）；③ G8 的"抽轨"能力 | Electron 实现、它的批量合并脚本 |
| **PySceneDetect** | `ContentDetector`（HSV 帧差）/ `AdaptiveDetector`（对运动自适应）/ `ThresholdDetector`（淡入淡出）三件套 + `split-video` | G2「素材」Tab 的"自动分段"按钮；复用现有 `media/silence.ts` 的检测器写法（同一套"扫描→区间"模式） | Python/OpenCV |
| **video-use** | ① **EDL 作为 LLM 与渲染之间的唯一契约**；② 不喂帧、喂 12KB 文本 + 按需 filmstrip；③ 自检回路（渲完在每个切点自检，最多 3 次）；④ `Ask → confirm → execute → self-eval → persist` | §4.4 EDL、§5.3 token 策略、§5.4 自检回路 | shell 脚本形态、ElevenLabs 绑定 |
| **OpenMontage** | **三层分工**：pipeline（场景化流水线，12 条）× tool（原子工具，52/100+ 个）× skill（提示词与领域知识，500+） | §5.1 分层：`tool`=原子操作（我们的 15 个 op 投影）、`pipeline`=粗剪/字幕/成片等组合、`skill`=提示词包 | 它的工具数量与素材库 |

---

## 3. 剪映式 UI 交互规范（目标 1，最高优先级）

### 3.1 布局：四区不变，左侧从"一个面板"改成"五个 Tab"

```
┌──────────────────────────────────────────────────────────────┐
│ 顶栏：工程名 · 撤销/重做 · 比例 · 导出        [自检] [AI 命令] │
├────────────┬──────────────────────────────┬──────────────────┤
│ 左侧分类   │                              │ 右侧属性         │
│ 素材 特效  │        实时预览              │ （随选中变化）    │
│ 字幕 音频  │                              │                  │
│ 贴纸       │                              │                  │
│ ─────────  │                              │                  │
│ 该分类内容 │                              │                  │
│ （缩略图   │                              │                  │
│  网格）    │                              │                  │
├────────────┴──────────────────────────────┴──────────────────┤
│ 时间轴：工具栏（吸附/缩放/文本/轨道） + 标尺 + 多轨            │
└──────────────────────────────────────────────────────────────┘
```

**规范**：

- 左栏宽度 240px，Tab 用**文字**（素材/特效/字幕/音频/贴纸），不用图标——沿用本项目已定规矩："每个软件图标都不一样的功能必须写字"（`docs/PROJECT-STATUS.md` §3.13）。
- 点击 Tab **不弹窗、不切页**，只在下方换内容网格（剪映就是这样，切换零成本）。
- 右栏默认只显示 4 组：**基础（缩放/位置/旋转）、不透明度、音量、淡入淡出**。其余（曲线/LUT/蒙版/降噪/关键帧/变速）收进「更多」折叠区（G4）。

### 3.2 拖拽矩阵（G1 的核心，必须先做）

现在只有"双击上轨"。要补齐成下面这张表，**每一格都必须能用鼠标拖完成**：

| 拖什么 | 拖到哪 | 结果 | 现有基础 |
|---|---|---|---|
| 素材卡 | 时间轴任意轨道的任意位置 | 在该帧插入片段；落点有吸附；视频素材不许落音频轨 | `core/placement.buildPlaceAssetOps()`（已有，只需接 drop） |
| 素材卡 | 另一条轨道 | 跨轨插入（多机位入口） | 同上 |
| 特效卡 | **时间轴上的片段** | 给该片段加效果（落点高亮该片段） | `setClipEffect`（已有） |
| 转场卡 | **两个片段的接缝** | 给左片段加 `transitionOut`；接缝高亮 | `setClipTransition`（已有） |
| 文字预设 | 时间轴 | 在该帧插入文字片段 | `createTextContent`（已有） |
| 音频卡 | 音频轨 | 插入音频片段 | `buildPlaceAssetOps`（已有） |
| 时间轴片段 | 时间轴 | 移动/跨轨 | `moveClip`（已有，控制器已实现） |

**实现要点**（照 OpenCut classic 的交互，不照它的代码）：

1. `dataTransfer.setData('application/x-veditor-asset', assetId)` 之类**自定义 MIME**，不用 `text/plain`（避免和"拖文件进窗口导入"打架——`AssetPanel` 已监听整窗 drop，见 `AssetPanel.tsx:205`）。
2. 时间轴 `onDragOver` 必须 `preventDefault()` 才允许 drop（浏览器硬要求）。
3. 拖到片段上时用 `ephemeral.dropTarget` 高亮，**不写 doc**（沿用"拖动期间不 dispatch"铁律）。
4. 落点换算走 `laneX()` → 帧，禁止在 drop 处理里自己算 `clientX/zoom`（`timebase` 守卫会拦）。

### 3.3 预设化（G3）：三层结构

```
预设库（左侧 Tab 内容）
  └─ 分类（如 特效 → 滤镜 / 光效 / 故障 / 复古）
       └─ 预设卡（缩略图 + 名称）  ← 一键应用，默认零参数
```

- **缩略图必须是"真画面"**：用当前预览帧跑一遍该预设，截 160×90 存 IDB（照 `media/mediaProbe.ts` 现有缩略图管线，别另写一套）。
- **预设 = 数据，不是代码**：一个预设就是一段 `ClipOperation` 模板（`{ op:'setClipEffect', to:{ type, params } }`），
  这样"点预设"和"Agent 调工具"走**同一条路**（这是目标 2-1 的硬要求）。
- 参数默认全隐藏；想调的人右键预设卡 →「调整参数」才展开右栏（剪映也是这么藏的）。

### 3.4 文本剪辑（学 AutoCut）

「字幕」Tab 提供两种视图：

1. **时间线视图**（默认）：字幕片段在轨道上，可拖可裁。
2. **文本视图**：一个 textarea，每行 = 一条字幕。
   - 删掉一行 → 对应字幕片段被删（`removeClip`）；
   - 改一行文字 → `setClipText`；
   - 在文本视图里按 Enter 拆行 → `splitClip` + 两段 text。

这条功能的**验收标准**：删掉一行文本后，时间线上对应的字幕片段消失，且**一次 Ctrl+Z 能整体回来**（因为是一批 ops）。

### 3.5 高频功能前置（目标 1-4）

一级入口只放 6 个（其余收进二级）：

| 一级入口 | 位置 | 现有能力 |
|---|---|---|
| 裁剪（拖片段两端） | 时间线 | ✅ |
| 分割（`B`） | 时间线 | ✅ |
| 文字/字幕 | 左侧 Tab | ✅（属性栏里，需提升） |
| 转场 | 左侧 Tab | ✅（属性栏里，需提升） |
| 音频降噪 | 右键片段 / 属性栏一级 | ✅ |
| 一键抠像 | 左侧「特效」→ 抠像 | ❌ 待做（见 §6 P2） |

---

## 4. 统一工程文件格式 v2（目标 2 的地基）

### 4.1 为什么不是"重新设计一套格式"

**`Project` JSON 已经是唯一真相源**：所有改动都必须走 `store.dispatch(ops)`，
GUI 与 Agent 只要都产出 `ClipOperation[]`，就自动共用同一条渲染/撤销/持久化链路。
所以 v2 的活是**补齐三件事**，不是新建：

1. **版本化与迁移**（现在 `PROJECT_FILE_VERSION=1` 只会"拒收过新版本"，没有"升级旧版本"）；
2. **操作日志**（G7：只有快照，Agent 改了什么无法审计）；
3. **外部引用稳定化**（素材路径/哈希，跨机器可迁移）。

### 4.2 文件结构（沿用现有信封，加两个块）

```jsonc
{
  "format": "veditor-project",
  "version": 2,                    // 文件格式版本（v1 可无损升级到 v2）
  "schemaVersion": 2,              // 工程结构版本（Project.schemaVersion）
  "createdAt": 1790000000000,
  "updatedAt": 1790000000000,

  "project": { /* 现有 Project，字段不变 */ },

  // 新增 A：操作日志（可选，但 Agent 写入时必须带）
  "journal": {
    "base": "snapshot",            // 这份 project 是快照
    "entries": [
      {
        "id": "op_01H...",
        "at": 1790000000123,
        "actor": "agent",          // "human" | "agent" | "system"
        "actorName": "doubao",     // 可选
        "label": "去掉停顿",
        "ops": [ /* ClipOperation[] —— 与 store 用的是同一个联合类型 */ ],
        "inverse": [ /* 便于回放/撤销 */ ]
      }
    ]
  },

  // 新增 B：素材引用（跨机器可迁移）
  "media": [
    {
      "assetId": "ast_xxx",
      "sha256": "…",               // 内容哈希：换机器靠它重新定位
      "relPath": "footage/a.mp4",  // 相对工程文件的路径（首选）
      "size": 12345678,
      "probe": { "fpsMilli": 30000, "durationFrames": 240, "hasAudio": true }
    }
  ]
}
```

**依据**：`persist/projectFile.ts` 已有信封与版本检查；MLT 的 `.mlt` 也是"一个 XML 同时描述工程与可渲染图"，
但它把 `producer` 也塞进同一棵树里——我们**不学这一点**，因为我们的素材是"外部文件引用 + 哈希"，
把字节塞进工程文件会让文件从 KB 变 GB。libopenshot 的 `Json()` 同样是"整条时间线一份 JSON"，与我们的方向一致。

### 4.3 关键帧结构升级（学 libopenshot）

现状：`core/keyframes.ts` 是"每条属性一串 `{frame, value}`"，线性插值。
libopenshot 的 `Keyframe` 是**一等对象**（点 + 左右手柄 + 插值模式），所以同一个 `scale` 既能线性也能贝塞尔。

**建议的 v2 形状**（向后兼容：老数据视为 `mode: 'linear'`）：

```jsonc
{ "frame": 30, "value": 1.5, "ease": "linear" }   // 旧
{ "frame": 30, "value": 1.5, "ease": "bezier",    // 新
  "handleLeft":  { "frame": 22, "value": 1.2 },
  "handleRight": { "frame": 38, "value": 1.8 } }
```

**收益**：右栏"缓入缓出"变成预设按钮（用户能看懂），而不是让用户填贝塞尔数字。

### 4.4 EDL：Agent 与渲染之间的唯一契约（学 video-use）

**这是整个 Agent 方案最重要的一条**。

```
自然语言 ──(LLM)──> EDL ──(确定性编译)──> ClipOperation[] ──(store.dispatch)──> Project
                      ↑                         ↑
                 模型只需要会写这个        我们已有的 15 种原子操作
```

EDL（Edit Decision List）**不是新格式**，它是 `Project` 的一个**受限视图**：只有"片段清单 + 每段的源入出点 + 轨道"，没有 UI 状态、没有 zoom、没有 playhead。

```jsonc
{
  "version": 1,
  "fpsMilli": 30000,
  "canvas": { "width": 1920, "height": 1080 },
  "tracks": [
    { "kind": "video", "name": "V1", "items": [
      { "asset": "a.mp4", "srcIn": 120, "srcOut": 300, "start": 0,
        "speed": 1.0, "effects": ["denoise"] }
    ]},
    { "kind": "audio", "name": "A1", "items": [
      { "asset": "bgm.mp3", "srcIn": 0, "srcOut": 900, "start": 0, "gain": 0.6 }
    ]}
  ],
  "subtitles": [ { "text": "第一句", "start": 0, "end": 90 } ]
}
```

**为什么必须有这一层**（不是多此一举）：

1. **token 预算**：完整 `Project` 有 30+ 字段/片段，EDL 只有 6 个。模型写错的概率与字段数成正比。
2. **可校验**：EDL → ops 的编译是**纯函数**，可以在服务端/CLI 里跑单测（我们能测，模型不用猜）。
3. **video-use 已经证明这条路可行**：它的 LLM 只产出 EDL，渲染由脚本确定性完成，自检回路只回看渲染结果。

### 4.5 插件 manifest（学 MLT 的 service metadata，但只做最小版）

AI 功能（字幕、抠像、场景识别）做成可插拔插件（用户架构原则 3）。最小 manifest：

```jsonc
{
  "id": "veditor.matte",
  "name": "一键抠像",
  "kind": "effect",              // effect | transition | tool | pipeline
  "inputs": { "type": "videoFrame" },
  "params": { "mode": { "enum": ["person", "background"], "default": "person" } },
  "runtime": "worker",           // 跑在 Web Worker，不阻塞 UI
  "weight": 0                    // 是否允许出现在一级入口
}
```

**不学 MLT 的部分**：它用 C 插件 + 目录扫描发现服务；我们用 JSON manifest + 动态 `import()`，
因为我们的插件是 TS/WASM，不是 so/dll。

---

## 5. Agent 原子工具接口（目标 2-3）

### 5.1 三层分工（照 OpenMontage）

| 层 | 是什么 | 我们的实现 | 数量 |
|---|---|---|---|
| **tool** | 原子操作，一次只做一件事，可直接映射到 `ClipOperation` | 15 个编辑工具（19 个 op 的投影）+ 4 个查询工具 | 19 |
| **pipeline** | 场景化流水线（多步、有中间产物） | 粗剪 / 字幕 / 成片 | 3–5 |
| **skill** | 提示词 + 领域知识（什么时候用哪个工具） | `skills/*.md`，可被 agent 直接读 | 3+ |

### 5.2 工具清单（命名照 MoviePy 的"一句人话"风格）

```jsonc
// —— 查询类（只读，模型用来"看"工程，不消耗撤销栈）——
{ "name": "get_project_summary",  "desc": "工程概况：时长、轨道数、片段数、素材列表" }
{ "name": "get_timeline",         "desc": "按轨道返回片段清单（EDL 视图，不含 UI 状态）" }
{ "name": "get_transcript",       "desc": "返回转写文本（带时间戳），可按区间过滤" }
{ "name": "get_frame_strip",      "desc": "返回某区间的胶片条 PNG（决策点才调用）" }

// —— 编辑类（写操作，全部返回 { ops, undoLabel }）——
{ "name": "import_media",   "args": { "path": "string" } }
{ "name": "add_clip",       "args": { "assetId": "string", "trackId": "string?", "start": "frame" } }
{ "name": "trim_clip",      "args": { "clipId": "string", "srcIn"?: "frame", "srcOut"?: "frame" } }
{ "name": "split_clip",     "args": { "clipId": "string", "at": "frame" } }
{ "name": "move_clip",      "args": { "clipId": "string", "start": "frame", "trackId"?: "string" } }
{ "name": "delete_clip",    "args": { "clipId": "string", "ripple"?: "boolean" } }
{ "name": "set_speed",      "args": { "clipId": "string", "speed": "number" } }
{ "name": "add_transition", "args": { "clipId": "string", "side": "in|out", "type": "string", "seconds": "number" } }
{ "name": "add_text",       "args": { "text": "string", "start": "frame", "end": "frame", "style"?: "string" } }
{ "name": "add_subtitles",  "args": { "srt": "string" } }
{ "name": "apply_effect",   "args": { "clipId": "string", "effect": "string", "params"?: "object" } }
{ "name": "detach_audio",   "args": { "clipId": "string" } }
{ "name": "freeze_frame",   "args": { "clipId": "string", "at": "frame", "seconds"?: "number" } }
{ "name": "reverse_clip",   "args": { "clipId": "string" } }
{ "name": "render",         "args": { "format": "mp4|gif|wav|png", "range"?: "[start,end]" } }
```

**设计约束（必须写进实现）**：

1. **每个 tool 的返回值都必须是 `{ ok, ops, undoLabel }` 或 `{ ok:false, message }`**——
   与 `core/detachAudio.ts` / `core/freeze.ts` 现有"返回可读原因而不是抛错"的约定一致。
2. **tool 不许直接改 doc**：一律走 `store.dispatch(ops, label)`，这样 Agent 的每一步都可撤销（用户在 GUI 里按 Ctrl+Z 就能撤掉 AI 的操作——这条已经是现状，别破坏）。
3. **一个 tool 调用 = 一个撤销步**。像"去掉停顿"这种要删 20 段的，必须**一批 ops 一次 dispatch**（`core/rippleDelete.ts` 已经是这么做的）。

### 5.3 与现有代码的接线（不要另起一套）

```
agent/tools.ts        ← 新增：工具定义（JSON Schema）+ 实现，只 import core/
        ↓
ai/intents.ts         ← 已有：NL → intent → compileIntents → ops（继续用）
        ↓
core/operations.ts    ← 已有：applyOperation / invertOperation
```

新增 `agent/` 目录（不放进 `ai/`，因为 `ai/` 是"自然语言理解"，`agent/` 是"对外工具契约"）：

```
src/agent/
  schema.ts      # 工具 JSON Schema（可导出给 MCP / function call）
  tools.ts       # 每个 tool 的实现（薄，只做参数校验 + 调 core）
  edl.ts         # EDL ↔ Project 双向转换（纯函数，可单测）
  mcp.ts         # MCP server 适配（stdio / http）
  headless.ts    # 无头渲染入口（Node 侧）
```

### 5.4 自检回路（学 video-use）

Agent 渲染完**不能直接交付**，必须回看：

```
render → 抽 N 个切点 → get_frame_strip(切点±3帧) → 检查：黑帧？跳变？字幕被挡？ → 有问题修 + 重渲（最多 3 次）
```

我们的 `ui/SelfCheck.tsx` 已经有 8 项检查（WebCodecs/解码/出画/音频排期/…），
**把它抽成 `core/selfcheck.ts` 纯函数**，GUI 与 Agent 共用——这比新写一套检查器划算，也符合"GUI 与 Agent 共用同一套引擎"。

### 5.5 Token 策略（学 video-use 的 12KB 原则）

| 给模型看什么 | 大小 | 何时 |
|---|---|---|
| 工程概况（`get_project_summary`） | < 1KB | 每次会话开头 |
| 转写文本（`get_transcript`） | ~12KB / 10 分钟素材 | 需要按语义剪时 |
| 胶片条 PNG（`get_frame_strip`） | 1 张 / 次 | 只在决策点 |
| **绝不**给整段帧序列 | 45M tokens | 永不 |

---

## 6. 路线图（按"用户体感 ÷ 成本"排序）

### P0：让"简单"这件事成立（2–3 周量级）

| # | 任务 | 验收标准 | 依据 |
|---|---|---|---|
| P0-1 ✅ | **时间轴拖拽**（G1）：素材/音频拖进去（已完成） | `verify-dragdrop` 19 项：落点误差 ≤1 帧、吸附贴齐、预览=落点、视频拖音轨被拒、`dragend` 清预览 | 目标1-2；`placement` 已有 |
| P0-1b | 拖特效到片段 / 拖转场到接缝 / 拖文字预设 | 依赖 P0-4 的预设库（要先有卡片才能拖） | 同上 |
| P0-2 | **左侧五 Tab**（G2）：素材/特效/字幕/音频/贴纸 | 点 Tab 内容切换 < 16ms（不掉帧）；五个 Tab 都有内容（贴纸可先放"纯色/形状"占位） | 目标1-1 |
| P0-3 | **右栏折叠**（G4）：默认只留 4 组 | 打开工程时属性栏高度 ≤ 一屏；「更多」里能展开全部 | 目标1-3 |
| P0-4 | **预设库**（G3）：至少 12 个特效预设 + 6 个转场 + 6 个文字样式，全部有真实缩略图 | 点预设 → 预览立刻变；一个撤销步；缩略图非占位色块 | 目标1-3；`mediaProbe` 缩略图管线 |

### P1：让 Agent 真的能驱动（3–4 周量级）

| # | 任务 | 验收标准 | 依据 |
|---|---|---|---|
| P1-1 | **工程文件 v2**（G7）：journal + media 引用 + 迁移 | v1 文件能无损打开并升级；v2 文件带 journal 时能逐条回放 | §4.2；`projectFile.ts` |
| P1-2 | **EDL 双向转换**（§4.4） | `edl.test.mjs`：EDL→ops→Project→EDL 幂等；非法 EDL 给可读错误 | video-use |
| P1-3 | **工具层 + MCP**（G5/G8） | 19 个 tool 有 JSON Schema；MCP server 能被客户端 list/call；每个 tool 有单测 | MoviePy 命名 + OpenMontage 分层 |
| P1-4 | **无头渲染**（G6） | `veditor render x.vedproj -o out.mp4` 在 Node 里跑通（无 DOM） | MLT `melt` |
| P1-5 | **自检抽成纯函数** | GUI 的 8 项与 Agent 的检查调同一个函数 | video-use 自检回路 |

### P2：补齐剪映式高频特色（按需）

| # | 任务 | 依据 |
|---|---|---|
| P2-1 | 文本剪辑视图（改字 = 改片） | AutoCut |
| P2-2 | 自动分段（镜头边界识别） | PySceneDetect 三检测器 |
| P2-3 | 快速导出（无损剪切，关键帧边界） | LosslessCut `-c copy` |
| P2-4 | 一键抠像（可插拔插件，Web Worker） | 用户架构原则 3 |
| P2-5 | 缓动曲线关键帧 | libopenshot `Keyframe` |

**为什么 P0 全是 UI、P1 才是 Agent**：用户定的优先级就是 UI 第一；
而且 P0-1（拖拽）会改 `TimelineView` 的事件层，**先做完再动工程文件格式，能少改一遍**。

---

## 7. 风险与取舍（要明说的）

### 7.1 现在换 Rust 内核 = 推倒重来，不建议

| 维度 | 现有 Web 内核 | 换 Rust（OpenCut 路线） |
|---|---|---|
| 已交付功能 | 64 条需求 / 462 单测 / 46 E2E 全部基于 TS | 全部重写 |
| 解码 | WebCodecs（H.264/HEVC/VP8/VP9/AAC/Opus 已验证） | FFmpeg 绑定（更强，但要跨平台构建） |
| 合成 | WebGL2（已实现调色/曲线/LUT/蒙版/转场） | wgpu（要重写着色器链） |
| 桌面化 | Tauri 包一层即可 | 本来就要 Tauri |
| 主要短板 | 4K 多轨性能、无头渲染 | 无 |

**结论**：短板是"性能"和"无头"，这两个都能**局部**解决（代理已做、无头用 Node+WASM 解码），
不需要换内核。**等 P2 之后再评估**。

### 7.2 桌面化路径：Tauri（不是 Electron）

- 体积：Tauri ~10MB vs Electron ~150MB；
- 我们已经是纯前端，`dist/` 直接塞进 Tauri 的 webview；
- `persist/autosave.ts` 的 File System Access 在 Tauri 里换成它的 fs API（一个适配层，`host/` 已经有抽象位置）。
- **风险**：WebCodecs 在 WebView2（Windows）上有版本差异——需要 P0 阶段先做一次兼容性验证（现有 `SelfCheck` 直接能测）。

### 7.3 无损快剪的边界（LosslessCut 那条）

`ffmpeg -c copy` 只能在**关键帧**切。用户拖到任意帧时：
- 若该帧是关键帧 → 真正无损；
- 否则 → 要么"从上一个关键帧切"（画面会多几帧），要么"重编这一小段"（不是无损）。
**必须在 UI 上把关键帧画出来**（时间线标尺加 I 帧刻度），否则用户会觉得"切不准"。
这条是 LosslessCut 的核心妥协，我们不能假装没有。

### 7.4 三个"不要做"

1. **不要**把 `Project` 全量喂给模型（30+ 字段/片段，必错）；
2. **不要**让 Agent 直接调 `store`（必须经 `agent/tools.ts`，否则没有参数校验与可读错误）；
3. **不要**为了"专业"把参数摊在默认界面上（目标 1-3 明说默认隐藏）。

---

## 8. 进度与下一步

### 已完成（2026-10-22）

**P0-1 时间轴拖拽** ✅

- 素材卡可拖（`ui/dnd.ts` 自定义 MIME `application/x-veditor-asset`，与"拖文件进窗口导入"互不干扰）
- 时间轴 `onDragOver/onDragLeave/onDrop`（`ui/TimelineView.tsx`）
- 落点预览（`EphemeralState.dropGhost` + `render/timelinePainter.drawDropGhost`）：**预览即落点**
- 落点走吸附（复用 R-022 `snapFrame`；`Alt` 临时关、`N` 整体关）
- 拖拽校验下沉到 `core/placement.buildPlaceAssetOps({ trackId })`：
  视频拖音轨 / 锁定轨 / 隐藏轨 / 轨不存在 → 可读原因，**不偷偷换轨**
- 顺手修掉一个老 bug：`timelinePainter` 的行号用的是**存储顺序**而不是显示顺序，
  导致 V2 上片段的拖动 ghost 画到了 A1 那行（E2E 只拖过 V1 所以一直没暴露）

### 下一步

1. **P0-2/P0-3/P0-4**（左侧五 Tab / 右栏折叠 / 预设库）：做完 P0-4 才能把"拖特效、拖转场"接上（P0-1b）。
2. **P1-2 EDL 转换器**：纯函数、可单测，做完"Agent 只生成工程文件"就从口号变成可验证能力。
