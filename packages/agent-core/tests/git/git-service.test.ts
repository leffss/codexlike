import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createGitService } from '../../src/git/git-service';

/** 临时 git repo fixture（工单 AC：`git init` + 制造变更，不 mock git） */
const repos: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codexlike-git-'));
  repos.push(dir);
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'e2e@codexlike.local');
  git(dir, 'config', 'user.name', 'CodexLike Test');
  writeFileSync(join(dir, 'README.md'), '# 初始\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', '初始提交');
  return dir;
}

afterAll(() => {
  for (const dir of repos) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('git 服务：status', () => {
  it('干净仓库：isGitRepo true、返回当前分支、无变更文件', async () => {
    const repo = makeRepo();
    const status = await createGitService(repo).status();
    expect(status.isGitRepo).toBe(true);
    expect(status.branch).toBe('main');
    expect(status.files).toEqual([]);
  });

  it('非 git 目录：isGitRepo false 且不抛错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codexlike-nogit-'));
    repos.push(dir);
    const status = await createGitService(dir).status();
    expect(status.isGitRepo).toBe(false);
    expect(status.branch).toBeNull();
    expect(status.files).toEqual([]);
  });

  it('变更文件按类型标识：新增（untracked/staged）与删除', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'new.txt'), '新文件'); // untracked → 新增
    writeFileSync(join(repo, 'gone.txt'), '将删除');
    git(repo, 'add', 'gone.txt');
    git(repo, 'commit', '-m', '补充 gone.txt');
    git(repo, 'rm', '--cached', 'gone.txt'); // 暂存区删除（文件仍在磁盘）→ 删除
    writeFileSync(join(repo, 'staged.txt'), '已暂存新文件');
    git(repo, 'add', 'staged.txt'); // staged A → 新增（须在上一条 commit 之后）

    const status = await createGitService(repo).status();
    const kinds = Object.fromEntries(status.files.map((f) => [f.path, f.kind]));
    expect(kinds['new.txt']).toBe('added');
    expect(kinds['staged.txt']).toBe('added');
    // rm --cached 会产生 D + ?? 双记录：同一路径只显示一条（以第一条为准 → 删除）
    expect(status.files.filter((f) => f.path === 'gone.txt')).toHaveLength(1);
    expect(kinds['gone.txt']).toBe('deleted');
  });

  it('修改与重命名：工作区修改 → modified；git mv → renamed（含 oldPath）', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'README.md'), '# 修改后\n');
    writeFileSync(join(repo, 'to-rename.txt'), '内容');
    git(repo, 'add', 'to-rename.txt');
    git(repo, 'commit', '-m', '补充 to-rename');
    git(repo, 'mv', 'to-rename.txt', 'renamed.txt');

    const status = await createGitService(repo).status();
    const readme = status.files.find((f) => f.path === 'README.md');
    expect(readme?.kind).toBe('modified');
    const renamed = status.files.find((f) => f.path === 'renamed.txt');
    expect(renamed?.kind).toBe('renamed');
    expect(renamed?.oldPath).toBe('to-rename.txt');
  });
});
