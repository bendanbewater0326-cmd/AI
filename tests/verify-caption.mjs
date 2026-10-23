/**
 * 左栏「字幕」面板 E2E（C2：列表视图）。
 *
 * ## 这个文件在防什么
 *
 * 1. **空状态真的给了入口**：两个按钮在，且「AI 生成字幕」在无通道时**禁用 + 说明**
 *    （不是"点了没反应"）；
 * 2. **导入后列表条数对**：SRT 3 条 → 列表 3 行（不能多不能少）；
 * 3. **按时间升序**：列表顺序 = 时间顺序（不是导入顺序、不是 id 顺序）；
 * 4. **时间码是毫秒口径**：`00:00:00.000` 这种格式（不是帧口径 `:00`）；
 * 5. **角标规则**：SRT 导入**不加角标**、手动文字加「文字」、AI 加「AI」；
 * 6. **点击跳转**：点一条 → 播放头到该条入点 + 该片段被选中；
 * 7. **双击内联编辑**：改文本 → 一个撤销步；文本没变 → 不产生撤销步；
 * 8. **播放联动高亮**：播放到某条时该行 `data-active=true`。
 *
 * 运行：`node tests/verify-caption.mjs`
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5290;
const FIXTURE = 'sample-720p.mp4';
const SRT = path.join(ROOT, 'tests', '.tmp', 'caption-c2.srt');
const SHOTS = path.join(ROOT, 'tests', 'screenshots');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 三条字幕（含一条中文标点、一条英文），覆盖解析容错
fs.mkdirSync(path.dirname(SRT), { recursive: true });
fs.writeFileSync(
  SRT,
  [
    '1',
    '00:00:00,000 --> 00:00:02,000',
    '第一句：大家好',
    '',
    '2',
    '00:00:02,500 --> 00:00:04,500',
    'Second line, with comma',
    '',
    '3',
    '00:00:05,000 --> 00:00:07,500',
    '第三句，结束。',
    '',
  ].join('\n'),
  'utf8',
);

const server = http.createServer((request, response) => {
  const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
  const candidates = [
    path.join(ROOT, 'tests', 'fixtures', 'compat', name),
    path.join(ROOT, 'tests', 'fixtures', 'hardline', name),
  ];
  const found = candidates.find((item) => fs.existsSync(item)) ?? candidates[0];
  if (!fs.existsSync(found)) {
    response.writeHead(404);
    response.end('not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
  fs.createReadStream(found).pipe(response);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const dev = spawn(process.execPath, ['scripts/dev.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve) => {
  dev.stdout.on('data', (chunk) => {
    if (String(chunk).includes(`127.0.0.1:${PORT}`)) resolve();
  });
});

const report = createReport();
const page = await launchPage({
  url: `http://127.0.0.1:${PORT}/?src=${encodeURIComponent(`${origin}/${FIXTURE}`)}`,
  width: 1600,
  height: 950,
});

async function screenshot(name) {
  const shot = await page.session.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(shot.data, 'base64'));
  console.log(`  · 截图：tests/screenshots/${name}`);
}

/** 读列表的可见行（按 DOM 顺序）。 */
const readRows = () =>
  page.session.evaluate(`(() => {
    return JSON.stringify(Array.from(document.querySelectorAll('[data-v="caption-row"]')).map((row) => ({
      clipId: row.getAttribute('data-clip-id'),
      time: row.querySelector('[data-v="caption-time"]')?.textContent?.trim() ?? '',
      text: row.querySelector('[data-v="caption-text"]')?.textContent?.trim() ?? '',
      origin: row.getAttribute('data-origin'),
      badge: row.querySelector('[data-v="caption-badge"]')?.textContent?.trim() ?? '',
      selected: row.getAttribute('data-selected') === 'true',
      active: row.getAttribute('data-active') === 'true',
    })));
  })()`).then(JSON.parse);

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length === 1', 15000);

  // ---- ① 切到字幕 Tab：空状态 ----
  await page.session.evaluate(`document.querySelector('[data-v="left-tab-caption"]').click()`);
  await sleep(400);
  const emptyState = await page.session.evaluate(`JSON.stringify({
    panel: !!document.querySelector('[data-v="caption-panel"]'),
    isEmpty: document.querySelector('[data-v="caption-panel"]')?.getAttribute('data-empty'),
    title: document.querySelector('[data-v="caption-empty"] .v-caption-empty__title')?.textContent ?? '',
    hasImport: !!document.querySelector('[data-v="caption-import"]'),
    hasGenerate: !!document.querySelector('[data-v="caption-generate"]'),
    generateDisabled: document.querySelector('[data-v="caption-generate"]')?.disabled ?? null,
    noAsrNote: !!document.querySelector('[data-v="caption-no-asr"]'),
  })`);
  const empty = JSON.parse(emptyState);
  report.check(
    `① 空状态有引导 + 两个入口（${emptyState}）`,
    empty.panel && empty.isEmpty === 'true' && empty.hasImport && empty.hasGenerate,
  );
  report.check(
    `①b 无语音通道时「AI 生成字幕」禁用并给说明（disabled=${empty.generateDisabled}，note=${empty.noAsrNote}）`,
    empty.generateDisabled === true && empty.noAsrNote === true,
  );
  await screenshot('caption-1-empty.png');

  // ---- ② 导入 SRT ----
  const { root } = await page.session.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await page.session.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: '[data-v="caption-file"]',
  });
  report.check('② 有隐藏的文件输入（导入入口）', nodeId !== 0);
  await page.session.send('DOM.setFileInputFiles', { nodeId, files: [SRT] });
  await sleep(1200);

  const rows = await readRows();
  report.check(`②b 导入后列表 3 条（实际 ${rows.length}）`, rows.length === 3);
  report.check(
    `③ 按时间升序（${rows.map((row) => row.time).join(' | ')}）`,
    rows[0]?.time === '00:00:00.000' &&
      rows[1]?.time === '00:00:02.500' &&
      rows[2]?.time === '00:00:05.000',
  );
  report.check(
    `④ 时间码是毫秒口径（${rows[0]?.time}）`,
    /^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(rows[0]?.time ?? ''),
  );
  report.check(
    `⑤ SRT 导入不加角标（badge="${rows[0]?.badge}"，origin=${rows[0]?.origin}）`,
    rows.every((row) => row.origin === 'caption' && row.badge === ''),
  );
  report.check(
    `②c 文本解析正确（${rows.map((row) => row.text).join(' / ')}）`,
    rows[0]?.text === '第一句：大家好' && rows[2]?.text === '第三句，结束。',
  );
  await screenshot('caption-2-list.png');

  // ---- ⑤b 一屏可见条数（用户要求 8–10 条）----
  // 再导入一份 10 条的 SRT，数"完全落在列表可视区内"的行
  {
    const LONGSRT = path.join(ROOT, 'tests', '.tmp', 'caption-c2-long.srt');
    const blocks = [];
    for (let index = 0; index < 10; index += 1) {
      const start = index * 2;
      const pad = (value) => String(value).padStart(2, '0');
      blocks.push(
        String(index + 1),
        `00:00:${pad(start)},000 --> 00:00:${pad(start + 1)},800`,
        `第 ${index + 1} 条测试字幕`,
        '',
      );
    }
    fs.writeFileSync(LONGSRT, blocks.join('\n'), 'utf8');

    // 退回空状态（先删掉现有字幕）再导入，走同一条入口
    await page.session.evaluate(`window.__VEDITOR_TEST__.undo()`);
    await sleep(600);
    const { root: root2 } = await page.session.send('DOM.getDocument', { depth: -1 });
    const { nodeId: fileNode } = await page.session.send('DOM.querySelector', {
      nodeId: root2.nodeId,
      selector: '[data-v="caption-file"]',
    });
    if (fileNode !== 0) {
      await page.session.send('DOM.setFileInputFiles', { nodeId: fileNode, files: [LONGSRT] });
      await sleep(1200);
    }

    const visible = await page.session.evaluate(`(() => {
      const list = document.querySelector('[data-v="caption-list"]');
      if (list === null) return -1;
      const listRect = list.getBoundingClientRect();
      let count = 0;
      for (const row of list.querySelectorAll('[data-v="caption-row"]')) {
        const rect = row.getBoundingClientRect();
        if (rect.top >= listRect.top - 1 && rect.bottom <= listRect.bottom + 1) count += 1;
      }
      return count;
    })()`);
    report.check(
      `⑤b 一屏可见字幕条数 ≥ 8（实际 ${visible} 条，左栏高度约 280px）`,
      Number(visible) >= 8,
    );
    await screenshot('caption-2-list.png');

    // 恢复成 3 条：**不能靠 undo**——上一次 undo 撤销的是"导入 10 条"，
    // 会退回到空状态（导入前就是 0 条），不是 3 条。重新导入原来那份。
    await page.session.evaluate(`window.__VEDITOR_TEST__.undo()`);
    await sleep(600);
    const { root: root3 } = await page.session.send('DOM.getDocument', { depth: -1 });
    const { nodeId: fileNode3 } = await page.session.send('DOM.querySelector', {
      nodeId: root3.nodeId,
      selector: '[data-v="caption-file"]',
    });
    if (fileNode3 !== 0) {
      await page.session.send('DOM.setFileInputFiles', { nodeId: fileNode3, files: [SRT] });
      await sleep(1200);
    }
  }

  // ---- ⑥ 点击一条 → 跳播放头 + 选中 ----
  await page.session.evaluate(`(() => {
    const rows = document.querySelectorAll('[data-v="caption-row"]');
    rows[1].click();
    return true;
  })()`);
  await sleep(500);
  const afterClick = await page.session.evaluate(`JSON.stringify({
    playhead: window.__VEDITOR_TEST__.playheadFrame(),
    selected: window.__VEDITOR_TEST__.selection?.() ?? null,
    rowSelected: document.querySelectorAll('[data-v="caption-row"]')[1]?.getAttribute('data-selected'),
  })`);
  const clicked = JSON.parse(afterClick);
  report.check(
    `⑥ 点击第 2 条 → 播放头到 75 帧（2.5s@30fps，实际 ${clicked.playhead}）且该行选中（${clicked.rowSelected}）`,
    Math.abs(clicked.playhead - 75) <= 1 && clicked.rowSelected === 'true',
  );

  // ---- ⑦ 双击内联编辑 ----
  await page.session.evaluate(`(() => {
    const rows = document.querySelectorAll('[data-v="caption-row"]');
    rows[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  const editorOpen = await page.session.evaluate(`!!document.querySelector('[data-v="caption-editor"]')`);
  report.check('⑦ 双击进入内联编辑（出现 textarea）', editorOpen === true);
  await screenshot('caption-3-editing.png');

  // 改文本 + Enter
  await page.session.evaluate(`(() => {
    const el = document.querySelector('[data-v="caption-editor"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, '改过的第一句');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  await sleep(600);
  const afterEdit = await readRows();
  report.check(
    `⑦b 文本已改（${afterEdit[0]?.text}）`,
    afterEdit[0]?.text === '改过的第一句',
  );
  // **不要用 `?.()`**：钩子不存在时会静默返回 undefined，断言就变成"恒真/恒假"。
  // 先断言钩子本身存在，再读值。（MEMORY 记过 `lastUndoLabel?.()` 假绿的坑，这里别再踩。）
  const undoHookReady = await page.session.evaluate(
    `typeof window.__VEDITOR_TEST__.lastUndoLabel === 'function'`,
  );
  report.check('⑦c0 撤销栈标签钩子存在（不用 ?.() 掩盖）', undoHookReady === true);
  const undoLabel = await page.session.evaluate(`window.__VEDITOR_TEST__.lastUndoLabel()`);
  report.check(`⑦c 编辑产生一个撤销步（栈顶=${undoLabel}）`, String(undoLabel).includes('编辑字幕'));

  // ---- ⑧ 文本没变不产生撤销步 ----
  const undoBefore = await page.session.evaluate(`window.__VEDITOR_TEST__.lastUndoLabel()`);
  await page.session.evaluate(`(() => {
    const rows = document.querySelectorAll('[data-v="caption-row"]');
    rows[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  await page.session.evaluate(`(() => {
    const el = document.querySelector('[data-v="caption-editor"]');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  const undoAfter = await page.session.evaluate(`window.__VEDITOR_TEST__.lastUndoLabel()`);
  report.check(
    `⑧ 原样回车不产生撤销步（前=${undoBefore}，后=${undoAfter}）`,
    undoBefore === undoAfter,
  );

  // ---- ⑨ 播放联动高亮 ----
  await page.session.evaluate(`(() => {
    const rows = document.querySelectorAll('[data-v="caption-row"]');
    rows[2].click();
    return true;
  })()`);
  await sleep(600);
  const activeRow = await page.session.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('[data-v="caption-row"]'));
    const index = rows.findIndex((row) => row.getAttribute('data-active') === 'true');
    return index;
  })()`);
  report.check(`⑨ 播放头所在字幕高亮（第 ${Number(activeRow) + 1} 行为 active）`, activeRow === 2);

  // ---- ⑪ 工具条三入口（C3）----
  const toolbar = await page.session.evaluate(`JSON.stringify({
    bar: !!document.querySelector('[data-v="caption-toolbar"]'),
    generate: document.querySelector('[data-v="caption-toolbar"] [data-v="caption-generate"]')?.textContent?.trim() ?? '',
    importBtn: document.querySelector('[data-v="caption-toolbar"] [data-v="caption-import"]')?.textContent?.trim() ?? '',
    exportBtn: document.querySelector('[data-v="caption-toolbar"] [data-v="caption-export"]')?.textContent?.trim() ?? '',
    generateDisabled: document.querySelector('[data-v="caption-toolbar"] [data-v="caption-generate"]')?.disabled ?? null,
  })`);
  const bar = JSON.parse(toolbar);
  report.check(
    `⑪ 工具条三入口齐全且全中文（${toolbar}）`,
    bar.bar &&
      bar.generate === 'AI 生成字幕' &&
      bar.importBtn === '导入字幕' &&
      bar.exportBtn === '导出字幕',
  );
  report.check(
    `⑪b 无语音通道时 AI 按钮禁用（disabled=${bar.generateDisabled}）`,
    bar.generateDisabled === true,
  );
  await screenshot('caption-4-toolbar.png');

  // ---- ⑫ 导入后的明确反馈 ----
  // C2 里已经导入过两次，这里再导一次看反馈文案
  {
    const { root: r4 } = await page.session.send('DOM.getDocument', { depth: -1 });
    const { nodeId: f4 } = await page.session.send('DOM.querySelector', {
      nodeId: r4.nodeId,
      selector: '[data-v="caption-file"]',
    });
    await page.session.send('DOM.setFileInputFiles', { nodeId: f4, files: [SRT] });
    await sleep(1200);
    const notice = await page.session.evaluate(
      `document.querySelector('[data-v="caption-notice"]')?.textContent?.trim() ?? ''`,
    );
    report.check(`⑫ 导入后给明确反馈（"${notice}"）`, notice.includes('已导入') && notice.includes('3'));
  }

  // ---- ⑬ 导出真的产出正确文件 ----
  {
    const outDir = path.join(ROOT, 'tests', '.tmp', 'caption-export');
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });

    // **关掉 showSaveFilePicker**：无头环境弹不出系统对话框，会卡住。
    // 关掉后 actions 自动退回 `<a download>` 兜底 —— 这本身也是要验的降级路径。
    await page.session.evaluate(`(() => {
      try { delete window.showSaveFilePicker; } catch { window.showSaveFilePicker = undefined; }
      return typeof window.showSaveFilePicker;
    })()`);
    await page.session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: outDir });
    await page.session.evaluate(`document.querySelector('[data-v="caption-export"]').click()`);

    let files = [];
    for (let index = 0; index < 40; index += 1) {
      await sleep(250);
      files = fs.existsSync(outDir)
        ? fs.readdirSync(outDir).filter((name) => name.endsWith('.srt'))
        : [];
      if (files.length > 0) break;
    }
    report.check(`⑬ 导出产出 .srt 文件（${files.join(', ') || '无'}）`, files.length > 0);
    if (files.length > 0) {
      const content = fs.readFileSync(path.join(outDir, files[0]), 'utf8');
      const blocks = content.trim().split(/\n\s*\n/).length;
      report.check(
        `⑬b 导出内容 3 条且是标准 SRT 格式（${blocks} 块，含 --> 时间轴）`,
        blocks === 3 && content.includes(' --> ') && content.includes('00:00:00,000'),
      );
      // **注意**：⑫ 重新导入过一次，而导入是「整段替换」——它会覆盖 ⑦ 里编辑的文本。
      // 所以这里应该断言"导出的就是当前 doc 的内容"（导入的原文），不是"改过的第一句"。
      // 这条反过来也验证了"替换"语义：导出永远跟着当前字幕轨走。
      report.check(
        `⑬c 导出内容与当前字幕轨一致（含"第一句：大家好"，且不含已被替换掉的旧文本）`,
        content.includes('第一句：大家好') && !content.includes('改过的第一句'),
      );
      const notice = await page.session.evaluate(
        `document.querySelector('[data-v="caption-notice"]')?.textContent?.trim() ?? ''`,
      );
      report.check(`⑬d 导出后给明确反馈（"${notice}"）`, notice.includes('已导出') || notice.includes('已取消'));
    }
  }

  // ---- ⑩ 错误条为空 ----
  const errors = await page.session.evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll('[data-v="errorbar"]'));
    return JSON.stringify(nodes.map((node) => (node.textContent ?? '').trim()).filter((text) => text !== ''));
  })()`);
  report.check(`⑩ 全程无错误条（${errors}）`, errors === '[]');

  /* ===================== C4：字幕迷你时间轴视图（⑭ ~ ㉑） ===================== */
  /*
   * ## 为什么放在 ⑩ 之后
   *
   * ⑩ 断言"全程无错误条"，而 ⑲ 要**故意**制造一条错误条（拖到重叠）。
   * 放在 ⑩ 之前会把 ⑩ 变成假红 —— 错的是测试顺序，不是功能。
   *
   * ## 这一段的断言全部"读数"，不看"元素存在"
   *
   * | 要证明的事 | 读什么 |
   * |---|---|
   * | 条块比例 | `getBoundingClientRect().width / 轨道宽度`（比例，不是绝对像素） |
   * | 时间基准 | 轴末端文案 + **最后一个条块右边缘是否贴住轨道右边缘** |
   * | doc 有没有变 | `clips()` 的 `startFrame` / `durationFrames`（不碰 effectDetails） |
   * | 撤销步数 | `lastUndoLabel()` 前后对比 + **一次 undo 能否回滚到底**（比数标签硬） |
   * | 拖动中是否只是预览 | 松手前的 doc 快照 + 条块 `title`（title 里是预览后的起止毫秒） |
   *
   * ## 测试钩子一律"先断言存在，再读值"
   *
   * `lastUndoLabel?.()` 在钩子不存在时静默返回 undefined，断言会变成恒假/恒真
   * （MEMORY 记过这个假绿的坑）。下面 ⑭0 先把本节用到的钩子整体验一遍。
   */

  /** 本节依赖的测试钩子（少一个，后面的断言就不可信）。 */
  const HOOKS = ['clips', 'selection', 'playheadFrame', 'seek', 'lastUndoLabel', 'undo'];
  const missingHooks = await page.session.evaluate(
    `JSON.stringify(${JSON.stringify(HOOKS)}.filter((name) => typeof window.__VEDITOR_TEST__[name] !== 'function'))`,
  );
  report.check(`⑭0 本节依赖的测试钩子全部存在（缺：${missingHooks}）`, missingHooks === '[]');

  /**
   * 读条块几何 + 状态。
   *
   * 宽度/位置全部换算成**相对轨道左边缘的比例**：窗口尺寸、左栏宽度一变，
   * 绝对像素就全错了，比例仍然是稳的。
   */
  const readTimeline = () =>
    page.session
      .evaluate(`(() => {
        const track = document.querySelector('[data-v="caption-tl-track"]');
        if (track === null) return JSON.stringify({ present: false });
        const box = track.getBoundingClientRect();
        const blocks = Array.from(track.querySelectorAll('[data-v="caption-tl-block"]')).map((block) => {
          const rect = block.getBoundingClientRect();
          return {
            clipId: block.getAttribute('data-clip-id'),
            left: rect.left - box.left,
            right: rect.right - box.left,
            width: rect.width,
            ratio: box.width > 0 ? rect.width / box.width : 0,
            selected: block.getAttribute('data-selected') === 'true',
            active: block.getAttribute('data-active') === 'true',
            dragging: block.getAttribute('data-dragging') === 'true',
            title: block.getAttribute('title') ?? '',
            text: (block.querySelector('[data-v="caption-tl-text"]')?.textContent ?? '').trim(),
          };
        });
        const axis = Array.from(document.querySelectorAll('[data-v="caption-tl-axis"] span')).map((span) =>
          (span.textContent ?? '').trim(),
        );
        return JSON.stringify({ present: true, width: box.width, blocks, axis });
      })()`)
      .then(JSON.parse);

  /** 读 doc 里的字幕（按起点排序 = 面板行顺序），只取本节要断言的字段。 */
  const readCaptions = () =>
    page.session
      .evaluate(`JSON.stringify(
        window.__VEDITOR_TEST__.clips()
          .filter((clip) => clip.text !== null)
          .map((clip) => ({
            id: clip.id,
            text: clip.text.content,
            start: clip.startFrame,
            duration: clip.durationFrames,
            inFrame: clip.inFrame,
            outFrame: clip.outFrame,
          }))
          .sort((left, right) => left.start - right.start)
      )`)
      .then(JSON.parse);

  /** 工程总长（所有片段的最晚结束帧）—— 用来对比"分母到底取的是什么"。 */
  const readProjectFrames = () =>
    page.session.evaluate(
      `window.__VEDITOR_TEST__.clips().reduce((max, clip) => Math.max(max, clip.startFrame + clip.durationFrames), 0)`,
    );

  // ---- 真实指针事件（CDP Input.dispatchMouseEvent，视口 CSS 像素）----
  // 为什么不用合成 PointerEvent：实现里既有 `setPointerCapture` 也有 window 监听，
  // 合成事件覆盖不到"指针捕获 + 真实按下序列"这条路径，测出来的绿是假的。
  const mouseMove = (x, y) =>
    page.session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x),
      y: Math.round(y),
      button: 'none',
      buttons: 0,
    });
  const mouseDragMove = (x, y) =>
    page.session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x),
      y: Math.round(y),
      button: 'left',
      buttons: 1,
    });
  const mousePress = (x, y) =>
    page.session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: Math.round(x),
      y: Math.round(y),
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
  const mouseRelease = (x, y) =>
    page.session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: Math.round(x),
      y: Math.round(y),
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });

  /** 第 index 个条块某个把手的中心点。 */
  const handlePoint = (index, edge) =>
    page.session
      .evaluate(`(() => {
        const block = document.querySelectorAll('[data-v="caption-tl-block"]')[${index}];
        const handle = block === undefined ? null : block.querySelector('[data-v="caption-tl-handle"][data-edge="${edge}"]');
        if (handle === null) return JSON.stringify({ ok: false, why: 'handle-missing' });
        const rect = handle.getBoundingClientRect();
        return JSON.stringify({ ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, w: rect.width, h: rect.height });
      })()`)
      .then(JSON.parse);

  /** 第 index 个条块的文本区中心（避开两端 6px 把手）。 */
  const blockPoint = (index) =>
    page.session
      .evaluate(`(() => {
        const block = document.querySelectorAll('[data-v="caption-tl-block"]')[${index}];
        if (block === undefined) return JSON.stringify({ ok: false });
        const rect = block.getBoundingClientRect();
        const text = block.querySelector('[data-v="caption-tl-text"]');
        const textRect = text === null ? rect : text.getBoundingClientRect();
        return JSON.stringify({
          ok: true,
          x: textRect.left + textRect.width / 2,
          y: rect.top + rect.height / 2,
          w: rect.width,
          h: rect.height,
        });
      })()`)
      .then(JSON.parse);

  /**
   * 拖一次把手：mousePressed → mouseMoved ×2 → 60ms → **复述落点** → 60ms → mouseReleased。
   *
   * 为什么中间要停 60ms 再复述落点：CDP 的中间 `mouseMoved` 有可能被浏览器合并/丢弃，
   * 复述一次保证"松手前的最后一帧"就是目标位置；留 60ms 是给 React 把预览 state
   * 渲染出来 —— 否则松手时 `draftRef` 可能还是空，拖动就成了一次空操作。
   *
   * 返回**松手前**的快照（用来证明"拖动中 doc 不变、只是预览"）。
   */
  async function dragHandle(index, edge, dx) {
    const point = await handlePoint(index, edge);
    if (point.ok !== true) return { ok: false, why: point.why ?? 'handle-missing', point };
    await mouseMove(point.x, point.y); // 先悬停：确认落点真的在把手上（不是被别的层挡住）
    await mousePress(point.x, point.y);
    await mouseDragMove(point.x + dx / 2, point.y);
    await mouseDragMove(point.x + dx, point.y);
    await sleep(60);
    await mouseDragMove(point.x + dx, point.y); // 复述落点
    await sleep(60);
    const midTimeline = await readTimeline();
    const midCaptions = await readCaptions();
    await mouseRelease(point.x + dx, point.y);
    await sleep(450);
    return { ok: true, point, midTimeline, midCaptions };
  }

  /** 点一次（真实指针按放，不走合成 .click()）——见 ㉑a 的注释。 */
  async function clickBlock(index) {
    const point = await blockPoint(index);
    if (point.ok !== true) return { ok: false };
    await mouseMove(point.x, point.y);
    await mousePress(point.x, point.y);
    await sleep(30);
    await mouseRelease(point.x, point.y);
    await sleep(450);
    return { ok: true, point };
  }

  /** 关闭所有错误条（⑲ 造了一条，别让它影响后面的可达性）。 */
  async function dismissErrors() {
    for (let index = 0; index < 3; index += 1) {
      const clicked = await page.session.evaluate(`(() => {
        const button = document.querySelector('[data-v="errorbar"] button');
        if (button === null) return false;
        button.click();
        return true;
      })()`);
      if (clicked !== true) return;
      await sleep(200);
    }
  }

  // ---- ⑭ 视图切换：默认列表 → 时间轴 → 列表 → 时间轴 ----
  const switchInitial = JSON.parse(
    await page.session.evaluate(`JSON.stringify({
      bar: !!document.querySelector('[data-v="caption-viewswitch"]'),
      listLabel: document.querySelector('[data-v="caption-view-list"]')?.textContent?.trim() ?? '',
      timelineLabel: document.querySelector('[data-v="caption-view-timeline"]')?.textContent?.trim() ?? '',
      listActive: document.querySelector('[data-v="caption-view-list"]')?.getAttribute('data-active') ?? '',
      hasList: !!document.querySelector('[data-v="caption-list"]'),
      hasTimeline: !!document.querySelector('[data-v="caption-timeline"]'),
      stored: window.localStorage.getItem('veditor:caption:view'),
      playhead: window.__VEDITOR_TEST__.playheadFrame(),
    })`),
  );
  report.check(
    `⑭a 默认落在列表视图，切换按钮是中文「列表」「时间轴」（label=${switchInitial.listLabel}/${switchInitial.timelineLabel}，list=${switchInitial.hasList}，timeline=${switchInitial.hasTimeline}，active=${switchInitial.listActive}，stored=${switchInitial.stored}）`,
    switchInitial.bar === true &&
      switchInitial.listLabel === '列表' &&
      switchInitial.timelineLabel === '时间轴' &&
      switchInitial.listActive === 'true' &&
      switchInitial.hasList === true &&
      switchInitial.hasTimeline === false &&
      switchInitial.stored === null,
  );

  await page.session.evaluate(`document.querySelector('[data-v="caption-view-timeline"]').click()`);
  await sleep(450);
  const timelineOn = await readTimeline();
  const switchToTimeline = JSON.parse(
    await page.session.evaluate(`JSON.stringify({
      hasList: !!document.querySelector('[data-v="caption-list"]'),
      timelineActive: document.querySelector('[data-v="caption-view-timeline"]')?.getAttribute('data-active') ?? '',
      listActive: document.querySelector('[data-v="caption-view-list"]')?.getAttribute('data-active') ?? '',
      stored: window.localStorage.getItem('veditor:caption:view'),
    })`),
  );
  report.check(
    `⑭b 点「时间轴」→ 出现条块视图、列表卸载、localStorage 写入 timeline（timeline=${timelineOn.present}，条块 ${timelineOn.blocks.length} 个，list=${switchToTimeline.hasList}，stored=${switchToTimeline.stored}）`,
    timelineOn.present === true &&
      timelineOn.blocks.length === 3 &&
      switchToTimeline.hasList === false &&
      switchToTimeline.stored === 'timeline' &&
      switchToTimeline.timelineActive === 'true' &&
      switchToTimeline.listActive === 'false',
  );
  // ⑨ 里点过第三条（播放头 150 帧）：切进时间轴时播放头**已经在**某条字幕里，
  // 实现里有一条"挂载时先同步一次，别等下一次播放"的逻辑，这里正好验它。
  const activeOnMount = timelineOn.blocks.findIndex((block) => block.active === true);
  report.check(
    `⑭c 切入时间轴时按当前播放头（${switchInitial.playhead} 帧）立即同步高亮：第 ${activeOnMount + 1} 个条块 active`,
    Math.abs(switchInitial.playhead - 150) <= 1 && activeOnMount === 2,
  );
  await screenshot('caption-5-timeline.png');

  await page.session.evaluate(`document.querySelector('[data-v="caption-view-list"]').click()`);
  await sleep(450);
  const switchBackToList = JSON.parse(
    await page.session.evaluate(`JSON.stringify({
      hasList: !!document.querySelector('[data-v="caption-list"]'),
      hasTimeline: !!document.querySelector('[data-v="caption-timeline"]'),
      stored: window.localStorage.getItem('veditor:caption:view'),
    })`),
  );
  report.check(
    `⑭d 点「列表」→ 回到列表且 localStorage 改写为 list（list=${switchBackToList.hasList}，timeline=${switchBackToList.hasTimeline}，stored=${switchBackToList.stored}）`,
    switchBackToList.hasList === true &&
      switchBackToList.hasTimeline === false &&
      switchBackToList.stored === 'list',
  );
  await page.session.evaluate(`document.querySelector('[data-v="caption-view-timeline"]').click()`);
  await sleep(450);

  // ---- ⑮ 条块比例：分母 = 所有字幕的最晚结束帧（不是工程总长）----
  const caps0 = await readCaptions();
  const tl0 = await readTimeline();
  const projectFrames = await readProjectFrames();
  const latestEnd = caps0.reduce((max, cap) => Math.max(max, cap.start + cap.duration), 0);
  report.check(
    `⑮a 3 条字幕的时间区间是 60/60/75 帧、最晚结束 ${latestEnd} 帧（${caps0.map((cap) => `${cap.start}+${cap.duration}`).join(' / ')}）`,
    caps0.length === 3 &&
      caps0[0]?.start === 0 &&
      caps0[0]?.duration === 60 &&
      caps0[1]?.start === 75 &&
      caps0[1]?.duration === 60 &&
      caps0[2]?.start === 150 &&
      caps0[2]?.duration === 75 &&
      latestEnd === 225,
  );

  const ratioError = Math.max(
    ...tl0.blocks.map((block, index) => Math.abs(block.ratio - caps0[index].duration / latestEnd)),
  );
  report.check(
    `⑮b 条块宽度 = 时长 / 最晚结束帧（实际比例 ${tl0.blocks.map((block) => block.ratio.toFixed(4)).join(' / ')}，期望 ${caps0
      .map((cap) => (cap.duration / latestEnd).toFixed(4))
      .join(' / ')}，最大误差 ${ratioError.toFixed(4)}）`,
    tl0.blocks.length === 3 && ratioError <= 0.02,
  );
  // 这条是"分母取谁"的决定性证据：最后一条的右边缘若没贴住轨道右边缘，
  // 说明分母比 225 大（比如错用了工程总长 projectFrames 帧）。
  const tailGap = Math.abs(tl0.blocks[2].right - tl0.width);
  report.check(
    `⑮c 最后一个条块右边缘贴住轨道右边缘（差 ${tailGap.toFixed(1)}px / 轨道宽 ${tl0.width.toFixed(1)}px）→ 分母是字幕最晚结束 ${latestEnd} 帧，不是工程总长 ${projectFrames} 帧`,
    tailGap <= 3 && projectFrames > latestEnd,
  );
  report.check(
    `⑮d 轴末端是毫秒口径的最晚结束时间（${tl0.axis[0] ?? '?'} → ${tl0.axis[1] ?? '?'}）`,
    tl0.axis.length === 2 && tl0.axis[0] === '00:00:00.000' && tl0.axis[1] === '00:00:07.500',
  );

  // ---- ⑯ 刷新后仍然是时间轴（localStorage 持久化）----
  const storedBeforeReload = await page.session.evaluate(
    `window.localStorage.getItem('veditor:caption:view')`,
  );
  await page.session.send('Page.reload');
  await page.session.waitFor("document.readyState === 'complete'", 20000);
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 20000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length === 1', 20000);
  await page.session.waitFor(`!!document.querySelector('[data-v="left-tab-caption"]')`, 20000);
  await page.session.evaluate(`document.querySelector('[data-v="left-tab-caption"]').click()`);
  await page.session.waitFor(`!!document.querySelector('[data-v="caption-file"]')`, 20000);
  const storedAfterReload = await page.session.evaluate(
    `window.localStorage.getItem('veditor:caption:view')`,
  );
  /*
   * `?src=` 打开时**不恢复上次会话**（App.tsx「带 ?src= 打开时不恢复上次会话」），
   * 所以刷新后 doc 是干净的（只有素材、没有字幕）。必须重新导入，
   * 才能在"**完全没点过切换按钮**"的前提下验证视图被记住了 —— 这才是持久化的意义。
   */
  {
    const { root: reloadRoot } = await page.session.send('DOM.getDocument', { depth: -1 });
    const { nodeId: reloadFile } = await page.session.send('DOM.querySelector', {
      nodeId: reloadRoot.nodeId,
      selector: '[data-v="caption-file"]',
    });
    report.check('⑯a 刷新后文件输入仍在（导入入口没丢）', reloadFile !== 0);
    await page.session.send('DOM.setFileInputFiles', { nodeId: reloadFile, files: [SRT] });
    await page.session.waitFor(
      `document.querySelectorAll('[data-v="caption-tl-block"]').length === 3`,
      15000,
    );
  }
  const tlReloaded = await readTimeline();
  report.check(
    `⑯b 刷新 + 重新导入后**不点任何切换按钮**就落在时间轴（stored 前=${storedBeforeReload} 后=${storedAfterReload}，条块 ${tlReloaded.blocks.length} 个）`,
    storedBeforeReload === 'timeline' &&
      storedAfterReload === 'timeline' &&
      tlReloaded.present === true &&
      tlReloaded.blocks.length === 3,
  );
  await screenshot('caption-6-timeline-reload.png');

  // ---- ⑰ 右把手拖动：拖动中只是预览，松手才提交，且只压一步撤销 ----
  const capsBeforeRight = await readCaptions();
  const tlBeforeRight = await readTimeline();
  const rightDx = 20;
  const rightDelta = Math.round((rightDx / tlBeforeRight.width) * latestEnd);
  const undoBeforeRight = await page.session.evaluate(`window.__VEDITOR_TEST__.lastUndoLabel()`);
  const rightDrag = await dragHandle(2, 'right', rightDx);
  report.check(
    `⑰a 右把手真实拖动会话建立（起点 ${rightDrag.point?.x?.toFixed(1)},${rightDrag.point?.y?.toFixed(1)}，把手宽 ${rightDrag.point?.w}px，拖动中 data-dragging=${rightDrag.midTimeline?.blocks[2]?.dragging}）`,
    rightDrag.ok === true && rightDrag.midTimeline?.blocks[2]?.dragging === true,
  );
  const midEnd = /→ (\d{2}:\d{2}:\d{2}\.\d{3})/.exec(rightDrag.midTimeline?.blocks[2]?.title ?? '')?.[1] ?? '';
  report.check(
    `⑰b 拖动中只是预览：doc 里时长仍是 ${rightDrag.midCaptions?.[2]?.duration} 帧，条块 title 的末端已到 ${midEnd}（原 00:00:07.500）`,
    rightDrag.midCaptions?.[2]?.duration === capsBeforeRight[2].duration &&
      rightDrag.midCaptions?.[2]?.start === capsBeforeRight[2].start &&
      midEnd > '00:00:07.500',
  );

  const capsAfterRight = await readCaptions();
  const rightExpected = capsBeforeRight[2].duration + rightDelta;
  report.check(
    `⑰c 松手后 doc 才变：时长 ${capsBeforeRight[2].duration} → ${capsAfterRight[2]?.duration} 帧（期望 ≈${rightExpected}，起点仍是 ${capsAfterRight[2]?.start}），outFrame 跟随=${capsAfterRight[2]?.outFrame}`,
    capsAfterRight[2]?.start === capsBeforeRight[2].start &&
      Math.abs(capsAfterRight[2].duration - rightExpected) <= 2 &&
      capsAfterRight[2].outFrame === capsAfterRight[2].duration &&
      capsAfterRight[2].duration > capsBeforeRight[2].duration,
  );

  const undoAfterRight = await page.session.evaluate(`window.__VEDITOR_TEST__.lastUndoLabel()`);
  report.check(
    `⑰d 撤销栈只多了一步，标签是「调整字幕时间」（前=${undoBeforeRight} → 后=${undoAfterRight}）`,
    undoAfterRight === '调整字幕时间' && undoAfterRight !== undoBeforeRight,
  );

  await page.session.evaluate(`window.__VEDITOR_TEST__.undo()`);
  await sleep(450);
  const capsAfterUndo = await readCaptions();
  const undoLabelAfterUndo = await page.session.evaluate(`window.__VEDITOR_TEST__.lastUndoLabel()`);
  report.check(
    `⑰e 一次 undo 就完整回滚到拖动前（时长回到 ${capsAfterUndo[2]?.duration} 帧，栈顶退回 ${undoLabelAfterUndo}）→ 整场拖动确实只压了一步`,
    capsAfterUndo[2]?.duration === capsBeforeRight[2].duration &&
      capsAfterUndo[2]?.start === capsBeforeRight[2].start &&
      undoLabelAfterUndo === undoBeforeRight,
  );

  // ---- ⑱ 左把手拖动：起点跟着指针走，**终点钉住** ----
  const capsBeforeLeft = await readCaptions();
  const tlBeforeLeft = await readTimeline();
  const leftDx = 20;
  const leftDelta = Math.round((leftDx / tlBeforeLeft.width) * latestEnd);
  const leftDrag = await dragHandle(2, 'left', leftDx);
  const capsAfterLeft = await readCaptions();
  const leftEnd = capsAfterLeft[2].start + capsAfterLeft[2].duration;
  report.check(
    `⑱a 左把手拖动后起点变、时长反向变（${capsBeforeLeft[2].start}+${capsBeforeLeft[2].duration} → ${capsAfterLeft[2].start}+${capsAfterLeft[2].duration}，期望起点 ≈${capsBeforeLeft[2].start + leftDelta}）`,
    leftDrag.ok === true &&
      Math.abs(capsAfterLeft[2].start - (capsBeforeLeft[2].start + leftDelta)) <= 2 &&
      Math.abs(capsAfterLeft[2].duration - (capsBeforeLeft[2].duration - leftDelta)) <= 2 &&
      capsAfterLeft[2].outFrame === capsAfterLeft[2].duration,
  );
  report.check(
    `⑱b 终点钉住不变：${capsBeforeLeft[2].start + capsBeforeLeft[2].duration} → ${leftEnd}（start + duration 恒定）`,
    leftEnd === capsBeforeLeft[2].start + capsBeforeLeft[2].duration,
  );
  await screenshot('caption-7-timeline-dragged.png');

  // ---- ⑲ 拖到重叠：中文错误条 + doc 不变 + 条块回滚 ----
  // 此时第三条已被 ⑱ 拉到 164–225，第二条（75–135）只要再长 30 帧就会盖到它。
  // 拖动距离**按真实几何算**（多给 12 帧余量），不写死像素 —— 窗口/左栏宽度变了也照样能拖到重叠。
  const tlBeforeOverlap = await readTimeline();
  const capsBeforeOverlap = await readCaptions();
  const overlapNeedFrames =
    capsBeforeOverlap[2].start - capsBeforeOverlap[1].start - capsBeforeOverlap[1].duration + 12;
  const overlapDx = Math.ceil((overlapNeedFrames / latestEnd) * tlBeforeOverlap.width);
  const undoBeforeOverlap = await page.session.evaluate(`window.__VEDITOR_TEST__.lastUndoLabel()`);
  const overlapDrag = await dragHandle(1, 'right', overlapDx);
  const tlAfterOverlap = await readTimeline();
  const capsAfterOverlap = await readCaptions();
  const errorText = await page.session.evaluate(`(() => {
    const bar = document.querySelector('[data-v="errorbar"]');
    return bar === null ? '' : (bar.textContent ?? '').trim();
  })()`);
  report.check(
    `⑲a 拖到重叠后给出中文错误条（"${errorText}"）`,
    errorText.includes('重叠'),
  );
  // 拖动中 doc 必须**不变**（预览只活在本地 state 里）——所以这里要同时验两件事：
  //   a) 松手后 doc 还是原值（重叠被拒 → 没有 dispatch）；
  //   b) 松手前的条块 title 已经跑到重叠位置（说明"确实拖动了、只是没写进 doc"）。
  // 只验 a 的话，一个"根本没拖动"的空操作也会绿。
  const midOverlapEnd =
    /→ (\d{2}:\d{2}:\d{2}\.\d{3})/.exec(overlapDrag.midTimeline?.blocks[1]?.title ?? '')?.[1] ?? '';
  report.check(
    `⑲b doc 没被改：第二条仍是 ${capsAfterOverlap[1]?.start}+${capsAfterOverlap[1]?.duration}（拖动中预览已到末端 ${midOverlapEnd}，原末端 00:00:04.500）`,
    capsAfterOverlap[1]?.start === capsBeforeOverlap[1].start &&
      capsAfterOverlap[1]?.duration === capsBeforeOverlap[1].duration &&
      overlapDrag.midCaptions?.[1]?.duration === capsBeforeOverlap[1].duration &&
      midOverlapEnd > '00:00:04.500',
  );
  report.check(
    `⑲c 条块回滚到拖动前（left ${tlBeforeOverlap.blocks[1].left.toFixed(1)} → ${tlAfterOverlap.blocks[1].left.toFixed(1)}，宽 ${tlBeforeOverlap.blocks[1].width.toFixed(1)} → ${tlAfterOverlap.blocks[1].width.toFixed(1)}，dragging=${tlAfterOverlap.blocks[1].dragging}）`,
    Math.abs(tlAfterOverlap.blocks[1].left - tlBeforeOverlap.blocks[1].left) <= 1 &&
      Math.abs(tlAfterOverlap.blocks[1].width - tlBeforeOverlap.blocks[1].width) <= 1 &&
      tlAfterOverlap.blocks[1].dragging === false,
  );
  const undoAfterOverlap = await page.session.evaluate(`window.__VEDITOR_TEST__.lastUndoLabel()`);
  report.check(
    `⑲d 被拒绝的拖动不留撤销步（栈顶 ${undoBeforeOverlap} → ${undoAfterOverlap}）`,
    undoAfterOverlap === undoBeforeOverlap,
  );
  await dismissErrors();

  // ---- ⑳ 播放高亮：播放头所在的条块 data-active=true ----
  // 换成 24 条（起点 0/2/4…46s）：条块更细，也顺便把"最后一条的末端"当分母
  // （分母跟着数据走，不是常量 225）。
  //
  // **为什么是 24 条而不是 10 条**：左栏一屏能放下 10 条（⑤b 就是验这个），
  // 10 条时列表根本不可滚动，`scrollIntoView` 是空转 —— 那样"选中行可见"永远成立 = 假绿。
  //
  // **为什么最后一条故意做成 10 秒**：24 条等宽时每块只有约 12px（1400 帧里占 54 帧），
  // 而两端把手各 6px —— 条块正体宽度为 0，鼠标按下必然落在把手上，点选/跳转根本点不到。
  // 那是"极短字幕在长工程里只剩把手"的真实 UX 局限（见汇报），不该混进这条联动断言里，
  // 所以留一条长字幕当"用户真会点的目标"。
  const LONG_COUNT = 24;
  const SRT_LONG = path.join(ROOT, 'tests', '.tmp', 'caption-c4-long.srt');
  {
    const blocks = [];
    for (let index = 0; index < LONG_COUNT; index += 1) {
      const start = index * 2;
      const pad = (value) => String(value).padStart(2, '0');
      const end = index === LONG_COUNT - 1 ? `${pad(start + 10)},000` : `${pad(start + 1)},800`;
      blocks.push(
        String(index + 1),
        `00:00:${pad(start)},000 --> 00:00:${end}`,
        `第 ${index + 1} 条时间轴字幕`,
        '',
      );
    }
    fs.writeFileSync(SRT_LONG, blocks.join('\n'), 'utf8');
    const { root: longRoot } = await page.session.send('DOM.getDocument', { depth: -1 });
    const { nodeId: longFile } = await page.session.send('DOM.querySelector', {
      nodeId: longRoot.nodeId,
      selector: '[data-v="caption-file"]',
    });
    await page.session.send('DOM.setFileInputFiles', { nodeId: longFile, files: [SRT_LONG] });
    await page.session.waitFor(
      `document.querySelectorAll('[data-v="caption-tl-block"]').length === ${LONG_COUNT}`,
      15000,
    );
  }
  const capsLong = await readCaptions();
  await page.session.evaluate(`window.__VEDITOR_TEST__.seek(200)`);
  await sleep(400);
  const tlSeek = await readTimeline();
  const activeIndexes = tlSeek.blocks
    .map((block, index) => (block.active ? index : -1))
    .filter((index) => index >= 0);
  report.check(
    `⑳ 播放头到 200 帧时只有第 4 个条块 active（active 索引 [${activeIndexes.join(',')}]，第 4 条区间 ${capsLong[3]?.start}–${(capsLong[3]?.start ?? 0) + (capsLong[3]?.duration ?? 0)}）`,
    tlSeek.blocks.length === LONG_COUNT &&
      activeIndexes.length === 1 &&
      activeIndexes[0] === 3 &&
      200 >= capsLong[3].start &&
      200 < capsLong[3].start + capsLong[3].duration,
  );

  // ---- ㉑ 双向联动：点条块 → 播放头跳 + 选中；切回列表选中行可见 ----
  /*
   * **这里必须用真实指针按放，不能 `element.click()`**：
   * 实现里"拖动结束后紧跟的 click 要吞掉"（suppressClickRef），而 ⑲ 那次失败的拖动
   * 也把这个标记置上了。纯 `.click()` 不带 pointerdown（唯一清除标记的时机），
   * 会被当成拖动的尾巴吞掉 —— 那样测出来的"点不动"是测试造的假 bug。
   */
  const lastIndex = LONG_COUNT - 1;
  const clickResult = await clickBlock(lastIndex);
  const afterBlockClick = JSON.parse(
    await page.session.evaluate(`JSON.stringify({
      playhead: window.__VEDITOR_TEST__.playheadFrame(),
      selected: window.__VEDITOR_TEST__.selection(),
    })`),
  );
  const tlAfterClick = await readTimeline();
  report.check(
    `㉑a 点第 ${LONG_COUNT} 个条块 → 播放头跳到 ${afterBlockClick.playhead} 帧（该条起点 ${capsLong[lastIndex].start}）+ 选中 ${afterBlockClick.selected === tlAfterClick.blocks[lastIndex].clipId ? '这一条' : `别条(${afterBlockClick.selected})`}`,
    clickResult.ok === true &&
      Math.abs(afterBlockClick.playhead - capsLong[lastIndex].start) <= 1 &&
      afterBlockClick.selected === tlAfterClick.blocks[lastIndex].clipId &&
      tlAfterClick.blocks[lastIndex].active === true,
  );

  await page.session.evaluate(`document.querySelector('[data-v="caption-view-list"]').click()`);
  await sleep(600);
  // 先证明这条断言**有内容**：列表本身得是可滚动的（24 条 × 26px 远超左栏高度），
  // 否则 scrollIntoView 是空转，"选中行可见"永远成立 = 假绿。
  const listScroll = JSON.parse(
    await page.session.evaluate(`(() => {
      const list = document.querySelector('[data-v="caption-list"]');
      if (list === null) return JSON.stringify({ present: false });
      const listRect = list.getBoundingClientRect();
      const rows = Array.from(list.querySelectorAll('[data-v="caption-row"]'));
      const selected = rows.find((row) => row.getAttribute('data-selected') === 'true');
      const rect = selected === undefined ? null : selected.getBoundingClientRect();
      return JSON.stringify({
        present: true,
        rowCount: rows.length,
        scrollable: list.scrollHeight > list.clientHeight + 10,
        scrollTop: list.scrollTop,
        selectedClipId: selected === undefined ? null : selected.getAttribute('data-clip-id'),
        visible:
          rect !== null && rect.top >= listRect.top - 1 && rect.bottom <= listRect.bottom + 1,
        offsetFromTop: rect === null ? null : Math.round(rect.top - listRect.top),
      });
    })()`),
  );
  report.check(
    `㉑b 切回列表后选中行仍是第 ${LONG_COUNT} 条，且被 scrollIntoView 滚进可视区（行 ${listScroll.rowCount} 行、可滚动=${listScroll.scrollable}、scrollTop=${listScroll.scrollTop}、距顶 ${listScroll.offsetFromTop}px）`,
    listScroll.present === true &&
      listScroll.rowCount === LONG_COUNT &&
      listScroll.scrollable === true &&
      listScroll.scrollTop > 0 &&
      listScroll.selectedClipId === afterBlockClick.selected &&
      listScroll.visible === true,
  );
  await screenshot('caption-8-timeline-linkage.png');

// ---- ㉒ 窄条块也要点得到（回归保护）----
// 24 条 1.8s 字幕时每块仅约 11.7px。把手若写死 6px 会铺满整块，
// `elementFromPoint(块中心)` 命中把手 → 块正体的 click 被 stopPropagation 吞掉，
// 用户点条块完全没反应（选中和跳转都失效）。这条断言守住 `width: min(6px, 30%)`。
{
  await page.session.evaluate(`document.querySelector('[data-v="caption-view-timeline"]').click()`);
  await sleep(800);
  const narrow = await page.session.evaluate(`(() => {
    const blocks = Array.from(document.querySelectorAll('[data-v="caption-tl-block"]'));
    if (blocks.length === 0) return JSON.stringify({ ok: false, reason: 'no-block' });
    let target = null;
    let minWidth = Infinity;
    for (const block of blocks) {
      const r = block.getBoundingClientRect();
      if (r.width < minWidth) { minWidth = r.width; target = { block, r }; }
    }
    const cx = target.r.left + target.r.width / 2;
    const cy = target.r.top + target.r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return JSON.stringify({
      ok: true,
      count: blocks.length,
      minWidth: Math.round(minWidth * 10) / 10,
      hitV: hit?.getAttribute?.('data-v') ?? null,
      hitIsBlock: hit?.getAttribute?.('data-v') === 'caption-tl-block',
      x: Math.round(cx),
      y: Math.round(cy),
    });
  })()`);
  const n = JSON.parse(narrow);
  report.check(
    `㉒ 最窄条块（${n.minWidth}px）中心可点（命中 ${n.hitV}，不是把手）`,
    n.ok === true && n.hitIsBlock === true,
  );

  // 真点一下：不只看 elementFromPoint，还要选中/跳转真的发生
  if (n.ok === true) {
    await page.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: n.x, y: n.y, button: 'none' });
    await sleep(30);
    await page.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: n.x, y: n.y, button: 'left', clickCount: 1 });
    await sleep(30);
    await page.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: n.x, y: n.y, button: 'left', clickCount: 1 });
    await sleep(500);
    const picked = await page.session.evaluate(`JSON.stringify({
      selectedCount: document.querySelectorAll('[data-v="caption-tl-block"][data-selected="true"]').length,
      playhead: window.__VEDITOR_TEST__.playheadFrame(),
    })`);
    const p = JSON.parse(picked);
    report.check(
      `㉒b 点最窄条块真的选中（selected 块数=${p.selectedCount}，播放头=${p.playhead}）`,
      p.selectedCount === 1,
    );
  }
}

// ---- ㉓ 框选（C5-6）：相交判定 / Ctrl 加选 / 点空白清空 ----
/*
 * **用合成 PointerEvent，不用 CDP 真实鼠标**。
 *
 * 实测 CDP 的 `Input.dispatchMouseEvent` 序列是
 *   pointerdown → pointermove → **pointercancel@0,0**
 * 浏览器在合成鼠标的第二次 move 就取消指针，选框"闪一下就不见"。
 * 这是 CDP 合成鼠标的指针状态机限制（真机鼠标不会），
 * 所以这里退让到页面内 dispatch，验证的是**框选逻辑本身**（相交判定/加选/清空）。
 * 已经给 track 加了 `touch-action: none`（真机上是必需的，虽然 CDP 测不出来）。
 */
{
  async function marqueeDrag(x0, y0, x1, y1, withCtrl = false) {
    await page.session.evaluate(`(() => {
      const track = document.querySelector('[data-v="caption-tl-track"]');
      if (track === null) return false;
      const base = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, ctrlKey: ${withCtrl ? 'true' : 'false'} };
      track.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: ${x0}, clientY: ${y0} }));
      for (const t of [0.4, 0.75, 1]) {
        const x = Math.round(${x0} + (${x1} - ${x0}) * t);
        const y = Math.round(${y0} + (${y1} - ${y0}) * t);
        window.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: x, clientY: y }));
      }
      window.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0, clientX: ${x1}, clientY: ${y1} }));
      return true;
    })()`);
    await sleep(400);
  }

  const geo = JSON.parse(await page.session.evaluate(`(() => {
    const blocks = Array.from(document.querySelectorAll('[data-v="caption-tl-block"]'));
    const track = document.querySelector('[data-v="caption-tl-track"]');
    const tr = track.getBoundingClientRect();
    return JSON.stringify({
      trackRight: Math.round(tr.right),
      blocks: blocks.map((b) => { const r = b.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }; }),
    });
  })()`));
  const midY = Math.round((geo.blocks[0].top + geo.blocks[0].bottom) / 2);

  const sel = () =>
    page.session.evaluate(`JSON.stringify({
      count: document.querySelectorAll('[data-v="caption-tl-block"][data-selected="true"]').length,
      indexes: Array.from(document.querySelectorAll('[data-v="caption-tl-block"]')).map((b, i) => (b.getAttribute('data-selected') === 'true' ? i : -1)).filter((i) => i >= 0),
      batchBar: !!document.querySelector('[data-v="batch-bar"]'),
    })`).then(JSON.parse);

  // ① 从块 0 与块 1 的间隙起手，拖到块 2 中间 → 相交的是块 1、2
  await marqueeDrag(geo.blocks[0].right + 2, midY, Math.round((geo.blocks[2].left + geo.blocks[2].right) / 2), midY);
  const first = await sel();
  report.check(
    `㉓ 框选相交判定：从间隙拖到第 3 块中间 → 选中 ${first.count} 条（索引 [${first.indexes.join(',')}]，期望 [1,2]）`,
    first.count === 2 && first.indexes[0] === 1 && first.indexes[1] === 2,
  );
  report.check(`㉓b 框选后批量条自动弹出`, first.batchBar === true);

  // ② Ctrl 框选最后一块 → 加选（不清掉已有的）
  const geo2 = JSON.parse(await page.session.evaluate(`(() => {
    const blocks = Array.from(document.querySelectorAll('[data-v="caption-tl-block"]'));
    const n = blocks.length;
    const r = blocks[n - 1].getBoundingClientRect();
    const prev = blocks[n - 2].getBoundingClientRect();
    return JSON.stringify({ gap: Math.round(prev.right + 2), lastLeft: Math.round(r.left), lastRight: Math.round(r.right), y: Math.round((r.top + r.bottom) / 2) });
  })()`));
  await marqueeDrag(geo2.gap, geo2.y, Math.round((geo2.lastLeft + geo2.lastRight) / 2), geo2.y, true);
  const second = await sel();
  report.check(
    `㉓c Ctrl 框选是**加选**（${first.count} → ${second.count} 条，索引 [${second.indexes.join(',')}]）`,
    second.count === first.count + 1 && second.indexes.includes(1) && second.indexes.includes(2),
  );

  // ③ 点空白（不拖）→ 清空
  const geo3 = JSON.parse(await page.session.evaluate(`(() => {
    const track = document.querySelector('[data-v="caption-tl-track"]');
    const tr = track.getBoundingClientRect();
    const b = document.querySelectorAll('[data-v="caption-tl-block"]')[0].getBoundingClientRect();
    return JSON.stringify({ x: Math.round(tr.right - 4), y: Math.round((b.top + b.bottom) / 2) });
  })()`));
  await marqueeDrag(geo3.x, geo3.y, geo3.x, geo3.y);
  const third = await sel();
  report.check(
    `㉓d 点空白清空选择（${third.count} 条）`,
    third.count === 0 && third.batchBar === false,
  );
}

} finally {
  await page.close();
  dev.kill();
  await new Promise((resolve) => server.close(resolve));
}

report.summary('左栏「字幕」面板');