import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { simpleGit } from 'simple-git';

import { codexlikeBranchName } from '../git/branch-name';
import type { SessionRecord } from '../session/types';
import { resolveInWorkspace } from '../tools/workspace';

/**
 * 托管 Worktree 管理（spec「git 集成与托管 Worktree」；GLOSSARY「托管 Worktree」）。
 * worktree 模式的会话在 `<CODEXLIKE_HOME>/worktrees/<会话id>` 检出隔离副本
 * （独立分支 `codexlike/<会话id>`），会话的全部文件与终端操作发生在副本内。
 *
 * 分支名 sanitize 复用工单 05 的 `codexlikeBranchName`（会话 id 实际为 UUID，天然合法，
 * 但接口不假设调用方只传 UUID）。依赖 Node 运行时，经 `./node` 出口暴露。
 */

/** `.worktreeinclude` 文件名（项目根，每行一个需复制进副本的被 ignore 文件路径） */
export const WORKTREE_INCLUDE_FILE = '.worktreeinclude';

/** LRU 清理默认保留的 worktree 数量（spec：只保留最近 15 个） */
export const WORKTREE_KEEP_DEFAULT = 15;

export interface ManagedWorktree {
  /** worktree 检出目录（会话的 workspacePath 指向这里） */
  path: string;
  /** 独立分支名（codexlike/<会话id>） */
  branch: string;
  /** 实际复制进副本的 `.worktreeinclude` 条目（相对工作区的 POSIX 路径） */
  copiedFiles: string[];
}

export interface WorktreeCleanupResult {
  /** 已删除的 worktree 对应的会话 id（含孤儿目录名） */
  removed: string[];
  /** 进入候选但按 LRU 保留的会话 id */
  kept: string[];
  /** 候选中因会话运行中而跳过的会话 id（永不清理） */
  skippedRunning: string[];
}

/** cleanup 只依赖会话记录的 id / status / archivedAt / updatedAt（SessionRecord 的结构子集） */
export type WorktreeCleanupSession = Pick<
  SessionRecord,
  'id' | 'status' | 'archivedAt' | 'updatedAt'
>;

export interface WorktreeService {
  /**
   * 为会话创建托管 Worktree：非 git 目录抛中文错误（会话不应创建），
   * 成功返回副本路径与分支名。`.worktreeinclude` 声明的文件（存在时）复制进副本。
   */
  createForSession(input: {
    sessionId: string;
    workspacePath: string;
  }): Promise<ManagedWorktree>;
  /**
   * LRU 清理：一切非运行中会话的 worktree（含活跃空闲、已归档、无会话记录的孤儿）
   * 进入候选，按会话 updatedAt 保留最近 `keep` 个（默认 15），其余删除；
   * 运行中（streaming / waiting-approval）会话的 worktree 永不清理。
   * 删除只移除 worktree 检出目录，独立分支保留（改动不丢，可人工找回）。
   */
  cleanup(input: {
    sessions: WorktreeCleanupSession[];
    keep?: number;
  }): Promise<WorktreeCleanupResult>;
}

export function createWorktreeService(options: {
  /** worktree 根目录（`~/.codexlike/worktrees`，CODEXLIKE_HOME 由宿主解析后传入） */
  worktreesDir: string;
}): WorktreeService {
  const { worktreesDir } = options;

  /** 读取项目根 `.worktreeinclude`：每行一个路径，去掉空行；文件不存在返回空 */
  function readIncludeList(workspacePath: string): string[] {
    const includePath = join(workspacePath, WORKTREE_INCLUDE_FILE);
    if (!existsSync(includePath)) {
      return [];
    }
    return readFileSync(includePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '');
  }

  /**
   * 删除一个 worktree：解析其 `.git` 文件得到主仓库，在主仓库执行
   * `git worktree remove --force` + `prune`（清理 git 元数据）；
   * 目录已不是合法 worktree（.git 文件缺失等）时直接删目录。
   */
  async function removeWorktree(worktreePath: string): Promise<void> {
    const dotGitPath = join(worktreePath, '.git');
    let mainRepo: string | null = null;
    try {
      const gitdirLine = readFileSync(dotGitPath, 'utf8').split(/\r?\n/)[0] ?? '';
      const match = /^gitdir:\s*(.+)$/.exec(gitdirLine.trim());
      if (match !== null) {
        // <主仓库>/.git/worktrees/<名> → 主仓库根
        mainRepo = dirname(dirname(dirname(match[1]!.trim())));
      }
    } catch {
      mainRepo = null;
    }
    if (mainRepo !== null && existsSync(mainRepo)) {
      try {
        await simpleGit({ baseDir: mainRepo }).raw([
          'worktree',
          'remove',
          '--force',
          worktreePath,
        ]);
        await simpleGit({ baseDir: mainRepo }).raw(['worktree', 'prune']);
        return;
      } catch {
        // git 删除失败（元数据已损坏等）退回直接删目录
      }
    }
    rmSync(worktreePath, { recursive: true, force: true });
  }

  return {
    async createForSession({ sessionId, workspacePath }) {
      const git = simpleGit({ baseDir: workspacePath });
      if (!(await git.checkIsRepo())) {
        throw new Error(
          `当前工作区不是 git 仓库，无法使用 worktree 模式：${workspacePath}。请改用「本目录直跑」，或先在该目录执行 git init。`,
        );
      }
      const worktreePath = join(worktreesDir, sessionId);
      if (existsSync(worktreePath)) {
        throw new Error(
          `worktree 目录已存在：${worktreePath}（会话 id 冲突，请重试新建会话）`,
        );
      }
      // 分支名 sanitize 沿用工单 05 的规则（codexlikeBranchName）
      const branch = codexlikeBranchName(sessionId);
      mkdirSync(worktreesDir, { recursive: true });
      try {
        // 基于当前 HEAD 检出新分支到隔离目录
        await git.raw(['worktree', 'add', '-b', branch, worktreePath]);
      } catch (error) {
        // 失败清理半成品目录，不残留
        rmSync(worktreePath, { recursive: true, force: true });
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`创建托管 Worktree 失败：${message}`);
      }

      // `.worktreeinclude`：声明的被 ignore 文件复制进副本（副本检出 HEAD，ignore 文件不在其中）
      const copiedFiles: string[] = [];
      for (const line of readIncludeList(workspacePath)) {
        // 路径限制在工作区内（防 .. 与链接逃逸，与工具层同一套边界校验）
        const source = resolveInWorkspace(workspacePath, line);
        let isFile = false;
        try {
          isFile = statSync(source).isFile();
        } catch {
          isFile = false; // 声明的文件不存在：跳过（如本机没有的 .env）
        }
        if (!isFile) {
          continue;
        }
        const target = join(worktreePath, ...line.split('/'));
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
        copiedFiles.push(line);
      }
      return { path: worktreePath, branch, copiedFiles };
    },

    async cleanup({ sessions, keep = WORKTREE_KEEP_DEFAULT }) {
      if (!existsSync(worktreesDir)) {
        return { removed: [], kept: [], skippedRunning: [] };
      }
      const byId = new Map(sessions.map((record) => [record.id, record]));
      const skippedRunning: string[] = [];
      // 候选 = 一切非运行中的 worktree（活跃空闲、已归档、孤儿都算——story 24「磁盘不被占满」，
      // 运行中的永不清理）；按 updatedAt 倒序排（最近在前），孤儿视作最旧、优先清理
      const candidates: { id: string; updatedAt: string }[] = [];
      for (const name of readdirSync(worktreesDir)) {
        const path = join(worktreesDir, name);
        if (!statSync(path).isDirectory()) {
          continue;
        }
        const record = byId.get(name);
        if (record !== undefined) {
          if (record.status !== 'idle') {
            // 运行中会话的 worktree 永不清理
            skippedRunning.push(name);
            continue;
          }
          candidates.push({ id: name, updatedAt: record.updatedAt });
        } else {
          candidates.push({ id: name, updatedAt: '' }); // 孤儿：会话已删除
        }
      }
      candidates.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
      const kept = candidates.slice(0, keep).map((candidate) => candidate.id);
      const removed: string[] = [];
      for (const candidate of candidates.slice(keep)) {
        await removeWorktree(join(worktreesDir, candidate.id));
        removed.push(candidate.id);
      }
      return { removed, kept, skippedRunning };
    },
  };
}
