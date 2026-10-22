# 待办清单（Backlog）

> 记录**已确认但排在后续迭代**的优化项。每条都写清"落在哪、怎么验收"，
> 下次开工不需要重新调研。
>
> 最后更新：2026-10-22（缓存池验收通过时确认）

---

## 1. 拷贝队列持久化（下次打开自动续传）

**现状**：`media/draftCache.ts` 的拷贝队列在**内存**里。导入后立刻关页面，
没拷完的素材就断了（下次打开不会重试）。

**影响面**：只影响"导入后马上关页面"这一种情况。正常情况下 2.8MB 素材 1 秒内写完；
大文件（2GB）需要停留十几秒。

**怎么做**：

1. 新增 IDB store `cacheJobs`（`assetId` → `{ fileHandleRef | blobKey, cacheName, sourcePath, addedAt }`）；
2. `enqueueCacheWrite` 时同步写一条 job 记录，完成后删掉；
3. App 启动（`restoreSession` 之后）读 `cacheJobs`，把未完成的重新入队；
4. **注意**：`File` 对象不能直接存 IDB（`FileSystemFileHandle` 可以）。所以续传有两种来源：
   - 有句柄的素材 → 用句柄 `getFile()` 拿文件（权限 granted 才行）；
   - 没句柄的素材 → 只能放弃（源字节已经不在了）。
   **也就是说这条优化对"有句柄的素材"才有意义** —— 实现时要在 UI 上如实说明。

**验收**：导入 2GB 素材 → 3 秒内关页面 → 重开 → 缓存面板里那个素材在几秒内补齐。

**风险**：`cacheJobs` 记录会和"素材被删/缓存被清"打架，需要一份 `unusedJobs()` 清理逻辑
（参考 `unusedEntries`）。

---

## 2. 缓存配额显示 + 素材弱进度提示

**现状**：缓存面板只显示"已用 X MB"，不显示"能用多少"。
导入 2GB 素材时用户不知道后台在拷什么（拷贝是静默的，这是刻意的）。

**怎么做**：

1. **配额**：`navigator.storage.estimate()` 拿 `{ usage, quota }`，
   面板显示「已用 128 MB / 可用 8.2 GB」；占用超过 80% 时那一行变琥珀色并给一句
   "缓存接近上限，可在下方清理"。
   Electron 侧走宿主 `cacheStats()` 返回的配额（主进程能查磁盘剩余）。
2. **弱进度**：素材卡右下角一个 2px 的细进度条（`enqueueCacheWrite` 目前没有进度回调，
   要给 `CacheBackend.put` 加 `onProgress`，OPFS 的 `createWritable` 支持 `write` 分段，
   可以按 4MB 一块上报）。
   **只给"大于 200MB 的素材"显示** —— 小文件 1 秒就完了，闪一下反而像 bug。

**验收**：面板显示配额；导入 2GB 素材时卡片右下角有细进度条，完成后消失。

**注意**：不要做成弹窗或顶栏提示。用户明确要求"失败静默降级不打扰"，
进度也必须是**弱提示**（不抢焦点、不挡操作）。

---

## 3. 工程打包导出（工程 + 缓存素材一起带走）

**现状**：`.vedproj` 只含工程 JSON（素材只有元数据）。换机器打开时素材全部离线，
要靠重链/缓存重新找。

**怎么做**：

1. 新增导出格式 `.vedpack`（ZIP）：
   ```
   project.vedproj
   assets/sha256-….mp4      ← 直接从缓存池读（有缓存就不必重新读源文件）
   assets/manifest.json     ← assetId → 文件名 + 指纹
   ```
2. 打开时：解出 `assets/` 到内存（或写进缓存池），`handleRef` 置空、`cacheKey` 指向解出的文件；
3. **体积要如实告知**：打包前先算总大小，弹一句"将包含 3 个素材，共 1.2 GB"；
4. 复用 `export/zip.ts`（已有 `createZip`，目前用于 PNG 序列）。

**验收**：导出 `.vedpack` → 换一台机器（清空 OPFS）→ 打开 → 素材全部在线、时间线完整。

**依赖**：需要先有"缓存池读取"的批量接口（`readCachedAsset` 已有，但要支持"按 asset 列表批量读"）。

---

## 附：合入主分支前需要确认的两件事

### A. 仓库已在本地初始化（原记录"不是 git 仓库"已过期）

```
$ git rev-parse --is-inside-work-tree
true
```

- 2026-10-22 已 `git init`，当前 `main` 分支 **9 个提交**，工作区干净；
- 提交身份写在本仓库 local config（`user.name=veditor` / `user.email=dev@veditor.local`），
  **不是** `--global`；
- `.gitattributes` 统一 `eol=lf`（此前一半文件是 CRLF，跨平台会出现"整文件被改动"的假 diff）；
- **远端已配置但尚未推送成功**：`origin = https://github.com/bendanbewater0326-cmd/AI.git`。
  本机到 GitHub 的网络被代理拦（`CONNECT tunnel failed, response 502`），
  网络恢复后直接 `git push -u origin main` 即可，不需要再 `remote add`。

### B. `tests/fixtures/` 有 **188 MB** 的测试素材

这些是 E2E 用的合成视频（`sample-720p.mp4`、`uhd-4k.mp4`、`long-10min.mp4` 等）。
直接提交会让仓库膨胀到几百 MB，clone 一次要等很久。

三个选项：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A（推荐）** | 忽略大 mp4，保留生成脚本 | 新环境要先跑一次 `node tests/fixtures/compat/gen-baseline.cjs`（需要本机有 ffmpeg） |
| B | Git LFS | 需要远端支持 LFS，clone 仍需下载 |
| C | 全提交 | 仓库永久 188MB+，每次改动历史都背着 |

`gen-baseline.cjs` 已经存在（用 ffmpeg 生成），所以方案 A 是可行的 ——
需要在 `.gitignore` 加：

```gitignore
tests/fixtures/**/*.mp4
tests/fixtures/**/*.webm
tests/fixtures/**/*.m4a
```

并在 README 里写清"首次 clone 后先跑生成脚本"。
