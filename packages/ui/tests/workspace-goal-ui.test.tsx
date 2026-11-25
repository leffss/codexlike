// @vitest-environment jsdom
// 真实工作台与输入框；只替换 IPC 和 jsdom 缺失的浏览器观察接口。
// 目标模式（ADR 0035）在 WorkspacePage 的接线：/goal 命令分发与本地命令反馈、
// 目标进度行（恢复 + 事件接续）、完成判定标记行入消息流。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  GoalRecord,
  GoalStatus,
  GoalVerificationRecord,
  ProviderProfile,
  WorkbenchEntry,
  WorkbenchTarget,
} from "@codexlike/agent-core";
import type {
  CodexLikeApi,
  ExitState,
  TaskEventEnvelope,
  TaskListItem,
  TaskView,
} from "@codexlike/desktop/ipc";

import { WorkspacePage } from "../src/pages/WorkspacePage";
import { createWorkspaceState } from "../src/lib/workspace-state";

const profile: ProviderProfile = {
  id: "profile",
  name: "测试模型",
  baseURL: "https://example.invalid/v1",
  apiKey: "",
  models: ["test-model"],
};
const activity = {
  running: false,
  waitingForUser: false,
  outcome: null,
  unread: false,
} as const;

function goalOf(
  status: GoalStatus,
  overrides: Partial<GoalRecord> = {}
): GoalRecord {
  return {
    id: "goal-1",
    taskId: "A",
    text: "让示例测试全部通过",
    status,
    activeMs: 65_000,
    activeSince: null,
    createdAt: "2026-11-25T08:00:00.000Z",
    updatedAt: "2026-11-25T08:00:00.000Z",
    ...overrides,
  };
}

const verification: GoalVerificationRecord = {
  id: "gv-1",
  taskId: "A",
  goalId: "goal-1",
  round: 1,
  passed: true,
  reason: "示例测试已全部通过",
  nextAction: "",
  createdAt: "2026-11-25T08:00:09.000Z",
};

function task(id: string): TaskListItem {
  return {
    id,
    title: `任务 ${id}`,
    projectId: null,
    workspacePath: `C:/test-workspaces/${id}`,
    workspaceMode: "local",
    workspaceOriginPath: null,
    providerProfileId: profile.id,
    model: "test-model",
    approvalMode: "ask",
    status: "idle",
    archivedAt: null,
    createdAt: "2026-11-18T08:00:00Z",
    updatedAt: "2026-11-18T08:00:00Z",
    activity,
  };
}

/** 任务 A 带着一个已完成的目标（进度行的恢复数据源），任务 B 没有目标 */
function taskView(taskId: string): TaskView {
  return {
    taskId,
    executionId: null,
    sequence: 1,
    history: [],
    subagents: [],
    terminals: [],
    events: [],
    pendingInteractions: [],
    activity,
    queueState: { queue: [], paused: false, sendingId: null },
    goal: taskId === "A" ? goalOf("completed") : null,
  };
}

function workbenchEntry(text = ""): WorkbenchEntry {
  return {
    revision: 0,
    value: {
      text,
      requestId: "draft-request",
      preferences: {
        providerProfileId: profile.id,
        model: "test-model",
        thinkingEffort: "auto",
        approvalMode: "ask",
      },
      questionDrafts: {},
      readingPosition: null,
    },
  };
}

function setup() {
  const disk = new Map<string, WorkbenchEntry>([
    [JSON.stringify({ kind: "task", taskId: "A" }), workbenchEntry("A 原草稿")],
    [JSON.stringify({ kind: "task", taskId: "B" }), workbenchEntry("B 原草稿")],
  ]);
  const workbench = {
    read: vi.fn(async (target: WorkbenchTarget) =>
      structuredClone(disk.get(JSON.stringify(target)) ?? workbenchEntry())
    ),
    write: vi.fn(async (target: WorkbenchTarget, entry: WorkbenchEntry) => {
      disk.set(JSON.stringify(target), structuredClone(entry));
      return { accepted: true, entry: structuredClone(entry) };
    }),
  } satisfies CodexLikeApi["workbench"];
  const listeners = new Set<(event: TaskEventEnvelope) => void>();
  const api = {
    workbench,
    application: {
      exitState: vi.fn(async (): Promise<ExitState> => ({
        id: "",
        phase: "idle",
      })),
      flushed: vi.fn(async (_id: string, _error?: string) => {}),
      onExitState: (listener: (event: ExitState) => void) => () => {
        void listener;
      },
    } satisfies Partial<CodexLikeApi["application"]>,
    tasks: {
      list: vi.fn(async () => [task("A"), task("B")]),
      view: vi.fn(async (id: string) => taskView(id)),
      resources: vi.fn(async () => null),
      workspaceFiles: vi.fn(async () => []),
      status: vi.fn(async () => null),
      markViewed: vi.fn(async () => {}),
      workspaceSharing: vi.fn(async () => ({
        workspacePath: null,
        runningTasks: [],
      })),
      send: vi.fn(async () => {}),
      goalSet: vi.fn<CodexLikeApi["tasks"]["goalSet"]>(async (taskId, text) =>
        goalOf("active", { taskId, text })
      ),
    } satisfies Partial<CodexLikeApi["tasks"]>,
    providerProfiles: { list: vi.fn(async () => [profile]) },
    projects: { list: vi.fn(async () => []) },
    launchState: { setWorkbenchTarget: vi.fn(async () => {}) },
    git: {
      status: vi.fn(async () => ({
        isGitRepo: false,
        branch: null,
        files: [],
      })),
    },
    terminals: {
      listFor: vi.fn(async () => []),
      create: vi.fn(async () => ({ ok: false as const, reason: "stub" })),
      write: vi.fn(async () => ({ ok: false as const, reason: "stub" })),
      resize: vi.fn(async () => {}),
      kill: vi.fn(async () => ({ ok: false as const, reason: "stub" })),
      subscribe: vi.fn(async (sessionId: string) => ({
        ok: false as const,
        reason: sessionId,
      })),
      unsubscribe: vi.fn(async () => {}),
      session: vi.fn(async () => null),
      onSessionData: vi.fn(() => () => {}),
    },
    onTaskEvent: (listener: (event: TaskEventEnvelope) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  vi.stubGlobal("codexlike", api);
  const state = createWorkspaceState(workbench);
  return { api, state, workbench, listeners };
}

function composer(): HTMLTextAreaElement {
  return screen.getByTestId("composer-input") as HTMLTextAreaElement;
}

function feedback(): string {
  return screen.getByTestId("command-feedback").textContent ?? "";
}

/** 在输入框键入并以发送按钮提交（命令走解析层分发） */
function submit(text: string) {
  fireEvent.change(composer(), { target: { value: text } });
  fireEvent.click(screen.getByTestId("composer-send"));
}

function statusText(): string {
  return screen.getByTestId("goal-progress-status").textContent ?? "";
}

async function openWorkspace() {
  const fixture = setup();
  render(<WorkspacePage state={fixture.state} onOpenSettings={() => {}} />);
  await waitFor(() => expect(composer().value).toBe("A 原草稿"));
  return fixture;
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  HTMLElement.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WorkspacePage 目标模式接线（ADR 0035）", () => {
  it("进度行随任务恢复：有目标任务显示摘要 / 状态 / 累计时长，切到无目标任务不渲染", async () => {
    const { state } = await openWorkspace();
    expect(screen.getByTestId("goal-progress-row").dataset.goalStatus).toBe(
      "completed"
    );
    expect(screen.getByTestId("goal-progress-summary").textContent).toBe(
      "让示例测试全部通过"
    );
    expect(statusText()).toBe("已完成");
    expect(screen.getByTestId("goal-progress-elapsed").textContent).toBe(
      "1 分 5 秒"
    );

    fireEvent.click(
      screen
        .getAllByTestId("task-item")
        .find((item) => item.dataset.taskId === "B")!
    );
    await waitFor(() => expect(composer().value).toBe("B 原草稿"));
    expect(screen.queryByTestId("goal-progress-row")).toBeNull();
    void state;
  });

  it("/goal <目标>：带当前任务的发送参数调用 goalSet，成功走本地命令反馈，进度行转「进行中」", async () => {
    const { api } = await openWorkspace();

    submit("/goal 让示例测试全部通过");

    await waitFor(() => expect(feedback()).toContain("已设定目标"));
    expect(api.tasks.goalSet).toHaveBeenCalledWith(
      "A",
      "让示例测试全部通过",
      expect.objectContaining({
        providerProfileId: profile.id,
        model: "test-model",
        thinkingEffort: "auto",
        approvalMode: "ask",
      })
    );
    expect(statusText()).toBe("进行中");
    expect(screen.getByTestId("goal-progress-summary").textContent).toBe(
      "让示例测试全部通过"
    );
    // 命令输入已消费；首轮由宿主以目标原文发出（不经渲染层 send）
    expect(composer().value).toBe("");
    expect(api.tasks.send).not.toHaveBeenCalled();
  });

  it("/goal 无参数：只给用法提示，不调用 goalSet", async () => {
    const { api } = await openWorkspace();

    submit("/goal");

    await waitFor(() => expect(feedback()).toContain("用法：/goal"));
    expect(api.tasks.goalSet).not.toHaveBeenCalled();
    expect(statusText()).toBe("已完成");
  });

  it("设定失败：失败原因以本地命令反馈呈现，命令输入保留供修正后重发", async () => {
    const { api } = await openWorkspace();
    api.tasks.goalSet.mockRejectedValueOnce(
      new Error("任务已有未结束的目标，请先清除当前目标")
    );

    submit("/goal 第二个目标");

    await waitFor(() =>
      expect(feedback()).toContain(
        "设定目标失败：任务已有未结束的目标，请先清除当前目标"
      )
    );
    expect(composer().value).toBe("/goal 第二个目标");
    // 原目标不受影响
    expect(statusText()).toBe("已完成");
  });

  it("目标状态随 goal-changed 事件接续；判定结论入消息流为标记行", async () => {
    const { listeners } = await openWorkspace();
    let sequence = 1;
    const emit = async (event: TaskEventEnvelope["event"]) => {
      sequence += 1;
      await act(async () => {
        for (const listener of listeners)
          listener({
            taskId: "A",
            executionId: "execution",
            sequence,
            activity,
            event,
          });
      });
    };

    await emit({ type: "goal-changed", goal: goalOf("active") });
    expect(statusText()).toBe("进行中");

    await emit({ type: "goal-verification", verification });
    expect(screen.getByTestId("goal-verification-marker").textContent).toBe(
      "第 1 次迭代 · 已完成"
    );

    await emit({ type: "goal-changed", goal: goalOf("completed") });
    expect(statusText()).toBe("已完成");
  });
});
