// @vitest-environment jsdom
// 目标进度行上的 token 预算控件（ADR 0035「护栏」，票 05）：用量 / 预算的显示
// 与设置入口——预算是目标级参数，不进执行设置；「预算受限」态直接加预算。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { GoalRecord, GoalStatus } from "@codexlike/agent-core";

import { GoalBudgetControl } from "../src/components/GoalBudgetControl";

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

/** 预算变更入口的替身：记录调用并返回更新后的目标记录 */
function budgetStub() {
  return vi.fn(async (taskId: string, tokens: number): Promise<GoalRecord> =>
    goalOf("active", { taskId, budgetTokens: tokens })
  );
}

afterEach(cleanup);

describe("GoalBudgetControl（进度行上的 token 预算控件）", () => {
  it("未设预算：显示「预算 不限」入口（设置预算的入口），不显示用量数字", () => {
    render(<GoalBudgetControl goal={goalOf("active")} spentTokens={1234} />);

    const trigger = screen.getByTestId("goal-budget-trigger");
    expect(trigger.textContent).toBe("预算 不限");
    expect(screen.queryByTestId("goal-budget-spent")).toBeNull();
    expect(screen.queryByTestId("goal-budget-editor")).toBeNull();
  });

  it("已设预算：显示「用量 / 预算」（千分位）；用量达到预算时以警示色标出", () => {
    const { rerender } = render(
      <GoalBudgetControl
        goal={goalOf("active", { budgetTokens: 200_000 })}
        spentTokens={12_345}
      />
    );
    expect(screen.getByTestId("goal-budget-spent").textContent).toBe("12,345");
    expect(screen.getByTestId("goal-budget-limit").textContent).toBe("200,000");
    expect(screen.getByTestId("goal-budget-trigger").dataset.over).toBe(
      undefined
    );

    rerender(
      <GoalBudgetControl
        goal={goalOf("budget-limited", { budgetTokens: 200_000 })}
        spentTokens={203_000}
      />
    );
    expect(
      screen
        .getByTestId("goal-budget-trigger")
        .classList.contains("text-warn-fg")
    ).toBe(true);
    expect(screen.getByTestId("goal-budget-trigger").dataset.over).toBe("true");
  });

  it("已结束且未设预算的目标：整个控件不占位", () => {
    const { container } = render(
      <GoalBudgetControl goal={goalOf("completed")} spentTokens={0} />
    );
    expect(container.firstChild).toBeNull();
  });
});

/** 编辑浮层里的数字输入框 */
function budgetInput(): HTMLInputElement {
  return screen.getByTestId("goal-budget-input") as HTMLInputElement;
}

describe("GoalBudgetControl：设置与调整预算（编辑浮层）", () => {
  it("点入口打开浮层 → 输入 → 保存：以（任务, 预算）调用变更入口，浮层收起", async () => {
    const setBudget = budgetStub();
    render(
      <GoalBudgetControl
        goal={goalOf("active")}
        spentTokens={0}
        setBudget={setBudget}
      />
    );

    fireEvent.click(screen.getByTestId("goal-budget-trigger"));
    // 未设预算：输入框预填为空
    expect(budgetInput().value).toBe("");
    fireEvent.change(budgetInput(), { target: { value: "200000" } });
    fireEvent.click(screen.getByTestId("goal-budget-save"));

    await waitFor(() =>
      expect(setBudget).toHaveBeenCalledWith("task-1", 200_000)
    );
    await waitFor(() =>
      expect(screen.queryByTestId("goal-budget-editor")).toBeNull()
    );
  });

  it("已有预算：输入框预填当前预算；回车保存，Esc 与点浮层外收起（不提交）", async () => {
    const setBudget = budgetStub();
    render(
      <GoalBudgetControl
        goal={goalOf("active", { budgetTokens: 200_000 })}
        spentTokens={1000}
        setBudget={setBudget}
      />
    );
    const open = () =>
      fireEvent.click(screen.getByTestId("goal-budget-trigger"));

    open();
    expect(budgetInput().value).toBe("200000");
    fireEvent.keyDown(budgetInput(), { key: "Escape" });
    expect(screen.queryByTestId("goal-budget-editor")).toBeNull();

    open();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("goal-budget-editor")).toBeNull();
    expect(setBudget).not.toHaveBeenCalled();

    open();
    fireEvent.change(budgetInput(), { target: { value: "500000" } });
    fireEvent.keyDown(budgetInput(), { key: "Enter" });
    await waitFor(() =>
      expect(setBudget).toHaveBeenCalledWith("task-1", 500_000)
    );
  });

  it("非法输入不提交：空输入、零、小数——给出提示并保留浮层", async () => {
    const setBudget = budgetStub();
    render(
      <GoalBudgetControl
        goal={goalOf("active")}
        spentTokens={0}
        setBudget={setBudget}
      />
    );
    fireEvent.click(screen.getByTestId("goal-budget-trigger"));

    fireEvent.click(screen.getByTestId("goal-budget-save"));
    expect(screen.getByRole("alert").textContent).toContain(
      "请输入 token 预算"
    );
    for (const text of ["0", "1.5"]) {
      fireEvent.change(budgetInput(), { target: { value: text } });
      fireEvent.click(screen.getByTestId("goal-budget-save"));
      expect(screen.getByRole("alert").textContent).toContain("正整数");
    }
    expect(setBudget).not.toHaveBeenCalled();
    expect(screen.getByTestId("goal-budget-editor")).toBeTruthy();
  });

  it("变更失败：失败原因留在浮层里（不收起，可修正后重试）", async () => {
    const setBudget = budgetStub();
    setBudget.mockRejectedValueOnce(new Error("目标已完成，不能修改预算"));
    render(
      <GoalBudgetControl
        goal={goalOf("active")}
        spentTokens={0}
        setBudget={setBudget}
      />
    );
    fireEvent.click(screen.getByTestId("goal-budget-trigger"));
    fireEvent.change(budgetInput(), { target: { value: "1000" } });
    fireEvent.click(screen.getByTestId("goal-budget-save"));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "目标已完成，不能修改预算"
      )
    );
    expect(screen.getByTestId("goal-budget-editor")).toBeTruthy();
  });

  it("已结束的目标只回看：入口不可点，不打开编辑浮层", () => {
    const setBudget = budgetStub();
    render(
      <GoalBudgetControl
        goal={goalOf("completed", { budgetTokens: 200_000 })}
        spentTokens={150_000}
        setBudget={setBudget}
      />
    );
    const trigger = screen.getByTestId("goal-budget-trigger");
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("goal-budget-spent").textContent).toBe("150,000");
    fireEvent.click(trigger);
    expect(screen.queryByTestId("goal-budget-editor")).toBeNull();
  });
});

describe("GoalBudgetControl：「预算受限」态直接加预算", () => {
  it("预算受限：入口旁有醒目的「加预算」；浮层里一键加预算（在现有预算上累加），点一下即提交", async () => {
    const setBudget = budgetStub();
    render(
      <GoalBudgetControl
        goal={goalOf("budget-limited", { budgetTokens: 200_000 })}
        spentTokens={203_000}
        setBudget={setBudget}
      />
    );

    fireEvent.click(screen.getByTestId("goal-budget-add"));
    expect(budgetInput().value).toBe("200000");
    const quickAdds = screen.getAllByTestId("goal-budget-quick-add");
    expect(quickAdds.map((node) => node.textContent)).toEqual([
      "+10 万",
      "+50 万",
      "+100 万",
    ]);

    fireEvent.click(quickAdds[1]!);
    await waitFor(() =>
      expect(setBudget).toHaveBeenCalledWith("task-1", 700_000)
    );
    await waitFor(() =>
      expect(screen.queryByTestId("goal-budget-editor")).toBeNull()
    );
  });

  it("「加预算」入口只在预算受限时出现；一键加预算只在已有预算可累加时出现", () => {
    const setBudget = budgetStub();
    const { rerender } = render(
      <GoalBudgetControl
        goal={goalOf("active", { budgetTokens: 200_000 })}
        spentTokens={1000}
        setBudget={setBudget}
      />
    );
    expect(screen.queryByTestId("goal-budget-add")).toBeNull();
    // 进行中调整已有预算：可上调（一键）也可改总数
    fireEvent.click(screen.getByTestId("goal-budget-trigger"));
    expect(screen.getAllByTestId("goal-budget-quick-add")).toHaveLength(3);
    fireEvent.click(screen.getByTestId("goal-budget-cancel"));

    // 从未设预算：没有可累加的基数，只填总数
    rerender(
      <GoalBudgetControl
        goal={goalOf("active")}
        spentTokens={1000}
        setBudget={setBudget}
      />
    );
    fireEvent.click(screen.getByTestId("goal-budget-trigger"));
    expect(screen.queryByTestId("goal-budget-quick-add")).toBeNull();
  });
});
