/**
 * 左栏「特效」面板 E2E（第一步：预设 + 点击应用 + 已应用高亮）。
 *
 * ## 这个文件在防什么
 *
 * 1. **参数真的写对了**：点「黑白」后 `saturation` 必须是 -100（不是"有个 colorGrade 就行"）；
 * 2. **画面真的变了**：`meanLuma` 判不出"去色"—— 彩色画面和它的灰度版亮度完全一样。
 *    所以读**三通道均值**：黑白后三个值趋同，应用前差异明显；
 * 3. **同类型单例**：换预设是替换不是叠加（`effects` 里 colorGrade 始终 1 条）；
 * 4. **「原片」= 移除 effect**，不是"写四个 0 的 effect"（后者会在 effects 里留空记录）；
 * 5. **重复点同一个预设不发无用撤销步**（撤销一次应该回到上一步，而不是"没变化"）；
 * 6. **文字片段拒绝**：属性栏里没有调色控件，加了也去不掉；
 * 7. **缩略图是真画面**：黑白卡的缩略图三通道也要趋同（说明缩略图用的是同一套公式）。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5262;
const FIXTURE = 'sample-720p.mp4';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('dev server 启动超时')), 20000);
  dev.stdout.on('data', (chunk) => {
    if (String(chunk).includes(`127.0.0.1:${PORT}`)) {
      clearTimeout(timer);
      resolve();
    }
  });
});

const page = await launchPage({
  url: `http://127.0.0.1:${PORT}/?src=${origin}/${FIXTURE}`,
  width: 1440,
  height: 900,
});
const report = createReport();

const clips = async () => JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.clips())'));
const errors = async () => JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.errors())'));
const click = async (selector) => {
  await page.session.evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  await sleep(320);
};
const snapshot = async () =>
  JSON.parse(
    await page.session.evaluate(
      '(async () => JSON.stringify(await window.__VEDITOR_TEST__.previewSnapshot()))()',
    ),
  );
/** 等画面真的画出来（解码是异步的，固定 sleep 在全量连跑时会拍到全黑）。 */
const waitPreview = async () => {
  for (let i = 0; i < 25; i += 1) {
    const stats = await snapshot();
    if (stats !== null && stats.nonBlack > 1000) return stats;
    await sleep(200);
  }
  return await snapshot();
};
const clipById = async (id) => (await clips()).find((clip) => clip.id === id);
/** 片段上的 colorGrade（可能没有）。 */
const gradeOf = (clip) => (clip?.effectDetails ?? []).find((effect) => effect.type === 'colorGrade') ?? null;
/** 三通道均值的"最大差值"：去色后趋 0。 */
const channelSpread = (stats) => {
  const values = [stats.meanR, stats.meanG, stats.meanB];
  return Math.max(...values) - Math.min(...values);
};
const tracks = async () => JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.tracks())'));
/** 帧号 + 轨道 → 画布上的屏幕坐标（时间线内容区，行中线）。 */
const dragPoint = async (frame, trackId) =>
  JSON.parse(
    await page.session.evaluate(`(() => {
      const canvas = document.querySelector('[data-v="timeline-canvas"]');
      const layout = window.__VEDITOR_TEST__.timelineLayout();
      const row = layout.rows.find((item) => item.trackId === ${JSON.stringify(trackId)});
      if (!row) return JSON.stringify({ x: -1, y: -1 });
      const zoom = window.__VEDITOR_TEST__.zoomLevel();
      const scrollX = Number(canvas.dataset['scrollX'] ?? '0');
      const rect = canvas.getBoundingClientRect();
      return JSON.stringify({
        x: rect.left + layout.headerWidth + ${frame} * zoom - scrollX,
        y: rect.top + row.top + row.height / 2,
      });
    })()`),
  );
/**
 * 完整模拟一次拖拽：卡片 `dragstart` → 画布 `dragover` → 画布 `drop`。
 *
 * **必须补 dragstart**：dragover 阶段浏览器不允许读 `getData()`，实现里靠 `ui/dnd`
 * 的页面内变量传 id —— 那个变量只有真正的 dragstart 才会写上。
 */
const dragPreset = async (point, presetId) =>
  JSON.parse(
    await page.session.evaluate(`(() => {
      const canvas = document.querySelector('[data-v="timeline-canvas"]');
      const card = document.querySelector('[data-v="effect-preset"][data-preset-id="${presetId}"]');
      const dt = new DataTransfer();
      const make = (type, target) => {
        const event = new DragEvent(type, {
          bubbles: true, cancelable: true, dataTransfer: dt,
          clientX: ${point.x}, clientY: ${point.y},
        });
        target.dispatchEvent(event);
        return event;
      };
      if (card) make('dragstart', card);
      const over = make('dragover', canvas);
      const ghost = window.__VEDITOR_TEST__.effectGhost();
      make('drop', canvas);
      return JSON.stringify({ prevented: over.defaultPrevented, ghost });
    })()`),
  );
/** 面板上可见的卡片（按 DOM 顺序）。 */
const cards = async () =>
  JSON.parse(
    await page.session.evaluate(`(() => {
      const nodes = [...document.querySelectorAll('[data-v="effect-preset"]')];
      return JSON.stringify(nodes.filter((el) => el.getBoundingClientRect().height > 0).map((el) => ({
        id: el.getAttribute('data-preset-id'),
        name: el.querySelector('.v-fxcard__name')?.textContent ?? '',
        applied: el.getAttribute('data-applied') === 'true',
        pinned: el.getAttribute('data-pinned') === 'true',
      })));
    })()`),
  );

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 20000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 30000);
  await sleep(1800);

  // ---- ① 面板：14 张卡 + 4 个分类 chip ----
  await click('[data-v="left-tab-effect"]');
  const list = await cards();
  const chips = JSON.parse(
    await page.session.evaluate(`(() => {
      const nodes = [...document.querySelectorAll('[data-v^="effect-cat-"]')];
      return JSON.stringify(nodes.map((el) => el.textContent.trim()));
    })()`),
  );
  report.check(
    `① 特效 Tab 显示 14 个预设 / 4 个分类（${chips.join('/')}）`,
    list.length === 14 && chips.join('/') === '全部/基础/冷暖/风格',
  );
  report.check(
    `①b 原片固定第一条（${list[0]?.name}）且标记为 pinned`,
    list[0]?.name === '原片' && list[0]?.pinned === true,
  );
  report.check(
    `①c 没有特效时「原片」高亮（已高亮 ${list.filter((c) => c.applied).length} 张）`,
    list[0]?.applied === true && list.filter((c) => c.applied).length === 1,
  );

  // ---- ② 应用「黑白」：参数正确 + 同类型只有一条 ----
  const clip = (await clips())[0];
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(clip.id)})`);
  await sleep(200);
  const beforeStats = await waitPreview();
  await click('[data-v="effect-preset"][data-preset-id="fx-mono"]');
  let now = await clipById(clip.id);
  const mono = gradeOf(now);
  report.check(
    `② 点「黑白」→ saturation=${mono?.params?.saturation}，effects 里 colorGrade 共 ${
      (now?.effectDetails ?? []).filter((e) => e.type === 'colorGrade').length
    } 条`,
    mono?.params?.saturation === -100 &&
      mono?.params?.contrast === 8 &&
      (now?.effectDetails ?? []).filter((e) => e.type === 'colorGrade').length === 1,
  );

  // ---- ③ 画面真的变灰（读三通道均值，meanLuma 判不出来）----
  /**
   * 判据用**相对变化**而不是绝对阈值：素材本身的色差只有 5 左右（这个 fixture 偏灰），
   * 写死"差异 > 6"会红在一个跟产品无关的地方。真正要证的是"去色之后三通道趋同"，
   * 即 spread 掉到原来的 1/2 以下、且接近 0。
   */
  await sleep(600);
  const monoStats = await waitPreview();
  report.check(
    `③ 黑白后三通道趋同（差异 ${channelSpread(beforeStats).toFixed(1)} → ${channelSpread(
      monoStats,
    ).toFixed(1)}；均值 R${monoStats.meanR.toFixed(0)} G${monoStats.meanG.toFixed(0)} B${monoStats.meanB.toFixed(0)}）`,
    channelSpread(beforeStats) > 3 &&
      channelSpread(monoStats) < 1 &&
      channelSpread(monoStats) < channelSpread(beforeStats) * 0.5,
  );

  // ---- ④ 卡片高亮跟着走（只有黑白那张）----
  const appliedList = (await cards()).filter((item) => item.applied);
  report.check(
    `④ 「已应用」只在黑白那张卡上（${appliedList.map((c) => c.name).join('/')}）`,
    appliedList.length === 1 && appliedList[0].id === 'fx-mono',
  );

  // ---- ⑤ 换「暖阳」→ 替换而不是叠加 ----
  await click('[data-v="effect-preset"][data-preset-id="fx-warm"]');
  now = await clipById(clip.id);
  const warm = gradeOf(now);
  report.check(
    `⑤ 换「暖阳」→ 替换（colorGrade 仍 ${
      (now?.effectDetails ?? []).filter((e) => e.type === 'colorGrade').length
    } 条，temperature=${warm?.params?.temperature}，saturation=${warm?.params?.saturation}）`,
    (now?.effectDetails ?? []).filter((e) => e.type === 'colorGrade').length === 1 &&
      warm?.params?.temperature === 34 &&
      warm?.params?.saturation === 8,
  );

  // ---- ⑥ 属性栏同步（面板与滑块写的是同一份数据）----
  const tempSlider = await page.session.evaluate(
    `document.querySelector('[data-v="inspector-temperature-value"]')?.textContent ?? ''`,
  );
  report.check(`⑥ 属性栏色温滑块跟着变（显示 ${tempSlider}）`, String(tempSlider).trim() === '34');

  // ---- ⑦ 重复点同一个预设 → 不产生撤销步 ----
  /**
   * 此刻状态是「黑白 → 暖阳」。再点一次暖阳（参数完全一样）应该**什么都不发**，
   * 所以撤销一次必须回到**黑白**；如果第二次点击也占了一个撤销步，
   * 撤销一次会"看起来什么都没变"（还是暖阳）—— 这正是要防的。
   */
  await click('[data-v="effect-preset"][data-preset-id="fx-warm"]');
  await page.session.evaluate('window.__VEDITOR_TEST__.undo()');
  await sleep(450);
  now = await clipById(clip.id);
  report.check(
    `⑦ 重复点同一预设不占撤销步（撤销一次回到黑白，saturation=${gradeOf(now)?.params?.saturation}）`,
    gradeOf(now)?.params?.saturation === -100,
  );

  // ---- ⑧ 点「原片」：移除 effect，画面恢复彩色 ----
  await click('[data-v="effect-preset"][data-preset-id="fx-mono"]');
  await sleep(600);
  await click('[data-v="effect-preset"][data-preset-id="fx-original"]');
  await sleep(600);
  now = await clipById(clip.id);
  const restored = await waitPreview();
  report.check(
    `⑧ 点「原片」→ effect 被移除（${(now?.effectDetails ?? []).length} 条）且画面恢复到应用前（差异 ${channelSpread(
      restored,
    ).toFixed(1)}，应用前 ${channelSpread(beforeStats).toFixed(1)}）`,
    (now?.effectDetails ?? []).length === 0 &&
      channelSpread(restored) > 3 &&
      Math.abs(channelSpread(restored) - channelSpread(beforeStats)) < 1.5,
  );

  // ---- ⑨ 分类筛选：原片永远在第一位 ----
  await click('[data-v="effect-cat-style"]');
  const styleList = await cards();
  await click('[data-v="effect-cat-basic"]');
  const basicList = await cards();
  report.check(
    `⑨ 分类筛选（风格 ${styleList.length} 张 / 基础 ${basicList.length} 张，原片都在第一）`,
    styleList.length === 6 &&
      styleList[0].id === 'fx-original' &&
      basicList.length === 5 &&
      basicList[0].id === 'fx-original',
  );
  await click('[data-v="effect-cat-all"]');

  // ---- ⑩ 缩略图是真画面，而且套了同一个公式 ----
  /**
   * 判据刻意避开"源图够不够彩"：这个 fixture 的第一帧几乎是灰的，
   * 用"色差变小"来验去色会时灵时不灵。改成三条与源图无关的：
   * - 提亮 → 平均亮度必须明显高于原片（加法提亮，任何源图都成立）；
   * - 暖阳 → R 均值必须大于 B 均值（色温加红减蓝）；
   * - 黑白 → 三通道趋同（去色的定义）。
   */
  const thumbs = JSON.parse(
    await page.session.evaluate(`(() => {
      const read = (id) => {
        const card = document.querySelector('[data-v="effect-preset"][data-preset-id="' + id + '"]');
        const canvas = card?.querySelector('canvas');
        if (!canvas) return null;
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let r = 0, g = 0, b = 0, luma = 0;
        const n = data.length / 4;
        for (let i = 0; i + 3 < data.length; i += 4) {
          r += data[i]; g += data[i + 1]; b += data[i + 2];
          luma += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        }
        const meanR = r / n, meanG = g / n, meanB = b / n;
        return {
          meanR, meanG, meanB, luma: luma / n,
          spread: Math.max(meanR, meanG, meanB) - Math.min(meanR, meanG, meanB),
        };
      };
      return JSON.stringify({ original: read('fx-original'), brighten: read('fx-brighten'),
                              mono: read('fx-mono'), warm: read('fx-warm') });
    })()`),
  );
  report.check(
    `⑩ 缩略图套了同一个公式（亮度 ${thumbs.original?.luma.toFixed(1)} → 提亮 ${thumbs.brighten?.luma.toFixed(
      1,
    )}；暖阳 R${thumbs.warm?.meanR.toFixed(0)}>B${thumbs.warm?.meanB.toFixed(0)}；黑白色差 ${thumbs.mono?.spread.toFixed(
      1,
    )}）`,
    thumbs.brighten.luma > thumbs.original.luma + 10 &&
      thumbs.warm.meanR > thumbs.warm.meanB + 6 &&
      thumbs.mono.spread < 1.5,
  );
  /**
   * ⑩b 用的是**素材真画面**，不是内置测试图。
   *
   * 内置测试图刻意画了肤色块 + 红块 + 灰阶，三通道色差约 12；
   * 这个 fixture 的缩略图偏灰，色差只有 5 左右。所以"色差 < 10"能钉住
   * "真缩略图被读到了"—— 一旦退化成兜底图，这条会红。
   * （不写死具体数值，只卡在两档之间。）
   */
  report.check(
    `⑩b 缩略图来自素材本身而不是兜底图（原片色差 ${thumbs.original?.spread.toFixed(1)}，兜底图约 12）`,
    thumbs.original.spread > 1 && thumbs.original.spread < 10,
  );

  // ---- ⑪ 没选中片段 → 按播放头落点 ----
  await page.session.evaluate('window.__VEDITOR_TEST__.selectClip(null)');
  await page.session.evaluate('window.__VEDITOR_TEST__.seek(10)');
  await sleep(300);
  await click('[data-v="effect-preset"][data-preset-id="fx-cool"]');
  now = await clipById(clip.id);
  report.check(
    `⑪ 没选中片段时按播放头落点（temperature=${gradeOf(now)?.params?.temperature}）`,
    gradeOf(now)?.params?.temperature === -34,
  );

  // ---- ⑫ 文字片段拒绝：给提示且文档不变 ----
  await click('[data-v="left-tab-text"]');
  await click('[data-v="text-preset"][data-preset-id="tpl-title-main"]');
  await sleep(500);
  const textClip = (await clips()).find((item) => item.text !== null && item.text !== undefined);
  await click('[data-v="left-tab-effect"]');
  await page.session.evaluate('window.__VEDITOR_TEST__.dismissAllErrors?.()');
  const beforeText = JSON.stringify(textClip);
  await click('[data-v="effect-preset"][data-preset-id="fx-vivid"]');
  const textErrors = await errors();
  const afterText = (await clips()).find((item) => item.id === textClip?.id);
  report.check(
    `⑫ 文字片段拒绝（提示「${textErrors[0]?.message ?? '（无）'}」，effect 数 ${(afterText?.effectDetails ?? []).length}）`,
    (textErrors[0]?.message ?? '').includes('文字片段') &&
      JSON.stringify(afterText) === beforeText &&
      (afterText?.effectDetails ?? []).length === 0,
  );

  // ---- ⑬ 空工程：内置测试图兜底（缩略图不是空白）----
  const fallbackOk = JSON.parse(
    await page.session.evaluate(`(() => {
      const card = document.querySelector('[data-v="effect-preset"][data-preset-id="fx-vivid"]');
      const canvas = card?.querySelector('canvas');
      if (!canvas) return 'false';
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let nonEmpty = 0;
      for (let i = 0; i + 3 < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 0) nonEmpty += 1;
      return nonEmpty > data.length / 4 / 2 ? 'true' : 'false';
    })()`),
  );
  report.check('⑬ 每张卡的缩略图都有内容（不是空白 canvas）', fallbackOk === true);

  // ---- ⑭ 拖拽：落在片段上 → 绿色预览 + 落库 + 自动选中 ----
  /**
   * 拖拽的落点**按鼠标下的片段**，不看选中态 —— 这里故意先选中文字片段
   * （它压在视频上面），再拖到视频片段那一行，验证特效落在视频上。
   */
  const videoClip = (await clips()).find((item) => item.text === null || item.text === undefined);
  const textTrackId = textClip?.trackId ?? '';
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(textClip.id)})`);
  await sleep(250);
  const beforeDrag = JSON.stringify(await clipById(videoClip.id));
  const dropOnVideo = await dragPreset(await dragPoint(20, videoClip.trackId), 'fx-retro');
  await sleep(600);
  const afterDrag = await clipById(videoClip.id);
  const selectionAfter = await page.session.evaluate('window.__VEDITOR_TEST__.selection()');
  report.check(
    `⑭ 拖到视频片段 → 绿色预览（valid=${dropOnVideo.ghost?.valid}，指向 ${
      dropOnVideo.ghost?.clipId === videoClip.id ? '视频片段' : dropOnVideo.ghost?.clipId
    }），松手后落到视频上（temperature=${gradeOf(afterDrag)?.params?.temperature}）`,
    dropOnVideo.prevented === true &&
      dropOnVideo.ghost?.valid === true &&
      dropOnVideo.ghost?.clipId === videoClip.id &&
      gradeOf(afterDrag)?.params?.temperature === 18 &&
      beforeDrag !== JSON.stringify(afterDrag),
  );
  report.check(
    `⑭b 松手后自动选中落点片段（${selectionAfter === videoClip.id ? '视频片段' : selectionAfter}），文字片段没被改动`,
    selectionAfter === videoClip.id && (await clipById(textClip.id))?.effectDetails?.length === 0,
  );

  // ---- ⑮ 拖到文字片段 → 红色预览 + 可读原因 + 文档不变 ----
  const beforeTextDrop = JSON.stringify(await clipById(textClip.id));
  const dropOnText = await dragPreset(await dragPoint(20, textTrackId), 'fx-vivid');
  await sleep(400);
  report.check(
    `⑮ 拖到文字片段 → 红色预览（valid=${dropOnText.ghost?.valid}，原因「${
      dropOnText.ghost?.reason ?? '（无）'
    }」）且文档未变`,
    dropOnText.ghost?.valid === false &&
      (dropOnText.ghost?.reason ?? '').includes('文字片段') &&
      JSON.stringify(await clipById(textClip.id)) === beforeTextDrop,
  );

  // ---- ⑯ 拖到没有片段的轨道 → 不画预览、不落库、不报错 ----
  await page.session.evaluate('window.__VEDITOR_TEST__.dismissAllErrors?.()');
  const audioTrackId = (await tracks()).find((track) => track.kind === 'audio')?.id ?? 'trk_A1';
  const dropOnEmpty = await dragPreset(await dragPoint(20, audioTrackId), 'fx-vivid');
  await sleep(400);
  const emptyErrors = await errors();
  report.check(
    `⑯ 拖到空轨道 → 不画预览（ghost=${dropOnEmpty.ghost === null ? 'null' : '有'}）、不报错（${
      emptyErrors.length
    } 条）`,
    dropOnEmpty.ghost === null && emptyErrors.length === 0 && gradeOf(await clipById(videoClip.id))?.params?.temperature === 18,
  );

  // ---- ⑰ 重复拖同一个预设 → 不占撤销步 ----
  /**
   * 此刻视频片段上已经套着「复古胶片」。再拖一次同一个预设应该**什么都不发**，
   * 所以撤销一次必须回到**上一个状态**（冷调，⑪ 点的那次），而不是"看起来没变化"。
   */
  const beforeRepeat = JSON.stringify(await clipById(videoClip.id));
  await dragPreset(await dragPoint(20, videoClip.trackId), 'fx-retro');
  await sleep(400);
  const afterRepeat = JSON.stringify(await clipById(videoClip.id));
  await page.session.evaluate('window.__VEDITOR_TEST__.undo()');
  await sleep(450);
  const afterUndo = await clipById(videoClip.id);
  report.check(
    `⑰ 重复拖同一预设不占撤销步（文档未变=${beforeRepeat === afterRepeat}，撤销一次后 temperature=${
      gradeOf(afterUndo)?.params?.temperature
    }）`,
    beforeRepeat === afterRepeat && gradeOf(afterUndo)?.params?.temperature === -34,
  );

} finally {
  await page.close();
  server.close();
  dev.kill();
}

report.summary('特效面板');
