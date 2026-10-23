# 左栏「特效」面板实现方案

> 状态：**两步全部交付（2026-10-23）**。
> 目标：把左栏「特效」Tab 从「功能开发中」换成**一键滤镜库**：分类筛选 + 真画面缩略图网格 +
> 点击/拖拽应用到片段，与文本、转场面板同一套手感。

---

## 1. 摸底：现在到底有什么

### 1.1 数据结构（`core/types.ts:229`）

```ts
interface Effect {
  id, clipId, type: string, params: Record<string, number|string>,
  keyframes: Keyframe[], enabled: boolean, order, source: 'ui'|'ai'
}
```

`type` 是**自由字符串**，渲染层按类型名去认。真正被认的只有 4 个 + 1 个音频的：

| 类型 | 常量定义 | 参数 | 渲染位置 |
|---|---|---|---|
| `colorGrade` | 无（字面量散落各处） | brightness / contrast / saturation / temperature，各 -100..100 | `GRADE_GLSL`（`compositor.ts:249`） |
| `curve` | `CURVE_EFFECT`（`render/curve.ts:26`） | x1/y1/x2/y2（0..1） | `CURVE_GLSL`（`compositor.ts:272`） |
| `lut` | `LUT_EFFECT`（`render/lut.ts`） | cube（.cube 原文）+ strength | `LUT_GLSL`（`compositor.ts:296`） |
| `mask` | `MASK_EFFECT`（`render/mask.ts`） | shape/x/y/w/h/feather/invert | `MASK_GLSL`（`compositor.ts:315`） |
| `denoise` | `DENOISE_EFFECT`（`media/denoise.ts:29`） | 音频降噪强度 | `audioEngine` / `export/audioMix` |

**没有别的了。** 没有模糊、没有像素化、没有光效、没有故障、没有锐化、没有暗角。

### 1.2 渲染链路

```
clip.effects ──gradeOf() / curveOf() / lutOf() / maskOf()──► RenderLayer
                                                              │
                    compositor.drawLayer(source, transform, placement, grade, curve, lut, mask)
                                                              │
                         固定顺序：transform → grade → curve → LUT → mask
```

关键点：

- **顺序是硬编码的**，不是按 `Effect.order` 排。`Effect.order` 字段目前无人读取。
- 一条 `drawLayer` 调用吃 4 个可选参数 → 加第 5 种效果要改 `Compositor` 接口（WebGL + Canvas2D 两套实现）。
- WebGL2 主路径 + Canvas2D 降级路径**都在** `compositor.ts`（1372 行）。

### 1.3 导出兼容

`exporter.ts:167` 调的是 `this.engine.compositor.captureFrame()` —— 与预览**同一张离屏缓冲**。
所以：**任何已在预览里生效的效果，导出自动一致**，不需要为导出单独做任何事。

### 1.4 现有 UI

全部挤在**右侧属性栏**（`InspectorPanel.tsx`）：

| 效果 | 属性栏控件 | 行号 |
|---|---|---|
| 调色 | 4 条滑块（亮度/对比/饱和/色温） | 967–990 |
| 曲线 | 2 个数值（暗部/亮部 y） | 999 |
| 蒙版 | 形状 + 4 个方位 + 羽化 + 反向 | 1043 |
| LUT | 文件选择 + 强度滑块 | 346–398 / 1127 |
| 降噪 | 开关 + 强度 | 483–528 / 1217 |

**注意**：调色/曲线整块被 `{!disabled && !isText ? ...}` 包着 —— **文字片段没有这些控件**。

### 1.5 成熟度判定

| 效果 | 成熟度 | 理由 |
|---|---|---|
| `colorGrade` | **成熟** | 4 个参数全覆盖、中性值等价于不加、单测 + E2E（`verify-c-ui` 读画面像素）、导出同源 |
| `curve` | 成熟但表达力弱 | 只有 2 个控制点（x 固定 0.25/0.75），做不出真正的 S 曲线 |
| `lut` | 成熟但门槛高 | 要用户自己准备 `.cube` 文件；原文存进工程（工程文件会变大） |
| `mask` | 成熟 | 带关键帧（`Effect.keyframes`） |
| `denoise` | 成熟但**是音频** | 改的是声音，不是画面 |

**结论**：能做成"缩略图一键套用"的，只有 `colorGrade` 这一种。`curve` 表达力太弱（2 点），
`lut` 需要外部文件，`mask` 是空间操作（画个矩形挖洞，不是滤镜），`denoise` 不属于画面。

---

## 2. 分类梳理：哪些能一键，哪些必须留参数

| 类别 | 效果 | 交互形态 | 本轮 |
|---|---|---|---|
| **一键预设** | `colorGrade` 的参数组合（14 个预设） | 左栏「特效」网格，点击/拖拽 | ✅ 做 |
| 参数精调 | `colorGrade` 4 条滑块 | 右栏滑块 | 已有，不动 |
| 参数型 | `curve` / `mask` | 右栏控件（蒙版还要在画面上拖） | 已有，不动 |
| 外部资源型 | `lut`（.cube 文件） | 右栏「载入 LUT」 | 已有，不动 |
| 音频 | `denoise` | 右栏开关 | 已有，不动 |

**「特效」面板只做第一行**，其余四行保持在属性栏 —— 面板是"选风格"，属性栏是"调数值"，
两者写的是**同一份** `clip.effects` 里的 `colorGrade`。

### 2.1 为什么不做"虚化/光效/故障"

要做必须给 `Compositor` 加新的 shader pass（WebGL + Canvas2D 两套），还要和
`grade → curve → LUT → mask` 的既有顺序、混合模式的 2-pass 路径、蒙版的裁剪矩形共存。
这是**渲染器改造**，不是面板范围 —— 与转场面板"不补新类型"是同一个判断。

---

## 3. 面板设计

```
┌ 特效 ──────────────────────────────┐
│ [全部] [基础] [冷暖] [风格]          │  ← 4 个分类 chip
├────────────────────────────────────┤
│ ┌──────┐ ┌──────┐                  │  缩略图 = 工程里某段视频的**真画面**
│ │ 原片  │ │ 提亮  │                  │  套上该预设的调色后画出来
│ └──────┘ └──────┘                  │  （不是纯色块：复古和冷调纯色块分不清）
│ ┌──────┐ ┌──────┐                  │
│ │ 压暗  │ │ 高对比 │                  │
│ └──────┘ └──────┘                  │
├────────────────────────────────────┤
│ 选中片段后点击应用，或拖到片段上      │
└────────────────────────────────────┘
```

**不做顶部时长类控件**（特效没有时长）；**不做"我的预设"**（第三步再说，R-053 已能存 colorGrade）。

### 3.1 缩略图：真画面 + 复算着色器公式

```
1. 取源图：选中片段的素材缩略图 → 否则工程里第一个视频素材的缩略图
           → 都没有（空工程）就用内置测试图（画一个"天空+地面+太阳"的渐变）
2. 画到 80×45 离屏 canvas，缓存（同一源只解一次）
3. 每张卡：drawImage 缓存 → getImageData → 逐像素套调色 → putImageData
```

逐像素套的公式**必须与 `GRADE_GLSL` 逐字对应**：

```
brightness: c += b/200            （加法，不是乘法）
contrast:   c = (c-0.5)*k + 0.5   （围绕 0.5，不是围绕中灰 0.5 的乘法）
saturation: c = mix(luma, c, s)
temperature: r += t*0.15; b -= t*0.15
```

**不能用 CSS `filter: brightness()`**：CSS 的 brightness 是**乘法**，着色器是**加法**。
用 CSS 做缩略图 → 缩略图和预览不一致 → 用户点了发现"和缩略图不是一个东西"。

> 顺带发现（不修，记一笔）：Canvas2D 降级路径用的正是 `ctx.filter`
> （`compositor.ts:1245`），所以**无 WebGL2 时调色与 WebGL 略有差异**。
> 这是既有实现，本轮不动，但说明"照抄 CSS filter"会踩同一个坑。

### 3.2 点击语义

| 情况 | 行为 |
|---|---|
| 选中视频片段 | 应用到该片段（一个撤销步） |
| 没选中，播放头下有片段 | 应用到播放头所在片段 |
| 选中的是**文字片段** | 拒绝 + 可读提示（属性栏没有调色控件，加上了也去不掉） |
| 什么都没选中 | 提示「先选中一个片段」 |
| 点「原片」 | **移除** `colorGrade`（不是写全 0 的 effect） |

### 3.3 「已应用」高亮

卡片上比对 `clip.effects` 里 colorGrade 的 4 个参数与预设值**完全相等** → 加主色描边 + 右上角对勾。
`gradeOf()` 会把缺失参数补 0，所以比对前先把预设也补成 4 个键。

### 3.4 拖拽（第二步）

第四个独立 MIME：`application/x-veditor-effect`，载荷 = 预设 id。

| 落点 | 结果 |
|---|---|
| 片段上 | 应用到该片段 |
| 文字片段 | 红色预览 + 松手提示 |
| 空白 / 轨道头 / 标尺 | 红色预览 + 「拖到片段上」 |

`ephemeral.effectGhost = { clipId, valid, reason? }` —— 与 `dropGhost`（有起点+时长）、
`transitionGhost`（有侧别）都不同：**特效没有时间跨度**，只是"这块片段被选中了"。
painter 画整块片段的描边（绿/红），不画楔形。

---

## 4. 代码落点

| 文件 | 改动 |
|---|---|
| `core/effectPresets.ts` | **新增**：14 个预设（id/name/category/params/hint）+ 分类表 + `effectPresetById` + `gradeMatches`（比对是否已应用） |
| `core/gradePixels.ts` | **新增**：`applyGradeToPixels(rgba, w, h, grade)` —— 与 `GRADE_GLSL` 逐字对应的 JS 实现（照 `render/curve.ts` 的 `applyCurveValue` 先例，注释写明"两边必须一起改"） |
| `ui/EffectPanel.tsx` | **新增**：分类 chips + 网格 + canvas 缩略图 + 点击/移除/高亮 |
| `ui/LeftPanel.tsx` | effect Tab 挂 `EffectPanel`（与 text/transition 一样常驻挂载） |
| `styles/app.css` | `.v-effectpanel*` / `.v-fxcard*`；网格规则与 `.v-textpanel__grid` 合并成一条选择器列表 |
| `core/types.ts` | `EffectGhost` 类型 + `EphemeralState.effectGhost` |
| `core/store.ts` | `setEffectGhost` + 初始值 |
| `ui/dnd.ts` | `EFFECT_MIME` / `setEffectDrag` / `hasEffectDrag` / `readEffectDrag` / `clearDraggingEffect` |
| `ui/TimelineView.tsx` | `onDragOver`/`onDrop` 第三个分支 + `planForEffectDrop` |
| `render/timelinePainter.ts` | `drawEffectGhost` |
| `ui/InspectorPanel.tsx` | 不动（它已经在读同一份 colorGrade，应用后滑块自动跟着变） |

**不新增** `ClipOperation` —— `setClipEffect` 已经够用（特效就是"给片段设一个 colorGrade"）。

---

## 5. 两步交付

### 第 1 步：数据 + 面板 + 点击应用

- `effectPresets.ts` / `gradePixels.ts`（纯函数，Node 可穷举）
- `EffectPanel.tsx`：4 个 chip、14 张卡、真画面缩略图、点击应用/移除、已应用高亮
- 文字片段 / 无选中 的可读提示
- 单测 `tests/effect-presets.test.mjs`（预设合法性、分类覆盖、`gradeMatches`、像素公式与中性值）
- E2E `tests/verify-effect-panel.mjs`

**验收**
1. 14 张卡顺序与中文名正确；4 个 chip 过滤后数量正确
2. 点「黑白」→ doc 里出现 `colorGrade` 且 saturation = -100；**读画面像素证明真的变灰**
   （三通道差异趋 0；对照：应用前差异明显）
3. 点「原片」→ effect 被移除，画面恢复
4. 一次操作 = 一步撤销
5. 应用「复古」后再点「冷调」→ **替换而不是叠加**（`effects` 里 colorGrade 仍只有 1 条）
6. 已应用高亮：应用后该卡有 `data-applied="true"`，其余为 false
7. 选中文字片段点卡片 → 有提示、doc 不变
8. 缩略图非空白（每张卡 canvas 有非零像素方差），且「黑白」卡的三通道差异 < 「原片」卡
9. 属性栏滑块跟着变（应用「暖阳」后 `inspector-temperature-value` = 预设值）
10. 刷新后仍在（走工程持久化，不是内存态）

### 第 2 步：拖拽 + 落点预览

- `EFFECT_MIME` + `effectGhost` + `drawEffectGhost`（整块片段描边，绿/红）
- 拖到片段 / 文字片段 / 空白 三种落点
- E2E 加 4 条（拖到片段落库、拖到文字片段变红、拖到空白不落库、ghost 指向正确 clipId）

---

## 6. 风险与坑（动手前先记下）

1. **`setClipEffect` 是同类型单例**（`operations.ts:334` 先 filter 掉同类型再加）。
   所以"应用第二个特效"是**替换**不是叠加。UI 必须让这件事可见（已应用高亮 + 只有一个高亮），
   否则用户会以为"我叠了两个滤镜"。
2. **文字片段没有调色控件**（属性栏 `!isText` 分支）。给文字片段加 colorGrade 会导致
   "加得上、去不掉" —— 本轮直接拒绝并给提示，不做半成品。
3. **缩略图必须复算着色器公式**，不能图省事用 CSS filter（见 §3.1）。
4. **`Effect.order` 是死字段**：加预设时写 0 即可，别指望它控制顺序（顺序是硬编码的）。
5. **别在拖动期间 dispatch**（沿用铁律）：ghost 只画，松手才写。
6. 空工程没有素材缩略图 → 必须有内置测试图兜底，否则卡片全是空白。

---

## 7. 待拍板

| # | 问题 | 建议 |
|---|---|---|
| **A** | 特效面板 = 一键调色滤镜（复用 `colorGrade`，不改渲染器） | **同意**。这是当前渲染模型唯一能真实表达、且导出自动一致的东西 |
| **B** | 与「调节」Tab 的分工 | 特效 = 预设（一键选风格）；调节 = 精调（滑块/曲线/LUT/蒙版）。两者写同一份 `colorGrade`，应用后属性栏滑块自动同步 |
| **C** | 缩略图用真画面 + JS 复算公式，无素材时用内置测试图 | **同意**。纯色块分不清复古和冷调 |
| **D** | 降噪不放进画面特效面板 | **同意**。它是音频效果，放进"画面特效"会让面板语义错位；留在属性栏，未来进「音频」面板 |
| **E** | 拖拽落点 = 片段（整块高亮，绿/红），无吸附 | **同意**。特效没有时间跨度，不需要吸附 |
| **F** | 不设"强度"滑杆；「原片」= 移除效果 | **同意**。属性栏 4 条滑块已经是强度调节，面板再加一层会打架 |

### 预设清单（14 个 / 4 类）

| 分类 | 预设 | 参数（brightness / contrast / saturation / temperature） |
|---|---|---|
| 基础 | 原片 | 全部 0（= 移除） |
| | 提亮 | +18 / 0 / 0 / 0 |
| | 压暗 | -18 / 0 / 0 / 0 |
| | 高对比 | 0 / +28 / 0 / 0 |
| | 柔和 | +6 / -22 / -6 / 0 |
| 冷暖 | 暖阳 | +6 / 0 / +8 / +34 |
| | 冷调 | 0 / +6 / 0 / -34 |
| | 暖夜 | -14 / +8 / -6 / +22 |
| | 冷白 | +12 / +4 / -10 / -18 |
| 风格 | 黑白 | 0 / +8 / -100 / 0 |
| | 复古胶片 | +4 / -12 / -26 / +18 |
| | 电影感 | -6 / +20 / -14 / -10 |
| | 日系清透 | +12 / -14 / -6 / -4 |
| | 鲜艳 | 0 / +10 / +38 / 0 |
