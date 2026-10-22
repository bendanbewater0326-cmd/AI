/**
 * 生产构建：esbuild 打包 src/main.tsx → dist/（main.js + main.css），并把 index.html 复制到 dist/。
 * 产物可直接 `cd dist && python -m http.server --bind 127.0.0.1` 访问（file:// 会因安全上下文被阻断，属预期行为）。
 */
import { build } from 'esbuild';
import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');

/** 只清理本脚本产出的 3 个文件（不整体删 dist，避免动到正在运行的 dev 产物）。 */
const OWN_OUTPUTS = ['main.js', 'main.css', 'index.html'];

async function main() {
  await mkdir(DIST, { recursive: true });
  for (const file of OWN_OUTPUTS) {
    await rm(path.join(DIST, file), { force: true });
  }

  await build({
    absWorkingDir: ROOT,
    entryPoints: ['src/main.tsx'],
    outdir: DIST,
    bundle: true,
    minify: true,
    format: 'esm',
    target: ['chrome110', 'edge110'],
    platform: 'browser',
    loader: { '.css': 'css' },
    define: {
      'process.env.NODE_ENV': '"production"',
    },
    legalComments: 'none',
    logLevel: 'info',
  });

  await copyFile(path.join(ROOT, 'index.html'), path.join(DIST, 'index.html'));
  await writeFile(path.join(DIST, 'build-id.txt'), new Date().toISOString(), 'utf8');

  const files = await readdir(DIST);
  const report = [];
  for (const file of files) {
    if (!OWN_OUTPUTS.includes(file)) continue;
    const info = await stat(path.join(DIST, file));
    report.push(`${file}  ${(info.size / 1024).toFixed(1)} KB`);
  }
  console.log(`\n✓ 构建完成 → ${path.relative(ROOT, DIST)}/`);
  for (const line of report) console.log(`  ${line}`);
  console.log('  验证：cd dist && python -m http.server 8080 --bind 127.0.0.1');
}

main().catch((error) => {
  console.error('构建失败：', error instanceof Error ? error.message : error);
  process.exit(1);
});
