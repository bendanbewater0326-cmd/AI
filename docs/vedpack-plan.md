# .vedpack 工程打包导出方案（已交付，2026-10-24：V1 核心层 + V2 入口 + V3 E2E）

> 摸底日期：2026-10-24。目标：工程 JSON + **素材字节**打包为单文件，拖入即可完整恢复——
> 补齐「保存-迁移-分享」闭环。与现有 `.vedproj`（纯元数据）**并行不替代**。
> 零核心改动：不动 `render/export(编码)/media 解码`；全部是 persist/ui 层的组装工作。

---

## 1. 摸底：底数比预期厚，缺口只有两个

### 1.1 现成件

| 件 | 现状 | 对本方案的作用 |
|---|---|---|
| 工程信封 | `serializeProjectFile` / `parseProjectFile`（R-054，`.vedproj`） | **原样复用**为包内 `project.json`——格式、版本校验、素材清单全成熟 |
| ZIP 写入 | `export/zip.ts createZip`（PNG 序列导出在用，**store 模式**） | 打包容器现成；store 对已压缩的音视频**正好**（deflate 无收益白耗 CPU） |
| 素材字节三来源 | 内存源 `getPreviewSource().source`（Blob）→ 缓存池 `readCachedAsset(cacheKey, name)` → 句柄 `handleRef.getFile()` | 与自动恢复同序：内存最快、缓存最稳、句柄兜底 |
| 字节绑回链路 | `relinkAssetFromFile({ assetId, file })`（`restoreFromCache` 就是这个套路） | 按 **assetId 直绑**（不走 hashKey 查重，无漂移问题）；probe→注册→缩略图→清解码缓存一条龙 |
| 工程载入 | `parseProjectFile → replaceDoc`（TopBar 的 .vedproj 导入路径） | 包内 project.json 走同一条路 |

### 1.2 缺口（本方案要写的）

1. **没有 unzip**：`zip.ts` 只有写。补一个**最小只读解包**（只认 store 条目——我们自己的产物
   全是 store；外部 deflate ZIP 给可读拒绝"不是 veditor 工程包"）。中央目录解析 + CRC 校验。
2. **没有打包编排层**：字节收集（三层来源）+ 清单 + 组装 + 下载；导入编排：解包 →
   replaceDoc → 逐素材 relink。

---

## 2. 格式设计

```
xxx.vedpack = ZIP（store 模式）
  pack.json              ← 清单：{ format:'veditor-pack', version:1, entries: { [assetId]: { path, name, size, contentHash? } } }
  project.json           ← 现有 .vedproj 信封原文（serializeProjectFile 产物）
  assets/<assetId>/<原文件名>   ← 素材字节（按 assetId 分目录：同名素材互不覆盖）
```

- 命名冲突天然解决（assetId 目录）；`project.json` 保持人可读可 diff 的定位。
- 导入校验序：`pack.json` 的 format/version → `project.json` 的既有校验（复用）→
  逐素材 CRC32（store 条目自带）→ 不齐的素材**降级为待重链**（见 §4）。

---

## 3. 代码落点

| 文件 | 改动 |
|---|---|
| `export/zip.ts` | +`unzipStore(bytes)`：读中央目录 → 校验 store 标志与 CRC → 按 name 返回 `Map<string, Uint8Array>`（纯函数，Node 可测） |
| `persist/vedpack.ts`（新） | `collectAssetBytes(doc)`（三层来源逐素材）、`buildVedpack(doc)`（清单+组装，返回 Blob）、`openVedpack(file)`（解包+校验）与 `restoreVedpack(file)`（replaceDoc + 逐素材 `relinkAssetFromFile`，失败素材累计进提示） |
| `ui/TopBar.tsx` | 「工程」下拉 +「导出工程包…（含素材）」/「导入工程包…」两 items；file input accept 加 `.vedpack` |
| `tests/vedpack.test.mjs` | 单测：zip 往返（写→读 CRC/CRC 损坏拒绝）、buildVedpack 清单结构、openVedpack 校验序（坏 format/缺 project.json） |
| `tests/verify-vedpack.mjs` | E2E：导出（含视频+音效工程）→ 下载落盘 → 重开页面拖入导入 → 素材在线、片段完整、播放调度 PCM>0 |

**不改**：`render/**`、`media/**`（relink/draftCache 只调用）、`core/**`（store 的 replaceDoc 走既有）、
`.vedproj` 全链路（原样保留）。

---

## 4. 边界与诚实说明

1. **内存打包的规模上限**：`createZip` 一次性分配（产物 = 素材总大小 + 元数据）。
   导出前**先算总大小**：> 500MB 时弹确认（"约 1.2GB，浏览器可能吃不下，建议拆分或用 .vedproj"）；
   硬上限 4GB（ZIP64 不做，超了可读拒绝）。这是 store 模式 ZIP 的物理边界，如实告知。
2. **素材字节缺失**（内存源丢失 + 缓存未写完 + 句柄无权限）：该素材**不进包**，
   清单标记 `missing: true`；导出完成提示"2 个素材未能打包（已保留元数据，导入后可重链）"。
   导入后这些素材走既有五层恢复/手动重链——**包永远可导出，不会因为个别素材失败而整体拒绝**。
3. **导入的素材一致性**：`relinkAssetFromFile` 的 `scoreCandidate` 会比对时长/指纹——
   包内字节就是导出时的字节，分数必然满分；万一 CRC 失败按坏素材降级待重链。
4. **与 `.vedproj` 的分工**（文件头注释里"为什么不用 ZIP"是 R-054 当时的正确决策，
   现在场景变了——那时没有"整包迁移"需求）：`.vedproj` = 轻、可 diff、素材自备；
   `.vedpack` = 重、自包含、跨设备。两个入口并列，互不替代。

---

## 5. 分步交付

| 步 | 内容 | 验收 |
|---|---|---|
| V1 | `unzipStore` + `vedpack.ts` 打包/解包/恢复 + 单测 | zip 往返/清单/坏包单测绿 |
| V2 | TopBar 两入口 + 大小确认 + E2E 全链路（导出→重开→拖入→恢复→播放） | `verify-vedpack` 全绿 |
| V3 | 全量基线 + docs 收尾 | 全量 E2E 零回归 |

## 6. 待拍板

1. **>500MB 弹确认、4GB 硬上限**（store ZIP 的物理边界，如实告知而非静默失败）——数值是否同意？
2. **缺失素材降级**（包永远可导出，缺失者导入后走既有重链）而非整体拒绝——是否同意？
3. **unzip 只认 store**（自产自销；外部 deflate ZIP 报"不是 veditor 工程包"）——是否同意？
4. `.vedproj 与 .vedpack 并行保留`（入口并列，互不替代）——是否同意？
