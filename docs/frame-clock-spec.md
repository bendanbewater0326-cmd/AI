# 时基与帧映射规格（Frame Clock Spec）

配套 PRD `R-031` / `R-032`，供架构师作为实现约束。仅规格，不含选型论证。

**引用约定**：本文用例编号一律写作 `spec:T1`～`spec:T10`；架构文档的任务编号写作 `task:T01`～`task:T19`。两者不得混用（`spec:T1` ≠ `task:T01`）。

## 1. 两套时基

| 时基 | 单位 | 持有字段 | 规则 |
|---|---|---|---|
| 项目时基 `P` | 项目帧 | `Project.fps` `Clip.startFrame` `playheadFrame`；`Project.durationFrames` 为**派生值**（由 clips 推出，不落盘） | 时间线栅格，起点 0，整数 |
| 素材时基 `S` | 素材帧 | `Asset.fps` `Asset.durationFrames` `Clip.inFrame/outFrame` | 解码栅格，整数 |
| 音频时基 | 采样点 | `Project.sampleRate`(48000) `Asset.sampleRate` | 混音前统一到 48kHz |

两套时基不得混用同一变量名，字段名后缀区分。

## 2. 换算公式（全整数运算）

记 `clip = {startFrame: s0, inFrame: i, outFrame: o}`，`fs = 素材毫帧率`，`fp = 项目毫帧率`（见 §3）。

| 用途 | 公式 | 取整 | 调用时机 |
|---|---|---|---|
| 片段在项目轨上的帧数 | `Lp = divRoundHalfUp((o - i) * fp, fs)` | half-up | 建片段时算定并缓存 |
| 项目帧 N → 素材帧 S | `S = i + divFloor((N - s0) * fs, fp)` | floor | 每帧渲染 / seek |
| 素材帧 S → 项目帧 P | `P = s0 + divRoundHalfUp((S - i) * fp, fs)` | half-up | **仅建片段与裁剪时**，运行期禁用 |

`divRoundHalfUp(a,b) = (2a+b)//(2b)`，`a,b>0`；`divFloor` 负数向下取整。

## 3. 边界表

| 边界 | 输入 | 输出 |
|---|---|---|
| startFrame 之前 | `N < s0` | `null`（该轨无画面，不得返回 `i` 附近帧） |
| 首帧 | `N = s0` | `S = i` |
| 末帧 | `N = s0 + Lp - 1` | `i + divFloor((Lp-1) * fs, fp)`，必须 `≤ o - 1` |
| outFrame 及之后 | `N ≥ s0 + Lp` | `null`；**不得 clamp 到 `o-1` 继续 hold**（会延长片段） |
| 负值 | `N < 0` 或 `s0 < 0` | 拒绝（assert），起点固定 0 |
| 素材边界 | `o > Asset.durationFrames` | 拒绝建片段；`o − i ≥ 1` |
| 分数帧率 | `23.976 / 29.97` | 毫帧率整数运算，不转浮点 |
| 恒定帧率假设 | VFR 素材 | 按 `Asset.fps` 平均帧率换算，不做逐帧时间戳对齐（M1 不承诺） |

## 4. 整数防漂移规则

| # | 规则 |
|---|---|
| 1 | 帧率一律存整数毫帧率：`30000`、`29970`、`23976` |
| 2 | 先乘后除，禁止先除后乘；中间积用 `Number`（< 2^53）或 `BigInt` |
| 3 | 只在返回前取整一次 |
| 4 | 禁止以秒或浮点时间戳作中间量；禁止 `dt` 累加推进播放头 |
| 5 | 预览、导出、缩略图、seek 共用同一函数，不得重写 |
| 6 | 音频时长以项目帧反推：`samples = divRoundHalfUp(Lp * 48000, fp)` |

## 5. 接口

`mapProjectFrameToAssetFrame(projectFrame, clip, asset, projectMilliFps): Frame | null`

**必须显式传项目帧率**：`clip.durationFrames` 是派生值，用它反推 `fs/fp` 会在非整除场景稳定偏 1 帧（判别见 `D1`–`D5`）。纯函数；`null` 表示无画面。全链路唯一实现。

## 6. 必测用例（单测须全绿）

| # | 场景 | 条件 | 输入 N | 期望 |
|---|---|---|---|---|
| `spec:T1` | 24→30 | `fs=24 fp=30 s0=0 i=0 o=240` | 10 | `S=8` |
| `spec:T2` | 30→24 | `fs=30 fp=24 s0=0 i=0 o=240` | 5 | `S=6` |
| `spec:T3` | 60→30 | `fs=60 fp=30 s0=0 i=0 o=600` | 7 | `S=14` |
| `spec:T4` | 25→30 | `fs=25 fp=30 s0=0 i=0 o=250` | 4 | `S=3` |
| `spec:T5` | 同帧率恒等 | `fs=fp=30 s0=50 i=100 o=400` | 60 | `S=110` |
| `spec:T6` | 边界首帧 | `fs=24 fp=30 s0=20 i=48 o=288` | 20 | `S=48` |
| `spec:T7` | 边界末帧 | 同 `spec:T6`，`Lp=300` | 319 | `S=287`（`= o-1`） |
| `spec:T8` | 跨 outFrame | 同 `spec:T6` | 320 | `null` |
| `spec:T9` | startFrame 之前 | 同 `spec:T6` | 19 | `null` |
| `spec:T10` | 分数帧率 | `fs=23976 fp=29970 s0=0 i=0 o=23976` | 100 | `S=80` |

同时须覆盖：`Lp` 计算（`spec:T1`/`spec:T3`/`spec:T5` 的 `Lp` 均须为 300），以及 `samples` 反推（`Lp=300, fp=30` → `samples=480000`）。

> **重要局限**：`spec:T1`–`T10` 全是**整除用例**（`(o−i)×fp` 恰被 `fs` 整除），**不能证明**「用 `durationFrames` 反推比例」与「显式传 `fp`」等价——前者在非整除场景稳定偏 1 帧。判别见 `D1`–`D5`、`arch:S8`，不得删除。

> 边界 no-op 约定（验收用）：切点落在片段首帧或末帧时，切分不产生操作、不入撤销栈，以免产生 0 帧片段。见 `acceptance-m1m2.md` §5.2 断言⑤。

> **切分守恒（R-016，混合帧率必读）**：①`A.out === B.in`；②`A.span + B.span === 原 span`；③`B.start === A.start + A.dur` —— 三条均 **0 容差**。④`|A.dur + B.dur − Lp| ≤ 1`，同帧率时必须为 0。已穷举：混合帧率下两侧 `round` 后**不可能**恒等于 `Lp`（1773 个切点中 206 个偏 ±1），故④给 1 帧容差；**不得为凑④改素材跨度**（丢帧）。用例见 `HL-R016-05`。

## 7. 工程 fps 变更重排（对应 PRD R-015）

| 步 | 规则 |
|---|---|
| 1 | 唯一触发点 `dispatch([setProjectParams])`；UI 层禁止自行重算 |
| 2 | `newDuration = divRoundHalfUp((o - i) * newFp, fs)`，**素材跨度 `o - i` 一律不动**（不丢帧、不重采样） |
| 3 | `newStart = divRoundHalfUp(oldStart * newFp, oldFp)`：按绝对时间等比，**保留间隙** |
| 4 | 同轨冲突时 `newStart = prevEnd`（**只贴紧，禁级联右推**） |
| 5 | 播放头同式映射并 clamp 到 `[0, durationFrames]` |
| 6 | 整批 = 1 个撤销步；弹窗须事先给出「受影响片段数 + 最大位移帧数」 |
| 7 | 显式禁止：删间隙、整轨右推、按新帧率重采样素材、改 `inFrame/outFrame` |
