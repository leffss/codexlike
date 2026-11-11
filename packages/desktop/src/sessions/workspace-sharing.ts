import { isAbsolute, relative } from "node:path";
import { realpathSync, statSync } from "node:fs";
import type { SessionManager } from "@codexlike/agent-core/node";
import type {
  WorkspaceSharingTarget,
  WorkspaceSharingView,
} from "../shared/ipc";

/** 供创建、共享提示与归属管理复用；不按目录显示名或前缀推导相等。 */
export function canonicalWorkspacePath(path: string): string {
  if (!isAbsolute(path)) throw new Error("工作区必须是已有目录的绝对路径");
  try {
    const real = realpathSync.native(path);
    if (!statSync(real).isDirectory()) throw new Error();
    return real;
  } catch {
    throw new Error("工作区目录不存在或无法访问，请重新选择目录后重试");
  }
}

export function sameWorkspaceDirectory(left: string, right: string): boolean {
  try {
    return (
      relative(canonicalWorkspacePath(left), canonicalWorkspacePath(right)) ===
      ""
    );
  } catch {
    return false;
  }
}

/** 只读取目录与宿主运行事实，不分配目录、不创建会话，也不是并行锁。 */
export function workspaceSharing(
  target: WorkspaceSharingTarget,
  manager: SessionManager,
  isRunning: (id: string) => boolean
): WorkspaceSharingView {
  if (!target || typeof target !== "object")
    throw new Error("工作区查询参数不合法");
  let path: string | undefined;
  let exclude: string | undefined;
  if ("sessionId" in target) {
    const session = manager.list().find((item) => item.id === target.sessionId);
    if (!session) throw new Error("会话不存在");
    path = session.workspacePath;
    exclude = session.id;
  } else {
    if (
      target.workspaceMode !== undefined &&
      target.workspaceMode !== "local" &&
      target.workspaceMode !== "worktree"
    )
      throw new Error("工作区模式不合法");
    if (target.projectId !== null) {
      const project = manager
        .projects()
        .find((item) => item.id === target.projectId);
      if (!project) throw new Error("项目不存在");
      if (target.workspacePath !== undefined)
        throw new Error("项目会话不能更换工作区");
      if (target.workspaceMode === "worktree")
        return { workspacePath: null, runningSessions: [] };
      path = project.workspacePath;
    } else {
      if (target.workspaceMode === "worktree")
        throw new Error("独立会话入口不支持直接创建 Worktree");
      path = target.workspacePath;
    }
  }
  if (path === undefined) return { workspacePath: null, runningSessions: [] };
  if (typeof path !== "string") throw new Error("工作区路径不合法");
  const workspacePath = canonicalWorkspacePath(path);
  return {
    workspacePath,
    runningSessions: manager
      .list()
      .filter(
        (item) =>
          item.id !== exclude &&
          isRunning(item.id) &&
          sameWorkspaceDirectory(workspacePath, item.workspacePath)
      )
      .map(({ id, title }) => ({ id, title })),
  };
}
