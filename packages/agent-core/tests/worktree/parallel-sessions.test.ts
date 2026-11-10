import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, describe, expect, it } from 'vitest';

import type { ProviderProfile } from '../../src/provider/provider-profile';
import { createSessionManager } from '../../src/session/manager';
import { createSqliteSessionStore } from '../../src/session/persistence';
import type { SessionEvent } from '../../src/session/types';
import { createBuiltinTools } from '../../src/tools/builtin';
import { createWorktreeService } from '../../src/worktree/worktree-service';

/**
 * 托管 Worktree 集成（验收场景 5 + 恢复等价性）：
 * 同一 git 仓库上「本目录直跑」与「worktree 模式」两个会话并行改动互不干扰；
 * worktree 会话重启恢复后仍指向原 worktree 副本（workspacePath 落库即天然成立，
 * 此处以等价性测试锁定行为）。
 */
const dirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codexlike-par-repo-'));
  dirs.push(dir);
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'e2e@codexlike.local');
  git(dir, 'config', 'user.name', 'CodexLike Test');
  writeFileSync(join(dir, 'README.md'), '# 并行\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', '初始提交');
  return dir;
}

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  // Windows：先释放 SQLite 句柄再删临时目录，否则 rmSync EPERM
  for (const store of openStores) {
    store.close();
  }
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 双会话各自携带不同 profile（id 用于模型工厂分发，避免共享状态的时序竞态） */
const localProfile: ProviderProfile = {
  id: 'profile-local',
  name: 'GLM',
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: 'sk-test',
  model: 'glm-4.7',
};

const worktreeProfile: ProviderProfile = {
  ...localProfile,
  id: 'profile-worktree',
};

function usage() {
  return {
    inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 2, text: undefined, reasoning: undefined },
  };
}

/** 脚本化模型：第 1 轮 write_file、之后每轮文本收尾 */
function writeThenTextModel(path: string, content: string): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const index = call++;
      if (index === 0) {
        return {
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'write_file',
                input: JSON.stringify({ path, content }),
              });
              controller.enqueue({
                type: 'finish',
                usage: usage(),
                finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
              });
              controller.close();
            },
          }),
        };
      }
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'text-start', id: 'text-1' });
            controller.enqueue({ type: 'text-delta', id: 'text-1', delta: `已写入 ${path}` });
            controller.enqueue({ type: 'text-end', id: 'text-1' });
            controller.enqueue({
              type: 'finish',
              usage: usage(),
              finishReason: { unified: 'stop' as const, raw: 'stop' },
            });
            controller.close();
          },
        }),
      };
    },
  });
}

/** 每个 profile id 对应的模型工厂（会话创建前注册，避免并行时序竞态） */
const modelFactories = new Map<string, () => MockLanguageModelV4>();

/** 打开的 SQLite 库句柄（Windows 上不 close 会锁住临时目录，afterAll 统一释放） */
const openStores: ReturnType<typeof createSqliteSessionStore>[] = [];

function makeManager(dbPath: string) {
  const persistence = createSqliteSessionStore(dbPath);
  openStores.push(persistence);
  return createSessionManager({
    persistence,
    tools: createBuiltinTools(),
    languageModelFor: (used) => {
      const factory = modelFactories.get(used.id);
      if (factory === undefined) {
        throw new Error(`测试未注册模型工厂：profile=${used.id}`);
      }
      return factory();
    },
  });
}

async function collect(iterable: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

describe('托管 Worktree 集成（同一仓库双会话并行）', () => {
  it('local 与 worktree 会话各自写文件互不干扰，主仓库不含 worktree 的改动', async () => {
    const repo = makeRepo();
    const home = makeDir('codexlike-par-home-');
    const worktreeService = createWorktreeService({
      worktreesDir: join(home, 'worktrees'),
    });
    const dbPath = join(makeDir('codexlike-par-db-'), 'codexlike.db');

    // worktree 副本先检出（desktop 的 createSessionWithMode 同款编排），再以同一 id 落库
    const worktrees = makeManager(dbPath);
    const localSession = worktrees.create({ workspacePath: repo });
    const wtId = 'wt-parallel-1';
    const wt = await worktreeService.createForSession({
      sessionId: wtId,
      workspacePath: repo,
    });
    const wtSession = worktrees.create({
      id: wtId,
      workspacePath: wt.path,
      workspaceMode: 'worktree',
    });

    // 两个会话并行写同名文件（各自模型脚本写不同内容）
    modelFactories.set('profile-local', () =>
      writeThenTextModel('feature.txt', 'local-change'),
    );
    modelFactories.set('profile-worktree', () =>
      writeThenTextModel('feature.txt', 'worktree-change'),
    );
    const localEvents = collect(
      localSession.sendMessage({ text: '写 local 版本', profile: localProfile }),
    );
    const wtEvents = collect(
      wtSession.sendMessage({ text: '写 worktree 版本', profile: worktreeProfile }),
    );
    await Promise.all([localEvents, wtEvents]);

    // local 会话的文件落在主仓库目录
    expect(readFileSync(join(repo, 'feature.txt'), 'utf8')).toBe('local-change');
    // worktree 会话的文件落在隔离副本，内容互不覆盖
    expect(readFileSync(join(wt.path, 'feature.txt'), 'utf8')).toBe('worktree-change');
    expect(readFileSync(join(repo, 'feature.txt'), 'utf8')).toBe('local-change');
    // 主仓库工作区不出现 worktree 会话的独有文件（隔离性）
    expect(existsSync(join(wt.path, 'README.md'))).toBe(true);
    // git 状态互不污染：主仓库只有 local 会话的新文件
    const status = git(repo, 'status', '--porcelain').trim();
    expect(status).toBe('?? feature.txt');
  });

  it('worktree 会话重启恢复后仍指向原 worktree，续跑改动仍发生在副本内', async () => {
    const repo = makeRepo();
    const home = makeDir('codexlike-par-home-');
    const worktreeService = createWorktreeService({
      worktreesDir: join(home, 'worktrees'),
    });
    const dbPath = join(makeDir('codexlike-par-db-'), 'codexlike.db');

    const first = makeManager(dbPath);
    const wtId = 'wt-resume-1';
    const wt = await worktreeService.createForSession({
      sessionId: wtId,
      workspacePath: repo,
    });
    const session = first.create({
      id: wtId,
      workspacePath: wt.path,
      workspaceMode: 'worktree',
    });
    const originalPath = session.record.workspacePath;

    // 重启前一轮工具轮次（在副本内写文件）
    modelFactories.set('profile-local', () => writeThenTextModel('first.txt', '重启前'));
    await collect(session.sendMessage({ text: '写 first.txt', profile: localProfile }));
    expect(existsSync(join(wt.path, 'first.txt'))).toBe(true);

    // 等价应用重启：同一库文件上的新 manager 恢复会话
    const second = makeManager(dbPath);
    const restored = second.get(wtId);
    expect(restored).not.toBeNull();
    expect(restored!.record.workspacePath).toBe(originalPath);
    expect(restored!.record.workspaceMode).toBe('worktree');

    // 恢复后续跑：改动仍发生在原 worktree 副本内，主仓库不受影响
    modelFactories.set('profile-local', () => writeThenTextModel('second.txt', '重启后'));
    await collect(restored!.sendMessage({ text: '写 second.txt', profile: localProfile }));
    expect(readFileSync(join(wt.path, 'second.txt'), 'utf8')).toBe('重启后');
    expect(existsSync(join(repo, 'second.txt'))).toBe(false);
    expect(existsSync(join(repo, 'first.txt'))).toBe(false);
  });
});
