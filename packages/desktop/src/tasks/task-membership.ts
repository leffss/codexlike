import type { TaskManager } from "@codexlike/agent-core/node";
import type { createTaskManagement } from "./task-management";
import { sameWorkspaceDirectory } from "./workspace-sharing";

/** 归属只改变管理关系；检查与同步写入共用执行保护，不触碰磁盘文件。 */
export function createTaskMembership(
  manager: TaskManager,
  management: ReturnType<typeof createTaskManagement>
) {
  return {
    removeProject(projectId: string, confirmed: boolean) {
      if (!confirmed) return null;
      if (!manager.projects().some((item) => item.id === projectId))
        throw new Error("项目不存在或已移除");
      const members = manager
        .list()
        .filter((item) => item.projectId === projectId);
      for (const member of members) management.assertInactive(member.id);
      return { projectId, sessionIds: manager.removeProject(projectId) };
    },
    setProject(sessionId: string, projectId: string | null) {
      const session = manager.list().find((item) => item.id === sessionId);
      if (!session) throw new Error("会话不存在或已移除");
      management.assertInactive(sessionId);
      if (projectId !== null) {
        const project = manager
          .projects()
          .find((item) => item.id === projectId);
        if (!project) throw new Error("项目不存在或已移除");
        const source =
          session.workspaceMode === "worktree"
            ? session.workspaceOriginPath
            : session.workspacePath;
        if (!source || !sameWorkspaceDirectory(source, project.workspacePath))
          throw new Error(
            session.workspaceMode === "worktree"
              ? "Worktree 会话只能移回来源项目"
              : "会话工作区与目标项目目录不匹配"
          );
      }
      return manager.setProject(sessionId, projectId);
    },
  };
}
