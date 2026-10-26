/**
 * 新手引导（G1–G3）的 E2E 验收。
 *
 * ## 这个文件在防什么
 *
 * 1. **穿透**——引导是"边看边试"的，目标必须**真的能点**。
 *    这条最容易在"顺手把外层容器改成 pointer-events:auto"时被破坏：
 *    一个 `inset:0 + pointer-events:auto` 的透明板会吃掉整屏点击（命中测试只看几何、
 *    不看背景透明度），底下的「导入」按钮、时间轴全部点不动。
 *    所以断言必须落到 `elementFromPoint(目标中心)` **不在** `.v-onboarding` 子树内。
 * 2. **不重复打扰**——每次刷新都弹等于骚扰。done / skipped 之后不能再自动弹。
 * 3. **手动入口不看标记**——主动点「重新查看新手引导」就该能看，与"看过"无关。
 * 4. **容错**——目标被藏起来（切到别的 Tab 让素材栏 hidden）时要**跳过该步**，
 *    而不是画一个 0×0 的洞指空气。
 * 5. **AI 可用性决定步数**——默认 6 步（离线规则引擎也算可用，与顶栏按钮同源），
 *    `?ai=off` 时 5 步且最后一步是导出。
 *
 * ## 必须显式 `onboarding: 'on'`
 *
 * `launchPage` 现在**默认追加 `onboarding=off`**（避免 75 个既有脚本被引导挡住），
 * 所以本文件每一处 `launchPage` 都要显式打开。
 *
 * ## 坐标约定
 *
 * `getBoundingClientRect()` 是 CSS 像素，不乘除 DPR；对齐容差 2px（亚像素取整）。
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5310;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const base = `http://127.0.0.1:${PORT}/`;
// ?ai=off：没有 AI 通道，用来验"AI 不可用时不讲 AI"（5 步）
const page = await launchPage({ url: `${base}?ai=off`, width: 1440, height: 900, onboarding: 'on' });
const report = createReport();

const ev = (code) => page.session.evaluate(code);
const guideOpen = async () => (await ev(`document.querySelector('[data-v="onboarding"]') !== null`)) === true;
const flag = async () => (await ev(`localStorage.getItem('veditor:onboarding')`)) ?? null;
const near = (a, b, tolerance = 2) => Math.abs(a - b) <= tolerance;

const box = async (selector) =>
  JSON.parse(
    await ev(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'null'; const r = el.getBoundingClientRect(); return JSON.stringify({ left: r.left, top: r.top, w: r.width, h: r.height }); })()`,
    ),
  );

const stepInfo = async () =>
  JSON.parse(
    await ev(`(() => {
      const step = document.querySelector('[data-v="onboarding-step"]');
      const title = document.querySelector('[data-v="onboarding-title"]');
      const body = document.querySelector('[data-v="onboarding-body"]');
      const next = document.querySelector('[data-v="onboarding-next"]');
      const prev = document.querySelector('[data-v="onboarding-prev"]');
      return JSON.stringify({
        step: step ? step.textContent.trim() : null,
        title: title ? title.textContent.trim() : null,
        body: body ? body.textContent.trim() : null,
        next: next ? next.textContent.trim() : null,
        hasPrev: prev !== null,
      });
    })()`),
  );

const click = async (selector) => {
  const exists = await ev(`document.querySelector(${JSON.stringify(selector)}) !== null`);
  if (exists !== true) throw new Error(`找不到元素：${selector}`);
  await ev(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await sleep(180);
};

const waitReady = async () => {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 20000);
};

/** 刷新并等编辑器就绪（不清 localStorage，标记由用例自己摆）。 */
const reload = async () => {
  await ev('location.reload()');
  await sleep(2600);
  await waitReady();
};

/** 清标记 + 刷新（冷启动，引导会自己弹）。 */
const coldStart = async () => {
  await ev(`localStorage.removeItem('veditor:onboarding')`);
  await reload();
  await sleep(900);
};

/** 在设置面板里手动唤起（不看标记）。 */
const replayFromSettings = async () => {
  await click('[data-v="left-tab-settings"]');
  await click('[data-v="settings-group-about-toggle"]');
  await click('[data-v="settings-replay-onboarding"]');
  await sleep(400);
};

/** 键盘：真的走 window keydown（与用户按键同一条路径）。 */
const key = async (name) => {
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true }))`);
  await sleep(250);
};

try {
  await waitReady();

  /* ================= ① 首次自动触发 ================= */

  await ev(`localStorage.removeItem('veditor:onboarding')`);
  await ev('location.reload()');
  let sawReadyNoGuide = false;
  let sawGuide = false;
  let samples = 0;
  const started = Date.now();
  while (Date.now() - started < 8000 && !sawGuide) {
    try {
      const state = JSON.parse(
        await ev(`JSON.stringify({ ready: !!window.__VEDITOR_TEST__, onb: !!document.querySelector('[data-v="onboarding"]') })`),
      );
      samples += 1;
      if (state.ready && !state.onb) sawReadyNoGuide = true;
      if (state.ready && state.onb) sawGuide = true;
    } catch {
      // reload 期间执行上下文会被销毁，属正常
    }
    await sleep(15);
  }
  report.check(
    `① 清标记后：先就绪、约 300ms 后再弹（${samples} 次采样，「就绪未弹」出现过=${sawReadyNoGuide}）`,
    sawGuide === true && sawReadyNoGuide === true,
  );

  /* ================= ② 定位：spotlight = 目标矩形（左上 + 右下） ================= */

  const target1 = await box('[data-v="left-tab-media"]');
  const spot1 = await box('[data-v="onboarding-spotlight"]');
  report.check(
    `② spotlight 左上角贴目标（${Math.round(spot1?.left)},${Math.round(spot1?.top)} vs ${Math.round(target1?.left)},${Math.round(target1?.top)}）`,
    spot1 !== null && target1 !== null && near(spot1.left, target1.left) && near(spot1.top, target1.top),
  );
  report.check(
    `②b spotlight 右下角贴目标（${Math.round(spot1?.w)}×${Math.round(spot1?.h)} vs ${Math.round(target1?.w)}×${Math.round(target1?.h)}）`,
    spot1 !== null && target1 !== null && near(spot1.w, target1.w) && near(spot1.h, target1.h),
  );

  /* ================= ③ 穿透（核心） ================= */

  const hit = JSON.parse(
    await ev(`(() => {
      const el = document.querySelector('[data-v="left-tab-media"]');
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return JSON.stringify({
        tag: top ? top.tagName : 'null',
        isInsideTarget: top !== null && el.contains(top),
        isInsideOverlay: top !== null && top.closest('[data-v="onboarding"]') !== null,
      });
    })()`),
  );
  report.check(
    `③ 洞里的命中测试落在真实按钮上、不在蒙层里（tag=${hit.tag}，落进蒙层=${hit.isInsideOverlay}）`,
    hit.isInsideTarget === true && hit.isInsideOverlay === false,
  );

  const layers = JSON.parse(
    await ev(`(() => {
      const read = (selector) => getComputedStyle(document.querySelector(selector)).pointerEvents;
      return JSON.stringify({
        root: read('[data-v="onboarding"]'),
        spot: read('[data-v="onboarding-spotlight"]'),
        tip: read('[data-v="onboarding-tip"]'),
      });
    })()`),
  );
  report.check(
    `③b 指针层 none / none / auto（实测 ${layers.root}/${layers.spot}/${layers.tip}）`,
    layers.root === 'none' && layers.spot === 'none' && layers.tip === 'auto',
  );

  /* ================= ④ 文案与步数（?ai=off → 5 步） ================= */

  const first = await stepInfo();
  report.check(`④ 第 1 步是「左边是功能区」（${first.step}）`, first.step === '第 1 步 / 共 5 步' && first.title === '左边是功能区');
  report.check('④b 第 1 步正文只列有内容的面板（含「常用的都在这排」）', first.body.includes('常用的都在这排') === true);
  report.check('④c 第 1 步没有「上一步」按钮', first.hasPrev === false);
  report.check('④d 第 1 步主按钮是「下一步」', first.next === '下一步');

  /* ================= ⑤ 提示框在目标右侧且在视口内 ================= */

  const tip1 = await box('[data-v="onboarding-tip"]');
  const viewport = JSON.parse(await ev(`JSON.stringify({ w: window.innerWidth, h: window.innerHeight })`));
  report.check(`⑤ 提示框在目标右侧（tip.left=${Math.round(tip1.left)} > 目标右边缘 ${Math.round(target1.left + target1.w)}）`, tip1.left >= target1.left + target1.w);
  report.check('⑤b 提示框完整落在视口内（8px 边距）', tip1.left >= 8 && tip1.top >= 8 && tip1.left + tip1.w <= viewport.w - 8 && tip1.top + tip1.h <= viewport.h - 8);

  /* ================= ⑥ 可操作：点 Tab 真切过去、引导不关 ================= */

  await click('[data-v="left-tab-text"]');
  const leftTab = await ev('window.__VEDITOR_TEST__.leftTab()');
  report.check(`⑥ 点「文本」Tab 真的切过去了（leftTab=${leftTab}）且引导没被打断`, leftTab === 'text' && (await guideOpen()) === true);

  /* ================= ⑦ 容错跳步：素材栏 hidden → 第 2 步被跳过 ================= */

  await key('ArrowRight');
  const skipped = await stepInfo();
  report.check(
    `⑦ 素材栏被藏起来后第 2 步自动跳过，直接到「这里是时间轴」（${skipped.step} · ${skipped.title}）`,
    skipped.title === '这里是时间轴',
  );

  await click('[data-v="left-tab-media"]');
  await key('ArrowLeft');
  const stepTwo = await stepInfo();
  report.check(`⑦b 素材栏恢复后 ← 落到第 2 步（${stepTwo.step} · ${stepTwo.title}）`, stepTwo.title === '先把素材放进来' && stepTwo.hasPrev === true);
  await key('ArrowLeft');
  const stepOne = await stepInfo();
  report.check(`⑦c 再 ← 回到第 1 步（${stepOne.title}）`, stepOne.title === '左边是功能区' && stepOne.hasPrev === false);
  await key('ArrowRight');
  const stepTwoAgain = await stepInfo();
  report.check(`⑦d → 又前进到第 2 步（${stepTwoAgain.title}）`, stepTwoAgain.title === '先把素材放进来');

  /* ================= ⑧ 响应式：缩放后 spotlight 仍贴目标 ================= */

  await page.session.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 780, deviceScaleFactor: 1, mobile: false });
  await sleep(700);
  const targetAfter = await box('[data-v="asset-content"]');
  const spotAfter = await box('[data-v="onboarding-spotlight"]');
  report.check(
    `⑧ 窗口缩到 1100×780 后 spotlight 仍贴着目标（spot ${Math.round(spotAfter.left)},${Math.round(spotAfter.top)} / 目标 ${Math.round(targetAfter.left)},${Math.round(targetAfter.top)}）`,
    near(spotAfter.left, targetAfter.left) && near(spotAfter.top, targetAfter.top) && near(spotAfter.w, targetAfter.w),
  );
  await page.session.send('Emulation.clearDeviceMetricsOverride');
  await sleep(400);

  /* ================= ⑨ 退出三连：跳过 / Esc / 点空白 ================= */

  await coldStart();
  await click('[data-v="onboarding-skip"]');
  report.check('⑨ 点「跳过」关闭并记录 skipped', (await guideOpen()) === false && (await flag()) === 'skipped');

  await coldStart();
  await key('Escape');
  report.check('⑨b Esc 关闭并记录 skipped', (await guideOpen()) === false && (await flag()) === 'skipped');

  await coldStart();
  await ev(`document.querySelector('[data-v="workspace"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await sleep(300);
  report.check('⑨c 点真正的空白处关闭并记录 skipped', (await guideOpen()) === false && (await flag()) === 'skipped');

  /* ================= ⑩ 不重复打扰 ================= */

  await sleep(1200);
  report.check('⑩ 看过之后刷新（标记 skipped）不再自动弹', (await guideOpen()) === false);
  await ev(`localStorage.setItem('veditor:onboarding', 'done')`);
  await reload();
  await sleep(1200);
  report.check('⑩b 标记 done 时刷新也不再自动弹', (await guideOpen()) === false);

  /* ================= ⑪ 手动入口不看标记 ================= */

  await replayFromSettings();
  const manual = await stepInfo();
  report.check(
    `⑪ 标记 done 时，设置面板仍能手动唤起（${manual.step} · ${manual.title}）`,
    (await guideOpen()) === true && manual.step === '第 1 步 / 共 5 步',
  );

  /* ================= ⑫ 走完最后一步 → done ================= */

  const labels = [];
  let last = await stepInfo();
  for (let guard = 0; guard < 8 && last.next !== '开始创作'; guard += 1) {
    labels.push(last.next);
    await click('[data-v="onboarding-next"]');
    last = await stepInfo();
  }
  report.check(
    `⑫ 一路「下一步」走到最后一步，按钮变「开始创作」（${last ? `${last.step} · ${last.title} · ${last.next}` : 'null'}）`,
    last !== null && last.next === '开始创作',
  );
  report.check(`⑫b 中间每一步的按钮都是「下一步」（${labels.join(' / ')}）`, labels.length >= 3 && labels.every((item) => item === '下一步'));
  await click('[data-v="onboarding-next"]');
  report.check('⑫c 点「开始创作」关闭并记录 done', (await guideOpen()) === false && (await flag()) === 'done');
} finally {
  await page.close();

  /* ================= ⑬ AI 可用性：默认 6 步（另开一个页面，不带 ?ai=off） ================= */
  let second_page = null;
  try {
    second_page = await launchPage({ url: base, width: 1440, height: 900, onboarding: 'on' });
    const ev2 = (code) => second_page.session.evaluate(code);
    await second_page.session.waitFor('!!window.__VEDITOR_TEST__', 20000);
    await ev2(`localStorage.removeItem('veditor:onboarding')`);
    await ev2('location.reload()');
    await sleep(2600);
    await second_page.session.waitFor('!!window.__VEDITOR_TEST__', 20000);
    await sleep(900);
    const info = JSON.parse(
      await ev2(`(() => {
        const step = document.querySelector('[data-v="onboarding-step"]');
        const ai = document.querySelector('[data-v="ai-open"]');
        return JSON.stringify({
          step: step ? step.textContent.trim() : null,
          aiDisabled: ai ? ai.disabled === true : null,
        });
      })()`),
    );
    report.check(
      `⑬ 默认启动（AI 通道可用）→ 6 步，且顶栏 AI 按钮可用（disabled=${info.aiDisabled}，${info.step}）`,
      info.step === '第 1 步 / 共 6 步' && info.aiDisabled === false,
    );

    // 走到底：最后一步必须是 AI，且按钮是「开始创作」
    let lastStep = JSON.parse(
      await ev2(`(() => {
        const title = document.querySelector('[data-v="onboarding-title"]');
        const next = document.querySelector('[data-v="onboarding-next"]');
        return JSON.stringify({ title: title ? title.textContent.trim() : null, next: next ? next.textContent.trim() : null });
      })()`),
    );
    for (let guard = 0; guard < 8 && lastStep.next !== '开始创作'; guard += 1) {
      await ev2(`document.querySelector('[data-v="onboarding-next"]').click()`);
      await sleep(180);
      lastStep = JSON.parse(
        await ev2(`(() => {
          const title = document.querySelector('[data-v="onboarding-title"]');
          const next = document.querySelector('[data-v="onboarding-next"]');
          return JSON.stringify({ title: title ? title.textContent.trim() : null, next: next ? next.textContent.trim() : null });
        })()`),
      );
    }
    report.check(
      `⑬b AI 可用时最后一步是「还能直接说人话」+「开始创作」（${lastStep.title} · ${lastStep.next}）`,
      lastStep.title === '还能直接说人话' && lastStep.next === '开始创作',
    );
  } catch (error) {
    report.check(`⑬ 默认启动检查失败：${error instanceof Error ? error.message : String(error)}`, false);
  } finally {
    if (second_page !== null) await second_page.close();
    report.summary('新手引导（首次触发 / 穿透 / 定位 / 退出 / 步进 / 容错 / 手动入口 / AI 可用性）');
    dev.kill();
  }
}

process.exit(process.exitCode ?? 0);
