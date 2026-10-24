/**
 * 工程历史备份端到端验证（B3）。
 *
 * 覆盖：
 *   ① 首次打开：空态（新工程还没有备份）
 *   ② pagehide → 「退出前备份」强制写入并出现在列表（用户补充的边界场景）
 *   ③ 列表新→旧排序、内容差异可辨（1 段 / 2 段两份）
 *   ④ 恢复旧版本：片段数回到快照点（恢复走 .vedproj 同一条 replaceDoc 链路）
 *   ⑤ 回退前快照：恢复动作自动给"当时的现状"留档（可反悔）
 *   ⑥ 内容无变化 → 重复打开不产生重复条目
 *
 * 说明：自动备份的 60s tick + 5 分钟到期判定是纯函数 `isBackupDue`（单测覆盖），
 * E2E 等不起真实间隔——写入/列表/恢复链路由 pagehide 强制写与恢复动作驱动，同一批函数。
 *
 * 运行：`node --experimental-websocket tests/verify-backup.mjs`
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createReport, launchPage } from './cdp.mjs';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..');
const PORT = 5848;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dev = spawn(process.execPath, ['scripts/dev.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('dev server 未就绪')), 20000);
  dev.stdout.on('data', (chunk) => {
    if (String(chunk).includes(`127.0.0.1:${PORT}`)) {
      clearTimeout(timer);
      resolve();
    }
  });
});

const page = await launchPage({ url: `http://127.0.0.1:${PORT}/`, width: 1440, height: 900 });
const report = createReport();

const ev = async (expression) => page.session.evaluate(expression);
const evalJson = async (expression) => JSON.parse(await ev(`JSON.stringify(${expression})`));
const click = async (selector) => {
  await ev(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  await sleep(300);
};

/** 触发 pagehide（App 监听它写「退出前备份」）。 */
const firePagehide = async () => {
  await ev(`window.dispatchEvent(new PageTransitionEvent('pagehide')); true`);
  await sleep(700); // 卸载路径的写是异步尽力而为，留出落盘时间
};

/** 打开「工程 → 历史版本…」并读列表；返回后关闭对话框。 */
const openAndRead = async () => {
  await ev(`(() => {
    const buttons = Array.from(document.querySelectorAll('[data-v="topbar"] button'));
    buttons.find((item) => item.textContent.trim() === '工程')?.click();
    return true;
  })()`);
  await sleep(250);
  await click('[data-v="backup-open"]');
  await page.session.waitFor(`document.querySelector('[data-v="backup-dialog"]') !== null`, 8000);
  await page.session.waitFor(`document.querySelector('[data-v="backup-loading"]') === null`, 8000);
  const list = await evalJson(`(() => {
    const rows = Array.from(document.querySelectorAll('[data-v="backup-item"]'));
    return rows.map((row) => ({
      time: row.querySelector('.v-backup__time')?.textContent ?? '',
      reason: row.querySelector('.v-backup__reason')?.textContent ?? '',
      clips: Number(row.getAttribute('data-clips') ?? '-1'),
    }));
  })()`);
  await click('[data-v="backup-close"]');
  await sleep(250);
  return list;
};

/** 打开对话框（不关闭），并返回行数与原因列表。 */
const openOnly = async () => {
  await ev(`(() => {
    const buttons = Array.from(document.querySelectorAll('[data-v="topbar"] button'));
    buttons.find((item) => item.textContent.trim() === '工程')?.click();
    return true;
  })()`);
  await sleep(250);
  await click('[data-v="backup-open"]');
  await page.session.waitFor(`document.querySelector('[data-v="backup-loading"]') === null`, 8000);
  return evalJson(`(() => {
    const rows = Array.from(document.querySelectorAll('[data-v="backup-item"]'));
    return rows.map((row) => row.querySelector('.v-backup__reason')?.textContent ?? '');
  })()`);
};

const closeDialog = async () => {
  await click('[data-v="backup-close"]');
  await sleep(250);
};

try {
  await page.session.waitFor("document.readyState === 'complete' && !!window.__VEDITOR_TEST__", 15000);
  await sleep(600);

  // 准备内容：文字面板加一段（工程"有东西"）
  await click('[data-v="left-tab-text"]');
  await page.session.waitFor(`document.querySelector('[data-v="text-add"]') !== null`, 8000);
  await click('[data-v="text-add"]');
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 1`, 8000);
  await sleep(400);

  // ---- ① 首次打开：空态 ----
  {
    const list = await openAndRead();
    report.check(`① 首次打开：没有任何备份（实际 ${JSON.stringify(list)}）`, list.length === 0);
  }

  // ---- ② pagehide → 退出前备份（1 段） ----
  await firePagehide();
  {
    const list = await openAndRead();
    report.check(
      `② pagehide 后出现「退出前备份」（${JSON.stringify(list.map((item) => item.reason))}）`,
      list.length === 1 && list[0].reason.includes('退出前备份'),
    );
  }

  // ---- ③ 再加一段 + 再来一次 pagehide → 两份、新→旧 ----
  await click('[data-v="text-add"]');
  await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 2`, 8000);
  await sleep(300);
  await firePagehide();
  {
    const list = await openAndRead();
    report.check(
      `③ 列表新→旧两份（${JSON.stringify(list.map((item) => item.reason))}）`,
      list.length === 2 && list[0].reason.includes('最新') && list[1].reason.includes('退出前备份'),
    );
  }

  // ---- ④/⑤ 恢复：再加一段（3 段）→ 恢复到"1 段"的快照 → 回退前快照入列 ----
  {
    await click('[data-v="text-add"]');
    await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 3`, 8000);
    await sleep(300);
    const reasons = await openOnly();
    report.check(`④ 打开恢复列表：${reasons.length} 条`, reasons.length >= 2);
    // 恢复第 2 行（较旧的"1 段"快照）
    await ev(`(() => {
      const rows = Array.from(document.querySelectorAll('[data-v="backup-item"]'));
      rows[1]?.querySelector('[data-v="backup-restore"]')?.click();
      return true;
    })()`);
    await page.session.waitFor(`window.__VEDITOR_TEST__.clips().length === 1`, 10000);
    report.check(`④ 恢复旧版本：片段 3 → 1`, (await ev('window.__VEDITOR_TEST__.clips().length')) === 1);
    // 恢复动作自动拍了"回退前快照"（当时的 3 段现状）
    const reasonsAfter = await openOnly();
    report.check(
      `⑤ 回退前快照入列（${JSON.stringify(reasonsAfter)}）`,
      reasonsAfter.some((item) => item.includes('回退前快照')),
    );
    await closeDialog();
  }

  // ---- ⑥ 内容无变化不重复 ----
  {
    const first = await openAndRead();
    const second = await openAndRead();
    report.check(`⑥ 无变化不重复（${first.length} / ${second.length}）`, first.length === second.length);
  }

  report.summary('工程历史备份');
} finally {
  await page.close().catch(() => {});
  dev.kill();
}
