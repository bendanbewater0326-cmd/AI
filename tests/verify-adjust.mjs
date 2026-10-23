/**
 * 左栏「调节」面板 E2E（S2：基础调色 + 曲线接线）。
 *
 * ## 这个文件在防什么
 *
 * 1. **面板真接上了**：`adjust` Tab 不再是 `TabPlaceholder`（有 `adjust-panel` 且在采光区里）；
 * 2. **默认展开态**：基础调色展开、曲线/LUT/蒙版折叠（用户明确指定）；
 * 3. **滑块真的改到 doc**：拖到 -60 → `params.brightness === -60`（不是"拖了但没生效"）；
 * 4. **画面真的变了**：亮度 -60 → `meanLuma` 显著下降（只断言 doc 字段测不出渲染链断了）；
 * 5. **一次拖动 = 一个撤销步**：撤销一次就回到 0（不是撤销 40 次）；
 * 6. **数值输入可用**：输 40 + Enter → `brightness === 40`（"双操作"的右半边）；
 * 7. **双向同步**（两个方向都测）：
 *    - 左栏改 → 右栏属性栏滑块跟着变；
 *    - 右栏改 → 左栏滑块跟着变。
 *    这条最容易假绿：只测一边、另一处仍是 `useEffect(..., [])` 只读一次。
 * 8. **重置**：点「重置」→ effect 被删掉（不是写四个 0 的僵尸效果）。
 *
 * 运行：`node tests/verify-adjust.mjs`
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5270;
const FIXTURE = 'sample-720p.mp4';
/** 提亮 LUT（2×2×2，验证"载入 / 强度 / 移除"链路足够）。由 verify-lut.mjs 生成并复用。 */
const CUBE = path.join(ROOT, 'tests', '.tmp', 'brighten.cube');
const SHOTS = path.join(ROOT, 'tests', 'screenshots');
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
await new Promise((resolve) => {
  dev.stdout.on('data', (chunk) => {
    if (String(chunk).includes(`127.0.0.1:${PORT}`)) resolve();
  });
});

const report = createReport();
const page = await launchPage({
  url: `http://127.0.0.1:${PORT}/?src=${encodeURIComponent(`${origin}/${FIXTURE}`)}`,
  width: 1600,
  height: 900,
});

/** 在页面里改一个 `<input type=range>`：模拟拖动（input 事件）+ 松手（pointerup）。 */
async function dragRange(selector, value) {
  await page.session.evaluate(`(() => {
    const el = document.querySelector('${selector}');
    if (el === null) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '${value}');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    return true;
  })()`);
  await sleep(350);
}

/** 在页面里给一个 `<input type=number>` 输入并回车提交。 */
async function typeNumber(selector, text) {
  await page.session.evaluate(`(() => {
    const el = document.querySelector('${selector}');
    if (el === null) return false;
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '${text}');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    el.blur();
    return true;
  })()`);
  await sleep(350);
}

/**
 * 读调色参数。
 *
 * **必须用 `effectDetails`**：`clips()[].effects` 只有类型字符串（`['colorGrade']`），
 * 断言不了"亮度是不是 -60"。`effectDetails` 才带 `params`。
 */
const readGrade = () =>
  page.session.evaluate(`(() => {
    const clip = window.__VEDITOR_TEST__.clips()[0];
    const fx = (clip?.effectDetails ?? []).find((e) => e.type === 'colorGrade');
    return fx === undefined ? null : fx.params;
  })()`);

const readSnapshot = async () => await page.session.evaluate('window.__VEDITOR_TEST__.previewSnapshot()');

/** 截一张整页图（左栏面板 + 预览 + 时间线都在里面，能看出"具体做成什么样"）。 */
async function screenshot(name) {
  const shot = await page.session.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, name);
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log(`  · 截图：tests/screenshots/${name}`);
  return file;
}

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length === 1', 15000);

  // 选中片段（保证目标明确；面板也支持"不选中按播放头"，但这里先走确定路径）
  const clipId = await page.session.evaluate('window.__VEDITOR_TEST__.clips()[0].id');
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip('${clipId}')`);
  await sleep(300);

  // ---- ① 切到「调节」Tab，面板真接上了 ----
  await page.session.evaluate(`document.querySelector('[data-v="left-tab-adjust"]').click()`);
  await sleep(400);
  const mounted = await page.session.evaluate(`(() => {
    const pane = document.querySelector('[data-v="adjust-panel"]');
    const slot = document.querySelector('[data-v="adjust-content-slot"]');
    const placeholder = document.querySelector('.v-tabpane > .v-placeholder, .v-tabpane__placeholder');
    return JSON.stringify({
      panel: pane !== null,
      slotVisible: slot !== null && !slot.hasAttribute('hidden'),
      hasPlaceholder: placeholder !== null,
    });
  })()`);
  const mountedInfo = JSON.parse(mounted);
  report.check(`① 调节面板已挂载且可见（${mounted}）`, mountedInfo.panel && mountedInfo.slotVisible && !mountedInfo.hasPlaceholder);

  // ---- ② 默认展开态 ----
  const openState = await page.session.evaluate(`JSON.stringify({
    grade: document.querySelector('[data-v="adjust-group-grade"]')?.getAttribute('data-open'),
    curve: document.querySelector('[data-v="adjust-group-curve"]')?.getAttribute('data-open'),
    lut: document.querySelector('[data-v="adjust-group-lut"]')?.getAttribute('data-open'),
    mask: document.querySelector('[data-v="adjust-group-mask"]')?.getAttribute('data-open'),
  })`);
  const open = JSON.parse(openState);
  report.check(
    `② 默认态：只有基础调色展开（${openState}）`,
    open.grade === 'true' && open.curve === 'false' && open.lut === 'false' && open.mask === 'false',
  );

  // ---- ③④ 拖亮度到 -60：doc 与画面都要变 ----
  const before = await readSnapshot();
  await dragRange('[data-v="adjust-brightness"]', '-60');
  const gradeAfter = await readGrade();
  const after = await readSnapshot();
  report.check(
    `③ 滑块写到 doc（brightness=${gradeAfter?.brightness}）`,
    gradeAfter !== null && gradeAfter.brightness === -60,
  );
  report.check(
    `④ 画面真的变暗（meanLuma ${Number(before?.meanLuma ?? 0).toFixed(1)} → ${Number(after?.meanLuma ?? 0).toFixed(1)}）`,
    Number(after?.meanLuma ?? 0) < Number(before?.meanLuma ?? 0) - 10,
  );

  // 截图：调色生效中的面板（4 行控件 + 亮度 -60 + 画面变暗）
  await screenshot('adjust-1-color.png');

  // ---- ⑤ 一次拖动 = 一个撤销步 ----
  await page.session.evaluate('window.__VEDITOR_TEST__.undo()');
  await sleep(300);
  const afterUndo = await readGrade();
  report.check(
    `⑤ 撤销一次即回到 0（brightness=${afterUndo === null ? 'null(effect已删)' : afterUndo.brightness}）`,
    afterUndo === null || afterUndo.brightness === 0,
  );

  // ---- ⑥ 数值输入（双操作的右半边） ----
  await typeNumber('[data-v="adjust-brightness-value"]', '40');
  const gradeTyped = await readGrade();
  report.check(
    `⑥ 数值输入生效（brightness=${gradeTyped?.brightness}）`,
    gradeTyped !== null && gradeTyped.brightness === 40,
  );

  // ---- ⑦a 左栏改 → 右栏跟着变 ----
  await dragRange('[data-v="adjust-saturation"]', '-80');
  const rightSat = await page.session.evaluate(`(() => {
    const el = document.querySelector('[data-v="inspector-saturation"]');
    return el === null ? 'missing' : el.value;
  })()`);
  report.check(`⑦a 左栏改饱和 → 右栏滑块同步（inspector=${rightSat}）`, String(rightSat) === '-80');

  // ---- ⑦b 右栏改 → 左栏跟着变 ----
  await dragRange('[data-v="inspector-contrast"]', '35');
  const leftContrast = await page.session.evaluate(`(() => {
    const el = document.querySelector('[data-v="adjust-contrast"]');
    return el === null ? 'missing' : el.value;
  })()`);
  report.check(`⑦b 右栏改对比 → 左栏滑块同步（adjust=${leftContrast}）`, String(leftContrast) === '35');

  // ---- ⑧ 重置 = 删 effect ----
  await page.session.evaluate(`document.querySelector('[data-v="adjust-grade-reset"]').click()`);
  await sleep(350);
  const afterReset = await readGrade();
  report.check(
    `⑧ 重置删掉 colorGrade（effects 中=${afterReset === null ? '无' : JSON.stringify(afterReset)}）`,
    afterReset === null,
  );

  // ================= S3：LUT =================
  // 载入入口在属性栏（用户决策 ④：左栏不放文件选择，避免与素材拖拽语义混淆）
  {
    // 动态分组改造后 LUT 组默认折叠：先展开（折叠交互本身由 verify-inspector-groups 专测）
    await page.session.evaluate(`document.querySelector('[data-v="inspector-section-lut-toggle"]')?.click()`);
    await sleep(200);
    const { root } = await page.session.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await page.session.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '[data-v="inspector-lut-file"]',
    });
    report.check('⑩a 属性栏仍有 LUT 文件入口（载入入口保留在原位）', nodeId !== 0);
    if (nodeId !== 0) {
      await page.session.send('DOM.setFileInputFiles', { nodeId, files: [CUBE] });
      await page.session.waitFor(`window.__VEDITOR_TEST__.clips()[0].effects.includes('lut')`, 10000);
      await sleep(900);

      // 展开 LUT 组看左栏显示
      await page.session.evaluate(`document.querySelector('[data-v="adjust-group-lut-toggle"]').click()`);
      await sleep(300);
      const lutUi = await page.session.evaluate(`JSON.stringify({
        title: document.querySelector('[data-v="adjust-lut-title"]')?.textContent ?? '',
        hasStrength: document.querySelector('[data-v="adjust-lut-strength"]') !== null,
      })`);
      const lutState = JSON.parse(lutUi);
      report.check(
        `⑩b 左栏显示"已载入" + 强度滑块（${lutUi}）`,
        lutState.hasStrength && lutState.title.includes('已载入'),
      );

      await dragRange('[data-v="adjust-lut-strength"]', '50');
      const strength = await page.session.evaluate(`(() => {
        const fx = (window.__VEDITOR_TEST__.clips()[0]?.effectDetails ?? []).find((e) => e.type === 'lut');
        return fx === undefined ? null : fx.params.strength;
      })()`);
      report.check(`⑩c 强度写进 doc（strength=${strength}，期望 0.5）`, strength === 0.5);

      await screenshot('adjust-2-lut.png');

      // 移除
      await page.session.evaluate(`document.querySelector('[data-v="adjust-lut-remove"]').click()`);
      await sleep(350);
      const hasLut = await page.session.evaluate(`window.__VEDITOR_TEST__.clips()[0].effects.includes('lut')`);
      report.check('⑩d 移除 LUT 生效（effects 里不再有 lut）', hasLut === false);
    }
  }

  // ================= S3：蒙版 =================
  {
    await page.session.evaluate(`document.querySelector('[data-v="adjust-group-mask-toggle"]').click()`);
    await sleep(300);
    // 添加
    await page.session.evaluate(`document.querySelector('[data-v="adjust-mask-add"]').click()`);
    await sleep(400);
    const created = await page.session.evaluate(`(() => {
      const fx = (window.__VEDITOR_TEST__.clips()[0]?.effectDetails ?? []).find((e) => e.type === 'mask');
      return fx === undefined ? null : JSON.stringify(fx.params);
    })()`);
    const maskParams = created === null ? null : JSON.parse(created);
    report.check(
      `⑪a 添加蒙版（shape=${maskParams?.shape} x=${maskParams?.x} invert=${maskParams?.invert}）`,
      maskParams !== null && maskParams.shape === 'rect' && maskParams.invert === 0,
    );

    // 形状改椭圆
    await page.session.evaluate(`(() => {
      const el = document.querySelector('[data-v="adjust-mask-shape"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(el, 'ellipse');
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(400);
    const shapeAfter = await page.session.evaluate(`(() => {
      const fx = (window.__VEDITOR_TEST__.clips()[0]?.effectDetails ?? []).find((e) => e.type === 'mask');
      return fx?.params.shape ?? null;
    })()`);
    report.check(`⑪b 形状改椭圆（shape=${shapeAfter}）`, shapeAfter === 'ellipse');

    // 调 x
    await dragRange('[data-v="adjust-mask-x"]', '30');
    const xAfter = await page.session.evaluate(`(() => {
      const fx = (window.__VEDITOR_TEST__.clips()[0]?.effectDetails ?? []).find((e) => e.type === 'mask');
      return fx?.params.x ?? null;
    })()`);
    report.check(`⑪c 蒙版 x 写进 doc（x=${xAfter}，期望 0.3）`, Math.abs(xAfter - 0.3) < 0.02);

    // 反转
    await page.session.evaluate(`document.querySelector('[data-v="adjust-mask-invert"]').click()`);
    await sleep(400);
    const invertAfter = await page.session.evaluate(`(() => {
      const fx = (window.__VEDITOR_TEST__.clips()[0]?.effectDetails ?? []).find((e) => e.type === 'mask');
      return fx?.params.invert ?? null;
    })()`);
    report.check(`⑪d 反转存成 1（不是 boolean，invert=${invertAfter}）`, invertAfter === 1);

    // 截图前滚到底：蒙版组在最下方，不滚看不到参数行
    await page.session.evaluate(`(() => {
      const panel = document.querySelector('[data-v="adjust-panel"]');
      if (panel) panel.scrollTop = panel.scrollHeight;
      return true;
    })()`);
    await sleep(300);
    await screenshot('adjust-3-mask.png');

    // 移除
    await page.session.evaluate(`document.querySelector('[data-v="adjust-mask-remove"]').click()`);
    await sleep(350);
    const hasMask = await page.session.evaluate(`window.__VEDITOR_TEST__.clips()[0].effects.includes('mask')`);
    report.check('⑪e 移除蒙版生效', hasMask === false);
  }

  // ================= S4：与特效面板联动 =================
  {
    // 切到特效 Tab，点「黑白」预设
    await page.session.evaluate(`document.querySelector('[data-v="left-tab-effect"]').click()`);
    await sleep(400);
    const applied = await page.session.evaluate(`(() => {
      // 卡片属性是 data-v="effect-preset" + data-preset-id（不是 effect-card / data-preset）
      const card = document.querySelector('[data-v="effect-preset"][data-preset-id="fx-darken"]')
        ?? document.querySelector('[data-v="effect-preset"]');
      if (card === null) return 'no-card';
      card.click();
      return 'clicked';
    })()`);
    await sleep(600);
    const appliedId = await page.session.evaluate(`(() => {
      const node = document.querySelector('[data-applied="true"]');
      return node === null ? '' : (node.getAttribute('data-preset-id') ?? 'unknown');
    })()`);

    // 切回调节，改一个参数 → 特效高亮应消失
    await page.session.evaluate(`document.querySelector('[data-v="left-tab-adjust"]').click()`);
    await sleep(400);
    await dragRange('[data-v="adjust-brightness"]', '15');
    const stillApplied = await page.session.evaluate(`(() => {
      const node = document.querySelector('[data-applied="true"]');
      return node === null ? '' : (node.getAttribute('data-preset-id') ?? 'unknown');
    })()`);
    report.check(
      `⑫ 改参数后特效高亮消失（点预设后=${appliedId || '无'}，改参数后=${stillApplied || '无'}）`,
      applied !== 'no-card' && appliedId !== '' && stillApplied === '',
    );
  }

  // ---- ⑨ 错误条为空（全程不应有错误） ----
  const errors = await page.session.evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll('[data-v="errorbar"]'));
    return JSON.stringify(nodes.map((node) => (node.textContent ?? '').trim()).filter((text) => text !== ''));
  })()`);
  report.check(`⑨ 全程无错误条（${errors}）`, errors === '[]');

  await page.session.send('Page.captureScreenshot', { format: 'png' }).then((shot) => {
    fs.mkdirSync(path.join(ROOT, 'tests', 'screenshots'), { recursive: true });
    fs.writeFileSync(
      path.join(ROOT, 'tests', 'screenshots', 'adjust-panel.png'),
      Buffer.from(shot.data, 'base64'),
    );
  });
} finally {
  await page.close();
  dev.kill();
  await new Promise((resolve) => server.close(resolve));
}

report.summary('左栏「调节」面板');