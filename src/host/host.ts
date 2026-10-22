/**
 * 宿主边界（架构 §11，task:T18）：唯一挂载入口 + 三种接入方式。
 *
 * ## 为什么 `mountVeditor` 必须只有一个
 *
 * 三种接入（`?src=` / `<veditor-panel>` / `postMessage`）共享同一份状态注入与销毁逻辑。
 * 一旦出现两条挂载路径，就会出现"Web Component 里没有 autosave"这类隐性 bug。
 * 因此 `main.tsx` 只调 `mountVeditor`，一切适配器都从这里派生。
 *
 * ## 接入方式与状态（§11.2 / R-050）
 *
 * | 接入 | 状态 |
 * |---|---|
 * | `?src=<url>` | ✅ fetch → File → memory 导入 + 自动上 V1 |
 * | `<veditor-panel>` | ✅ customElements + shadow DOM + disconnectedCallback → destroy |
 * | `postMessage` | ✅ 四条命令：`getProject` / `setProject` / `importAsset` / `export`（见 `commands.ts`） |
 *
 * **postMessage 的响应约定**：每条命令回恰好一条 `{type, id?, ...result}`；
 * 带 `id` 就原样回传，宿主可据此把响应对上请求。导出结果用 `ArrayBuffer` **transfer** 回去，
 * 不复制、不转 base64（大文件转 base64 会让宿主主线程卡住）。
 */
import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import type {
  AIModelPort,
  HostAdapter,
  HostCommand,
  HostEvent,
  HostReply,
  InitialSource,
  Project,
  Result,
  VeditorHandle,
} from '../core/types';
import { createId, fail, makeError, ok } from '../core/types';
import { store } from '../core/store';
import { importAssetFile } from '../media/importAsset';
import { App } from '../ui/App';
import { createHostProvider } from '../ai/provider';
import { setAIProvider } from '../ai/registry';
import { createCloudLLMModel } from '../ai/cloudLLM';
import type { CloudLLMConfig } from '../ai/cloudLLM';
import { HOST_SCHEMA_VERSION, normalizeProjectInput, runHostCommand } from './commands';

/* ---------------- 类型（§11.1） ---------------- */

// 协议类型统一在 `core/types.ts`（单一事实来源），这里只做转出，
// 让 `import type { AIModelPort } from '../host/host'` 的既有调用点不用改。
export type {
  AIModelPort,
  HostAdapter,
  HostCommand,
  HostCommandResult,
  HostEvent,
  HostReply,
  InitialSource,
  VeditorHandle,
} from '../core/types';

/* ---------------- 三种适配器 ---------------- */

/**
 * 按 URL 取一份素材（`?src=` 与「嵌入 + `?src=`」两条路径共用）。
 *
 * 取不到就返回 null 而不是抛：宿主给的地址可能是 404 / 跨域被拦，
 * 编辑器应该照常起来（只是素材栏为空），不能整页白屏。
 */
async function fetchSourceByUrl(url: string, name?: string): Promise<InitialSource | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    const fallback = decodeURIComponent(url.split('/').pop() ?? '') || 'source.mp4';
    return { file: new File([blob], name ?? fallback, { type: blob.type || 'video/mp4' }) };
  } catch {
    return null;
  }
}

class UrlParamAdapter implements HostAdapter {
  readonly kind = 'url-param' as const;
  private source: InitialSource | null = null;

  constructor() {
    const url = new URLSearchParams(window.location.search).get('src');
    if (url) this.source = { url };
  }

  async getInitialSource(): Promise<InitialSource | null> {
    if (this.source === null) return null;
    return fetchSourceByUrl(this.source.url as string, this.source.name);
  }
  onCommand(): () => void { return () => undefined; }
  postEvent(): void {}
  getAIModel(): null { return null; }
  dispose(): void {}
}

/**
 * `postMessage` 通道（R-050）。
 *
 * 协议：宿主 → `{ type, id?, ...参数 }`；编辑器 → `{ type, id?, ok, ...结果 }`，**一请求一响应**。
 * 响应回到 `event.source`（不是写死 `window.parent`）：命令可能来自父窗口以外的 frame。
 * 导出字节用 transfer 送 `ArrayBuffer`——转 base64 会让大文件把宿主主线程卡住。
 */
class PostMessageAdapter implements HostAdapter {
  readonly kind = 'postmessage' as const;
  private listeners = new Set<(cmd: HostCommand, reply: HostReply) => void>();

  /**
   * `initialUrl` = `?src=`。**嵌入场景也必须支持它**：
   * 早期 `pickAdapter()` 一看到 `?src=` 就返回 `UrlParamAdapter`，
   * 结果"iframe + ?src=" 的页面收不到任何命令、也发不出 `ready`（宿主永远等不到响应）。
   * 两种能力是互补的，不是二选一。
   */
  constructor(private readonly initialUrl?: string) {
    window.addEventListener('message', this.handle);
  }

  private handle = (event: MessageEvent): void => {
    const data = event.data as { type?: unknown; id?: unknown } | null;
    if (data === null || typeof data !== 'object' || typeof data.type !== 'string') return;
    const type = data.type;

    const target = (event.source as Window | null) ?? window.parent;
    const reply: HostReply = (result) => {
      const message: Record<string, unknown> = { type, ...result };
      if (typeof data.id === 'string') message['id'] = data.id;
      const transfer = result.ok && result.buffer instanceof ArrayBuffer ? [result.buffer] : [];
      try {
        target.postMessage(message, '*', transfer);
      } catch {
        // 宿主窗口已卸载：不能让一条失败的响应打断后续命令
      }
    };

    if (this.listeners.size === 0) {
      // 命令比挂载更早到达：明确告诉宿主"还没就绪"，别让它一直等
      reply({ ok: false, code: 'E_INTERNAL', message: '编辑器尚未就绪，请等 ready 事件后再发命令' });
      return;
    }
    for (const cb of this.listeners) cb(data as HostCommand, reply);
  };

  async getInitialSource(): Promise<InitialSource | null> {
    if (this.initialUrl === undefined) return null;
    return fetchSourceByUrl(this.initialUrl);
  }
  onCommand(cb: (cmd: HostCommand, reply: HostReply) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
  postEvent(evt: HostEvent): void {
    try {
      window.parent.postMessage(evt, { targetOrigin: '*' });
    } catch {
      // 同上：事件发不出去不是致命错误
    }
  }
  getAIModel(): null { return null; }
  dispose(): void {
    window.removeEventListener('message', this.handle);
    this.listeners.clear();
  }
}

/**
 * `<veditor-panel src="...">` 的适配器。
 *
 * **之前这里是个真 bug**：`connectedCallback` 硬编码 `new NullAdapter()`，
 * 完全忽略 `src` 属性 —— 挂上 panel 后素材栏永远是空的（`cardCount === 0`），
 * 用户以为"加载失败"，其实是从没读过那个属性。T18 只测了 `?src=` 路径，没覆盖这条。
 */
class SrcAttributeAdapter implements HostAdapter {
  readonly kind = 'webcomponent' as const;

  constructor(private readonly url: string) {}

  async getInitialSource(): Promise<InitialSource | null> {
    if (this.url === '') return null;
    try {
      const response = await fetch(this.url);
      if (!response.ok) return null;
      const blob = await response.blob();
      const rawName = this.url.split('/').pop() ?? 'source.mp4';
      const name = decodeURIComponent(rawName.split('?')[0] ?? rawName);
      return { file: new File([blob], name, { type: blob.type || 'video/mp4' }) };
    } catch {
      return null;
    }
  }

  onCommand(): () => void { return () => undefined; }
  postEvent(): void {}
  getAIModel(): null { return null; }
  dispose(): void {}
}

class NullAdapter implements HostAdapter {
  readonly kind = 'null' as const;
  async getInitialSource(): Promise<InitialSource | null> { return null; }
  onCommand(): () => void { return () => undefined; }
  postEvent(): void {}
  getAIModel(): null { return null; }
  dispose(): void {}
}

/* ---------------- Web Component ---------------- */

export class VeditorPanelElement extends HTMLElement {
  private root: ShadowRoot | null = null;
  private handle: VeditorHandle | null = null;
  private adapter: HostAdapter | null = null;

  connectedCallback(): void {
    // **自定义元素默认是 `display: inline`**：`height: 100%` 对 inline 元素无效，
    // 于是整条百分比高度链断裂（mountPoint 100% → .v-app 100% 全部失效），
    // 面板按内容撑开（实测宿主给 600px 时内容高 1234px，播放按钮被挤出可视区）。
    // 这里显式声明为块级并撑满宿主容器——不依赖宿主页面自己写 CSS。
    this.style.display = 'block';
    this.style.width = '100%';
    this.style.height = '100%';
    this.style.position = 'relative';
    this.root = this.attachShadow({ mode: 'open' });
    // **必须把 CSS 注入 shadow DOM**：`main.css` 是通过 document 的 <link> 加载的，
    // 而 shadow DOM 是**样式隔离**的 —— 不注入的话 panel 内的 `.v-app` 等元素
    // 全部走默认样式（block / auto 高度），`.v-app { height: 100% }` 根本不生效，
    // 面板按内容撑开溢出宿主容器（实测 1233px vs 宿主 600px）。
    // 这里克隆 document 里已加载的 stylesheet 到 shadowRoot，路径由原 <link> 保证正确。
    for (const node of Array.from(document.querySelectorAll('link[rel="stylesheet"]'))) {
      this.root.appendChild(node.cloneNode(true));
    }
    const mountPoint = document.createElement('div');
    // 已知限制：shadow DOM 里 `.v-app` 的 `height: 100%` 会失效（计算值按内容撑开
    // 1233px，而不是父容器的 600px），所以 panel 在**矮容器**里会溢出。
    // 绝对定位与 ResizeObserver 方案都试过，未解决（疑点在该百分比链本身）。
    // 全屏使用不受影响；宿主集成需给容器足够高度。
    mountPoint.style.width = '100%';
    mountPoint.style.height = '100%';
    this.root.appendChild(mountPoint);
    // 读 `src` 属性：宿主通过 `<veditor-panel src="...">` 指定初始素材
    const src = this.getAttribute('src') ?? '';
    this.adapter = src === '' ? new NullAdapter() : new SrcAttributeAdapter(src);
    this.handle = mountVeditor(mountPoint, { adapter: this.adapter, autoImport: true });
  }

  disconnectedCallback(): void {
    this.handle?.destroy();
    this.handle = null;
    this.adapter?.dispose();
    this.adapter = null;
    this.root = null;
  }
}

let registered = false;
export function registerVeditorPanel(): void {
  if (registered || typeof customElements === 'undefined') return;
  registered = true;
  customElements.define('veditor-panel', VeditorPanelElement);
}

/* ---------------- 唯一挂载入口 ---------------- */

export interface MountOptions {
  adapter?: HostAdapter;
  /** 启动时自动导入 adapter.getInitialSource() 返回的素材（?src= / 宿主注入）。 */
  autoImport?: boolean;
  /**
   * 宿主注入的模型（R-047：用户界面不出现任何 API Key / 模型配置）。
   *
   * 任意 agent 都能接：把「调用自家模型」包成 `AIModelPort` 即可，
   * AI 层只认 `complete({prompt, context}) → {text}` 这一个方法。
   */
  aiModel?: AIModelPort;
  /**
   * 便捷入口：直接传 WorkBuddy 云 LLM 配置（endpoint + publishableKey），
   * 内部会用 `createCloudLLMModel` 包成 `AIModelPort`。
   * 优先级低于 `aiModel`（两者都传时以 `aiModel` 为准）。
   */
  cloudLLM?: CloudLLMConfig;
}

export function mountVeditor(el: HTMLElement, options: MountOptions = {}): VeditorHandle {
  const adapter = options.adapter ?? pickAdapter();
  if (options.aiModel !== undefined) {
    setAIProvider(createHostProvider(options.aiModel));
  } else if (options.cloudLLM !== undefined) {
    // 云 LLM 便捷入口：包成 AIModelPort 后走 host provider（与宿主注入同一条路）
    setAIProvider(createHostProvider(createCloudLLMModel(options.cloudLLM)));
  } else if (adapter.getAIModel() !== null) {
    setAIProvider(createHostProvider(adapter.getAIModel() as AIModelPort));
  }
  const reactRoot = createRoot(el);
  reactRoot.render(createElement(App));
  adapter.postEvent({ type: 'ready', schemaVersion: HOST_SCHEMA_VERSION });

  let disposed = false;
  let unsubCommand: (() => void) | null = null;
  if (options.autoImport !== false) {
    void (async () => {
      const src = await adapter.getInitialSource();
      if (src?.file) await importAssetFile(src.file);
    })();
  }
  // 宿主命令通道（R-050）：分发与结果回包都在 commands.ts，这里只注入依赖
  unsubCommand = adapter.onCommand((cmd, reply) => {
    void runHostCommand(cmd, {
      reply,
      postEvent: (evt) => adapter.postEvent(evt),
      getDoc: () => store.getDoc(),
      replaceDoc: (next) => store.replaceDoc(next),
      importFile: (file, assetId) => importAssetFile(file, assetId),
    });
  });

  return {
    async loadSource(src: InitialSource): Promise<Result<string>> {
      if (src.file) return importAssetFile(src.file);
      if (src.url) {
        const blob = await (await fetch(src.url)).blob();
        const name = src.name ?? src.url.split('/').pop() ?? 'source.mp4';
        return importAssetFile(new File([blob], name, { type: blob.type || 'video/mp4' }));
      }
      return { ok: false, error: { code: 'E_ASSET_OFFLINE', message: '没有可导入的素材', at: Date.now(), detail: undefined } };
    },
    getProject(): Project {
      return store.getDoc();
    },
    setProject(p: Project): Result<void> {
      // 与 postMessage 的 setProject 走同一条归一化：宿主/调用方给的工程可能缺字段
      const project = normalizeProjectInput(p);
      if (project === null) {
        return fail(makeError('E_INVALID_PROJECT', '工程结构不合法', 'VeditorHandle.setProject'));
      }
      store.replaceDoc(project);
      return ok(undefined);
    },
    destroy(): void {
      if (disposed) return;
      disposed = true;
      unsubCommand?.();
      reactRoot.unmount();
      adapter.dispose();
    },
  };
}

function pickAdapter(): HostAdapter {
  const url = new URLSearchParams(window.location.search).get('src');
  // 嵌入优先：只要在 iframe 里，命令通道就必须可用，`?src=` 只是顺带给初始素材。
  // 反过来写（先判 url）会让"iframe + ?src=" 既没有命令通道、也没有 ready 事件。
  if (window.parent !== window) return new PostMessageAdapter(url ?? undefined);
  if (url) return new UrlParamAdapter();
  return new NullAdapter();
}

void createId;
