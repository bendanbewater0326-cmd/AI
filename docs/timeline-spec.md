# 时间轴模块落地规范（2026-10-22）

> 严格按你的规范写。但有三处**必须先对齐**，否则代码写出来会和现有引擎打架：
> ① 我们的时间轴是 **canvas 绘制**，不是 DOM 元素；② 内部时间单位是**帧**，不是秒；
> ③ 轨道头 56→130px、轨道高度 60/50/32 会动到几何常量与 6 个 E2E。
>
> 每条都给了**不改会怎样**和**改的代价**，你可以直接拍板。

---

## 0. 三个前提（必须先定，否则后面全是返工）

### 0.1 canvas 还是 DOM？→ 建议**混合**（这条决定后面 80% 的代码形态）

你的规范通篇按 DOM 写（HTML 结构 + CSS 状态 + `addEventListener`）。现有实现是：
**轨道头是 DOM，轨道内容与片段是 canvas**（`render/timelinePainter.ts`）。

**为什么当初用 canvas**（有实测数据，不是偏好）：
- 100 个片段的整条时间线重绘 **0.10ms 中位 / 0.20ms 最大**（`verify-t15` ④ 一直在跑这条断言）；
- 缩略图铺满片段、波形、吸附线、虚影都是逐帧重绘，DOM 方案要 1000+ 节点 + 每次拖动改 `style`，
  在中低端机上会明显掉帧；
- 拖拽期间"只画 ghost、不改真实元素"这条铁律，在 canvas 上是天然的，在 DOM 上要靠 `will-change` 硬扛。

**建议的混合边界**（改完之后你的规范 100% 能落地）：

| 层 | 用什么 | 负责 |
|---|---|---|
| 轨道头（图标/名称/按钮/⋮） | **DOM**（已有，React） | 命中区域大、要 tooltip、要无障碍 |
| 标尺 / 轨道底 / 片段块 / 缩略图 / 波形 / 把手 / 转场 / 效果点 / 虚影 / 吸附线 | **canvas** | 高频重绘 |
| 浮层（时长气泡、效果名 tooltip、文本编辑浮窗、右键菜单） | **DOM** | 需要文本排版与交互 |

也就是说：**你规范里的"CSS 样式"只作用在轨道头与浮层上**，片段的视觉（圆角、描边、蒙层、
标题条、彩色圆点）由 canvas 用同一套色值绘制。这不影响任何视觉规格，只影响"写在哪"。

> 如果你坚持整条时间轴都用 DOM：可以，但要重写 painter（约 900 行）、改 12 个 E2E、
> 并把"100 片段 < 3ms"这条性能指标降到"< 16ms 不掉帧"。**不建议**，因为收益只有"代码更好读"。

### 0.2 帧还是秒？→ 内部**帧**，接口**秒**

你的数据结构里是 `timeline_start: 2.5`（秒）。我们的内部单位是**帧**（`Frame`），
并且有一条硬约束：**所有帧↔时间换算只能走 `core/timebase.ts`**，由 `scripts/check-timebase.mjs` 静态扫描（当前 72 文件 0 违规）。

**为什么不能内部用秒**：这个项目踩过一次真实的坑——早期用浮点秒反推帧号，产生 **13.5% 的系统性相位错**
（音画对不上，且越往后越偏）。所以：
- **内部**（`Project`/`Clip`/渲染/导出）一律整数帧；
- **对外**（Agent JSON / EDL）用秒，在**边界**用 `secondsToFrames` / `framesToSeconds` 单向换算。

这样你的 JSON 可以原样给 Agent 用，而内部不会因为浮点累积漂移。

### 0.3 130px 头宽 + 60/50/32 轨高：**要做，但要先做几何改造**

现状是"所有轨道等高 56px、头宽 56px"，常量散落在 4 处：`timelinePainter`、`timelineController`、
`TimelineView`、以及 **6 个 E2E 里硬编码的 `56`**（`geo.left + (56 + frame*zoom - scrollX) * scale`）。

**改造顺序（顺序反了必崩）**：
1. 新增 `core/trackLayout.ts` 作为**唯一几何真相源**（见 §2）；
2. 测试钩子暴露 `timelineLayout()`，把 6 个 E2E 的硬编码 `56` 换成读钩子；
3. 再改常量（130 / 60·50·32）与 painter 的逐轨 y 偏移。

**代价**：约 1 个开发批次（含改测试）。**收益**：轨道类型一眼可分（你的 §2.3 核心诉求），
且以后加"字幕轨""贴纸轨"不用再动几何。

---

## 1. 数据模型与双向适配器

### 1.1 字段对照（你的 JSON ↔ 我们的 `Project`）

| 你的字段 | 我们的字段 | 换算 / 说明 |
|---|---|---|
| `track_id` | `Track.id` | 直接 |
| `track_type` | `Track.kind` | `video`/`audio`；**`text` 需新增**（见 §1.3） |
| `track_name` | `Track.name` | 直接 |
| `is_hidden` | `Track.hidden` | 直接 |
| `is_locked` | `Track.locked` | 直接 |
| `height` | `Track.height`（新增，可选） | 缺省按类型取 60/50/32 |
| `z_index` | `Track.order` | **语义相反**：我们 `order` 越大越靠上（V2 在 V1 之上）；你的 `z_index` 越大越靠前，映射时 `order = z_index` |
| `clip_id` | `Clip.id` | 直接 |
| `clip_type` | 由 `Track.kind` + `Clip.role` 推导 | 我们没有 `clip_type` 字段（片段类型由所在轨与 `role` 决定） |
| `track_id` | `Clip.trackId` | 直接 |
| `source_url` | `Clip.assetId` → `Asset` | 我们用素材 id，不是 URL（URL 会随重新链接变化） |
| `timeline_start` | `Clip.startFrame` | `secondsToFrames(秒, fpsMilli)` |
| `timeline_end` | `startFrame + durationFrames` | 同上 |
| `source_in` | `Clip.inFrame` | `secondsToFrames` |
| `source_out` | `Clip.outFrame` | `secondsToFrames`（**右开区间**：`outFrame` 不含） |
| `properties.volume` | `Clip.audio.gain` | 线性振幅 0~3.98（+12dB 上限）；见 `core/volume.ts` |
| `properties.opacity` | `Clip.transform.opacity` | 直接 |
| `properties.speed` | `Clip.speedMilli` | **×1000**：`1.0` → `1000` |
| `properties.filters` | `Clip.effects[]` | 我们的 effect 是 `{type, params, keyframes}`，不是字符串数组 |
| `properties.transition_in/out` | `Clip.transitionIn/Out` | `{type, durationFrames}` |
| `is_locked`（片段级） | **没有** | 我们是**轨道级**锁定（片段级锁定会让"为什么这段拖不动"无从解释） |
| `is_muted`（片段级） | `Clip.audio.gain === 0` | 等价；UI 上显示为红色「静音」徽标 |

**三处我们多出来、你的 schema 装不下的字段**（不装会丢数据）：
`role`（分离音频）、`freeze`（定格）、`reversed`（倒放）、`transform.rotation/flipX/flipY`（旋转翻转）、
`clip.text`（字幕内容）、`clip.keyframes`（音量关键帧）。
→ 适配器里放进 `properties.extra`，**不丢**：

```jsonc
"properties": {
  "volume": 0.5, "opacity": 1.0, "speed": 1.0,
  "filters": [], "transition_in": null, "transition_out": null,
  "extra": { "role": "video", "freeze": false, "reversed": false,
             "rotation": 90, "flipX": true, "text": null }
}
```

### 1.2 适配器（`src/agent/timelineJson.ts`，纯函数，可单测）

```ts
import type { Project, Track, Clip } from '../core/types';
import { framesToSeconds, secondsToFrames } from '../core/timebase';

export interface AgentTrack {
  track_id: string;
  track_type: 'video' | 'audio' | 'text';
  track_name: string;
  is_hidden: boolean;
  is_locked: boolean;
  height: number;
  z_index: number;
  clips: AgentClip[];
}

export interface AgentClip {
  clip_id: string;
  clip_type: 'video' | 'audio' | 'text';
  track_id: string;
  source_url: string;          // 导出时写 assetId，导入时按 assetId 反查
  timeline_start: number;      // 秒
  timeline_end: number;        // 秒
  source_in: number;           // 秒
  source_out: number;          // 秒
  properties: {
    volume: number; opacity: number; speed: number;
    filters: Array<{ type: string; params: Record<string, number | string> }>;
    transition_in: { type: string; duration: number } | null;
    transition_out: { type: string; duration: number } | null;
    extra: Record<string, unknown>;
  };
  is_locked: boolean;
  is_muted: boolean;
}

/** Project → Agent JSON（Agent 读工程时用）。 */
export function toAgentTimeline(doc: Project): { fps: number; tracks: AgentTrack[] } { /* … */ }

/** Agent JSON → Project（Agent 写工程时用；只保留"能对上"的字段，其余走 extra）。 */
export function fromAgentTimeline(json: unknown, doc: Project): Project { /* … */ }
```

**关键约定**：`fromAgentTimeline` **不重新造工程**，而是以传入的 `doc` 为底，
把 JSON 里出现的轨道/片段做 upsert —— 这样 Agent 只改一部分也不会把别的东西抹掉。

### 1.3 需要新增的数据字段

```ts
// core/types.ts
export type TrackKind = 'video' | 'audio' | 'text';   // + text（字幕轨）
export interface Track {
  /* … */
  /** 轨道高度（px）。缺省按类型：video 60 / audio 50 / text 32。 */
  height?: number;
  /** 独奏：任一轨 solo 时，只有 solo 轨出声/出画。 */
  solo?: boolean;
}
```

**字幕轨（`kind: 'text'`）的迁移**：老工程里的文字片段在 `video` 轨上，仍然合法——
`collectVisibleClips` 只要不排除 text 片段即可。新增 text 轨只是**多一种容器**，不是换一套模型。

---

## 2. 几何：单一真相源（`core/trackLayout.ts`）

现在 `TRACK_HEIGHT` 被 4 个文件各用一遍，一改高度就全乱。先收敛：

```ts
export const RULER_HEIGHT = 24;
export const TRACK_HEADER_WIDTH = 130;      // 规范 §2.1
export const TRACK_MIN_HEIGHT = 24;
export const TRACK_MAX_HEIGHT = 120;        // 规范 §2.4
export const TRACK_HEIGHT_BY_KIND: Record<TrackKind, number> = {
  video: 60, audio: 50, text: 32,           // 规范 §2.3
};

export interface TrackRow {
  trackId: string;
  kind: TrackKind;
  /** 相对画布顶部的 y（含标尺）。 */
  top: number;
  height: number;
}

export interface TimelineLayout {
  headerWidth: number;
  rulerHeight: number;
  rows: TrackRow[];
  /** 画布总高 = 标尺 + 所有轨道。 */
  totalHeight: number;
}

/** 唯一入口：给定工程，算出每条轨的 y 与高度（按**显示顺序**，音频/字幕沉底）。 */
export function trackLayout(doc: Project): TimelineLayout;

/** y → 轨道行（命中测试用；越界返回 null）。 */
export function trackRowAtY(layout: TimelineLayout, y: number): TrackRow | null;

/** trackId → 行（画 ghost / 定位按钮用）。 */
export function trackRowOf(layout: TimelineLayout, trackId: string): TrackRow | null;
```

**然后改这三处**（都改成查表，不再乘 `TRACK_HEIGHT`）：
- `render/timelinePainter.ts`：`y = RULER_HEIGHT + index * TRACK_HEIGHT` → `row.top`
- `ui/timelineController.ts`：`hitTest` 的 `Math.floor((y - RULER) / TRACK_HEIGHT)` → `trackRowAtY`
- `ui/TimelineView.tsx`：`trackIndexAtY` / 轨道头按钮的 `top` / `dropTargetAt` 全部走 `trackRowAtY`

**测试钩子**（先加这个，再改常量，否则 E2E 全红）：
```ts
// ui/App.tsx 的 __VEDITOR_TEST__
timelineLayout: () => {
  const l = trackLayout(store.getDoc());
  return { headerWidth: l.headerWidth, rulerHeight: l.rulerHeight, rows: l.rows };
},
```
E2E 里所有 `(56 + frame * zoom)` 改成 `(layout.headerWidth + frame * zoom)`，`24 + 56 * index` 改成 `rows[index].top`。

---

## 3. 轨道头（DOM）

### 3.1 HTML 结构层级（React JSX，`ui/TrackHeader.tsx` 新文件）

```jsx
<div className="v-tl-scroll" data-v="timeline-scroll">
  <div className="v-tl-inner" style={{ height: layout.totalHeight }}>
    <canvas data-v="timeline-canvas" />

    {/* 轨道头：每条轨一组，绝对定位到该轨的 y */}
    {layout.rows.map((row) => (
      <div
        key={row.trackId}
        className="v-track-head"
        data-v={`track-head-${row.trackId}`}
        data-kind={row.kind}
        data-selected={selectedTrackId === row.trackId}
        data-locked={track.locked}
        style={{ top: row.top, height: row.height, width: layout.headerWidth }}
        onPointerDown={beginReorder}          // §3.4 拖拽排序
        onContextMenu={openTrackMenu}          // §5.7 轨道头右键
      >
        {/* ① 类型图标 16px */}
        <span className="v-track-head__icon" data-v="track-icon" aria-hidden="true">
          {row.kind === 'video' ? <FilmIcon /> : row.kind === 'audio' ? <NoteIcon /> : <TextIcon />}
        </span>

        {/* ② 名称 12px，双击重命名 */}
        <span
          className="v-track-head__name"
          data-v="track-name"
          title={track.name}
          onDoubleClick={() => setRename({ trackId: row.trackId, draft: track.name })}
        >
          {track.name}
        </span>

        {/* ③ 静音/隐藏 18px（视频=眼睛，音频=喇叭） */}
        <button
          type="button"
          className="v-track-head__btn"
          data-v={`${row.kind === 'audio' ? 'mute' : 'hide'}-${row.trackId}`}
          aria-pressed={row.kind === 'audio' ? track.muted : track.hidden}
          aria-label={`${track.name} ${row.kind === 'audio' ? '静音' : '隐藏'}`}
          title={row.kind === 'audio' ? (track.muted ? '取消静音' : '静音') : (track.hidden ? '显示轨道' : '隐藏轨道')}
          onClick={() => toggleFlag(row.trackId, row.kind === 'audio' ? 'muted' : 'hidden')}
        >
          {row.kind === 'audio' ? (track.muted ? <SpeakerOffIcon /> : <SpeakerIcon />)
                                : (track.hidden ? <EyeOffIcon /> : <EyeIcon />)}
        </button>

        {/* ④ 锁定 18px */}
        <button
          type="button"
          className="v-track-head__btn"
          data-v={`lock-${row.trackId}`}
          aria-pressed={track.locked}
          aria-label={`${track.name} ${track.locked ? '解锁' : '锁定'}`}
          title={track.locked ? '解锁轨道' : '锁定轨道（锁定后不能改上面的片段）'}
          onClick={() => toggleFlag(row.trackId, 'locked')}
        >
          <LockIcon open={!track.locked} />
        </button>

        {/* ⑤ 更多 ⋮ 16px */}
        <button
          type="button"
          className="v-track-head__more"
          data-v={`track-more-${row.trackId}`}
          aria-label={`${track.name} 更多操作`}
          onClick={openTrackMenu}
        >
          <MoreIcon />
        </button>

        {/* ⑥ 下边缘 3px 高度调节热区（规范 §2.4） */}
        <div
          className="v-track-head__resize"
          data-v={`track-resize-${row.trackId}`}
          role="separator"
          aria-label="调整轨道高度"
          onPointerDown={beginResize}
        />
      </div>
    ))}

    {/* 空轨道引导：画在 canvas 上（见 §4.5），DOM 不做 */}

    {/* 时长气泡（拖拽/裁剪时跟随指针） */}
    {dragTip !== null && (
      <div className="v-tl-tip" style={{ left: dragTip.x, top: dragTip.y }}>
        时长 {dragTip.duration} · 起点 {dragTip.start} · 终点 {dragTip.end}
      </div>
    )}
  </div>
</div>
```

### 3.2 状态矩阵（规范 §1.4 要求四态齐全）

| 元素 | 默认 | 悬停 | 选中 / 激活 | 锁定 |
|---|---|---|---|---|
| 轨道头 | 按类型底色 | 底色加深 4% | 左侧 2px 主色条 + 底色加深 | 图标变锁、内容区叠加 30% 灰 |
| 类型图标 | opacity .7 | opacity 1 | opacity 1 | opacity .35 |
| 名称 | `--v-fg` | 下划线（提示可双击） | `--v-fg` 600 字重 | `--v-fg-dim` |
| 静/隐/锁按钮 | `--v-fg-dim` | 主色 | 主色 + `--v-primary-light` 底 | 置灰禁用 |
| 片段 | 无描边 | 亮度 +10% + 把手显现 | 2px 主色描边 + 四角锚点 | 30% 灰蒙层 + `not-allowed` |

### 3.3 ⋮ 菜单（低频操作收纳）

```
重命名
复制轨道
上移 / 下移
独奏（Solo）        ← 新增能力，见下
删除轨道（浅红，放最底）
```

**独奏必须新增一个收敛点**（否则"预览有声、导出没声"）：
```ts
// core/trackAudibility.ts（新）
export function isTrackAudible(doc: Project, track: Track): boolean {
  const soloed = doc.tracks.filter((t) => t.solo === true);
  if (soloed.length > 0) return track.solo === true && !track.muted;
  return !track.muted;
}
```
`playbackEngine.collectVisibleClips`、`audioEngine.audibleClips`、`export/audioMix.audibleClipsFor`
三处**全部改调它**（现在这三处各写一遍 `muted || hidden`）。

### 3.4 拖拽排序（规范 §2.4）

- 只有**轨道头空白区**能起拖（按在按钮上不触发）；拖动时显示一条 2px 横向指示线（DOM，`position: absolute`）。
- 松手 → `renameTrack` 不行，需要新操作：
```ts
{ op: 'reorderTrack'; trackId: string; from: number; to: number }
```
`applyOperation` 里重排 `doc.tracks` 的 `order`（同类型内重排，**不允许把视频轨拖到音频轨下方**——
显示顺序是"视频在上、音频/字幕沉底"，这是 `trackDisplayOrder` 的规则，不能靠拖拽破坏）。

### 3.5 高度调节（规范 §2.4）

- 下边缘 3px 热区，`cursor: ns-resize`；拖动改 `Track.height`，夹在 24–120。
- 用 `mergeKey: 'track-height:<id>'` → 一次拖动 = 一个撤销步。
- 改高度后 `trackLayout` 自然重算，canvas 重绘，按钮 `top` 跟着变（因为都从 layout 取）。

---

## 4. 片段（canvas 绘制）

### 4.1 绘制入口（`render/timelinePainter.ts`）

```ts
function drawClip(ctx, clip, row: TrackRow, state, colors): void {
  const box = clipBox(clip, row, state.doc.zoomLevel, state.scrollX);
  if (box.x + box.width < 0 || box.x > state.viewport.width) return;   // 视口裁剪

  const state4 = clipVisualState(clip, state.ephemeral);   // default|hover|selected|locked
  drawClipBody(ctx, box, row.kind, state4, colors);         // 底色/圆角/描边
  if (row.kind === 'video') drawThumbStrip(ctx, box, clip, state);      // 缩略图平铺
  if (row.kind === 'audio') { drawWaveform(ctx, box, clip, state); drawVolumeLine(ctx, box, clip); }
  if (row.kind === 'text')  drawTextPreview(ctx, box, clip);
  drawClipTitle(ctx, box, clip, state);                     // 顶部 20px 半透明条
  drawEffectDots(ctx, box, clip, colors);                   // 顶部彩色小圆点
  drawFadeHandles(ctx, box, clip, state4);                  // 音频：左右上角淡入/淡出点
  if (state4 === 'selected') drawTrimHandles(ctx, box, colors);
  if (state4 === 'locked')  drawLockVeil(ctx, box);         // 30% 灰蒙层
  if (clip.audio.gain === 0 || clip.role === 'video') drawSilentBadge(ctx, box, clip, colors);
}
```

**色值全部来自 tokens**（不是写死 hex），否则高对比主题（`[data-theme='contrast']`）会失效。

### 4.2 分类型视觉（规范 §3.2）

| 类型 | 主体 | 标题 | 附加 |
|---|---|---|---|
| 视频 | 缩略图按时长均匀平铺（已有：沿块宽重复铺） | 顶部 20px 半透明黑 + 白 12px 左对齐 | 效果圆点 |
| 音频 | 波形占轨高 70%、垂直居中、低饱和主色 | 同上 | 音量线（顶部 1.5px 白线）+ 淡入淡出拖拽点 + 右下角「单声道 · 100%」 |
| 字幕 | 半透明主色块 + 圆角 2px | 无 | 白色文字居中预览；双击进编辑浮窗 |

**缩略图"均匀抽取"**：现在是"沿块宽重复铺同一张 90×51"。规范要求"按时长均匀抽取关键帧"——
需要**多帧缩略图**：`media/clipThumbnails.ts` 按 1 张/秒抽帧存 IDB（key: assetId + 秒），
绘制时按 `frame → 秒` 取最近的一张。**这是新增成本**（每素材多解 N 帧），建议放第二步。

### 4.3 裁剪把手（规范 §3.3）

- 左右各 8px 热区（`HANDLE_WIDTH = 8` 已有，`hitTest` 已返回 `clip-handle-left/right`）。
- 悬停变 `ew-resize`；选中时画半透明白色矩形（现在画的是实色主色块，按规范改）。
- **Shift + 拖把手 = 波纹裁剪**：裁剪后同轨后续片段前移。现有 `trim` 不 ripple，需要：
```ts
// ui/timelineController.ts 的 commit
if (altRipple) {
  const shift = newOutFrame - oldOutFrame;           // 右把手：时长变化量
  ops.push({ op: 'rippleShift', shifts: laterClips.map(...) });
}
```
（`rippleShift` 操作已存在，直接复用。）

### 4.4 转场片段（规范 §3.4）

- 位置：**接缝两侧各占一半**（不是"重叠区"，因为我们没有重叠——片段是首尾相接的）。
  画法：以接缝为中心，宽 = `transition.durationFrames * zoom`，高 = 轨道高 - 8。
- 交互：`hitTest` 新增 `transition-in` / `transition-out` 区域（接缝 ±12px）；
  拖左右边缘 → 改 `durationFrames`（夹在 1..`maxTransitionFrames`）；双击 → 弹类型选择浮窗。
- 添加：从左侧转场面板拖到接缝 → `setClipTransition`（拖拽 MIME 见 `docs/ux-plan.md` §1.1）。

### 4.5 空轨道引导 + 效果圆点

- **空轨道引导**：`drawTracks` 里，若该轨 `clips.length === 0`，在内容区居中画 12px 灰字
  「拖拽素材到此处添加」（canvas 文字，不走 DOM——每条轨一个 div 会拖慢滚动）。
- **效果圆点**：`drawEffectDots` 在标题条下方横排 4px 圆点，颜色映射：
  `filter → 蓝` / `effect → 紫` / `grade → 橙` / `audio(denoise) → 绿`。
  悬停 tooltip 需要 DOM：canvas 上 `pointermove` 命中圆点 → `setHoverEffect({clipId, effectType, x, y})` → 渲染一个绝对定位浮窗（含「关闭」按钮）。

---

## 5. 核心交互（现有基础 + 要补的）

| 规范条目 | 现状 | 要做的事 |
|---|---|---|
| 4.1 水平拖拽 | ✅ `moveClip` | 加**时长气泡**（DOM 浮层） |
| 4.1 跨轨拖拽 | ✅ `resolveMoveTarget` | 加**横向指示线**（现在只有 ghost） |
| 4.1 拖拽虚影 | ✅ `drawDragDraft` | 虚影 + 原位保留轮廓（现在原位片段还在画，够了） |
| 4.2 分割 | ✅ `splitAtPlayhead` | 分割处画 **1px 缝隙**（纯视觉，不改数据） |
| 4.2 删除 / 波纹删除 | ✅ `removeSelectedClip` / `rippleDeleteSelectedClip` | 无 |
| 4.3 框选 | ❌ | 见下 |
| 4.3 Ctrl 加选 | 🟡 `extraSelectedClipIds` 已存在 | 控制器加 `ctrl/meta + pointerdown` 分支 |
| 4.4 磁吸 | ✅ `snapFrame`（阈值 **8px**，规范要 **5px**） | 阈值改 5；候选集加"整数秒" |
| 4.5 缩放 | ✅ Ctrl+滚轮 / 滑块（`clampZoom`） | 加**无播放头时以鼠标为中心** |
| 4.6 三套右键菜单 | 片段✅ / 空白处✅（2 项）/ 轨道头❌ | 补轨道头菜单 + 空白处补"添加三种轨/缩放" |

### 5.1 框选（要新增）

```ts
// ephemeral 增加 marquee
marquee: { x0: number; y0: number; x1: number; y1: number } | null;

// 控制器：空白处 pointerdown（非片段、非标尺）→ 进入框选
// pointermove → 更新 marquee → requestPaint（只画不 dispatch）
// pointerup → 命中测试：与选框相交的片段 → setSelection([...])
```
**命中规则**：片段矩形与选框**相交**即选中（不是包含）——剪映也是相交，包含会让用户"框不到"。
绘制：半透明主色填充 + 1px 描边。

### 5.2 磁吸候选集（规范 §4.4）

```ts
export function collectSnapCandidates(doc: Project, movingClipId: string): Frame[] {
  const set = new Set<number>([0, doc.playheadFrame, ...doc.markers]);
  for (const track of doc.tracks)
    for (const clip of track.clips) {
      if (clip.id === movingClipId) continue;
      set.add(clip.startFrame);
      set.add(clip.startFrame + clip.durationFrames);
    }
  // 整数秒刻度（规范新增）
  const perSecond = Math.round(doc.fpsMilli / 1000);
  for (let f = perSecond; f <= maxFrame; f += perSecond) set.add(f);
  return [...set].sort((a, b) => a - b);
}
```
注意：整数秒候选会让"吸附"变密（每秒一个），阈值必须小（5px）否则会抢戏。**建议阈值仍用 8px，
但整数秒候选只在 `zoom ≤ 6`（概览态）时加入**——精剪时秒刻度反而碍事。

### 5.3 三套右键菜单

| 位置 | 菜单项 |
|---|---|
| 轨道头 | 重命名 / 复制轨道 / 上移 / 下移 / 独奏 / 删除轨道（浅红，最底） |
| 片段 | 现有 11 项（分离音频/导出音频/配音频/定格/倒放/旋转/翻转/删除音频/静音/复制/删除片段）+ AI 三项 |
| 空白处 | 添加视频轨 / 添加音频轨 / 添加字幕轨 / 放大 / 缩小 / 适配到窗口 |

「复制轨道」= 新操作 `{ op: 'duplicateTrack'; trackId; track: Track }`（连片段一起复制，id 重新生成）。

---

## 6. CSS（严格复用变量 + 主题可切）

### 6.1 变量映射：**不要另起一套命名**

你给的 12 个变量是"时间轴专用色"。如果原样塞进 `:root`，会和现有 `--v-*` 形成两套色板
（同一个"主色"有两个变量名），而且**高对比主题**（`[data-theme='contrast']`）没法覆盖写死的 hex。

所以做**一对一映射**（值取你的色板，名字沿用我们的前缀）：

```css
:root {
  /* —— 尺寸（规范 §2.1 / §3.3 / §4.5）—— */
  --v-tl-head-w: 130px;          /* 原 --v-track-head-w: 56px */
  --v-tl-scale-h: 24px;          /* 原 --v-tl-ruler-h */
  --v-tl-handle-w: 8px;
  --v-tl-track-h-video: 60px;
  --v-tl-track-h-audio: 50px;
  --v-tl-track-h-text: 32px;
  --v-tl-radius: 2px;

  /* —— 色板（规范 §2.3）—— */
  --v-tl-track-video-bg: #f5f5f5;
  --v-tl-track-video-bg-active: #e8e8e8;
  --v-tl-track-audio-bg: #f0f7ff;
  --v-tl-track-text-bg: #fafafa;
  --v-tl-track-border: #e8e8e8;
  --v-tl-text: #262626;
  --v-tl-text-dim: #8c8c8c;
  --v-tl-text-white: #ffffff;
}

/* 高对比主题：只覆盖值，不改名字 —— 这是"用 token 而不是 hex"的唯一理由 */
:root[data-theme='contrast'] {
  --v-tl-track-video-bg: #101010;
  --v-tl-track-audio-bg: #0d1620;
  --v-tl-track-text-bg: #141414;
  --v-tl-track-border: #5a5a5a;
  --v-tl-text: #ffffff;
  --v-tl-text-dim: #c8c8c8;
}
```

**主色怎么办**：你的 `--primary-color: #1677ff` 与现有 `--v-accent: #534ab7` 冲突。
建议**统一成一个**（时间线的选中框、按钮高亮、菜单高亮都用它，两种蓝紫混用会显脏）。
改法是一行：`--v-accent: #1677ff;`（同时改 `--v-accent-weak: #e6f4ff`）。
**注意**：`render/timelinePainter.ts` 的 `DEFAULT_TIMELINE_COLORS` 里也有一份 accent，
`readColors()` 会从 CSS 变量读，所以只改 CSS 即可，但要把默认值同步（否则首帧会闪一下紫）。

### 6.2 轨道头样式（完整）

```css
.v-track-head {
  position: absolute;
  left: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  box-sizing: border-box;
  border-right: 1px solid var(--v-tl-track-border);
  border-bottom: 1px solid var(--v-tl-track-border);
  font-size: 12px;
  color: var(--v-tl-text);
  user-select: none;
  cursor: default;
}
.v-track-head[data-kind='video'] { background: var(--v-tl-track-video-bg); }
.v-track-head[data-kind='audio'] { background: var(--v-tl-track-audio-bg); }
.v-track-head[data-kind='text']  { background: var(--v-tl-track-text-bg); }

.v-track-head[data-selected='true'] {
  background: var(--v-tl-track-video-bg-active);
  box-shadow: inset 2px 0 0 var(--v-accent);       /* 左侧 2px 主色条 */
}

.v-track-head__icon { width: 16px; height: 16px; opacity: 0.7; flex: 0 0 auto; }
.v-track-head:hover .v-track-head__icon { opacity: 1; }

.v-track-head__name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;                          /* 过长省略 */
  cursor: text;
}
.v-track-head__name:hover { text-decoration: underline dotted; }

.v-track-head__btn {
  width: 18px; height: 18px; padding: 0;
  display: grid; place-items: center;
  border: 0; background: transparent;
  color: var(--v-tl-text-dim);
  cursor: pointer;
}
.v-track-head__btn:hover { color: var(--v-accent); }
.v-track-head__btn[aria-pressed='true'] {
  color: var(--v-accent);
  background: var(--v-primary-light, var(--v-accent-weak));
  border-radius: var(--v-tl-radius);
}
.v-track-head__btn:disabled { opacity: 0.35; cursor: not-allowed; }

.v-track-head__more { width: 16px; height: 16px; color: var(--v-tl-text-dim); }
.v-track-head__more:hover { color: var(--v-accent); }

.v-track-head__resize {
  position: absolute;
  left: 0; right: 0; bottom: -1.5px;
  height: 3px;                                     /* 规范 §2.4 的 3px 热区 */
  cursor: ns-resize;
}
.v-track-head__resize:hover { background: var(--v-accent); opacity: 0.4; }

/* 拖拽排序指示线 */
.v-tl-reorder-line {
  position: absolute; left: 0; right: 0; height: 2px;
  background: var(--v-accent);
  pointer-events: none;
  z-index: 5;
}

/* 时长气泡 */
.v-tl-tip {
  position: absolute;
  transform: translate(-50%, -130%);
  padding: 2px 6px;
  border-radius: var(--v-tl-radius);
  background: rgba(0, 0, 0, 0.78);
  color: var(--v-tl-text-white);
  font-size: 11px;
  white-space: nowrap;
  pointer-events: none;
  z-index: 6;
}
```

### 6.3 片段在 canvas 上的"样式表"（等价于 CSS，但写成数据）

```ts
// render/clipStyle.ts（新）—— 片段的"CSS"：一处定义，painter 直接取
export interface ClipStyle {
  fill: string; stroke: string; strokeWidth: number;
  radius: number; titleBarAlpha: number; lockedVeilAlpha: number;
}
export function clipStyle(kind: TrackKind, visual: ClipVisualState, colors: TimelineColors): ClipStyle {
  if (visual === 'selected') return { ...base(kind, colors), stroke: colors.selection, strokeWidth: 2 };
  if (visual === 'hover')    return { ...base(kind, colors), stroke: colors.border, strokeWidth: 1 };
  return base(kind, colors);
}
```

---

## 7. 数据驱动渲染（为什么这么设计）

```
store.dispatch(ops)                    ← GUI 与 Agent 的唯一入口
        │
        ├─ doc 变化 → notify() → 订阅者
        │        ├─ TimelineView 标记 pending（不立即画）
        │        └─ rAF 合帧 → paintTimeline(ctx, { doc, ephemeral, viewport, scrollX, thumbnails })
        │
        └─ 拖动期间：只改 ephemeral（drag/dropGhost/marquee），**不碰 doc** → 不产生撤销步、不触发 React 重渲染
                 pointerup → 一次 dispatch（或 beginTransaction+commit）→ 一个撤销步
```

**四条铁律**（已在代码里，别破坏）：
1. **拖动期间不 dispatch**：控制器全程只 `setDraft` + `requestPaint`。
2. **rAF 合帧**：同一帧内多次请求只画一次（`pendingRef`）。
3. **坐标唯一入口**：`frameToX` / `xToFrame` / `laneX`，禁止在组件里自己乘 zoom。
4. **时间唯一入口**：`core/timebase.ts`，`npm run check` 会扫。

**性能预算**：100 片段全量重绘 ≤ 3ms（当前 0.1ms 中位）。加入波形与多帧缩略图后要复测这条
（`verify-t15` ④ 已固化，超标会红）。

---

## 8. 落地顺序（按"风险从低到高"）

| 步 | 内容 | 涉及文件 | 验收 |
|---|---|---|---|
| **S1** | 几何收敛：`trackLayout` + 测试钩子 + 6 个 E2E 去硬编码 | `core/trackLayout.ts`、`ui/App.tsx`、6 个 E2E | 全部 E2E 仍绿（常量还没改） |
| **S2** | 轨道头改造：130px + 类型图标 + 四按钮 + ⋮ 菜单 + 类型底色 | `ui/TrackHeader.tsx`（新）、`app.css` | 三种轨底色可辨；⋮ 菜单 6 项可用 |
| **S3** ✅ | 轨道高度 60/50/32 + 拖拽调节 + 拖拽排序 + 复制/上移下移 | `core/trackOps.ts`（新）、`setTrackHeight`/`reorderTracks` 两个 op | 已完成：`track-ops` 22 单测 + `verify-track-s3` 14 项 E2E。拖边缘 24–120 可调、排序后层级同步、复制一步撤销 |
| **S4** ✅ | 片段四态（本轮）+ 类型视觉（标题条/波形/效果圆点 → S8） | `timelinePainter`、`timelineController`、`store.setHoverClipId` | 已完成四态：`verify-clip-states` 16 项（全读像素）。**顺手修了两处"实现了没接上"**：悬停态是死代码（hoverClipId 从没被写）、锁定没有拦拖动 |
| **S5** | 交互补齐：框选、Ctrl 加选、时长气泡、跨轨指示线、Shift 波纹裁剪 | `timelineController` | 框选相交即选中；Shift 裁后片段前移且一步撤销 |
| **S6** | 转场片段（画在接缝 + 拖边改时长 + 双击换类型） | painter + controller + `maxTransitionFrames` | 转场宽度随时长变；超上限被夹住 |
| **S7** | 三套右键菜单 + 空白处缩放/加轨 | `TimelineView` | 三处菜单齐全；删除项浅红置底 |
| **S8** | 波形（`media/waveform.ts` + IDB 表） | 新增 | 波形与声音对齐；缩放不糊 |

**必须一起改的测试**（不做会红）：
- `verify-t15`（几何 + 性能）：断言 56/24 的地方改读 `timelineLayout()`
- `verify-t16`（拖动/裁剪坐标）：同上
- `verify-interaction` / `verify-dragdrop` / `verify-audio-controls` / `verify-freeze-reverse`：`yOfTrack` 从"index×56"改"rows[index].top"
- `verify-t12`（缩略图/素材名）：片段视觉改动后像素断言可能要调阈值

---

## 9. 与你的规范不一致、但我建议保留的 3 处

| 你的规范 | 我建议 | 理由 |
|---|---|---|
| 片段级 `is_locked` | 只保留**轨道级**锁定 | 片段级锁定后，用户选中它发现"拖不动"却找不到原因；轨道级有明确的锁图标 |
| 吸附阈值 5px | **8px**（整数秒候选只在概览态加入） | 5px 在 1080p 屏上只有 5 个物理像素，手一抖就吸不上；8px 是我们 46 个 E2E 稳定跑下来的值 |
| 磁吸目标含"整数秒刻度" | 仅 `zoom ≤ 6` 时加入 | 精剪时每秒一个吸附点会"抢走"片段边缘的吸附，反而更难对齐 |

---

## 10. 一句话总结

**视觉照你的规范做**（130px 头、60/50/32 高度、类型底色、四态、彩色圆点），
**代码落在我们的架构上**（canvas 画片段、DOM 画轨道头与浮层、帧为内部单位、秒在边界换算），
**顺序上先收敛几何再改常量**（否则 6 个 E2E 会一起红）。

需要我直接开工的话，建议从 **S1+S2** 开始（几何收敛 + 轨道头改造）——
这两步做完你就能看到"三种轨道一眼可分"的效果，而且不会动到片段绘制，风险最低。
