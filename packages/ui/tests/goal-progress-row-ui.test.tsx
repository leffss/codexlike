// @vitest-environment jsdom
// 目标进度行（ADR 0035，GLOSSARY「目标」）：输入框上方常驻——目标摘要、状态、
// 累计时长，以及控制面按钮组（暂停 / 恢复 / 编辑 / 清除，票 04）。
// jsdom + testing-library 驱动（时长实时跳动依赖定时器）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
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
const roundText = () => screen.getByTestId("goal-progress-round").textContent;
const button = (id: string) => screen.queryByTestId(id);

/** 控制面四个操作的回调（no-op 替身）；保存可按用例替换为失败 */
function callbacks(options: { failSave?: boolean } = {}) {
  return {
    onPause: vi.fn(),
    onResume: vi.fn(),
    onSaveEdit: vi.fn(async () => {
      if (options.failSave)
        throw new Error("目标进行中，不能编辑：请先暂停目标");
    }),
    onClear: vi.fn(),
  };
}

/** 渲染带按钮组的进度行 */
function renderControls(
  goal: GoalRecord,
  props: Partial<Parameters<typeof GoalProgressRow>[0]> & {
    failSave?: boolean;
  } = {}
) {
  const { failSave, ...rest } = props;
  const handlers = callbacks({ failSave });
  const view = render(
    <GoalProgressRow goal={goal} controls={handlers} {...rest} />
  );
  return { ...view, handlers };
}

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

  it("呈现轮次「第 N 轮」：缺省第 1 轮；宿主传入的轮次原样显示", () => {
    const { rerender } = render(<GoalProgressRow goal={goalOf("active")} />);
    expect(roundText()).toBe("第 1 轮");

    rerender(<GoalProgressRow goal={goalOf("active")} round={3} />);
    expect(roundText()).toBe("第 3 轮");
  });

  // 已清除是退场态（见下方「已清除」用例），其余五态各有称谓
  it.each(GOAL_STATUSES.filter((status) => status !== "cleared"))(
    "五态称谓：%s",
    (status) => {
      render(<GoalProgressRow goal={goalOf(status)} />);
      expect(statusText()).toBe(GOAL_STATUS_NAMES[status]);
      cleanup();
    }
  );

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

describe("控制面按钮组的六态可用性矩阵（票 04）", () => {
  // 期望取自票面：进行中可暂停不可恢复、编辑需先暂停；三种可恢复态一致
  // （恢复 / 编辑 / 清除）；已完成后无暂停 / 恢复、不可编辑，只可清除
  it.each([
    [
      "进行中",
      "active",
      ["goal-pause", "goal-edit", "goal-clear"],
      ["goal-edit"],
    ],
    ["已暂停", "paused", ["goal-resume", "goal-edit", "goal-clear"], []],
    [
      "预算受限",
      "budget-limited",
      ["goal-resume", "goal-edit", "goal-clear"],
      [],
    ],
    ["未达成", "unmet", ["goal-resume", "goal-edit", "goal-clear"], []],
    ["已完成", "completed", ["goal-edit", "goal-clear"], ["goal-edit"]],
  ] as const)(
    "%s：出现的按钮 %s，其中不可用 %s",
    (_label, status, present, disabled) => {
      renderControls(goalOf(status));
      for (const id of [
        "goal-pause",
        "goal-resume",
        "goal-edit",
        "goal-clear",
      ]) {
        if ((present as readonly string[]).includes(id))
          expect(button(id), id).not.toBeNull();
        else expect(button(id), id).toBeNull();
      }
      for (const id of present)
        expect(button(id)!.hasAttribute("disabled"), `${id} 是否不可用`).toBe(
          (disabled as readonly string[]).includes(id)
        );
      cleanup();
    }
  );

  it("已清除：进度行退场（不占布局行），按钮组随之全部退场", () => {
    const { container } = renderControls(goalOf("cleared"));
    expect(container.firstChild).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("不可用的按钮以悬停提示说明原因（进行中先暂停、已完成不再修改）", () => {
    renderControls(goalOf("active"));
    expect(button("goal-edit")!.getAttribute("title")).toContain(
      "请先暂停目标"
    );
    cleanup();
    renderControls(goalOf("completed"));
    expect(button("goal-edit")!.getAttribute("title")).toContain("已完成");
  });

  it("暂停 / 恢复 / 清除点击各自触发回调", () => {
    const { handlers } = renderControls(goalOf("active"));
    fireEvent.click(button("goal-pause")!);
    fireEvent.click(button("goal-clear")!);
    expect(handlers.onPause).toHaveBeenCalledTimes(1);
    expect(handlers.onClear).toHaveBeenCalledTimes(1);
    cleanup();

    const resumed = renderControls(goalOf("paused"));
    fireEvent.click(button("goal-resume")!);
    expect(resumed.handlers.onResume).toHaveBeenCalledTimes(1);
  });

  it("判定在途（验证中）：暂停与清除照常可用，不出现恢复", () => {
    renderControls(goalOf("active"), { verifying: true });
    expect(statusText()).toBe("验证中");
    expect(button("goal-pause")!.hasAttribute("disabled")).toBe(false);
    expect(button("goal-clear")!.hasAttribute("disabled")).toBe(false);
    expect(button("goal-resume")).toBeNull();
  });

  it("操作进行中：按钮组整体禁用，防止重复提交", () => {
    renderControls(goalOf("paused"), {
      controls: { ...callbacks(), busy: true },
    });
    for (const id of ["goal-resume", "goal-edit", "goal-clear"])
      expect(button(id)!.hasAttribute("disabled"), id).toBe(true);
  });

  it("没有提供操作回调时只读呈现（如已归档的任务）：不渲染按钮组", () => {
    render(<GoalProgressRow goal={goalOf("paused")} />);
    for (const id of ["goal-pause", "goal-resume", "goal-edit", "goal-clear"])
      expect(button(id), id).toBeNull();
    expect(statusText()).toBe("已暂停");
  });
});

describe("编辑目标（票 04）", () => {
  const MULTI_LINE = "让示例测试全部通过\n约束：不改公共接口\n验证：pnpm test";
  const editInput = () =>
    screen.getByTestId("goal-edit-input") as HTMLTextAreaElement;

  it("点击编辑进入编辑态：编辑框预填目标全文（含多行），操作按钮让位", () => {
    renderControls(goalOf("paused", { text: MULTI_LINE }));
    fireEvent.click(button("goal-edit")!);

    expect(editInput().value).toBe(MULTI_LINE);
    expect(screen.getByTestId("goal-edit-save")).toBeTruthy();
    expect(screen.getByTestId("goal-edit-cancel")).toBeTruthy();
    // 编辑期间不暴露其余操作（状态以保存或取消落定）
    expect(button("goal-resume")).toBeNull();
    expect(button("goal-clear")).toBeNull();
    // 状态与时长照常可见
    expect(statusText()).toBe("已暂停");
  });

  it("进行中时编辑不可用：按钮禁用，点击不进入编辑态", () => {
    renderControls(goalOf("active"));
    expect(button("goal-edit")!.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button("goal-edit")!);
    expect(screen.queryByTestId("goal-edit-input")).toBeNull();
  });

  it("保存：以编辑框的文本调用保存；成功后编辑态收起，进度行按新快照显示新文本", async () => {
    const { handlers, rerender } = renderControls(goalOf("paused"));
    fireEvent.click(button("goal-edit")!);
    fireEvent.change(editInput(), {
      target: { value: "修订后的目标：示例与集成测试全部通过" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("goal-edit-save"));
    });

    expect(handlers.onSaveEdit).toHaveBeenCalledWith(
      "修订后的目标：示例与集成测试全部通过"
    );
    // 编辑态收起，操作按钮回来
    expect(screen.queryByTestId("goal-edit-input")).toBeNull();
    expect(button("goal-resume")).not.toBeNull();
    // 目标文本随宿主下发的快照更新（这里以重渲染模拟快照到达）
    rerender(
      <GoalProgressRow
        goal={goalOf("paused", {
          text: "修订后的目标：示例与集成测试全部通过",
        })}
        controls={handlers}
      />
    );
    expect(screen.getByTestId("goal-progress-summary").textContent).toBe(
      "修订后的目标：示例与集成测试全部通过"
    );
  });

  it("保存进行中：保存与取消禁用（防重复提交），完成后编辑态收起", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const handlers = { ...callbacks(), onSaveEdit: vi.fn(() => pending) };
    render(<GoalProgressRow goal={goalOf("paused")} controls={handlers} />);
    fireEvent.click(button("goal-edit")!);
    fireEvent.change(editInput(), { target: { value: "修订后的目标" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("goal-edit-save"));
    });

    expect(screen.getByTestId("goal-edit-save").textContent).toBe("保存中…");
    expect(screen.getByTestId("goal-edit-save").hasAttribute("disabled")).toBe(
      true
    );
    expect(
      screen.getByTestId("goal-edit-cancel").hasAttribute("disabled")
    ).toBe(true);

    await act(async () => {
      finish();
    });
    expect(screen.queryByTestId("goal-edit-input")).toBeNull();
  });

  it("保存失败：编辑态保持、文本不丢（可重试）", async () => {
    const { handlers } = renderControls(goalOf("paused"), { failSave: true });
    fireEvent.click(button("goal-edit")!);
    fireEvent.change(editInput(), { target: { value: "修订后的目标" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("goal-edit-save"));
    });

    expect(handlers.onSaveEdit).toHaveBeenCalledTimes(1);
    expect(editInput().value).toBe("修订后的目标");
    expect(screen.getByTestId("goal-edit-save").hasAttribute("disabled")).toBe(
      false
    );
  });

  it("取消（或按 Esc）：编辑态收起，不调用保存，目标文本不变", () => {
    const { handlers } = renderControls(goalOf("paused"));
    fireEvent.click(button("goal-edit")!);
    fireEvent.change(editInput(), { target: { value: "改了一半" } });
    fireEvent.click(screen.getByTestId("goal-edit-cancel"));
    expect(handlers.onSaveEdit).not.toHaveBeenCalled();
    expect(screen.queryByTestId("goal-edit-input")).toBeNull();
    expect(screen.getByTestId("goal-progress-summary").textContent).toBe(
      "让示例测试全部通过"
    );

    fireEvent.click(button("goal-edit")!);
    fireEvent.keyDown(editInput(), { key: "Escape" });
    expect(screen.queryByTestId("goal-edit-input")).toBeNull();
    expect(handlers.onSaveEdit).not.toHaveBeenCalled();
  });

  it("文本为空时保存不可用；文本未改动时保存直接收起编辑态、不发起保存", async () => {
    const { handlers } = renderControls(goalOf("paused"));
    fireEvent.click(button("goal-edit")!);
    fireEvent.change(editInput(), { target: { value: "   " } });
    expect(screen.getByTestId("goal-edit-save").hasAttribute("disabled")).toBe(
      true
    );

    fireEvent.change(editInput(), {
      target: { value: "让示例测试全部通过" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("goal-edit-save"));
    });
    expect(screen.queryByTestId("goal-edit-input")).toBeNull();
    expect(handlers.onSaveEdit).not.toHaveBeenCalled();
  });

  it("Ctrl+Enter 保存：与点「保存」等效（Enter 留给换行）", async () => {
    const { handlers } = renderControls(goalOf("paused"));
    fireEvent.click(button("goal-edit")!);
    fireEvent.change(editInput(), { target: { value: "修订后的目标" } });
    // 普通 Enter 只是换行，不触发保存
    fireEvent.keyDown(editInput(), { key: "Enter" });
    expect(handlers.onSaveEdit).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(editInput(), { key: "Enter", ctrlKey: true });
    });
    expect(handlers.onSaveEdit).toHaveBeenCalledWith("修订后的目标");
    expect(screen.queryByTestId("goal-edit-input")).toBeNull();
  });

  it("目标在编辑期间被清除：进度行退场，编辑态随之卸载", () => {
    const { handlers, rerender } = renderControls(goalOf("paused"));
    fireEvent.click(button("goal-edit")!);
    rerender(<GoalProgressRow goal={goalOf("cleared")} controls={handlers} />);
    expect(screen.queryByTestId("goal-progress-row")).toBeNull();
    expect(screen.queryByTestId("goal-edit-input")).toBeNull();
  });
});
