// E2E 冒烟（项目侧栏，spec .scratch/projects-sidebar/spec.md）：
// 两次启动（同一 homeDir、不同工作区目录）各建一个会话 → 侧栏出现两个项目组
// （组名 = 目录名，ADR 0005 纯派生聚合；项目按创建时间倒序）；
// 无当前会话的项目组可折叠/展开。运行：node e2e/projects-sidebar.mjs（需先 build）。
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { assert, closeApp, launchApp } from './helpers.mjs';

async function createSession(window) {
  await window.getByTestId('new-session').click();
  await window.getByTestId('create-session-confirm').click();
  await window.getByTestId('session-item').first().waitFor({ timeout: 10_000 });
}

async function main() {
  const homeDir = mkdtempSync(join(tmpdir(), 'codexlike-projects-'));
  const alphaDir = join(homeDir, 'alpha-repo');
  const betaDir = join(homeDir, 'beta-repo');
  mkdirSync(alphaDir);
  mkdirSync(betaDir);

  try {
    // 1) 第一次启动：alpha-repo 上建会话（跨重启项目仍在 = 数据落库而非 UI 态）
    const first = await launchApp({ homeDir, workspaceDir: alphaDir });
    await createSession(first.window);
    await closeApp(first.app);

    // 2) 第二次启动（同 homeDir，不同工作区）：beta-repo 上建会话
    const second = await launchApp({ homeDir, workspaceDir: betaDir });
    const window = second.window;
    await createSession(window);

    // 3) 两个项目组：组名 = 目录名；创建时间倒序（后建的 beta 在最上）
    await window.waitForFunction(
      () => document.querySelectorAll('[data-testid="project-group"]').length === 2,
      undefined,
      { timeout: 5_000 },
    );
    const groupNames = await window.getByTestId('project-group').allTextContents();
    assert(
      groupNames[0].includes('beta-repo') && groupNames[1].includes('alpha-repo'),
      `项目应按创建时间倒序（beta 在上）：实际 ${groupNames.join(' | ')}`,
    );

    // 4) 折叠/展开：alpha 组无当前会话，收起后只剩 beta 组的会话；再点展开恢复
    const alphaGroup = window.getByTestId('project-group').nth(1);
    await alphaGroup.click();
    assert(
      (await window.getByTestId('session-item').count()) === 1,
      '收起 alpha 组后应只剩 beta 组的 1 个会话',
    );
    await alphaGroup.click();
    assert(
      (await window.getByTestId('session-item').count()) === 2,
      '展开 alpha 组后应恢复 2 个会话',
    );
    console.log('[e2e] 项目侧栏：双目录分组 + 组头折叠/展开 OK');

    await closeApp(second.app);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('[e2e] 项目侧栏冒烟失败：', error);
  process.exitCode = 1;
});
