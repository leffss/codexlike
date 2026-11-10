// E2E 浏览器工具（工单 11）：启动真实 Electron 应用 → mock 模型依次调用
// browser_navigate（打开本 E2E 自带的 fixture 页）→ browser_screenshot（整页截图）
// → 最终文本。断言：工具卡片渲染、截图真实落盘到会话数据目录、截图卡片内嵌图片
// （IPC 读回 dataURL）回填给模型的 tool result 为文本降级（未设附图开关）。
// 运行：pnpm test:e2e:browser（先全仓 build；本机需已有 Chromium 缓存或首次自动下载）。
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const DESKTOP_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const ELECTRON_BIN = require('electron');

function assert(condition, message) {
  if (!condition) {
    throw new Error(`断言失败：${message}`);
  }
}

/** 关闭应用：优雅关闭优先；Electron 45 上偶发不退（功能断言已过后进程挂着），10 秒后强杀兜底 */
async function closeApp(app) {
  const forceKill = setTimeout(() => {
    try {
      app.process().kill();
    } catch {}
  }, 10_000);
  try {
    await app.close();
  } catch {
    // 优雅关闭失败（可能已被强杀）：断言已全部完成，继续收尾
  } finally {
    clearTimeout(forceKill);
  }
}
/** 浏览器工具要抓取的 fixture 页（标题与正文唯一，便于断言） */
const FIXTURE_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>E2E 浏览器页</title></head>
<body><h1>浏览器工具 E2E</h1><p>fixture 正文内容 browser-e2e-ok</p></body></html>`;

/**
 * 一个端口同时提供：
 * - GET /page：浏览器 fixture 页
 * - POST /v1/chat/completions：OpenAI 兼容 mock——第 1 轮 browser_navigate、
 *   第 2 轮 browser_screenshot、之后流式文本；记录每轮请求体供断言。
 */
async function startServers() {
  const receivedBodies = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
      return;
    }
    if (req.method === 'POST' && req.url !== undefined && req.url.endsWith('/chat/completions')) {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        receivedBodies.push(body);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const send = (payload) =>
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-e2e-browser',
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

        const toolCall = (id, name, args) => {
          send({
            delta: {
              tool_calls: [
                { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
              ],
            },
            finish_reason: null,
          });
          setTimeout(() => finishWith('tool_calls'), 30);
        };

        const round = receivedBodies.length;
        if (round === 1) {
          toolCall('call-e2e-nav', 'browser_navigate', { url: `http://127.0.0.1:${server.address().port}/page` });
          return;
        }
        if (round === 2) {
          toolCall('call-e2e-shot', 'browser_screenshot', {});
          return;
        }
        const chunks = ['截图已收到，', '浏览器工具链路 OK'];
        let index = 0;
        const timer = setInterval(() => {
          if (index < chunks.length) {
            send({ delta: { content: chunks[index++] }, finish_reason: null });
            return;
          }
          clearInterval(timer);
          finishWith('stop');
        }, 30);
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port, receivedBodies };
}

async function launchApp(homeDir) {
  const env = {
    ...process.env,
    CODEXLIKE_HOME: homeDir,
    CODEXLIKE_TEST_WORKSPACE: join(homeDir, 'workspace'),
    VITE_DEV_SERVER_URL: '',
  };
  const app = await electron.launch({ executablePath: ELECTRON_BIN, args: [DESKTOP_DIR], env });
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
  const { server, port, receivedBodies } = await startServers();
  const homeDir = mkdtempSync(join(tmpdir(), 'codexlike-e2e-browser-'));
  mkdirSync(join(homeDir, 'workspace'));

  let app;
  try {
    // 1) 预置 Profile + 建会话
    const launched = await launchApp(homeDir);
    app = launched.app;
    const window = launched.window;
    await window.getByRole('button', { name: '设置', exact: true }).click();
    await window.getByRole('button', { name: '+ 新建 Profile' }).click();
    const profileForm = window.locator('form');
    await profileForm.getByLabel('名称').fill('Mock');
    await profileForm.getByLabel('baseURL').fill(`http://127.0.0.1:${port}/v1`);
    await profileForm.getByLabel('API Key').fill('sk-e2e');
    await profileForm.getByLabel('模型').fill('mock-model');
    // 设置页有多个「保存」按钮（Profile 表单与搜索源区），限定在表单内点击
    await profileForm
      .getByRole('button', { name: /保存|创建/ })
      .click();
    await window.getByText('Mock').first().waitFor();
    await window.getByRole('button', { name: '返回工作台' }).click();
    await window.getByTestId('new-session').click();
    // 新建会话对话框（工单 09）：默认本目录直跑，点确认
    await window.getByTestId('create-session-confirm').click();
    await window.getByTestId('session-item').first().waitFor({ timeout: 10_000 });
    console.log('[e2e] 应用启动、Profile 与会话就绪');

    // 2) 发消息 → mock 模型依次调 navigate / screenshot
    await window.getByTestId('composer-input').fill('打开 fixture 页并截图');
    await window.getByTestId('composer-send').click();

    // navigate 卡片：真实 Chromium 打开 fixture，输出含页面标题
    const navCard = window.locator('[data-testid="tool-call-card"][data-tool-name="browser_navigate"]');
    await navCard.waitFor({ timeout: 60_000 });
    await navCard.getByTestId('tool-call-toggle').click();
    await navCard.getByText('已打开「E2E 浏览器页」').waitFor({ timeout: 20_000 });
    console.log('[e2e] browser_navigate 在 Electron 主进程内真实执行');

    // screenshot 卡片：输出含保存路径，且卡片内嵌截图图片（IPC 读回 dataURL）
    const shotCard = window.locator('[data-testid="tool-call-card"][data-tool-name="browser_screenshot"]');
    await shotCard.waitFor({ timeout: 60_000 });
    await shotCard.getByTestId('tool-call-toggle').click();
    await shotCard.getByText('整页截图已保存').waitFor({ timeout: 20_000 });
    await shotCard.getByTestId('tool-call-screenshot').waitFor({ timeout: 20_000 });
    console.log('[e2e] 截图卡片内嵌图片渲染（写盘 → toolImage IPC → img）');

    // 3) 截图真实落盘到会话数据目录（约定路径）
    const sessionsDir = join(homeDir, 'sessions');
    const shotFile = await (async () => {
      const fs = await import('node:fs');
      for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = join(sessionsDir, entry.name, 'screenshots', 'call-e2e-shot.png');
        if (existsSync(candidate)) return candidate;
      }
      return null;
    })();
    assert(shotFile !== null, `截图未落盘到 ${sessionsDir}/*/screenshots/call-e2e-shot.png`);
    console.log(`[e2e] 截图已落盘：${shotFile}`);

    // 4) 最终回复可见；第三轮请求体里工具结果以文本回填（默认降级：无 image_url）
    await window
      .getByTestId('message-assistant')
      .getByText('浏览器工具链路 OK')
      .waitFor({ timeout: 30_000 });
    assert(receivedBodies.length >= 3, '模型请求数不足三轮');
    const third = receivedBodies[2];
    assert(third.includes('browser_screenshot'), '第三轮请求未回填截图工具结果');
    assert(third.includes('image_url') === false, '默认（未开附图开关）不应包含 image_url');
    console.log('[e2e] 工具结果以文本回填模型（降级路径）；最终回复可见');

    await closeApp(app);
    console.log('[e2e] 浏览器工具 E2E 通过 ✅');
  } catch (error) {
    console.error('[e2e] 浏览器工具 E2E 失败 ❌', error);
    process.exitCode = 1;
    try {
      await closeApp(app);
    } catch {
      // 已关闭
    }
  } finally {
    server.close();
    rmSync(homeDir, { recursive: true, force: true });
  }
}

await main();
