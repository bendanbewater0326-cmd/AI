# AI 场景化面板植入方案（已交付，2026-10-24：P1 意图 + P2 三面板 + P3 测试）

> 摸底日期：2026-10-24。目标：把 AI 从「Ctrl+K 隐藏命令」变成「面板内的场景化入口」，
> **踩坑**：React 受控输入必须用原生 value setter 赋值（S5/E2E 同款教训——
> 直赋值被值跟踪去重，onChange 不触发，生成按钮保持禁用）。
> 全部复用现有通道与意图体系，零底层改动（不动 `render/export/media/playbackEngine/core/types`）。

---

## 1. 摸底：现有底数

### 1.1 AI 通道与安全架构（全部成熟）

| 件 | 现状 |
|---|---|
| `AIProvider` 端口 | `complete()`（文本→**意图**）+ 可选 `transcribe()`；host / mock（离线规则）/ null 三实现（`ai/provider.ts`） |
| 安全闸门 | AI **只输出意图**，客户端编译器补全载荷、校验、编译成操作（`ai/intents.ts`，意图白名单 + 属性路径白名单）——模型编不了 clip 对象，撤销栈安全 |
| 可用性判定 | `isAIUsable()`（null 置灰）+ TopBar 按钮已有 disabled+title 先例；字幕面板有更细的 `hasTranscribeChannel()` 禁用先例 |
| 本地规则拦截 | 粗剪/降噪/多机位/字幕/蒙版/曲线六类在命令栏**调模型之前**本地处理（`CommandBar.submit`） |

### 1.2 三个面板的现状

| 面板 | 现状 |
|---|---|
| 字幕 | **「AI 生成字幕」入口已存在**（C1-C3 交付：按钮 + transcribeReady 禁用 + busy 态 + toast）——用户建议第一条的"保留入口"已成立，只剩"优化指令预设" |
| 文本 | 无 AI 入口。**关键缺口：意图白名单里没有 `addTextClip`**——模型现在无法创建文字内容，"AI 生成文案"走不通 |
| 特效 | 无 AI 入口。**同样缺口：没有调色意图**（`setProperty` 白名单不含 colorGrade 参数；调色是 effect 不是 property） |

### 1.3 关键架构事实（决定方案形态）

1. **文案是"内容"不是"操作"**：与 transcribe 的文本同性质。符合安全架构的做法 =
   新增意图 `addTextClip { content, styleHint? }`，模型只给**文案文本**，建轨/落片/撤销
   由编译器落地（复用 `ui/textClip.buildNewTextOps`——与文本面板/右键菜单同一个定义点）。
2. **调色同理**：新增意图 `setGrade { clipId?, brightness, contrast, saturation, temperature }`，
   编译器写 `colorGrade` effect（与属性栏 `commitGrade` 同一构造），参数 clamp 到 −100..100。
3. **模型看不到画面**（上下文只有帧率/轨道/属性，不上传素材字节——隐私承诺）。
   所以「智能调色」的诚实形态 = **风格描述 → 调色参数**（"复古胶片感"→ 模型给参数），
   不是"看图调色"。方案与 UI 文案都要如实表达（按钮叫「AI 风格调色」而不是"智能识别画面"）。
4. **mock provider 生成不了真文案**（它是规则引擎）。文案生成的可用性判定需要比
   `isAIUsable()` 更严，或让 mock 返回固定演示文案（E2E 可断言）。这是要拍板的点。

---

## 2. 方案

### 2.1 文本面板：「AI 生成文案」

- 入口：面板顶部工具行加「✦ AI 文案」按钮（样式对齐字幕面板的 primary 按钮先例）。
- 点击弹**轻量输入行**（面板内联，不新开对话框）：主题输入框 + 4 个风格预设 chips
  （种草安利 / 知识科普 / 悬念开场 / 温情治愈——点击即把风格词填进主题输入）+「生成」。
- 链路：拼 prompt（主题 + 风格 + 工程时长上下文）→ `provider.complete` →
  意图 `addTextClip` → 编译器 `buildNewTextOps` 落**文字轨播放头处** → 自动选中
  （用户立刻能在属性栏改内容/样式——与手动添加完全同一套后续）。
- busy 态：按钮转「生成中…」；失败走 `store.pushError`（可读中文，与命令栏同口径）。
- 无真模型时：`isAIUsable() === false` → 按钮 disabled + title 说明；mock provider 对
  文案请求返回**固定演示文案**（"（离线演示）……"，E2E 可断言全链路）——是否同意见 §5。

### 2.2 特效面板：「AI 风格调色」

- 入口：预设区顶部加「✦ AI 风格调色」按钮 → 内联输入行：风格描述框
  （占位文案"例：复古胶片 / 清爽夏日 / 电影感冷色"）+「应用」。
- 链路：风格词 + 选中片段上下文 → `complete` → 意图 `setGrade`（目标 = 选中片段，
  未选中则播放头处视频片段——与特效面板点击应用同一落点规则 `resolveEffectTarget`）→
  编译器写 colorGrade（参数 clamp −100..100）→ 特效面板「已应用」高亮自动出现（同源 effects）。
- 同一输入可重复调整（"再暖一点"→ 模型基于当前值微调——上下文里带当前调色值）。
- 诚实边界写进占位文案与提示：按**文字描述**匹配调色，不分析画面内容。

### 2.3 字幕面板：保留现有入口 + 指令预设优化

- 「AI 生成字幕」按钮与禁用逻辑**原样保留**（已符合本次要求）。
- 优化：空状态文案改为**三个可点预设**（"识别中文语音" / "识别英文语音" / "先导入 SRT"），
  点前两个直接触发生成（语言参数不再需要用户输入——现状 `generateCaptions('auto')`
  的语言判定本来就在 `parseTranscribeRequest` 里，只是没有 UI 捷径）。

### 2.4 无宿主通道的统一模式（对齐既有先例）

| 入口 | 判定 | 表现 |
|---|---|---|
| AI 生成字幕 | `hasTranscribeChannel()`（已有） | disabled + title「当前客户端未提供语音识别通道」 |
| AI 文案 / AI 风格调色 | `isAIUsable()` | disabled + title「当前客户端未提供模型」 |
| （mock 演示态） | mock provider | 可用——返回演示文案/预设参数，UI 标注「离线演示」 |

### 2.5 明确不做

- 不做"看画面调色"（上下文不上传素材字节是隐私承诺，模型也拿不到帧）
- 不做 AI 贴纸/素材生成（贴纸面板本身延后）
- 不改命令栏（Ctrl+K 全局入口原样，面板入口只是同一通道的场景化捷径）
- 不新增 AI 底层能力（无新端口、无新通道；只有两个新**意图种类**走既有编译管线）

---

## 3. 代码落点

| 文件 | 改动 |
|---|---|
| `ai/intents.ts` | +`addTextClip` / `setGrade` 意图类型与编译（text 复用 `buildNewTextOps`；grade 与属性栏同一 effect 构造 + clamp） |
| `ai/provider.ts` | SYSTEM_PROMPT 增补两种意图说明；INTENT_KINDS + normalize 两个分支；mock 对文案请求回固定演示文案 |
| `ui/TextPanel.tsx` | 「✦ AI 文案」按钮 + 内联输入行 + 调用链 |
| `ui/EffectPanel.tsx` | 「✦ AI 风格调色」按钮 + 内联输入行 + 调用链 |
| `ui/caption/CaptionPanel.tsx` | 空状态加三个预设入口（语言直达） |
| `tests/ai-panels.test.mjs` | 单测：两个新意图的编译（正常/越界 clamp/坏字段拒绝）+ normalize |
| `tests/verify-ai-panels.mjs` | E2E：三面板入口可见性、无通道禁用（`?ai=off`）、mock 生成文案落文字轨、调色写 colorGrade、字幕预设直达 |

**不改**：`render/**`、`export/**`、`media/**`、`playbackEngine.ts`、`core/types.ts`、
`store.ts`、`CommandBar.tsx`（命令栏不动，面板入口是平行捷径）。

---

## 4. 测试设计

单测（Node）：
- `addTextClip` 编译：落文字轨、时长 = 偏好默认、一个撤销步、content 空/超长拒绝
- `setGrade` 编译：写 colorGrade、参数 clamp（−100..100）、目标解析（选中/播放头）、与现有调色叠加（覆盖同类型 effect）
- normalize：两个新 kind 的形状校验、未知字段丢弃

E2E（`verify-ai-panels.mjs`，≥10 断言）：
1. 文本面板出现「✦ AI 文案」；`?ai=off` 时 disabled + title
2. mock 下生成 → 文字轨出现片段、内容 = 演示文案、被选中
3. 风格 chips 点击填入主题词
4. 特效面板出现「✦ AI 风格调色」；`?ai=off` 时 disabled
5. mock 下应用（"暖阳风"）→ 选中片段 colorGrade 参数落库（mock 规则映射到预设参数）
6. 调色后特效面板「已应用」高亮切换（同源 effects 验证）
7. 字幕空状态三个预设可见；点「识别中文语音」在无通道时给可读拒绝
8. 回归：`verify-m4-ai`（命令栏全链路）、`verify-text-panel`、`verify-effect-panel`、`verify-caption`

---

## 5. 待拍板

1. **mock（离线演示）对文案请求返回固定演示文案**（E2E 可全链路断言；宿主注入真模型后自然出真文案）——是否同意？
2. **「AI 风格调色」的诚实命名**（按钮文案用「AI 风格调色」，不用"智能识别画面"——因为模型只按文字描述给参数、不分析画面）——是否同意？
3. 字幕空状态改**三个预设入口**（中文/英文/SRT）——是否同意？
4. 两个新意图（`addTextClip`/`setGrade`）走**既有意图编译管线**（不动安全架构：模型仍只输出意图、不碰操作载荷）——是否同意？
