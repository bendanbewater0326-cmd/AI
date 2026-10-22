# S1 + S2 交付说明（2026-10-22）

> 范围：**几何常量收敛（S1）+ 轨道头改造（S2）**。S3–S8 未动。
> 依据：`docs/timeline-spec.md`（规范）+ 你确认的六条调整项。

---

## 1. 变更文件清单

### 新增（4 个）

| 文件 | 作用 |
|---|---|
| `src/core/trackLayout.ts` | **几何唯一真相源**：常量 + `trackLayout(doc)` + `trackRowAtY/Of` + `trackHeightOf` |
| `src/core/trackAudibility.ts` | **出画/出声唯一判断**：`isTrackVisible` / `isTrackAudible` / `hasSoloTrack` |
| `src/ui/TrackHeader.tsx` | 轨道头 DOM 组件（图标 / 名称 / 显隐或静音 / 锁定 / ⋮） |
| `tests/track-layout.test.mjs` | 14 条单测（几何 + 可听性） |

### 修改（核心）

| 文件 | 改动 |
|---|---|
| `src/core/types.ts` | `TrackKind` 加 `'text'`；`Track` 加 `solo?` / `height?`；`TrackFlag` 加 `'solo'`；`trackDisplayOrder` 改为**字幕在上 → 视频 → 音频垫底** |
| `src/core/placement.ts` | 删掉本地重复的 `TrackKind`（改从 types 引入，否则加 text 不报错）；`nextTrackFor` 支持 `T` 前缀；落点文案补"字幕只能放到字幕轨" |
| `src/core/store.ts` | `setTrackFlag` 支持 `solo`（`from` 收敛成布尔） |
| `src/render/timelinePainter.ts` | 常量改从 trackLayout 引入；`clipBox`/`drawClip`/`drawDragDraft`/`drawDropGhost` 全部改吃 `TrackRow`；`drawTracks` 按类型分底色、**不再画轨道头文字**（交给 DOM） |
| `src/ui/timelineController.ts` | `hitTest` 用 `trackRowAtY`（原来 `Math.floor((y-24)/56)`） |
| `src/ui/TimelineView.tsx` | 画布高 = `layout.totalHeight`；删掉 4 组按钮与 canvas 双击改名；接 `<TrackHeader>`；底部「＋ 添加轨道」三选一；⋮ 菜单；`readColors` 加分类型底色 |
| `src/media/playbackEngine.ts` | 出画判断改 `isTrackVisible`；**字幕轨也参与合成**（原来只认 `kind==='video'`） |
| `src/media/audioEngine.ts` / `src/export/audioMix.ts` | 出声判断改 `isTrackAudible`（与预览同一份） |
| `src/styles/app.css` | `--v-tl-*` 变量 + 高对比覆盖；`.v-track-head*` 全量样式；主色统一 `#1677ff`；删除旧 `.v-tl-mute/.v-tl-flag/.v-tl-remove/.v-tl-rename` |
| `src/ui/App.tsx` | 测试钩子加 `timelineLayout()` |

### 测试（8 个文件）

| 文件 | 改动 |
|---|---|
| `verify-interaction` | 几何改读 `timelineLayout()`（含 `xOfFrame` 之前漏掉的 `scrollX`） |
| `verify-dragdrop` | 同上；`rowOf` 直接用 `rows` |
| `verify-audio-controls` | 同上；加轨改走三选一菜单；按钮按类型找（`hide-`/`mute-`） |
| `verify-freeze-reverse` / `verify-audio-menu` | 同上 |
| `verify-a-ui` | 视频轨的开关按钮改成**眼睛**（隐藏）；改名改成双击 DOM 名称 |
| `verify-tracks` | 加轨走菜单；删除轨道改走 ⋮ 菜单；"不可删"改为断言菜单项置灰 + 文案 |
| `verify-touch-a11y` | 断言"时间线可视区在视口内"（画布可更高、靠滚动）；触摸起点越过 130px 头 |

---

## 2. 核心 API

### 2.1 `core/trackLayout.ts`（几何唯一入口）

```ts
export const RULER_HEIGHT = 24;
export const TRACK_HEADER_WIDTH = 130;
export const TRACK_MIN_HEIGHT = 24;
export const TRACK_MAX_HEIGHT = 120;
export const TRACK_HEIGHT_BY_KIND = { text: 32, video: 60, audio: 50 };

export interface TrackRow { trackId; kind; name; top; height; index }
export interface TimelineLayout { headerWidth; rulerHeight; rows: TrackRow[]; totalHeight }

trackLayout(doc: Project): TimelineLayout     // 纯函数，O(轨道数)
trackRowAtY(layout, y): TrackRow | null        // 命中测试：左闭右开，越界 null
trackRowOf(layout, trackId): TrackRow | null
trackHeightOf(track): number                   // 用户值优先，夹在 24–120
contentEndFrame(doc): Frame
```

**使用规约**（写进注释了）：任何"第几条轨的 y"都必须查 `trackLayout()`，
**禁止** `index * TRACK_HEIGHT`。`TRACK_HEIGHT` 只剩"没有具体轨道时的估算"这一个用途。

### 2.2 `core/trackAudibility.ts`（三处共用）

```ts
hasSoloTrack(doc): boolean
isTrackVisible(doc, track): boolean   // 隐藏 / 独奏规则（管画面）
isTrackAudible(doc, track): boolean   // 上面那条 + 静音（管声音）
```

**为什么拆两个**：静音只该管声音。合并成一个会让"视频轨静音"把画面也吃掉。
渲染、预览音频、导出混音**三处全部改调它**，以后加 solo/静音类规则只改这里。

### 2.3 `ui/TrackHeader.tsx`

```ts
interface TrackHeaderProps {
  track: Track;
  row: TrackRow;                    // 位置与高度都来自它
  selected: boolean;                // "当前操作轨道" = 选中片段所在轨
  renaming: boolean;
  renameDraft: string;
  onRenameStart / onRenameDraft / onRenameCommit / onRenameCancel;
  onToggleFlag(flag: 'muted'|'hidden'|'locked'|'solo', value: boolean);
  onOpenMenu(point: { clientX: number; clientY: number });
}
```

### 2.4 测试钩子

```ts
window.__VEDITOR_TEST__.timelineLayout()
// → { headerWidth, rulerHeight, rows: [{ trackId, kind, name, top, height, index }], totalHeight }
```
**E2E 里所有坐标必须从这里取**，不许再出现 `56` / `24 + 56 * i`。

---

## 3. 视觉效果自检项（可逐条勾）

打开预览（`127.0.0.1:5173`），逐条看：

### 轨道头
- [ ] 三条默认轨（V2 / V1 / A1）**底色不同**：视频浅灰 `#f5f5f5`、音频浅蓝 `#f0f7ff`
- [ ] 点「＋ 添加轨道」→ 选"字幕轨"→ 顶部出现 **32px 矮轨**，底色最浅 `#fafafa`，图标是 `T`
- [ ] 每行从左到右：**类型图标 → 名称 → 眼睛/喇叭 → 锁 → ⋮**
- [ ] 视频轨是**眼睛**（隐藏），音频轨是**喇叭**（静音）——不是都长一样
- [ ] 点眼睛/喇叭/锁：图标变主色、底色变浅蓝（`aria-pressed` 生效）
- [ ] 双击名称 → 出现输入框；回车提交、Esc 取消
- [ ] 选中一个片段 → 它所在的那条轨头左侧出现 **2px 主色竖条**、底色加深
- [ ] 锁定的轨道：整块变暗（opacity 0.6），图标仍可点（能解锁）
- [ ] 悬停轨道头：图标从 70% 变 100%，按钮变主色
- [ ] 点 ⋮ → 菜单有：重命名轨道 / 独奏（只听这条）/ 静音这条轨（视频轨才有）/ 删除轨道（浅红、置底）
- [ ] 只剩一条视频轨时，⋮ 里的删除项**置灰**且文字带原因「删除轨道（至少要保留一条视频轨）」

### 轨道高度与滚动
- [ ] 视频轨明显比音频轨高，字幕轨最矮（60 / 50 / 32）
- [ ] 轨道多到装不下时，时间线**能纵向滚动**（右侧滚动条），滚到底能看到 A1
- [ ] 滚动后轨道头按钮与轨道**仍然对齐**（一起滚）

### 主题
- [ ] 点顶栏「主题」切到高对比：三种轨道底色变成深色但**仍可区分**，文字变白
- [ ] 切回默认：颜色恢复，布局不跳动
- [ ] 时间线选中框、吸附线、播放头都是同一个蓝 `#1677ff`（不再是紫蓝混用）

### 数据一致（Agent 侧）
- [ ] 用 `timelineLayout()` 拿到的 `rows[i].top/height` 与实际像素一致（可对比截图）

---

## 4. 强制验收对照

| 标准 | 结果 |
|---|---|
| **性能不回退**（100 片段重绘 0.1ms 级） | `verify-t15` ④ 实测 **中位 0.10ms / 最大 0.10ms**（与改造前一致） |
| **接口不破坏**（Agent JSON 向下兼容） | 本轮**没有改** `Clip`/`Asset`/`Project` 的任何既有字段语义；`Track` 只**新增** `solo?`/`height?`（可选），老工程照常读；`TrackKind` 新增 `'text'` 是**扩展**，老工程里没有该类型的轨 |
| **主题不失效**（无写死色值） | 轨道头/轨道底色的颜色全部走 `--v-tl-*`；`[data-theme='contrast']` 只覆盖变量值。`verify-touch-a11y` ⑥ 断言"切主题后背景 255→0 且布局不变" |

**数字**：509 单测 / 31 脚本；E2E 48 个脚本；构建 592.0KB；75 文件 0 处非法换算。

---

## 5. 与规范的三处偏差（都是有意为之）

| 规范 | 实际 | 原因 |
|---|---|---|
| 默认轨道名「视频轨1」「音频轨1」 | 保持 `V1 / V2 / A1 / T1` | 130px 头里图标+四个按钮占 ~87px，名称只剩 ~43px；「视频轨1」会被省略成「视频轨…」，反而更难认。PR 也是 V1/A1 |
| ⋮ 菜单 6 项（含复制轨道/上移/下移） | 先给 **4 项**（重命名/独奏/静音/删除） | 复制轨道、上移下移需要 `duplicateTrack` / `setTrackOrder` 两个新操作，属于 S3。**宁缺不给死按钮** |
| 轨道高度拖拽调节（§2.4） | 数据与渲染已支持（`Track.height` + 夹 24–120），**拖拽手柄留到 S3** | 手柄要改 `hitTest` 增加 `track-resize` 区域，与 S3 的排序一起做更省事 |

---

## 6. 下一步（S3）

1. `setTrackOrder` + `duplicateTrack` 两个操作 → ⋮ 菜单补"复制轨道/上移/下移"
2. 轨道头下边缘 3px 热区 → 拖拽改高度（`mergeKey: 'track-height:<id>'`，一次拖动一个撤销步）
3. 轨道头空白区拖拽排序（横向指示线 + 视频/音频层级不可越界）
4. 片段四态 + 类型视觉（标题条 / 音量线 / 淡入淡出点 / 效果圆点）
