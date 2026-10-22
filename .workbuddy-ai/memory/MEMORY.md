
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
**合入主分支前注意**：此目录不是 git 仓库；`tests/fixtures/` 有 188MB 测试素材，
建议忽略大文件 + 用 `gen-baseline.cjs` 生成（详见 backlog 附录）。

## 版本管理（2026-10-22 建立）

- 仓库已在本地初始化（`git init`），首次提交 `37eb021`，第二次 `fa6987f`（README + 行尾规范）。
- **还没有远端**（`git remote -v` 为空）。接远端后直接 `git push -u origin main`。
- `.gitattributes` 统一 `eol=lf`：此前一半文件是 CRLF，跨平台会出现"整文件被改动"的假 diff。
  写 `.gitignore` / `.gitattributes` **必须用 LF 行尾**（用 python 写要 `newline='\n'`，
  否则规则末尾带 `\r` 匹配不上，踩过一次）。
- `tests/fixtures/` 的音视频（~188MB）**不进仓库**，新环境首次 clone 后要先跑
  `node tests/fixtures/compat/gen-baseline.cjs`（需 ffmpeg），否则 E2E 会大面积失败。
  仓库里保留 `baseline.json` / `expected-meta.json` / `*.cjs` / `ref/*.png`。
- 提交身份用 `-c user.name=... -c user.email=...` 临时指定，没有全局配置。

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
