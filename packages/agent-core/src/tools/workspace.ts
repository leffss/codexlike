import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { ApprovalMode } from "../task/approval";

/**
 * 按审批模式解析工具路径（GLOSSARY「审批模式」；ADR 0004）：
 * - `full-access` 完全访问：不做边界断言——绝对路径原样解析，相对路径仍以工作区为基准，
 *   模型可读写工作区之外的本地任意文件；
 * - 其余档位：走 resolveInWorkspace 强制工作区边界（spec「审批与安全」，不变）。
 */
export function resolvePath(
  workspacePath: string,
  target: string,
  mode: ApprovalMode
): string {
  if (mode === "full-access") {
    return isAbsolute(target)
      ? resolve(target)
      : resolve(workspacePath, target);
  }
  return resolveInWorkspace(workspacePath, target);
}

/**
 * 工作区边界（spec「审批与安全」）：文件操作限制在工作区内。
 * realpath 校验，`..` 与符号链接逃逸被拒；失败抛中文可读错误（工具层转 isError 结果返回模型）。
 *
 * 对尚不存在的写入路径：对存在的最近祖先做 realpath，再拼回剩余段判断边界，
 * 保证「祖先目录是符号链接」的逃逸同样被拦截。
 */
export function resolveInWorkspace(
  workspacePath: string,
  target: string
): string {
  const workspaceReal = realpathSync(workspacePath);
  const candidate = isAbsolute(target)
    ? resolve(target)
    : resolve(workspaceReal, target);

  // 向上找存在的最近祖先：realpath 归一符号链接后再拼回剩余段
  let anchor = candidate;
  let tail = "";
  for (;;) {
    const real = tryRealpath(anchor);
    if (real !== undefined) {
      const normalized = tail === "" ? real : join(real, tail);
      assertInside(workspaceReal, normalized, target);
      return normalized;
    }
    const parent = dirname(anchor);
    if (parent === anchor) {
      // 走到盘符根仍未命中（理论上不会发生）：直接按字面判断
      assertInside(workspaceReal, candidate, target);
      return candidate;
    }
    tail =
      tail === ""
        ? relative(parent, anchor)
        : join(relative(parent, anchor), tail);
    anchor = parent;
  }
}

function tryRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** path.relative 在 win32 上不区分大小写；结果以 `..` 开头即在工作区外 */
function assertInside(
  workspaceReal: string,
  normalized: string,
  originalTarget: string
): void {
  const rel = relative(workspaceReal, normalized);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `路径越界：${originalTarget} 解析到工作区（${workspaceReal}）之外，操作被拒绝`
    );
  }
}
