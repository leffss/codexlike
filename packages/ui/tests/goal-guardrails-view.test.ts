// 目标模式护栏（ADR 0035，票 05）的呈现层纯函数：进度行的停留原因（未达成 /
// 预算受限）、token 数量文案与预算输入解析。
import { describe, expect, it } from "vitest";
import {
  GOAL_MAX_IDLE_ROUNDS,
  type GoalRecord,
  type GoalStatus,
} from "@codexlike/agent-core";

import {
  formatGoalTokens,
  goalPauseReason,
  parseGoalBudgetInput,
} from "../src/lib/goal-view";

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
    activeSince: status === "active" ? "2026-11-26T08:00:00.000Z" : null,
    createdAt: "2026-11-26T08:00:00.000Z",
    updatedAt: "2026-11-26T08:00:00.000Z",
    idleStreak: 0,
    failureStreak: 0,
    budgetTokens: null,
    baselineTokens: 0,
    ...overrides,
  };
}

describe("进度行的停留原因：护栏阻断", () => {
  it("未达成：写明连续多少轮判定未过且无实质工具活动", () => {
    expect(
      goalPauseReason(goalOf("unmet", { idleStreak: GOAL_MAX_IDLE_ROUNDS }))
    ).toBe("连续 3 轮判定未过且无实质工具活动");
  });

  it("预算受限：写明目标用量已达到 token 预算", () => {
    expect(
      goalPauseReason(
        goalOf("budget-limited", {
          budgetTokens: 200_000,
          baselineTokens: 500,
        })
      )
    ).toBe("目标用量已达到 token 预算");
  });

  it("进行中与已完成没有停留原因；已暂停仍只对「判定连续不可用」写明原因", () => {
    expect(goalPauseReason(goalOf("active", { idleStreak: 2 }))).toBeNull();
    expect(goalPauseReason(goalOf("completed"))).toBeNull();
    expect(goalPauseReason(goalOf("paused"))).toBeNull();
    expect(goalPauseReason(goalOf("paused", { failureStreak: 3 }))).toBe(
      "完成判定连续 3 次不可用"
    );
  });
});

describe("token 数量文案（进度行的用量 / 预算）", () => {
  it("千分位分组，位数不足四位原样", () => {
    expect(formatGoalTokens(0)).toBe("0");
    expect(formatGoalTokens(999)).toBe("999");
    expect(formatGoalTokens(1234)).toBe("1,234");
    expect(formatGoalTokens(200000)).toBe("200,000");
    expect(formatGoalTokens(1234567)).toBe("1,234,567");
  });
});

describe("预算输入解析（进度行上的预算设置）", () => {
  it("正整数（tokens）原样生效：允许首尾空白", () => {
    expect(parseGoalBudgetInput("200000")).toBe(200_000);
    expect(parseGoalBudgetInput(" 200000 ")).toBe(200_000);
    expect(parseGoalBudgetInput("1")).toBe(1);
  });

  it("空输入、零与负数、小数、非数字一律无效", () => {
    for (const text of ["", "  ", "0", "-5", "1.5", "abc", "1e5", "１２"]) {
      expect(parseGoalBudgetInput(text), JSON.stringify(text)).toBeNull();
    }
  });
});
