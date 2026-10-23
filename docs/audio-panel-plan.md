# 左栏「音频」面板实现方案（轻量版：内置音效库）

> 状态：**已拍板，A1 已交付**（2026-10-24）。四项决策全部确认：方案 C / 10 音效 3 分类 /
> 音效进素材栏（「音效·」前缀）/ 三步交付。A1 = 数据层（`gen-sfx.mjs` + `sfxLibrary.ts` +
> loader 接线 + `applyFirstAssetParams` 纯音频不跟随修复 + 17 单测）。
> 摸底日期：2026-10-24。本文遵循既有面板方案的结构（参考 `effect-panel-plan.md` / `text-panel-plan.md`）。
> 硬边界（用户已拍板）：**本轮不做交叉淡化、人声分离等引擎层改动，仅做上层 UI 接线。**

---

## 1. 摸底：现在到底有什么

### 1.1 音频引擎（`media/audioEngine.ts`，911 行）—— 成熟，不碰

| 能力 | 状态 | 位置 |
|---|---|---|
| 分块预读 + 绝对时间排期调度 | ✅ 成熟（3s 预读、1s 块、接缝消咔、起播延迟补偿） | `createAudioScheduler` |
| 片段音量（gain）+ 软限幅 | ✅ 烘进 PCM，预览/导出同一套数学 | `applyClipGain` / `core/volume.ts` |
| 淡入淡出（线性包络，帧） | ✅ R-037 已交付，属性栏有滑块 | `envelopeAt` |
| 音量关键帧（`audio.gain`） | ✅ R-038 | `core/keyframes.ts` |
| 降噪（噪声门 + 增强） | ✅ R-061，走 `setClipEffect` 可撤销 | `media/denoise.ts` |
| 轨道闸门（静音/隐藏/独奏立刻生效） | ✅ | `trackGates` / `core/trackAudibility.ts` |
| 预览总音量（只听不导） | ✅ | `setMasterVolume` |
| 静音检测 | ✅（用于 ASR 抽音频） | `media/silence.ts` |
| 分离音频（role: video/audio） | ✅ | `core/detachAudio.ts` |

**结论：预览/导出链路对"音频资产"已经完全够用，音频面板不需要动任何引擎代码。**

### 1.2 导出链路 —— 成熟，不碰

`export/audioMix.ts`（混音/下混/重采样 → `encodeWav`），`exporter.ts` 支持 `format: 'wav'`；
右键菜单已有「导出这段的音频…」「配一段音频…」「删除音频」（`TimelineView.tsx:979–1044`）。

### 1.3 数据模型 —— 现有 `ClipOperation` 全覆盖，无需新操作类型

- 音量/淡入淡出：`setClipProps`（path `audio.gain` / `audio.fadeInFrames` / `audio.fadeOutFrames`）
- 降噪：`setClipEffect`（type `denoise`）
- 落轨：`core/placement.buildPlaceAssetOps` 已支持 `kind: 'audio'`
  （音轨自动挑选 / 不够建新轨 / 建轨与落片同一撤销步 / 指定轨时的可读拒绝全都有，`placement.ts:216`）
- 落点预览：`EphemeralState.dropGhost`（`trackId/startFrame/durationFrames/valid`）是通用结构，音效拖拽直接复用

### 1.4 关键缺口（本方案的真正命题）：**没有"纯音频文件"能进来**

- 导入管线只认 **mp4 / webm 容器**（`media/mediaProbe.ts` 嗅探，其它一律
  `E_UNSUPPORTED_CONTAINER`「请转为 mp4 或 webm」）。**WAV / MP3 导入是断的**
  ——「配一段音频…」的 `accept="audio/*"` 只是选择器不拦，选了 .wav 会在解析时报错。
- 资产 `kind: 'audio'` 已经存在（mp4/webm 无视频轨时自动判定，`demuxMp4.ts:12`
  明确支持纯音频 mp4），纯音频素材的解码/播放/落轨链路**是通的**——只是没有入口能产生这种资产。

### 1.5 约束盘点

| 约束 | 来源 | 对方案的影响 |
|---|---|---|
| 无后端、无网络请求 | PRD 定案 | 音效必须内置，不能引在线曲库 |
| PRD §Q：不做素材市场、模板商店、**贴纸/音乐曲库** | `PRD.md:361` | **音乐库**本轮继续不做；「内置音效库」不是外部曲库（无版权、无下载、构建期自己合成），不违反该定案，但要在方案里写明 |
| 零底层改动（不动 render/export/playbackEngine/types） | 用户本轮拍板 | 音效必须**走现有导入管线**成为真资产，不能另开播放路径 |
| 同一条规则只写一份 | 项目铁律 | 落轨走 `buildPlaceAssetOps`、拖拽 MIME 独立、不复制素材栏的导入逻辑 |

---

## 2. 内置音效库的物理形态（核心决策）

### 2.1 三个候选

| 方案 | 做法 | 为什么不行/行 |
|---|---|---|
| ❌ A：提交 WAV + 新增 WAV 容器支持 | 改 `mediaProbe` 嗅探 + 新写 `demuxWav` + `decoderPool` PCM 直通 | 要动 **media 层三处**，违反本轮边界 |
| ❌ B：运行时合成 PCM 直接播放 | `OfflineAudioContext` 合成 → AudioBuffer 直接响 | 绕过调度器/解码池 = **第二条播放路径**，违反"同一条规则只写一份"；且资产生命周期（草稿缓存/刷新恢复）全接不上 |
| ✅ C：构建期 ffmpeg 生成**纯音频 mp4（AAC）**，内联进 bundle，运行时走现有导入管线 | 见下 | **media 层零改动**；`demuxMp4` 明确支持纯音频 mp4；AAC 解码已被测试素材全量 E2E 长期验证；资产是真资产——草稿缓存、刷新恢复、重链、素材栏复用全部免费获得 |

### 2.2 方案 C 展开

1. **生成**：`scripts/gen-sfx.cjs`（一次性，提交生成的产物）。本机 ffmpeg 路径已固定
   （`gen-baseline.cjs` 同款解析方式）。每个音效 0.4–2.5s、**单声道 48kHz、AAC 48–64kbps**，
   ffmpeg 滤镜程序化合成（正弦/噪声 + 包络/扫频），无版权问题。
2. **内联**：esbuild 给 `.m4a` 加 `base64` loader → `import dingDataUrl from './sfx/ding.m4a'`。
   base64 解码后构造成 `File`（显式 `type: 'audio/mp4'`）。预计 10 个音效合计 ~70KB →
   main.js 增加 **~100KB**（725KB → ~825KB，构建报告里盯这个数）。
   （不用 `file` loader + 相对路径 fetch：host 可能以自定义协议加载，内联最稳。）
3. **注册为真资产**：`ensureSfxAsset(preset)` —— 先按 `hashKey` 查重
   （我们的文件字节固定 → `name|size` 确定，幂等；这与素材栏查重是同一份口径，不新造），
   没有才 `importAssetFile(file)`。**全链路复用**：探测→样本索引→解码池→草稿缓存→自动恢复。
4. **进素材栏是特性不是 bug**：音效成为普通资产后用户可在素材栏复用、可删除，
   与剪映"用过的音效出现在素材里"的习惯一致。

### 2.3 音效清单（10 个，全中文，3 分类）

| 分类 | 名称 | 时长 | 合成方式（ffmpeg 滤镜思路） |
|---|---|---|---|
| 提示音 | 叮 | 0.6s | 880Hz 正弦 + 指数衰减 |
| 提示音 | 咚 | 0.7s | 220Hz 正弦 + 快衰减 |
| 提示音 | 滴·短 | 0.3s | 1200Hz 短促方包络（0.15s 在资源管理器显示成 0:00，加长到 0.3s） |
| 提示音 | 双响提示 | 0.9s | 两连音（880→1320） |
| 转场音 | 嗖 | 1.2s | 白噪 + 带通中心频率扫频 |
| 转场音 | 上扬 | 1.0s | 正弦 300→1200Hz 上滑 + 淡出 |
| 转场音 | 下落 | 1.0s | 正弦 1200→300Hz 下滑 |
| 转场音 | 咔哒 | 0.4s | 短噪声脉冲 + 快衰减 |
| 底噪 | 白噪·柔 | 2.5s | 白噪 + 低通 + 低电平 |
| 底噪 | 白噪·强 | 2.5s | 白噪 + 中电平（对白垫底/测试用） |

最终以 `gen-sfx.cjs` 实测听感为准，**生成后必须人工试听验收**（E2E 听不了声音）。

---

## 3. 面板设计（与文本/特效/转场面板同一套手感）

```
┌──────────────────────────────┐
│ [全部] [提示音] [转场音] [底噪] │  ← 分类 chips（同 TextPanel）
├──────────────────────────────┤
│ ┌──────┐ ┌──────┐ ┌──────┐  │
│ │ 叮 ▶ │ │ 咚 ▶ │ │ 滴 ▶ │  │  ← 卡片：名称 + 时长角标 + 试听小按钮
│ │ 0.6s │ │ 0.7s │ │ 0.3s │  │
│ └──────┘ └──────┘ └──────┘  │
│  …（网格布局同特效面板）        │
├──────────────────────────────┤
│ ℹ 点卡片落到播放头；拖到音轨任意位置│  ← 底部一行可读说明（同其他面板）
└──────────────────────────────┘
```

- **点击卡片 = 应用**：`ensureSfxAsset` → `buildPlaceAssetOps(doc, asset, 播放头, { kind: 'audio' })`
  → `dispatch(ops, '添加音效（叮）')` → 选中落下的片段（与 TextPanel.createText 同套路）。
  音轨不够时自动建轨（placement 已有，建轨与落片一个撤销步）。
- **试听按钮（▶）**：字节 → `Blob`（`type:'audio/mp4'`）→ `URL.createObjectURL` → `new Audio()`。
  纯 UI 反馈，不碰 `audioEngine`，不进 doc，同一时间只播一个（再点停止）。
  点击应用与试听是两个独立命中区（卡片主体 vs ▶ 按钮），不会误触。
- **拖拽 = 新 MIME** `application/x-veditor-sfx`（payload = 预设 id），独立 MIME 是项目定案
  （`ui/dnd.ts` 每个面板一个，`onDrop` 里不长 if）。`text/plain` 带前缀兜底同素材那套。
- **落点预览**：复用通用 `DropGhost`（音轨上的矩形块，时长 = 预设秒数静态已知），
  只在**音频轨**上显示；拖到视频轨 = 红 + `reason: '音效只能放到音频轨'`。
- 全中文命名：分类、名称、按钮、提示语，无英文术语。
- 常驻挂载（`hidden` 切换）：与文本/特效面板一致，分类选中态不因切 Tab 丢失。

### 3.1 明确不做（本轮边界）

- **音乐库**（PRD 定案不做曲库）、**配音录音**（要 MediaRecorder + 新引擎面）、
  **WAV/MP3 导入**（media 层，另立专项）、**交叉淡化**（用户拍板不做）、**人声分离**（要模型）。
- 音量/淡入淡出/降噪面板：**属性栏已有**（`InspectorPanel.tsx:114–288`），不在音频面板重复做
  ——同一条规则只写一份。

---

## 4. 代码落点

| 文件 | 新/改 | 内容 |
|---|---|---|
| `scripts/gen-sfx.cjs` | 新 | ffmpeg 合成 10 个 m4a → `src/ui/audio/sfx/`（产物提交进 git，~70KB） |
| `src/ui/audio/sfxLibrary.ts` | 新 | 预设表（id/名称/分类/秒数/hashKey/音源 dataUrl）+ `ensureSfxAsset`（查重 + importAssetFile）+ 试听播放器（模块级单例 Audio） |
| `src/ui/audio/AudioPanel.tsx` | 新 | 分类 chips + 卡片网格 + 点击应用 + 试听（套 `TextPanel`/`EffectPanel` 的结构与 `data-v` 命名） |
| `src/ui/dnd.ts` | 改 | +`SFX_MIME` + set/read 函数（照 TEXT_MIME 的写法） |
| `src/ui/LeftPanel.tsx` | 改 | `audio` case 从 `TabPlaceholder` 换 `<AudioPanel />`，常驻挂载 slot |
| `src/ui/TimelineView.tsx` | 改 | onDragOver/onDrop 各加一个 sfx 分支（ghost 限音频轨 + drop 先 ensure 再 buildPlaceAssetOps） |
| `scripts/build.mjs` | 改 | loader 加 `'.m4a': 'base64'` |
| `tests/sfx.test.mjs` | 新 | 单测（见 §5） |
| `tests/verify-audio-panel.mjs` | 新 | E2E（见 §5） |
| `docs/PROJECT-STATUS.md` 等 | 改 | 收尾四处同步（§2 数字/§3 全史/§6 表/package.json e2e 别名） |

**不改**：`src/media/**`、`src/core/**`、`src/render/**`、`src/export/**`（零底层改动硬边界）。

---

## 5. 测试设计

### 5.1 Node 单测 `tests/sfx.test.mjs`（不需要浏览器）

- 预设表完整性：id 唯一、名称唯一且全中文、分类合法、时长 0.3–2.5s、hashKey 与音源可配对
- 分类覆盖断言（3 个分类都有内容，防"加了预设忘分类"——同 keymapView 的 `uncategorizedIds` 套路）
- MIME 常量与现有四个（asset/text/transition/effect）不冲突
- `ensureSfxAsset` 幂等：mock store 已有同 hashKey 资产 → 不再触发导入
- base64 → File 的解码函数纯函数部分（Node 可测）

### 5.2 E2E `tests/verify-audio-panel.mjs`（先 build 再跑，无头）

1. 切到音频 Tab → 面板出现，分类 chips + 10 张卡片
2. 点「叮」→ A1（或自动建的音轨）出现片段，时长 = 0.6s 换算 ±1 帧，且被选中
3. 连点两次 → **资产数量不变**（幂等）、两个片段各自独立
4. 拖拽（页面内合成 PointerEvent，见 `verify-caption.mjs` ㉓ 的 pointercancel 坑）→ 音轨 ghost 显示 → 松手落轨
5. 拖到视频轨 → 红 ghost + 松手报「音效只能放到音频轨」
6. 音效片段挂降噪/静音轨后不出声（复用 trackAudibility 现有断言套路）
7. **导出 WAV 的 PCM RMS > 0**（真声音进了导出，不只是 UI 假绿）——这是"音效真的可听"在无头环境里唯一可验口径
8. 刷新 → 音效资产从草稿缓存自动恢复（零操作）

### 5.3 手工验收（E2E 测不到的）

- 10 个音效逐个试听听感（合成参数的最终裁决）
- 试听与应用同时进行不打架；连续点击试听不叠音
- 播放头在时间线末尾时点卡片 → 落轨 + 提示正常

---

## 6. 分步交付（每步独立验收）

| 步 | 内容 | 验收 |
|---|---|---|
| **A1** | `gen-sfx.cjs` 生成 10 个 m4a + 预设表 `sfxLibrary.ts` + esbuild loader + ensureSfxAsset | `npm run check` 绿；构建报告 main.js 增量 ~100KB；单测绿；**人工试听 10 个音效** |
| **A2** | `AudioPanel.tsx` + LeftPanel 接线 + 点击应用 + 试听 | 截图给用户；点卡片落轨 ±1 帧；资产幂等 |
| **A3** | 拖拽 MIME + TimelineView 分支 + ghost + `verify-audio-panel` + docs 收尾 | E2E 全绿；全量 E2E 不回归；PROJECT-STATUS 四处同步 |

---

## 7. 风险与坑（动手前先记下）

1. **AAC 低码率听感**：48kbps 单声道对正弦/噪声合成音足够，但必须人工听；不行就提到 64k（体积预算还够）。
2. **esbuild base64 的 data URL mime** 可能不是 `audio/mp4`——解码时**只取 base64 段**，File 显式给 type，不信任内联 mime；试听用 Blob URL 不用 data URL。
3. **drop 里 ensure 是异步的**：importAssetFile 全链路（探测/写缓存）虽小仍要 await，drop handler 里做好 busy 提示（「正在添加音效…」），失败走 `store.pushError`，不静默。
4. **hashKey 查重口径**：素材栏的查重在 UI 层做（不是 importAssetFile 内部），sfx 也在自己的 `ensure` 里做，**别改 importAssetFile**。
5. **`useDoc` 返回新数组会无限重渲染**：面板里按分类筛选用 `useMemo` 或本地 state 存筛选结果，不从 selector 返回数组。
6. **ghost 只画音频轨**：`dropTargetAt` 命中视频轨时要给 `valid:false + reason`，不能不显示（用户不知道为什么松手没反应——S5 拖出界提示的同一条经验）。
7. **音效片段默认 gain=1**：合成音效已按 −6dBFS 左右配平峰值，不靠 gain 补。
8. **10 个音效同时进素材栏**：命名统一 `音效·叮` 前缀，在素材栏一眼可辨、可批量删。

---

## 8. 待拍板

1. **音效物理形态**按方案 C（构建期 AAC 内联 + 走现有导入管线）——是否同意？
2. **音效清单**（10 个、3 分类）是否要增减？（比如要不要「掌声」这类合成不了的——要的话只能延后等真实素材来源）
3. **进素材栏**的行为（音效=真资产，会出现在素材面板）是否接受？
4. 分步交付 A1→A2→A3 的切分是否同意？
