// E2E（工单 06）：会话打断（停止按钮）+ 中断点跨重启恢复的真实应用冒烟。
// 路径：设置页建 Profile（本地 mock SSE）→ 建会话
// ① 流式输出中点停止 → 本轮立即中断、UI 标记中断点
// ② 中断后继续发新消息 → 正常完成回复
// ③ 工具执行中（sleep 30 长命令）点停止 → 子进程被杀、结果标记用户中断、无后续模型请求
// ④ 重启应用 → 中断标记与工具卡片完整恢复。
// 运行：pnpm --filter @codexlike/desktop run test:e2e:interrupt（先 pnpm build）。
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

/**
 * 本地 OpenAI 兼容 mock（按请求序号脚本化）：
 * ① 慢速流式（长文分段，供流式中途点停止）；
 * ② 中断后的新消息 → 快速完整回复；
 * ③ run_terminal_command 长命令（sleep 30）tool_call → 工具执行中点停止。
 * ④ 不应存在（中断后模型不再被请求）——requestCount 断言。
 */
function startMockProvider() {
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      if (req.method === 'POST' && req.url !== undefined && req.url.endsWith('/chat/completions')) {
        requestCount += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
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

        // 客户端中断（abort）后 res.write 会失败：监听 close 停止慢速发送
        let timer = null;
        res.on('close', () => {
          if (timer !== null) clearInterval(timer);
        });

        if (requestCount === 1) {
          // ① 慢速流式：20 段、每段 300ms（共 6 秒），保证点击停止时仍在输出
          let index = 0;
          timer = setInterval(() => {
            try {
              send({ delta: { content: `第${index}段长文。` }, finish_reason: null });
              index += 1;
              if (index >= 20) {
                clearInterval(timer);
                finishWith('stop');
              }
            } catch {
              clearInterval(timer);
            }
          }, 300);
          return;
        }

        if (requestCount === 2) {
          // ② 中断后的新消息：快速完整回复
          send({ delta: { content: '中断后的新回答。' }, finish_reason: null });
          finishWith('stop');
          return;
        }

        if (requestCount === 3) {
          // ③ 工具调用：长命令（sleep 30），供执行中点停止
          send({
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-sleep',
                  type: 'function',
                  function: {
                    name: 'run_terminal_command',
                    arguments: JSON.stringify({ command: 'echo started; sleep 30', timeoutMs: 120000 }),
                  },
                },
              ],
            },
            finish_reason: null,
          });
          setTimeout(() => finishWith('tool_calls'), 30);
          return;
        }

        // ④ 中断后模型不应再被请求
        send({ delta: { content: '（不应被请求）' }, finish_reason: null });
        finishWith('stop');
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
  });
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      resolveServer({ server, port: server.address().port, getRequestCount: () => requestCount });
    });
  });
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
  const { server, port, getRequestCount } = await startMockProvider();
  const homeDir = mkdtempSync(join(tmpdir(), 'codexlike-e2e-stop-'));
  mkdirSync(join(homeDir, 'workspace'));

  let app;
  try {
    // 0) 启动 → 设置页创建 Profile（指向本地 mock）
    const first = await launchApp(homeDir);
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
    await window.getByRole('button', { name: '返回工作台' }).click();

    // ① 流式输出中点停止：本轮立即中断，UI 标记中断点
    await window.getByTestId('new-session').click();
    await window.getByTestId('session-item').first().waitFor({ timeout: 10_000 });
    await window.getByTestId('composer-input').fill('慢慢写一篇长文');
    await window.getByTestId('composer-send').click();
    // 等流式文本真正开始（停止才有「部分内容保留」可断言）
    await window.getByTestId('message-assistant').getByText('第0段长文').waitFor({ timeout: 15_000 });
    await window.getByTestId('composer-stop').click();

    await window.getByText('（已中断，以上为部分回复）').waitFor({ timeout: 10_000 });
    const partial = await window.getByTestId('message-assistant').first().textContent();
    assert(partial !== null && !partial.includes('第19段长文'), '中断后不应出现完整 20 段');
    // 中断后发送按钮回来（streaming 复位），输入框恢复可用
    await window.getByTestId('composer-send').waitFor({ timeout: 10_000 });
    console.log('[e2e] 流式中断：立即停止，UI 标记中断点，输入区恢复');

    // ② 中断后继续发新消息：正常完成（上下文含中断前历史）
    await window.getByTestId('composer-input').fill('中断后再问一句');
    await window.getByTestId('composer-send').click();
    await window.getByText('中断后的新回答。').waitFor({ timeout: 15_000 });
    console.log('[e2e] 中断后继续发新消息：正常完成回复');

    // ③ 工具执行中点停止：长命令子进程被杀，结果标记用户中断
    await window.getByTestId('composer-input').fill('跑个长命令');
    await window.getByTestId('composer-send').click();
    const card = window.getByTestId('tool-call-card').first();
    await card.waitFor({ timeout: 20_000 });
    assert(
      (await card.getAttribute('data-tool-name')) === 'run_terminal_command',
      '工具卡片未显示 run_terminal_command',
    );
    // 审批门（工单 04）：suggest 档命令先弹审批卡片；批准后长命令才开始执行，
    // 停止因此落在执行中（子进程被杀），而非等待审批时（等待中停止视为拒绝）
    const approvalCard = window.getByTestId('approval-card').first();
    await approvalCard.waitFor({ timeout: 10_000 });
    await approvalCard.getByTestId('approval-approve').click();
    const stopAt = Date.now();
    await window.getByTestId('composer-stop').click();
    // 工具结果回流：卡片展开可见「已被用户中断」（子进程树被杀，不会等满 30 秒）
    await card.getByTestId('tool-call-toggle').click();
    await card.getByText('已被用户中断').waitFor({ timeout: 15_000 });
    const stoppedIn = Date.now() - stopAt;
    assert(stoppedIn < 15_000, `中断未即时生效（耗时 ${stoppedIn}ms）`);
    // 本轮终止：中断标记出现（assistant-aborted）
    await window.getByText('（已中断，以上为部分回复）').nth(1).waitFor({ timeout: 10_000 });
    console.log('[e2e] 工具执行中停止：子进程被杀，结果标记用户中断');

    // 中断后模型不再被请求（第 4 次请求不应发生）
    await new Promise((r) => setTimeout(r, 800));
    assert(getRequestCount() === 3, `工具中断后不应再有模型请求（实际 ${getRequestCount()} 次）`);
    // 中断后输入区再次恢复
    await window.getByTestId('composer-send').waitFor({ timeout: 10_000 });

    // ④ 重启应用：中断标记与工具卡片完整恢复
    await app.close();
    const second = await launchApp(homeDir);
    app = second.app;
    window = second.window;
    await window.getByTestId('session-item').first().waitFor({ timeout: 15_000 });
    await window.getByTestId('session-item').first().click();
    await window.getByTestId('message-user').first().waitFor({ timeout: 10_000 });
    const restoredMarks = await window.getByText('（已中断，以上为部分回复）').count();
    assert(restoredMarks >= 2, '重启后中断点标记未恢复');
    const restoredCards = await window.getByTestId('tool-call-card').count();
    assert(restoredCards >= 1, '重启后工具卡片未恢复');
    const restoredCard = window.getByTestId('tool-call-card').first();
    await restoredCard.getByTestId('tool-call-toggle').click();
    await restoredCard.getByText('已被用户中断').waitFor({ timeout: 10_000 });
    console.log('[e2e] 重启恢复：中断标记与工具卡片（含中断结果）完整还原');

    await app.close();
    console.log('[e2e] 打断冒烟通过 ✅');
  } catch (error) {
    console.error('[e2e] 打断冒烟失败 ❌', error);
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
