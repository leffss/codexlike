// E2E 冒烟（工单 02 + 03 扩展）：启动真实 Electron 应用走最小路径——
// 预置 Provider Profile（指向本地 OpenAI 兼容 mock SSE server）→ 新建会话（固定工作区）
// → 消息往返（第一轮返回 tool_call：真实执行 write_file → 结果回填 → 第二轮流式 markdown）
// → 工具卡片出现并可展开 → 重启应用断言会话列表、消息历史与工具卡片恢复。
// 运行：pnpm test:e2e（先全仓 build，再用生产产物启动）。
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const DESKTOP_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
// pnpm 隔离下 playwright-core 自解析 electron 不可靠，显式指定本包依赖的 Electron 二进制
const ELECTRON_BIN = require('electron');

/** 极简断言 */
function assert(condition, message) {
  if (!condition) {
    throw new Error(`断言失败：${message}`);
  }
}

/**
 * 本地 OpenAI 兼容 mock：第 1 次 /chat/completions 返回 tool_call（write_file），
 * 第 2 次返回 tool_call（web_search），之后返回流式 markdown（含代码块）——
 * 覆盖「工具调用 → 执行 → 回填 → 最终回复」全链路。
 * 另提供 Tavily 兼容的 POST /search 端点（记录请求体供断言），经 CODEXLIKE_TAVILY_URL 注入主进程。
 */
function startMockProvider() {
  const textChunks = [
    '你好！这是一个示例：\n\n',
    '```ts\n',
    'const answer = 42;\n',
    '```\n',
  ];
  let requestCount = 0;
  /** /search 收到的请求体（断言 api_key + query 真实进入请求） */
  const searchRequests = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/search') {
      let body = '';
      req.on('data', (chunk) => {
        body += String(chunk);
      });
      req.on('end', () => {
        searchRequests.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            query: 'tavily',
            results: [
              {
                title: 'Tavily Search API',
                url: 'https://docs.tavily.com',
                content: 'Search API for AI agents.',
              },
            ],
          }),
        );
      });
      return;
    }
    if (req.method === 'POST' && req.url !== undefined && req.url.endsWith('/chat/completions')) {
      requestCount += 1;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      const send = (payload) =>
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-e2e',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'mock-model',
            choices: [{ index: 0, ...payload }],
          })}\n\n`,
        );
      const finishWith = (reason) => {
        send({ delta: {}, finish_reason: reason });
        res.write('data: [DONE]\n\n');
        res.end();
      };

      const toolCallRound = (callId, name, args) => {
        send({
          delta: {
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        });
        setTimeout(() => finishWith('tool_calls'), 30);
      };

      if (requestCount === 1) {
        // 第一轮：发起 write_file 工具调用（agent 会真实写文件并把结果回填）
        toolCallRound('call-e2e', 'write_file', { path: 'e2e.txt', content: '工具链路 OK' });
        return;
      }
      if (requestCount === 2) {
        // 第二轮：发起 web_search 工具调用（agent 会真实请求 /search mock 并把结果回填）
        toolCallRound('call-search', 'web_search', { query: 'tavily search api' });
        return;
      }

      let index = 0;
      const timer = setInterval(() => {
        if (index < textChunks.length) {
          send({ delta: { content: textChunks[index++] }, finish_reason: null });
          return;
        }
        clearInterval(timer);
        finishWith('stop');
      }, 30);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      resolveServer({ server, port: server.address().port, searchRequests });
    });
  });
}

async function launchApp(homeDir, tavilyUrl) {
  const env = {
    ...process.env,
    CODEXLIKE_HOME: homeDir,
    CODEXLIKE_TEST_WORKSPACE: join(homeDir, 'workspace'),
    CODEXLIKE_TAVILY_URL: tavilyUrl,
    // 生产模式：不带 VITE_DEV_SERVER_URL，主进程以 file:// 加载 ui/dist
    VITE_DEV_SERVER_URL: '',
  };
  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: [DESKTOP_DIR],
    env,
  });
  app.process().stdout?.on('data', (chunk) => console.log(`[main] ${String(chunk).trimEnd()}`));
  app.process().stderr?.on('data', (chunk) => console.error(`[main:err] ${String(chunk).trimEnd()}`));
  const window = await app.firstWindow();
  window.on('console', (message) => {
    if (message.type() === 'error') {
      console.log(`[renderer console.error] ${message.text()}`);
    }
  });
  return { app, window };
}

async function main() {
  const { server, port, searchRequests } = await startMockProvider();
  const homeDir = mkdtempSync(join(tmpdir(), 'codexlike-e2e-'));
  // 预置工作区目录（CODEXLIKE_TEST_WORKSPACE 钩子返回它）
  mkdirSync(join(homeDir, 'workspace'));
  const tavilyUrl = `http://127.0.0.1:${port}/search`;

  let app;
  try {
    // 1) 启动 → 设置页创建 Profile（baseURL 指向本地 mock）+ 配置搜索源 key
    const first = await launchApp(homeDir, tavilyUrl);
    app = first.app;
    let window = first.window;
    await window.getByRole('button', { name: '设置', exact: true }).click();
    await window.getByRole('button', { name: '+ 新建 Profile' }).click();
    const profileForm = window.locator('form');
    await profileForm.getByLabel('名称').fill('Mock');
    await profileForm.getByLabel('baseURL').fill(`http://127.0.0.1:${port}/v1`);
    await profileForm.getByLabel('API Key').fill('sk-e2e');
    await profileForm.getByLabel('模型').fill('mock-model');
    // 设置页现在有两个「保存」按钮（Profile 表单与搜索源区），限定在表单内点击
    await window
      .locator('form')
      .getByRole('button', { name: /保存|创建/ })
      .click();
    await window.getByText('Mock').first().waitFor();
    console.log('[e2e] Provider Profile 已创建（真实 safeStorage 加密落盘）');

    // 1b) 搜索源配置：填 Tavily key 保存 → 状态变「已配置」（key 加密落盘）
    await window.getByTestId('search-api-key-input').fill('tvly-e2e-key');
    await window.getByTestId('search-api-key-save').click();
    await window.getByText('已配置').first().waitFor();
    const searchSettingsRaw = readFileSync(
      join(homeDir, 'search-settings.json'),
      'utf8',
    );
    assert(
      !searchSettingsRaw.includes('tvly-e2e-key'),
      '搜索 key 明文落盘（search-settings.json 含原始 key）',
    );
    console.log('[e2e] 搜索源已配置（真实 safeStorage 加密落盘）');

    // 2) 返回工作台 → 新建会话（目录选择器经 CODEXLIKE_TEST_WORKSPACE 钩子固定）
    await window.getByRole('button', { name: '返回工作台' }).click();
    await window.getByTestId('new-session').click();
    try {
      await window.getByTestId('session-item').first().waitFor({ timeout: 10_000 });
    } catch (error) {
      const errorCards = await window.getByTestId('message-error').allTextContents();
      console.error('[e2e:debug] 消息流错误卡片：', errorCards);
      throw error;
    }
    console.log('[e2e] 会话已创建并选中');

    // 3) 发送消息 → 模型先调 write_file（真实执行）→ 结果回填 → 最终流式 markdown
    await window.getByTestId('composer-input').fill('创建 e2e.txt，并给出一个 TypeScript 代码块');
    await window.getByTestId('composer-send').click();

    // 工具卡片出现（折叠态：工具名 + 参数摘要），点击展开可见完整输出
    const card = window.getByTestId('tool-call-card').first();
    await card.waitFor({ timeout: 20_000 });
    assert((await card.getAttribute('data-tool-name')) === 'write_file', '工具卡片未显示 write_file');
    await card.getByTestId('tool-call-toggle').click();
    await card.getByText('已写入 e2e.txt').waitFor({ timeout: 10_000 });
    console.log('[e2e] 工具卡片渲染：write_file 摘要 + 可展开完整输出');

    // 工具真实执行：工作区内文件已写入
    const writtenPath = join(homeDir, 'workspace', 'e2e.txt');
    await new Promise((r) => setTimeout(r, 500));
    assert(existsSync(writtenPath), `工具未真实写入 ${writtenPath}`);
    assert(readFileSync(writtenPath, 'utf8') === '工具链路 OK', '工具写入内容不正确');

    await window
      .getByTestId('message-assistant')
      .getByText('const answer = 42;')
      .waitFor({ timeout: 20_000 });
    const highlighted = await window
      .locator('[data-testid="message-assistant"] pre code.hljs')
      .count();
    assert(highlighted >= 1, '代码块未渲染 highlight.js 高亮');
    const userText = await window.getByTestId('message-user').first().textContent();
    assert(
      userText !== null && userText.includes('创建 e2e.txt'),
      '用户消息未出现在消息流',
    );
    console.log('[e2e] 消息往返完成：工具调用 + 流式 markdown + 代码块高亮可见');

    // 3b) 第二条消息：模型发起 web_search → 主进程真实请求 /search mock → 结果回填 → 卡片渲染
    // （click 自带 actionability 等待：上一轮流式结束后按钮重新可用才触发）
    await window.getByTestId('composer-input').fill('搜一下 tavily search api');
    await window.getByTestId('composer-send').click();
    const searchCard = window.getByTestId('tool-call-card').filter({
      hasText: 'web_search',
    });
    await searchCard.waitFor({ timeout: 20_000 });
    await searchCard.getByTestId('tool-call-toggle').click();
    // 展开后的输出区含「标题 / URL / 摘要」三要素
    const searchOutput = searchCard.getByTestId('tool-call-output');
    await searchOutput.waitFor({ timeout: 10_000 });
    const searchText = await searchOutput.textContent();
    assert(
      searchText !== null &&
        searchText.includes('Tavily Search API') &&
        searchText.includes('https://docs.tavily.com') &&
        searchText.includes('Search API for AI agents.'),
      `web_search 卡片输出不完整：${searchText ?? '(空)'}`,
    );
    // mock 端真实收到了 api_key + query（请求形态与设置页保存的 key 一致）
    await new Promise((r) => setTimeout(r, 300));
    assert(searchRequests.length >= 1, '搜索请求未到达 mock /search 端点');
    assert(
      searchRequests[0]?.api_key === 'tvly-e2e-key' &&
        searchRequests[0]?.query === 'tavily search api',
      `搜索请求体不正确：${JSON.stringify(searchRequests[0])}`,
    );
    console.log('[e2e] web_search 全链路：key 配置 → 工具调用 → mock 搜索 → 卡片可展开');

    // 4) 关闭 → 重启（等价应用重启）：侧栏会话列表、消息历史与工具卡片完整恢复
    await app.close();
    const second = await launchApp(homeDir, tavilyUrl);
    app = second.app;
    window = second.window;
    await window.getByTestId('session-item').first().waitFor({ timeout: 15_000 });
    await window.getByTestId('session-item').first().click();
    await window.getByTestId('message-user').first().waitFor({ timeout: 10_000 });
    const restored = await window.getByTestId('message-assistant').count();
    assert(restored >= 1, '重启后助手消息历史未恢复');
    const restoredCards = await window.getByTestId('tool-call-card').count();
    assert(restoredCards >= 1, '重启后工具卡片未恢复');
    console.log('[e2e] 重启后侧栏会话列表、消息历史与工具卡片完整恢复');

    await app.close();
    console.log('[e2e] 冒烟通过 ✅');
  } catch (error) {
    console.error('[e2e] 冒烟失败 ❌', error);
    process.exitCode = 1;
    try {
      await app?.close();
    } catch {
      // 已关闭
    }
  } finally {
    server.close();
    rmSync(homeDir, { recursive: true, force: true });
  }
}

await main();
