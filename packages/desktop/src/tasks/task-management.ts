import type { TaskManager } from "@codexlike/agent-core/node";
import type { TaskExecutionState } from "../shared/ipc";

/** 宿主管理规则。检查和同步写入之间不得 await；归属调整/项目移除复用此保护。 */
export function createTaskManagement(
  manager: TaskManager,
  executions: ReadonlyMap<string, string>
) {
  function execution(sessionId: string): TaskExecutionState | null {
    const record = manager.list().find((item) => item.id === sessionId);
    if (!record) return null;
    const pending = manager.get(sessionId)?.pendingInteractions ?? [];
    return {
      sessionId,
      executionId: executions.get(sessionId) ?? null,
      running:
        executions.has(sessionId) ||
        record.status !== "idle" ||
        pending.length > 0,
      waitingForUser: pending.length > 0,
      pendingInteractionIds: pending.map((item) => item.request.id),
    };
  }

  function assertInactive(sessionId: string): void {
    if (execution(sessionId)?.running)
      throw new Error("任务正在执行或等待用户回应，请先停止再整理");
  }

  return {
    execution,
    assertInactive,
    assertCanExecute(sessionId: string) {
      const record = manager.list().find((item) => item.id === sessionId);
      if (!record) throw new Error("任务不存在或已移除");
      if (record.archivedAt !== null)
        throw new Error("任务已归档，请先恢复再发送");
      assertInactive(sessionId);
    },
    archive(sessionId: string, archived: boolean) {
      assertInactive(sessionId);
      return manager.setArchived(sessionId, archived);
    },
  };
}
