/**
 * 极简 CDP 驱动（T07/T08 浏览器验收用）。
 *
 * 为什么不用 playwright：项目 devDependencies 固定为 5 个，不引入额外依赖；
 * Node 24 自带全局 `WebSocket`，配合 `--remote-debugging-port=0` 足够跑 WebGL2 / AudioContext 验收。
 *
 * 用法：
 *   const { session, server, close } = await launchPage({ files, pageUrl });
 *   await session.evaluate('1 + 1');
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

function findBrowser() {
  for (const candidate of EDGE_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('找不到 Edge / Chrome 可执行文件');
}

/** 内存静态服务器：只服务测试页面与 bundle，绑定 127.0.0.1。 */
export function startServer(files) {
  const server = http.createServer((request, response) => {
    const url = (request.url ?? '/').split('?')[0];
    const entry = files.get(url);
    if (!entry) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(`not found: ${url}`);
      return;
    }
    response.writeHead(200, { 'Content-Type': entry.type });
    response.end(entry.body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

class CdpSession {
  constructor(webSocketUrl, pageUrl = '') {
    this.url = webSocketUrl;
    this.pageUrl = pageUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
  }

  open() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('CDP WebSocket 连接失败'));
      socket.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (typeof message.id === 'number' && this.pending.has(message.id)) {
          const { resolve: done, reject: fail } = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) fail(new Error(`CDP ${message.error.message}`));
          else done(message.result);
        }
      };
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 求值（自动 await Promise、按值返回）。 */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      const frames = result.exceptionDetails.stackTrace?.callFrames ?? [];
      const stack = frames
        .slice(0, 6)
        .map((frame) => `  at ${frame.functionName || '(anonymous)'} (${frame.url || '?'}:${frame.lineNumber + 1}:${frame.columnNumber + 1})`)
        .join('\n');
      throw new Error(
        `页面内异常：${description}\n页面：${this.pageUrl || '(unknown)'}${stack ? `\n堆栈：\n${stack}` : ''}`,
      );
    }
    return result.result.value;
  }

  /**
   * 轮询等待页面条件成立（避免"注入后立即求值"的竞态）。
   * 超时抛出带条件、页面 URL 与最后一次异常的明确错误。
   */
  async waitFor(expression, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const value = await this.evaluate(expression);
        if (value === true) return;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `等待页面条件超时（${timeoutMs}ms）：${expression}\n页面：${this.pageUrl || '(unknown)'}` +
        `\n最后一次异常：${lastError ? lastError.message : '无'}`,
    );
  }

  close() {
    try {
      this.socket?.close();
    } catch {
      // 忽略关闭异常
    }
  }
}

/** 启动无头 Edge，打开页面并返回 CDP 会话。 */
export async function launchPage({ url, width = 1440, height = 900 }) {
  const executable = findBrowser();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veditor-cdp-'));
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      `--window-size=${width},${height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-unsafe-swiftshader',
      // 无头下 rAF / 定时器会被"后台节流"，导致播放循环不推进 ——
      // 那样 E2E 就永远测不了"播放中/播放结束"这类状态（实测 playhead 卡在 100 不动）。
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
      url,
    ],
    { stdio: 'ignore' },
  );

  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + 20000;
  let port = 0;
  while (Date.now() < deadline) {
    if (fs.existsSync(portFile)) {
      const text = fs.readFileSync(portFile, 'utf8').split('\n');
      port = Number(text[0]);
      if (Number.isInteger(port) && port > 0) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!port) {
    child.kill();
    throw new Error('浏览器未能在 20 秒内启动调试端口');
  }

  let target = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      target = targets.find((item) => item.type === 'page' && typeof item.webSocketDebuggerUrl === 'string');
      if (target) break;
    } catch {
      // 浏览器还没就绪，重试
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!target) {
    child.kill();
    throw new Error('找不到可调试的页面 target');
  }

  const session = new CdpSession(target.webSocketDebuggerUrl, target.url);
  await session.open();

  // 等页面 load 完成
  let ready = false;
  while (Date.now() < deadline) {
    try {
      ready = await session.evaluate("document.readyState === 'complete'");
    } catch {
      ready = false;
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) {
    session.close();
    child.kill();
    throw new Error('页面未能在 20 秒内 load 完成');
  }

  /** 截取页面（CDP Page.captureScreenshot → PNG 写盘）。 */
  async function screenshot(options) {
    const result = await session.send('Page.captureScreenshot', { format: 'png' });
    if (!result || typeof result.data !== 'string') {
      throw new Error('截图失败：CDP 未返回图片数据');
    }
    const output = typeof options === 'string' ? options : options.path;
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, Buffer.from(result.data, 'base64'));
  }

  return {
    session,
    screenshot,
    close: async () => {
      session.close();
      child.kill();
      await new Promise((resolve) => setTimeout(resolve, 200));
      // Windows 上浏览器进程可能仍握着句柄：清理失败不影响验收结论
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        // 忽略：临时目录由 OS 回收
      }
    },
  };
}

/** 断言工具（与 Node 单测同一风格，输出可读）。 */
export function createReport() {
  const failures = [];
  const lines = [];
  return {
    check(name, condition, detail) {
      const ok = condition === true;
      lines.push(`${ok ? '  ✓' : '  ✗'} ${name}${detail === undefined ? '' : `  ${detail}`}`);
      if (!ok) failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`);
      return ok;
    },
    summary(title) {
      console.log(lines.join('\n'));
      if (failures.length > 0) {
        console.log(`\n✗ ${title}：${failures.length} 项失败`);
        for (const failure of failures) console.log(`  - ${failure}`);
        process.exitCode = 1;
        return false;
      }
      console.log(`\n✓ ${title}：全部通过`);
      return true;
    },
  };
}
