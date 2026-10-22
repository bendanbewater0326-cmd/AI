# veditor

桌面端视频剪辑器。**第一优先级是像剪映一样简单**（三栏 + 拖拽 + 预设化），
**第二优先级是底层能被 AI Agent 直接调度**（GUI 与 Agent 共用同一套剪辑内核）。

形态是一个 esbuild 单包 Web 应用，可直接在浏览器、WebView2 或 Electron 外壳里跑；
桌面能力（按路径读文件、缓存到用户数据目录）通过可选的 `window.veditorHost` 桥接。

---

## 快速开始

```bash
npm install
npm run dev      # 开发服务（默认 127.0.0.1:5173，热更新）
npm run build    # 打包到 dist/（单文件 main.js）
```

打开 `http://127.0.0.1:5173/`，点「导入媒体」即可开始。

---

## 测试

```bash
npm run check    # 类型检查 + 时基静态扫描（禁止第二处帧/秒换算）
npm test         # 576 条单测（35 个脚本，Node 直接跑，不需要浏览器）
npm run e2e      # 全量 E2E（56 个浏览器脚本 + 1 个 Node 性质测试，约 14 分钟，无头）
npm run e2e:list # 只列清单
```

### ⚠️ 首次 clone 必须先生成测试素材

`tests/fixtures/` 里的音视频（合计 ~188MB）**不在仓库里**（见 `.gitignore`），
需要本机有 `ffmpeg` 时生成一次：

```bash
node tests/fixtures/compat/gen-baseline.cjs
```

不生成的话，E2E 会大面积失败（缺素材），而单测不受影响
（单测只用纯数据和 Node 环境）。

仓库里保留的是：`baseline.json` / `expected-meta.json`（基准数据）、
`*.cjs`（生成与分析脚本）、`ref/*.png`（比对参考帧，1.3MB）。

---

## 架构要点（看代码前先读这三条）

1. **内部一律整数帧，秒只在边界换算** —— 所有换算必须走 `core/timebase.ts`，
   `npm run check` 会扫描全仓，出现第二处换算就报错。
   （早期用浮点秒反推帧号，产生过 13.5% 的系统性音画相位错。）
2. **文档不可变 + 操作日志撤销** —— 所有修改都是 `ClipOperation`，
   一次 `dispatch` = 一个撤销步；没有"直接改 doc"的路径。
3. **同一个判断只写一份** —— 例如"轨道是否出画/出声"收敛在
   `core/trackAudibility`，"时间线几何"收敛在 `core/trackLayout`。
   写过两份的地方都出过"预览有、导出没有"这类 bug。

---

## 目录

```
src/
  core/      纯逻辑：类型、时基、操作、撤销栈、落轨、轨道布局与可听性
  media/     解封装/解码/音频/预览源/导入管线/重链/草稿缓存
  render/    WebGL2 合成器（+2D 降级）、时间线绘制、文字层、曲线/LUT/蒙版
  export/    MP4 / GIF / WAV / PNG 序列导出
  persist/   IndexedDB（工程、句柄、缩略图、代理、目录）、自动保存
  host/      宿主桥接（postMessage 命令、工程文件导入）
  ai/        自然语言 → 意图 → 操作
  ui/        React 组件（素材栏 / 预览 / 时间线 / 属性栏 / 对话框）
tests/       单测（*.test.mjs）+ 浏览器 E2E（verify-*.mjs）
docs/        见下方索引
scripts/     dev / build / 时基检查 / E2E 编排
```

---

## 文档索引

| 文档 | 什么时候看 |
|---|---|
| [`docs/PROJECT-STATUS.md`](docs/PROJECT-STATUS.md) | **最全**：现状、每个需求的实现要点、踩过的坑 |
| [`docs/architecture.md`](docs/architecture.md) | 架构与数据流（要改内核前读） |
| [`docs/nle-baseline.md`](docs/nle-baseline.md) | 加剪辑功能前先查：剪映/PR 是怎么做的、我们有意外偏离什么 |
| [`docs/manual-test-guide.md`](docs/manual-test-guide.md) | 手工验收清单（自动化测不到的"手感"） |
| [`docs/backlog.md`](docs/backlog.md) | 已确认但排在后续的优化项 |

---

## 素材恢复：五层兜底

导入过的素材，刷新后**默认零操作自动恢复**：

```
1. 本地草稿缓存池（OPFS / 宿主 drafts/assets）  ← 唯一不依赖外部条件的路径
2. Electron 宿主按绝对路径直读
3. 持久化文件句柄权限恢复
4. 授权目录静默扫描匹配（文件被改名/移动）
5. 以上全失败 → 顶部琥珀色提示条 + 手动重链
```

缓存池的开关与占用在顶栏「缓存」里管理（不会悄悄占磁盘）。
