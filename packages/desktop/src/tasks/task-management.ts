import type { TaskManager } from "@codexlike/agent-core/node";
import type { TaskExecutionState } from "../shared/ipc";

/**
 * 宿主管理规则。检查和同步写入之间不得 await；归属调整/项目移除复用此保护。
 *
 * 「执行中」的来源有四：执行登记、任务状态（streaming / waiting）、待回应交互，
 * 以及目标循环在进行（目标模式，ADR 0035：目标激活期间任务视为持续执行——
 * 判定在途与两轮之间的窗口里没有执行登记，仍算执行中）。最后一项由宿主注入
 * 的 isGoalRunning 给出；只有目标循环自己发起的续跑轮可以越过它（见 assertCanExecute）。
 */
export function createTaskManagement(
  manager: TaskManager,
  executions: ReadonlyMap<string, string>,
  options: { isGoalRunning?: (taskId: string) => boolean } = {}
) {
  const isGoalRunning = options.isGoalRunning ?? (() => false);

  /**
   * 宿主执行态。ignoreGoalLoop 为 true 时只看真实的在途执行（执行登记 / 任务
   * 状态 / 待回应交互），不含目标循环——输入队列的互锁把目标循环写成自己的
   * 显式条件，用这个口径取「真实执行」部分。
   */
  function execution(
    taskId: string,
    ignoreGoalLoop = false
  ): TaskExecutionState | null {
    const record = manager.list().find((item) => item.id === taskId);
    if (!record) return null;
    const pending = manager.get(taskId)?.pendingInteractions ?? [];
    return {
      taskId,
      executionId: executions.get(taskId) ?? null,
      running:
        executions.has(taskId) ||
        record.status !== "idle" ||
        pending.length > 0 ||
        (!ignoreGoalLoop && isGoalRunning(taskId)),
      waitingForUser: pending.length > 0,
      pendingInteractionIds: pending.map((item) => item.request.id),
    };
  }

  function assertInactive(taskId: string, ignoreGoalLoop = false): void {
    if (execution(taskId, ignoreGoalLoop)?.running)
      throw new Error("任务正在执行或等待用户回应，请先停止再整理");
  }

  return {
    execution,
    assertInactive,
    /**
     * 执行前的可执行检查。`forGoalLoop` 供目标循环自己发起续跑轮时使用：
     * 「目标循环在进行」正是它要接续的状态，不构成阻碍；其余阻碍（任务已移除 /
     * 已归档 / 真有回合在跑 / 等待用户回应）照常生效。
     */
    assertCanExecute(
      taskId: string,
      options: { forGoalLoop?: boolean } = {}
    ): void {
      const record = manager.list().find((item) => item.id === taskId);
      if (!record) throw new Error("任务不存在或已移除");
      if (record.archivedAt !== null)
        throw new Error("任务已归档，请先恢复再发送");
      assertInactive(taskId, options.forGoalLoop === true);
    },
    archive(taskId: string, archived: boolean) {
      assertInactive(taskId);
      return manager.setArchived(taskId, archived);
    },
  };
}
