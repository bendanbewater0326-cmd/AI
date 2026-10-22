/**
 * veditor 唯一挂载入口。
 *
 * 启动顺序（架构 §11 / §8.4）：
 *   1) secure context 自检 —— `file://` 或非安全上下文下**只渲染阻断页，不挂载编辑器**
 *      （注意：Chromium 下 `file://` 的 `isSecureContext` 仍为 true，真正失败的是模块脚本被
 *      CORS 拦截，所以必须同时判 protocol）；
 *   2) 通过后经 `mountVeditor`（host 边界唯一入口）挂载四区应用，并注册 `<veditor-panel>`。
 */
import { createRoot } from 'react-dom/client';
import type { ReactElement } from 'react';
import './styles/app.css';
import { mountVeditor, registerVeditorPanel } from './host/host';

const SECURE_CONTEXT_MESSAGE = '需要安全上下文：请通过 http://127.0.0.1 或 HTTPS 打开';

/**
 * 阻断页：两种成因、两套文案。
 *
 * - `file://`：API 其实都存在（Chromium 下 `isSecureContext === true`），真正失败的是
 *   ES module 被 CORS 拦住（origin 为 null）→ 用户该做的是"起本地服务器"。
 * - 非安全上下文（如 http 局域网地址）：WebCodecs / 文件句柄确实不存在 → 换 127.0.0.1 或 HTTPS。
 */
function BlockedPage({ isFileProtocol }: { isFileProtocol: boolean }): ReactElement {
  if (isFileProtocol) {
    return (
      <div className="v-block" data-v="file-protocol-block">
        <div className="v-block__title">需要通过本地服务器打开</div>
        <div className="v-block__detail">
          直接双击 HTML 文件时，浏览器会拦截脚本加载（<code>file://</code> 的安全限制），所以编辑器无法启动。
          请运行 <code>npm run dev</code>，然后打开终端显示的 <code>http://127.0.0.1:端口</code>。
          （导出分发时同理：不要用 <code>file://</code> 打开 <code>dist/index.html</code>。）
        </div>
      </div>
    );
  }
  return (
    <div className="v-block" data-v="secure-context-block">
      <div className="v-block__title">{SECURE_CONTEXT_MESSAGE}</div>
      <div className="v-block__detail">
        当前页面不在安全上下文中，WebCodecs 与文件句柄能力不可用。
        请运行 <code>npm run dev</code> 后打开终端显示的 <code>http://127.0.0.1:端口</code>，或部署到 HTTPS。
      </div>
    </div>
  );
}

/** 挂载入口：先自检安全上下文，再决定渲染阻断页还是编辑器。 */
function boot(): void {
  const rootElement = document.getElementById('root');
  if (!rootElement) {
    console.error('veditor: 找不到 #root 挂载点');
    return;
  }

  const isFileProtocol = window.location.protocol === 'file:';
  const secure = window.isSecureContext === true && !isFileProtocol;
  const bootBlock = document.getElementById('boot-block');

  if (!secure) {
    document.documentElement.setAttribute('data-v-state', 'blocked');
    if (bootBlock) bootBlock.hidden = true; // 交给 React 渲染同一份提示，避免双份
    rootElement.hidden = false;
    createRoot(rootElement).render(<BlockedPage isFileProtocol={isFileProtocol} />);
    console.error(
      isFileProtocol
        ? 'veditor: 通过 file:// 打开时浏览器会拦截模块脚本，请用 http://127.0.0.1 访问'
        : `veditor: ${SECURE_CONTEXT_MESSAGE}`,
    );
    return;
  }

  document.documentElement.setAttribute('data-v-state', 'ready');
  if (bootBlock) bootBlock.hidden = true;
  registerVeditorPanel();

  // `?bare=1`：只注册 `<veditor-panel>`、**不挂载主 App**。
  //
  // 为什么需要：编辑器内部是模块级单例（`store` / `ensurePreviewEngine` 的引擎与解码器池
  // 各只有一份），所以同一页面**只能有一个编辑器实例**。宿主页面通过 custom element
  // 集成时不应该同时跑主 App —— 两者会抢同一个引擎，后者的预览画布永远是黑的。
  // 这个开关让宿主 / 测试能以"干净页面"的方式只挂 panel。
  if (new URLSearchParams(window.location.search).get('bare') === '1') {
    document.documentElement.setAttribute('data-v-state', 'bare');
    if (bootBlock) bootBlock.hidden = true;
    if (rootElement) rootElement.hidden = true;
    return;
  }

  mountVeditor(rootElement);
}

boot();
