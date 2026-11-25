import { describe, expect, it } from "vitest";
import type { GoalRecord, GoalStatus } from "@codexlike/agent-core";
import {
  formatGoalElapsed,
  goalElapsedMs,
  goalSummary,
  goalVerificationText,
} from "../src/lib/goal-view";

/** 目标模式呈现层纯函数（ADR 0035）：累计时长、摘要与标记行文案 */

function goalOf(
  status: GoalStatus,
  overrides: Partial<GoalRecord> = {}
): GoalRecord {
  return {
    id: "goal-1",
    taskId: "task-1",
    text: "让示例测试全部通过",
    status,
    activeMs: 0,
    activeSince: status === "active" ? "2026-11-25T08:00:00.000Z" : null,
    createdAt: "2026-11-25T08:00:00.000Z",
    updatedAt: "2026-11-25T08:00:00.000Z",
    ...overrides,
  };
}

const AT = Date.parse("2026-11-25T08:00:30.000Z");

describe("goalElapsedMs（目标累计时长）", () => {
  it("非进行中：只计已闭合的时长，不随当前时刻增长", () => {
    const paused = goalOf("paused", { activeMs: 65_000 });
    expect(goalElapsedMs(paused, AT)).toBe(65_000);
    expect(goalElapsedMs(paused, AT + 3_600_000)).toBe(65_000);
  });

  it("进行中：已闭合时长 + 当前进行中段的已过时间", () => {
    const active = goalOf("active", {
      activeMs: 10_000,
      activeSince: "2026-11-25T08:00:00.000Z",
    });
    expect(goalElapsedMs(active, AT)).toBe(40_000);
  });

  it("起点缺失或时钟回拨不产生负时长", () => {
    expect(
      goalElapsedMs(
        goalOf("active", { activeMs: 5_000, activeSince: null }),
        AT
      )
    ).toBe(5_000);
    // 当前时刻早于进行中段起点（系统时钟回拨）
    expect(
      goalElapsedMs(
        goalOf("active", { activeSince: "2026-11-25T09:00:00.000Z" }),
        AT
      )
    ).toBe(0);
  });
});

describe("formatGoalElapsed（时长文案）", () => {
  it.each([
    [0, "0 秒"],
    [5_000, "5 秒"],
    [59_000, "59 秒"],
    [60_000, "1 分"],
    [65_000, "1 分 5 秒"],
    [3_600_000, "1 小时"],
    [5_400_000, "1 小时 30 分"],
    [7_265_000, "2 小时 1 分"],
  ])("%i ms → %s", (ms, text) => {
    expect(formatGoalElapsed(ms)).toBe(text);
  });
});

describe("goalSummary（进度行摘要）", () => {
  it("多行目标取首个非空行", () => {
    expect(goalSummary("\n  让示例测试全部通过\n约束：不改公共接口  ")).toBe(
      "让示例测试全部通过"
    );
  });

  it("超长首行截断并以省略号收尾", () => {
    const summary = goalSummary("长".repeat(80));
    expect(summary).toBe(`${"长".repeat(60)}…`);
  });
});

describe("goalVerificationText（判定标记行文案）", () => {
  it("「第 N 次迭代 · 结论」：通过为已完成，未通过为未完成", () => {
    expect(goalVerificationText({ round: 1, passed: true })).toBe(
      "第 1 次迭代 · 已完成"
    );
    expect(goalVerificationText({ round: 3, passed: false })).toBe(
      "第 3 次迭代 · 未完成"
    );
  });
});
