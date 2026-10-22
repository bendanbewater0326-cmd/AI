/**
 * 轨道增删的端到端验证。
 *
 * ## 为什么单独一条
 *
 * 界面能「＋ 轨道」，双击素材在播放头被占用时还会**自动新建轨**（多机位的入口），
 * 但一直没有"删除轨道"——轨道**只增不减**，用户误点几下就攒出一堆空轨，永远清不掉。
 * 这条 E2E 盯的就是这个闭环：
 *
 *   ① 「＋ 轨道」建出 V3
 *   ② 播放头被占用时双击素材 → 自动落到空闲轨（V1/V2 满则新建 V3），**不重叠**
 *   ③ 删掉有内容的 V3 → 轨道与片段一起消失，**一次撤销全部回来**
 *   ④ 删到只剩一条视频轨时再删 → 可读拒绝（"至少要保留一条视频轨"），轨道还在
 *   ⑤ 全程无页面错误
 *
 * 运行：node tests/verify-tracks.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReport, launchPage } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5222;
const FIXTURE = 'sample-720p.mp4';

function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
    const found = [
      path.join(ROOT, 'tests', 'fixtures', 'compat', name),
      path.join(ROOT, 'tests', 'fixtures', name),
      path.join(ROOT, 'tests', 'fixtures', 'hardline', name),
    ].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!found) {
      response.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(found).pipe(response);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function startDevServer() {
  const child = spawn(process.execPath, ['scripts/dev.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dev server 未就绪')), 15000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes(`127.0.0.1:${PORT}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return child;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TRACKS = `JSON.stringify(window.__VEDITOR_TEST__.tracks().map((track) => ({ id: track.id, name: track.name, kind: track.kind, clips: track.clips })))`;
const CLIPS = `JSON.stringify(window.__VEDITOR_TEST__.clips().map((clip) => ({ trackId: clip.trackId, start: clip.startFrame, duration: clip.durationFrames })))`;

const report = createReport();
const fixture = await startFixtureServer();
const dev = await startDevServer();
const page = await launchPage({
  url: `http://127.0.0.1:${PORT}/?src=${fixture.origin}/${FIXTURE}`,
  width: 1440,
  height: 900,
});

/**
 * 通过 ⋮ 菜单删除轨道。
 *
 * 2026-10-22 起轨道头只留四个按钮（图标/名称/显隐或静音/锁定/更多），
 * "删除轨道"按规范 §4.6 收进了菜单——所以测试也得走菜单。
 */
async function removeTrackViaMenu(trackId) {
  await page.session.evaluate(`document.querySelector('[data-v="track-more-${trackId}"]')?.click()`);
  await sleep(250);
  await page.session.evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('[data-v="context-menu"] button'));
    const target = items.find((button) => button.textContent.includes('删除轨道'));
    if (target && !target.disabled) target.click();
    return true;
  })()`);
  await sleep(450);
}

try {
  await page.session.waitFor('!!window.__VEDITOR_TEST__', 15000);
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length > 0', 30000);
  await sleep(1200);

  const before = JSON.parse(await page.session.evaluate(TRACKS));

  // ---- ① 「＋ 轨道」建出 V3 ----
  // 点「＋轨道」→ 弹三选一菜单 → 选"添加视频轨"（规范 §2.4 的添加入口）
  await page.session.evaluate(`document.querySelector('[data-v="add-track"]').click()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await page.session.evaluate(`(() => {
    const item = Array.from(document.querySelectorAll('[data-v="context-menu"] button'))
      .find((button) => button.textContent.includes('添加视频轨'));
    if (item) item.click();
    return true;
  })()`);
  await page.session.waitFor(`window.__VEDITOR_TEST__.tracks().length === ${before.length + 1}`, 5000);
  const withNew = JSON.parse(await page.session.evaluate(TRACKS));
  const created = withNew[withNew.length - 1];
  report.check(
    `① 「＋ 轨道」建出新轨（${created?.name} / ${created?.id}）`,
    created !== undefined && created.kind === 'video' && /^V\d+$/.test(created.name),
  );
  report.check(
    `① 新轨的 ⋮ 菜单里有删除项（轨道头只留四个按钮，删除收进菜单）`,
    (await page.session.evaluate(`!!document.querySelector('[data-v="track-more-${created?.id}"]')`)) === true,
  );

  // ---- ② 播放头被占用时双击素材 → 落到空闲轨，不重叠 ----
  const doubleClickAsset = async () => {
    await page.session.evaluate(
      `document.querySelector('[data-v="asset-card"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`,
    );
  };

  await doubleClickAsset();
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length === 2', 10000);
  await sleep(600);
  const clips = JSON.parse(await page.session.evaluate(CLIPS));
  const trackIds = clips.map((clip) => clip.trackId);
  report.check(
    `② 第二段落到另一条轨（${trackIds.join(' / ')}），没有同轨重叠`,
    new Set(trackIds).size === 2,
  );

  // 再双击一次 → V1/V2 都占用，但 V3 是空的（① 刚建的）→ 落 V3，不新建
  await doubleClickAsset();
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length === 3', 10000);
  await sleep(600);
  const third = JSON.parse(await page.session.evaluate(CLIPS))[2];
  const tracksAtThree = JSON.parse(await page.session.evaluate(TRACKS));
  report.check(
    `② V1/V2 都占用 → 落已有的空轨 ${third?.trackId}（轨数仍是 ${tracksAtThree.length}，没有多建）`,
    third !== undefined && third.trackId === created.id && tracksAtThree.length === withNew.length,
  );

  // 再双击一次 → V1/V2/V3 全占用 → **自动新建**一条并放上去
  await doubleClickAsset();
  await page.session.waitFor('window.__VEDITOR_TEST__.clips().length === 4', 10000);
  await sleep(600);
  const afterAuto = JSON.parse(await page.session.evaluate(TRACKS));
  const autoTrack = afterAuto[afterAuto.length - 1];
  report.check(
    `② 全占用时自动新建轨并落片段（${autoTrack?.name}，轨数 ${afterAuto.length}）`,
    afterAuto.length === withNew.length + 1 && autoTrack.clips === 1 && autoTrack.id !== created.id,
  );

  // ---- ③ 删掉有内容的轨 → 片段一起消失；一次撤销全部回来 ----
  await removeTrackViaMenu(autoTrack.id);
  await page.session.waitFor(`window.__VEDITOR_TEST__.tracks().length === ${withNew.length}`, 5000);
  await sleep(400);
  const afterRemove = JSON.parse(await page.session.evaluate(TRACKS));
  const clipsAfterRemove = JSON.parse(await page.session.evaluate(CLIPS));
  report.check(
    `③ 轨道与其片段一起消失（轨 ${afterRemove.length} 条 / 片段 ${clipsAfterRemove.length} 段）`,
    afterRemove.every((track) => track.id !== autoTrack.id) && clipsAfterRemove.length === 3,
  );

  for (const type of ['keyDown', 'keyUp']) {
    await page.session.send('Input.dispatchKeyEvent', { type, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
  }
  await sleep(700);
  const restored = JSON.parse(await page.session.evaluate(TRACKS));
  const restoredClips = JSON.parse(await page.session.evaluate(CLIPS));
  report.check(
    `③ 一次撤销把轨道和片段都带回来（轨 ${restored.length} 条 / 片段 ${restoredClips.length} 段）`,
    restored.length === withNew.length + 1 &&
      restored.some((track) => track.id === autoTrack.id && track.clips === 1) &&
      restoredClips.length === 4,
  );

  // ---- ④ 最后一条视频轨不可删 ----
  // 先删掉 V4、V3、V2（都有内容），只剩 V1
  for (const id of [autoTrack.id, created.id, 'trk_V2']) {
    const exists = await page.session.evaluate(
      `window.__VEDITOR_TEST__.tracks().some((track) => track.id === ${JSON.stringify(id)})`,
    );
    if (exists === true) await removeTrackViaMenu(id);
  }
  const onlyVideo = JSON.parse(await page.session.evaluate(TRACKS));
  report.check(
    `④ 删到只剩一条视频轨（${onlyVideo.filter((track) => track.kind === 'video').map((track) => track.name).join(',')}）`,
    onlyVideo.filter((track) => track.kind === 'video').length === 1,
  );

  // 打开 V1 的 ⋮ 菜单，读"删除轨道"这一项的状态（不可删时置灰 + 文案带原因）
  await page.session.evaluate(`document.querySelector('[data-v="track-more-trk_V1"]').click()`);
  await sleep(300);
  const removeItem = JSON.parse(
    await page.session.evaluate(`(() => {
      const items = Array.from(document.querySelectorAll('[data-v="context-menu"] button'));
      const target = items.find((button) => button.textContent.includes('删除轨道'));
      if (target === undefined) return JSON.stringify({ found: false });
      return JSON.stringify({ found: true, disabled: target.disabled, text: target.textContent });
    })()`),
  );
  const disabled = removeItem.found === true ? String(removeItem.disabled) : 'missing';
  const title = removeItem.found === true ? removeItem.text : 'missing';
  await page.session.evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('[data-v="context-menu"] button'));
    const target = items.find((button) => button.textContent.includes('删除轨道'));
    if (target && !target.disabled) target.click();
    return true;
  })()`);
  await page.session.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(500);
  const afterBlocked = JSON.parse(await page.session.evaluate(TRACKS));
  const errorBanner = await page.session.evaluate(
    `document.querySelector('[data-v="errorbar"]')?.textContent ?? ''`,
  );
  report.check(
    `④ 最后一条视频轨标记为不可删（aria-disabled=${disabled}，title="${title}"）`,
    disabled === 'true' && /至少要保留一条视频轨/.test(String(title)),
  );
  /**
   * 断言方式变了：删除项现在是**置灰 + 文案里带原因**（点之前就知道为什么），
   * 而不是"点了之后弹错误条"。所以这里断言"点了没反应" + 原因写在菜单项上。
   * （旧实现的按钮 aria-disabled 但仍可点，点完才报错——先解释比后报错好。）
   */
  report.check(
    `④ 点了也不会消失（轨 ${afterBlocked.length} 条），原因写在菜单项上（"${String(title).trim()}"）`,
    afterBlocked.some((track) => track.id === 'trk_V1') &&
      /至少要保留一条视频轨/.test(String(title)) &&
      errorBanner === '',
  );

  // ---- ⑤ 隐藏：轨道不参与渲染（唯一轨道隐藏 → 预览黑屏），再点恢复 ----
  const bright = JSON.parse(
    await page.session.evaluate(`(async () => JSON.stringify(await window.__VEDITOR_TEST__.previewSnapshot()))()`),
  );
  await page.session.evaluate(`document.querySelector('[data-v="hide-trk_V1"]').click()`);
  await sleep(1200);
  const hiddenState = JSON.parse(
    await page.session.evaluate(
      `JSON.stringify(window.__VEDITOR_TEST__.tracks().find((track) => track.id === 'trk_V1'))`,
    ),
  );
  const dark = JSON.parse(
    await page.session.evaluate(`(async () => JSON.stringify(await window.__VEDITOR_TEST__.previewSnapshot()))()`),
  );
  report.check(
    `⑤ 隐藏轨道后预览变黑（非黑像素 ${bright?.nonBlack} → ${dark?.nonBlack}，hidden=${hiddenState?.hidden}）`,
    bright !== null && bright.nonBlack > 1000 && dark !== null && dark.nonBlack < 100 && hiddenState?.hidden === true,
  );
  await page.session.evaluate(`document.querySelector('[data-v="hide-trk_V1"]').click()`);
  await sleep(1200);
  const back = JSON.parse(
    await page.session.evaluate(`(async () => JSON.stringify(await window.__VEDITOR_TEST__.previewSnapshot()))()`),
  );
  const shownState = JSON.parse(
    await page.session.evaluate(
      `JSON.stringify(window.__VEDITOR_TEST__.tracks().find((track) => track.id === 'trk_V1'))`,
    ),
  );
  report.check(
    `⑤ 再点一次恢复显示（非黑像素 ${back?.nonBlack}，hidden=${shownState?.hidden}）`,
    back !== null && back.nonBlack > 1000 && shownState?.hidden === false,
  );

  // ---- ⑥ 锁定：轨道上的片段改不动（Delete 被拒绝，片段还在，错误条可读）----
  await page.session.evaluate(`document.querySelector('[data-v="lock-trk_V1"]').click()`);
  await sleep(400);
  const clipId = await page.session.evaluate(`window.__VEDITOR_TEST__.clips()[0].id`);
  // 直接选中并尝试删除（键盘路径，绕过任何按钮级禁用）
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(clipId)})`);
  await sleep(200);
  for (const type of ['keyDown', 'keyUp']) {
    await page.session.send('Input.dispatchKeyEvent', {
      type,
      key: 'Delete',
      code: 'Delete',
      windowsVirtualKeyCode: 46,
    });
  }
  await sleep(600);
  const afterLockedDelete = JSON.parse(
    await page.session.evaluate(`JSON.stringify({
      clips: window.__VEDITOR_TEST__.clips().length,
      errors: window.__VEDITOR_TEST__.errors().map((item) => item.message),
      locked: window.__VEDITOR_TEST__.tracks().find((track) => track.id === 'trk_V1').locked,
    })`),
  );
  report.check(
    `⑥ 锁定后 Delete 被拒绝（片段仍 ${afterLockedDelete.clips} 段，错误条："${afterLockedDelete.errors.join(' / ')}"）`,
    afterLockedDelete.locked === true &&
      afterLockedDelete.clips === 1 &&
      afterLockedDelete.errors.some((message) => /轨道已锁定/.test(message)),
  );

  // 解锁 → 同样的 Delete 就能删掉（证明拒绝的是"锁定"而不是别的）
  await page.session.evaluate(`document.querySelector('[data-v="lock-trk_V1"]').click()`);
  await sleep(300);
  await page.session.evaluate(`window.__VEDITOR_TEST__.selectClip(${JSON.stringify(clipId)})`);
  for (const type of ['keyDown', 'keyUp']) {
    await page.session.send('Input.dispatchKeyEvent', {
      type,
      key: 'Delete',
      code: 'Delete',
      windowsVirtualKeyCode: 46,
    });
  }
  await sleep(600);
  const afterUnlockedDelete = await page.session.evaluate(`window.__VEDITOR_TEST__.clips().length`);
  report.check(`⑥ 解锁后 Delete 生效（片段 ${afterUnlockedDelete} 段）`, afterUnlockedDelete === 0);

  // ---- ⑦ 无页面错误（只剩"锁定拒绝"那一条）----
  const errors = JSON.parse(await page.session.evaluate('JSON.stringify(window.__VEDITOR_TEST__.errors())'));
  report.check(
    `⑦ 只有"锁定拒绝"这一条提示，没有其它异常（${JSON.stringify(errors.map((item) => item.message))}）`,
    Array.isArray(errors) &&
      errors.length > 0 &&
      errors.every((item) => /至少要保留一条视频轨|轨道已锁定/.test(item.message)),
  );

  report.summary('轨道增删');
} finally {
  await page.close();
  dev.kill();
  await fixture.close();
}
