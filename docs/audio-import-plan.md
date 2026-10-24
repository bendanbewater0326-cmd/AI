# MP3/WAV 纯音频导入支持方案（已交付，2026-10-24：W1 WAV + W2 MP3 + W3 测试收尾）

> 摸底日期：2026-10-24。缘起：音频面板摸底时确认**导入管线只认 mp4/webm 容器**，
> **踩坑**：CDP 修饰键位 Shift=8（W1 同款）；MP3 的 LAME encoder padding 使 2s 素材实测
> 2.0667s（62 帧），断言必须用 ffprobe 实测而非整秒假设；`assets()` 钩子补 `codecAudio`
> 字段（钩子字段裁剪过一次就再也读不到的同款教训）。
> 用户自有 WAV/MP3 无法导入（`mediaProbe.sniffContainer` 直接 `E_UNSUPPORTED_CONTAINER`）。
> 本专项 = 补齐这两个纯音频容器，**混音/调度/导出核心零改动**。

---

## 1. 摸底：链路底数与缺口

### 1.1 现有管线对"纯音频"已经准备好的部分

| 环节 | 现状 |
|---|---|
| 资产模型 | `kind: 'audio'` 已存在（webm/纯音频 mp4 走过）；无缩略图、`needsProxy` false |
| 纯音频 mp4（.m4a） | **已经能导**（`demuxMp4.ts:12` 明确支持 `hasVideo:false`）——缺口只有 WAV/MP3 |
| 解码入口 | `decoderPool.decodeAudioRange(assetId, startIndex, count)`：按样本索引逐条 `readBlobBytes` → `EncodedAudioChunk` → 每素材 `AudioDecoder`（配置来自 `probe.audio.{codec,sampleRate,channels,description}`）→ flush → 收集 `AudioData` |
| 预览/导出 | 调度器与 `export/audioMix` 走**同一个** `decodeAudioRange`——导入+解码通了，导出自动通 |
| 契约先例 | `demuxWebm` 已证明"非 mp4 容器只要产出与 mp4 一致的 probe 结构（样本索引/codec/时长）即可接入" |

### 1.2 缺口（全部在 media 层的"容器接入"一处）

1. `mediaProbe.sniffContainer`：只认 mp4/webm → **加 'wav' / 'mp3' 两种判定**。
2. 没有 WAV/MP3 的 demuxer（样本索引 + codec 信息）。
3. `decoderPool` 的解码路径假设"样本 = 编码块 → AudioDecoder"——**WAV 是裸 PCM，不需要解码**。

### 1.3 两个容器各自的技术方案

**WAV（PCM 直通，零解码）**
- 解析：RIFF 头（`RIFF…WAVE`）→ `fmt ` chunk（audioFormat 1=PCM / 3=f32、channels、sampleRate、bitsPerSample）→ `data` chunk（偏移 + 字节数）。仅支持 PCM 族（1/3），压缩 WAV（6/7 等）给可读报错。
- 样本索引：按 **1 秒一块** 切 `data`（`bytesPerFrame = channels × bits/8`），`ptsUs` 累计。
- 解码：**不走 AudioDecoder**——`decodeAudioRange` 加 PCM 直通分支：按样本索引切字节 → 直接构造 `AudioData`（`format: 'f32-planar'` 或 's16'，`sampleRate/channels` 来自 fmt），所有权交给调用方（与现有契约一致）。
  - 为什么直通而不是喂 `AudioDecoder` 的 pcm codec：PCM codec 的 WebCodecs 支持度/输出格式存在浏览器差异，直通是**确定性**路径，且天然预览/导出一致（同一构造函数）。

**MP3（AudioDecoder 解码，走现有会话）**
- 解析：跳过 `ID3v2`（读头 10 字节的 syncsafe 大小）→ 逐帧走 MP3 帧头（0xFFE 同步字 → version/layer/bitrateIndex/samplerateIndex/padding → 帧长），每帧一条样本索引（~26ms），`ptsUs` 按采样数累计。VBR/Xing 头无需特判（逐帧解析天然支持）。
- 解码：**完全走现有 `AudioSession`**——`probe.audio.codec = 'mp3'`，Chrome/Edge/WebView2 的 `AudioDecoder` 原生支持 mp3。decoderPool 零改动（配置来自 probe，已有逻辑）。
- 边界：损坏/截断文件 → 解析到尾即止，`needsIndexScan: false`、`exactSeek: true`；0 帧可解析 → 可读报错 `E_UNSUPPORTED_CONTAINER`。

**选择 WAV 直通 + MP3 走解码器的理由**：MP3 必须解压（有 codec）；WAV 不必解压（直通最确定）。
两条路都收敛在 `decodeAudioRange` 的既有返回契约上，调度器/混音/导出**感知不到差异**。

---

## 2. 改动清单

| 文件 | 改动 |
|---|---|
| `media/demuxWav.ts` | 新：RIFF/fmt/data 解析 + 样本索引（纯函数，Node 可测） |
| `media/demuxMp3.ts` | 新：ID3 跳过 + 帧头解析 + 样本索引（纯函数，Node 可测） |
| `media/mediaProbe.ts` | `sniffContainer` 加 wav/mp3；`probeAsset` 各加一个分支（构造 Asset：kind 'audio'、`durationSec`、`sampleRate/channels`、`codecAudio`） |
| `media/decoderPool.ts` | `decodeAudioRange` 加 **PCM 直通分支**（仅 wav 资产；MP3 走现有 AudioSession 零改动） |
| `tests/demuxWav.test.mjs` / `tests/demuxMp3.test.mjs` | 纯函数单测（fixtures 用 ffmpeg 生成的小样本，提交进 git） |
| `tests/verify-audio-import.mjs` | E2E：WAV/MP3 各自 导入 → 素材(kind audio) → 上音轨 → 播放调度 PCM>0 → 导出 WAV |
| `tests/fixtures/compat/gen-baseline.cjs` 或新 gen 脚本 | ffmpeg 生成 `sample.wav` / `sample.mp3` 小 fixture（几秒，提交） |

**不改**：`render/**`、`export/**`（audioMix 走同一 decode 端口自动生效）、`core/**`、
`audioEngine.ts` 调度数学、`playbackEngine.ts`。mediaProbe/decoderPool 的改动是"加分支"，
不动既有 mp4/webm 路径一行。

---

## 3. 测试设计

单测（Node，纯函数）：
- demuxWav：正常 16bit/立体声/44.1k、f32、非 PCM format 拒绝、截断文件、多余 chunk（LIST 等）跳过
- demuxMp3：ID3v2 跳过、CBR 帧链、VBR（Xing 头存在也能逐帧解析）、截断尾帧、0 帧报错
- 样本索引不变式：`ptsUs` 单调、帧数×时长 ≈ 总时长（±1 帧）

E2E（`verify-audio-import.mjs`，≥8 断言）：
1. 拖入 `.wav` → 素材卡出现（kind=audio、无缩略图不报错）
2. 双击上音轨 → 片段时长与 WAV 时长 ±1 帧
3. 播放压过片段 → `audioStats` chunks/scheduledSeconds>0、gaps=0
4. 同流程 `.mp3` → 全部成立
5. 导出整段 WAV → ffprobe 校验时长 ±1 帧（复用 verify-m3-export 的落盘校验套路）
6. 损坏文件（截断的 wav）→ 可读报错不崩
7. 刷新恢复 → 草稿缓存链路对纯音频资产同样生效
8. 回归：`verify-audio-panel` / `verify-audio-menu` / `verify-realworld`

---

## 4. 分步交付

| 步 | 内容 | 验收 |
|---|---|---|
| W1 | demuxWav + probe 分支 + PCM 直通 + 单测 + wav fixture | 单测绿；E2E WAV 部分绿 |
| W2 | demuxMp3 + probe 分支 + 单测 + mp3 fixture | 单测绿；E2E MP3 部分绿 |
| W3 | `verify-audio-import.mjs` 全量 + 基线 + docs 收尾 | 全量 E2E 零回归 |

## 5. 待拍板

1. **范围 = WAV + MP3 两种**（.m4a 已通；ogg/flac 不做）——是否同意？
2. **WAV 仅支持 PCM 族**（含 f32；ADPCM 等压缩 WAV 明确拒绝并给可读提示）——是否同意？
3. **MP3 依赖宿主 WebCodecs 的 mp3 解码**（Chrome/Edge/WebView2 均支持；精简 Chromium 内核可能没有——与 AAC 同一条已知边界，进 SelfCheck 候选）——是否接受？
4. 分步 W1→W2→W3——是否同意？
