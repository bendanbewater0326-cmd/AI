/**
 * 左素材栏（T12 / R-002/003/004/005/014）：
 * 拖放导入（全窗口）、90×51 首帧缩略图、去重、双击上轨、离线重链接、内存模式常驻警告。
 *
 * 关键约定：
 *   1. `dragover` 必须 `preventDefault()`，否则浏览器会用文件替换整个页面（最常见失误）；
 *   2. 去重靠 `hashKey = name|size|lastModified`，**命中时根本不调 probeAsset**（R-003 要求不重探测）；
 *   3. 缩略图必须来自解码后的首帧（`probeAsset` 返回 `ImageBitmap`），失败时宁可没有缩略图，
 *      也不放色块占位（R-002）；
 *   4. 上轨的 `durationFrames` 一律由 `projectSpanFrames()` 算（禁止第二份换算）；
 *   5. 导入**不进撤销栈**（`store.addAsset` 直接写 doc），否则首次 Ctrl+Z 会撤销"导入"。
 *
 * 坏文件（webm / fMP4 / 加密）一律**不留半个条目**：只有 `probeAsset` 成功才 `addAsset`。
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { Asset, Project, Result } from '../core/types';
import { makeError } from '../core/types';
import { buildPlaceAssetOps } from '../core/placement';
import { ContextMenu } from './ContextMenu';
import type { ContextMenuState } from './ContextMenu';
import { store, useDoc } from '../core/store';
import { applyFirstAssetParams } from '../core/operations';
import { THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH } from '../media/mediaProbe';
import { getProxyState, subscribeProxyState } from '../media/previewSource';
import { probeMediaFile, thumbnailToDataUrl } from '../media/importPipeline';
import { relinkAssetFromFile, relinkFromFiles } from '../media/relink';
import { cacheFileName, enqueueCacheWrite } from '../media/draftCache';
import { clearDraggingAsset, setAssetDrag } from './dnd';
import {
  MEMORY_MODE_WARNING,
  getHandle,
  getThumbnail,
  hasFileSystemAccess,
  putDirectoryHandle,
  putHandle,
  putThumbnail,
  requestAssetPermission,
} from '../persist/autosave';
import type { FileHandlePort } from '../persist/autosave';

const selectAssets = (doc: Project): Asset[] => doc.assets;

/** `getAsFileSystemHandle` 不在标准 lib 里，按结构声明。 */
interface FileSystemItemPort {
  kind: string;
  getAsFile(): File | null;
  getAsFileSystemHandle?: () => Promise<FileHandlePort | null>;
}

/** 导入时一条待处理记录。 */
interface ImportEntry {
  file: File;
  handle: FileHandlePort | null;
}


/** 无 File System Access 时的常驻警告条（R-004：常驻，不是 toast）。 */
export function MemoryModeBanner(): ReactElement | null {
  if (hasFileSystemAccess()) return null;
  return (
    <div className="v-memorybar" data-v="memory-banner" role="status">
      {MEMORY_MODE_WARNING}
    </div>
  );
}

/** 左素材栏。 */
export function AssetPanel(): ReactElement {
  const assets = useDoc(selectAssets);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  /** 代理状态是模块级单例（R-052），用订阅 + 计数强制重渲染。 */
  const [proxyTick, setProxyTick] = useState(0);
  /** 重新链接：没有文件句柄时（工程文件迁入）走这个 input 选文件（R-054）。 */
  const relinkInputRef = useRef<HTMLInputElement | null>(null);
  const relinkTargetRef = useRef<string | null>(null);
  /** 批量重链：`webkitdirectory` 回退（拿不到句柄时用）。 */
  const batchInputRef = useRef<HTMLInputElement | null>(null);
  /** 右键菜单（素材）：删除素材 = 素材 + 引用它的片段（一个撤销步）。 */
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepth = useRef(0);
  const importing = useRef(false);

  /* ---------- 缩略图：优先内存缓存，其次从 IDB 读回 ---------- */
  useEffect(() => subscribeProxyState(() => setProxyTick((tick) => tick + 1)), []);

  useEffect(() => {
    let cancelled = false;
    for (const asset of assets) {
      if (thumbs[asset.id] !== undefined) continue;
      if (asset.thumbnailRef === null) continue;
      void (async () => {
        const stored = await getThumbnail(asset.thumbnailRef as string);
        if (cancelled || !stored.ok || !stored.value) return;
        try {
          const bitmap = await createImageBitmap(stored.value);
          const url = thumbnailToDataUrl(bitmap);
          bitmap.close();
          if (!cancelled && url) setThumbs((previous) => ({ ...previous, [asset.id]: url }));
        } catch {
          // 缩略图损坏不影响素材可用性
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [assets, thumbs]);

  /* ---------- 导入 ---------- */
  async function importEntries(entries: readonly ImportEntry[]): Promise<void> {
    if (importing.current) return;
    importing.current = true;
    try {
      for (const entry of entries) {
        const { file, handle } = entry;
        const hashKey = `${file.name}|${file.size}|${file.lastModified}`;
        // 去重：命中已有素材时**不重新探测**（R-003）
        if (store.getDoc().assets.some((asset) => asset.hashKey === hashKey)) continue;

        setBusy(true);
        store.setBusy('正在解析素材…');
        // 探测 → 资产 → 注册预览源 → 缩略图：与"给片段配音频"共用同一份实现
        // `sourcePath`：有句柄时用文件名占位（浏览器拿不到完整路径），
        // 供重链时在"原文件同级目录"里优先匹配
        const result = await probeMediaFile(file, handle, undefined, handle === null ? null : handle.name);
        if (!result.ok) {
          store.pushError(result.error);
          continue;
        }

        const { asset, thumbnailDataUrl, thumbnailBlob } = result.value;
        const assetId = asset.id;
        // R-001：首个素材改写工程参数（不弹窗、不进撤销栈）。必须在 addAsset 之前判空。
        applyFirstAssetParams(store, asset);
        store.addAsset(asset);
        if (handle) void putHandle(assetId, handle);
        if (thumbnailDataUrl) setThumbs((previous) => ({ ...previous, [assetId]: thumbnailDataUrl }));
        if (thumbnailBlob) void putThumbnail(assetId, thumbnailBlob);

        /**
         * ---- 后台写入本地草稿缓存（不阻塞导入）----
         *
         * 用户此刻已经能用原文件剪辑了（探测 + 注册都完成），拷贝在后台排队。
         * 成功后把 `cacheKey` 写回素材 —— 从此刷新**不再依赖源文件是否还在原地**。
         * 失败什么都不做（缓存是锦上添花，不该报错打扰用户）。
         */
        if (typeof asset.contentHash === 'string' && asset.contentHash !== '') {
          enqueueCacheWrite(
            file,
            asset.contentHash,
            asset.name,
            (ok) => {
              if (!ok) return;
              store.updateAsset(assetId, { cacheKey: cacheFileName(asset.contentHash as string, asset.name) });
            },
            handle === null ? null : handle.name,
          );
        }
      }
    } finally {
      importing.current = false;
      setBusy(false);
      store.setBusy(null);
    }
  }

  async function importFromDrop(event: DragEvent): Promise<void> {
    const transfer = event.dataTransfer;
    if (!transfer) return;
    const allItems = Array.from(transfer.items).filter((item) => item.kind === 'file');
    // 只接媒体文件：拖进来一张图片/文本（含"从素材栏拖缩略图"这种情况）时**静默忽略**，
    // 而不是走导入流程再报"暂不支持该格式"——那条报错会让人以为视频本身有问题。
    const isMedia = (file: File): boolean =>
      /^(video|audio)\//.test(file.type) || /\.(mp4|m4v|mov|webm|mp3|m4a|wav|aac)$/i.test(file.name);
    const items = allItems.filter((item) => {
      const file = item.getAsFile();
      return file === null ? true : isMedia(file);
    });
    if (items.length === 0 && allItems.length > 0) return;
    // `getAsFile()` 必须在同一个事件里同步取完；句柄读取可以之后 await
    const files = items.map((item) => item.getAsFile()).filter((file): file is File => file !== null);
    const handles = await Promise.all(
      items.map(async (item) => {
        const port = item as unknown as FileSystemItemPort;
        if (typeof port.getAsFileSystemHandle !== 'function') return null;
        try {
          return await port.getAsFileSystemHandle();
        } catch {
          return null;
        }
      }),
    );
    const entries: ImportEntry[] = files.map((file, index) => ({
      file,
      handle: handles[index] ?? null,
    }));
    // 没有 item（例如部分浏览器的整窗 drop）时退回 files 列表
    if (entries.length === 0) {
      for (const file of Array.from(transfer.files)) entries.push({ file, handle: null });
    }
    await importEntries(entries);
  }

  /* ---------- 全窗口拖放 ---------- */
  useEffect(() => {
    const hasFiles = (event: DragEvent): boolean => {
      const types = event.dataTransfer?.types;
      if (!types) return false;
      return Array.from(types).includes('Files');
    };
    const onDragEnter = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragActive(true);
    };
    const onDragOver = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      // 不 preventDefault 的话浏览器会直接用文件替换页面
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragActive(false);
    };
    const onDrop = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragActive(false);
      void importFromDrop(event);
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
    // importFromDrop 只依赖 ref/store，不需要重建监听
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- 选择器导入 ---------- */
  async function openPicker(): Promise<void> {
    if (hasFileSystemAccess() && typeof window.showOpenFilePicker === 'function') {
      try {
        const handles = await window.showOpenFilePicker({
          multiple: true,
          types: [
            { description: '视频/音频', accept: { 'video/*': ['.mp4', '.mov'], 'audio/*': ['.m4a'] } },
          ],
        });
        /**
         * **导入即请求持久权限**（"刷新后零操作"的前提）。
         *
         * Chrome 的 `showOpenFilePicker` 返回的句柄只在**本次会话**有效；
         * 刷新后 `queryPermission` 会变回 `prompt`，于是每次刷新都要点一次「恢复访问」。
         * 只有在**用户手势内**调 `requestPermission` 并选「始终允许」，权限才会持久化。
         *
         * 只对第一个句柄请求：同一 origin 的同一权限浏览器只弹一次，
         * 循环请求 10 次也只会弹一次，纯属多余。
         */
        const first = handles[0];
        if (first !== undefined && typeof first.requestPermission === 'function') {
          try {
            await first.requestPermission({ mode: 'read' });
          } catch {
            // 用户拒绝也不影响本次导入（本次会话仍可读）
          }
        }
        const entries: ImportEntry[] = [];
        for (const handle of handles) {
          const file = await handle.getFile();
          entries.push({ file, handle });
        }
        await importEntries(entries);
      } catch {
        // 用户取消选择：不是错误
      }
      return;
    }
    fileInputRef.current?.click();
  }

  /* ---------- 上轨 ---------- */
  function addToTimeline(asset: Asset): void {
    // 落轨规则、时长换算、新建轨与片段同批提交都在 `core/placement`：
    // 与右键"配音频"/"在播放头插入音频"共用同一份实现（各自写一份必然不一致）
    const plan = buildPlaceAssetOps(store.getDoc(), asset, store.getPlayheadFrame());
    if ('message' in plan) {
      store.pushError(makeError('E_DECODE_FAILED', plan.message, asset.name));
      return;
    }
    store.dispatch(plan.ops, plan.newTrackName === null ? '添加片段' : `添加片段到新轨 ${plan.newTrackName}`);
    store.setSelectedClipId(plan.clipId);
  }

  /**
   * 删除素材（右键菜单）。
   *
   * **连同引用它的片段一起删**：素材没了片段就解不出画面，留着只会黑屏 + 报错。
   * 一个撤销步（`removeAsset` 自带 `removedClips`），Ctrl+Z 能整批回来。
   */
  function removeAsset(asset: Asset): void {
    const doc = store.getDoc();
    const removedClips = doc.tracks.flatMap((track) =>
      track.clips.filter((clip) => clip.assetId === asset.id),
    );
    store.dispatch(
      [{ op: 'removeAsset', assetId: asset.id, removed: asset, removedClips }],
      removedClips.length === 0 ? '删除素材' : `删除素材（含 ${removedClips.length} 个片段）`,
    );
    store.setSelectedClipId(null);
  }

  /* ---------- 重新链接（P0 手动重链） ---------- */

  /**
   * 真正执行重链：**只换源引用，不碰片段**。
   *
   * 旧实现走的是 `importAssetFile(file, assetId)`，它把素材写成
   * `sourceMode: 'memory'` + `handleRef: null` —— 于是"重链成功 → 刷新 → 又离线"，
   * 用户看到的就是"重链根本没用"。这里改成 `relinkAssetFromFile`：
   * 有句柄就落 fs 模式并写 IDB，下次刷新不必再选。
   */
  async function runRelink(assetId: string, file: File, handle: FileHandlePort | null): Promise<void> {
    store.setBusy('正在重新链接…');
    const result = await relinkAssetFromFile({ assetId, file, handle });
    store.setBusy(null);
    if (!result.ok) {
      store.pushError(result.error);
      return;
    }
    const { warnings, thumbnailDataUrl } = result.value;
    if (thumbnailDataUrl !== null) {
      setThumbs((previous) => ({ ...previous, [assetId]: thumbnailDataUrl }));
    }
    if (warnings.length > 0) {
      // 只提示、不阻断：用户明确选了这个文件，差异让他自己判断
      store.pushError(
        makeError('E_ASSET_OFFLINE', '已重新链接，但文件和原来不完全一样', warnings.join('；')),
      );
    }
  }

  /**
   * 打开"选一个文件"的流程。
   *
   * ## 为什么**第一件事**就是打开选择器
   *
   * 旧实现在这里先 `await requestAssetPermission(...)`，失败后才 `input.click()`。
   * `await` 之后已经**脱离用户手势**，浏览器会拦掉文件选择框（内嵌面板里 100% 被拦），
   * 于是用户点了"重新链接"**什么都不发生** —— 这就是"重新链接功能无效"的直接原因。
   *
   * 现在：支持 `showOpenFilePicker` 就用它（能拿到句柄 → 下次刷新不丢），
   * 不支持/被拦就同步 `input.click()`。**"恢复访问"是另一个动作**，见 `restoreAccess`。
   */
  function pickFileFor(assetId: string): void {
    const picker = (window as unknown as { showOpenFilePicker?: (options: unknown) => Promise<FileHandlePort[]> })
      .showOpenFilePicker;
    if (typeof picker === 'function') {
      void (async () => {
        try {
          const handles = await picker({
            multiple: false,
            types: [
              {
                description: '音视频',
                accept: { 'video/*': ['.mp4', '.m4v', '.mov', '.webm'], 'audio/*': ['.mp3', '.m4a', '.wav', '.aac'] },
              },
            ],
          });
          const handle = handles[0];
          if (handle === undefined || typeof handle.getFile !== 'function') return;
          const file = await handle.getFile();
          await runRelink(assetId, file, handle);
          return;
        } catch (error) {
          const name = (error as { name?: string } | null)?.name;
          // 用户取消：什么都不做（**不要**回退到 input，否则取消一个又弹一个）
          if (name === 'AbortError') return;
          // 其它错误（内嵌面板 / 不支持的类型配置）→ 回退到 input
        }
        relinkTargetRef.current = assetId;
        relinkInputRef.current?.click();
      })();
      return;
    }
    relinkTargetRef.current = assetId;
    relinkInputRef.current?.click();
  }

  /**
   * 「恢复访问」：文件没动、只是权限过期时用（不必重新选文件）。
   *
   * `requestPermission` 必须在用户手势里调 —— 这个方法**只由按钮点击直接调用**
   * （中间只 await 了 IDB 读句柄，几十毫秒，仍在 transient activation 窗口内）。
   */
  async function restoreAccess(assetIds: string[]): Promise<void> {
    let restored = 0;
    for (const assetId of assetIds) {
      const asset = store.getDoc().assets.find((item) => item.id === assetId);
      if (asset === undefined || asset.handleRef === null) continue;
      const stored = await getHandle(asset.handleRef).catch(() => null);
      if (stored === null || !stored.ok || !stored.value) continue;
      const granted = await requestAssetPermission(stored.value);
      if (!granted.ok || !granted.value) continue;
      try {
        if (typeof stored.value.getFile !== 'function') continue;
        const file = await stored.value.getFile();
        await runRelink(assetId, file, stored.value);
        restored += 1;
      } catch {
        // 权限有了但文件被移走：留给"重新链接"
      }
    }
    if (restored === 0) {
      store.pushError(
        makeError('E_PERMISSION_DENIED', '恢复访问没有成功，请用「重新链接」选择文件', ''),
      );
    }
  }

  /**
   * 批量重链：选一个文件夹，自动匹配里面的音视频文件。
   *
   * 优先 `showDirectoryPicker`（每个文件都能拿到句柄 → 重链后刷新不丢），
   * 不支持则回退 `<input webkitdirectory>`（只能拿 File，重链后是内存模式）。
   */
  function pickFolderForBatch(): void {
    const picker = (window as unknown as { showDirectoryPicker?: () => Promise<unknown> }).showDirectoryPicker;
    if (typeof picker === 'function') {
      void (async () => {
        try {
          const directory = (await picker()) as FileHandlePort & {
            values?: () => AsyncIterable<FileHandlePort>;
          };
          /**
           * **记住这个目录**：下次刷新如果又有素材离线，第二层可以静默扫描它
           * （浏览器不允许凭空遍历磁盘，只能扫"用户授权过的目录"）。
           * 写入失败不影响本次批量重链。
           */
          if (directory.name !== undefined) {
            await putDirectoryHandle(directory.name, directory).catch(() => null);
          }
          const entries: Array<{ file: File; path: string; handle: FileHandlePort | null }> = [];
          if (typeof directory.values === 'function') {
            for await (const handle of directory.values()) {
              if (handle.kind !== 'file') continue;
              try {
                if (typeof handle.getFile !== 'function') continue;
                const file = await handle.getFile();
                entries.push({ file, path: handle.name, handle });
              } catch {
                // 单个文件读不了不影响其它
              }
            }
          }
          await runBatch(entries);
          return;
        } catch (error) {
          const name = (error as { name?: string } | null)?.name;
          if (name === 'AbortError') return;
        }
        batchInputRef.current?.click();
      })();
      return;
    }
    batchInputRef.current?.click();
  }

  /** 批量重链的执行与报告。 */
  async function runBatch(
    entries: Array<{ file: File; path: string; handle: FileHandlePort | null }>,
  ): Promise<void> {
    const offline = store.getDoc().assets.filter((asset) => asset.status === 'offline');
    if (offline.length === 0) {
      store.pushError(makeError('E_ASSET_OFFLINE', '没有离线的素材需要重链', ''));
      return;
    }
    store.setBusy('正在匹配素材…');
    /**
     * `relinkFromFiles` 内部用"指纹 + 名字 + 大小"打分，>= 95 才自动链。
     * 句柄按**文件名**回填：批量场景下同一文件夹里重名文件极少，
     * 而 `relinkFromFiles` 只回传 assetId，这里用文件对象反查。
     */
    const byName = new Map(entries.map((entry) => [entry.file.name, entry]));
    const report = await relinkFromFiles(
      offline.map((asset) => asset.id),
      // `handle` 一起传：否则批量重链后素材落 memory 模式，下次刷新又离线
      entries.map((entry) => ({ file: entry.file, path: entry.path, handle: entry.handle })),
    );
    store.setBusy(null);

    // 自动链成功的补写句柄（`relinkFromFiles` 内部没有句柄，这里补，保证刷新不丢）
    for (const assetId of report.linked) {
      const asset = store.getDoc().assets.find((item) => item.id === assetId);
      if (asset === undefined) continue;
      const entry = asset.sourcePath === null || asset.sourcePath === undefined ? undefined : byName.get(asset.sourcePath);
      if (entry !== undefined && entry.handle !== null) await putHandle(assetId, entry.handle);
    }

    const parts: string[] = [`已重新链接 ${report.linked.length} 个`];
    if (report.pending.length > 0) parts.push(`${report.pending.length} 个相似但不确定（请手动重链）`);
    if (report.failed.length > 0) parts.push(`${report.failed.length} 个没找到`);
    store.pushError(
      makeError(
        report.linked.length > 0 ? 'E_ASSET_OFFLINE' : 'E_ASSET_OFFLINE',
        `批量重链：${parts.join('，')}`,
        report.pending.length > 0
          ? report.pending.map((item) => `${item.assetName} ↔ ${item.candidate}（${item.score}分）`).join('；')
          : '',
      ),
    );
  }

  /* ---------- 顶部离线条的事件入口 ---------- */

  useEffect(() => {
    const onRelink = (event: Event): void => {
      const detail = (event as CustomEvent<{ assetId?: string | null }>).detail;
      const target =
        detail?.assetId ??
        store.getDoc().assets.find((asset) => asset.status === 'offline')?.id ??
        null;
      if (target === null) return;
      pickFileFor(target);
    };
    const onBatch = (): void => pickFolderForBatch();
    const onRestore = (): void => {
      const ids = store
        .getDoc()
        .assets.filter((asset) => asset.status === 'offline' && asset.handleRef !== null)
        .map((asset) => asset.id);
      if (ids.length === 0) {
        store.pushError(makeError('E_PERMISSION_DENIED', '这些素材没有保存文件句柄，请用「重新链接」', ''));
        return;
      }
      void restoreAccess(ids);
    };
    window.addEventListener('veditor:relink', onRelink);
    window.addEventListener('veditor:relink-batch', onBatch);
    window.addEventListener('veditor:relink-restore', onRestore);
    return () => {
      window.removeEventListener('veditor:relink', onRelink);
      window.removeEventListener('veditor:relink-batch', onBatch);
      window.removeEventListener('veditor:relink-restore', onRestore);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <aside className="v-rail v-rail--left" data-v="asset-panel" aria-label="素材栏">
      <input
        ref={relinkInputRef}
        type="file"
        accept="video/mp4,video/quicktime,audio/mp4,video/*,audio/*"
        hidden
        data-v="asset-relink-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          const target = relinkTargetRef.current;
          event.target.value = '';
          relinkTargetRef.current = null;
          if (file === undefined || target === null) return;
          // 走 input 时拿不到 FileSystemFileHandle → 落内存模式（刷新后需再选一次）
          void runRelink(target, file, null);
        }}
      />
      <input
        ref={batchInputRef}
        type="file"
        // @ts-expect-error webkitdirectory 不在标准 lib 里（Chromium/WebView2 支持）
        webkitdirectory=""
        directory=""
        multiple
        hidden
        data-v="asset-relink-batch-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length === 0) return;
          void runBatch(
            files.map((file) => ({
              file,
              // `webkitRelativePath` 形如 `素材/片头.mp4`，取末段作为匹配用的路径
              path: (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? file.name,
              handle: null,
            })),
          );
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="video/mp4,video/quicktime,audio/mp4,video/*,audio/*"
        multiple
        hidden
        data-v="asset-file-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length > 0) void importEntries(files.map((file) => ({ file, handle: null })));
        }}
      />

      {assets.length === 0 ? (
        <button
          type="button"
          className="v-assetpanel__empty"
          data-v="asset-empty"
          disabled={busy}
          onClick={() => void openPicker()}
        >
          <span className="v-assetpanel__plus">＋</span>
          <span>{busy ? '解析中…' : '导入媒体'}</span>
        </button>
      ) : (
        <div className="v-assetpanel__list" data-v="asset-list" data-proxy-tick={proxyTick}>
          {assets.map((asset) => {
            const thumb = thumbs[asset.id];
            const proxy = getProxyState(asset.id);
            return (
              <div
                className="v-assetcard"
                key={asset.id}
                data-v="asset-card"
                data-asset-id={asset.id}
                data-status={asset.status}
                title={asset.name}
                onDoubleClick={() => addToTimeline(asset)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  const used = store
                    .getDoc()
                    .tracks.reduce(
                      (count, track) =>
                        count + track.clips.filter((clip) => clip.assetId === asset.id).length,
                      0,
                    );
                  setMenu({
                    x: event.clientX,
                    y: event.clientY,
                    items: [
                      /**
                       * 离线时「重新链接」放第一项：这是用户右键它的**唯一原因**。
                       * 在线的素材不显示（避免菜单里多一条永远用不到的项）。
                       */
                      ...(asset.status === 'offline'
                        ? [
                            { label: '重新链接…', onSelect: () => pickFileFor(asset.id) },
                            { label: '批量重新链接…', onSelect: () => pickFolderForBatch() },
                            { separator: true as const },
                          ]
                        : []),
                      { label: '添加到时间线', onSelect: () => addToTimeline(asset) },
                      {
                        label: used === 0 ? '删除素材' : `删除素材（含 ${used} 个片段）`,
                        danger: true,
                        onSelect: () => removeAsset(asset),
                      },
                    ],
                  });
                }}
                /**
                 * **卡片可以拖**（剪映式：拖到时间轴任意轨道任意位置）。
                 *
                 * 缩略图 `<img>` 仍然是 `draggable={false}`：不然浏览器会把那张 PNG
                 * 塞进 `dataTransfer.files`，被整窗导入监听当成"拖进来一个文件"。
                 * 这里用自定义 MIME（`ui/dnd.ts`）区分"内部拖拽"与"拖入文件"。
                 */
                draggable
                onDragStart={(event) => {
                  setAssetDrag(event.dataTransfer, asset.id);
                }}
                onDragEnd={clearDraggingAsset}
              >
                {thumb ? (
                  <img
                    className="v-assetcard__thumb"
                    src={thumb}
                    alt=""
                    width={THUMBNAIL_WIDTH}
                    height={THUMBNAIL_HEIGHT}
                    /* **必须禁掉原生拖拽**：`<img>` 默认可拖，拖动素材卡时浏览器会把
                       缩略图（PNG）塞进 dataTransfer.files，于是被当成"拖入一个文件"去导入，
                       报出"暂不支持该格式，请转为 mp4"——用户以为视频不支持，其实是那张缩略图。 */
                    draggable={false}
                  />
                ) : (
                  <div className="v-assetcard__thumb v-assetcard__thumb--empty">{asset.kind === 'audio' ? '♪' : '…'}</div>
                )}
                {asset.status === 'offline' ? (
                  <span className="v-assetcard__badge v-assetcard__badge--offline" data-v="asset-offline-badge">
                    离线
                  </span>
                ) : null}
                {asset.status === 'offline' ? (
                  <button
                    type="button"
                    className="v-assetcard__relink"
                    data-v="asset-relink"
                    onClick={(event) => {
                      event.stopPropagation();
                      pickFileFor(asset.id);
                    }}
                  >
                    重新链接
                  </button>
                ) : null}
                {proxy.status === 'pending' ? (
                  <span className="v-assetcard__badge v-assetcard__badge--proxy" data-v="asset-proxy">
                    {`代理 ${Math.round(proxy.ratio * 100)}%`}
                  </span>
                ) : null}
                {proxy.status === 'ready' ? (
                  <span
                    className="v-assetcard__badge v-assetcard__badge--proxy"
                    data-v="asset-proxy"
                    title={`预览使用 ${proxy.width}×${proxy.height} 代理，导出仍用原片`}
                  >
                    代理
                  </span>
                ) : null}
                {asset.sourceMode === 'memory' ? (
                  <span className="v-assetcard__badge" data-v="asset-badge">
                    内存
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {assets.length > 0 ? (
        <button
          type="button"
          className="v-assetpanel__add"
          data-v="asset-add"
          disabled={busy}
          onClick={() => void openPicker()}
        >
          ＋
        </button>
      ) : null}

      {dragActive ? (
        <div className="v-dropzone" data-v="dropzone">
          <div className="v-dropzone__label">松开导入</div>
        </div>
      ) : null}
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </aside>
  );
}

/** 供验收/调试读取：素材总数（避免直接摸 doc）。 */
export function assetCount(doc: Project): number {
  return doc.assets.length;
}

/** 导入结果的类型别名（面板内部使用，导出便于测试断言）。 */
export type ImportResult = Result<Asset>;
