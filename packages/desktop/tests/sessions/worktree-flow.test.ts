import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createSessionManager,
  createSqliteSessionStore,
  createWorktreeService,
} from '@codexlike/agent-core/node';

import { createSessionWithMode } from '../../src/sessions/worktree-flow';

/**
 * 会话创建编排（新建会话的模式选择入口）：
 * worktree 模式 = 先检出托管 Worktree（目录名=会话 id）再以同一 id 落库；
 * 非 git 目录中文报错且会话不落库（AC：会话不创建）。
 */
const tempDirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codexlike-flow-repo-'));
  tempDirs.push(dir);
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'e2e@codexlike.local');
  git(dir, 'config', 'user.name', 'CodexLike Test');
  writeFileSync(join(dir, 'README.md'), '# 初始\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', '初始提交');
  return dir;
}

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('createSessionWithMode（新建会话模式编排）', () => {
  it('worktree 模式：git 仓库上检出托管副本，会话 workspacePath 指向副本且分支独立', async () => {
    const repo = makeRepo();
    const home = makeDir('codexlike-flow-home-');
    const persistence = createSqliteSessionStore(':memory:');
    const manager = createSessionManager({ persistence });
    const worktrees = createWorktreeService({ worktreesDir: join(home, 'worktrees') });

    const record = await createSessionWithMode({
      manager,
      worktreeService: worktrees,
      workspacePath: repo,
      workspaceMode: 'worktree',
    });

    expect(record.workspaceMode).toBe('worktree');
    // 副本目录名 = 会话 id；会话工作区指向副本
    expect(record.workspacePath).toBe(join(home, 'worktrees', record.id));
    // 原始仓库路径随会话落库（ADR 0005：侧栏项目按它聚合）
    expect(record.workspaceOriginPath).toBe(repo);
    expect(existsSync(join(record.workspacePath, 'README.md'))).toBe(true);
    expect(git(repo, 'branch', '--list', `codexlike/${record.id}`).trim()).not.toBe('');
    persistence.close();
  });

  it('worktree 模式：非 git 目录中文报错，会话不创建', async () => {
    const plain = makeDir('codexlike-flow-plain-');
    const home = makeDir('codexlike-flow-home-');
    const persistence = createSqliteSessionStore(':memory:');
    const manager = createSessionManager({ persistence });
    const worktrees = createWorktreeService({ worktreesDir: join(home, 'worktrees') });

    await expect(
      createSessionWithMode({
        manager,
        worktreeService: worktrees,
        workspacePath: plain,
        workspaceMode: 'worktree',
      }),
    ).rejects.toThrow('不是 git 仓库');

    // 关键：失败时没有会话落库
    expect(manager.list()).toEqual([]);
    persistence.close();
  });

  it('local 模式（默认）：直接以所选目录为工作区，不创建 worktree', async () => {
    const repo = makeRepo();
    const home = makeDir('codexlike-flow-home-');
    const persistence = createSqliteSessionStore(':memory:');
    const manager = createSessionManager({ persistence });
    const worktrees = createWorktreeService({ worktreesDir: join(home, 'worktrees') });

    const record = await createSessionWithMode({
      manager,
      worktreeService: worktrees,
      workspacePath: repo,
    });

    expect(record.workspaceMode).toBe('local');
    expect(record.workspacePath).toBe(repo);
    // local 模式工作区即原始目录，origin 恒为 null
    expect(record.workspaceOriginPath).toBeNull();
    expect(existsSync(join(home, 'worktrees'))).toBe(false);
    persistence.close();
  });
});
