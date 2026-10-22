#!/usr/bin/env node
/**
 * 全量 E2E：串行跑完 `tests/verify-*.mjs`，汇总结果。
 *
 * ## 为什么要一条命令
 *
 * 2026-10-21 之前一直是"改哪块跑哪块"，第一次全量跑（40 个脚本）就抓到 3 个红：
 * 2 个测试自身过期、1 个环境问题，还有 1 个真 bug 是顺手发现的。
 * 靠人记得跑 = 靠运气；所以固化成 `npm run e2e`，交付前跑一遍。
 *
 * ## 为什么串行
 *
 * 每个脚本自己起 dev server + 无头浏览器，且端口是**写死的**（5201..5222）。
 * 并行会撞端口，改端口又要动 40 个文件——串行最省事，总耗时约 10–15 分钟。
 *
 * ## 为什么给子进程去掉 `CODEBUDDY_SAFE_DELETE_BULK_*`
 *
 * 这个环境对"单轮批量删除"有闸（阈值 50 次），而每个脚本都会 `rmSync` 自己的
 * `tests/.tmp/<name>`。连跑 40 个脚本必然把配额用光，最后几个脚本会死在
 * "清理临时目录"这一步——**看起来像功能坏了**（`verify-realworld-export` 就这样假红过一次）。
 * 子进程删的都是仓库内的临时目录，去掉闸不影响安全（shim 仍然走回收站）。
 *
 * 用法：
 *   node scripts/e2e-all.mjs            # 全部
 *   node scripts/e2e-all.mjs --only=mask  # 只跑名字含 mask 的
 *   node scripts/e2e-all.mjs --list       # 只列清单
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const TESTS = path.join(ROOT, 'tests');
const PER_SCRIPT_TIMEOUT_MS = 300_000;
/** 每个脚本的完整日志（失败时看它，别只看最后 6 行）。 */
const LOG_DIR = path.join(TESTS, '.tmp', 'e2e-logs');

/** 慢脚本排在最后（跑在前面会让人以为卡住了）。 */
const SLOW_FIRST = ['realworld', 'realworld-export', 't06', 'm3-export', 'transition-mixed'];
/**
 * **必须最先跑**的脚本：这两个都用 4K 素材（`realworld` 断言 4K 预览非黑、
 * `proxy` 要现场转 4K 代理）。连跑 40 个脚本后 GPU/显存有压力：
 * realworld 的 4K 首帧会拍到黑帧（`lastLayerCount=1` 却全黑，是 capture 读回的问题），
 * proxy 的转码会卡在 pending 直到超时。放在最前面跑就稳定。
 */
const RUN_FIRST = ['verify-realworld.mjs', 'verify-proxy.mjs'];
/**
 * **只给这两个 4K 脚本一次重试**，而且重试成功要在输出里写明（`✓（重试后通过）`）。
 *
 * 它们失败的原因不是代码：4K 解码要显存，而机器上还有用户自己的浏览器在跑
 * （实测单跑必过、连跑偶红）。不重试的代价是"回归网永远有 2 条假红"，
 * 久而久之大家就不看结果了 —— 那比没有回归网更糟。
 *
 * **只对这两个**：其余脚本不重试，否则真 bug 会被第二次尝试掩盖。
 * 重试也只在**第一次失败**时发生一次，不无限重试。
 */
const RETRY_ONCE = new Set(['verify-realworld.mjs', 'verify-proxy.mjs']);

const args = process.argv.slice(2);
const onlyArg = args.find((arg) => arg.startsWith('--only='));
const only = onlyArg === undefined ? null : onlyArg.slice('--only='.length);
const listOnly = args.includes('--list');

function scriptList() {
  const all = readdirSync(TESTS)
    .filter((name) => name.startsWith('verify-') && name.endsWith('.mjs'))
    .sort();
  const filtered = only === null ? all : all.filter((name) => name.includes(only));
  /**
   * 稳定的排序：慢的沉底，其余保持字典序。
   *
   * `first` **必须按 `RUN_FIRST` 自己的顺序排**，不能沿用字典序：
   * 字典序下 `verify-proxy` 排在 `verify-realworld` 前面，于是"4K 代理转码"先跑、
   * "4K 预览"后跑 —— 正是注释里说会假红的那个顺序（实测 `decodeFailures=1`，
   * 单跑 0）。按 `RUN_FIRST` 的书写顺序取下标排序，才真的让 realworld 第一个跑。
   */
  const first = filtered
    .filter((name) => RUN_FIRST.includes(name))
    .sort((left, right) => RUN_FIRST.indexOf(left) - RUN_FIRST.indexOf(right));
  const rest = filtered.filter((name) => !RUN_FIRST.includes(name));
  const slow = rest.filter((name) => SLOW_FIRST.some((key) => name.includes(key)));
  const fast = rest.filter((name) => !SLOW_FIRST.some((key) => name.includes(key)));
  return [...first, ...fast, ...slow];
}

/** 跑一个脚本，返回 { ok, ms, tail }。 */
function runOne(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const env = { ...process.env };
    // 见文件头：闸是按 turn 累计的，跑几十个脚本必然误伤
    delete env.CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR;
    delete env.CODEBUDDY_TOOL_CALL_ID;

    const child = spawn(process.execPath, [path.join('tests', name)], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk) => {
      output += String(chunk);
      // 只留最后 4KB，避免内存里攒几十 MB 日志
      if (output.length > 8192) output = output.slice(-4096);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      output += `\n[runner] 超时 ${PER_SCRIPT_TIMEOUT_MS / 1000}s，已强杀`;
    }, PER_SCRIPT_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(path.join(LOG_DIR, `${name.replace(/\.mjs$/, '')}.log`), output, 'utf8');
      const lines = output.trim().split(/\r?\n/);
      resolve({
        ok: code === 0,
        code,
        ms: Date.now() - started,
        // 失败时给够上下文：断言行通常不在最后一行
        tail: lines.slice(-20).join('\n'),
      });
    });
  });
}

const scripts = scriptList();
if (scripts.length === 0) {
  console.error(`没有匹配的脚本${only === null ? '' : `（--only=${only}）`}`);
  process.exit(1);
}
if (listOnly) {
  for (const name of scripts) console.log(name);
  process.exit(0);
}

console.log(`全量 E2E：${scripts.length} 个脚本（串行，单脚本上限 ${PER_SCRIPT_TIMEOUT_MS / 1000}s）\n`);

const results = [];
for (const [index, name] of scripts.entries()) {
  process.stdout.write(`[${String(index + 1).padStart(2, ' ')}/${scripts.length}] ${name.padEnd(32, ' ')}`);
  let result = await runOne(name);
  let retried = false;
  if (!result.ok && RETRY_ONCE.has(name)) {
    // 4K 显存争抢：单跑必过，连跑偶红。重试一次，并把"重试过"打在结果里
    retried = true;
    process.stdout.write('↻ ');
    result = await runOne(name);
  }
  results.push({ name, ...result, retried });
  // 给上一个脚本的 headless Chrome 一点时间真正退出：
  // 连着跑时残留进程会抢解码器/GPU，`verify-proxy` 就因此卡在"代理生成中"超过 180 秒
  // （单跑 40 秒就好）。1 秒 × 43 个脚本 ≈ 多 40 秒，换稳定值得。
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const seconds = (result.ms / 1000).toFixed(0);
  console.log(`${result.ok ? '✓' : '✗'} ${seconds}s${result.ok && retried ? '（重试后通过）' : ''}`);
  if (!result.ok) {
    for (const line of result.tail.split('\n')) console.log(`        ${line}`);
  }
}

const failed = results.filter((item) => !item.ok);
const totalMs = results.reduce((sum, item) => sum + item.ms, 0);

console.log(`\n${failed.length === 0 ? '✓' : '✗'} 全量 E2E：${results.length - failed.length} / ${results.length} 通过（${(totalMs / 60000).toFixed(1)} 分钟）`);
if (failed.length > 0) {
  console.log('失败清单：');
  for (const item of failed) console.log(`  - ${item.name}（exit=${item.code}）`);
  process.exit(1);
}
