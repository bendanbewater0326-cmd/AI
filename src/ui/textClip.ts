/**
 * 兼容转发：`buildNewTextOps` 已迁至 `core/textClip.ts`（AI 编译器与 UI 共用同一实现）。
 * 此文件保留转发，既有引用方（TextPanel / TimelineView）不需要改 import。
 */
export { buildNewTextOps, type NewTextPlan } from '../core/textClip';
