/**
 * 云 LLM 通道单测（mock fetch，**不依赖真实云环境**）。
 *
 * 覆盖：
 *   ① 请求正确性（URL / headers / body / 系统提示词）
 *   ② 成功时返回 text
 *   ③ 401/403 时触发 onUnauthorized + 抛错（宿主 provider 会 catch 并降级）
 *   ④ 非 2xx 时触发 onError + 抛错
 *   ⑤ 空文本时抛错
 *   ⑥ 完整链路：createCloudLLMModel → createHostProvider → 拿到 message + intents
 *
 * 运行：`node tests/cloud-llm.test.mjs`
 */
import { buildSync } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const out = path.join(ROOT, 'tests', '.tmp', 'cloudLLM.mjs');
buildSync({
  absWorkingDir: ROOT,
  entryPoints: ['src/ai/cloudLLM.ts'],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  logLevel: 'silent',
});
const { createCloudLLMModel } = await import(pathToFileURL(out).href + '?t=' + Date.now());

const report = { passed: 0, failed: 0, failures: [] };
function check(name, cond, detail = '') {
  if (cond) {
    report.passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    report.failed += 1;
    report.failures.push(name);
    console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`);
  }
}

/** Mock fetch：记录请求，按预设返回响应。 */
function mockFetch(impl) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return impl(url, init);
  };
  return {
    calls,
    restore: () => { globalThis.fetch = original; },
  };
}

const CONFIG = {
  endpoint: 'https://test.workbuddy.cn/',
  publishableKey: 'wb_pk_test123',
  model: 'gpt-4o-mini',
};

// ---------------- ① 请求正确性 ----------------
{
  const m = mockFetch(() => Promise.resolve(
    new Response(JSON.stringify({ choices: [{ message: { content: '{"message":"ok","intents":[]}' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ));
  const model = createCloudLLMModel(CONFIG);
  await model.complete({ prompt: '把这段剪短', context: { fps: 30 } });
  const call = m.calls[0];
  check(
    '① URL 是 /.cloud/llm/chat/completions',
    call.url === 'https://test.workbuddy.cn/.cloud/llm/chat/completions',
    call.url,
  );
  check('① Content-Type: application/json', call.init.headers['Content-Type'] === 'application/json');
  check('① Authorization 带 Bearer', call.init.headers.Authorization === 'Bearer wb_pk_test123');
  const body = JSON.parse(call.init.body);
  check('① body.model 正确', body.model === 'gpt-4o-mini');
  check('① body.stream === false', body.stream === false);
  check(
    '① messages 含 system 与 user',
    body.messages.length === 2 && body.messages[0].role === 'system' && body.messages[1].role === 'user',
  );
  check(
    '① user 消息带 <project-context>',
    body.messages[1].content.includes('<project-context>') && body.messages[1].content.includes('"fps":30'),
  );
  m.restore();
}

// ---------------- ② 成功时返回 text ----------------
{
  const m = mockFetch(() => Promise.resolve(
    new Response(JSON.stringify({ choices: [{ message: { content: '{"message":"ok","intents":[]}' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ));
  const model = createCloudLLMModel(CONFIG);
  const result = await model.complete({ prompt: '测试', context: {} });
  check('② 返回 text', result.text === '{"message":"ok","intents":[]}');
  m.restore();
}

// ---------------- ③ 401 触发 onUnauthorized ----------------
{
  let unauthorizedCalled = false;
  const m = mockFetch(() => Promise.resolve(new Response('unauthorized', { status: 401 })));
  const model = createCloudLLMModel({ ...CONFIG, onUnauthorized: () => { unauthorizedCalled = true; } });
  let threw = false;
  try {
    await model.complete({ prompt: 'x', context: {} });
  } catch (error) {
    threw = true;
    check('③ 抛出的错误含"未授权"', String(error).includes('未授权'));
  }
  check('③ 401 抛错', threw);
  check('③ onUnauthorized 被调用', unauthorizedCalled);
  m.restore();
}

// ---------------- ④ 非 2xx 触发 onError ----------------
{
  let errorStatus = 0;
  const m = mockFetch(() => Promise.resolve(new Response('server error', { status: 500 })));
  const model = createCloudLLMModel({ ...CONFIG, onError: (status) => { errorStatus = status; } });
  let threw = false;
  try {
    await model.complete({ prompt: 'x', context: {} });
  } catch {
    threw = true;
  }
  check('④ 500 抛错', threw);
  check('④ onError 收到 500', errorStatus === 500);
  m.restore();
}

// ---------------- ⑤ 空文本抛错 ----------------
{
  const m = mockFetch(() => Promise.resolve(
    new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ));
  const model = createCloudLLMModel(CONFIG);
  let threw = false;
  try {
    await model.complete({ prompt: 'x', context: {} });
  } catch (error) {
    threw = true;
    check('⑤ 空文本抛错信息含"空文本"', String(error).includes('空文本'));
  }
  check('⑤ 空文本抛错', threw);
  m.restore();
}

// ---------------- ⑥ 完整链路（host provider） ----------------
{
  // 单独编译 host provider（它依赖 ai/registry 等，单独 bundle）
  const providerOut = path.join(ROOT, 'tests', '.tmp', 'hostProvider.mjs');
  buildSync({
    absWorkingDir: ROOT,
    entryPoints: ['src/ai/provider.ts'],
    outfile: providerOut,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
  });
  const { createHostProvider } = await import(pathToFileURL(providerOut).href + '?t=' + Date.now());

  const m = mockFetch(() => Promise.resolve(
    new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            message: '我建议把这段剪短',
            // AIIntent 的字段名是 kind（不是 type），frame/label 也对应
            intents: [{ kind: 'suggestCut', frame: 30, label: '节奏' }],
          }),
        },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ));
  const provider = createHostProvider(createCloudLLMModel(CONFIG));
  const result = await provider.complete({
    text: '把这段剪短',
    tone: 'suggest',
    doc: { tracks: [] },
    selectedClipId: null,
    playheadFrame: 0,
  });
  check('⑥ 链路成功', result.ok);
  if (result.ok) {
    check('⑥ message 正确', result.value.message === '我建议把这段剪短');
    check('⑥ intents 正确', result.value.intents.length === 1 && result.value.intents[0].kind === 'suggestCut');
  }
  m.restore();
}

console.log('');
if (report.failed === 0) {
  console.log(`✓ 云 LLM 通道单测：通过 ${report.passed} / ${report.passed}`);
  process.exit(0);
} else {
  console.log(`✗ 云 LLM 通道单测：${report.failed} 项失败`);
  for (const name of report.failures) console.log(`  - ${name}`);
  process.exit(1);
}
