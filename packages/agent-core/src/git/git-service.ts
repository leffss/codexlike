import { readFileSync } from "node:fs";
import { relative } from "node:path";

import { simpleGit } from "simple-git";

import { resolveInWorkspace } from "../tools/workspace";

/**
 * git 服务（spec「git 集成」）：改动面板的数据源。
 * `simple-git` 封装，面向会话工作区目录；非 git 目录优雅降级（isGitRepo=false），
 * 供 UI 显示「非 git 工作区」提示而非报错。
 * 依赖 Node 运行时（simple-git 走 child_process），经 `./node` 出口暴露。
 */

/** 变更类型（改动面板徽标）：新增 / 修改 / 删除 / 重命名 */
export type GitChangeKind = "added" | "modified" | "deleted" | "renamed";

export interface GitFileChange {
  /** 相对工作区的路径（POSIX 分隔符；重命名为新路径） */
  path: string;
  kind: GitChangeKind;
  /** 仅重命名：原路径 */
  oldPath?: string;
}

export interface GitStatus {
  isGitRepo: boolean;
  /** 当前分支名；空仓库/分离 HEAD 时 null */
  branch: string | null;
  /** 工作区范围内的变更文件（工作区为 repo 子目录时只列子目录内） */
  files: GitFileChange[];
}

/** 单文件 diff（Monaco 双栏视图的数据形状）：HEAD 侧 vs 工作区侧 */
export interface GitFileDiff {
  path: string;
  /** HEAD 版本内容；新文件为空串 */
  original: string;
  /** 工作区当前内容；已删除为空串 */
  modified: string;
}

export interface GitService {
  status(): Promise<GitStatus>;
  /**
   * 查看单文件改动（新旧两侧全文，供 Monaco DiffEditor 渲染）。
   * @param path 相对工作区的路径（POSIX 分隔符，来自 status 的 files）
   * @param oldPath 重命名场景 HEAD 中的原路径（可选）
   */
  diffFile(path: string, oldPath?: string): Promise<GitFileDiff>;
  /**
   * 创建（或切换到已存在的）`codexlike/<会话名>` 分支。
   * 创建成功 created=true；分支已存在则切换过去（created=false），可重复调用。
   */
  createSessionBranch(name: string): Promise<GitBranchResult>;
  /** 提交当前全部变更（含 untracked，等价 `git add -A` + `git commit`） */
  commitAll(message: string): Promise<GitCommitResult>;
}

export interface GitBranchResult {
  branch: string;
  /** true = 新建并切换；false = 分支已存在，仅切换 */
  created: boolean;
}

export interface GitCommitResult {
  committed: boolean;
  /** 提交哈希；未提交为 null */
  commitHash: string | null;
  /** 未提交原因（中文，如「没有可提交的变更」） */
  reason?: string;
}

/** git status 的 index/workdir 两列 code 合成面板显示的单一变更类型 */
function toChangeKind(index: string, workDir: string): GitChangeKind {
  // 暂存区状态优先（R/A/D 已 staged）；untracked 两列都是 '?'
  const code = index !== " " && index !== "?" ? index : workDir;
  switch (code) {
    case "?":
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    default:
      // M（修改）、C（复制）、T（类型变更）等一律按修改显示
      return "modified";
  }
}

/**
 * 解析 `git status --porcelain=v1 -z`：每条记录 `XY <path>` 以 NUL 结尾，
 * X 为 R/C（重命名/复制）时后跟 NUL 结尾的原路径。
 * 同一路径可能双记录（如 `rm --cached` 后的 D + ??）：保留首条。
 * 注：simple-git 4.0.2 的 status() 在含 rename 记录时会丢失后续条目，故自行解析。
 */
function parseStatusPorcelainZ(raw: string): GitFileChange[] {
  const files = new Map<string, GitFileChange>();
  const parts = raw.split("\0");
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]!;
    if (entry === "") {
      continue;
    }
    const x = entry[0]!;
    const y = entry[1]!;
    const path = entry.slice(3);
    const change: GitFileChange =
      x === "R" || x === "C"
        ? { path, kind: toChangeKind(x, y), oldPath: parts[i + 1] ?? "" }
        : { path, kind: toChangeKind(x, y) };
    if (x === "R" || x === "C") {
      i += 1;
    }
    if (!files.has(path)) {
      files.set(path, change);
    }
  }
  return [...files.values()];
}

export function createGitService(workspacePath: string): GitService {
  const git = simpleGit({ baseDir: workspacePath });

  /** 工作区相对 repo 根的 POSIX 前缀（'' = 工作区即 repo 根） */
  async function workspacePrefixInRepo(): Promise<string> {
    const toplevel = (await git.revparse("--show-toplevel")).trim();
    const rel = relative(toplevel, workspacePath).replace(/\\/g, "/");
    return rel === "" ? "" : `${rel}/`;
  }

  return {
    async status(): Promise<GitStatus> {
      const isGitRepo = await git.checkIsRepo();
      if (!isGitRepo) {
        return { isGitRepo: false, branch: null, files: [] };
      }
      // -u 展开被折叠的 untracked 目录到文件级（agent 新写文件的面板语义）
      const porcelain = await git.raw([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]);
      const branchOutput = await git.raw(["branch", "--show-current"]);
      const branch = branchOutput.trim();
      const prefix = await workspacePrefixInRepo();
      // porcelain 路径相对 repo 根：工作区为子目录时过滤到范围内并改写为工作区相对路径
      const lowered = prefix.toLowerCase();
      const files = parseStatusPorcelainZ(porcelain)
        .filter((file) => file.path.toLowerCase().startsWith(lowered))
        .map((file) => ({
          ...file,
          path: file.path.slice(prefix.length),
          ...(file.oldPath !== undefined
            ? { oldPath: file.oldPath.slice(prefix.length) }
            : {}),
        }));
      return {
        isGitRepo: true,
        branch: branch === "" ? null : branch,
        files,
      };
    },

    async diffFile(path: string, oldPath?: string): Promise<GitFileDiff> {
      if (!(await git.checkIsRepo())) {
        throw new Error("当前工作区不是 git 仓库，无法查看改动");
      }
      // 路径限制在工作区内（与工具层同一套边界校验，防 .. 与链接逃逸）
      const absolute = resolveInWorkspace(workspacePath, path);
      const prefix = await workspacePrefixInRepo();
      const repoRelative = `${prefix}${path}`;
      const originalRelative =
        oldPath !== undefined ? `${prefix}${oldPath}` : repoRelative;
      let original = "";
      try {
        // HEAD 版本（LF 存储）；新文件不在 HEAD 中 → 空串
        original = (
          await git.raw(["show", `HEAD:${originalRelative}`])
        ).replace(/\r\n/g, "\n");
      } catch {
        // 新文件不在 HEAD 中 → 保持初始空串
      }
      let modified = "";
      try {
        modified = readFileSync(absolute, "utf8").replace(/\r\n/g, "\n");
      } catch {
        // 文件已删除 → 保持初始空串
      }
      return { path, original, modified };
    },

    async createSessionBranch(name: string): Promise<GitBranchResult> {
      if (!(await git.checkIsRepo())) {
        throw new Error("当前工作区不是 git 仓库，无法创建分支");
      }
      try {
        // checkout -b：创建并切换（agent 的后续提交落在新分支上）。
        // 注：simple-git 4 的 checkoutBranch(name) 会把 start-point 拼成 undefined，故走 raw。
        await git.raw(["checkout", "-b", name]);
        return { branch: name, created: true };
      } catch (error) {
        // 分支已存在：切换过去（重复点击幂等）
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("already exists")) {
          await git.raw(["checkout", name]);
          return { branch: name, created: false };
        }
        throw error;
      }
    },

    async commitAll(message: string): Promise<GitCommitResult> {
      if (!(await git.checkIsRepo())) {
        throw new Error("当前工作区不是 git 仓库，无法提交");
      }
      const status = await this.status();
      if (status.files.length === 0) {
        return {
          committed: false,
          commitHash: null,
          reason: "没有可提交的变更",
        };
      }
      await git.raw(["add", "-A"]);
      const summary = await git.commit(message);
      const commitHash =
        typeof summary.commit === "string" && summary.commit !== ""
          ? summary.commit
          : null;
      return { committed: true, commitHash };
    },
  };
}
