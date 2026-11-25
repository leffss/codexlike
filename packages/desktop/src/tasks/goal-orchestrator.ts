import {
  GOAL_MAX_VERIFICATION_FAILURES,
  buildGoalContinuationInput,
  type GoalContinuationBasis,
  type GoalRecord,
  type GoalTransition,
  type GoalVerificationRecord,
  type ProviderProfile,
  type TaskManager,
} from "@codexlike/agent-core/node";

import type { TaskEventEnvelope } from "../shared/ipc";

/**
 * goal 编排器（ADR 0035，GLOSSARY「目标模式」）：跨回合编排住在 desktop 宿主
 * （落位先例 = 输入队列——agent-core 不知道宿主的空闲语义）。本模块是回合
 * 结束的 idle 边界与目标控制动作的唯一衔接点——agent-core 提供目标实体、
 * 六态状态机与一次完整判定（TaskManager.verifyGoal），这里决定何时判定、
 * 判定后目标去哪、何时发起下一轮。
 *
 * 续跑循环（票 03）：
 *   回合正常结束 → 完成判定 → 通过：已完成
 *                           → 未过：以内部输入发起下一轮（续跑轮不产生用户气泡）
 *                           → 判定自身不可用：同样续跑（fail-open 定案），
 *                             连续 GOAL_MAX_VERIFICATION_FAILURES 轮才转已暂停
 *   回合被中断 / 出错 → 不判定，直接已暂停（不让目标停在「进行中却没有回合在跑」）
 *
 * 每一轮回合是一次独立的宿主执行（各自的执行登记、中断通道与事件现场）；
 * 「两轮之间」目标仍在推进——这段循环的存活状态记在这里（loops），宿主据此
 * 把任务视为持续执行：输入队列不自动消费、占任务并发一席、侧栏显示运行中。
 * 循环只在两种场合开始存活：回合结束的 idle 边界上目标仍进行中（首轮与每个
 * 续跑轮），以及恢复（continueTurn，票 04 的恢复入口）。循环结束时目标必不
 * 在进行中，除非是应用退出（目标状态原样，重启后的恢复由恢复链路负责）。
 */

/** idle 边界的处置结果（供调用方与测试观察） */
export type GoalBoundaryResult =
  /** 目标不在循环中（无目标 / 已离开进行中）：与目标模式无关的普通回合 */
  | { action: "none" }
  /** 判定通过：目标已转「已完成」 */
  | { action: "verified"; status: GoalRecord["status"] }
  /** 判定未过或判定不可用：调用方注销本轮执行登记后发起续跑轮 */
  | { action: "continue"; verification: GoalVerificationRecord }
  /** 目标已转「已暂停」 */
  | { action: "paused"; reason: GoalPauseReason }
  /** 未发起判定或未改目标状态（目标被暂停 / 应用退出） */
  | { action: "skipped" };

/** 目标在 idle 边界转已暂停的原因 */
export type GoalPauseReason =
  /** 回合被用户中断（Stop） */
  | "turn-interrupted"
  /** 回合出错（模型请求失败等） */
  | "turn-failed"
  /** 完成判定在途被中断（Stop；不留结论） */
  | "verification-interrupted"
  /** 完成判定连续不可用，达到暂停阈值 */
  | "verification-unavailable";

/** 目标事件（任务级信封，经 task:events 下发到全部工作台窗口） */
export type GoalEvent = Extract<
  TaskEventEnvelope["event"],
  { type: "goal-changed" | "goal-verifying" | "goal-verification" }
>;

/** 循环的阶段：一轮回合在跑 / 完成判定在途 */
type GoalLoopPhase = "turn" | "verifying";

export function createGoalOrchestrator(deps: {
  manager: TaskManager;
  /**
   * 任务上次发送所用 Provider Profile 的解析（apiKey 只在主进程解密）；
   * 解析不到（已删除）返回 undefined——任务当前模型不可用，判定记为不可用。
   */
  profileFor: (profileId: string) => Promise<ProviderProfile | undefined>;
  /** 目标事件下发 */
  emit: (taskId: string, event: GoalEvent) => void;
  /** 应用退出中：idle 边界不做编排 */
  isStopping: () => boolean;
  /**
   * 发起一轮目标循环自己的回合（续跑轮；恢复后的首轮同此）：走宿主发送主路径
   * 的内部入口，text 是续跑指令。启动成功（回合已开始）即 resolve；启动失败以
   * 异常抛回，由这里处置（应用退出中除外：目标状态原样）。
   */
  startTurn: (taskId: string, text: string) => Promise<void>;
}) {
  const { manager } = deps;
  /** 本进程内存活的目标循环：任务 id → 阶段。条目存在 ⟺ 目标在进行且有循环在推进 */
  const loops = new Map<string, GoalLoopPhase>();

  /** 目标循环是否在进行（判定在途、回合在跑、或两轮之间） */
  function isRunning(taskId: string): boolean {
    return loops.has(taskId);
  }

  /** 「验证中」副状态：完成判定在途；其余时刻（回合在跑 / 轮间窗口）为 null */
  function phase(taskId: string): GoalLoopPhase | null {
    return loops.get(taskId) ?? null;
  }

  function endLoop(taskId: string): void {
    loops.delete(taskId);
  }

  /**
   * 推进当前目标的状态机并下发状态快照；离开进行中即循环结束——这是循环
   * 存活状态与目标状态保持一致的单点（外部一律经此，见返回对象上的 transition）。
   */
  function applyTransition(taskId: string, change: GoalTransition): GoalRecord {
    const goal = manager.transitionGoal(taskId, change);
    if (goal.status !== "active") endLoop(taskId);
    deps.emit(taskId, { type: "goal-changed", goal });
    return goal;
  }

  /** 进行中的目标转「已暂停」；不在进行中（含无目标）时幂等无操作 */
  function pauseIfActive(taskId: string): GoalRecord | null {
    if (manager.goal(taskId)?.status !== "active") {
      endLoop(taskId);
      return null;
    }
    return applyTransition(taskId, "pause");
  }

  return {
    isRunning,
    phase,

    /**
     * Stop = 暂停（ADR 0035「Stop 按钮在目标激活时等价于暂停（可恢复）」）：
     * 进行中的目标转「已暂停」，目标与累计账目保留。返回更新后的目标；
     * 目标不在进行中时返回 null（普通任务的停止路径不受影响）。
     * 回合在途时由调用方先中断回合（中断的回合在 idle 边界转已暂停）；
     * 两轮之间没有在途回合，调用方直接调本入口——待发起的续跑轮据此作废。
     * 票 04 的暂停按钮与本入口同一语义。
     */
    pause(taskId: string): GoalRecord | null {
      return pauseIfActive(taskId);
    },

    /**
     * 推进当前目标的状态机并下发状态快照；离开进行中即循环结束。
     * 控制面（票 04 的清除）与护栏（票 05 的未达成 / 预算受限）经此推进目标——
     * 不要直接调 manager.transitionGoal：那样循环的存活状态不会随之结束，任务
     * 会一直显示运行中、输入队列一直不消费。越界转换（如已完成后暂停）由
     * agent-core 状态机以中文错误拒绝，循环存活状态不受影响（转换未发生）。
     * 回合在途时推进到离开进行中：回合照常跑完，idle 边界不再判定、不再续跑；
     * 需要立即停下回合的由调用方先中断（与 Stop 同一路径）。
     */
    transition(taskId: string, change: GoalTransition): GoalRecord {
      // 状态机先于一切：转换被拒绝时抛错返回，循环存活状态与事件都未动
      return applyTransition(taskId, change);
    },

    /**
     * 目标进行中的任务开始了一轮回合：循环自此在本进程存活（首轮与每个续跑轮
     * 同此）。回合结束的终态事件下发时任务已是「目标循环进行中」——从终态事件
     * 到 idle 边界发起判定之间没有「回合已收尾、循环尚未登记」的空闲空窗，
     * 侧栏与输入队列的运行口径保持连续。目标不在进行中时无操作。
     */
    turnStarted(taskId: string): void {
      if (deps.isStopping()) return;
      if (manager.goal(taskId)?.status === "active") loops.set(taskId, "turn");
    },

    /**
     * 回合结束的 idle 边界（消息流结束、执行登记注销之前调用）。
     * - 目标不在进行中：none，调用方照常收尾；
     * - 目标进行中：回合被中断 / 出错 → 不判定，转已暂停；回合正常结束 →
     *   完成判定 → 通过：已完成；未过 / 判定不可用：continue，由调用方注销
     *   本轮执行登记后调 continueTurn 发起下一轮。
     * signal 为本轮的中断信号：判定在途被中断（Stop）时不留结论并转已暂停；
     * 应用退出中断了在途判定则不动目标状态。
     * toolActivity：刚结束的这一轮是否有实质工具活动（逐轮记账的输入）。
     */
    async afterTurn(
      taskId: string,
      options: {
        signal?: AbortSignal;
        outcome: "completed" | "failed" | "interrupted" | null;
        toolActivity: boolean;
      }
    ): Promise<GoalBoundaryResult> {
      if (deps.isStopping()) {
        // 应用退出中断了在途回合：循环就此结束，目标状态原样
        endLoop(taskId);
        return { action: "skipped" };
      }
      if (manager.goal(taskId)?.status !== "active") {
        endLoop(taskId);
        return { action: "none" };
      }
      loops.set(taskId, "turn");
      if (options.outcome !== "completed") {
        pauseIfActive(taskId);
        return {
          action: "paused",
          reason:
            options.outcome === "failed" ? "turn-failed" : "turn-interrupted",
        };
      }
      const record = manager.list().find((item) => item.id === taskId);
      const profile =
        record?.providerProfileId === null ||
        record?.providerProfileId === undefined
          ? undefined
          : await deps.profileFor(record.providerProfileId);
      // 等待解析期间目标可能已被暂停（Stop）、应用可能开始退出
      if (deps.isStopping() || manager.goal(taskId)?.status !== "active") {
        endLoop(taskId);
        return { action: "skipped" };
      }
      const goal = manager.goal(taskId)!;
      // 「验证中」：标记行占位与进度行副状态的实时信号（结论到达后原位升级）
      loops.set(taskId, "verifying");
      deps.emit(taskId, {
        type: "goal-verifying",
        goalId: goal.id,
        round: manager.goalVerifications(taskId).length + 1,
      });
      const result = await manager.verifyGoal(taskId, {
        profile,
        signal: options.signal,
        toolActivity: options.toolActivity,
      });
      if (result.kind === "skipped") {
        endLoop(taskId);
        return { action: "skipped" };
      }
      if (result.kind === "aborted") {
        // 判定在途被中断：不留结论。Stop 路径已暂停目标，此处兜底保证不空转；
        // 应用退出（退出屏障中断了在途判定）不动目标状态——与「回合在途被
        // 退出中断」同口径，重启后的恢复统一由恢复链路负责
        if (!deps.isStopping()) pauseIfActive(taskId);
        endLoop(taskId);
        return { action: "paused", reason: "verification-interrupted" };
      }
      const { verification } = result;
      deps.emit(taskId, { type: "goal-verification", verification });
      if (verification.outcome === "passed") {
        return {
          action: "verified",
          status: applyTransition(taskId, "complete").status,
        };
      }
      // fail-open 定案：判定自身不可用的轮次照常续跑，不因单次网络抖动打断整夜
      // 推进；但判定持续不可用就没有人判断完成与否——连续达到阈值转已暂停，
      // 原因对用户可见（目标记录上的 failureStreak 与标记行）
      if (
        verification.outcome === "unavailable" &&
        (manager.goal(taskId)?.failureStreak ?? 0) >=
          GOAL_MAX_VERIFICATION_FAILURES
      ) {
        pauseIfActive(taskId);
        return { action: "paused", reason: "verification-unavailable" };
      }
      loops.set(taskId, "turn");
      return { action: "continue", verification };
    },

    /**
     * 发起目标循环的下一轮（续跑轮 / 恢复后的首轮共用的再入点）：以内部输入
     * 走宿主发送主路径，消息流不产生用户气泡。调用方须先注销上一轮的执行
     * 登记（上一轮回合与续跑轮是两次独立的宿主执行）。
     * - 判定未过：下一步方向与判定理由进入续跑指令；
     * - 判定不可用：如实告知模型上一轮完成判定不可用、请继续推进；
     * - 恢复（票 04）：目标转回进行中后以 resume 调本方法从暂停点再入循环。
     * 只对进行中的目标生效（其余情形无操作，循环随之结束）。启动失败：目标转
     * 已暂停（不留「进行中却没有回合」）；应用退出中则目标状态原样。
     */
    async continueTurn(
      taskId: string,
      basis: GoalContinuationBasis
    ): Promise<void> {
      const goal = manager.goal(taskId);
      if (deps.isStopping() || goal === null || goal.status !== "active") {
        endLoop(taskId);
        return;
      }
      loops.set(taskId, "turn");
      try {
        await deps.startTurn(taskId, buildGoalContinuationInput(goal, basis));
      } catch (error) {
        endLoop(taskId);
        if (deps.isStopping()) return;
        console.error("[tasks] 目标续跑轮发起失败，目标已暂停", error);
        pauseIfActive(taskId);
      }
    },

    /**
     * 编排异常的兜底：结束循环，进行中的目标转已暂停——编排器出错不得把目标
     * 留在「进行中却没有循环在推进」的状态（那会让任务一直显示运行中、输入
     * 队列一直不消费）。
     */
    abandon(taskId: string): void {
      endLoop(taskId);
      pauseIfActive(taskId);
    },
  };
}

export type GoalOrchestrator = ReturnType<typeof createGoalOrchestrator>;
