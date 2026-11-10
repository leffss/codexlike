import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('工作区是 repo 子目录：只列子目录内的变更，路径相对工作区', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'sub'));
    writeFileSync(join(repo, 'sub', 'inner.txt'), '初始');
    git(repo, 'add', 'sub');
    git(repo, 'commit', '-m', '加 sub');
    writeFileSync(join(repo, 'sub', 'inner.txt'), '内部变更');
    writeFileSync(join(repo, 'outside.txt'), '工作区外变更');

    const status = await createGitService(join(repo, 'sub')).status();
    expect(status.branch).toBe('main');
    const paths = status.files.map((f) => f.path);
    expect(paths).toContain('inner.txt'); // 相对工作区（而非 repo 根的 sub/inner.txt）
    expect(paths.some((p) => p.includes('outside.txt'))).toBe(false);
  });
});

describe('git 服务：diffFile（单文件新旧两侧内容）', () => {
  it('修改文件：original 为 HEAD 版本、modified 为工作区版本', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'app.ts'), 'const a = 1;\n');
    git(repo, 'add', 'app.ts');
    git(repo, 'commit', '-m', '加 app.ts');
    writeFileSync(join(repo, 'app.ts'), 'const a = 2;\n');

    const diff = await createGitService(repo).diffFile('app.ts');
    expect(diff.path).toBe('app.ts');
    expect(diff.original).toBe('const a = 1;\n');
    expect(diff.modified).toBe('const a = 2;\n');
  });

  it('新文件（未跟踪）：original 为空串；删除文件：modified 为空串', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'new.txt'), '全新文件');
    writeFileSync(join(repo, 'bye.txt'), '将删除');
    git(repo, 'add', 'bye.txt');
    git(repo, 'commit', '-m', '加 bye.txt');
    git(repo, 'rm', '-f', 'bye.txt');

    const service = createGitService(repo);
    expect((await service.diffFile('new.txt')).original).toBe('');
    expect((await service.diffFile('new.txt')).modified).toBe('全新文件');
    expect((await service.diffFile('bye.txt')).modified).toBe('');
    expect((await service.diffFile('bye.txt')).original).toBe('将删除');
  });

  it('重命名：oldPath 命中 HEAD 中的原文件内容', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'origin.ts'), 'export const x = 1;\n');
    git(repo, 'add', 'origin.ts');
    git(repo, 'commit', '-m', '加 origin');
    git(repo, 'mv', 'origin.ts', 'moved.ts');
    writeFileSync(join(repo, 'moved.ts'), 'export const x = 2;\n');

    const diff = await createGitService(repo).diffFile('moved.ts', 'origin.ts');
    expect(diff.original).toBe('export const x = 1;\n');
    expect(diff.modified).toBe('export const x = 2;\n');
  });

  it('路径越界拒绝；非 git 目录调用抛中文错误', async () => {
    const repo = makeRepo();
    const service = createGitService(repo);
    await expect(service.diffFile('../outside.txt')).rejects.toThrow('路径越界');

    const plain = mkdtempSync(join(tmpdir(), 'codexlike-nogit2-'));
    repos.push(plain);
    await expect(createGitService(plain).diffFile('a.txt')).rejects.toThrow(
      '当前工作区不是 git 仓库',
    );
  });
});

describe('git 服务：createSessionBranch（codexlike/<会话名> 分支）', () => {
  it('创建并切换到新分支，created=true', async () => {
    const repo = makeRepo();
    const service = createGitService(repo);
    const result = await service.createSessionBranch('codexlike/修复登录');
    expect(result).toEqual({ branch: 'codexlike/修复登录', created: true });
    expect((await service.status()).branch).toBe('codexlike/修复登录');
  });

  it('分支已存在：切换过去并返回 created=false（可重复点击）', async () => {
    const repo = makeRepo();
    const service = createGitService(repo);
    await service.createSessionBranch('codexlike/修复登录');
    // 切回 main 制造「分支已存在」场景
    git(repo, 'checkout', 'main');
    const result = await service.createSessionBranch('codexlike/修复登录');
    expect(result).toEqual({ branch: 'codexlike/修复登录', created: false });
    expect((await service.status()).branch).toBe('codexlike/修复登录');
  });

  it('非 git 目录：中文报错不崩溃', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'codexlike-nogit3-'));
    repos.push(plain);
    await expect(createGitService(plain).createSessionBranch('codexlike/x')).rejects.toThrow(
      '当前工作区不是 git 仓库',
    );
  });
});

describe('git 服务：commitAll（一键提交全部变更）', () => {
  it('提交 untracked + 修改，返回哈希，提交后 status 干净', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'new.txt'), '新文件');
    writeFileSync(join(repo, 'README.md'), '# 改\n');
    const service = createGitService(repo);

    const result = await service.commitAll('添加 new.txt 并修改 README');
    expect(result.committed).toBe(true);
    expect(result.commitHash).toMatch(/^[0-9a-f]{7,40}$/);
    const head = git(repo, 'log', '-1', '--pretty=%H');
    expect(result.commitHash).toBe(head.trim());
    expect((await service.status()).files).toEqual([]);
    expect(git(repo, 'log', '-1', '--pretty=%s').trim()).toBe('添加 new.txt 并修改 README');
  });

  it('没有可提交的变更：committed=false 且有中文原因，不抛错', async () => {
    const repo = makeRepo();
    const result = await createGitService(repo).commitAll('空提交');
    expect(result.committed).toBe(false);
    expect(result.commitHash).toBeNull();
    expect(result.reason).toContain('没有可提交的变更');
  });

  it('提交落在当前分支（如 codexlike/* 会话分支）', async () => {
    const repo = makeRepo();
    const service = createGitService(repo);
    await service.createSessionBranch('codexlike/会话一');
    writeFileSync(join(repo, 'work.txt'), '工作成果');
    await service.commitAll('会话分支上的提交');
    expect(git(repo, 'branch', '--contains', 'HEAD').trim()).toBe('* codexlike/会话一');
  });
});
