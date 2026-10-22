/**
 * 轨道"是否参与输出"的唯一判断点。
 *
 * ## 为什么必须收敛到一个函数
 *
 * 加"独奏（solo）"之前，三处各写了一遍 `track.muted || track.hidden`：
 * - `media/playbackEngine.collectVisibleClips`（决定出不出画）
 * - `media/audioEngine.audibleClips`（决定出不出声）
 * - `export/audioMix.audibleClipsFor`（决定导出有没有声音）
 *
 * 三份判断一旦不同步，就会出现最难受的一类 bug：**预览正常、导出没有**。
 * solo 的语义又比 muted 复杂（"只要有一条轨独奏，其它轨全部让位"），写三遍等于埋三个雷。
 *
 * ## 为什么拆成 visible / audible 两个
 *
 * "静音"只该管声音，不该把画面也吃掉（视频轨静音后画面必须还在）。
 * 而"隐藏"和"独奏"是**整体让位**，画面和声音一起处理。
 * 所以：
 *   - `isTrackVisible` = 隐藏 / 独奏 的规则（管画面）
 *   - `isTrackAudible` = 上面那条 + 静音（管声音）
 */
import type { Project, Track } from './types';

/** 当前是否有轨道处于独奏（有的话，其它轨整体让位）。 */
export function hasSoloTrack(doc: Project): boolean {
  return doc.tracks.some((track) => track.solo === true);
}

/**
 * 该轨的画面要不要输出。
 *
 * 1. `hidden` → 不输出；
 * 2. 有任意轨 `solo` 时，只有 solo 轨输出（与剪映/PR 一致）；
 * 3. 其余正常输出（**静音不影响画面**）。
 */
export function isTrackVisible(doc: Project, track: Track): boolean {
  if (track.hidden) return false;
  if (hasSoloTrack(doc)) return track.solo === true;
  return true;
}

/** 该轨的声音要不要输出：在"画面输出"的基础上再排除静音。 */
export function isTrackAudible(doc: Project, track: Track): boolean {
  return isTrackVisible(doc, track) && !track.muted;
}
