// 目标模式续跑循环（ADR 0035 票 03）呈现层的纯函数与消息段归并：判定标记行三态
// 文案（验证中 → 已完成 / 未完成 / 判定不可用）、下一步方向摘要、进度行的「验证中」
// 副状态与暂停原因、续跑轮不产生用户气泡。
// Seam：纯函数（goal-view）与任务视图状态机（live-task 的 receiveLiveEvent /
// hydrateLiveTask、task-view 的 applyTaskEvent / initialTranscript）。
// 标记行的渲染见 goal-marker-ui；WorkspacePage 的接线见 workspace-goal-ui。
import { describe, expect, it } from "vitest";
import {
  GOAL_MAX_VERIFICATION_FAILURES,
  type GoalRecord,
  type GoalVerificationRecord,
} from "@codexlike/agent-core";
import type { TaskEventEnvelope, TaskView } from "@codexlike/desktop/ipc";

import {
  applyTaskEvent,
  initialTranscript,
  type MessageSegment,
} from "../src/lib/task-view";
import {
  hydrateLiveTask,
  receiveLiveEvent,
  type LiveTask,
} from "../src/lib/live-task";
import { groupTurns } from "../src/lib/turn-view";
import {
  goalNextStepText,
  goalPauseReason,
  goalStatusText,
  goalVerificationText,
  goalVerifyingText,
} from "../src/lib/goal-view";

const TASK = "goal-task";
const GOAL_ID = "goal-1";
const GOAL_TEXT = "让示例测试全部通过";

function goalOf(
  status: GoalRecord["status"],
  overrides: Partial<GoalRecord> = {}
): GoalRecord {
  return {
    id: GOAL_ID,
    taskId: TASK,
    text: GOAL_TEXT,
    status,
    activeMs: 0,
    activeSince: status === "active" ? "2026-11-25T08:00:00.000Z" : null,
    createdAt: "2026-11-25T08:00:00.000Z",
    updatedAt: "2026-11-25T08:00:00.000Z",
    idleStreak: 0,
    failureStreak: 0,
    ...overrides,
  };
}

function verification(
  round: number,
  outcome: GoalVerificationRecord["outcome"],
  overrides: Partial<GoalVerificationRecord> = {}
): GoalVerificationRecord {
  return {
    id: `gv-${round}`,
    taskId: TASK,
    goalId: GOAL_ID,
    round,
    passed: outcome === "passed",
    outcome,
    reason:
      outcome === "passed"
        ? "示例测试已全部通过"
        : outcome === "unpassed"
          ? "尚有步骤未完成"
          : "完成判定不可用（HTTP 401），本轮没有判定结论",
    nextAction: outcome === "unpassed" ? "继续实现剩余步骤" : "",
    toolActivity: outcome !== "passed",
    createdAt: `2026-11-25T08:00:0${round + 1}.000Z`,
    ...overrides,
  };
}

describe("判定标记行文案（三态）", () => {
  it("验证中 / 已完成 / 未完成 / 判定不可用各有文案；判定不可用不写成「未完成」", () => {
    expect(goalVerifyingText(3)).toBe("第 3 次迭代 · 验证中");
    expect(goalVerificationText(verification(1, "passed"))).toBe(
      "第 1 次迭代 · 已完成"
    );
    expect(goalVerificationText(verification(1, "unpassed"))).toBe(
      "第 1 次迭代 · 未完成"
    );
    // 判定自身故障：如实说明判定不可用，不冒充判定给出的「未完成」
    const unavailable = goalVerificationText(verification(2, "unavailable"));
    expect(unavailable).toContain("判定不可用");
    expect(unavailable).toContain("第 2 次迭代");
    expect(unavailable).not.toContain("未完成");
  });

  it("下一步方向摘要：未完成且判定给出方向时取下一步方向；通过 / 判定不可用 / 没给方向时没有", () => {
    expect(goalNextStepText(verification(1, "unpassed"))).toBe(
      "下一步：继续实现剩余步骤"
    );
    expect(goalNextStepText(verification(1, "passed"))).toBeNull();
    expect(goalNextStepText(verification(1, "unavailable"))).toBeNull();
    expect(
      goalNextStepText(verification(1, "unpassed", { nextAction: "" }))
    ).toBeNull();
  });
});

describe("进度行状态与暂停原因", () => {
  it("进行中的目标在判定在途时显示「验证中」，其余时刻显示状态称谓", () => {
    expect(goalStatusText(goalOf("active"), false)).toBe("进行中");
    expect(goalStatusText(goalOf("active"), true)).toBe("验证中");
    // 「验证中」只属于进行中：其他状态不受副状态影响
    expect(goalStatusText(goalOf("paused"), true)).toBe("已暂停");
    expect(goalStatusText(goalOf("completed"), false)).toBe("已完成");
  });

  it("因完成判定连续不可用而暂停时给出原因；其他暂停与进行中的目标没有原因", () => {
    expect(
      goalPauseReason(
        goalOf("paused", { failureStreak: GOAL_MAX_VERIFICATION_FAILURES })
      )
    ).toBe("完成判定连续 3 次不可用");
    // 手动暂停 / 出错暂停：没有原因说明
    expect(goalPauseReason(goalOf("paused"))).toBeNull();
    // 故障计数未达阈值时处于已暂停（如点停止）：不是这个原因
    expect(goalPauseReason(goalOf("paused", { failureStreak: 1 }))).toBeNull();
    expect(
      goalPauseReason(
        goalOf("active", { failureStreak: GOAL_MAX_VERIFICATION_FAILURES })
      )
    ).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 消息段归并：验证中占位、原位升级、续跑轮不产生用户气泡                  */
/* ------------------------------------------------------------------ */

const idle = {
  running: false,
  waitingForUser: false,
  outcome: null,
  unread: false,
} as const;
const running = { ...idle, running: true } as const;

const goalUserMessage = {
  id: "u1",
  taskId: TASK,
  role: "user" as const,
  content: GOAL_TEXT,
  createdAt: "2026-11-25T08:00:00.000Z",
};
const continuationMessage = {
  id: "gc-1",
  taskId: TASK,
  role: "goal-continuation" as const,
  content: "【目标续跑】请继续推进目标",
  createdAt: "2026-11-25T08:00:03.000Z",
};
const reply = (id: string, content: string, second: number) => ({
  id,
  taskId: TASK,
  role: "assistant" as const,
  content,
  createdAt: `2026-11-25T08:00:0${second}.000Z`,
});

function receive(
  state: LiveTask,
  sequence: number,
  event: TaskEventEnvelope["event"],
  activity: TaskEventEnvelope["activity"] = idle,
  executionId = "exec-1"
): LiveTask {
  return receiveLiveEvent(state, {
    taskId: TASK,
    executionId,
    sequence,
    activity,
    event,
  });
}

/** 目标首轮已收尾的任务视图：用户目标 → 回复结束（目标仍进行中） */
function settledFirstTurn(): LiveTask {
  let state = hydrateLiveTask({
    taskId: TASK,
    executionId: "exec-1",
    sequence: 0,
    history: [],
    subagents: [],
    terminals: [],
    events: [],
    pendingInteractions: [],
    activity: idle,
    goal: goalOf("active"),
  } as unknown as TaskView);
  state = receive(
    state,
    1,
    { type: "user-message", message: goalUserMessage },
    running
  );
  return receive(
    state,
    2,
    { type: "assistant-done", message: reply("a1", "做了一部分。", 1) },
    running
  );
}

const verifying = {
  type: "goal-verifying",
  goalId: GOAL_ID,
  round: 1,
} as const;

describe("消息段归并：验证中 → 结论", () => {
  it("goal-verifying 在尾部追加占位行；结论到达后同一行原位升级（序号与轮次归属不变）", () => {
    const withPending = receive(settledFirstTurn(), 3, verifying);
    expect(withPending.items.at(-1)).toMatchObject({
      kind: "goal-verification",
      pending: { goalId: GOAL_ID, round: 1 },
      turnId: "u1",
    });
    const pendingSeq = withPending.items.at(-1)!.seq;

    const concluded = receive(
      withPending,
      4,
      {
        type: "goal-verification",
        verification: verification(1, "unpassed"),
      },
      { ...running, goalPhase: "verifying" }
    );

    // 原位升级：行数不变、序号不变、段 id 换成验证记录 id（与重启恢复同形）
    expect(concluded.items).toHaveLength(3);
    expect(concluded.items.at(-1)).toEqual({
      kind: "goal-verification",
      id: "gv-1",
      seq: pendingSeq,
      turnId: "u1",
      responseId: null,
      at: Date.parse("2026-11-25T08:00:02.000Z"),
      verification: verification(1, "unpassed"),
    });
  });

  it("同一占位信号重复到达不重复占位；错过占位信号时结论照常追加", () => {
    const once = receive(settledFirstTurn(), 3, verifying);
    const twice = receive(once, 4, { ...verifying, round: 1 });
    expect(twice.items).toHaveLength(3);

    // 错过「验证中」信号（如切走再切回）：结论照常入流
    const concluded = receive(settledFirstTurn(), 3, {
      type: "goal-verification",
      verification: verification(1, "passed"),
    });
    expect(concluded.items.map((item) => item.kind)).toEqual([
      "user",
      "assistant",
      "goal-verification",
    ]);
    expect(concluded.items.at(-1)).toMatchObject({ id: "gv-1" });
  });

  it("目标离开进行中（已暂停 / 清除）：还没出结论的占位行撤下，不留永远的「验证中」", () => {
    const withPending = receive(settledFirstTurn(), 3, verifying);

    expect(
      receive(withPending, 4, {
        type: "goal-changed",
        goal: goalOf("paused"),
      }).items.map((item) => item.kind)
    ).toEqual(["user", "assistant"]);
    expect(
      receive(withPending, 4, { type: "goal-changed", goal: null }).items.map(
        (item) => item.kind
      )
    ).toEqual(["user", "assistant"]);
    // 目标仍在进行中（如恢复）：占位行保留
    expect(
      receive(withPending, 4, {
        type: "goal-changed",
        goal: goalOf("active"),
      }).items
    ).toBe(withPending.items);

    // 已有结论的标记行是留痕：不因目标离开进行中被撤下
    const concluded = receive(withPending, 4, {
      type: "goal-verification",
      verification: verification(1, "unpassed"),
    });
    expect(
      receive(concluded, 5, {
        type: "goal-changed",
        goal: goalOf("paused"),
      }).items
    ).toBe(concluded.items);
  });
});

describe("消息段归并：续跑轮是内部输入", () => {
  const user: MessageSegment = {
    kind: "user",
    id: "u1",
    seq: 0,
    turnId: "u1",
    responseId: null,
    content: GOAL_TEXT,
  };
  const assistant = (id: string, content: string): MessageSegment => ({
    kind: "assistant",
    id,
    seq: 0,
    turnId: "u1",
    responseId: id,
    content,
  });

  it("goal-continuation 事件不产生用户段：续跑轮的回复归入目标所在的轮次", () => {
    let items: MessageSegment[] = [user, assistant("a1", "第一轮。")];

    items = applyTaskEvent(items, {
      type: "goal-continuation",
      message: continuationMessage,
    });
    expect(items).toHaveLength(2);

    // 续跑轮的增量照常入流，轮次标签是目标的用户消息（用户只说过一次话）
    items = applyTaskEvent(items, {
      type: "assistant-delta",
      messageId: "a2",
      delta: "第二轮",
    });
    expect(items.at(-1)).toMatchObject({ kind: "assistant", turnId: "u1" });
    expect(groupTurns(items).map((turn) => turn.turnId)).toEqual(["u1"]);
  });

  it("运行期与重启恢复同构：时间线里的 goal-continuation 消息同样不产生用户段", () => {
    const restored = initialTranscript([
      { kind: "message", message: goalUserMessage },
      { kind: "message", message: reply("a1", "第一轮。", 1) },
      { kind: "goal-verification", verification: verification(1, "unpassed") },
      { kind: "message", message: continuationMessage },
      { kind: "message", message: reply("a2", "第二轮。", 4) },
      { kind: "goal-verification", verification: verification(2, "passed") },
    ]);

    expect(restored.map((item) => [item.kind, item.turnId])).toEqual([
      ["user", "u1"],
      ["assistant", "u1"],
      ["goal-verification", "u1"],
      ["assistant", "u1"],
      ["goal-verification", "u1"],
    ]);
  });

  it("续跑轮的事件按新执行接续（goal-continuation 是执行的起点信号），全程不产生用户气泡", () => {
    let state = settledFirstTurn();
    state = receive(state, 3, verifying, {
      ...running,
      goalPhase: "verifying",
    } as const);
    state = receive(
      state,
      4,
      {
        type: "goal-verification",
        verification: verification(1, "unpassed"),
      },
      running
    );
    expect(state.items.map((item) => item.kind)).toEqual([
      "user",
      "assistant",
      "goal-verification",
    ]);

    // 续跑轮是新的宿主执行：goal-continuation 作为起点信号切换执行现场
    // （任务水位跨执行不重置，续跑轮的事件序号接着上一轮往后排）
    state = receive(
      state,
      5,
      { type: "goal-continuation", message: continuationMessage },
      running,
      "exec-2"
    );
    expect(state.executionId).toBe("exec-2");
    state = receive(
      state,
      6,
      { type: "assistant-delta", messageId: "a2", delta: "第二轮" },
      running,
      "exec-2"
    );

    expect(state.items.map((item) => [item.kind, item.turnId])).toEqual([
      ["user", "u1"],
      ["assistant", "u1"],
      ["goal-verification", "u1"],
      ["assistant", "u1"],
    ]);
  });
});
