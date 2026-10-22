# 交互优化与功能补全方案（2026-10-22）

> 目标：**剪映式简单易用**（第一优先级）+ **AI/Agent 可调度**（架构底座）。
> 原则：**不引入任何"专业复杂"设计**——凡是要用户理解"轨道/节点/关键帧/矩阵"的概念，一律换成预设。
>
> 所有条目都对着本仓库现有代码写：标 ✅ 的是已经做完的，其余给"落在哪个文件、怎么验收"。
> 相关：`docs/product-plan.md`（路线图/工程文件/Agent 工具）、`docs/nle-baseline.md`（剪映与 PR 的行为对照）。

---

## 0. 一页结论

| 维度 | 现状 | 结论 |
|---|---|---|
| 四区骨架 | ✅ 素材栏 / 预览 / 时间线 / 属性栏 | **不改骨架**，只补内容与入口 |
| 拖拽 | ✅ 素材卡 → 时间轴任意轨（P0-1） | 把拖拽协议**扩展到特效/转场/文本/音频** |
| 音量 | ✅ 分段线性 dB（0%=静音，100%=0dB，200%=+12dB）+ 软限幅 | 已完成，见 §3.2 |
| 左侧分类 | ❌ 只有「素材」一个面板 | **第一优先级第一件事**：7 个 Tab |
| 时间轴 | ✅ 吸附/缩放/轨道增删/滚动 | 缺**波形**、轨道头缺**独奏**、缺快捷按钮组 |
| 属性栏 | ✅ 参数齐全 | 缺**分组折叠**与**画布直接拖拽** |
| 字幕 | 🟡 SRT 导入导出 + ASR 端口 | 缺样式/描边/动画预设与文本视图 |
| AI | 🟡 命令栏 + 10 种意图 + 转写端口 | 缺**常驻助手入口**与右键 AI |

**三步走**（对齐你给的节奏）：
1. **交互骨架**（1–2 周）：左侧 7 Tab + 音频波形 + 画布拖拽 + 顶部工具栏
2. **三大核心**（2–3 周）：字幕样式/动画、转场与滤镜预设库、一键音频三件套
3. **AI 与打磨**（持续）：AI 助手面板、右键 AI、工程文件 v2、细节

---

## 1. 第一优先级：UI 布局与交互

### 1.1 左侧分类面板（7 个 Tab，可折叠）

**结构**

```
src/ui/LibraryPanel.tsx        ← 新：Tab 壳 + 折叠 + 拖拽源
src/ui/library/
  AssetTab.tsx                 ← 现有 AssetPanel 的列表部分搬进来（逻辑不动）
  AudioTab.tsx                 ← 内置音乐/音效（先放"从素材库选音频"）
  TextTab.tsx                  ← 文字样式预设 + 「AI 生成字幕」按钮
  StickerTab.tsx               ← 贴纸（先用内置 SVG 形状，后续可扩展）
  TransitionTab.tsx            ← 转场预设（缩略图）
  EffectTab.tsx                ← 特效（滤镜/光效/故障…）
  FilterTab.tsx                ← 风格滤镜（与特效分开展示，剪映也是分开的）
src/ui/library/catalog.ts      ← 预设数据（纯数据，不是代码）
```

**为什么"滤镜"和"特效"分开**：剪映里「滤镜」是一键整体色调（有强度滑块），「特效」是局部/动态效果（如故障、光效）。
用户找东西时是按这两个词找的，合并成一个 Tab 反而更难找。

**Tab 壳的行为**

- 宽 240px；点击 Tab **只换下方网格**，不弹窗、不切页（切换成本为 0）。
- 左侧边缘有折叠按钮：折叠后 56px 宽，只剩竖排文字 Tab。
- 折叠状态存 `localStorage`（`veditor.library.collapsed`），**不进工程文件**——这是"我的习惯"，不是"这个工程的样子"。

**卡片（LibraryItem）**

```ts
export interface LibraryItem {
  id: string;                 // 'fx.vintage' / 'tr.v.fade' / 'text.title'
  name: string;               // 「复古」「叠化」「标题」
  kind: 'effect' | 'transition' | 'text' | 'sticker' | 'audio';
  /** 缩略图（真画面渲染出来的 160×90 PNG，见下）。 */
  thumbnailRef: string;
  /** 应用到时间线时用的操作模板（**数据**，不是回调）。 */
  payload: ClipOperation[] | TextContent | { effectType: string; params: Record<string, number | string> };
}
```

**缩略图必须是真画面**（不是色块）：
用当前选中片段（没有就用素材库第一段）的一帧，套上该预设跑 `renderPreviewFrame` → `captureFrame` → 160×90 →
存 IDB 新表 `library-thumbs`（key = itemId + 源帧指纹）。**同一预设只生成一次**，之后直接读。

**拖拽协议**（扩展 `ui/dnd.ts`，一格 MIME 对一个落点）

| 拖的是 | MIME | 落在哪 | 结果 |
|---|---|---|---|
| 素材卡 | `x-veditor-asset` ✅ | 时间轴任意轨 | `buildPlaceAssetOps` |
| 特效卡 | `x-veditor-effect` | **片段上**（高亮该片段） | `setClipEffect` |
| 转场卡 | `x-veditor-transition` | **两个片段的接缝**（高亮接缝） | 左片段 `setClipTransition(out)` |
| 文本预设 | `x-veditor-text` | 时间轴 | 在该帧插入文字片段 |
| 音频卡 | `x-veditor-audio` | 音频轨 | `buildPlaceAssetOps({trackId})` |
| 贴纸 | `x-veditor-sticker` | 时间轴 | 插入贴纸片段（= 文字/图形片段） |

**验收**：7 个 Tab 都有内容；点 Tab 切换 < 16ms 不丢帧；拖特效到片段上，该片段 `effects` 多一项且预览立刻变；一次 Ctrl+Z 撤回。

---

### 1.2 时间轴

#### (a) 音频波形（用户点名的第一条）

```
src/media/waveform.ts          ← 新：按素材算峰值包络
src/persist/db.ts              ← 加表 waveform（key: assetId + 采样密度）
src/render/timelinePainter.ts  ← 在片段块下半部画波形
```

- **数据**：每 10ms 一个峰值（100 桶/秒）。10 分钟素材 = 60000 个 float32 = 240KB，可接受。
- **怎么算**：用现有解码器池按块解 PCM（复用 `audioEngine` 的 `decodeAudioRange`），**只算峰值不保留 PCM**，算完立即释放。
- **怎么画**：`zoom × 帧率 / 100` 决定每个桶占几像素；< 1px 时合并相邻桶取最大。
- **静音段识别**：连续 8 个桶峰值 < -45dB → 画一段浅色底（对齐剪映的"静音标记"），**不做自动删除**（那是"智能粗剪"的活，已有 `ai/roughCut`）。
- **卡点对齐**：波形只是"看得见"，真正的"卡点"用**吸附**（已有 `snapFrame`）+ 播放头；不引入"节拍检测"这种重功能。

**验收**：音频片段上能看到波形；波形与声音对得上（拖播放头到波峰，听到重音）；缩放后波形不糊（桶合并而非拉伸位图）。

#### (b) 轨道头控制区

现有：`静/隐/锁/删` + 双击改名 ✅。要补：

| 按钮 | 状态 | 实现 |
|---|---|---|
| 静音 | ✅ | `setTrackFlag('muted')` |
| 隐藏 | ✅ | `setTrackFlag('hidden')` |
| 锁定 | ✅ | `setTrackFlag('locked')` |
| 重命名 | ✅ | 双击轨道头 |
| 删除轨道 | ✅ | `removeTrack` |
| **独奏（Solo）** | ❌ 新增 | `Track.solo?: boolean` + `setTrackFlag('solo')` |
| **＋视频轨 / ＋音频轨 / ＋字幕轨** | 部分（只有"＋轨道"） | 三个按钮，直接建对应类型 |

**独奏的语义必须收敛到一处**：
```ts
// src/core/trackAudibility.ts（新）
export function isTrackAudible(doc: Project, track: Track): boolean {
  const soloed = doc.tracks.filter((t) => t.solo === true);
  if (soloed.length > 0) return track.solo === true && !track.muted;
  return !track.muted;
}
```
`playbackEngine.collectVisibleClips`、`audioEngine.audibleClips`、`export/audioMix.audibleClipsFor` 三处**全部改调它**。
（现在这三处各写一遍 `muted || hidden`，加 solo 后不同步就会出现"预览有画面、导出没画面"。）

**字幕轨**：`TrackKind` 从 `'video' | 'audio'` 扩到 `+ 'text'`。
- 迁移：老工程里的文字片段在视频轨上，仍然合法（`kind: 'video'` 的轨可以放 text 片段）。
- 收益：文字不再和画面抢轨道，用户拖字幕时不用先想"放哪条"。

#### (c) 缩放

- 工具栏右侧：`－  [滑块]  ＋`，范围沿用 `clampZoom`（1–20 px/帧）。
- 滑块值 = `zoomLevel`，拖动时**以播放头为锚**（复用 `zoomScrollX`，与 Ctrl+滚轮同一套）。
- 旁边显示"总时长"（已有）。

#### (d) 顶部快捷操作按钮组

`分割 | 删除 | 波纹删除 | 吸附 | 撤销 | 重做`

- **全部调用现有能力**：`splitAtPlayhead()` / `removeSelectedClip()` / `rippleDeleteSelectedClip()` / `store.toggleSnap()` / `store.undo()`，**不新增逻辑**。
- **不做"选择/切割/手型"模式切换**：我们只有一种交互（点选 + 拖边裁切），加模式只会让用户"点了没反应"。
  这一点与你的原始要求有偏差，理由写在这里：**模式是专业软件的习惯，不是剪映的习惯**。

**验收**：分割按钮与 `B` 键结果完全一致；波纹删除后后面的片段整体前移且撤销一步回退；按钮在无选中片段时置灰并给出 title 说明。

---

### 1.3 右侧属性面板

#### (a) 分组折叠

```
基础变换（缩放/位置/旋转/翻转/不透明度/混合）
画面调节（亮度/对比度/饱和度/色温/曲线/LUT/蒙版/降噪）
速度时长（速度/时长/定格/倒放）
音频设置（音量 dB/淡入/淡出/一键降噪/人声增强/背景闪避）
```

- 默认展开：**基础变换** + （片段有音频时）**音频设置**；其余折叠。
- 折叠状态存 `localStorage`（按组 id），不写工程。
- 组标题右侧显示"已改过"的小圆点（该组有非默认值），让用户知道"这组被我动过"。

#### (b) 预览窗口直接拖拽（这条决定"专业感"）

```
src/ui/PreviewStage.tsx        ← 加一层 <canvas> 上的交互覆盖层
src/render/previewOverlay.ts   ← 新：画选中框 + 8 个缩放手柄 + 旋转手柄
```

- **只在"有选中片段 且 播放头在该片段内"时**显示选择框（否则不干扰观看）。
- 拖动框内 → 改 `transform.x/y`；拖四角 → 改 `transform.scale`（等比）；拖顶部圆点 → 改 `transform.rotation`（**吸附到 15°**，Shift 取消吸附）。
- 每次拖动用 `dispatch(..., { mergeKey: 'preview-drag:<clipId>' })`（本仓库已支持）→ **一次拖动 = 一个撤销步**。
- 右栏数字输入保留，作为"精确微调"（拖动优先，输入补充）。
- 坐标换算必须复用 `render/frameTransform.ts` 的 `onScreenFit`/`quadForRotation`，**不能在 UI 里另写一套 fit**（否则拖动和渲染会差几个像素）。

**验收**：拖预览里的片段，画面跟手（≤1 帧延迟）；松手后右栏 X/Y 数值同步；Ctrl+Z 一次回到拖动前。

---

### 1.4 顶部快捷工具栏

```
┌ 菜单（工程 ▾） ──────────────────────────────────────── [导出] ┐
│ 撤销 重做 │ 分割 删除 波纹删除 │ 16:9 9:16 1:1 │ 吸附 │  AI 助手 │
└───────────────────────────────────────────────────────────────┘
```

- 新增 `src/ui/QuickToolbar.tsx`，放在菜单栏下方（24→28px 高）。
- **导出**：右上角主色按钮（现有 `export-open` 移过来）。
- **工程 ▾（二级菜单）**：新建/打开/保存工程、导入工程、**自检**、主题、关于。
  - 自检从顶栏主位置移进二级菜单（它偏开发向，用户一年用不了两次）。
- **比例切换**：`16:9 / 9:16 / 1:1` 三个按钮 → `setProjectParams({width,height})`。
  注意：改比例**不缩放片段**，靠合成器的 contain 自适应（已验证），但**要在切换后重绘当前帧**，否则预览停在旧尺寸。

**验收**：工具栏不换行（1280 宽下仍一行）；导出按钮在右上角且比其它按钮显眼；比例切换后预览立刻变、工程参数同步、撤销可回退。

---

## 2. 第二优先级：核心功能

### 2.1 文本 / 字幕

**现状**：`Clip.text` + `render/textLayer.ts`（画文字）+ SRT 导入导出 + ASR 端口。

**要补的三件事**

1. **样式**：`TextContent` 扩展（向后兼容，全部可选）
```ts
export interface TextContent {
  content: string;
  fontSize: number;
  color: string;
  align: 'left' | 'center' | 'right';
  // 新增（都可选，缺省 = 现在的行为）
  fontFamily?: string;                     // 'system' | 'serif' | 'mono'
  bold?: boolean;
  stroke?: { width: number; color: string } | null;   // 描边
  shadow?: { x: number; y: number; blur: number; color: string } | null;
  background?: { color: string; opacity: number } | null;  // 字幕底条
  animationIn?: TextAnimation;             // 'none' | 'fade' | 'slideUp' | 'pop'
  animationOut?: TextAnimation;
  animationFrames?: Frame;                 // 动画时长（默认 12 帧 ≈ 0.4s）
}
```
2. **动画预设 = 枚举**，不是关键帧：`animationIn: 'slideUp'` 在 `textLayer` 里按"片段内偏移"算位移与透明度。
   **绝不把关键帧编辑器暴露给用户**——剪映也是这么做的（"入场动画"就是一排缩略图）。
3. **文字样式预设**：`ui/library/catalog.ts` 里 6 个（标题/副标题/字幕/花字/标签/引用），一键套用 = 一条 `setClipText`。

**AI 字幕入口**：文本 Tab 顶部一个按钮「AI 生成字幕」→ 走 `AIModelPort.transcribe`（端口已有）→
`subtitle/srt.buildSubtitleReplaceOps` 落时间线（已有，整段替换 + 一步撤销）。

**验收**：改字号/颜色/描边立刻生效；选一个入场动画，播放时文字从下方滑入；6 个预设一键套用；AI 字幕按钮在没有 provider 时给"未配置"提示而不是报错。

---

### 2.2 音频处理（一键三件套）

| 功能 | 状态 | 做法 |
|---|---|---|
| 音量（dB） | ✅ 已完成 | `core/volume.ts`：0%=静音 / 100%=0dB / 200%=+12dB，软限幅 |
| 淡入淡出 | ✅ | `clip.audio.fadeInFrames/fadeOutFrames` |
| 一键降噪 | ✅ | `media/denoise.ts`（噪声门 + 高通） |
| **人声增强** | ❌ 新增 | 降噪的预设变体：`denoise({threshold:-35, enhance:1})` + 2kHz 以上轻微提升。**一个按钮，无参数** |
| **背景音乐自动闪避** | ❌ 新增 | 见下 |

**自动闪避（ducking）**——这是"看起来高级、实现很简单"的典型：

```ts
// src/core/ducking.ts（纯函数，可单测）
export function buildDuckingOps(doc: Project, bgmClipId: string): ClipOperation[] {
  // 1) 找出所有人声片段（音频轨上非 bgm 的片段 / 或字幕片段的时间区间）
  // 2) 人声区间 → 在 bgm 的 audio.gain 上打关键帧：说话时 -12dB，停顿处 0dB
  // 3) 用 8 帧斜坡进出，避免"抽气"感
  // 返回 setClipKeyframes（复用现有关键帧机制，预览/导出同一套）
}
```
- 触发：右键 bgm 片段 →「自动闪避人声」，或音频设置组里的按钮。
- **不需要用户懂侧链压缩**——按钮上就写"人声出现时自动压低音乐"。

**验收**：闪避后播放，人声段音乐明显变小、停顿处恢复；一次 Ctrl+Z 撤销；导出与预览听感一致（同一套关键帧）。

---

### 2.3 转场与特效预设

- **转场**：`transitionPlan` 已支持 fade/black/slide/zoom 等；要补的是**预设卡**（缩略图 + 名称）。
  缩略图 = 取接缝前后两帧，按 50% 混合渲染 → 截图。
- **滤镜**：`colorGrade` / `curve` / `lut` 三条路都已通；预设库做成**数据**：
```ts
{ id: 'fl.vintage', name: '复古', payload: { effectType: 'colorGrade', params: { brightness: -5, contrast: 10, saturation: -20, temperature: 25 } } }
```
  10 个预设足够（清新/暖阳/复古/黑白/胶片/冷调/日系/港风/赛博/褪色）。
- **强度滑块**：滤镜预设默认强度 100%，右栏一个滑块 0–100%（映射到参数插值），**其余参数全隐藏**。

**验收**：拖转场到接缝 → 预览立刻能播过；10 个滤镜一键换色且强度可调；全部支持撤销。

---

### 2.4 素材库管理（文件夹）

- `doc.folders: Folder[]`（`{id, name, parentId}`），`Asset.folderId?: string`。
- 新操作：`addFolder` / `renameFolder` / `removeFolder`（子素材上移，不删素材）/ `moveAsset`。
- UI：素材 Tab 里一个可折叠的文件夹树 + 网格；拖素材到文件夹即归类。
- **工程文件 v2** 里加 `folders` 字段（见 `docs/product-plan.md` §4.2）。

**验收**：新建/重命名/删除文件夹；素材拖进文件夹；删除文件夹不删素材；全部可撤销。

---

## 3. 第三优先级：AI 与 Agent

### 3.1 AI 助手入口

- 右下角**悬浮按钮**「AI 助手」（圆形，主色），点击弹出**对话面板**（右侧抽屉 360px）。
- 面板内：输入框 + 历史气泡 + 「本次改动」列表（每条可单独撤销）。
- `⌘K` 命令栏**保留**（老用户/键盘流），两者共用 `ai/intents` → `compileIntents` → ops。
- 每次 AI 操作仍然是一个撤销步（现状已满足），并在面板里显示"改了 3 个片段"。

**为什么不做成"聊天窗口"**：用户要的是"改片子"，不是"聊天"。对话只是**输入方式**，产出必须落在时间线上且可撤销。

### 3.2 右键菜单里的 AI

在现有 11 项菜单里加一组（分隔线后）：

| 菜单项 | 能力 | 状态 |
|---|---|---|
| AI 生成字幕 | `AIModelPort.transcribe` | 端口已有，缺 UI 入口 |
| AI 智能抠像 | 插件 `veditor.matte`（`runtime: worker`） | 待做（无模型时显示"未安装"） |
| AI 识别精彩片段 | 场景检测 + 音频能量 | 待做（`media/sceneDetect.ts`） |

**共同约定**：三个都**必须有"未配置/未安装"的降级态**，且降级时按钮可见但置灰 + title 说明怎么开。
（"点了没反应"比"没有这个功能"更伤信任。）

### 3.3 工程文件（Agent 底座）

沿用 `docs/product-plan.md` §4 的方案，本轮新增字段：

```jsonc
{
  "format": "veditor-project", "version": 2, "schemaVersion": 2,
  "project": { /* 现有 Project */ },
  "folders": [ { "id": "fld_1", "name": "空镜", "parentId": null } ],
  "journal": { "base": "snapshot", "entries": [ { "actor": "agent", "ops": [...], "inverse": [...] } ] },
  "media": [ { "assetId": "ast_1", "sha256": "…", "relPath": "footage/a.mp4" } ]
}
```

**Agent 只写 EDL**（`自然语言 → EDL → ops → Project`），不直接写工程文件——见 `docs/product-plan.md` §4.4。

---

## 4. 第四优先级：细节

| 项 | 做法 |
|---|---|
| **播放条居中** | `.v-ctrlbar` 从预览左下角改到底部居中（`justify-content: center`），播放键/时间码/音量一组居中；左右留白给"总时长/帧率" |
| **刻度自适应** | `timelinePainter` 已按 zoom 分三级（帧/秒/分，`verify-t15` 有断言）；补一档：`zoom ≥ 12` 时标尺画**每一帧**的小刻度 |
| **画布比例** | 顶栏三个按钮 16:9 / 9:16 / 1:1 → `setProjectParams`（切完要重绘当前帧） |
| **快捷键** | 已有 15 条（`KEY_BINDINGS` 自带 label）；补「?」打开快捷键一览（直接渲染 `KEY_BINDINGS`，不另写文案）；补 `S` 分割别名、`Shift+Del` 波纹删除提示 |

---

## 5. 三步落地路线

### 第一步（1–2 周）：交互骨架

| # | 任务 | 验收 | 依赖 |
|---|---|---|---|
| 1 | 左侧 7 Tab 壳 + 素材/文本/转场/特效四个有内容 | 切 Tab 不卡；拖拽上轨/上片段都能用 | 拖拽协议（已有基础） |
| 2 | 音频波形 | 波形与声音对齐；缩放不糊 | `waveform.ts` + IDB 表 |
| 3 | 预览窗口拖拽（移动/缩放/旋转） | 跟手、右栏同步、一步撤销 | `mergeKey`（已有） |
| 4 | 顶部快捷工具栏 + 导出右置 + 工程/自检进二级菜单 | 1280 宽不换行 | 无 |

**风险**：左侧 7 Tab 的缩略图生成会拖慢首次打开（每个预设要渲一帧）。
**对策**：缩略图**懒生成**（Tab 首次打开时才生成该 Tab 的），并显示占位骨架。

### 第二步（2–3 周）：三大核心

| # | 任务 | 验收 |
|---|---|---|
| 5 | 文本样式 + 6 预设 + 入场/退场动画 | 见 §2.1 |
| 6 | 转场预设卡 + 10 个滤镜 + 强度滑块 | 见 §2.3 |
| 7 | 音频三件套（降噪/人声增强/自动闪避） | 见 §2.2 |
| 8 | 轨道：独奏 + 字幕轨 + 三个加轨按钮 | 见 §1.2(b) |

**风险**：`TrackKind` 加 `'text'` 会动工程结构与 painter 的轨道绘制。
**对策**：先加类型与迁移（老工程照常读），再改 UI；`schemaVersion` +1，迁移函数写单测。

### 第三步（持续）：AI 与打磨

| # | 任务 | 验收 |
|---|---|---|
| 9 | AI 助手抽屉 + 改动列表 | 见 §3.1 |
| 10 | 右键三个 AI 项（含降级态） | 见 §3.2 |
| 11 | 工程文件 v2（journal/media/folders）+ EDL 转换 | v1 无损升级；EDL 往返幂等 |
| 12 | 细节四项（播放条/刻度/比例/快捷键一览） | 见 §4 |

---

## 6. 明确不做的（防止"越做越专业"）

| 不做 | 为什么 |
|---|---|
| 选择/切割/手型**模式切换** | 只有一种交互，模式只会让用户"点了没反应" |
| **关键帧编辑器**（曲线/贝塞尔/表格） | 用"入场动画/闪避/缓动"预设覆盖 95% 需求；真需要的人会用 Agent |
| **节点式特效链** / 多面板停靠 | 专业软件的心智模型，与"低学习成本"直接冲突 |
| **多声道矩阵 / 声道映射** | 短视频场景不存在 |
| **LUFS 响度表 / 频谱图** | 波形 + 峰值足够；响度是交付级需求，不是剪辑级 |
| 任意角度旋转（非 90°） | 会产生画面外黑边，且需要"自动放大裁切"的产品决策 |
| 时间线**吸附到节拍**（自动 BPM） | 误判率高、解释成本高；用波形 + 手动吸附足够 |

---

## 7. 新增契约汇总（给实现时直接抄）

### 7.1 类型（`core/types.ts`）

```ts
export type TrackKind = 'video' | 'audio' | 'text';        // + text
export interface Track { /* … */ solo?: boolean }          // + solo
export interface Asset { /* … */ folderId?: string }       // + folderId
export interface Folder { id: string; name: string; parentId: string | null }
export interface Project { /* … */ folders?: Folder[] }    // + folders
```

### 7.2 操作（`ClipOperation` 联合类型）

```ts
| { op: 'addFolder'; folder: Folder }
| { op: 'renameFolder'; folderId: string; from: string; to: string }
| { op: 'removeFolder'; folderId: string; removed: Folder; movedAssets: string[] }
| { op: 'moveAsset'; assetId: string; from: string | null; to: string | null }
```

`solo` 复用现有 `setTrackFlag`（`flag: 'solo'`）。

### 7.3 拖拽 MIME 注册表（`ui/dnd.ts`）

| MIME | payload | 落点 |
|---|---|---|
| `application/x-veditor-asset` ✅ | assetId | 时间轴轨道 |
| `application/x-veditor-effect` | itemId | 片段 |
| `application/x-veditor-transition` | itemId | 片段接缝 |
| `application/x-veditor-text` | itemId | 时间轴 |
| `application/x-veditor-audio` | itemId | 音频轨 |
| `application/x-veditor-sticker` | itemId | 时间轴 |

### 7.4 音频三件套的 ops

```ts
// 降噪 / 人声增强
{ op: 'setClipEffect', clipId, to: { type: 'denoise', params: { threshold, enhance }, … } }
// 自动闪避
{ op: 'setClipKeyframes', clipId: bgmId, from: [...], to: [{ frame, value: 0.25 }, …] }  // audio.gain
```

---

## 8. 现在就能开工的顺序（我建议）

1. **左侧 7 Tab 壳 + 转场/特效/文本三个预设库**（第一优先级里体感最大、且能复用现有 `setClipEffect/setClipTransition/setClipText`）
2. **音频波形**（用户点名，且是"看起来专业、做起来不难"的一项）
3. **预览窗口拖拽**（决定"像不像剪辑软件"的关键交互）
4. 顶部工具栏（纯搬按钮，半天）

第 1 项做完，你就能"把特效拖到片段上"——这是本轮所有要求里**用户第一次能明显感觉到"像个剪辑软件"**的时刻。
