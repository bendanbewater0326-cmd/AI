# 时间轴 S5 第二阶段方案：五项交互打磨（已交付，2026-10-24）

> 摸底日期：2026-10-24。基线：`docs/s5-audit.md`（2026-10-22 的 S5 摸底，P0 四项已交付）。
> **补充拍板**：框选支持 Ctrl 加选/减选组合、单击空白清空选择；框选 Y 范围要罩住**全部文字轨**
> （ensureTextTrackOps 会在占用时新开文字轨，两段文字可能分居 T1/T2）。
> **踩坑**：CDP 修饰键位是 Alt1 / Ctrl2 / **Meta4** / **Shift8**——Shift 传成 4 = 按下的是 Cmd，
> 走进了 Ctrl 加选分支（E2E ⑥ 当场抓出）。
> 本轮五项 = 审计清单的 **B1 框选 / B4 时长气泡 / B5 跨轨指示线 / B6 Shift 波纹裁剪 / D3 边缘自动滚动**，
> 逐项核实**至今仍未实现**（grep 无 marquee/气泡/自动滚动代码；`rippleShift` op 存在但裁剪路径没接）。
> P2 遗留的 C2 整数秒吸附、C3 裁剪吸附线**不在本轮**（避免与片段边缘吸附抢优先级，另立批次）。

---

## 1. 摸底：可复用的现有底数

| 现有件 | 位置 | 对五项的作用 |
|---|---|---|
| `store.getSelection` / `toggleSelection` / `setSelectedClipId(null)` | `core/store.ts` | 框选的选中集操作——**清空后逐个 toggle 即可批量选中，不需要新增 store API**（零 store 改动） |
| `rippleShift` op（含逆操作） | `core/operations.ts:189/458/599` | 波纹裁剪的位移操作现成，`keymap.rippleDeleteSelectedClip` 已有"按被删时长和位移"的算法可参照 |
| `buildTrimOperation` + `deps.commit(ops[], label)` | `ui/timelineController.ts:346/664` | trim 提交是**操作数组**——波纹裁剪 = `trimClip` + `rippleShift` 两条 op 同批提交，天然一个撤销步 |
| `DragDraft`（kind/trackId/startFrame/durationFrames/valid + snapLine） | `core/types.ts` | 气泡与指示线的数据源（拖动中每帧更新，松手清空） |
| `trackLayout(doc).rows`（top/height） | `core/trackLayout.ts` | 指示线/气泡定位的几何来源 |
| `scrollXRef` + `controller.pointerMove`（每次重读 `getScrollX()`） | `TimelineView` | 边缘自动滚动后**重放同一坐标**即可让拖拽跟随新视口，不需要改控制器数学 |

**关键约束与对策**：ghost/吸附线画在 `render/timelinePainter.ts`（**零底层改动禁改**）。
对策：**框选矩形、时长气泡、跨轨指示线一律用 DOM 浮层**（absolute 定位在时间线容器里），
不碰 canvas 绘制；波纹裁剪与自动滚动是纯 `ui/` 逻辑。五项全部不触碰 `render/core`。

---

## 2. 五项实现要点

### E1 框选（B1，相交判定）

- **空白处**按下（`hitTest` 无片段、非轨道头）+ 拖动 → DOM 选框（1px 主色边 + 8% 填充）。
- 松手时：`setSelectedClipId(null)` → 遍历片段，**相交判定**（`clip.start < 框右 && clipEnd > 框左`
  且轨行与框纵向重叠）→ `toggleSelection(clip.id)` 逐个选中（一次遍历 = 最终多选态）。
- 拖动期间不 dispatch（与拖拽事务同一条经验）；`Esc` 取消框选。
- 已选中片段的拖动语义不变：命中片段仍是拖动/裁剪，只有空白才进框选。

### E2 拖拽时长气泡（B4）

- DOM 浮层（跟随指针，超出视口夹住），**移动与裁剪全程显示**：
  - 移动：`起点 00:03.10 · 结束 00:05.20 · 时长 2.10s`
  - 裁剪：`时长 2.10s`（+左缘裁剪显示 `入点` 变化）
- 数据源：`setDraft` 回调里同步更新浮层（不触发 React 重渲染，与拖动零重渲染约定一致）。
- 时间格式复用 `timelinePainter.frameToSecondLabel` 的口径（只调用不修改）。

### E3 跨轨拖拽指示线（B5）

- 拖动中 `draft.trackId ≠ fromTrackId` 且 `valid` 时：**DOM 横线**画在目标轨上缘（宽 = 内容区）。
- 与 ghost 块配合：ghost 表示"落点"，指示线表示"将落到这条轨"（审计 §4.1 要求）。
- 回到原轨/无效时隐藏。

### E4 Shift 波纹裁剪（B6）

- **Shift + 右缘裁剪**：提交时 `commit([trimClip, ...rippleShift], '波纹裁剪')`——
  同轨右缘之后的片段按 `新时长 − 旧时长` 平移（缩短前移、加长后推），一个撤销步。
- Shift + 左缘裁剪 = 普通裁剪（左缘波纹语义有歧义，规范只要求"后续片段前移"，即右缘场景）。
- 位移算法参照 `rippleDeleteSelectedClip`（"每个幸存片段前面的被删时长之和"同款思路：只平移
  `startFrame ≥ 原片段终点` 的片段，被裁片段与后续之间的既有间隔是用户故意留的，不吞掉）。

### E5 拖拽边缘自动滚动（D3）

- `pointerMove` 里：指针距画布左右边缘 < 40px → 每 tick 滚 12px（rAF 节流）；
  滚动后**把同一坐标重放给 `controller.pointerMove`**（控制器每次重读 `getScrollX()`，
  落点自动跟上新视口），拖拽全程持续滚动直到指针离开边缘区。
- `Shift` 框选/裁剪同样生效（框选的选框也跟着视口平移）。

---

## 3. 代码落点

| 文件 | 改动 |
|---|---|
| `ui/TimelineView.tsx` | 框选状态机（pointerDown/Move/Up 空白分支）、气泡与指示线 DOM 浮层、边缘滚动、setDraft 回调扩展 |
| `ui/timelineController.ts` | trim 提交加 `rippleShift`（Shift + 右缘）；`DragDraft` 透传已有字段，不改结构 |
| `styles/app.css` | 选框/气泡/指示线三组样式 |
| `tests/verify-s5-phase2.mjs` | 新 E2E（见 §4） |

**不改**：`render/**`（ghost/吸附线绘制不动）、`core/**`（rippleShift op 已存在）、
`store`（框选用现有选择 API 组合）。

---

## 4. 测试设计（`verify-s5-phase2.mjs`，≥10 断言）

1. 空白拖框选 → 松手后 selection = 框内 2 个片段（相交判定：只压到片段一半也算）
2. 框选清空旧选择：先单选一段，再框选别处 → selection 只剩新框内的
3. Esc 取消框选 → selection 不变
4. 拖动片段 → 气泡出现且文本含 `时长`；松手消失
5. 裁剪右缘 → 气泡实时变化（拖动中读两次值不同）
6. 跨轨拖拽 → 指示线出现在目标轨上缘（DOM 元素 + 位置校验）
7. Shift+右缘裁剪 → 本段变短、同轨后续片段左移恰为减少量（一次撤销步恢复）
8. 不按 Shift 右缘裁剪 → 后续片段不动（回归）
9. 拖到画布右缘 → scrollX 增大（自动滚动）
10. 既有回归：`verify-s5-p0`（裁剪吸附/Ctrl 加选/多选删除）、`verify-interaction`

---

## 5. 分步交付

| 步 | 内容 | 验收 |
|---|---|---|
| E1+e2 | 框选 + 时长气泡 | 截图（框选过程/气泡） |
| E3+E5 | 指示线 + 边缘自动滚动 | 截图（跨轨指示线） |
| E4 | Shift 波纹裁剪 | `verify-s5-p0` 回归 |
| 收尾 | `verify-s5-phase2.mjs` + 全量基线 + docs | 全量 E2E 零回归 |

---

## 6. 待拍板

1. 框选**只在空白处触发**（命中片段仍是拖动/裁剪）——是否同意？
2. 气泡显示**起点/终点/时长**三段信息（移动时），裁剪只显示时长——是否同意？
3. Shift 波纹裁剪**只对右缘生效**（左缘按普通裁剪）——是否同意？
4. 自动滚动**只做横向**（垂直方向 D1 的根因是时间线可视区高度，S1.4 已把它做成 15%–70% 可拖，用户可自行拉高）——是否同意？
