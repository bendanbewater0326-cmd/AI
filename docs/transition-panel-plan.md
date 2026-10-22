# 左栏「转场」面板实现方案

> 状态：**第 1 步已交付（2026-10-23）**，第 2 步（拖拽 + 接缝吸附 + 落点预览）待做。
> 目标：把左栏「转场」Tab 从「功能开发中」换成转场库：**点一下应用到选中片段 /
> 拖到时间线的片段或接缝上**，时长可调，与素材/文字的拖拽手感一致。

## 交付记录（第 1 步）

`core/transitionPresets.ts`（3 个预设 + 时长档位，`side` 写进数据）+
`core/transitionTarget.ts`（`clipAtFrame` / `previousAdjacent` / `resolveTransitionTarget` /
`buildTransitionOps` / `resolveDuration`）+ `ui/TransitionPanel.tsx`。
属性栏的时长夹取与 op 构造也改成调同一份实现（顺带不再产生无用撤销步）。

验证：`transition-target.test.mjs` 14 项 + `verify-transition-panel.mjs` 14 项
（含读画面像素证明淡入真的在画）。

---

## 0. 一句话结论 + 五个待拍板

**结论**：现有转场链路是**完整且导出兼容**的（预览与导出走同一个 `renderFrame`），
但**只有 3 种类型、且只有"不透明度"一个自由度**。所以这一轮能做的是
"把 3 种转场做成一等公民"，**不是**"补一堆转场效果"——后者要动渲染模型。

| # | 待定 | 我的建议 |
|---|---|---|
| A | 转场挂在**片段侧**（`transitionIn`/`transitionOut`），不是独立实体 | 就用现有模型。剪映里转场是"接缝上的一个东西"，但我们的数据结构是挂在片段上的；改成独立实体要动 19 种 op 与工程文件格式 |
| B | 「叠化」需要**左侧紧邻一段素材**（`endOf(prev) === start` 严格相等） | 不满足时**给可读提示**，不静默降级成淡入（降级会让用户以为叠化没效果） |
| C | 面板顶部放**时长三档**（0.3 / 0.5 / 1.0 秒） | 要。成本极低（一个 3 选 1），解决"默认 0.5 秒对短视频偏慢" |
| D | 是否同批做**音频交叉淡化** | **不做**。现在只有画面渐变、声音在接缝处硬切；补音频淡化要改音频调度（`audioEngine` 的排期），属于链路改动，不是面板范围 |
| E | 是否同批补**更多转场类型**（滑入/擦除/缩放） | **不做**。见 §2：现有 `TransitionOverride` 只有 `opacity` + `frozenFrame`，做位移/擦除要扩渲染模型 |

---

## 1. 现状盘点（对着代码核过）

| 事实 | 出处 |
|---|---|
| 转场只有 3 种：`crossDissolve` / `fadeIn` / `fadeOut` | `core/types.ts:249` |
| 挂在**片段**上：`clip.transitionIn` / `clip.transitionOut` | `core/types.ts:302-303` |
| 唯一写入通道 `setClipTransition{clipId, side, from, to}`（可撤销） | `core/types.ts:394` |
| **`transitionIn` 的窗口以接缝为中心**：`[start - D/2, start + D/2)` | `media/transitionPlan.ts:70-71` |
| `crossDissolve` 会把**左侧紧邻**片段一起拉进来做反向淡出 | `transitionPlan.ts:80-92` |
| "紧邻"是**严格相等**：`endOf(previous) === clip.startFrame`（有缝隙就不算） | `transitionPlan.ts:83` |
| `fadeIn` 不需要左邻：本片段从透明淡入（露背景） | `transitionPlan.ts:72-78` |
| `transitionOut` **只处理 `fadeOut`**；`transitionOut.crossDissolve` 会被**静默忽略** | `transitionPlan.ts:97` |
| 转场窗口不吃两侧内容：用**冻结帧**（A 冻末帧 / B 冻首帧）补边界外那一半 | `transitionPlan.ts:4-15` |
| 时长上限 = **片段时长的一半**（`floor(duration/2)`） | `core/types.ts:1015` |
| 属性栏 UI：类型下拉 + 时长(秒)，**同一时刻只保留一侧**（in 或 out） | `ui/InspectorPanel.tsx:290-310` |
| 属性栏时长夹在 **0.1–2 秒**，再夹到 `maxTransitionFrames` | `InspectorPanel.tsx:293-296` |
| 时间线画**固定 12px 楔形**角标表示这一侧有转场（不随真实时长变化） | `render/timelinePainter.ts:54, 742-758` |
| **导出兼容**：导出与预览共用 `engine.renderFrame` → 转场天然一致 | `export/exporter.ts:21, 165-166` |
| 渲染层只给"不透明度"：`TransitionOverride{opacity, frozenFrame}` | `transitionPlan.ts:26-31` |
| 没有音频交叉淡化（只有画面 opacity） | 全仓无相关代码 |

**结论**：链路完整、可撤销、可导出；缺的是**入口组织**（面板）与**落点交互**（拖到接缝）。

---

## 2. 能力边界：为什么"只能做 3 种"不是 UI 偷懒

`TransitionOverride` 只有两个字段：`opacity`（乘在 transform 上）与 `frozenFrame`。
渲染层能表达的转场**只有"透明度渐变"这一类**。

要做「滑入 / 擦除 / 缩放 / 翻页」，必须扩这个模型：
- 滑入 → 需要 `translate` 偏移（甚至要按进度插值 transform）；
- 擦除 → 需要给片段一个**裁剪矩形**（`drawOne` 里 `ctx.clip()` 或 shader 里 discard）；
- 缩放 → 需要 scale 插值。

这些都会动 `compositor.drawOne` 与 WebGL/2D 两条路径（还要考虑 `preserveDrawingBuffer`、
蒙版/曲线/LUT 的既有分支）。**所以这一轮明确只做 3 种**，把"面板 + 落点 + 时长"
这套骨架先跑通；以后补类型只加数据、不改交互。

---

## 3. 交互模型（关键：三种转场落法不同）

```
┌──────────┬──────────┐
│   片段 A  │   片段 B  │     接缝 = A 的末尾 == B 的开头（严格相等）
└──────────┴──────────┘
            ↑
     叠化 → 写到 B 的 transitionIn（窗口跨接缝，A 会被一起拉进来淡出）
     淡入 → 写到 B 的 transitionIn（只淡 B，不需要 A）
     淡出 → 写到 A 的 transitionOut（在 A 内部淡出，不需要 B）
```

### 3.1 点击卡片

```
选中了片段 → 叠化/淡入 写到它的 in 侧；淡出 写到它的 out 侧
没选中片段 → 播放头落在某个接缝上（±2 帧）就作用到那个接缝；否则给可读提示
叠化但没有左邻片段 → 提示「叠化需要左边紧挨着一段素材」，**不改文档**
```

与属性栏的关系：属性栏是"同一时刻只保留一侧"，面板也遵守同一规则
（设 in 时清 out，反之亦然），否则两侧斜坡会互相打架（`transitionPlan` 取 min，
表现是"转场看起来很弱"）。

### 3.2 拖拽卡片

- 拖到**某个片段上** → 按 §3.1 的规则作用到"光标下的那个片段"。
- 拖到**接缝附近（±12px）** → 吸附到接缝：叠化/淡入落到右侧片段的 in，淡出落到左侧片段的 out。
- 拖到空白区/轨道头列 → 不接（与素材/文字一致）。
- 落点预览：新增 `ephemeral.transitionGhost = { clipId, side, valid, reason }`，
  painter 在对应片段的边缘画一个**加宽的楔形**（绿=可落、红=不可落），
  比"整块半透明矩形"更能表达"这是接缝上的东西"。

### 3.3 时长

面板顶部三档：**0.3 / 0.5 / 1.0 秒**（默认 0.5，与属性栏一致）。
写入时统一 `min(secondsToFrames(档位), maxTransitionFrames(clip))` ——
**复用属性栏同一个夹取规则**（抽成 `core/transitionTarget.resolveDuration()`，
两处共用，禁止各写一份）。

---

## 4. 面板 UI

```
┌ 转场 ─────────────────────┐
│ 时长   [0.3s] [0.5s] [1.0s] │  ← 分段控件，作用于"新加的"转场
├────────────────────────────┤
│ ┌────────┐ ┌────────┐      │
│ │  叠化   │ │  淡入   │      │  ← 2 列网格，卡片 16:9
│ └────────┘ └────────┘      │
│ ┌────────┐                 │
│ │  淡出   │                 │
│ └────────┘                 │
├────────────────────────────┤
│ 选中片段后点击应用，或拖到   │  ← 底部一行说明（11px 灰字）
│ 两个片段的接缝上            │
└────────────────────────────┘
```

- **不做分类 chips**：只有 3 个类型，分类是纯噪音（文本面板有 5 类是因为有 10 个模板）。
- **缩略图用 DOM 画**（不用 canvas、不用渐变）：
  - 叠化：两块半透明方块叠着（各 45% 不透明度）；
  - 淡入：5 条竖条，不透明度 0.15→1 递增；
  - 淡出：反过来。
  这比"截一帧真画面"便宜得多，而且 E2E 能直接断言 DOM。
- 卡片 `draggable`（与文本模板同一套 `dnd` 机制），`title` 全中文。
- 当前片段已有转场时，对应卡片显示**选中态**（`data-active`），让用户知道"现在是什么"。

---

## 5. 数据与纯函数

### 5.1 `core/transitionPresets.ts`（新，纯数据）

```ts
export type TransitionKind = 'crossDissolve' | 'fadeIn' | 'fadeOut';

export interface TransitionPreset {
  id: string;              // 'trs-dissolve'
  name: string;            // '叠化'
  type: TransitionKind;
  /** 落在片段的哪一侧。淡出是 'out'，其余是 'in'。 */
  side: 'in' | 'out';
  /** 是否需要左侧紧邻片段（叠化需要）。 */
  needsPrevious: boolean;
  /** 缩略图画法（DOM）。 */
  preview: 'overlap' | 'fadeInBars' | 'fadeOutBars';
  hint: string;            // 卡片 tooltip 里的中文说明
}

export const TRANSITION_PRESETS: readonly TransitionPreset[];
export const TRANSITION_DURATIONS = [0.3, 0.5, 1.0] as const;
```

### 5.2 `core/transitionTarget.ts`（新，纯函数 + 单测）

```ts
/** 某帧上这条轨是哪个片段（半开区间）。 */
export function clipAtFrame(track: Track, frame: Frame): Clip | null;

/** 该片段左侧是否有严格紧邻的片段（叠化的前提）。 */
export function previousAdjacent(track: Track, clip: Clip): Clip | null;

/** 落点 → 转场目标：吸附接缝、判定能否应用、给出可读原因。 */
export function resolveTransitionTarget(
  doc: Project, track: Track, frame: Frame, preset: TransitionPreset,
): { clipId: string; side: 'in' | 'out'; durationFrames: Frame } | { message: string };

/** 时长夹取（与属性栏共用）。 */
export function resolveDuration(seconds: number, clip: Clip, fpsMilli: MilliFps): Frame;
```

**为什么抽成纯函数**：接缝吸附、"左邻是否存在"、"两侧互斥"这三条规则最容易写错，
而且都要在 Node 里穷举边界（首片段、有缝隙、同一帧两个片段重叠）。

---

## 6. 文件清单

| 文件 | 类型 | 内容 | 预估 |
|---|---|---|---|
| `src/core/transitionPresets.ts` | 新增 | 3 个预设 + 时长档位 | ~70 行 |
| `src/core/transitionTarget.ts` | 新增 | 4 个纯函数（上表） | ~110 行 |
| `src/ui/TransitionPanel.tsx` | 新增 | 时长分段 + 3 张卡片 + 点击/拖拽 | ~170 行 |
| `src/ui/LeftPanel.tsx` | 改 | `transition` Tab 渲染面板（占位列表再减一个） | ~10 行 |
| `src/ui/dnd.ts` | 改 | `TRANSITION_MIME` + 三个函数（照文字那套） | ~35 行 |
| `src/ui/TimelineView.tsx` | 改 | drop 分支 + 接缝吸附 + ghost | ~50 行 |
| `src/core/types.ts` | 改 | `EphemeralState.transitionGhost` | ~8 行 |
| `src/core/store.ts` | 改 | `setTransitionGhost`（同值不 notify） | ~8 行 |
| `src/render/timelinePainter.ts` | 改 | 画转场 ghost（加宽楔形，绿/红） | ~30 行 |
| `src/ui/InspectorPanel.tsx` | 改 | 时长夹取改调 `resolveDuration`（去掉第二份实现） | ~6 行 |
| `src/styles/app.css` | 改 | 面板样式 | ~80 行 |
| `tests/transition-target.test.mjs` | 新增 | 纯函数单测 | ~12 项 |
| `tests/verify-transition-panel.mjs` | 新增 | 面板 E2E | ~16 项 |

**零改动**：`transitionPlan`（渲染语义）、`operations`、`exporter`、音频链路。

---

## 7. 分两步交付

### 第 1 步：数据 + 面板 + 点击应用（不含拖拽）
- 3 张卡片 + 时长三档 + 点击应用到选中片段 / 播放头接缝。
- 两侧互斥、叠化缺左邻时给提示、时长夹取。
- 验收：单测 12 项 + E2E 前 10 项。

### 第 2 步：拖拽 + 接缝吸附 + 落点预览
- `TRANSITION_MIME`、`onDragOver` 画 ghost、`onDrop` 落库、接缝 ±12px 吸附。
- 顺带：把时间线的转场楔形**按真实时长画**（现在是固定 12px）—— 让用户能看出
  "这个转场是 0.3 秒还是 1 秒"。这条改动在 painter 里，不改数据。
- 验收：拖到片段、拖到接缝、拖到空白、拖到轨道头列。

---

## 8. 验收标准

**单测（`transition-target.test.mjs`）**
1. `clipAtFrame` 半开区间：起点算、终点不算；
2. `previousAdjacent`：严格相等才算；差 1 帧不算；
3. 叠化 + 有左邻 → 目标 = 右片段 in；
4. 叠化 + 无左邻 → `{message}` 且**不产生任何 op**；
5. 淡入 → 右片段 in（不需要左邻）；淡出 → 左片段 out；
6. `resolveDuration`：0.3/0.5/1.0 秒分别换算正确，且被 `maxTransitionFrames` 夹住；
7. 片段只有 4 帧时（上限 2 帧），1.0 秒 → 夹到 2 帧。

**E2E（`verify-transition-panel`）**
1. 点「转场」Tab → 3 张卡片，名称/顺序正确，时长默认 0.5s；
2. 选中片段 A → 点「淡出」→ `transitionOut.type === 'fadeOut'`，帧数 = 0.5s 换算值；
3. 再点「淡入」→ **out 被清空**、in 有值（两侧互斥）；
4. 选中有左邻的片段 → 点「叠化」→ `transitionIn.type === 'crossDissolve'`；
5. 选中**没有左邻**的片段 → 点「叠化」→ 出现可读错误、文档不变；
6. 改时长档 1.0s → 再点 → 帧数跟着变；
7. **像素**：接缝处播到 `cut-1` 与 `cut+1`，两帧的 `meanLuma` 都介于两侧单独画面之间
   （证明叠化真的在画，不是只改了字段）；
8. 拖「叠化」到接缝（±8px 内）→ 落到右侧片段的 in；
9. 拖到片段中部（远离接缝）→ 落到光标下片段的 in（叠化仍需左邻）；
10. 拖到空白区/轨道头列 → 不新建、不报错；
11. 一次操作 = 一步撤销；
12. 时间线楔形宽度随时长变化（0.3s 与 1.0s 两次对比，像素宽度不同）；
13. 全量 E2E 零回归（当前 59 个）。

---

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 两侧都有转场 → `transitionPlan` 取 min，看起来"转场很弱" | 面板与属性栏共用"设一侧就清另一侧"的规则；`resolveTransitionTarget` 返回需要清的那一侧，一次 dispatch 提交 |
| 叠化把左片段拉进来，但左片段在**另一条轨**（跨轨接缝） | 明确只认**同轨**接缝（`transitionPlan` 也是同轨找 previous），跨轨不接并给提示 |
| 转场窗口超过左片段长度 → 左片段整段冻结 | 时长上限目前只按**右片段**算；本轮沿用（保守），在文档里写明；不改渲染 |
| 拖拽接缝判定与"拖素材/拖文字"抢事件 | 三种 MIME 各自独立（asset / text / transition），`onDragOver` 先判 types |
| 时间线楔形改成按时长画后，极短转场（2 帧）几乎看不见 | 设最小可见宽度 6px，且 hover 时显示时长 tooltip |

---

## 10. 待你确认

1. **A** 转场继续挂在片段侧（`in`/`out`），不做独立实体；
2. **B** 叠化缺左邻时**提示而不是降级**；
3. **C** 时长三档（0.3/0.5/1.0）放在面板顶部；
4. **D** 音频交叉淡化**不做**（只做画面）；
5. **E** 本轮**不补**新转场类型（滑入/擦除需要扩渲染模型）；
6. 第 7 章的分两步节奏是否 OK。

确认后我按第 1 步开工。
