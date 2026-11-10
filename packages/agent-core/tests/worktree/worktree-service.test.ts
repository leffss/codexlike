import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  createWorktreeService,
  type WorktreeService,
} from '../../src/worktree/worktree-service';

/**
 * 托管 Worktree（GLOSSARY）：真实 git fixture 上验证 worktree 创建 / `.worktreeinclude`
 * 复制 / 非 git 报错 / LRU 清理，不 mock git。
 */
const dirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codexlike-wt-repo-'));
  dirs.push(dir);
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'e2e@codexlike.local');
  git(dir, 'config', 'user.name', 'CodexLike Test');
  writeFileSync(join(dir, 'README.md'), '# 初始\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', '初始提交');
  return dir;
}

function makeWorktreesDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codexlike-wt-home-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('worktree 创建', () => {
  it('在约定目录创建 worktree 与独立分支，检出当前 HEAD 内容', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'tracked.txt'), '被跟踪内容');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', '补充 tracked.txt');
    const home = makeWorktreesDir();
    const service = createWorktreeService({ worktreesDir: join(home, 'worktrees') });

    const info = await service.createForSession({
      sessionId: 'session-abc',
      workspacePath: repo,
    });

    expect(info.path).toBe(join(home, 'worktrees', 'session-abc'));
    expect(info.branch).toBe('codexlike/session-abc');
    // worktree 真实存在且检出 HEAD 内容
    expect(existsSync(join(info.path, 'README.md'))).toBe(true);
    expect(readFileSync(join(info.path, 'tracked.txt'), 'utf8')).toBe('被跟踪内容');
    // worktree 当前分支即独立分支；主仓库仍在 main
    expect(git(info.path, 'branch', '--show-current').trim()).toBe('codexlike/session-abc');
    expect(git(repo, 'branch', '--show-current').trim()).toBe('main');
    // 主仓库分支列表中包含该独立分支（`+` = 分支被检出于其他 worktree，正是预期）
    expect(git(repo, 'branch', '--list', 'codexlike/session-abc').trim()).toBe(
      '+ codexlike/session-abc',
    );
  });

  it('非 git 目录选 worktree 模式：中文明确报错', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'codexlike-wt-plain-'));
    dirs.push(plain);
    const service = createWorktreeService({
      worktreesDir: join(makeWorktreesDir(), 'worktrees'),
    });

    await expect(
      service.createForSession({ sessionId: 's1', workspacePath: plain }),
    ).rejects.toThrow('不是 git 仓库');
  });

  it('`.worktreeinclude` 声明的被 ignore 文件被复制进副本', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, '.gitignore'), '.env\nnode_modules/\n');
    writeFileSync(join(repo, '.env'), 'SECRET=1');
    mkdirSync(join(repo, 'config'));
    writeFileSync(join(repo, 'config', 'local.env'), 'DB=local');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-m', '添加 gitignore');
    writeFileSync(join(repo, '.worktreeinclude'), '.env\nconfig/local.env\n不存在.txt\n');
    const service = createWorktreeService({ worktreesDir: join(makeWorktreesDir(), 'worktrees') });

    const info = await service.createForSession({
      sessionId: 'session-env',
      workspacePath: repo,
    });

    // 声明的两个文件都进了副本，内容一致
    expect(readFileSync(join(info.path, '.env'), 'utf8')).toBe('SECRET=1');
    expect(readFileSync(join(info.path, 'config', 'local.env'), 'utf8')).toBe('DB=local');
    // 不存在的行跳过、不报错；未声明的被 ignore 文件不复制（本例没有其他被 ignore 文件）
    expect(existsSync(join(info.path, '不存在.txt'))).toBe(false);
    expect(info.copiedFiles.sort()).toEqual(['.env', 'config/local.env']);
  });

  it('无 `.worktreeinclude` 时创建正常、复制清单为空', async () => {
    const repo = makeRepo();
    const service = createWorktreeService({ worktreesDir: join(makeWorktreesDir(), 'worktrees') });

    const info = await service.createForSession({
      sessionId: 'session-plain',
      workspacePath: repo,
    });

    expect(info.copiedFiles).toEqual([]);
    expect(existsSync(info.path)).toBe(true);
  });

  it('目标目录已存在时中文报错（会话 id 冲突防御）', async () => {
    const repo = makeRepo();
    const home = makeWorktreesDir();
    mkdirSync(join(home, 'worktrees', 'session-dup'), { recursive: true });
    const service = createWorktreeService({ worktreesDir: join(home, 'worktrees') });

    await expect(
      service.createForSession({ sessionId: 'session-dup', workspacePath: repo }),
    ).rejects.toThrow('已存在');
  });
});

describe('worktree LRU 清理', () => {
  async function seedWorktrees(
    service: WorktreeService,
    repo: string,
    ids: string[],
  ): Promise<void> {
    for (const id of ids) {
      await service.createForSession({ sessionId: id, workspacePath: repo });
    }
  }

  /** 最小会话记录（cleanup 只读 id / status / archivedAt / updatedAt） */
  function sessionRecord(
    id: string,
    overrides: Partial<{ status: string; archivedAt: string | null; updatedAt: string }> = {},
  ) {
    return {
      id,
      status: 'idle',
      archivedAt: null,
      updatedAt: `2026-01-${String(Number(id.slice('s'.length)) + 1).padStart(2, '0')}T00:00:00Z`,
      ...overrides,
    };
  }

  it('已归档候选超过 15 个时只保留最近的 15 个', { timeout: 120_000 }, async () => {
    const repo = makeRepo();
    const home = makeWorktreesDir();
    const service = createWorktreeService({ worktreesDir: join(home, 'worktrees') });
    // s0 最旧 … s19 最新，共 20 个全部归档 → 只留最近 15 个（s5…s19）
    await seedWorktrees(service, repo, Array.from({ length: 20 }, (_, i) => `s${i}`));
    const sessions = Array.from({ length: 20 }, (_, i) =>
      sessionRecord(`s${i}`, { archivedAt: '2026-02-01T00:00:00Z' }),
    );

    const result = await service.cleanup({ sessions });

    expect(result.removed.sort()).toEqual(
      Array.from({ length: 5 }, (_, i) => `s${i}`).sort(),
    );
    expect(result.removed).toHaveLength(5);
    for (const id of ['s0', 's4']) {
      expect(existsSync(join(home, 'worktrees', id))).toBe(false);
    }
    for (const id of ['s5', 's19']) {
      expect(existsSync(join(home, 'worktrees', id))).toBe(true);
    }
    // 删除后主仓库分支保留（改动不丢，可人工找回）
    expect(git(repo, 'branch', '--list', 'codexlike/s0').trim()).toBe('codexlike/s0');
  });

  it('未归档（活跃）会话的 worktree 不清理', async () => {
    const repo = makeRepo();
    const home = makeWorktreesDir();
    const service = createWorktreeService({ worktreesDir: join(home, 'worktrees') });
    await seedWorktrees(service, repo, ['s0', 's1', 's2']);
    // 三个 worktree，两个已归档一个活跃：只有归档的进入候选，且数量未超 15 → 都保留
    const sessions = [
      sessionRecord('s0', { archivedAt: '2026-02-01T00:00:00Z' }),
      sessionRecord('s1', { archivedAt: '2026-02-01T00:00:00Z' }),
      sessionRecord('s2'),
    ];

    const result = await service.cleanup({ sessions });

    expect(result.removed).toEqual([]);
    expect(existsSync(join(home, 'worktrees', 's2'))).toBe(true);
  });

  it('运行中会话（streaming）的 worktree 永不清理，即使超过保留数', async () => {
    const repo = makeRepo();
    const home = makeWorktreesDir();
    const service = createWorktreeService({ worktreesDir: join(home, 'worktrees') });
    await seedWorktrees(service, repo, ['s0', 's1', 's2']);
    // s0 已归档且最旧（会被清），s1 已归档且运行中（永不清理），s2 活跃
    const sessions = [
      sessionRecord('s0', { archivedAt: '2026-02-01T00:00:00Z' }),
      sessionRecord('s1', { archivedAt: '2026-02-01T00:00:00Z', status: 'streaming' }),
      sessionRecord('s2'),
    ];
    // keep=0：全部候选都该删，但运行中的除外
    const result = await service.cleanup({ sessions, keep: 0 });

    expect(result.removed).toEqual(['s0']);
    expect(result.skippedRunning).toEqual(['s1']);
    expect(existsSync(join(home, 'worktrees', 's1'))).toBe(true);
  });

  it('孤儿 worktree（会话记录已不存在）比已归档候选更旧、超量时优先清理', async () => {
    const repo = makeRepo();
    const home = makeWorktreesDir();
    const service = createWorktreeService({ worktreesDir: join(home, 'worktrees') });
    await seedWorktrees(service, repo, ['orphan', 'archived', 'alive']);
    // keep=1：候选 = 孤儿（无记录，视作最旧）+ 已归档 s1；孤儿更旧被删，归档的留在窗口内
    const result = await service.cleanup({
      sessions: [
        sessionRecord('archived', { archivedAt: '2026-02-01T00:00:00Z' }),
        sessionRecord('alive'),
      ],
      keep: 1,
    });

    expect(result.removed).toEqual(['orphan']);
    expect(result.kept).toEqual(['archived']);
    expect(existsSync(join(home, 'worktrees', 'orphan'))).toBe(false);
    expect(existsSync(join(home, 'worktrees', 'archived'))).toBe(true);
    expect(existsSync(join(home, 'worktrees', 'alive'))).toBe(true);
  });

  it('worktrees 目录不存在时清理安全返回', async () => {
    const service = createWorktreeService({
      worktreesDir: join(makeWorktreesDir(), 'worktrees'),
    });
    const result = await service.cleanup({ sessions: [] });
    expect(result.removed).toEqual([]);
  });
});
