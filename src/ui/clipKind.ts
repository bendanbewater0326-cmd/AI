/**
 * 片段类型判定（属性栏动态分组与右键菜单共用的**唯一**定义点）。
 *
 * 为什么放 UI 层：判定只服务界面分组（属性栏 / 右键菜单），数据层与渲染层
 * 有各自的语义（`role`/`kind`），不依赖这个概念。
 */
import type { Clip, Project } from '../core/types';

export type ClipKind = 'text' | 'audio' | 'video';

export function clipKindOf(doc: Project, clip: Clip): ClipKind {
  if (clip.text !== null && clip.text !== undefined) return 'text';
  const asset = doc.assets.find((item) => item.id === clip.assetId);
  if (clip.role === 'audio' || asset?.kind === 'audio') return 'audio';
  return 'video';
}
