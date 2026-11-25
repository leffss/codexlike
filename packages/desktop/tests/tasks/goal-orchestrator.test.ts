import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GoalRecord,
  GoalTransition,
  GoalVerificationOutcome,
  TaskManager,
} from "@codexlike/agent-core/node";
import {
  createGoalOrchestrator,
  type GoalEvent,
} from "../../src/tasks/goal-orchestrator";

/**
 * goal 编排器（ADR 0035）的接缝级用例：不经 IPC、不接模型，只看编排器对「何时
 * 发起下一轮、何时结束循环」的决策——重点是还没有 IPC 调用方的控制面接缝
 * （票 04 的恢复入口：状态机 resume → continueTurn({ kind: "resume" })）、两道
 * 护栏在 idle 边界的处置结果（票 05）与异常兜底。续跑循环的端到端行为见
 * goal-continuation-ipc.test.ts / goal-guardrails-ipc.test.ts（真实 TaskManager
 * + mock 模型）。这里的 manager 是编排器注入端口上的内存替身：只实现目标 API 面。
 */

/** 一次脚本化判定的结局：结论种类，以及记账后目标记录上的连续计数 */
interface VerdictStep {
  outcome: GoalVerificationOutcome;
  after?: Partial<GoalRecord>;
}

function fakeManager(initial: Pick<GoalRecord, "taskId" | "status" | "text">) {
  let goal: GoalRecord = {
    id: "goal-1",
    activeMs: 0,
    activeSince: null,
    createdAt: "2026-11-25T08:00:00.000Z",
    updatedAt: "2026-11-25T08:00:00.000Z",
    idleStreak: 0,
    failureStreak: 0,
    budgetTokens: null,
    baselineTokens: 0,
    ...initial,
  };
  /** 任务用量账目（四列之和） */
  let usageTokens = 0;
  const verdicts: VerdictStep[] = [];
  const NEXT: Partial<Record<GoalTransition, GoalRecord["status"]>> = {
    resume: "active",
    pause: "paused",
    complete: "completed",
    unmet: "unmet",
    "budget-limit": "budget-limited",
    clear: "cleared",
  };
  const manager: Pick<
    TaskManager,
    | "goal"
    | "transitionGoal"
    | "setGoalBudget"
    | "editGoal"
    | "list"
    | "verifyGoal"
    | "goalVerifications"
  > = {
    goal: () => goal,
    transitionGoal(_taskId: string, transition: GoalTransition) {
      goal = { ...goal, status: NEXT[transition] ?? goal.status };
      return goal;
    },
    setGoalBudget(_taskId: string, tokens: number) {
      goal = { ...goal, budgetTokens: tokens };
      return goal;
    },
    editGoal(_taskId: string, text: string) {
      goal = { ...goal, text };
      return goal;
    },
    list: () => [
      {
        id: "task-1",
        title: "demo",
        projectId: null,
        workspacePath: "C:/work/demo",
        workspaceMode: "local",
        workspaceOriginPath: null,
        providerProfileId: null,
        model: null,
        status: "idle",
        approvalMode: "assist",
        autoApprove: false,
        mainInputTokens: usageTokens,
        mainOutputTokens: 0,
        subagentInputTokens: 0,
        subagentOutputTokens: 0,
        archivedAt: null,
        pinned: false,
        creationRequestId: null,
        createdAt: "2026-11-25T08:00:00.000Z",
        updatedAt: "2026-11-25T08:00:00.000Z",
      },
    ],
    async verifyGoal() {
      const step = verdicts.shift();
      if (step === undefined) throw new Error("判定脚本已耗尽");
      goal = { ...goal, ...step.after };
      return {
        kind: "verified" as const,
        verification: {
          id: "gv-1",
          taskId: "task-1",
          goalId: goal.id,
          round: 1,
          passed: step.outcome === "passed",
          outcome: step.outcome,
          reason: "判定理由",
          nextAction: step.outcome === "unpassed" ? "继续" : "",
          toolActivity: false,
          createdAt: "2026-11-25T08:00:01.000Z",
        },
      };
    },
    goalVerifications: () => [],
  };
  return {
    manager: manager as unknown as TaskManager,
    goal: () => goal,
    verdicts,
    /** 直接改写目标记录（构造已有的连续计数 / 预算） */
    patchGoal(patch: Partial<GoalRecord>) {
      goal = { ...goal, ...patch };
    },
    setUsage(tokens: number) {
      usageTokens = tokens;
    },
  };
}

function setup(options: {
  goal: Pick<GoalRecord, "taskId" | "status" | "text">;
  stopping?: () => boolean;
  startTurn?: () => Promise<void>;
}) {
  const fake = fakeManager(options.goal);
  const events: GoalEvent[] = [];
  const started: string[] = [];
  let stopping = false;
  const orchestrator = createGoalOrchestrator({
    manager: fake.manager,
    profileFor: async () => undefined,
    emit: (_taskId, event) => events.push(event),
    isStopping: () => (options.stopping ? options.stopping() : stopping),
    startTurn: async (_taskId, text) => {
      started.push(text);
      await options.startTurn?.();
    },
  });
  return {
    orchestrator,
    events,
    started,
    fake,
    setStopping: (v: boolean) => {
      stopping = v;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("goal 编排器接缝：恢复后再入循环（票 04 的恢复入口）", () => {
  it('已暂停的目标经状态机恢复后，continueTurn({ kind: "resume" }) 以内部输入发起下一轮：指令复述目标并要求从暂停点继续，循环重新存活', async () => {
    const app = setup({
      goal: { taskId: "task-1", status: "paused", text: "让示例测试全部通过" },
    });
    expect(app.orchestrator.isRunning("task-1")).toBe(false);

    // 恢复 = 状态机转回进行中（控制面的职责），随后经同一接缝再入循环
    app.fake.manager.transitionGoal("task-1", "resume");
    await app.orchestrator.continueTurn("task-1", { kind: "resume" });

    expect(app.started).toHaveLength(1);
    expect(app.started[0]).toContain("让示例测试全部通过");
    expect(app.started[0]).toContain("暂停");
    expect(app.orchestrator.isRunning("task-1")).toBe(true);
    expect(app.orchestrator.phase("task-1")).toBe("turn");
  });

  it("目标不在进行中时 continueTurn 不发起回合，循环不存活", async () => {
    const app = setup({
      goal: { taskId: "task-1", status: "paused", text: "目标" },
    });

    await app.orchestrator.continueTurn("task-1", { kind: "resume" });

    expect(app.started).toEqual([]);
    expect(app.orchestrator.isRunning("task-1")).toBe(false);
  });
});

describe("goal 编排器接缝：循环的结束", () => {
  it("续跑轮发起失败：目标转已暂停、循环结束；原因随状态快照下发（进度行的暂停原因，票 04 追加 C）并记入主进程日志", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = setup({
      goal: { taskId: "task-1", status: "active", text: "目标" },
      startTurn: async () => {
        throw new Error("所选 Provider Profile 不存在，请重新选择模型");
      },
    });

    const result = await app.orchestrator.continueTurn("task-1", {
      kind: "resume",
    });

    expect(result).toMatchObject({
      started: false,
      paused: true,
      reason: expect.stringContaining("Provider Profile 不存在"),
    });
    expect(app.fake.goal().status).toBe("paused");
    expect(app.orchestrator.isRunning("task-1")).toBe(false);
    // 原因不再只进主进程日志：随已暂停的状态快照一并下发，界面据此呈现
    expect(app.events.at(-1)).toMatchObject({
      type: "goal-changed",
      goal: { status: "paused" },
      pauseReason: expect.stringContaining("Provider Profile 不存在"),
    });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("续跑轮发起失败"),
      expect.objectContaining({
        message: expect.stringContaining("Provider Profile 不存在"),
      })
    );
  });

  it("续跑轮正常发起：返回已发起；手动暂停的状态快照不携带暂停原因", async () => {
    const app = setup({
      goal: { taskId: "task-1", status: "active", text: "目标" },
    });
    app.orchestrator.turnStarted("task-1");

    expect(
      await app.orchestrator.continueTurn("task-1", { kind: "resume" })
    ).toMatchObject({ started: true });

    app.orchestrator.pause("task-1");
    expect(app.events.at(-1)).toMatchObject({
      type: "goal-changed",
      goal: { status: "paused" },
    });
    expect(app.events.at(-1)).not.toHaveProperty("pauseReason");
  });

  it("应用退出中：续跑轮不发起，循环结束而目标状态原样", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = setup({
      goal: { taskId: "task-1", status: "active", text: "目标" },
      startTurn: async () => {
        throw new Error("应用正在退出，请取消退出后再操作");
      },
    });
    app.orchestrator.turnStarted("task-1");
    expect(app.orchestrator.isRunning("task-1")).toBe(true);
    app.setStopping(true);

    await app.orchestrator.continueTurn("task-1", { kind: "resume" });

    // 退出路径不改目标状态、不记为编排故障
    expect(app.fake.goal().status).toBe("active");
    expect(app.orchestrator.isRunning("task-1")).toBe(false);
    expect(app.events).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  it("回合在途时应用退出：idle 边界不做编排（skipped），循环结束而目标状态原样", async () => {
    const app = setup({
      goal: { taskId: "task-1", status: "active", text: "目标" },
      stopping: () => true,
    });
    app.orchestrator.turnStarted("task-1");

    const boundary = await app.orchestrator.afterTurn("task-1", {
      outcome: "interrupted",
      toolActivity: false,
    });

    expect(boundary).toEqual({ action: "skipped" });
    expect(app.fake.goal().status).toBe("active");
    expect(app.orchestrator.isRunning("task-1")).toBe(false);
    expect(app.events).toEqual([]);
  });

  it("编排异常兜底 abandon：结束循环，进行中的目标转已暂停", () => {
    const app = setup({
      goal: { taskId: "task-1", status: "active", text: "目标" },
    });
    app.orchestrator.turnStarted("task-1");

    app.orchestrator.abandon("task-1");

    expect(app.fake.goal().status).toBe("paused");
    expect(app.orchestrator.isRunning("task-1")).toBe(false);
    expect(app.events.at(-1)).toMatchObject({
      type: "goal-changed",
      goal: { status: "paused" },
    });
  });
});

describe("goal 编排器接缝：状态推进入口（票 04 的清除、票 05 的护栏经此）", () => {
  it.each([
    ["未达成", "unmet"],
    ["预算受限", "budget-limit"],
    ["清除", "clear"],
  ] as const)("%s：经编排器推进后快照下发、循环结束", (_label, change) => {
    const app = setup({
      goal: { taskId: "task-1", status: "active", text: "目标" },
    });
    app.orchestrator.turnStarted("task-1");
    expect(app.orchestrator.isRunning("task-1")).toBe(true);

    const goal = app.orchestrator.transition("task-1", change);

    expect(goal.status).not.toBe("active");
    expect(app.fake.goal().status).toBe(goal.status);
    expect(app.orchestrator.isRunning("task-1")).toBe(false);
    expect(app.events.at(-1)).toEqual({
      type: "goal-changed",
      goal: app.fake.goal(),
    });
  });
});

describe("goal 编排器接缝：护栏在 idle 边界的处置（票 05）", () => {
  const active = {
    taskId: "task-1",
    status: "active" as const,
    text: "目标",
  };
  /** 一次正常结束的回合（无实质工具活动）到达 idle 边界 */
  const boundary = { outcome: "completed" as const, toolActivity: false };

  it("空转阻断：连续 3 轮未过且无活动 → blocked(idle)、目标转未达成、循环结束；未达阈值照常续跑", async () => {
    const app = setup({ goal: active });
    app.orchestrator.turnStarted("task-1");

    app.fake.verdicts.push({ outcome: "unpassed", after: { idleStreak: 2 } });
    expect(await app.orchestrator.afterTurn("task-1", boundary)).toMatchObject({
      action: "continue",
    });
    expect(app.orchestrator.isRunning("task-1")).toBe(true);

    app.fake.verdicts.push({ outcome: "unpassed", after: { idleStreak: 3 } });
    expect(await app.orchestrator.afterTurn("task-1", boundary)).toEqual({
      action: "blocked",
      reason: "idle",
      status: "unmet",
    });
    expect(app.fake.goal().status).toBe("unmet");
    expect(app.orchestrator.isRunning("task-1")).toBe(false);
    expect(app.started).toEqual([]);
    expect(app.events.at(-1)).toMatchObject({
      type: "goal-changed",
      goal: { status: "unmet", idleStreak: 3 },
    });
  });

  it("token 预算：目标用量（账目 − 基线）达到预算 → blocked(budget-exceeded)、目标转预算受限、循环结束", async () => {
    const app = setup({ goal: active });
    app.fake.patchGoal({ budgetTokens: 1000, baselineTokens: 400 });
    app.orchestrator.turnStarted("task-1");

    // 任务账目 1399 → 目标消耗 999：未到，照常续跑
    app.fake.setUsage(1399);
    app.fake.verdicts.push({ outcome: "unpassed" });
    expect(await app.orchestrator.afterTurn("task-1", boundary)).toMatchObject({
      action: "continue",
    });

    // 任务账目 1400 → 目标消耗 1000：达到预算
    app.fake.setUsage(1400);
    app.fake.verdicts.push({ outcome: "unpassed" });
    expect(await app.orchestrator.afterTurn("task-1", boundary)).toEqual({
      action: "blocked",
      reason: "budget-exceeded",
      status: "budget-limited",
    });
    expect(app.orchestrator.isRunning("task-1")).toBe(false);
    expect(app.events.at(-1)).toMatchObject({
      type: "goal-changed",
      goal: { status: "budget-limited", budgetTokens: 1000 },
    });
  });

  it("未设预算 = 不限：任务账目再大也不因预算阻断", async () => {
    const app = setup({ goal: active });
    app.fake.setUsage(10 ** 12);
    app.orchestrator.turnStarted("task-1");
    app.fake.verdicts.push({ outcome: "unpassed" });

    expect(await app.orchestrator.afterTurn("task-1", boundary)).toMatchObject({
      action: "continue",
    });
  });

  it("完成优先于预算：判定通过 → 已完成，即使用量已超预算", async () => {
    const app = setup({ goal: active });
    app.fake.patchGoal({ budgetTokens: 100 });
    app.fake.setUsage(10_000);
    app.orchestrator.turnStarted("task-1");
    app.fake.verdicts.push({ outcome: "passed" });

    expect(await app.orchestrator.afterTurn("task-1", boundary)).toEqual({
      action: "verified",
      status: "completed",
    });
  });

  it("判定连续不可用达到暂停阈值时优先转已暂停（不是预算受限）", async () => {
    const app = setup({ goal: active });
    app.fake.patchGoal({ budgetTokens: 100 });
    app.fake.setUsage(10_000);
    app.orchestrator.turnStarted("task-1");
    app.fake.verdicts.push({
      outcome: "unavailable",
      after: { failureStreak: 3 },
    });

    expect(await app.orchestrator.afterTurn("task-1", boundary)).toEqual({
      action: "paused",
      reason: "verification-unavailable",
    });
  });
});

describe("goal 编排器接缝：预算受限后加预算并恢复（票 04 的恢复入口，票 05 的护栏）", () => {
  const boundary = { outcome: "completed" as const, toolActivity: false };

  /** 走到预算受限：预算 100、任务账目 150 */
  async function hitBudgetLimit() {
    const app = setup({
      goal: { taskId: "task-1", status: "active", text: "目标" },
    });
    app.fake.patchGoal({ budgetTokens: 100 });
    app.fake.setUsage(150);
    app.orchestrator.turnStarted("task-1");
    app.fake.verdicts.push({ outcome: "unpassed" });
    expect(await app.orchestrator.afterTurn("task-1", boundary)).toEqual({
      action: "blocked",
      reason: "budget-exceeded",
      status: "budget-limited",
    });
    return app;
  }

  it("加预算 → 状态机恢复 → continueTurn 从暂停点续跑；恢复后的判定按新预算对账，不再立即受限", async () => {
    const app = await hitBudgetLimit();

    // 预算受限态直接加预算（只改预算），随后经状态机恢复
    app.fake.manager.setGoalBudget("task-1", 1000);
    app.orchestrator.transition("task-1", "resume");
    await app.orchestrator.continueTurn("task-1", { kind: "resume" });

    expect(app.started).toHaveLength(1);
    expect(app.started[0]).toContain("暂停");
    expect(app.orchestrator.isRunning("task-1")).toBe(true);

    // 恢复后的回合到达 idle 边界：用量 150 < 新预算 1000，照常续跑
    app.fake.verdicts.push({ outcome: "unpassed" });
    expect(await app.orchestrator.afterTurn("task-1", boundary)).toMatchObject({
      action: "continue",
    });
    expect(app.fake.goal().status).toBe("active");
  });

  it("对照：不加预算就恢复 → 下一次判定后立即再次预算受限（护栏仍在生效）", async () => {
    const app = await hitBudgetLimit();

    app.orchestrator.transition("task-1", "resume");
    await app.orchestrator.continueTurn("task-1", { kind: "resume" });
    app.fake.verdicts.push({ outcome: "unpassed" });

    expect(await app.orchestrator.afterTurn("task-1", boundary)).toEqual({
      action: "blocked",
      reason: "budget-exceeded",
      status: "budget-limited",
    });
    expect(app.orchestrator.isRunning("task-1")).toBe(false);
  });
});

describe("goal 编排器接缝：编辑与恢复（票 04 的控制面）", () => {
  it("编辑：目标文本更新后下发完整快照；循环存活状态不受影响", () => {
    const app = setup({
      goal: { taskId: "task-1", status: "paused", text: "原文" },
    });

    const goal = app.orchestrator.edit("task-1", "新文本");

    expect(goal).toEqual({ ...app.fake.goal(), text: "新文本" });
    expect(app.events).toEqual([{ type: "goal-changed", goal }]);
    expect(app.orchestrator.isRunning("task-1")).toBe(false);
  });

  it("恢复：状态机转回进行中并下发快照，随后以内部输入从暂停点再入循环", async () => {
    const app = setup({
      goal: { taskId: "task-1", status: "paused", text: "让示例测试全部通过" },
    });

    const result = await app.orchestrator.resume("task-1");

    expect(result).toEqual({ started: true });
    expect(app.fake.goal().status).toBe("active");
    expect(app.events).toEqual([
      { type: "goal-changed", goal: app.fake.goal() },
    ]);
    expect(app.started).toHaveLength(1);
    expect(app.started[0]).toContain("目标此前被暂停，现已恢复");
    expect(app.orchestrator.isRunning("task-1")).toBe(true);
  });
});
