/**
 * 开发服务器：esbuild watch + 静态服务。
 *
 * 硬约束（见 docs/tech-preflight.md）：WebCodecs / File System Access 只在 secure context 下存在，
 * 因此 dev server **必须**绑定 127.0.0.1（不能用 0.0.0.0 / localhost 的 IPv6 解析），
 * 且端口被占用时自动 +1。
 */
import { context } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'dist', 'dev');
const HOST = '127.0.0.1';
const BASE_PORT = Number(process.env.PORT ?? 5173);
const MAX_PORT_TRIES = 20;

/** 端口是否空闲（在 HOST 上真实 listen 一次）。 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, HOST);
  });
}

/** 从 startPort 起逐个试探，返回第一个空闲端口。 */
async function findFreePort(startPort) {
  for (let i = 0; i < MAX_PORT_TRIES; i += 1) {
    const port = startPort + i;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`端口 ${startPort}–${startPort + MAX_PORT_TRIES - 1} 全部被占用`);
}

async function main() {
  // 不整体删除 outdir：Windows 上父进程持有句柄时递归删除会失败，且没必要（esbuild 会覆盖产物）
  // 与 build.mjs 同一个源头：package.json 的 version（注入为 __APP_VERSION__）
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  await mkdir(OUT, { recursive: true });
  await copyFile(path.join(ROOT, 'index.html'), path.join(OUT, 'index.html'));

  const ctx = await context({
    absWorkingDir: ROOT,
    entryPoints: ['src/main.tsx'],
    outdir: OUT,
    bundle: true,
    format: 'esm',
    target: ['chrome110', 'edge110'],
    platform: 'browser',
    loader: { '.css': 'css' },
    sourcemap: 'inline',
    define: {
      'process.env.NODE_ENV': '"development"',
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    logLevel: 'info',
    plugins: [
      {
        // index.html 不属于 esbuild 的产物，改完要重新拷到 servedir（否则 dev 下改了不生效）
        name: 'copy-index-html',
        setup(build) {
          build.onEnd(async (result) => {
            if (result.errors.length === 0) {
              await copyFile(path.join(ROOT, 'index.html'), path.join(OUT, 'index.html'));
              // 每次重建写一个时间戳，页面启动时 fetch 它并显示在顶栏。
              // 目的：**区分"代码没生效"和"页面没刷新"**——这两件事以前只能靠猜。
              await writeFile(path.join(OUT, 'build-id.txt'), new Date().toISOString(), 'utf8');
            }
          });
        },
      },
    ],
  });

  await ctx.watch();

  const port = await findFreePort(BASE_PORT);
  const served = await ctx.serve({ host: HOST, port, servedir: OUT });
  const url = `http://${HOST}:${served.port ?? port}/`;

  console.log(`\n  veditor dev server`);
  console.log(`  ➜  ${url}`);
  console.log(`  ➜  只监听 ${HOST}（WebCodecs / FS Access 需要安全上下文）`);
  console.log('  Ctrl+C 退出\n');

  const shutdown = async () => {
    await ctx.dispose();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('dev server 启动失败：', error instanceof Error ? error.message : error);
  process.exit(1);
});
