import type {
  GoalRecord,
  GoalTransition,
  ProviderProfile,
  TaskManager,
} from "@codexlike/agent-core/node";

import type { TaskEventEnvelope } from "../shared/ipc";

/**
 * goal 编排器（ADR 0035，GLOSSARY「目标模式」）：跨回合编排住在 desktop 宿主
 * （落位先例 = 输入队列：agent-core 不知道宿主的空闲语义）。本模块是回合
 * 结束的 idle 边界与目标控制动作的唯一衔接点——agent-core 提供目标实体、
 * 六态状态机与一次完整判定（TaskManager.verifyGoal），这里决定何时判定、
 * 判定后目标去哪。
 *
 * 票 02 只走通「进行中 → 已完成 / 已暂停」：
 * - 正常结束的回合 → 完成判定 → 通过：已完成；未通过（含 fail-open）：已暂停。
 * - 被中断 / 出错的回合 → 不判定，直接已暂停。
 * 票 03 的续跑循环在 afterTurn 的未通过分支接线（未通过 → 以内部输入发起
 * 下一轮，而非暂停）；票 04 的暂停 / 恢复 / 清除复用 pause 与同一状态机。
 */

/** idle 边界的处置结果（供调用方与测试观察） */
export type GoalBoundaryResult =
  /** 任务没有进行中的目标：与目标模式无关的普通回合 */
  | { action: "none" }
  /** 已完成判定并推进了目标状态 */
  | { action: "verified"; status: GoalRecord["status"] }
  /** 未发起判定即暂停（回合被中断 / 出错，或判定在途被中断） */
  | { action: "paused" }
  /** 应用退出中：不做任何编排（重启后的目标恢复由恢复链路负责） */
  | { action: "skipped" };

/** 目标事件（任务级信封，经 task:events 下发到全部工作台窗口） */
export type GoalEvent = Extract<
  TaskEventEnvelope["event"],
  { type: "goal-changed" | "goal-verification" }
>;

export function createGoalOrchestrator(deps: {
  manager: TaskManager;
  /**
   * 任务上次发送所用 Provider Profile 的解析（apiKey 只在主进程解密）；
   * 解析不到（已删除）返回 undefined——任务当前模型不可用，判定走 fail-open。
   */
  profileFor: (profileId: string) => Promise<ProviderProfile | undefined>;
  /** 目标事件下发 */
  emit: (taskId: string, event: GoalEvent) => void;
  /** 应用退出中：idle 边界不做编排 */
  isStopping: () => boolean;
}) {
  const { manager } = deps;

  /** 推进当前目标的状态机并下发状态快照；无目标 / 越界转换由 agent-core 抛错 */
  function transition(taskId: string, change: GoalTransition): GoalRecord {
    const goal = manager.transitionGoal(taskId, change);
    deps.emit(taskId, { type: "goal-changed", goal });
    return goal;
  }

  /** 进行中的目标转「已暂停」；不在进行中（含无目标）时幂等无操作 */
  function pauseIfActive(taskId: string): GoalRecord | null {
    if (manager.goal(taskId)?.status !== "active") return null;
    return transition(taskId, "pause");
  }

  return {
    /**
     * Stop = 暂停（ADR 0035「Stop 按钮在目标激活时等价于暂停（可恢复）」）：
     * 进行中的目标转「已暂停」，目标与累计账目保留。返回更新后的目标；
     * 目标不在进行中时返回 null（普通任务的停止路径不受影响）。
     * 票 04 的暂停按钮与本入口同一语义。
     */
    pause(taskId: string): GoalRecord | null {
      return pauseIfActive(taskId);
    },

    /**
     * 回合结束的 idle 边界（消息流结束、执行登记注销之前调用）。
     * - 无进行中目标：none，调用方照常收尾；
     * - 回合正常结束：发起完成判定 → 通过：已完成；未通过：本票不续跑，
     *   转已暂停（票 03 在此接续跑）；
     * - 回合被中断 / 出错：不判定，转已暂停——目标不会停在「进行中却没有
     *   回合在跑」的空转态。
     * signal 为本轮的中断信号：判定在途被中断（Stop）时不留结论并转已暂停。
     */
    async afterTurn(
      taskId: string,
      options: {
        signal?: AbortSignal;
        outcome: "completed" | "failed" | "interrupted" | null;
      }
    ): Promise<GoalBoundaryResult> {
      if (deps.isStopping()) return { action: "skipped" };
      if (manager.goal(taskId)?.status !== "active") return { action: "none" };
      if (options.outcome !== "completed") {
        pauseIfActive(taskId);
        return { action: "paused" };
      }
      const record = manager.list().find((item) => item.id === taskId);
      const profile =
        record?.providerProfileId === null ||
        record?.providerProfileId === undefined
          ? undefined
          : await deps.profileFor(record.providerProfileId);
      // 等待解析期间目标可能已被暂停（Stop）、应用可能开始退出：verifyGoal
      // 对非进行中目标返回 skipped，这里只需处理在途被中断
      const result = await manager.verifyGoal(taskId, {
        profile,
        signal: options.signal,
      });
      if (result.kind === "skipped") return { action: "skipped" };
      if (result.kind === "aborted") {
        // 判定在途被中断：不留结论。Stop 路径已暂停目标，此处兜底保证不空转；
        // 应用退出（退出屏障中断了在途判定）不动目标状态——与「回合在途被
        // 退出中断」同口径，重启后的恢复统一由恢复链路负责
        if (!deps.isStopping()) pauseIfActive(taskId);
        return { action: "paused" };
      }
      deps.emit(taskId, {
        type: "goal-verification",
        verification: result.verification,
      });
      return {
        action: "verified",
        status: result.verification.passed
          ? transition(taskId, "complete").status
          : transition(taskId, "pause").status,
      };
    },
  };
}

export type GoalOrchestrator = ReturnType<typeof createGoalOrchestrator>;
