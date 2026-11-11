// E2E 审批冒烟（工单 04）：真实 Electron 应用走审批三档最小路径——
// 新建会话（默认 suggest）→ 模型请求终端命令 → 审批卡片三键点「本会话总是允许」
// → 命令真实执行 + 同首词命令后续不再询问 → 重启后审批记忆仍生效
// → 切 readonly 后写入被真实拦截 → /status 显示审批模式真实值。
// 运行：pnpm --filter @codexlike/desktop run test:e2e:approvals（先全仓 build）。
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { assert, closeApp, launchApp, startMockProvider } from './helpers.mjs';

/**
 * 场景脚本：按请求序号脚本化（03 踩坑：tool_call 走
 * delta.tool_calls + finish_reason 'tool_calls'；arguments 是 JSON 字符串）。
 * 轮次 = 每次发送消息一轮工具调用 + 一轮收尾文本。
 */
const SCRIPT = [
  // 消息 1：请求终端命令（suggest 下应弹审批卡）
  { tool: { name: 'run_terminal_command', arguments: { command: 'echo approval-ok > approval.txt' } } },
  { text: '命令已执行' },
  // 消息 2：同首词（echo）命令（记忆命中，不应再询问）
  { tool: { name: 'run_terminal_command', arguments: { command: 'echo memory-ok > memory.txt' } } },
  { text: '这次没有询问' },
  // 消息 3（重启恢复后）：同首词命令（记忆随会话入库，恢复仍生效）
  { tool: { name: 'run_terminal_command', arguments: { command: 'echo restored-ok > restored.txt' } } },
  { text: '重启后记忆仍生效' },
  // 消息 4（切 readonly 后）：写入应被真实拦截
  { tool: { name: 'write_file', arguments: { path: 'deny.txt', content: '不应落盘' } } },
  { text: '写入被拒绝，我只读' },
];

async function main() {
  const { server, port } = await startMockProvider((ctx, { index }) => {
    const step = SCRIPT[Math.min(index - 1, SCRIPT.length - 1)];
    if (step.tool !== undefined) {
      ctx.toolCallRound(`call-${index}`, step.tool.name, step.tool.arguments);
      return;
    }
    ctx.textRound(step.text);
  });
  const homeDir = mkdtempSync(join(tmpdir(), 'codexlike-e2e-approval-'));
  mkdirSync(join(homeDir, 'workspace'));

  let app;
  try {
    // 1) 启动 → 设置页创建 Profile → 新建会话（默认 suggest）
    const first = await launchApp({ homeDir });
    app = first.app;
    let window = first.window;
    await window.getByRole('button', { name: '设置', exact: true }).click();
    await window.getByRole('button', { name: '+ 新建 Profile' }).click();
    const profileForm = window.locator('form');
    await profileForm.getByLabel('名称').fill('Mock');
    await profileForm.getByLabel('baseURL').fill(`http://127.0.0.1:${port}/v1`);
    await profileForm.getByLabel('API Key').fill('sk-e2e');
    await profileForm.getByLabel('模型').fill('mock-model');
    // 设置页有两个「保存」按钮（Profile 表单与搜索源区，工单 10），限定在表单内点击
    await window
      .locator('form')
      .getByRole('button', { name: /保存|创建/ })
      .click();
    await window.getByText('Mock').first().waitFor();

    await window.getByRole('button', { name: '返回工作台' }).click();
    await window.getByTestId('new-session').click();
    // 新建会话对话框：选运行位置（默认本目录直跑）
    await window.getByTestId('create-session-confirm').click();
    await window.getByTestId('session-item').first().waitFor({ timeout: 10_000 });
    console.log('[e2e] 会话已创建（默认 suggest 审批模式）');

    // 选择器显示「协作」档（当前会话真实值）
    const modeSelect = window.getByTestId('approval-mode-select');
    assert((await modeSelect.inputValue()) === 'suggest', '审批模式选择器未默认 suggest');

    // 2) 消息 1：终端命令触发审批卡片（三键可见、侧栏「等待审批」徽标）
    await window.getByTestId('composer-input').fill('跑一条命令');
    await window.getByTestId('composer-send').click();

    const approvalCard = window.getByTestId('approval-card').first();
    await approvalCard.waitFor({ timeout: 20_000 });
    assert(
      (await approvalCard.getAttribute('data-approval-command')) === 'echo approval-ok > approval.txt',
      '审批卡片未显示命令原文',
    );
    await window.getByTestId('session-item').first().getByText('等待审批').waitFor({ timeout: 5_000 });
    console.log('[e2e] 审批卡片出现：命令原文 + 三键 + 侧栏「等待审批」徽标');

    // 3) 点「本会话总是允许」：命令真实执行、卡片转结果态
    await approvalCard.getByTestId('approval-always').click();
    await approvalCard.getByText('已总是允许').waitFor({ timeout: 10_000 });
    const approvalPath = join(homeDir, 'workspace', 'approval.txt');
    await new Promise((r) => setTimeout(r, 500));
    assert(existsSync(approvalPath), '审批通过后命令未真实执行');
    await window.getByTestId('message-assistant').last().getByText('命令已执行').waitFor({ timeout: 20_000 });
    console.log('[e2e] 「本会话总是允许」：命令真实执行，卡片转结果态');

    // 4) 消息 2：同首词（echo）命令不再询问（审批记忆生效）
    await window.getByTestId('composer-input').fill('再跑一条 echo');
    await window.getByTestId('composer-send').click();
    await new Promise((r) => setTimeout(r, 1_500));
    assert(existsSync(join(homeDir, 'workspace', 'memory.txt')), '记忆命中后命令未执行');
    assert((await window.getByTestId('approval-card').count()) === 1, '同首词命令不应再弹审批卡');
    await window.getByTestId('message-assistant').last().getByText('这次没有询问').waitFor({ timeout: 20_000 });
    console.log('[e2e] 审批记忆：同首词命令直接执行，不再询问');

    // 5) /status 显示审批模式真实值（07 预留字段落位）
    await window.getByTestId('composer-input').fill('/status');
    await window.getByTestId('composer-send').click();
    await window
      .getByTestId('message-status')
      .last()
      .getByText('协作（suggest）：文件编辑自动应用，终端命令逐条审批')
      .waitFor({ timeout: 10_000 });
    console.log('[e2e] /status 显示审批模式真实值');

    // 6) 重启（等价应用重启）→ 审批记忆随会话恢复仍生效
    await closeApp(app);
    const second = await launchApp({ homeDir });
    app = second.app;
    window = second.window;
    await window.getByTestId('session-item').first().waitFor({ timeout: 15_000 });
    await window.getByTestId('session-item').first().click();
    await window.getByTestId('composer-input').fill('重启后再跑一条 echo');
    await window.getByTestId('composer-send').click();
    await new Promise((r) => setTimeout(r, 1_500));
    assert(existsSync(join(homeDir, 'workspace', 'restored.txt')), '重启恢复后记忆命令未执行');
    assert((await window.getByTestId('approval-card').count()) === 0, '重启后不应再询问已记忆命令');
    await window.getByTestId('message-assistant').last().getByText('重启后记忆仍生效').waitFor({ timeout: 20_000 });
    console.log('[e2e] 重启后审批记忆仍生效');

    // 7) 切换到 readonly：写入被真实拦截（拒绝原因回填模型、文件不落盘、循环不崩）
    await window.getByTestId('approval-mode-select').selectOption('readonly');
    await new Promise((r) => setTimeout(r, 300));
    assert((await window.getByTestId('approval-mode-select').inputValue()) === 'readonly', '选择器未切到 readonly');
    await window.getByTestId('composer-input').fill('写一个文件试试');
    await window.getByTestId('composer-send').click();
    // 按 data-tool-name 精确等待新卡片（last() 会命中重启恢复的旧卡片）
    const denyCard = window.locator('[data-testid="tool-call-card"][data-tool-name="write_file"]').first();
    await denyCard.waitFor({ timeout: 20_000 });
    await denyCard.getByTestId('tool-call-toggle').click();
    await denyCard.getByText('readonly').waitFor({ timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 500));
    assert(!existsSync(join(homeDir, 'workspace', 'deny.txt')), 'readonly 下文件不应落盘');
    await window.getByTestId('message-assistant').last().getByText('写入被拒绝，我只读').waitFor({ timeout: 20_000 });
    console.log('[e2e] readonly：写入被真实拦截，模型收到拒绝原因后正常继续');

    await closeApp(app);
    console.log('[e2e] 审批冒烟通过 ✅');
  } catch (error) {
    console.error('[e2e] 审批冒烟失败 ❌', error);
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
