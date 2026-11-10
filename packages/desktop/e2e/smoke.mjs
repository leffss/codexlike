// E2E 冒烟（工单 02）：启动真实 Electron 应用走最小路径——
// 预置 Provider Profile（指向本地 OpenAI 兼容 mock SSE server）→ 新建会话（固定工作区）
// → 消息往返（流式 markdown + 代码块高亮）→ 重启应用断言会话列表与历史恢复。
// 运行：pnpm test:e2e（先全仓 build，再用生产产物启动）。
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

/** 本地 OpenAI 兼容 mock：/v1/chat/completions 返回流式 markdown（含代码块） */
function startMockProvider() {
  const chunks = [
    '你好！这是一个示例：\n\n',
    '```ts\n',
    'const answer = 42;\n',
    '```\n',
  ];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url !== undefined && req.url.endsWith('/chat/completions')) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      let index = 0;
      const timer = setInterval(() => {
        if (index < chunks.length) {
          const delta = chunks[index++];
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-e2e',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'mock-model',
              choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
            })}\n\n`,
          );
          return;
        }
        clearInterval(timer);
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-e2e',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'mock-model',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
      }, 30);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      resolveServer({ server, port: server.address().port });
    });
  });
}

async function launchApp(homeDir) {
  const env = {
    ...process.env,
    CODEXLIKE_HOME: homeDir,
    CODEXLIKE_TEST_WORKSPACE: join(homeDir, 'workspace'),
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
  const { server, port } = await startMockProvider();
  const homeDir = mkdtempSync(join(tmpdir(), 'codexlike-e2e-'));
  // 预置工作区目录（CODEXLIKE_TEST_WORKSPACE 钩子返回它）
  mkdirSync(join(homeDir, 'workspace'));

  let app;
  try {
    // 1) 启动 → 设置页创建 Profile（baseURL 指向本地 mock）
    const first = await launchApp(homeDir);
    app = first.app;
    let window = first.window;
    await window.getByRole('button', { name: '设置', exact: true }).click();
    await window.getByRole('button', { name: '+ 新建 Profile' }).click();
    await window.getByLabel('名称').fill('Mock');
    await window.getByLabel('baseURL').fill(`http://127.0.0.1:${port}/v1`);
    await window.getByLabel('API Key').fill('sk-e2e');
    await window.getByLabel('模型').fill('mock-model');
    await window.getByRole('button', { name: /保存|创建/ }).click();
    await window.getByText('Mock').first().waitFor();
    console.log('[e2e] Provider Profile 已创建（真实 safeStorage 加密落盘）');

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

    // 3) 发送消息 → 流式渲染 markdown，代码块高亮
    await window.getByTestId('composer-input').fill('打个招呼，并给出一个 TypeScript 代码块');
    await window.getByTestId('composer-send').click();
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
      userText !== null && userText.includes('打个招呼'),
      '用户消息未出现在消息流',
    );
    console.log('[e2e] 消息往返完成：流式 markdown + 代码块高亮可见');

    // 4) 关闭 → 重启（等价应用重启）：侧栏会话列表与消息历史完整恢复
    await app.close();
    const second = await launchApp(homeDir);
    app = second.app;
    window = second.window;
    await window.getByTestId('session-item').first().waitFor({ timeout: 15_000 });
    await window.getByTestId('session-item').first().click();
    await window.getByTestId('message-user').first().waitFor({ timeout: 10_000 });
    const restored = await window.getByTestId('message-assistant').count();
    assert(restored >= 1, '重启后助手消息历史未恢复');
    console.log('[e2e] 重启后侧栏会话列表与消息历史完整恢复');

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
