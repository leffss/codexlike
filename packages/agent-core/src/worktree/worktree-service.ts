import {
  copyFileSync,
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";

import { simpleGit } from "simple-git";

import { codexlikeBranchName } from "../git/branch-name";
import { resolveInWorkspace } from "../tools/workspace";

/**
 * 托管 Worktree 管理（spec「git 集成与托管 Worktree」；GLOSSARY「托管 Worktree」）。
 * worktree 模式的会话在 `<CODEXLIKE_HOME>/worktrees/<会话id>` 检出隔离副本
 * （独立分支 `codexlike/<会话id>`），会话的全部文件与终端操作发生在副本内。
 *
 * 分支名 sanitize 复用工单 05 的 `codexlikeBranchName`（会话 id 实际为 UUID，天然合法，
 * 但接口不假设调用方只传 UUID）。依赖 Node 运行时，经 `./node` 出口暴露。
 */

/** `.worktreeinclude` 文件名（项目根，每行一个需复制进副本的被 ignore 文件路径） */
export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";

export interface ManagedWorktree {
  /** worktree 检出目录（会话的 workspacePath 指向这里） */
  path: string;
  /** 独立分支名（codexlike/<会话id>） */
  branch: string;
  /** 实际复制进副本的 `.worktreeinclude` 条目（相对工作区的 POSIX 路径） */
  copiedFiles: string[];
  /** 仅撤销本次创建且尚无新增成果的副本；不可证明安全时保留并返回 false。 */
  rollback(): Promise<boolean>;
}

export interface WorktreeService {
  /**
   * 为会话创建托管 Worktree：非 git 目录抛中文错误（会话不应创建），
   * 成功返回副本路径与分支名。`.worktreeinclude` 声明的文件（存在时）复制进副本。
   */
  createForSession(input: {
    sessionId: string;
    workspacePath: string;
  }): Promise<ManagedWorktree>;
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
    return readFileSync(includePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
  }

  return {
    async createForSession({ sessionId, workspacePath }) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(sessionId))
        throw new Error("会话 id 不能包含路径或特殊字符");
      const git = simpleGit({ baseDir: workspacePath });
      if (!(await git.checkIsRepo())) {
        throw new Error(
          `当前工作区不是 git 仓库，无法使用 worktree 模式：${workspacePath}。请改用「本目录直跑」，或先在该目录执行 git init。`
        );
      }
      const worktreePath = join(worktreesDir, sessionId);
      if (existsSync(worktreePath)) {
        throw new Error(
          `worktree 目录已存在：${worktreePath}（会话 id 冲突，请重试新建会话）`
        );
      }
      // 在创建前验证来源路径；目录以排他 mkdir 认领，失败不递归清理未知内容。
      const includes = readIncludeList(workspacePath).map((line) => {
        const parts = line.split(/[\\/]/);
        if (
          isAbsolute(line) ||
          parts.some((part) => part === ".." || part.toLowerCase() === ".git")
        )
          throw new Error(
            `.worktreeinclude 路径越界或涉及 Git 元数据：${line}`
          );
        return { line, source: resolveInWorkspace(workspacePath, line) };
      });
      const branch = codexlikeBranchName(sessionId);
      let head: string;
      try {
        head = (await git.raw(["rev-parse", "--verify", "HEAD"])).trim();
      } catch {
        throw new Error(
          "创建托管 Worktree 失败：Git 仓库尚无提交，请先提交或改用本地模式"
        );
      }
      mkdirSync(worktreesDir, { recursive: true });
      mkdirSync(worktreePath);
      try {
        await git.raw(["worktree", "add", "-b", branch, worktreePath, head]);
      } catch (error) {
        // Git 失败时仅撤销空的认领目录，绝不递归删除竞争者或 hook 写入的成果。
        try {
          rmdirSync(worktreePath);
        } catch {
          /* 非空则保留 */
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`创建托管 Worktree 失败：${message}`, {
          cause: error,
        });
      }
      const copiedFiles: string[] = [];
      // 包含 ignored/untracked 文件；不能只看 git status（会漏掉用户成果）。
      function fingerprint(path: string): string {
        const hash = createHash("sha256");
        function visit(dir: string) {
          for (const name of readdirSync(dir).sort()) {
            const child = join(dir, name);
            const stat = lstatSync(child);
            if (stat.isSymbolicLink()) throw new Error("符号链接不能自动回滚");
            hash.update(child.slice(worktreePath.length));
            if (stat.isDirectory()) visit(child);
            else hash.update(readFileSync(child));
          }
        }
        visit(path);
        return hash.digest("hex");
      }
      // checkout hooks 或外部进程已经写入的成果不属于本次可回收内容。
      const pristine =
        (
          await simpleGit({ baseDir: worktreePath }).raw([
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--ignored",
          ])
        ).trim() === "";
      let baseline: string | undefined;
      try {
        if (pristine) baseline = fingerprint(worktreePath);
      } catch {
        /* 不可证明则保留 */
      }
      async function rollback() {
        try {
          if (baseline === undefined || fingerprint(worktreePath) !== baseline)
            return false;
          if ((await git.raw(["rev-parse", branch])).trim() !== head)
            return false;
          if (fingerprint(worktreePath) !== baseline) return false;
          await git.raw(["worktree", "remove", "--force", worktreePath]);
          await git.raw(["update-ref", "-d", `refs/heads/${branch}`, head]);
          return true;
        } catch {
          return false;
        }
      }
      try {
        for (const { line, source } of includes) {
          if (!existsSync(source) || !statSync(source).isFile()) continue;
          const target = resolveInWorkspace(worktreePath, line);
          mkdirSync(dirname(target), { recursive: true });
          copyFileSync(source, target);
          copiedFiles.push(line);
          // 同步复制期间无异步窗口；每次完成后记录仅本次写入的新基线。
          if (pristine) baseline = fingerprint(worktreePath);
        }
      } catch (error) {
        const removed = await rollback();
        throw new Error(
          `创建托管 Worktree 失败：${error instanceof Error ? error.message : String(error)}${removed ? "" : `；无法确认可安全回收，已保留目录：${worktreePath}`}`,
          { cause: error }
        );
      }
      return { path: worktreePath, branch, copiedFiles, rollback };
    },
  };
}
