
## 预览服务：必须用受管后台任务

`(PORT=5173 npm run dev &)` 这种"括号 + &"起的服务，**shell 一退出就被回收**，
表现为"预览面板打不开 / present_files 退回静态 HTML 快照"。已踩两次。
正确做法：用 Bash 工具的 `run_in_background: true` 起（有 task id，会话内保活），
再 `curl --noproxy '*' http://127.0.0.1:5173/` 确认 200，
最后用 `tests/cdp.mjs` 的 `launchPage` 真开一次页面确认**渲染**（200 ≠ 能跑）。

## 素材恢复：缓存池是终极兜底（2026-10-22 验收通过）

用户确认的三条原则（后续改动不得违反）：

1. **缓存池优先级最高，与原有四层完全兼容** —— 恢复顺序固定为
   `缓存池 → 宿主绝对路径 → 句柄权限 → 授权目录扫描 → 离线兜底`。
   缓存只"多一条保命路径"，不推翻任何一层；从缓存恢复时 `handle` 传 `undefined`
   （保留原句柄），不要传 `null`。
2. **异步拷贝、无缝切换、失败静默降级** —— 拷贝队列并发 2，导入完成才入队；
   失败不报错、不弹窗、不打断剪辑。
3. **必须给用户管理入口** —— 缓存不能悄悄占磁盘。顶栏「缓存」面板负责
   统计 / 开关 / 清理未使用 / 清空。

后续优化项记在 `docs/backlog.md`（拷贝队列持久化、配额显示+弱进度、工程打包导出）。
**合入主分支前注意**：仓库已在本地初始化（见下节）；`tests/fixtures/` 有 188MB 测试素材，
建议忽略大文件 + 用 `gen-baseline.cjs` 生成（详见 backlog 附录）。

## 版本管理（2026-10-22 建立）

- 仓库已在本地初始化（`git init`），`main` 分支；S1.3 之前 9 个提交，S1.3 后 10 个。
- **远端已配置**：`origin = https://github.com/bendanbewater0326-cmd/AI.git`，
  但**本机到 GitHub 完全不通**（代理 `CONNECT tunnel failed, response 502`，直连 000，
  关沙箱同样失败）。网络恢复后直接 `git push -u origin main`，不要再 `remote add`。
- `.gitattributes` 统一 `eol=lf`：此前一半文件是 CRLF，跨平台会出现"整文件被改动"的假 diff。
  写 `.gitignore` / `.gitattributes` **必须用 LF 行尾**（用 python 写要 `newline='\n'`，
  否则规则末尾带 `\r` 匹配不上，踩过一次）。
- `tests/fixtures/` 的音视频（~188MB）**不进仓库**，新环境首次 clone 后要先跑
  `node tests/fixtures/compat/gen-baseline.cjs`（需 ffmpeg），否则 E2E 会大面积失败。
  仓库里保留 `baseline.json` / `expected-meta.json` / `*.cjs` / `ref/*.png`。
- 提交身份已写进**本仓库** local config：`user.name=veditor` / `user.email=dev@veditor.local`。
  之前只在临时 `-c` 里传，换会话后 commit 会直接失败（"Author identity unknown"）。
  不要改成 `--global`。

## 反复出现的系统性风险：「数据层有、界面没接」

已连续两轮踩到同一个模式（S4 悬停态、S5 Ctrl 加选）：
`store` / `ephemeral` 里字段和 setter 都写好了、单测也过，但**没有任何 UI 调用点**，
于是功能从上线起就没生效过，而代码看起来完全正常。

**加任何交互状态时的自检项**：
1. `grep -rn "<setter名>" src/ui/ src/render/` —— 除了定义处，**必须有调用点**；
2. 该状态要有**像素级或 DOM 级**断言，只断言 store 字段等于没断言；
3. 状态优先级要写进注释（如 S4 的 锁定 > 选中 > 悬停 > 默认）。

同类风险还有：`toggleSelection`/`getSelection`（S5 摸底时发现 UI 零调用）。

## 测试坐标换算：不要除/乘 DPR

`layout` 的 `top/height` 与 `getBoundingClientRect()` **都是 CSS 像素**，
而 `canvas.width / rect.width` 是 DPR。两者混用会让 y 缩一半、落到别的区域
（实测：拖拽落点命中预览画布或工具栏，表现为"拖了没反应"，极难归因）。

正确：`屏幕 y = rect.top + row.top`，`屏幕 x = rect.left + headerWidth + frame*zoom - scrollX`。
`getImageData` 才需要乘 DPR。

## 测「挂载 / 初始化」逻辑：必须让那段代码真的跑一遍（2026-10-22 S1.2 教训）

窄屏媒体查询失效的 bug 在挂载 `useEffect` 里。第一版测试写的是
「清 localStorage + 手动 `removeProperty` 掉行内值 → 断言 16%」，
**等于替出问题的代码擦了屁股，带 bug 也是绿的**。

正确写法：清记忆 → 改窗口尺寸 → **真的 `location.reload()`** → 再断言。
验证过一次：带 bug 读到 25.2%、修好 16.1%。

**通用判据**：如果测试里出现"手动补齐被测代码本应产生的副作用"，这条断言就没牙。

## 三栏布局：grid 子项必须显式 `grid-column`（2026-10-22 S1.2）

`.v-body` 是 5 列 grid。面板折叠用 `display: none` 会**让子项脱离 grid 流**，
剩下的项自动放置往前挤一格 —— 实测折叠左栏后预览宽度变成 4px（落到了分隔条列）。
所以 5 个子项全部写死 `grid-column: 1..5`。

**阴点**：折叠右栏时不会暴露（尾部少一项、前面列号不变）。
凡是"从某一侧移除元素"的布局，**两个方向都要测**。

## 藏 flex 容器别用 `hidden`（2026-10-22 S1.3）

`[hidden]` 的浏览器默认样式 `display: none` **优先级低于类选择器**。
`.v-tabpane__slot { display: flex }` 会把"隐藏"盖掉 → 元素照样占位、照样能点，
而且看起来"隐藏逻辑没生效"。必须显式补 `[hidden] { display: none }`。

## "算在里面"要用差值断言，不能只断言自己（2026-10-22 S1.3）

44px 图标条到底是"算在 25% 内"还是"25% + 44px"，1440 下只差 3%，肉眼看不出来。
断言必须是 `内容区宽 = 左栏宽 − 44`（差值 0），只断言"图标条宽 44"两种实现都绿。
同 S1.2 的 grid 挤位：**断言元素之间的关系，不要断言元素自己的尺寸**。

## 百分比存"无单位变量"，长度派生一次（2026-10-23 S1.4）

`--v-timeline-pct: 50` + `--v-timeline-h: calc((100vh - var(--v-topbar-h)) * var(--v-timeline-pct) / 100)`。
若把 `--v-timeline-h` 直接写成 `50%`，它进到 `width: calc(100vh - … - 50%)` 时会按
**宽度**解析（百分比基准由属性语境决定）→ 预览尺寸静默算错，不报错。
另：`calc()` 之后 `getComputedStyle().getPropertyValue()` 返回的是 token 串
（`calc((100vh - 48px) * 50 / 100)`），**不是 px**，测试别拿它做数值断言。

## 布局常量改动前：先确认"文档里说已经能做"的代码真的接了事件（2026-10-23 S1.4）

`.v-timeline__splitter` 在方案文档里写着"已经能拖"，实际是个 `aria-hidden` 的空 div、
零事件监听 —— 和 S4 悬停态、S5 Ctrl 加选同一个模式。**动手前 grep 事件绑定**，
别信文档里的"已完成"。
