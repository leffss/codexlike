import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** @引用 菜单不展示的目录（依赖产物与 VCS 内部数据） */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.next',
  '.cache',
  'coverage',
]);

/** 枚举条数上限：大仓库不无限展开，菜单层再做模糊过滤 */
export const WORKSPACE_FILES_LIMIT = 2000;

/** 深度上限：防御异常深的目录环 */
const MAX_DEPTH = 16;

/**
 * 枚举工作区文件（@引用 菜单候选，工单 07）。
 * 返回相对路径（统一 POSIX 分隔符，与输入框 @token 一致），按路径排序；
 * 目录不存在返回空数组；条数达到上限即停止。
 */
export function listWorkspaceFiles(workspacePath: string): string[] {
  const files: string[] = [];
  try {
    walk(workspacePath, workspacePath, 0, files);
  } catch {
    return files;
  }
  files.sort();
  return files;
}

function walk(
  root: string,
  dir: string,
  depth: number,
  files: string[],
): void {
  if (depth > MAX_DEPTH || files.length >= WORKSPACE_FILES_LIMIT) {
    return;
  }
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= WORKSPACE_FILES_LIMIT) {
      return;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        walk(root, full, depth + 1, files);
      }
    } else if (entry.isFile()) {
      files.push(toPosixRelative(root, full));
    }
    // symlink 一律跳过：@引用 枚举只走真实文件，防目录环
  }
}

function toPosixRelative(root: string, full: string): string {
  return relative(root, full).split(sep).join('/');
}
