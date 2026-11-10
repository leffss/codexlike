import { simpleGit } from 'simple-git';

/**
 * git 服务（spec「git 集成」）：改动面板的数据源。
 * `simple-git` 封装，面向会话工作区目录；非 git 目录优雅降级（isGitRepo=false），
 * 供 UI 显示「非 git 工作区」提示而非报错。
 * 依赖 Node 运行时（simple-git 走 child_process），经 `./node` 出口暴露。
 */

/** 变更类型（改动面板徽标）：新增 / 修改 / 删除 / 重命名 */
export type GitChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

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

export interface GitService {
  status(): Promise<GitStatus>;
}

/** git status 的 index/workdir 两列 code 合成面板显示的单一变更类型 */
function toChangeKind(index: string, workDir: string): GitChangeKind {
  // 暂存区状态优先（R/A/D 已 staged）；untracked 两列都是 '?'
  const code = index !== ' ' && index !== '?' ? index : workDir;
  switch (code) {
    case '?':
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    default:
      // M（修改）、C（复制）、T（类型变更）等一律按修改显示
      return 'modified';
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
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]!;
    if (entry === '') {
      continue;
    }
    const x = entry[0]!;
    const y = entry[1]!;
    const path = entry.slice(3);
    const change: GitFileChange =
      x === 'R' || x === 'C'
        ? { path, kind: toChangeKind(x, y), oldPath: parts[i + 1] ?? '' }
        : { path, kind: toChangeKind(x, y) };
    if (x === 'R' || x === 'C') {
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

  return {
    async status(): Promise<GitStatus> {
      const isGitRepo = await git.checkIsRepo();
      if (!isGitRepo) {
        return { isGitRepo: false, branch: null, files: [] };
      }
      const porcelain = await git.raw(['status', '--porcelain=v1', '-z']);
      const branchOutput = await git.raw(['branch', '--show-current']);
      const branch = branchOutput.trim();
      return {
        isGitRepo: true,
        branch: branch === '' ? null : branch,
        files: parseStatusPorcelainZ(porcelain),
      };
    },
  };
}
