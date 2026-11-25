// @vitest-environment jsdom
// 目标进度行（ADR 0035，GLOSSARY「目标」）：输入框上方常驻——目标摘要、状态、
// 累计时长。jsdom + testing-library 驱动（时长实时跳动依赖定时器）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  GOAL_STATUSES,
  GOAL_STATUS_NAMES,
  type GoalRecord,
  type GoalStatus,
} from "@codexlike/agent-core";

import { GoalProgressRow } from "../src/components/GoalProgressRow";
import { goalPauseReason } from "../src/lib/goal-view";

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
    activeSince: status === "active" ? "2026-11-25T07:59:50.000Z" : null,
    createdAt: "2026-11-25T07:59:50.000Z",
    updatedAt: "2026-11-25T08:00:00.000Z",
    idleStreak: 0,
    failureStreak: 0,
    budgetTokens: null,
    baselineTokens: 0,
    ...overrides,
  };
}

const T0 = new Date("2026-11-25T08:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const elapsed = () => screen.getByTestId("goal-progress-elapsed").textContent;
const statusText = () => screen.getByTestId("goal-progress-status").textContent;

describe("GoalProgressRow（目标进度行）", () => {
  it("空态：没有目标时不占布局行", () => {
    const { container } = render(<GoalProgressRow goal={null} />);
    expect(container.firstChild).toBeNull();
    // 空态不起计时器
    expect(vi.getTimerCount()).toBe(0);
  });

  it("呈现目标摘要、状态与累计时长；状态以 data-goal-status 暴露", () => {
    render(
      <GoalProgressRow goal={goalOf("completed", { activeMs: 65_000 })} />
    );
    expect(screen.getByTestId("goal-progress-row").dataset.goalStatus).toBe(
      "completed"
    );
    expect(screen.getByTestId("goal-progress-summary").textContent).toBe(
      "让示例测试全部通过"
    );
    expect(statusText()).toBe("已完成");
    expect(elapsed()).toBe("1 分 5 秒");
  });

  it.each(GOAL_STATUSES)("六态称谓：%s", (status) => {
    render(<GoalProgressRow goal={goalOf(status)} />);
    expect(statusText()).toBe(GOAL_STATUS_NAMES[status]);
    cleanup();
  });

  it("摘要只取首行，目标全文放进 title 供悬停查看", () => {
    render(
      <GoalProgressRow
        goal={goalOf("active", {
          text: "让示例测试全部通过\n约束：不改公共接口\n验证：pnpm test",
        })}
      />
    );
    const summary = screen.getByTestId("goal-progress-summary");
    expect(summary.textContent).toBe("让示例测试全部通过");
    expect(summary.getAttribute("title")).toBe(
      "让示例测试全部通过\n约束：不改公共接口\n验证：pnpm test"
    );
  });

  it("时长：进行中实时累加，离开进行中后定格不再跳动", () => {
    const { rerender } = render(<GoalProgressRow goal={goalOf("active")} />);
    // 进行中段起点 07:59:50，当前 08:00:00 → 已过 10 秒
    expect(elapsed()).toBe("10 秒");
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(elapsed()).toBe("15 秒");

    // 暂停：时长定格（已闭合 15 秒），计时器撤除
    rerender(<GoalProgressRow goal={goalOf("paused", { activeMs: 15_000 })} />);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(elapsed()).toBe("15 秒");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("验证中（完成判定在途）：进行中的目标状态显示「验证中」，时长继续累加；判定结束回到「进行中」", () => {
    const { rerender } = render(
      <GoalProgressRow goal={goalOf("active")} verifying />
    );
    expect(statusText()).toBe("验证中");
    expect(screen.getByTestId("goal-progress-row").dataset.goalStatus).toBe(
      "active"
    );
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(elapsed()).toBe("15 秒");

    rerender(<GoalProgressRow goal={goalOf("active")} verifying={false} />);
    expect(statusText()).toBe("进行中");
  });

  it("暂停原因：因完成判定连续不可用而暂停时写明原因；普通暂停只显示「已暂停」", () => {
    const { rerender } = render(
      <GoalProgressRow
        goal={goalOf("paused", { failureStreak: 3 })}
        pauseReason="完成判定连续 3 次不可用"
      />
    );
    expect(statusText()).toBe("已暂停");
    expect(screen.getByTestId("goal-progress-reason").textContent).toBe(
      "完成判定连续 3 次不可用"
    );

    rerender(<GoalProgressRow goal={goalOf("paused")} pauseReason={null} />);
    expect(statusText()).toBe("已暂停");
    expect(screen.queryByTestId("goal-progress-reason")).toBeNull();
  });

  it("护栏阻断的停留原因：未达成写明连续空转；预算受限写明达到预算并给出「加预算」入口", () => {
    const { rerender } = render(
      <GoalProgressRow
        goal={goalOf("unmet", { idleStreak: 3 })}
        pauseReason={goalPauseReason(goalOf("unmet", { idleStreak: 3 }))}
      />
    );
    expect(statusText()).toBe("未达成");
    expect(screen.getByTestId("goal-progress-reason").textContent).toBe(
      "连续 3 轮判定未过且无实质工具活动"
    );

    const limited = goalOf("budget-limited", { budgetTokens: 200_000 });
    rerender(
      <GoalProgressRow
        goal={limited}
        pauseReason={goalPauseReason(limited)}
        spentTokens={203_000}
      />
    );
    expect(statusText()).toBe("预算受限");
    expect(screen.getByTestId("goal-progress-reason").textContent).toBe(
      "目标用量已达到 token 预算"
    );
    expect(screen.getByTestId("goal-budget-trigger").textContent).toBe(
      "用量 203,000 / 200,000"
    );
    expect(screen.getByTestId("goal-budget-trigger").dataset.over).toBe("true");
    expect(screen.getByTestId("goal-budget-add").textContent).toBe("加预算");
  });

  it("token 预算控件挂在行上（单一挂载点）：未设预算显示「预算 不限」入口，已设预算显示 用量 / 预算", () => {
    const { rerender } = render(
      <GoalProgressRow goal={goalOf("active")} spentTokens={1234} />
    );
    expect(screen.getByTestId("goal-budget-trigger").textContent).toBe(
      "预算 不限"
    );
    expect(screen.queryByTestId("goal-budget-add")).toBeNull();

    rerender(
      <GoalProgressRow
        goal={goalOf("active", { budgetTokens: 200_000 })}
        spentTokens={1234}
      />
    );
    expect(screen.getByTestId("goal-budget-trigger").textContent).toBe(
      "用量 1,234 / 200,000"
    );
    expect(screen.getByTestId("goal-budget-trigger").dataset.over).toBe(
      undefined
    );
  });
});
