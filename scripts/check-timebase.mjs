/**
 * 时基合规静态检查（R-031 的保护网）。
 *
 * 规则：除 `src/core/timebase.ts` 之外，全仓库禁止出现任何"帧 ↔ 时间"换算字面量
 * （1e6 / 1e9 / 1000 / fps / fps * 1000 / frame / fps / (frames / 1000) * fps / sec * 1000 …）。
 * 唯一换算点必须是 `src/core/timebase.ts`，否则长播放与导出必然漂移（架构 §5.2）。
 *
 * 例外：行内注释写 `timebase-allow: <理由>` 可放行该行（仅用于 UI 显示帧率这类非换算用途）。
 *
 * 命中即 exit 1，并打印文件名 + 行号 + 命中内容。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const ALLOW_MARKER = 'timebase-allow';
const EXCLUDED_FILES = new Set([path.normalize(path.join(ROOT, 'src', 'core', 'timebase.ts'))]);
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.git', '.workbuddy', 'tests']);
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.html']);

/** 非法换算规则表。顺序无关，命中任意一条即报错。 */
const RULES = [
  {
    id: 'MICRO_CONSTANT',
    re: /(?<![\w$.])(?:1e6|1e9|1_000_000|1_000_000_000|1000000|1000000000)(?![\w])/,
    reason: '出现微秒/纳秒级常量（帧↔时间换算必须走 timebase）',
  },
  {
    id: 'FPS_TO_MILLI',
    re: /\b[A-Za-z_$][\w$]*[Ff][Pp][Ss]\w*\s*\/\s*1000\b/,
    reason: 'fps / 1000（帧率换算帧率，必须用毫帧率整数）',
  },
  {
    id: 'MILLI_TO_FPS',
    re: /\b1000\s*\/\s*[A-Za-z_$][\w$]*[Ff][Pp][Ss]\w*/,
    reason: '1000 / fps（秒级换算，必须走 timebase）',
  },
  {
    id: 'FPS_TIMES_THOUSAND',
    re: /\b[A-Za-z_$][\w$]*[Ff][Pp][Ss]\w*\s*\*\s*1000\b/,
    reason: 'fps * 1000（秒级换算，必须走 timebase）',
  },
  {
    id: 'DIV_FPS_TIMES_THOUSAND',
    re: /\/\s*[A-Za-z_$][\w$]*[Ff][Pp][Ss]\w*\s*\*\s*1000/,
    reason: '/ fps * 1000（帧→毫秒，必须走 timebase）',
  },
  {
    id: 'FRAME_DIV_FPS',
    re: /\b[A-Za-z_$][\w$]*[Ff]rames?\b\s*\/\s*[A-Za-z_$][\w$]*[Ff][Pp][Ss]\w*/,
    reason: 'frame / fps（帧→秒，必须走 timebase）',
  },
  {
    id: 'SECONDS_TIMES_FPS',
    re: /\b[A-Za-z_$][\w$]*\s*\*\s*[A-Za-z_$][\w$]*[Ff][Pp][Ss]\w*\s*\/\s*1000/,
    reason: 'sec * fps / 1000（秒→帧，必须走 timebase）',
  },
  {
    id: 'THOUSAND_DIV_FPS_SIMPLE',
    re: /\b1000\s*\/\s*(?:fps|fpsMilli|frameRate)\b/,
    reason: '1000 / fps（帧→毫秒，必须走 timebase）',
  },
  {
    // 兜底规则：`(frames / 1000) * fps`、`sec * 1000`、`(frame / 1000)` 这类"帧↔秒"缩放，
    // 单独看 1000 无法判定，因此要求同一行（注释已剥离）里同时出现 fps/frame/time/sec 等标识符。
    id: 'THOUSAND_SCALE_WITH_TIME',
    re: /(?:\/\s*1000\b|\*\s*1000\b)/,
    alsoRequires:
      /\b(?:fps|fpsMilli|frame|frames|frameMillis?|time|timestamp|sec|secs|second|seconds|durationSec)\b/i,
    reason: '与 fps/frame/时间标识符同现的 1000 缩放（帧↔秒换算必须走 timebase）',
  },
];

/**
 * 把注释替换为空格（保留换行，行号不变），字符串字面量原样保留（便于发现模板串里的换算）。
 * 目的：避免文档注释里出现 "1e6/fps" 这类说明性文字被误判。
 */
function stripComments(source) {
  let out = '';
  let i = 0;
  let mode = 'code'; // code | block | line | string
  let quote = '';
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (mode === 'block') {
      if (ch === '*' && next === '/') {
        mode = 'code';
        out += '  ';
        i += 2;
        continue;
      }
      out += ch === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (ch === '\n') {
        mode = 'code';
        out += '\n';
      } else {
        out += ' ';
      }
      i += 1;
      continue;
    }
    if (mode === 'string') {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) mode = 'code';
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      mode = 'block';
      out += '  ';
      i += 2;
      continue;
    }
    if (ch === '/' && next === '/') {
      mode = 'line';
      out += '  ';
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      mode = 'string';
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 递归收集待扫描文件。 */
async function collectFiles(entryPath, collected) {
  const info = await stat(entryPath);
  if (info.isDirectory()) {
    const base = path.basename(entryPath);
    if (EXCLUDED_DIRS.has(base)) return;
    const entries = await readdir(entryPath, { withFileTypes: true });
    for (const entry of entries) {
      await collectFiles(path.join(entryPath, entry.name), collected);
    }
    return;
  }
  if (!info.isFile()) return;
  if (!SCAN_EXTENSIONS.has(path.extname(entryPath))) return;
  if (EXCLUDED_FILES.has(path.normalize(entryPath))) return;
  collected.push(entryPath);
}

/** 扫描单个文件，返回命中列表。 */
async function scanFile(filePath) {
  const raw = await readFile(filePath, 'utf8');
  const stripped = stripComments(raw);
  const rawLines = raw.split(/\r?\n/);
  const codeLines = stripped.split(/\r?\n/);
  const hits = [];
  for (let index = 0; index < codeLines.length; index += 1) {
    const codeLine = codeLines[index] ?? '';
    if (codeLine.trim().length === 0) continue;
    const rawLine = rawLines[index] ?? '';
    // 放行标记可写在同行或紧邻的上一行（注释块里标注原因更可读）
    if (rawLine.includes(ALLOW_MARKER) || (rawLines[index - 1] ?? '').includes(ALLOW_MARKER)) {
      continue;
    }
    for (const rule of RULES) {
      const match = rule.re.exec(codeLine);
      if (!match) continue;
      // 部分规则需要同一行还出现时间语义标识符，避免误伤 1000 这个数字本身
      if (rule.alsoRequires && !rule.alsoRequires.test(codeLine)) continue;
      hits.push({
        line: index + 1,
        rule: rule.id,
        reason: rule.reason,
        excerpt: rawLine.trim().slice(0, 120),
      });
      break;
    }
  }
  return hits;
}

async function main() {
  const files = [];
  await collectFiles(path.join(ROOT, 'src'), files);
  await collectFiles(path.join(ROOT, 'index.html'), files).catch(() => {});

  let totalHits = 0;
  for (const file of files.sort()) {
    const hits = await scanFile(file);
    for (const hit of hits) {
      totalHits += 1;
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      console.error(`✗ ${rel}:${hit.line}  [${hit.rule}] ${hit.reason}`);
      console.error(`    ${hit.excerpt}`);
    }
  }

  if (totalHits > 0) {
    console.error(`\n✗ 时基静态检查失败：${totalHits} 处非法帧↔时间换算（唯一换算点是 src/core/timebase.ts）`);
    process.exit(1);
  }
  console.log(`✓ 时基静态检查通过：扫描 ${files.length} 个文件，0 处非法换算`);
}

main().catch((error) => {
  console.error('时基静态检查执行失败：', error instanceof Error ? error.message : error);
  process.exit(1);
});
