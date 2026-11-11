// E2E（工单 07）：斜杠命令 + @引用 + AGENTS.md 注入的真实应用冒烟。
// 路径：预置全局/项目 AGENTS.md 与工作区文件 → 设置页建 Profile（本地 mock SSE）
// → 建会话 → /status 展示 AGENTS.md 来源 → @引用 发消息并断言真实请求体
// 含 AGENTS.md 与被引用文件内容 → /rename /model /new /archive 逐一验证。
// 运行：pnpm --filter @codexlike/desktop run test:e2e:commands（先 pnpm build）。
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from 'playwright-core';
import { launchTarget } from './launch-target.mjs';


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
/** 本地 OpenAI 兼容 mock：记录请求体（断言 AGENTS.md / @引用 内容真实进入模型请求） */
function startMockProvider() {
  const seenBodies = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      if (req.method === 'POST' && req.url !== undefined && req.url.endsWith('/chat/completions')) {
        seenBodies.push(body);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created: 0, model: 'mock-model',
            choices: [{ index: 0, delta: { content: '收到。' }, finish_reason: 'stop' }],
          })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
  });
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      resolveServer({ server, port: server.address().port, seenBodies });
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
  const app = await electron.launch(launchTarget(env));
  app.process().stdout?.on('data', (chunk) => console.log(`[main] ${String(chunk).trimEnd()}`));
  app.process().stderr?.on('data', (chunk) => console.error(`[main:err] ${String(chunk).trimEnd()}`));
  const window = await app.firstWindow();
  return { app, window };
}

async function main() {
  const { server, port, seenBodies } = await startMockProvider();
  const homeDir = mkdtempSync(join(tmpdir(), 'codexlike-e2e-cmd-'));

  // 预置：全局 + 项目 AGENTS.md（/status 与请求体断言用）、@引用 目标文件
  mkdirSync(join(homeDir, 'workspace', 'src'), { recursive: true });
  writeFileSync(join(homeDir, 'AGENTS.md'), 'E2E全局规范标记XYZ');
  writeFileSync(join(homeDir, 'workspace', 'AGENTS.md'), 'E2E项目规范标记UVW');
  writeFileSync(join(homeDir, 'workspace', 'README.md'), 'README 内容：这是被 @引用 的文件。');
  writeFileSync(join(homeDir, 'workspace', 'src', 'app.ts'), 'export const app = 1;');

  let app;
  try {
    const { app: launchedApp, window } = await launchApp(homeDir);
    app = launchedApp;

    // 1) 设置页创建 Profile（本地 mock）
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

    // 2) 建会话（目录经 CODEXLIKE_TEST_WORKSPACE 钩子固定）
    await window.getByRole('button', { name: '返回工作台' }).click();
    await window.getByTestId('new-session').click();
    // 新建会话对话框：选运行位置（默认本目录直跑）
    await window.getByTestId('create-session-confirm').click();
    await window.getByTestId('session-item').first().waitFor({ timeout: 10_000 });

    const composer = window.getByTestId('composer-input');

    // 3) 斜杠命令菜单：输入 /st 弹菜单（模糊匹配 status），Enter 选中无参命令即执行
    await composer.fill('/st');
    const menu = window.getByTestId('composer-menu');
    await menu.waitFor({ timeout: 5_000 });
    assert((await menu.textContent())?.includes('/status') === true, '命令菜单未展示 /status');
    await composer.press('Enter'); // 选中 /status（无参命令）直接执行
    assert((await menu.count()) === 0, '执行后菜单应关闭');

    const statusCard = window.getByTestId('message-status').first();
    await statusCard.waitFor({ timeout: 10_000 });
    const statusText = await statusCard.textContent();
    // 尚未发消息：模型未记录属预期；用量与 AGENTS.md 来源必须展示
    assert(statusText?.includes('未选择') === true, `/status 未发消息前应显示未选择模型：${statusText}`);
    assert(statusText?.includes('tokens') === true, '/status 未显示 token 估算');
    assert(
      statusText?.includes('2 个来源') === true && statusText?.includes('AGENTS.md') === true,
      `/status 未显示 AGENTS.md 来源：${statusText}`,
    );
    console.log('[e2e] /status：用量估算 + AGENTS.md 来源可见');

    // 4) @引用 菜单：输入 @REA 模糊匹配 README.md，Enter 写回，发送后断言真实请求体
    await composer.fill('请阅读 @REA');
    await menu.waitFor({ timeout: 5_000 });
    assert((await menu.textContent())?.includes('README.md') === true, '@菜单未展示 README.md');
    await composer.press('Enter'); // 选中写回 @README.md
    assert(
      (await composer.inputValue()) === '请阅读 @README.md ',
      `@选中未写回输入框：${await composer.inputValue()}`,
    );
    await composer.pressSequentially('并总结', { delay: 10 });
    await window.getByTestId('composer-send').click();
    await window.getByTestId('message-user').first().waitFor({ timeout: 10_000 });
    // 等 mock 收到请求（回复完成后）
    await window.getByTestId('message-assistant').first().waitFor({ timeout: 20_000 });

    const requestBodies = seenBodies.join('\n');
    assert(
      requestBodies.includes('E2E全局规范标记XYZ') === true,
      '全局 AGENTS.md 未进入模型请求',
    );
    assert(
      requestBodies.includes('E2E项目规范标记UVW') === true,
      '项目 AGENTS.md 未进入模型请求',
    );
    assert(
      requestBodies.includes('README 内容：这是被 @引用 的文件。') === true,
      '@引用 文件内容未进入模型请求',
    );
    assert(requestBodies.includes('attached-file') === true, '@引用 未按 attached-file 结构附加');
    console.log('[e2e] @引用 与 AGENTS.md 内容真实进入模型请求体');

    // 4.5) 消息往返后再查 /status：模型已记录
    await composer.fill('/status');
    await composer.press('Enter');
    const statusAfter = window.getByTestId('message-status').nth(1);
    await statusAfter.waitFor({ timeout: 10_000 });
    const statusAfterText = await statusAfter.textContent();
    assert(statusAfterText?.includes('mock-model') === true, `/status 未显示已用模型：${statusAfterText}`);
    console.log('[e2e] /status：发送消息后显示所用模型');

    // 5) /rename：侧栏标题更新
    await composer.fill('/rename E2E改名会话');
    await composer.press('Enter');
    await window.getByTestId('session-item').filter({ hasText: 'E2E改名会话' }).waitFor({ timeout: 5_000 });
    console.log('[e2e] /rename：侧栏标题已更新');

    // 6) /model：唯一命中切换
    await composer.fill('/model Mock');
    await composer.press('Enter');
    await window.getByText('模型已切换：Mock · mock-model').waitFor({ timeout: 5_000 });
    console.log('[e2e] /model：模型切换提示可见');

    // 7) /new：同工作区新会话（侧栏两个会话）
    await composer.fill('/new');
    await composer.press('Enter');
    await window.getByTestId('composer-input').waitFor({ timeout: 5_000 });
    await window
      .getByTestId('session-item')
      .nth(1)
      .waitFor({ timeout: 10_000 });
    assert((await window.getByTestId('session-item').count()) === 2, '/new 后应有 2 个会话');
    console.log('[e2e] /new：同工作区新会话已创建');

    // 8) /archive：当前会话归档后侧栏只剩 1 个，已归档区可展开恢复
    await composer.fill('/archive');
    await composer.press('Enter');
    await window
      .locator('[data-testid="session-item"]')
      .filter({ hasNotText: '' })
      .first()
      .waitFor({ timeout: 5_000 });
    await window.waitForFunction(
      () => document.querySelectorAll('[data-testid="session-item"]').length === 1,
      undefined,
      { timeout: 5_000 },
    );
    await window.getByTestId('toggle-archived').click();
    await window.getByTestId('unarchive-button').first().waitFor({ timeout: 5_000 });
    await window.getByTestId('unarchive-button').first().click();
    await window.waitForFunction(
      () => document.querySelectorAll('[data-testid="session-item"]').length === 2,
      undefined,
      { timeout: 5_000 },
    );
    console.log('[e2e] /archive 与恢复：归档不在侧栏显示，可展开恢复');

    await closeApp(app);
    console.log('[e2e] 工单 07 命令冒烟通过 ✅');
  } catch (error) {
    console.error('[e2e] 冒烟失败 ❌', error);
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
