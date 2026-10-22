#!/usr/bin/env node
/**
 * 本地媒体服务器：把**磁盘上的视频**用 HTTP 暴露给编辑器。
 *
 * ## 为什么需要它
 *
 * 编辑器在客户端的内嵌面板里跑，而内嵌面板**拿不到 File System Access 权限**
 * （`showOpenFilePicker` / `handle.requestPermission` 一律 denied），
 * 从资源管理器拖文件进去也可能被面板吞掉。结果是"本地文件根本进不来"。
 *
 * 但编辑器支持 `?src=<url>` 自动导入——那就把文件用 HTTP 喂给它：
 *
 *   磁盘文件 → 本服务器 → http://127.0.0.1:PORT/xxx.mp4 → 编辑器 ?src= 自动导入
 *
 * 这样不依赖任何浏览器权限，剪辑/预览/导出全部照常（素材是"内存模式"，但内存模式本来就能用）。
 *
 * ## 用法
 *
 *   node scripts/serve-media.mjs                      # 默认服务微信视频目录
 *   node scripts/serve-media.mjs --dir="D:/视频"       # 指定目录
 *   node scripts/serve-media.mjs --port=5180
 *   node scripts/serve-media.mjs --list                # 只列文件与 URL，不启动
 *
 * 支持 Range（视频跳转要它），带 CORS 头（编辑器与服务器不同源）。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_DIR = 'D:/Wechat/xwechat_files/wxid_jld1pf5xn22c22_d177/msg/video';
const MEDIA_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.mp3', '.m4a', '.wav', '.aac']);

const args = process.argv.slice(2);
const argOf = (name) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};
const dir = path.resolve(argOf('dir') ?? DEFAULT_DIR);
// **别用 5180**：E2E 脚本 `verify-c-ui` 占了 5180，端口冲突会让它起不来（实测假红一次）。
// 5300 在测试端口段（5180–5223）之外。
const port = Number(argOf('port') ?? 5300);
/** 编辑器地址（首页每行给一个"在编辑器中打开"的链接，省得手拼 URL）。 */
const editorBase = argOf('editor') ?? 'http://127.0.0.1:5173/';
const listOnly = args.includes('--list');

/** 递归收集媒体文件（微信按月份分目录）。 */
function collect(root, depth = 0) {
  const found = [];
  if (depth > 4) return found;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...collect(full, depth + 1));
      continue;
    }
    if (MEDIA_EXT.has(path.extname(entry.name).toLowerCase())) found.push(full);
  }
  return found;
}

const files = collect(dir).sort((left, right) => {
  // 新的排前面（按修改时间）
  return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
});

if (files.length === 0) {
  console.error(`目录里没有媒体文件：${dir}`);
  process.exit(1);
}

const relative = (file) => path.relative(dir, file).split(path.sep).join('/');
const urlOf = (file) => `http://127.0.0.1:${port}/${encodeURI(relative(file))}`;

if (listOnly) {
  for (const file of files.slice(0, 30)) {
    const mb = (fs.statSync(file).size / 1024 / 1024).toFixed(1);
    console.log(`${mb.padStart(6)}MB  ${urlOf(file)}`);
  }
  process.exit(0);
}

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
};

const server = http.createServer((request, response) => {
  const urlPath = decodeURIComponent((request.url ?? '/').split('?')[0]);
  const name = urlPath.replace(/^\//, '');

  if (name === '' || name === 'index.html') {
    const rows = files
      .slice(0, 200)
      .map((file) => {
        const mb = (fs.statSync(file).size / 1024 / 1024).toFixed(1);
        const openUrl = `${editorBase}?src=${encodeURIComponent(urlOf(file))}`;
        return `<li><a href="${openUrl}" target="_blank">在编辑器中打开</a> · <a href="/${encodeURI(
          relative(file),
        )}">${relative(file)}</a> <small>${mb}MB</small></li>`;
      })
      .join('');
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    response.end(`<!doctype html><meta charset="utf-8"><h3>${dir}</h3><ul>${rows}</ul>`);
    return;
  }

  const target = path.resolve(dir, name);
  // 防目录穿越：解析后必须仍在 dir 内
  if (!target.startsWith(path.resolve(dir))) {
    response.writeHead(403, { 'Access-Control-Allow-Origin': '*' });
    response.end('forbidden');
    return;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    response.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    response.end('not found');
    return;
  }

  const size = fs.statSync(target).size;
  const mime = MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
  const range = request.headers.range;
  const common = {
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
    'Content-Type': mime,
  };

  if (range !== undefined) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match?.[1] === '' || match?.[1] === undefined ? 0 : Number(match[1]);
    const end = match?.[2] === '' || match?.[2] === undefined ? size - 1 : Number(match[2]);
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
      response.writeHead(416, { ...common, 'Content-Range': `bytes */${size}` });
      response.end();
      return;
    }
    response.writeHead(206, {
      ...common,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
    });
    fs.createReadStream(target, { start, end }).pipe(response);
    return;
  }

  response.writeHead(200, { ...common, 'Content-Length': String(size) });
  fs.createReadStream(target).pipe(response);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`媒体服务器：${dir}`);
  console.log(`共 ${files.length} 个文件，打开 http://127.0.0.1:${port}/ 可浏览`);
  console.log(`最近的一个：${urlOf(files[0])}`);
  console.log(`用法：编辑器地址后面加 ?src=<上面的 URL>`);
});
