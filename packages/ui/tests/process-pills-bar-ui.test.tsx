// @vitest-environment jsdom
// 过程胶囊条（ADR 0034）交互面：胶囊渲染/空态隐藏、浮层开合与锚定、行点击
// 直跳回调、点外收起。SSR 静态断言测不到浮层本地 state 与 useTerminalSessions
// 的 IPC 装配，jsdom + testing-library 驱动真实点击（terminals fake 模式先例
// terminal-rail-switch.test.tsx）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { ProcessPillsBar } from "../src/components/ProcessPillsBar";
import type {
  MessageSegment,
  SubagentSegment,
  ToolCallSegment,
} from "../src/lib/task-view";
import type { TerminalSessionRecord } from "@codexlike/agent-core";

// ===== window.codexlike.terminals fake（listFor 结果表 + 事件监听器捕获）=====
const ipc = vi.hoisted(() => {
  const state = {
    listForResults: {} as Record<string, unknown[]>,
    taskListeners: [] as Array<(envelope: unknown) => void>,
  };
  const stub = {
    listFor: async (taskId: string) => state.listForResults[taskId] ?? [],
    onTaskEvent: (listener: (envelope: unknown) => void) => {
      state.taskListeners.push(listener);
      return () => {
        const index = state.taskListeners.indexOf(listener);
        if (index >= 0) state.taskListeners.splice(index, 1);
      };
    },
  };
  return { state, stub };
});

beforeEach(() => {
  window.codexlike = {
    ...window.codexlike,
    terminals: ipc.stub,
    onTaskEvent: ipc.stub.onTaskEvent,
  } as unknown as typeof window.codexlike;
});

afterEach(() => {
  cleanup();
  ipc.state.listForResults = {};
  ipc.state.taskListeners = [];
  vi.unstubAllGlobals();
});

// ===== 段/记录构造 =====

let nextSeq = 0;

function planSeg(
  id: string,
  turnId: string,
  steps: { content: string; status: string }[]
): ToolCallSegment {
  return {
    kind: "tool-call",
    id,
    seq: ++nextSeq,
    turnId,
    responseId: null,
    at: 2_000,
    taskId: "task-1",
    toolName: "update_plan",
    arguments: JSON.stringify({ steps }),
    output: "工作计划已更新",
    isError: false,
    running: false,
  };
}

function subSeg(
  id: string,
  overrides: Partial<SubagentSegment> = {}
): SubagentSegment {
  return {
    kind: "subagent",
    id,
    seq: ++nextSeq,
    turnId: id,
    responseId: null,
    toolCallId: "",
    task: `委派任务 ${id}`,
    state: "running",
    startedAt: null,
    endedAt: null,
    report: null,
    ok: null,
    tools: [],
    ...overrides,
  };
}

function termRecord(
  overrides: Partial<TerminalSessionRecord> = {}
): TerminalSessionRecord {
  return {
    sessionId: "ts-1",
    taskId: "task-1",
    name: "git-bash · 1",
    shell: "git-bash",
    origin: "user",
    status: "running",
    createdAt: "2026-11-23T08:00:00.000Z",
    ...overrides,
  };
}

function renderBar(props: {
  messages: MessageSegment[];
  onOpenSubagent?: (id: string) => void;
  onOpenTerminal?: (id: string) => void;
}) {
  return render(
    <ProcessPillsBar
      taskId="task-1"
      messages={props.messages}
      restoredTerminals={[]}
      onOpenSubagent={props.onOpenSubagent ?? (() => {})}
      onOpenTerminal={props.onOpenTerminal ?? (() => {})}
    />
  );
}

describe("ProcessPillsBar（ADR 0034）", () => {
  it("三类皆有：三胶囊渲染 + 运行徽章 + 计数（计划 done/total、终端经 listFor 装配）", async () => {
    installStubReady();
    ipc.state.listForResults["task-1"] = [
      termRecord({ sessionId: "ts-1", status: "running" }),
      termRecord({
        sessionId: "ts-2",
        name: "git-bash · 2",
        status: "exited",
        exitCode: 0,
        exitedAt: "2026-11-23T08:02:00.000Z",
      }),
    ];
    renderBar({
      messages: [
        planSeg("p1", "t1", [
          { content: "第一步", status: "completed" },
          { content: "第二步", status: "in_progress" },
          { content: "第三步", status: "pending" },
        ]),
        subSeg("sub-1"),
      ],
    });
    // 计数口径 = 纯 completed 数（completedCount，对齐 WorkPlanCard）
    expect(screen.getByTestId("process-pill-plan").textContent).toContain(
      "1/3"
    );
    expect(screen.getByTestId("process-pill-subagents").textContent).toContain(
      "运行 1"
    );
    // 终端胶囊经异步 listFor 到达
    await waitFor(() => {
      expect(screen.getByTestId("process-pill-terminals")).not.toBeNull();
    });
    expect(screen.getByTestId("process-pill-terminals-count").textContent).toBe(
      "2"
    );
    expect(
      screen.getByTestId("process-pill-terminals-running").textContent
    ).toBe("运行 1");
  });

  it("空胶囊隐藏：只有计划时子代理/终端胶囊不渲染（对齐「无计划不占布局行」口径）", () => {
    installStubReady();
    renderBar({
      messages: [
        planSeg("p1", "t1", [{ content: "唯一一步", status: "pending" }]),
      ],
    });
    expect(screen.getByTestId("process-pill-plan")).not.toBeNull();
    expect(screen.queryByTestId("process-pill-subagents")).toBeNull();
    // 终端胶囊在 listFor 异步返回前也绝不出现（结果表为空）
    expect(screen.queryByTestId("process-pill-terminals")).toBeNull();
  });

  it("三类皆空：整条渲染 null 不占布局行", () => {
    installStubReady();
    const { container } = renderBar({ messages: [] });
    expect(container.firstChild).toBeNull();
  });

  it("浮层开合：点胶囊向上弹出（锚定冒烟）+ 再点收起 + 点外收起", async () => {
    installStubReady();
    renderBar({
      messages: [subSeg("sub-1"), subSeg("sub-2", { state: "queued" })],
    });
    fireEvent.click(screen.getByTestId("process-pill-subagents"));
    expect(screen.getByTestId("process-pill-popover-subagents")).not.toBeNull();
    // 锚定：浮层水平位置来自被点胶囊中心（style.left 非空）
    const popover = screen.getByTestId("process-pill-popover-subagents");
    expect(popover.style.left).not.toBe("");
    // 点外收起（mousedown 落在胶囊条容器外）
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("process-pill-popover-subagents")).toBeNull();
    // 再开再点胶囊收起（toggle）
    fireEvent.click(screen.getByTestId("process-pill-subagents"));
    fireEvent.click(screen.getByTestId("process-pill-subagents"));
    expect(screen.queryByTestId("process-pill-popover-subagents")).toBeNull();
  });

  it("计划浮层：步骤清单三态渲染（完成删除线语义走 WorkPlanCard 同款图标）", () => {
    installStubReady();
    renderBar({
      messages: [
        planSeg("p1", "t1", [
          { content: "已完成步骤", status: "completed" },
          { content: "进行中步骤", status: "in_progress" },
        ]),
      ],
    });
    fireEvent.click(screen.getByTestId("process-pill-plan"));
    const popover = screen.getByTestId("process-pill-popover-plan");
    expect(popover.textContent).toContain("已完成步骤");
    expect(popover.textContent).toContain("进行中步骤");
    expect(popover.textContent).toContain("工作计划 · 2 步");
    // 头部右侧状态预览：进行中步骤内容（desktop e2e work-plan 的断言锚点）
    expect(
      screen.getByTestId("process-pill-popover-plan-state").textContent
    ).toBe("进行中步骤");
  });

  it("计划浮层头部状态：全部步骤完成时显示「全部完成」", () => {
    installStubReady();
    renderBar({
      messages: [
        planSeg("p1", "t1", [
          { content: "步骤一", status: "completed" },
          { content: "步骤二", status: "completed" },
        ]),
      ],
    });
    fireEvent.click(screen.getByTestId("process-pill-plan"));
    expect(
      screen.getByTestId("process-pill-popover-plan-state").textContent
    ).toBe("全部完成");
  });

  it("行点击直跳：子代理行回调携带段 id 且浮层收起；终端行回调携带 sessionId", async () => {
    installStubReady();
    ipc.state.listForResults["task-1"] = [termRecord({ sessionId: "ts-9" })];
    const openedSubagents: string[] = [];
    const openedTerminals: string[] = [];
    renderBar({
      messages: [subSeg("sub-7")],
      onOpenSubagent: (id) => openedSubagents.push(id),
      onOpenTerminal: (id) => openedTerminals.push(id),
    });
    await waitFor(() => {
      expect(screen.getByTestId("process-pill-terminals")).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId("process-pill-subagents"));
    fireEvent.click(screen.getByText("委派任务 sub-7"));
    expect(openedSubagents).toEqual(["sub-7"]);
    // 跳转意图达成后浮层应收起
    expect(screen.queryByTestId("process-pill-popover-subagents")).toBeNull();
    fireEvent.click(screen.getByTestId("process-pill-terminals"));
    await waitFor(() => {
      expect(
        screen.getByTestId("process-pill-popover-terminals")
      ).not.toBeNull();
    });
    fireEvent.click(screen.getByText("git-bash · 1"));
    expect(openedTerminals).toEqual(["ts-9"]);
  });
});

/** 每用例重装 stub（对齐 terminal-rail-switch 的 installStub 纪律） */
function installStubReady() {
  window.codexlike = {
    ...window.codexlike,
    terminals: ipc.stub,
    onTaskEvent: ipc.stub.onTaskEvent,
  } as unknown as typeof window.codexlike;
}
