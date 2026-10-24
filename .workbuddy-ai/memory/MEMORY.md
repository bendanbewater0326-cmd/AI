# veditor 项目长期记忆（MEMORY）

> **详细上下文**：`docs/PROJECT-STATUS.md`（项目全史 + 状态 + 踩坑 + 冷启动）
> **最后更新**：2026-10-23（合并两处记忆目录 + 数字更新到实测值）
>
> ⚠️ **本文件双写两份，改完必须同步**（2026-10-23 合并后确立）：
>
> | 位置 | 用途 |
> |---|---|
> | `.workbuddy/memory/MEMORY.md` | 会话系统提示读这里 |
> | `.workbuddy-ai/memory/MEMORY.md` | **进 git 的存档**（工作记忆留档） |
>
> 两份内容必须完全一致（`md5sum` 校验）。历史上曾因只写一份导致
> "10-23 检查时误判今天没有工作日志"，别再让它们分叉。

## 项目一句话

可嵌入 AI 客户端的极简视频剪辑器（纯前端 + WebCodecs + WebGL2 + IndexedDB）。
**AI 隐形化**：默认零 AI 痕迹，`Cmd/Ctrl+K` 唤起，`Esc` 消失。

## 当前状态（2026-10-23 实测）

**P0（32）+ P1（19）+ P2（13）= 64 条需求全部交付**。
其中 R-056 / R-057 / R-058 / R-059 是**部分交付**（机制+规则做了，需要模型的那半没做，口径见 STATUS §7.1）。

| 维度 | 实测值 | 复现 |
|---|---|---|
| 源码 | **105 个 ts/tsx / 3.3 万行**（108 文件含 app.css） | `Get-ChildItem -Recurse src -Include *.ts,*.tsx` |
| 单测 | **780 条 / 46 脚本全绿** | `npm test` |
| E2E | **72 个 `verify-*.mjs`**（全量 72/72，约 20 分钟） | `ls tests/verify-*.mjs \| wc -l` |
| 构建 | `main.js` **899.0KB**（含 10 个内联音效）+ `main.css` 57.2KB | `npm run build` |
| 时基守卫 | **114 文件 0 违规** | `npm run check` |
| git | 工作区干净、**28 提交**（领先 origin 18）、`.git` 20.6M | `git status --short` |

> 数字会过期。**改功能时连数字和命令一起改**，别再写死快照。

### 左栏 9 个 Tab 的实际完成度（2026-10-23 核实）

| 有真实内容 | 仍是 `TabPlaceholder` 占位 |
|---|---|
| 素材 / 文本 / 音频（音效库） / 转场 / 特效 / 调节 / 字幕 / 设置 | **贴纸** |

## 长期约定（跨会话遵守）

### 技术约束（破坏必出 bug）

1. **时基唯一换算点**：所有帧↔时间换算必须走 `src/core/timebase.ts`
2. **借来的 `VideoFrame` 禁止 close**；`ensureFrame` 交付的是 clone（归调用方）
3. **fpsMilli 是毫帧率**（30fps = 30000，不是 30）
4. **解码器池纪元（epoch）**：seek 时递增，迟到的旧 epoch 帧必须 close

### 技术定案（已拍板，不再讨论）

- 不引入播放器库/timeline 库（自己写 WebCodecs + WebGL2）
- 不引入 Vite/Webpack（esbuild 自写构建）
- 无后端（IndexedDB + FileHandle 引用）
- AI 只输出白名单 `ClipOperation`（不自由改 doc）
- **导出四种：MP4 / GIF / WAV / PNG 序列（透明通道，ZIP）**；WebM 只支持导入、不提供导出（PRD Q9）
- **透明通道必须用 `createCompositor({ alpha: true })`**：否则清屏 alpha=1，PNG 全是不透明黑
- **蒙版语义**：`maskAlphaAt` 是"区域内保留、区域外遮住"，所以"遮住X"必须 `invert:1`、"只露X"才是 `invert:0`；`invert` 在 params 里存 **1/0**（`maskOf` 判 `=== 1`，boolean 会被静默当 false）
- **用户只用客户端，不开外置浏览器**：实操走 `npm run dev` + `present_files` 内置预览面板；
  应用内有顶栏「自检」（6 项，复用 `__VEDITOR_TEST__` 钩子），别让他去开 Chrome。
- **预览服务必须用受管后台任务**：`(PORT=5173 npm run dev &)` 这种"括号 + &"起的服务，
  **shell 一退出就被回收**，表现为"预览面板打不开 / present_files 退回静态 HTML 快照"。已踩两次。
  正确做法：Bash 工具 `run_in_background: true`（有 task id，会话内保活）→
  `curl --noproxy '*' http://127.0.0.1:5173/` 确认 200 → 再用 `tests/cdp.mjs` 的 `launchPage`
  真开一次确认**渲染**（200 ≠ 能跑）。
- **E2E 全无头**（`cdp.mjs` 用 `--headless=new`，不弹窗）；连跑时脚本之间要留 1 秒，
  否则残留 Chrome 抢解码器，`verify-proxy` 会卡在"代理生成中"。
- **改完源码必须先 `npm run build` 再跑 E2E**：E2E 跑 `dist/`，不重建就是测上一版（曾假红 5 项）。
- **预览音频不要逐块重采样**：sinc 核要块边界外的样本，逐块调用 = 每秒二十来处爆音（听感"一直沙哑"）。
  直接把**源采样率**的 AudioBuffer 交给 WebAudio（它做整段高质量重采样）。
- **声道数以 AudioSpecificConfig 为准**（`[objType 5][freqIndex 4][channels 4]`，freqIndex=15 时放弃）：
  微信在 stsd 里写 2，真实常是单声道。
- **别把"打开即重置"写在 effect 里**：会和用户第一下输入抢时序（字被清空）。用条件挂载。
- **测试素材的参数多样性也是覆盖度**：采样率/声道/帧率恰好一致，bug 就永远测不出来。
- **交互类 E2E 别用测试钩子抄近路**：先 `selectClip()` 再拖，正好绕过"手柄要求先选中"的真 bug。
  能用真实指针事件（CDP `Input.dispatchMouseEvent`）就走真路径。
- **裁剪手柄不要求先选中**（未选中 6px / 选中 8px）；**点片段也会定位播放头**；
  **末帧按播放回到 0 重播**（R-007 只管 ←/→ 步进不回绕）。
- **缩略图必须 `draggable={false}`**：否则拖素材卡会把 PNG 当文件导入，报"请转为 mp4"（误导性报错）。
- **E2E 只能"等条件"，不能"等时间"**：固定 `sleep(N)` 单跑够、全量连跑不够（机器被压着）。
- **`decodeTest()` 会 bump epoch 取消在飞渲染**：诊断要排在拍快照之后，否则快照是空的（层数 0）。
- **`decodeFailures` 不再统计"epoch 取消"**（`EPOCH_CANCEL_MESSAGE`）：那是正常取代，不是失败。
- **轨道三个开关走同一个操作** `setTrackFlag { flag: muted|hidden|locked }`；
  `locked` 的守卫在 `applyOperation` 入口（`clipTracksForOp`），抛 `TrackLockedError`；
  `store.record` **只捕获这一类**转错误条，其它异常照旧抛（统一 catch 会让真 bug 变成一条不起眼的提示）
- **轨道要能删**：`trackRemoveBlockReason` —— 至少留一条视频轨、锁定轨不可删；
  有内容的轨允许删（撤销能整体回退）。轨道头 `×` 不可删时给 `aria-disabled` + 原因
- **落轨规则只有一处**（`core/placement`）：首选 V1/A1，占用则换空闲轨，都占用就新建轨；
  **永远不要退回"硬塞 V1"**——会造成同轨重叠（画面叠着、音量翻倍），并让多机位不可达
- **ASR 是可选能力**：`AIModelPort.transcribe?` 不实现就是没有，**绝不兜底成空数组**；
  输入统一由客户端整理成 16k 单声道，宿主不该知道工程采样率
- **测试断言别用"对称指标"**：全画面均值分不出"遮左/遮右""增亮/变暗"，必须分区域/分方向量
- **宿主通道 = 四条命令**（`getProject` / `setProject` / `importAsset` / `export`），
  协议在 `core/types.ts`，实现在 `host/commands.ts`；入站工程必须过 `projectInput.ts` 归一化
- **接入方式不是互斥的，别再写成 if/else 二选一**：`pickAdapter()` 曾先判 `?src=` →
  "iframe + ?src=" 既没有命令通道也发不出 `ready`

- **主题只有「默认 / 高对比」二态**，不做常规深色主题（2026-10-23 用户拍板进 **P2 长期队列**：
  要补近 4000 行 CSS 的整套 dark 变量 + 逐屏核对，收益不匹配；高对比已覆盖弱光诉求）。
  设置面板与顶栏「工程」菜单是**同一个开关**（`ui/theme.setTheme`），`toggleTheme` 委托它。

### 素材恢复：缓存池是终极兜底（2026-10-22 验收通过，用户确认三条原则）

1. **缓存池优先级最高，与原有四层完全兼容** —— 恢复顺序固定为
   `缓存池 → 宿主绝对路径 → 句柄权限 → 授权目录扫描 → 离线兜底`。
   缓存只"多一条保命路径"，不推翻任何一层；从缓存恢复时 `handle` 传 `undefined`（保留原句柄），不要传 `null`。
2. **异步拷贝、无缝切换、失败静默降级** —— 拷贝队列并发 2，导入完成才入队；失败不报错、不弹窗、不打断剪辑。
3. **必须给用户管理入口** —— 缓存不能悄悄占磁盘。顶栏「缓存」面板负责统计 / 开关 / 清理未使用 / 清空。

后续优化项在 `docs/backlog.md`（拷贝队列持久化、配额显示+弱进度、工程打包导出）。

### 版本管理（2026-10-22 建立）

- 仓库已 `git init`，`main` 分支、13 个提交；工作区干净。
- **远端已配但未推送**：`origin = https://github.com/bendanbewater0326-cmd/AI.git`，
  本机到 GitHub 不通（代理 `CONNECT tunnel failed 502`）。网络恢复后直接 `git push -u origin main`。
- `.gitattributes` 统一 `eol=lf`；写 `.gitignore` / `.gitattributes` **必须用 LF**（Python 要 `newline='\n'`，
  否则规则末尾带 `\r` 匹配不上，踩过一次）。
- `tests/fixtures/` 音视频（~188MB）**不进仓库**，新环境 clone 后先跑
  `node tests/fixtures/compat/gen-baseline.cjs`（需 ffmpeg），否则 E2E 大面积失败。
- 提交身份写在本仓库 local config（`user.name=veditor` / `user.email=dev@veditor.local`），**不要改成 `--global`**。

## 已知未解决（别重复劳动）

1. **没有未交付需求了**，但有 4 条"部分交付"（**别把设计边界当 bug 修**）：
   R-056 无自动跟踪 / R-057 无说话人识别（用音频能量近似）/ R-058 无色域转换 /
   R-059 客户端不做 ASR，但**通道已通**（宿主实现 `AIModelPort.transcribe` 即可）。
2. **VFR 素材节奏不精确**：线性帧号映射假设 CFR，总时长对、内容有拉伸。
3. **左栏只剩「贴纸」是空壳**（音频已做成内置音效库，2026-10-24）—— 贴纸明确延后。
4. **特效面板没有"我的预设"**（文本面板有；计划里写"第三步再说"但已标收官）。
5. **云 LLM 未做真实联调**（代码就绪，缺云环境）。

### AI 通道（三种，同一个 `AIModelPort` 端口）

宿主注入（`mountVeditor(el, { aiModel })`）/ **云 LLM**（`src/ai/cloudLLM.ts`，fetch 直调
`/.cloud/llm/chat/completions`，免 Key，需开通云环境）/ 离线规则（`createMockProvider`）。
云 LLM 有 18 条 mock 单测，**尚未真实联调**（缺云环境，属外部条件）。

## 已交付的 P2 关键实现（2026-10-21，12 条）

- **R-057 多机位**：`ai/multicam.ts`。**不新建片段**——切换点 `splitClip` 切开各机位轨，
  每段只让选中的机位 `enabled=true`（渲染层本来跳过）。切分+开关 = 一个撤销步。
  "跟说话人"用**每轨音频能量**近似。两个坑：① 时间线比切换间隔短必须**报错**；
  ② "多机位每 2 秒切一次"不以动词开头 → `classifyTone` 判成提问 → `looksImperativeFor()` 要补 `机位`/`跟说话`。
- **R-056 蒙版**：`render/mask.ts` + 着色器 `maskAlpha`。**关键帧挂在 effect 上**（复用 `Effect.keyframes`）。
- **R-058 LUT**：`render/lut.ts` + `applyLut`。**两个白屏坑**：`sampler3D` 必须写 `mediump`；
  模板字符串里不能出现反引号。坐标要半像素偏移。
- **R-059 字幕**：`subtitle/srt.ts`；**不做 ASR**。新增 timebase 原语 `msToFrame`/`frameToMs`。
- **R-055 曲线**：JS 与 GLSL 是**两份实现**，单测只覆盖 JS，必须 E2E 像素验证 GLSL。
  对比曲线绕 0.5 旋转 → 均值几乎不变，别拿均值断言。
- **R-061 降噪**：`media/denoise.ts` 高通→存在感→噪声门，逐样本无状态；**不做谱减**。
- **R-063/R-064**：触屏只改 CSS（**不动轨道高**，那是 JS 命中测试常量）；aria-live 播报必须 400ms 节流。
- **R-053 预设**：只存"被改过的样式字段"，不存时间与转场；套用 = 一批 op 一次 dispatch；上限 40。
- **R-054 工程迁出**：`.vedproj` + `normalizeProjectInput` 校验 + `resetPreviewSources()` 后再 replaceDoc。
  **导入逻辑只有一份**（`media/importAsset.ts`）。
- **R-052 代理媒体**：4K 自动转 960px 代理存 IDB，预览用代理、导出用原片。
  **切源必须 `unregisterAsset` → `registerAsset`**（只 register 留着旧帧缓存 → 黑屏且不自愈），
  且要**等到 `decoded === true`**。实测 42.2ms/帧 → 4.4ms/帧。
- **R-060 智能粗剪**：`media/silence.ts` + `core/rippleDelete.ts` + `ai/roughCut.ts`。
  **模型只判意图，位置必须本地算**。
- **R-062 透明通道导出**：`alpha` 选项 + 自写 ZIP（store 模式）+ `frame_000001.png` 序列 + `frames.json`。

## 最重要的两课

1. **规格里的每个数学公式，都必须有"反例用例"证明它不能被等价替换。**
   时基 bug 造成 13.5% 相位错，30 个测试全绿没抓到——因为全是整除组合，对反推实现免疫。
2. **同一条规则只能有一个定义点。** 本项目 90% 的隐蔽 bug 出在"两处写了同一条规则"
   （如 `duration-1` 的 clamp 写了两份 → 片尾追加重叠 1 帧）或"返回值语义/单位"
   （`speedOf` 返回 1000 而非因子 1、`1e9/ns` 是帧/秒而非毫帧率）。改这类代码前先搜第二份实现。

## 10-22 / 10-23 的实战教训（18 条，每条都是踩过的）

### 反模式：数据层有、界面没接

已连续两轮踩到同一个模式（S4 悬停态、S5 Ctrl 加选）：`store` / `ephemeral` 里字段和 setter
都写好了、单测也过，但**没有任何 UI 调用点**，功能从上线起就没生效过，而代码看起来完全正常。
同类还有 `toggleSelection`/`getSelection`（UI 零调用）、`.v-timeline__splitter`（文档说"已经能拖"，
实际是 `aria-hidden` 空 div、零事件监听）。

**加任何交互状态时的自检项**：
1. `grep -rn "<setter名>" src/ui/ src/render/` —— 除了定义处，**必须有调用点**；
2. 该状态要有**像素级或 DOM 级**断言，只断言 store 字段等于没断言；
3. 状态优先级写进注释（如 S4 的 锁定 > 选中 > 悬停 > 默认）。
4. **别信文档里的"已完成"**，动手前 grep 事件绑定。
5. **新加的 `tests/*.test.mjs` 必须确认已进 `npm test` 的脚本列表**：`settings.test.mjs` 就曾单跑全绿、而全量 "699 条全绿" 里压根没跑它。**判据：加完脚本 `npm test` 的总条数必须变多。**

### 测试坐标换算：不要除/乘 DPR

`layout` 的 `top/height` 与 `getBoundingClientRect()` **都是 CSS 像素**，
而 `canvas.width / rect.width` 是 DPR。混用会让 y 缩一半、落到别的区域
（实测：拖拽落点命中预览画布，表现为"拖了没反应"，极难归因）。
正确：`屏幕 y = rect.top + row.top`，`屏幕 x = rect.left + headerWidth + frame*zoom - scrollX`。
`getImageData` 才需要乘 DPR。

### 测「挂载/初始化」逻辑：必须让那段代码真的跑一遍（S1.2）

窄屏媒体查询失效的 bug 在挂载 `useEffect` 里。第一版测试"清 localStorage + 手动 removeProperty →
断言 16%"，**等于替出问题的代码擦了屁股**，带 bug 也是绿的。
正确：清记忆 → 改窗口尺寸 → **真的 `location.reload()`** → 再断言。
**通用判据**：测试里出现"手动补齐被测代码本应产生的副作用"，这条断言就没牙。

### 三栏布局：grid 子项必须显式 `grid-column`（S1.2）

`.v-body` 是 5 列 grid。折叠用 `display: none` 会让子项**脱离 grid 流**，剩下的自动往前挤一格
（实测折叠左栏后预览宽度变成 4px）。所以 5 个子项全部写死 `grid-column: 1..5`。
**阴点**：折叠右栏不会暴露（尾部少一项、前面列号不变）→ **两个方向都要测**。

### 藏 flex 容器别用 `hidden`（S1.3）

`[hidden]` 的浏览器默认 `display: none` **优先级低于类选择器**。
`.v-tabpane__slot { display: flex }` 会把"隐藏"盖掉 → 元素照样占位能点。
必须显式补 `[hidden] { display: none }`。

### "算在里面"要用差值断言（S1.3）

44px 图标条是"算在 25% 内"还是"25% + 44px"，1440 下只差 3%，肉眼看不出来。
断言必须是 `内容区宽 = 左栏宽 − 44`（差值 0）；只断言"图标条宽 44"两种实现都绿。
**断言元素之间的关系，不要断言元素自己的尺寸。**

### 百分比存"无单位变量"，长度派生一次（S1.4）

`--v-timeline-pct: 50` + `--v-timeline-h: calc((100vh - var(--v-topbar-h)) * var(--v-timeline-pct) / 100)`。
若把 `--v-timeline-h` 写成 `50%`，进到 `width: calc(100vh - … - 50%)` 时会按**宽度**解析
（百分比基准由属性语境决定）→ 预览尺寸静默算错，不报错。
另：`calc()` 之后 `getPropertyValue()` 返回 token 串（不是 px），测试别拿它做数值断言。

### 无头测试：有音轨素材播放头不动（S1.5）

`play()` 优先选音频时钟；无头里 AudioContext 不推进，`derivedFrame()` 永远算回 anchor 帧。
症状：`aria-pressed=true` 但 `playheadFrame()` 2 → 2（像"播放键坏了"）。
**要测播放推进，用无音轨素材**（`silent-720p.mp4`）。
另：`element.click()` 绕过命中测试，被移动/叠加过的控件必须用 `Input.dispatchMouseEvent` 真实点击 +
`elementFromPoint` 命中自身。CDP 拖拽的最后一次 `mousemove` 与 `mouseReleased` 之间要留 60ms 并复述落点。

### 任何"模板/贴纸/预设位置"必须按分辨率换算（文本面板）

`TextContent.x/y/fontSize` 是**项目绝对像素**。模板按 1080p 写死时，落到 1280×720 工程上
`y=380` 已超半画面高（360）→ 文字被推出画面、预览纯黑，而 doc 里字段完全正确。
统一做法：`presetToText(preset, content, {width, height})`，按 `height/1080` 缩放字号/描边/y，
按 `width/1920` 缩放 x。**判据：断言要落在画面像素上**。

### 加可选字段要改 4 处（`TextContent.bold/stroke`）

`types.ts` 接口 → `render/*.ts` 的绘制**与缓存 key** → `core/preset.ts` 的
`capturePreset`/`normalizePayload` → `host/projectInput.ts` 的 `normalizeText`。
漏缓存 key：改了样式画面不变（只断言 doc 字段测不出来）。漏 normalizeText：存盘再打开样式消失。

### `track.order` 只在同类型内唯一，不能当合成顺序

视频 0/1/2…、文字 0/1… 会撞号 → **文字被视频盖住**（症状："doc 里有文字、预览像素一点没变"）。
合成顺序一律走 `core/types.trackCompositeOrder()`（文字 `10000+order`）。
注意它与 `trackDisplayOrder` **方向相反**：屏幕顺序文字在最上一行，合成顺序文字最后画。

### 同一份数据被两个组件各读一次 = 一定不同步

属性栏和左栏文本面板都有"预设列表"，都 `useEffect(..., [])` 只读一次 → 一处增删另一处永远旧数据。
修法：`persist/presets.ts` 写入成功后 `dispatchEvent(PRESETS_CHANGED)`，两边订阅重读。
**判据：凡是"两处都能改同一份持久化数据"，就必须有变更广播（或共享 store）。**

### 时间线画布上"按颜色筛像素"几乎总是错的

片段底色 `--v-clip: #d9d7f0`（淡紫），转场楔形只是同色系加深 → 按"偏紫"筛会把整块片段算进去
（实测两档都满格 159px，像"宽度没变"）。
**要量某个绘制元素的范围，用"两次渲染逐点做差、看差异延伸到多远"**，与底色/抗锯齿都无关。

### 缩略图别用 CSS filter 近似着色器（特效面板）

着色器 `c += b/200` 是**加法**，CSS `brightness()` 是**乘法**；contrast 也不是同一条曲线。
用 CSS 做缩略图 → 卡片和预览不是一个颜色 → 用户觉得"骗人"。
正确：`render/grade.ts` 逐像素复算，与 `GRADE_GLSL` **逐字对应**（照 `render/curve.ts` 先例，
注释写"两边必须一起改"）。**判据：缩略图和成片必须能对得上。**

### 从 IDB 读"导入产物"要重试，且 effect 不会自己重跑

`thumbnailRef` 导入时**同步**填好，但 blob 是异步 `putThumbnail` 写的。常驻挂载的面板很可能
在落库前读一次 → 读不到就**永久**停在兜底图（依赖项 `assetId` 没变，effect 不重跑）。
修法：读不到就重试（特效面板用 5 次 × 400ms）。
**判据：凡是"读异步写入的导入产物"，都要么重试、要么订阅写入完成。**

### 测试里的 `xxx?.()` 会把"接口不存在"吞掉

`window.__VEDITOR_TEST__.dismissAllErrors?.()` 用了可选调用，而那个钩子**根本不存在** →
不报错、不清理 → "有没有报错"读到的是几步之前的历史错误：**该报错时通过、不该报错时也通过**。
判据：测试里调测试钩子**不要用 `?.()`**，或先 `typeof fn === 'function'` 断言。

### 同类：`lastUndoLabel` 也不存在

`verify-relink` ⑤ 断言"重链不进撤销栈"，读 `lastUndoLabel?.()` → 钩子不存在 → 读到空串 →
`!''.includes('重新链接')` **恒真**，这条断言从来没验过任何东西。
修法：store 加 `peekUndoLabel()`（只读栈顶不移动），断言改成**操作前后各读一次、比较相等**。
**判据：凡是"某操作不该产生副作用"的断言，必须前后对比。**

### 已解决：panel 布局溢出（2026-10-21）

根因是 **shadow DOM 样式隔离**，`main.css` 没进 shadowRoot。
修法：`connectedCallback` 克隆 document 的 `<link rel="stylesheet">` 到 shadowRoot。
**CSS 没生效时，先查 `getComputedStyle().display` 判断是不是整条样式都没了。**

### 已解决：播放中卸载 rAF 是否停（2026-10-21）

**会停**。用 CDP 真实鼠标事件点播放按钮验证（脚本 `.click()` 不翻转 React 状态），20 轮无累积。

## 常用命令

```bash
cd "D:/项目专用文件夹/剪辑工具"
npm test            # 699 单测 / 40 脚本
npm run check       # 类型 + 时基静态扫描（108 文件）
npm run build       # 构建（看 dist/main.js 体积）
npm run e2e                       # 全量 E2E（约 10 分钟，交付前必跑）
# ！本机（Chatbox + PowerShell）注意：`node` 是个包装函数，跑**脚本文件**时会吞掉 stdout；
#   而 nvm 的 node.exe 是 v20（无全局 WebSocket）。所以单跑 E2E 用：
#   node.exe --experimental-websocket tests/verify-xxx.mjs
node tests/verify-realworld.mjs   # 真实素材回归（最全面）
node tests/verify-panel-leak.mjs  # 宿主集成回归
node tests/verify-postmessage.mjs # 宿主命令通道
node tests/verify-png-export.mjs  # 透明通道导出
node tests/verify-roughcut.mjs    # 智能粗剪
node tests/verify-proxy.mjs       # 代理媒体
node tests/verify-project-file.mjs # 工程迁出
node tests/verify-preset.mjs      # 预设
node tests/verify-touch-a11y.mjs  # 触屏 + 无障碍
node tests/verify-multicam.mjs    # 多机位
```

## 文档导航

- **详细状态/全史/冷启动**：`docs/PROJECT-STATUS.md`（37 节，220KB）
- **PRD（64 条）**：`docs/PRD.md`
- **架构**：`docs/architecture.md`
- **时基规格**：`docs/frame-clock-spec.md`
- **剪辑行为基线（剪映/PR 对照）**：`docs/nle-baseline.md`
- **待办**：`docs/backlog.md`
- **产品规划**：`docs/product-plan.md`
- **面板方案**：`docs/text-panel-plan.md` / `transition-panel-plan.md` / `effect-panel-plan.md`
- **UI 重构**：`docs/ui-refactor-plan.md`
- **手工测试**：`docs/manual-test-guide.md` / `manual-test-findings-2026-10-21.md`
- **按日工作日志**：`.workbuddy/memory/YYYY-MM-DD.md`（**权威**）
