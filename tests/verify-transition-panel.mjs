/**
 * 左栏「转场」面板 E2E（第一步：点击应用 + 时长档位 + 状态提示）。
 *
 * ## 这个文件在防什么
 *
 * 1. **三种转场落在不同侧**：叠化/淡入 → 入点，淡出 → 出点。写错一侧不会报错，
 *    只会"点了没反应"（因为渲染层只认那几种组合）。
 * 2. **两侧互斥**：设一侧必须清另一侧。两侧都在时渲染层取 `min(opacity)`，
 *    表现是"转场看起来很弱"，肉眼很难归因。
 * 3. **叠化需要左邻**：没有左邻时不能静默落库，必须给可读提示且**文档不变**。
 * 4. **时长夹取**：0.5s 在 23.976fps 下是 12 帧，1.0s 会被片段一半（15 帧）夹住 ——
 *    只断言"有值"是测不出夹取的。
 * 5. **真的在画**：淡入到一半时画面必须比之后暗（读画面像素，不只看 doc 字段）。
 *
 * ## 坐标约定
 *
 * `getBoundingClientRect()` 与 `uiLayout()` 都是 CSS 像素；`previewSnapshot` 的区域
 * 是 0..1 的归一化坐标。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5261;
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
const snapshot = async (region) =>
  JSON.parse(
    await page.session.evaluate(
      `(async () => JSON.stringify(await window.__VEDITOR_TEST__.previewSnapshot(${JSON.stringify(region)})))()`,
    ),
  );
const clipById = async (id) => (await clips()).find((clip) => clip.id === id);
/** 钩子里的转场快照（transitionDetails 才带 type/durationFrames）。 */
const trs = (clip) => clip?.transitionDetails ?? { in: null, out: null };

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 20000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 30000);
  await sleep(1800);
  const meta = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.projectMeta())'));
  /** 秒 → 帧（与 `core/timebase.secondsToFrames` 同口径：四舍五入）。 */
  const framesOf = (seconds) => Math.round((seconds * meta.fpsMilli) / 1000);

  // ---- ① 面板：3 张卡片 + 时长档位 + 默认高亮 ----
  await click('[data-v="left-tab-transition"]');
  const cards = JSON.parse(
    await page.session.evaluate(`(() => {
      const nodes = [...document.querySelectorAll('[data-v="transition-preset"]')];
      return JSON.stringify(nodes.filter((el) => el.getBoundingClientRect().height > 0).map((el) => ({
        id: el.getAttribute('data-preset-id'),
        name: el.querySelector('.v-trscard__name')?.textContent ?? '',
        active: el.getAttribute('data-active') === 'true',
      })));
    })()`),
  );
  report.check(
    `① 转场 Tab 显示 3 个预设（${cards.map((c) => c.name).join(' / ')}）`,
    cards.length === 3 && cards.map((c) => c.name).join('/') === '叠化/淡入/淡出',
  );
  const durationActive = await page.session.evaluate(
    `document.querySelector('[data-v="transition-duration-0.5"]').getAttribute('data-active')`,
  );
  const removeDisabled = await page.session.evaluate(
    `document.querySelector('[data-v="transition-remove"]').disabled`,
  );
  report.check(
    `①b 默认时长 0.5s 高亮（${durationActive}）、没有转场时「移除」禁用（${removeDisabled}）`,
    durationActive === 'true' && removeDisabled === true,
  );

  // ---- 准备：把唯一片段从中间切开，得到两个**严格紧邻**的片段 ----
  const whole = (await clips())[0];
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(whole.id)})`);
  await page.session.evaluate('window.__VEDITOR_TEST__.seek(60)');
  await sleep(200);
  await click('[data-v="split"]');
  await sleep(500);
  const parts = (await clips()).sort((a, b) => a.startFrame - b.startFrame);
  report.check(
    `② 切成两段且严格紧邻（${parts.map((c) => `${c.startFrame}..${c.startFrame + c.durationFrames}`).join(' / ')}）`,
    parts.length === 2 && parts[0].startFrame + parts[0].durationFrames === parts[1].startFrame,
  );
  const [left, right] = parts;

  // ---- ③ 选中右段 → 淡出写 out 侧 ----
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(right.id)})`);
  await sleep(200);
  await click('[data-v="transition-preset"][data-preset-id="trs-fade-out"]');
  let now = await clipById(right.id);
  report.check(
    `③ 点「淡出」→ out 侧是 fadeOut、${framesOf(0.5)} 帧（实测 ${trs(now).out?.durationFrames}）`,
    trs(now).out?.type === 'fadeOut' && trs(now).out?.durationFrames === framesOf(0.5),
  );
  report.check('③b 同一时刻 in 侧为空（没有两条斜坡）', trs(now).in === null);

  // ---- ④ 再点「淡入」→ 两侧互斥，out 被清掉 ----
  await click('[data-v="transition-preset"][data-preset-id="trs-fade-in"]');
  now = await clipById(right.id);
  report.check(
    `④ 点「淡入」→ in 有值、out 被清空（in=${trs(now).in?.type} out=${trs(now).out}）`,
    trs(now).in?.type === 'fadeIn' && trs(now).out === null,
  );

  // ---- ⑤ 叠化：右段有左邻 → 成功 ----
  await click('[data-v="transition-preset"][data-preset-id="trs-dissolve"]');
  now = await clipById(right.id);
  const dissolveActive = await page.session.evaluate(
    `document.querySelector('[data-v="transition-preset"][data-preset-id="trs-dissolve"]').getAttribute('data-active')`,
  );
  report.check(
    `⑤ 点「叠化」→ in 侧 crossDissolve（${trs(now).in?.type}），卡片高亮 ${dissolveActive}`,
    trs(now).in?.type === 'crossDissolve' && dissolveActive === 'true',
  );

  // ---- ⑥ 叠化：左段没有左邻 → 可读提示且文档不变 ----
  const beforeBad = JSON.stringify(await clipById(left.id));
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(left.id)})`);
  await sleep(200);
  await page.session.evaluate('window.__VEDITOR_TEST__.dismissAllErrors?.()');
  await click('[data-v="transition-preset"][data-preset-id="trs-dissolve"]');
  const badErrors = await errors();
  const afterBad = JSON.stringify(await clipById(left.id));
  report.check(
    `⑥ 左段没有左邻 → 提示「${badErrors[0]?.message ?? '（无）'}」且文档未变`,
    beforeBad === afterBad && (badErrors[0]?.message ?? '').includes('左侧'),
  );

  // ---- ⑦ 时长档位：1.0s 在长片段上按真实秒数换算 ----
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(right.id)})`);
  await sleep(200);
  await click('[data-v="transition-duration-1"]');
  await click('[data-v="transition-preset"][data-preset-id="trs-fade-in"]');
  now = await clipById(right.id);
  const cap = Math.max(1, Math.floor(right.durationFrames / 2));
  report.check(
    `⑦ 1.0s 在 ${right.durationFrames} 帧的片段上是 ${framesOf(1)} 帧（上限 ${cap}，未触发夹取）`,
    trs(now).in?.durationFrames === framesOf(1) && framesOf(1) < cap,
  );

  // ---- ⑧ 一次操作 = 一步撤销（回到 0.5s 的叠化）----
  await page.session.evaluate('window.__VEDITOR_TEST__.undo()');
  await sleep(450);
  now = await clipById(right.id);
  report.check(
    `⑧ 一次撤销回到上一步（${trs(now).in?.type} / ${trs(now).in?.durationFrames} 帧）`,
    trs(now).in?.type === 'crossDissolve' && trs(now).in?.durationFrames === framesOf(0.5),
  );

  // ---- ⑨ 像素：淡入真的在画（0.5s 转场在接缝处让画面变暗）----
  /**
   * 把 1.0s 淡入设到**左段**（它从 0 开始，窗口 [-15,15)），
   * 第 0 帧的不透明度只有约一半 → 画面必须比第 40 帧暗。
   * 只断言 `transitionIn` 字段是测不出"到底画没画"的。
   */
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(left.id)})`);
  await sleep(200);
  await click('[data-v="transition-duration-1"]');
  await click('[data-v="transition-preset"][data-preset-id="trs-fade-in"]');
  await page.session.evaluate('window.__VEDITOR_TEST__.seek(0)');
  await sleep(700);
  const atStart = await snapshot();
  await page.session.evaluate('window.__VEDITOR_TEST__.seek(40)');
  await sleep(700);
  const atMiddle = await snapshot();
  report.check(
    `⑨ 淡入真的让开头变暗（第 0 帧 ${atStart.meanLuma.toFixed(1)} < 第 40 帧 ${atMiddle.meanLuma.toFixed(1)}）`,
    atMiddle.meanLuma > 5 &&
      atStart.meanLuma < atMiddle.meanLuma * 0.75 &&
      atStart.meanLuma > atMiddle.meanLuma * 0.2,
  );

  // ---- ⑩ 移除：两侧都清空、按钮回到禁用 ----
  await click('[data-v="transition-remove"]');
  now = await clipById(left.id);
  const removeDisabledAfter = await page.session.evaluate(
    `document.querySelector('[data-v="transition-remove"]').disabled`,
  );
  report.check(
    `⑩ 移除后两侧都为空（in=${trs(now).in} out=${trs(now).out}），按钮禁用=${removeDisabledAfter}`,
    trs(now).in === null && trs(now).out === null && removeDisabledAfter === true,
  );

  // ---- ⑪ 没选中片段时：作用到播放头所在的片段 ----
  await page.session.evaluate('window.__VEDITOR_TEST__.selectClip(null)');
  await page.session.evaluate('window.__VEDITOR_TEST__.seek(30)');
  await sleep(200);
  await click('[data-v="transition-duration-0.3"]');
  await click('[data-v="transition-preset"][data-preset-id="trs-fade-out"]');
  const leftAfter = await clipById(left.id);
  report.check(
    `⑪ 没选中片段时按播放头落点（左段 out=${trs(leftAfter).out?.type}，${trs(leftAfter).out?.durationFrames} 帧）`,
    trs(leftAfter).out?.type === 'fadeOut' && trs(leftAfter).out?.durationFrames === framesOf(0.3),
  );

  // ---- ⑫ 短片段上 1.0s 被夹到一半（上限 = floor(片段/2)）----
  /**
   * 上一条 ⑦ 只验了"秒→帧换算"，夹取要在**短片段**上才看得到。
   * 这里把左段再切一刀（0..60 → 0..20 / 20..60），20 帧的片段上限只有 10 帧。
   */
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(left.id)})`);
  await page.session.evaluate('window.__VEDITOR_TEST__.seek(20)');
  await sleep(200);
  await click('[data-v="split"]');
  await sleep(500);
  const pieces = (await clips()).sort((a, b) => a.startFrame - b.startFrame);
  const short = pieces.find((clip) => clip.startFrame === 0);
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(short?.id)})`);
  await sleep(200);
  await click('[data-v="transition-duration-1"]');
  await click('[data-v="transition-preset"][data-preset-id="trs-fade-in"]');
  const shortAfter = await clipById(short?.id);
  const shortCap = Math.max(1, Math.floor((short?.durationFrames ?? 1) / 2));
  report.check(
    `⑫ 短片段 ${short?.durationFrames} 帧上 1.0s 被夹到 ${shortCap} 帧（实测 ${trs(shortAfter).in?.durationFrames}）`,
    trs(shortAfter).in?.durationFrames === shortCap && shortCap < framesOf(1),
  );

  // ---- ⑬ 拖「叠化」到接缝附近（偏左 4px）→ 吸附到接缝、落到右侧片段 ----
  /**
   * 模拟完整拖拽：卡片 dragstart → 画布 dragover（读 ghost）→ drop。
   * 落点故意放在接缝**左边 4px**：不吸附的话 `clipAtFrame` 会命中左边那段，
   * 而左段没有左邻 → 叠化会被判不可用。吸附正确才能落到右段。
   */
  const dragPoint = async (frame, dxPx = 0, trackId = 'trk_V1') =>
    JSON.parse(
      await page.session.evaluate(`(() => {
        const canvas = document.querySelector('[data-v="timeline-canvas"]');
        const layout = window.__VEDITOR_TEST__.timelineLayout();
        const row = layout.rows.find((item) => item.trackId === '${trackId}');
        const zoom = window.__VEDITOR_TEST__.zoomLevel();
        const scrollX = Number(canvas.dataset['scrollX'] ?? '0');
        const rect = canvas.getBoundingClientRect();
        return JSON.stringify({
          x: rect.left + layout.headerWidth + ${frame} * zoom - scrollX + ${dxPx},
          y: rect.top + row.top + row.height / 2,
        });
      })()`),
    );
  const dragTransition = async (point, presetId) =>
    JSON.parse(
      await page.session.evaluate(`(() => {
        const canvas = document.querySelector('[data-v="timeline-canvas"]');
        const card = document.querySelector('[data-v="transition-preset"][data-preset-id="${presetId}"]');
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
        const ghost = window.__VEDITOR_TEST__.transitionGhost();
        make('drop', canvas);
        return JSON.stringify({ prevented: over.defaultPrevented, ghost });
      })()`),
    );

  const seamClip = (await clips()).find((clip) => clip.startFrame === 20);
  const beforeDragTrs = JSON.stringify(await clipById(seamClip.id));
  const dragResult = await dragTransition(await dragPoint(20, -4), 'trs-dissolve');
  await sleep(500);
  const afterDragTrs = await clipById(seamClip.id);
  report.check(
    `⑬ 拖到接缝左 4px → 吸附并落到右段（in=${trs(afterDragTrs).in?.type}，ghost valid=${dragResult.ghost?.valid}）`,
    dragResult.prevented === true &&
      dragResult.ghost?.clipId === seamClip.id &&
      dragResult.ghost?.valid === true &&
      trs(afterDragTrs).in?.type === 'crossDissolve',
  );
  report.check(
    `⑬b 落点预览的形状与真实角标一致（side=${dragResult.ghost?.side}，宽度 ${dragResult.ghost?.durationFrames} 帧）`,
    dragResult.ghost?.side === 'in' && Number(dragResult.ghost?.durationFrames) > 0 && beforeDragTrs !== JSON.stringify(afterDragTrs),
  );

  // ---- ⑭ 拖到没有左邻的片段中部 → 红色预览 + 可读原因 + 文档不变 ----
  const loneClip = (await clips()).find((clip) => clip.startFrame === 0);
  const beforeInvalid = JSON.stringify(await clipById(loneClip.id));
  const invalidResult = await dragTransition(await dragPoint(10), 'trs-dissolve');
  await sleep(400);
  const afterInvalid = JSON.stringify(await clipById(loneClip.id));
  report.check(
    `⑭ 无左邻时预览变红（valid=${invalidResult.ghost?.valid}，原因「${invalidResult.ghost?.reason ?? '（无）'}」）且文档未变`,
    invalidResult.ghost?.valid === false &&
      String(invalidResult.ghost?.reason ?? '').includes('左侧') &&
      beforeInvalid === afterInvalid,
  );

  // ---- ⑮ 拖到空白区 → 不画预览、不落库、不报错 ----
  const emptyResult = await dragTransition(await dragPoint(400), 'trs-fade-in');
  await sleep(300);
  const afterEmpty = await clips();
  report.check(
    `⑮ 拖到空白区什么都不发生（ghost=${emptyResult.ghost === null ? 'null' : '有值'}，片段数 ${afterEmpty.length}）`,
    emptyResult.ghost === null && afterEmpty.length === 3,
  );

  // ---- ⑯ 时间线角标宽度按真实时长变化（读画布像素）----
  /**
   * 直接量"紫色楔形占了多宽"：楔形从片段左端向右铺开，宽度 = D/2 × zoom。
   * 只断言 `durationFrames` 是测不出"画得对不对"的 —— 之前那个固定 12px 的版本
   * 数据完全正确、视觉上毫无区别。
   */
  /**
   * 把片段左端那一行像素的**亮度**取回来（160 个采样点）。
   *
   * 为什么不用"数紫色像素"：视频片段本身底色就是淡紫 `--v-clip: #d9d7f0`，
   * 楔形只是同色系加深 —— 按颜色筛会把整块片段都算进去（实测两档都是满格 159px）。
   * 改成"两次渲染逐点做差、看差异延伸到多远"，就与底色无关了。
   */
  const captureRow = async (clipId) =>
    JSON.parse(
      await page.session.evaluate(`(() => {
        const canvas = document.querySelector('[data-v="timeline-canvas"]');
        const layout = window.__VEDITOR_TEST__.timelineLayout();
        const clip = window.__VEDITOR_TEST__.clips().find((item) => item.id === ${JSON.stringify(clipId)});
        if (!clip) return JSON.stringify([]);
        const row = layout.rows.find((item) => item.trackId === clip.trackId);
        const zoom = window.__VEDITOR_TEST__.zoomLevel();
        const rect = canvas.getBoundingClientRect();
        const scale = canvas.width / Math.max(1, rect.width);
        const scrollX = Number(canvas.dataset['scrollX'] ?? '0');
        const startX = Math.round((layout.headerWidth + clip.startFrame * zoom - scrollX) * scale);
        const y = Math.round((row.top + 4) * scale);
        const width = Math.round(160 * scale);
        const ctx = canvas.getContext('2d');
        const data = ctx.getImageData(Math.max(0, startX), y, width, 1).data;
        const out = [];
        for (let i = 0; i + 3 < data.length; i += 4) {
          out.push(Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]));
        }
        return JSON.stringify(out);
      })()`),
    );
  /** 两次渲染的差异延伸到第几个采样点（= 角标宽度差了多少 px）。 */
  const diffExtent = (left, right) => {
    let furthest = 0;
    for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
      if (Math.abs(left[i] - right[i]) > 2) furthest = i;
    }
    return furthest;
  };

  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(seamClip.id)})`);
  await sleep(200);
  await click('[data-v="transition-duration-0.3"]');
  await click('[data-v="transition-preset"][data-preset-id="trs-fade-in"]');
  await page.session.evaluate('window.__VEDITOR_TEST__.selectClip(null)');
  await sleep(500);
  const rowNarrow = await captureRow(seamClip.id);

  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(seamClip.id)})`);
  await sleep(200);
  await click('[data-v="transition-duration-1"]');
  await click('[data-v="transition-preset"][data-preset-id="trs-fade-in"]');
  await page.session.evaluate('window.__VEDITOR_TEST__.selectClip(null)');
  await sleep(500);
  const rowWide = await captureRow(seamClip.id);
  const wideClip = await clipById(seamClip.id);
  const extent = diffExtent(rowNarrow, rowWide);
  report.check(
    `⑯ 角标宽度按时长变化（0.3s → 1.0s 的差异延伸到 ${extent}px，转场 ${trs(wideClip).in?.durationFrames} 帧）`,
    extent >= 8 && extent <= 120,
  );
} finally {
  report.summary('转场面板：3 种转场 / 时长档位 / 两侧互斥 / 左邻判定 / 像素验证');
  await page.close();
  dev.kill();
  server.close();
}
