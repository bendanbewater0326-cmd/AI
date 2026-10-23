/**
 * 唯一时基换算点（架构 §5，权威规格 `docs/frame-clock-spec.md`）。
 *
 * 设计约束（不得违反）：
 *   1. 纯函数、无状态、零依赖（只 `import type`），必须能在 Node 里直接单测；
 *   2. 帧率一律整数毫帧率 `fpsMilli`（30000 / 29970 / 23976 / 25000 / 60000）；
 *   3. 先乘后除，只在返回前取整一次；中间积超出 2^53 时自动切 BigInt（外部无感）；
 *   4. 越界**返回 null**，严禁 clamp 到 `outFrame - 1` 继续 hold（会延长片段）；
 *   5. 导出符号封闭为 7 个函数 + 2 个常量，不新增"顺手"的辅助函数（架构 §5.1）。
 *
 * 关于 `mapProjectFrameToAssetFrame` 为什么必须显式传 `projectMilliFps`：
 *   spec §2 的公式是 `S = i + divFloor((N - s0) * fs, fp)`，分子分母是**两套独立帧率**。
 *   曾经的写法是用片段缓存的 `Lp`（`durationFrames`）反推比例
 *   `S = i + divFloor((N - s0) * (o - i), Lp)` —— 这在 `(o-i)*fp/fs` 能整除时恰好成立，
 *   但 `Lp` 是 half-up 取整后的**缓存值**，一旦不能整除，反推出的 `fs/fp` 就是错的：
 *     fs=60000 fp=30000 o-i=25 → Lp=13，正确节奏是隔帧取 (0,2,4,6…)，反推却得到 (0,1,3,5…)。
 *   这属于"画面节奏整体偏掉且不抛错、不越界"的静默错误，比签名多一个参数危险得多。
 *   因此 fp 必须显式传入（`projectSpanFrames` 之外，全仓库也只有这里需要 fp）。
 *
 * 关于越界抛错（不是 clamp，也不是静默返回）：
 *   `N ∈ [s0, s0+Lp)` 且 `Lp = half-up(span*fp/fs)` 时，映射数学上恒 `< outFrame`。
 *   一旦越界，说明 `clip.durationFrames` 与两套 fps **失配**（缓存过期、手工构造、
 *   undo 恢复顺序错）——这是上游编程错误。抛错能让它在第一次访问就暴露，
 *   而 clamp 只会把"画错一帧"藏起来，让人查三天。**不要把它当多余防御删掉。**
 */
import type { Asset, Clip, Frame, MilliFps, Us } from './types';

/** 项目音频时基固定 48kHz（R-032）。 */
export const PROJECT_SAMPLE_RATE = 48000;

/** 空工程兜底帧率 30fps。 */
export const DEFAULT_FPS_MILLI = 30000;

/** 微秒分子：`f * 1e9 / fpsMilli` = 微秒时间戳（milliFps 为毫帧率）。 */
const US_NUMERATOR = 1_000_000_000;

/** 毫单位基数：毫帧率与帧↔秒、帧↔采样点换算共用（1000 毫/秒）。 */
const MILLI_PER_SECOND = 1000;

/** 断言：必须是整数（帧/毫帧率只能是整数，浮点即编程错误）。 */
function assertInteger(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`timebase: ${label} 必须是整数，收到 ${String(value)}`);
  }
}

/** 断言：毫帧率必须是正整数。 */
function assertMilliFps(milliFps: MilliFps): void {
  assertInteger(milliFps, 'fpsMilli');
  if (milliFps <= 0) {
    throw new Error(`timebase: fpsMilli 必须为正整数，收到 ${milliFps}`);
  }
}

/** BigInt 向下取整除法（`a / b`，b > 0）。 */
function bigFloorDiv(a: bigint, b: bigint): bigint {
  const quotient = a / b;
  const remainder = a % b;
  if (remainder !== 0n && a < 0n) {
    return quotient - 1n;
  }
  return quotient;
}

/**
 * `floor(a / b)`，全整数运算。
 * 中间量超出安全整数范围时切 BigInt，保证长工程（> 2^53 乘积）不漂移。
 */
function divFloor(a: number, b: number): number {
  if (b === 0) throw new Error('timebase: divFloor 除数为 0');
  if (Number.isSafeInteger(a) && Number.isSafeInteger(b)) {
    const quotient = Math.trunc(a / b);
    const remainder = a - quotient * b;
    if (remainder !== 0 && (remainder < 0) !== (b < 0)) {
      return quotient - 1;
    }
    return quotient;
  }
  return Number(bigFloorDiv(BigInt(a), BigInt(b)));
}

/**
 * `(2a + b) // (2b)`，即带 half-up 取整的有理数除法（b > 0）。
 * 负数输入按 floor 语义（向 -∞ 取整），与 spec §2 的 `//` 定义一致。
 */
function divRoundHalfUp(a: number, b: number): number {
  if (b === 0) throw new Error('timebase: divRoundHalfUp 除数为 0');
  const numerator = 2 * a + b;
  const denominator = 2 * b;
  if (Number.isSafeInteger(numerator) && Number.isSafeInteger(denominator)) {
    return divFloor(numerator, denominator);
  }
  return Number(bigFloorDiv(2n * BigInt(a) + BigInt(b), 2n * BigInt(b)));
}

/**
 * 素材跨度 → 项目帧跨度（spec §2 第 1 行，half-up，下限 1）。
 *
 * `Lp = divRoundHalfUp(assetSpanFrames * projectMilliFps, assetMilliFps)`
 *
 * 建片段时算定一次并缓存到 `Clip.durationFrames`；裁剪/改工程帧率时重算。
 */
export function projectSpanFrames(
  assetSpanFrames: Frame,
  assetMilliFps: MilliFps,
  projectMilliFps: MilliFps,
  speedMilli: number = 1000,
): Frame {
  assertInteger(assetSpanFrames, 'assetSpanFrames');
  assertMilliFps(assetMilliFps);
  assertMilliFps(projectMilliFps);
  if (assetSpanFrames < 1) {
    throw new Error(`timebase: 素材跨度必须 ≥ 1 帧，收到 ${assetSpanFrames}`);
  }
  assertSpeedMilli(speedMilli);
  // 变速：以 speed 倍速播放时，素材跨度占用的项目时长反比缩短。
  // speedMilli = 1000 时 `× 1000 / 1000` 相消，完全退化为原式（现有 147 条用例不受影响）。
  const span = divRoundHalfUp(
    assetSpanFrames * projectMilliFps * 1000,
    assetMilliFps * speedMilli,
  );
  return span < 1 ? 1 : span;
}

/** speedMilli 校验：正整数，1000 = 1x。 */
function assertSpeedMilli(speedMilli: number): void {
  if (!Number.isInteger(speedMilli) || speedMilli < 1) {
    throw new Error(`timebase: speedMilli 必须是正整数，收到 ${String(speedMilli)}`);
  }
}

/**
 * 片段的 `speedMilli`（1000 = 1x）。**返回原值，不是速度因子**。
 *
 * `speedMilli` 是后加字段，旧工程（该字段加入前持久化的）里可能缺失，统一按 1000 处理。
 */
function speedMilliOf(clip: Clip): number {
  const speedMilli = (clip as { speedMilli?: number }).speedMilli;
  if (typeof speedMilli !== 'number' || !Number.isInteger(speedMilli) || speedMilli < 1) {
    return 1000;
  }
  return speedMilli;
}

/**
 * 项目帧 → 素材帧（spec §5 的 `mapProjectFrameToAssetFrame`）。
 *
 * `S = clip.inFrame + divFloor((projectFrame - clip.startFrame) * asset.fpsMilli, projectMilliFps)`
 *
 * 返回 `null` 表示该轨此刻无画面：
 *   - `projectFrame < clip.startFrame` → null（不得返回 inFrame 附近帧）
 *   - `projectFrame >= clip.startFrame + clip.durationFrames` → null（不得 clamp 到 outFrame-1）
 *
 * 不变量（§5.4）：
 *   1. 单调不减；2. 恒 `< clip.outFrame`；3. `map(startFrame) === inFrame`；
 *   4. 只做"项目帧 → 素材帧"单向推导。
 *
 * @param projectMilliFps 项目毫帧率（**必须显式传入**，不能由 `clip.durationFrames` 反推）
 * @example
 * // 正确：项目帧率来自 Project.fpsMilli
 * mapProjectFrameToAssetFrame(frame, clip, asset, project.fpsMilli);
 * // 错误（会稳定偏 1 帧，且测试可能全绿）：把素材帧率当成项目帧率
 * mapProjectFrameToAssetFrame(frame, clip, asset, asset.fpsMilli); // ❌ 这是 fs，不是 fp
 */
export function mapProjectFrameToAssetFrame(
  projectFrame: Frame,
  clip: Clip,
  asset: Asset,
  projectMilliFps: MilliFps,
): Frame | null {
  assertInteger(projectFrame, 'projectFrame');
  assertInteger(clip.startFrame, 'clip.startFrame');
  assertInteger(clip.inFrame, 'clip.inFrame');
  assertInteger(clip.outFrame, 'clip.outFrame');
  assertInteger(clip.durationFrames, 'clip.durationFrames');
  assertMilliFps(asset.fpsMilli);
  assertMilliFps(projectMilliFps);

  if (projectFrame < 0) {
    throw new Error(`timebase: projectFrame 不允许为负，收到 ${projectFrame}`);
  }
  if (clip.startFrame < 0) {
    throw new Error(`timebase: clip.startFrame 不允许为负，收到 ${clip.startFrame}`);
  }
  if (clip.outFrame <= clip.inFrame) {
    throw new Error(
      `timebase: 片段素材跨度必须 ≥ 1 帧（inFrame=${clip.inFrame}, outFrame=${clip.outFrame}）`,
    );
  }
  // asset.durationFrames 可以是 null（无 Cues 的 webm / 时长不可知）：
  // 必须显式判空，绝不能让 `clip.outFrame > null`（恒 false）静默跳过校验。
  const assetDuration = asset.durationFrames;
  if (typeof assetDuration === 'number' && clip.outFrame > assetDuration) {
    throw new Error(
      `timebase: 片段 outFrame=${clip.outFrame} 超出素材时长 ${assetDuration} 帧`,
    );
  }
  if (clip.durationFrames < 1) {
    throw new Error(`timebase: clip.durationFrames 必须 ≥ 1，收到 ${clip.durationFrames}`);
  }

  if (projectFrame < clip.startFrame) return null;
  if (projectFrame >= clip.startFrame + clip.durationFrames) return null;

  // spec §2 第 2 行：S = i + divFloor((N - s0) * fs, fp)，fs = 素材毫帧率，fp = 项目毫帧率。
  // 变速：`× speedMilli / 1000`——speedMilli=1000 时相消，退化为原式。
  /**
   * 定格帧：整段都显示 `inFrame` 那一帧。
   *
   * 放在映射里而不是渲染里，是因为**所有**读画面的地方都会问这一个函数
   * （预览、导出、缩略图、音频排期），改一处就全都对，不会出现"预览定格了、导出没定格"。
   */
  if (clip.freeze === true) return clip.inFrame;

  const speedMilli = speedMilliOf(clip);
  const offset = divFloor(
    (projectFrame - clip.startFrame) * asset.fpsMilli * speedMilli,
    projectMilliFps * 1000,
  );
  /**
   * 倒放：把片段内偏移翻到素材区间的另一端。
   *
   * `offset ∈ [0, span-1]`，所以 `outFrame - 1 - offset ∈ [inFrame, outFrame-1]`，
   * 下面那条"越过 outFrame"的不变量依然成立（不需要放宽任何校验）。
   * **不反向解码**：反向解码要逐帧 seek，长片段慢到不可用；这样解码器仍是顺序读。
   */
  const assetFrame = clip.reversed === true ? clip.outFrame - 1 - offset : clip.inFrame + offset;
  // 不变量（由 Lp = half-up(span*fp/fs) 保证）：N ≤ s0 + Lp - 1 ⇒ offset ≤ span - 1。
  // 违反它意味着 clip.durationFrames 与 fps 失配（缓存过期/手工构造），必须立刻暴露，
  // 而不是 clamp 到 outFrame-1 继续 hold。
  if (assetFrame >= clip.outFrame) {
    throw new Error(
      `timebase: 映射越过 outFrame（assetFrame=${assetFrame}, outFrame=${clip.outFrame}）：` +
        `clip.durationFrames=${clip.durationFrames} 与 fpsMilli(asset=${asset.fpsMilli}, project=${projectMilliFps}) 不一致`,
    );
  }
  return assetFrame;
}

/**
 * 素材帧 → 项目帧（spec §2 第 3 行，half-up）。
 *
 * `P = s0 + divRoundHalfUp((S - i) * fp, fs)`
 *
 * **仅建片段与裁剪时使用，运行期禁用**（PRD §8 约定 5：只允许单向推导）。
 */
export function assetFrameToProjectFrame(
  assetFrame: Frame,
  clip: Clip,
  asset: Asset,
  projectMilliFps: MilliFps,
): Frame {
  assertInteger(assetFrame, 'assetFrame');
  assertMilliFps(asset.fpsMilli);
  assertMilliFps(projectMilliFps);
  const assetDuration = asset.durationFrames;
  if (typeof assetDuration === 'number' && clip.outFrame > assetDuration) {
    throw new Error(
      `timebase: 片段 outFrame=${clip.outFrame} 超出素材时长 ${assetDuration} 帧`,
    );
  }
  if (assetFrame < clip.inFrame || assetFrame > clip.outFrame) {
    throw new Error(
      `timebase: assetFrame=${assetFrame} 越界，片段素材区间为 [${clip.inFrame}, ${clip.outFrame}]`,
    );
  }
  // 变速：素材帧 → 项目帧同样反比于速度；speedMilli=1000 时相消。
  const speedMilli = speedMilliOf(clip);
  const offset = divRoundHalfUp(
    (assetFrame - clip.inFrame) * projectMilliFps * 1000,
    asset.fpsMilli * speedMilli,
  );
  return clip.startFrame + offset;
}

/**
 * 项目帧/素材帧 → 整数微秒（WebCodecs 时间戳唯一来源）。
 *
 * `frameToUs(f) = floor(f * 1e9 / fpsMilli)`
 */
export function frameToUs(frame: Frame, milliFps: MilliFps): Us {
  assertInteger(frame, 'frame');
  assertMilliFps(milliFps);
  if (frame < 0) {
    throw new Error(`timebase: frame 不允许为负，收到 ${frame}`);
  }
  if (Number.isSafeInteger(frame * US_NUMERATOR)) {
    return divFloor(frame * US_NUMERATOR, milliFps);
  }
  return Number(bigFloorDiv(BigInt(frame) * 1_000_000_000n, BigInt(milliFps)));
}

/**
 * 整数微秒 → 帧（half-up 补偿 `frameToUs` 的向下取整，否则回环稳定少 1 帧）。
 *
 * `usToFrame(us) = floor((2 * us * fpsMilli + 1e9) / (2 * 1e9))`
 */
export function usToFrame(us: Us, milliFps: MilliFps): Frame {
  assertInteger(us, 'us');
  assertMilliFps(milliFps);
  if (us < 0) {
    throw new Error(`timebase: us 不允许为负，收到 ${us}`);
  }
  const numerator = 2 * us * milliFps + US_NUMERATOR;
  const denominator = 2 * US_NUMERATOR;
  if (Number.isSafeInteger(numerator) && Number.isSafeInteger(denominator)) {
    return divFloor(numerator, denominator);
  }
  return Number(
    bigFloorDiv(2n * BigInt(us) * BigInt(milliFps) + 1_000_000_000n, 2_000_000_000n),
  );
}

/**
 * 毫帧率 → 帧/秒（浮点）。
 *
 * 仅用于**展示/标尺刻度**这类"不写回数据层"的换算（T15 时间线标尺算刻度间距）。
 * 数据层的帧换算请走 `frameToUs` / `secondsToFrames` / `projectSpanFrames`，不要用这个浮点值。
 * 新增理由（2026-10-20，T15）：标尺要算 `px/秒 = px/帧 × 帧/秒`，`fpsMilli / 1000`
 * 是"毫帧率"定义里的固有除法，只能收进本文件，否则会被 `check-timebase.mjs` 拦下。
 */
/**
 * 毫秒 → 项目帧（R-059 字幕：SRT 是"毫秒"定义的格式）。
 *
 * 为什么放进 timebase：字幕导入/导出要在毫秒与帧之间来回换，放在调用方就是又一处
 * 裸换算（时基守卫会拦，而且迟早和别处不一致）。这里只做一次，两个方向都在本文件。
 */
export function msToFrame(ms: number, milliFps: MilliFps): Frame {
  if (!Number.isFinite(ms)) {
    throw new Error(`timebase: ms 必须是有限数值，收到 ${String(ms)}`);
  }
  return usToFrame(Math.round(ms) * 1000, milliFps);
}

/** 项目帧 → 毫秒（与 `msToFrame` 互逆到 ±0.5ms）。 */
export function frameToMs(frame: Frame, milliFps: MilliFps): number {
  return Math.round(usToSeconds(frameToUs(frame, milliFps)) * 1000);
}

/**
 * 秒 → 毫秒（R-059 语音识别：宿主回传的是"秒"，SRT/字幕内部是"毫秒"）。
 *
 * 为什么不放在调用方：`sec * 1000` 就是一处裸换算，时基守卫会拦；
 * 而且"取整策略"（这里四舍五入到整毫秒）必须只有一个定义点。
 */
export function secondsToMs(sec: number): number {
  if (!Number.isFinite(sec)) {
    throw new Error(`timebase: 秒必须是有限数值，收到 ${String(sec)}`);
  }
  return Math.round(sec * MILLI_PER_SECOND);
}

/** 毫秒 → 秒（`secondsToMs` 的逆方向）。 */
export function msToSeconds(ms: number): number {
  if (!Number.isFinite(ms)) {
    throw new Error(`timebase: 毫秒必须是有限数值，收到 ${String(ms)}`);
  }
  return ms / MILLI_PER_SECOND;
}

export function framesPerSecond(milliFps: MilliFps): number {
  assertMilliFps(milliFps);
  return milliFps / MILLI_PER_SECOND;
}

/**
 * 帧 → 采样点（音频调度唯一来源，禁止 `frame / fps * 48000` 浮点路径）。
 *
 * `frameToSample(f, fpsMilli, r) = floor(f * r * 1000 / fpsMilli)`
 */
export function frameToSample(
  frame: Frame,
  milliFps: MilliFps,
  rate: number = PROJECT_SAMPLE_RATE,
): number {
  assertInteger(frame, 'frame');
  assertMilliFps(milliFps);
  assertInteger(rate, 'rate');
  if (rate <= 0) {
    throw new Error(`timebase: 采样率必须为正整数，收到 ${rate}`);
  }
  if (frame < 0) {
    throw new Error(`timebase: frame 不允许为负，收到 ${frame}`);
  }
  const numerator = frame * rate * MILLI_PER_SECOND;
  if (Number.isSafeInteger(numerator)) {
    return divFloor(numerator, milliFps);
  }
  return Number(
    bigFloorDiv(BigInt(frame) * BigInt(rate) * 1000n, BigInt(milliFps)),
  );
}

/**
 * 时钟秒数 → 帧（仅供 Transport 从主时钟取值，一次性得到偏移帧数）。
 *
 * 这是全仓库唯一允许浮点秒进入换算的地方，且只用于"读时钟"，不写回数据层。
 * `secondsToFrames(sec, fpsMilli) = floor(sec * fpsMilli / 1000)`
 */
export function secondsToFrames(sec: number, milliFps: MilliFps): Frame {
  if (!Number.isFinite(sec)) {
    throw new Error(`timebase: sec 必须是有限数值，收到 ${String(sec)}`);
  }
  assertMilliFps(milliFps);
  if (sec < 0) {
    return 0;
  }
  return Math.floor((sec * milliFps) / MILLI_PER_SECOND);
}

/**
 * 微秒 → 秒（T09 `ElementEngine` 给 `<video>.currentTime` 赋值时用）。
 *
 * 与 `secondsToFrames` 对称，属于"唯一换算点"的一部分：**只有本文件允许出现
 * 微秒量级的缩放常量**。调用方（尤其 UI / 媒体层）必须走这里，不得自己写 `/ 1e6`。
 *
 * 新增理由（2026-10-20，T09）：兼容模式必须把帧号换算成秒才能驱动 `<video>`，
 * 而此前本模块只有"秒 → 帧"方向，T09 一旦自己写 `/ 1e6` 就会被
 * `scripts/check-timebase.mjs` 拦下。刻意**不**再加 `frameToSeconds`：
 * 调用方用 `usToSeconds(frameToUs(frame, fpsMilli))` 组合即可，避免导出面继续膨胀。
 */
export function usToSeconds(us: Us): number {
  if (!Number.isFinite(us)) {
    throw new Error(`timebase: us 必须是有限数值，收到 ${String(us)}`);
  }
  return us / 1_000_000;
}

/**
 * 采样点 → 微秒（M3 导出给 `AudioData.timestamp` 赋值时用）。
 *
 * 与 `frameToSample` 互为逆方向，是"唯一换算点"的一部分：
 * `AudioEncoder` 要求每个 `AudioData` 带微秒时间戳，而导出侧只持有采样下标，
 * 若调用方自己写 `samples / rate * 1e6` 就会绕过时基守卫（也必然在长音频上漂移）。
 *
 * 新增理由（2026-10-20，M3）：导出链路第一次需要"采样 → 时间"这个方向，
 * 刻意**不**加 `samplesToSeconds`——秒级结果用 `usToSeconds(samplesToUs(...))` 组合。
 */
export function samplesToUs(samples: number, rate: number): Us {
  assertInteger(samples, 'samples');
  assertInteger(rate, 'rate');
  if (rate <= 0) {
    throw new Error(`timebase: 采样率必须为正整数，收到 ${rate}`);
  }
  if (samples < 0) {
    throw new Error(`timebase: samples 不允许为负，收到 ${samples}`);
  }
  return divRoundHalfUp(samples * MILLI_PER_SECOND * 1000, rate);
}

/* ---------------- 毫秒 ↔ 时分秒文本（字幕面板用） ---------------- */

/**
 * 毫秒 → `HH:MM:SS.mmm`。
 *
 * 字幕面板用**毫秒口径**而不是帧：SRT 规范本身就是毫秒，用户对"2.5 秒"的感知
 * 也比"75 帧"直接。（时间线顶栏的 `formatTimecode` 是帧口径 `HH:MM:SS:FF`，两者不要混用。）
 *
 * 放在 timebase 里的原因：`check-timebase` 守卫禁止在其它文件出现
 * "与时间标识符同现的 1000 缩放"——这里的时分秒进位就是那种运算。
 */
export function formatMs(ms: number): string {
  const total = Math.max(0, Math.round(Number.isFinite(ms) ? ms : 0));
  const perHour = MILLI_PER_SECOND * 60 * 60;
  const perMinute = MILLI_PER_SECOND * 60;
  const hours = Math.floor(total / perHour);
  const minutes = Math.floor((total % perHour) / perMinute);
  const seconds = Math.floor((total % perMinute) / MILLI_PER_SECOND);
  const millis = total % MILLI_PER_SECOND;
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}

/**
 * `HH:MM:SS.mmm` / `MM:SS.mmm` / `SS.mmm` → 毫秒。
 *
 * 容错：允许省略毫秒（当 0）、允许 `,` 作小数分隔符（SRT 规范用逗号）。
 * **非法输入返回 `null` 而不是 0**——0 是合法时间，返回 0 会让用户以为"改成功了"。
 */
export function parseMs(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '') return null;
  const parts = trimmed.split(':');
  if (parts.length > 3) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^\d+(\.\d+)?$/.test(part)) return null;
    numbers.push(Number(part));
  }
  const seconds = numbers.pop() as number;
  const minutes = numbers.length > 0 ? (numbers.pop() as number) : 0;
  const hours = numbers.length > 0 ? (numbers.pop() as number) : 0;
  if (minutes >= 60 || hours > 999) return null;
  const total =
    (hours * 60 * 60 + minutes * 60 + seconds) * MILLI_PER_SECOND;
  return Number.isFinite(total) ? Math.round(total) : null;
}
