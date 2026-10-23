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
} finally {
  await page.close();
  dev.kill();
  await new Promise((resolve) => server.close(resolve));
}

report.summary('左栏「字幕」面板');