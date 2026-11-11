// E2E（工单 09：托管 Worktree）：真实 Electron 应用走 worktree 模式全链路——
// git repo 工作区（.gitignore 忽略 .env + .worktreeinclude 声明复制）→ 新建会话
// 对话框选「worktree 模式」→ 卡片 worktree 徽标 → 副本目录与独立分支就位、.env 已复制
// → 消息驱动 write_file 落在副本（主仓库不受影响）→ 非 git 目录选 worktree 中文报错
// 且会话不创建（改选本目录直跑可成功）→ 重启恢复仍指向原副本、续跑改动仍在副本内。
// 运行：pnpm --filter @codexlike/desktop run test:e2e:worktree（先全仓 build）。
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { assert, closeApp, launchApp, startMockProvider } from './helpers.mjs';

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

/** 场景脚本：第 1 次 tool_call（write_file，真实写盘）→ 之后流式文本；非流式请求 404 */
async function main() {
  let streamCount = 0;
  const { server, port } = await startMockProvider((ctx, { body }) => {
    if (!body.includes('"stream":true')) {
      ctx.notFound();
      return;
    }
    streamCount += 1;
    if (streamCount === 1) {
      ctx.toolCallRound('call-worktree-e2e', 'write_file', {
        path: 'wt-e2e.txt',
        content: 'worktree E2E 内容',
      });
      return;
    }
    ctx.textRound('已在隔离副本中创建文件。');
  });
  const homeDir = mkdtempSync(join(tmpdir(), 'codexlike-e2e-worktree-'));
  const repo = join(homeDir, 'workspace');
  const plain = join(homeDir, 'plain-workspace');
  let app;
  try {
    // git repo fixture：基线提交 + 被 ignore 的 .env（.worktreeinclude 声明复制进副本）
    mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'e2e@codexlike.local');
    git(repo, 'config', 'user.name', 'CodexLike E2E');
    writeFileSync(join(repo, 'README.md'), '# 基线\n');
    writeFileSync(join(repo, '.gitignore'), '.env\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', '基线提交');
    writeFileSync(join(repo, '.env'), 'SECRET=e2e');
    writeFileSync(join(repo, '.worktreeinclude'), '.env\n');
    mkdirSync(plain);

    // 1) 启动 → 配置 Profile → 新建会话选 worktree 模式
    const first = await launchApp({ homeDir, workspaceDir: repo });
    app = first.app;
    let window = first.window;
    await window.getByRole('button', { name: '设置', exact: true }).click();
    await window.getByRole('button', { name: '+ 新建 Profile' }).click();
    await window.getByLabel('名称').fill('Mock');
    await window.getByLabel('baseURL').fill(`http://127.0.0.1:${port}/v1`);
    await window.getByLabel('API Key').fill('sk-e2e');
    // 设置页有子代理模型选择器（工单 13）也带「模型」label，限定在 Profile 表单内
    await window.locator('form').getByLabel('模型').fill('mock-model');
    await window
      .locator('form')
      .getByRole('button', { name: /保存|创建/ })
      .click();
    await window.getByText('Mock').first().waitFor();
    await window.getByRole('button', { name: '返回工作台' }).click();

    await window.getByTestId('new-session').click();
    await window.getByTestId('new-session-dialog').waitFor({ timeout: 10_000 });
    await window.getByTestId('mode-worktree').click();
    await window.getByTestId('create-session-confirm').click();
    await window.getByTestId('worktree-badge').waitFor({ timeout: 15_000 });
    console.log('[e2e] worktree 模式会话已创建，卡片显示 worktree 徽标');

    // 2) 副本就位：<home>/worktrees/<会话id>、独立分支、.worktreeinclude 的 .env 已复制
    const worktreesDir = join(homeDir, 'worktrees');
    const sessionIds = readdirSync(worktreesDir);
    assert(sessionIds.length === 1, `副本目录数异常：${sessionIds.length}`);
    const sessionId = sessionIds[0];
    const worktreePath = join(worktreesDir, sessionId);
    assert(existsSync(join(worktreePath, 'README.md')), '副本未检出 HEAD 内容');
    assert(
      git(repo, 'branch', '--list', `codexlike/${sessionId}`).trim() !== '',
      '独立分支未创建',
    );
    assert(readFileSync(join(worktreePath, '.env'), 'utf8') === 'SECRET=e2e', '.env 未复制进副本');
    console.log('[e2e] 副本目录、独立分支、.worktreeinclude 复制全部就位');

    // 3) 消息驱动 write_file：文件落在副本，主仓库不受影响
    await window.getByTestId('composer-input').fill('在隔离副本创建 wt-e2e.txt');
    await window.getByTestId('composer-send').click();
    await window.getByText('已在隔离副本中创建文件。').waitFor({ timeout: 15_000 });
    assert(
      readFileSync(join(worktreePath, 'wt-e2e.txt'), 'utf8') === 'worktree E2E 内容',
      'write_file 未落在副本内',
    );
    assert(!existsSync(join(repo, 'wt-e2e.txt')), 'worktree 会话的改动泄漏进主仓库');
    console.log('[e2e] 会话改动发生在副本内，主仓库不受影响');

    // 4) 重启恢复：会话仍指向原副本，续跑改动仍在副本内
    await closeApp(app);
    const second = await launchApp({ homeDir, workspaceDir: repo });
    app = second.app;
    window = second.window;
    await window.getByTestId('worktree-badge').waitFor({ timeout: 15_000 });
    await window.getByTestId('session-item').first().click();
    await window.getByTestId('composer-input').waitFor({ timeout: 10_000 });
    await window.getByTestId('composer-input').fill('再写一个文件');
    await window.getByTestId('composer-send').click();
    await window.getByText('已在隔离副本中创建文件。').first().waitFor({ timeout: 15_000 });
    assert(
      readFileSync(join(worktreePath, 'wt-e2e.txt'), 'utf8') === 'worktree E2E 内容',
      '恢复后续跑未指向原副本（文件内容被改写或丢失）',
    );
    assert(!existsSync(join(repo, 'wt-e2e.txt')), '恢复后改动泄漏进主仓库');
    console.log('[e2e] 重启恢复后仍指向原 worktree，续跑改动仍在副本内');

    // 5) 非 git 目录选 worktree：中文报错、会话不创建；改选本目录直跑可成功
    await closeApp(app);
    const third = await launchApp({ homeDir, workspaceDir: plain });
    app = third.app;
    window = third.window;
    await window.getByTestId('new-session').click();
    await window.getByTestId('new-session-dialog').waitFor({ timeout: 10_000 });
    await window.getByTestId('mode-worktree').click();
    await window.getByTestId('create-session-confirm').click();
    const errorCard = window.getByTestId('message-error');
    await errorCard.waitFor({ timeout: 15_000 });
    assert(
      (await errorCard.textContent()).includes('不是 git 仓库'),
      '非 git 目录选 worktree 未给出明确中文错误',
    );
    const sessionCountBefore = await window.getByTestId('session-item').count();
    assert(sessionCountBefore === 1, `worktree 失败后不应新增会话（现有 ${sessionCountBefore}）`);
    console.log('[e2e] 非 git 目录选 worktree：中文报错且会话不创建');

    // 同一对话框改选本目录直跑 → 创建成功（失败可恢复）
    await window.getByTestId('mode-local').click();
    await window.getByTestId('create-session-confirm').click();
    await window.getByTestId('composer-input').waitFor({ timeout: 15_000 });
    assert(
      (await window.getByTestId('session-item').count()) === 2,
      '改选本目录直跑后应创建成功',
    );
    console.log('[e2e] 报错后改选本目录直跑创建成功（对话框可恢复）');

    await closeApp(app);
    console.log('[e2e] 托管 Worktree E2E 通过 ✅');
  } catch (error) {
    console.error('[e2e] 托管 Worktree E2E 失败 ❌', error);
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
