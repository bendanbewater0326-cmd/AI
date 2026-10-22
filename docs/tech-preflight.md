# 技术预检报告（WebCodecs 能力边界实测）

> 实测环境：Windows / Microsoft Edge 155.0.0.0（Chromium 155）/ Node 24.16.0
> 实测方式：`tests/preflight.cjs`、`tests/preflight2.cjs`（Playwright 无头 + `127.0.0.1` 安全上下文）
> 报告日期：2026-10-18

## 0. 首要注意事项

**WebCodecs 与 File System Access API 都要求 secure context。**
在 `about:blank` 或 `file://` 下，`VideoDecoder` / `VideoEncoder` / `showOpenFilePicker` 全部为 `undefined`。
必须以 `http://127.0.0.1:PORT` 或 HTTPS 提供服务，否则功能整体不可用。
→ 开发服务器必须绑定 `127.0.0.1`；打包后若以 `file://` 打开会静默失效，需在启动时检测并提示。

## 1. 能力矩阵（实测）

### 解码（VideoDecoder.isConfigSupported）

| 编解码器 | 配置 | 支持 |
|---|---|---|
| H.264 Baseline | avc1.42E01E 720p | ✅ |
| H.264 High | avc1.640028 1080p | ✅ |
| VP9 | vp09.00.10.08 | ✅ |
| AV1 | av01.0.04M.08 | ✅ |
| H.265 / HEVC | hvc1.1.6.L93.B0 | ✅ |

结论：输入侧几乎无敌，用户拖进来的任何常见格式都能解。

### 编码（VideoEncoder.isConfigSupported）

| 编解码器 | 配置 | 支持 |
|---|---|---|
| H.264 Baseline | avc1.42001f 720p | ✅ |
| H.264 High | avc1.640028 1080p | ✅ |
| VP8 | vp8 | ✅ |
| **VP8 + alpha** | `alpha: 'keep'` | ❌ |
| VP9 | vp09.00.10.08 / vp09.02.10.10 | ✅ |
| **VP9 + alpha** | `alpha: 'keep'` | ❌ |
| AAC | mp4a.40.2（48k / 44.1k） | ✅ |
| Opus | opus（48k） | ✅ |
| H.264 annexb 格式 | `avc.format: 'annexb'` | ✅（含 realtime） |

### 其它

| 能力 | 结果 |
|---|---|
| `showOpenFilePicker` | ✅ |
| OffscreenCanvas | ✅ |
| WebGL2（OffscreenCanvas 内） | ✅ |
| `new VideoFrame(OffscreenCanvas)` | ✅，format = RGBA |
| MediaRecorder `video/webm;codecs=vp8` | ✅ |
| MediaRecorder `video/webm;codecs=vp9` | ✅ |
| MediaRecorder `video/mp4;codecs=avc1` | ✅ |
| MediaRecorder `video/x-matroska;codecs=avc1` | ✅ |

## 2. 三个硬约束（影响功能承诺，必须写进设计）

### 约束 A：透明通道无法用 WebCodecs 编码器产出

VP8/VP9 的 `alpha: 'keep'` 在本机 Chrome 155 上全部返回 `false`。
即"WebM 透明视频"**不能**走 `VideoEncoder` 这条主路径。

可选降级路线（按优先级）：
1. **PNG 序列 + ZIP**：逐帧导出 RGBA PNG 打包，用户拿去任何后期软件合成。帧精确、无质量损失，但文件大、不能在播放器直接播。
2. **MediaRecorder 实时录制 canvas**：canvas 为 RGBA，理论上可保留 alpha，但**只能实时速度录制**（10 秒片要录 10 秒），且时间戳不完全可控。
3. **宿主提供 ffmpeg 能力**：若将来嵌入的是 Electron 类客户端，可通过 HostBridge 调本机 ffmpeg 出 ProRes 4444 / VP9 alpha。这是唯一能拿到"专业透明视频"的路径。

→ 产品侧必须把"透明通道"标注为**受限能力**，且在 UI 上只在导出 WebM 时点亮对应选项、并说明限制。

### 约束 B：MediaRecorder 不能替代帧精确导出

`MediaRecorder` 走实时时钟，丢帧/时间戳抖动不可控，**不能**作为主导出管线。
主导出必须是 `VideoEncoder` + 逐帧 `VideoFrame` 喂入 + `mp4-muxer`/`webm-muxer` 封装。

### 约束 C：播放与导出的帧时间戳必须自建时基

视频源是可变帧率（VFR）时，`requestVideoFrameCallback` 给出的时间戳不等于 `index / fps`。
编辑器内部必须维护**整数帧号 → 微秒时间戳**的唯一换算，所有 seek、切割点、导出时间戳都由它派生，否则会出现"剪在 3 秒实际剪在 2.97 秒"的漂移。

## 3. 已验证的测试资产

- `tests/fixtures/sample-720p.mp4`：1280×720 / 30fps / 240 帧 / 8s / H.264 + AAC，含 `testsrc2` 图案（自带帧号与色块），可直接用于帧精确比对。
- `tests/preflight.cjs`：基础能力探针（可重复运行，用于回归确认浏览器能力未变）。
- `tests/preflight2.cjs`：编码/封装/透明通道专项探针。

## 4. 对架构的直接影响

1. 开发与生产环境都必须以 `127.0.0.1` 或 HTTPS 提供页面，需在启动脚本中固定。
2. 导出模块需按「能力探测 → 选择可用封装 → UI 动态禁用不支持选项」设计，不能硬编码选项列表。
3. 透明通道需求降级为 PNG 序列（P2 优先级），主路径不承诺 WebM alpha。
4. 时基模块（FrameClock）必须是独立、可单测的核心模块，不能散落在组件里。
