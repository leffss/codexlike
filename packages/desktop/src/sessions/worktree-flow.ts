import type {
  WorktreeService,
  WorkspaceMode,
} from "@codexlike/agent-core/node";

/** 仅由 sessions.start 使用：准备工作区事实，不另设创建正式会话的旁路。 */
export async function prepareSessionWorkspace(options: {
  id: string;
  workspacePath: string;
  workspaceMode?: WorkspaceMode;
  worktreeService: WorktreeService;
}) {
  const mode = options.workspaceMode ?? "local";
  if (mode === "local") {
    return {
      workspacePath: options.workspacePath,
      workspaceMode: mode,
      workspaceOriginPath: undefined,
      rollback: async () => true,
    };
  }
  const worktree = await options.worktreeService.createForSession({
    sessionId: options.id,
    workspacePath: options.workspacePath,
  });
  return {
    workspacePath: worktree.path,
    workspaceMode: mode,
    // 来源是持久事实，与当前 projectId 无关（ADR 0010）。
    workspaceOriginPath: options.workspacePath,
    rollback: worktree.rollback,
  };
}
