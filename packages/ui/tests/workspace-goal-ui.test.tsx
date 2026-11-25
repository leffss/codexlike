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
    idleStreak: 0,
    failureStreak: 0,
    ...overrides,
  };
}

const verification: GoalVerificationRecord = {
  id: "gv-1",
  taskId: "A",
  goalId: "goal-1",
  round: 1,
  passed: true,
  outcome: "passed",
  reason: "示例测试已全部通过",
  nextAction: "",
  toolActivity: false,
  createdAt: "2026-11-25T08:00:09.000Z",
};

function task(id: string, archived = false): TaskListItem {
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
    archivedAt: archived ? "2026-11-25T09:00:00.000Z" : null,
    createdAt: "2026-11-18T08:00:00Z",
    updatedAt: "2026-11-18T08:00:00Z",
    activity,
  };
}

/** 任务 A 带着一个目标（进度行的恢复数据源，缺省为已完成），任务 B 没有目标 */
function taskView(taskId: string, goal: GoalRecord | null): TaskView {
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
    goal: taskId === "A" ? goal : null,
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

/** 装配选项：任务 A 的初始目标（缺省已完成） */
interface SetupOptions {
  goal?: GoalRecord | null;
}

function setup(options: SetupOptions = {}) {
  const initialGoal =
    options.goal === undefined ? goalOf("completed") : options.goal;
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
      view: vi.fn(async (id: string) => taskView(id, initialGoal)),
      resources: vi.fn(async () => null),
      workspaceFiles: vi.fn(async () => []),
      status: vi.fn(async () => null),
      markViewed: vi.fn(async () => {}),
      workspaceSharing: vi.fn(async () => ({
        workspacePath: null,
        runningTasks: [],
      })),
      send: vi.fn(async () => {}),
      interrupt: vi.fn(async () => true),
      compact: vi.fn(async () => ({ compactedMessages: 2 })),
      goalSet: vi.fn<CodexLikeApi["tasks"]["goalSet"]>(async (taskId, text) =>
        goalOf("active", { taskId, text })
      ),
      goalResume: vi.fn<CodexLikeApi["tasks"]["goalResume"]>(async (taskId) =>
        goalOf("active", { taskId })
      ),
      goalEdit: vi.fn<CodexLikeApi["tasks"]["goalEdit"]>(async (taskId, text) =>
        goalOf("paused", { taskId, text })
      ),
      goalClear: vi.fn<CodexLikeApi["tasks"]["goalClear"]>(async (taskId) =>
        goalOf("cleared", { taskId })
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

async function openWorkspace(options: SetupOptions = {}) {
  const fixture = setup(options);
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

  /** 带活动态与执行现场的事件下发（续跑循环的接线用例：宿主活动态在循环期间保持运行中） */
  function emitter(listeners: Set<(event: TaskEventEnvelope) => void>) {
    let sequence = 1;
    const running = { ...activity, running: true };
    return async (
      event: TaskEventEnvelope["event"],
      options: {
        activity?: TaskEventEnvelope["activity"];
        executionId?: string;
      } = {}
    ) => {
      sequence += 1;
      await act(async () => {
        for (const listener of listeners)
          listener({
            taskId: "A",
            executionId: options.executionId ?? "execution",
            sequence,
            activity: options.activity ?? running,
            event,
          });
      });
    };
  }

  it("验证中：判定在途时进度行显示「验证中」、消息流原位出现占位行；结论到达后同一行变成结论行，状态回到「进行中」", async () => {
    const { listeners } = await openWorkspace();
    const emit = emitter(listeners);
    const verifying = {
      ...activity,
      running: true,
      goalPhase: "verifying" as const,
    };

    await emit({ type: "goal-changed", goal: goalOf("active") }, { activity });
    expect(statusText()).toBe("进行中");
    expect(screen.queryByTestId("goal-verifying-marker")).toBeNull();

    await emit(
      { type: "goal-verifying", goalId: "goal-1", round: 1 },
      { activity: verifying }
    );
    expect(statusText()).toBe("验证中");
    expect(screen.getByTestId("goal-verifying-marker").textContent).toBe(
      "第 1 次迭代 · 验证中"
    );

    await emit({
      type: "goal-verification",
      verification: {
        ...verification,
        passed: false,
        outcome: "unpassed",
        reason: "尚有步骤未完成",
        nextAction: "继续实现剩余步骤",
      },
    });
    // 同一行原位升级：没有残留的「验证中」
    expect(screen.queryByTestId("goal-verifying-marker")).toBeNull();
    expect(screen.getByTestId("goal-verification-marker").textContent).toBe(
      "第 1 次迭代 · 未完成 · 下一步：继续实现剩余步骤"
    );
    expect(statusText()).toBe("进行中");
  });

  it("续跑轮不产生用户气泡：goal-continuation 不呈现为用户消息，回复照常入流", async () => {
    const { listeners } = await openWorkspace();
    const emit = emitter(listeners);
    const goalText = "让示例测试全部通过";
    const userBubbleTexts = () =>
      screen.getAllByTestId("message-user").map((node) => node.textContent);

    await emit({ type: "goal-changed", goal: goalOf("active") }, { activity });
    await emit({
      type: "user-message",
      message: {
        id: "goal-user",
        taskId: "A",
        role: "user",
        content: goalText,
        createdAt: "2026-11-25T08:00:00.000Z",
      },
    });
    await emit({
      type: "assistant-done",
      message: {
        id: "a1",
        taskId: "A",
        role: "assistant",
        content: "第一轮回复",
        createdAt: "2026-11-25T08:00:01.000Z",
      },
    });
    await emit({ type: "goal-verifying", goalId: "goal-1", round: 1 });
    await emit({
      type: "goal-verification",
      verification: {
        ...verification,
        passed: false,
        outcome: "unpassed",
        reason: "尚有步骤未完成",
        nextAction: "继续实现剩余步骤",
      },
    });

    // 续跑轮：新的执行现场，以 goal-continuation 开始
    await emit(
      {
        type: "goal-continuation",
        message: {
          id: "gc-1",
          taskId: "A",
          role: "goal-continuation",
          content: "【目标续跑】请继续推进目标",
          createdAt: "2026-11-25T08:00:02.000Z",
        },
      },
      { executionId: "execution-2" }
    );
    await emit(
      { type: "assistant-delta", messageId: "a2", delta: "续跑轮的回复" },
      { executionId: "execution-2" }
    );

    expect(userBubbleTexts()).toEqual([goalText]);
    expect(screen.getByText("续跑轮的回复")).toBeTruthy();
    expect(statusText()).toBe("进行中");
  });

  it("判定在途时目标转已暂停：「验证中」占位行撤下；因完成判定连续不可用暂停时进度行写明原因", async () => {
    const { listeners } = await openWorkspace();
    const emit = emitter(listeners);

    await emit({ type: "goal-changed", goal: goalOf("active") }, { activity });
    await emit({ type: "goal-verifying", goalId: "goal-1", round: 1 });
    expect(screen.getByTestId("goal-verifying-marker")).toBeTruthy();

    await emit(
      { type: "goal-changed", goal: goalOf("paused", { failureStreak: 3 }) },
      { activity }
    );
    expect(screen.queryByTestId("goal-verifying-marker")).toBeNull();
    expect(statusText()).toBe("已暂停");
    expect(screen.getByTestId("goal-progress-reason").textContent).toBe(
      "完成判定连续 3 次不可用"
    );

    // 手动暂停（没有记录到原因）：只显示「已暂停」
    await emit({ type: "goal-changed", goal: goalOf("paused") }, { activity });
    expect(screen.queryByTestId("goal-progress-reason")).toBeNull();
  });

  it("目标循环的开始与收束都刷新侧栏任务列表（后台目标任务的徽章与「N 个执行中」统计依赖它）", async () => {
    const { api, listeners } = await openWorkspace();
    const emit = emitter(listeners);
    const listCalls = () => vi.mocked(api.tasks.list).mock.calls.length;
    const before = listCalls();

    await emit({
      type: "goal-continuation",
      message: {
        id: "gc",
        taskId: "A",
        role: "goal-continuation",
        content: "续跑",
        createdAt: "2026-11-25T08:00:02.000Z",
      },
    });
    await waitFor(() => expect(listCalls()).toBeGreaterThan(before));

    const afterStart = listCalls();
    await emit(
      { type: "goal-changed", goal: goalOf("completed") },
      { activity }
    );
    await waitFor(() => expect(listCalls()).toBeGreaterThan(afterStart));
  });

  /** 进度行上的控制面控件（按钮 / 编辑框）；不存在返回 null */
  const control = (id: string) => screen.queryByTestId(id);

  /** 在输入框键入并以 Enter 提交（回复进行中输入框没有发送按钮，Enter 与「加入队列」等效） */
  function submitByEnter(text: string) {
    fireEvent.change(composer(), { target: { value: text } });
    fireEvent.keyDown(composer(), { key: "Enter" });
  }

  it("暂停按钮：与停止按钮同一通道（调用 interrupt），成功走本地命令反馈", async () => {
    const { api } = await openWorkspace({ goal: goalOf("active") });

    fireEvent.click(control("goal-pause")!);

    await waitFor(() => expect(api.tasks.interrupt).toHaveBeenCalledWith("A"));
    expect(feedback()).toContain("目标已暂停");
    expect(api.tasks.goalResume).not.toHaveBeenCalled();
  });

  it("暂停失败：原因以本地命令反馈呈现，目标状态不变", async () => {
    const { api } = await openWorkspace({ goal: goalOf("active") });
    vi.mocked(api.tasks.interrupt).mockRejectedValueOnce(
      new Error("应用正在退出，请取消退出后再操作")
    );

    fireEvent.click(control("goal-pause")!);

    await waitFor(() =>
      expect(feedback()).toContain(
        "暂停目标失败：应用正在退出，请取消退出后再操作"
      )
    );
    expect(statusText()).toBe("进行中");
  });

  it("恢复按钮：调用 goalResume；成功后进度行转「进行中」并走本地命令反馈", async () => {
    const { api } = await openWorkspace({ goal: goalOf("paused") });
    expect(control("goal-resume")).not.toBeNull();

    fireEvent.click(control("goal-resume")!);

    await waitFor(() => expect(feedback()).toContain("目标已恢复"));
    expect(api.tasks.goalResume).toHaveBeenCalledWith("A");
    expect(statusText()).toBe("进行中");
    // 进行中：暂停可用、恢复不出现、编辑不可用
    expect(control("goal-pause")).not.toBeNull();
    expect(control("goal-resume")).toBeNull();
    expect(control("goal-edit")!.hasAttribute("disabled")).toBe(true);
  });

  it("恢复失败：原因以本地命令反馈呈现，目标保持已暂停", async () => {
    const { api } = await openWorkspace({ goal: goalOf("paused") });
    vi.mocked(api.tasks.goalResume).mockRejectedValueOnce(
      new Error("任务正在执行，请等回复结束后再恢复目标")
    );

    fireEvent.click(control("goal-resume")!);

    await waitFor(() =>
      expect(feedback()).toContain(
        "恢复目标失败：任务正在执行，请等回复结束后再恢复目标"
      )
    );
    expect(statusText()).toBe("已暂停");
    // 没能恢复：按钮回来可重试
    await waitFor(() =>
      expect(control("goal-resume")!.hasAttribute("disabled")).toBe(false)
    );
  });

  it("编辑：进度行进入编辑、保存调用 goalEdit；成功后摘要更新并走本地命令反馈", async () => {
    const { api } = await openWorkspace({ goal: goalOf("paused") });

    fireEvent.click(control("goal-edit")!);
    const input = screen.getByTestId("goal-edit-input") as HTMLTextAreaElement;
    expect(input.value).toBe("让示例测试全部通过");
    fireEvent.change(input, { target: { value: "修订后的目标" } });
    fireEvent.click(screen.getByTestId("goal-edit-save"));

    await waitFor(() => expect(feedback()).toContain("目标已更新"));
    expect(api.tasks.goalEdit).toHaveBeenCalledWith("A", "修订后的目标");
    await waitFor(() =>
      expect(screen.queryByTestId("goal-edit-input")).toBeNull()
    );
    expect(screen.getByTestId("goal-progress-summary").textContent).toBe(
      "修订后的目标"
    );
  });

  it("编辑失败：原因以本地命令反馈呈现，编辑框保持、内容不丢", async () => {
    const { api } = await openWorkspace({ goal: goalOf("paused") });
    vi.mocked(api.tasks.goalEdit).mockRejectedValueOnce(
      new Error("目标进行中，不能编辑：请先暂停目标")
    );

    fireEvent.click(control("goal-edit")!);
    fireEvent.change(screen.getByTestId("goal-edit-input"), {
      target: { value: "修订后的目标" },
    });
    fireEvent.click(screen.getByTestId("goal-edit-save"));

    await waitFor(() =>
      expect(feedback()).toContain(
        "编辑目标失败：目标进行中，不能编辑：请先暂停目标"
      )
    );
    expect(
      (screen.getByTestId("goal-edit-input") as HTMLTextAreaElement).value
    ).toBe("修订后的目标");
  });

  it("清除：调用 goalClear；进度行退场、标记行保留，走本地命令反馈", async () => {
    const { api, listeners } = await openWorkspace({ goal: goalOf("paused") });
    const emit = emitter(listeners);
    await emit({ type: "goal-verification", verification }, { activity });
    expect(screen.getByTestId("goal-verification-marker")).toBeTruthy();

    fireEvent.click(control("goal-clear")!);

    await waitFor(() => expect(feedback()).toContain("目标已清除"));
    expect(api.tasks.goalClear).toHaveBeenCalledWith("A");
    await waitFor(() =>
      expect(screen.queryByTestId("goal-progress-row")).toBeNull()
    );
    // 逐轮验证记录的标记行仍随任务可回看
    expect(screen.getByTestId("goal-verification-marker").textContent).toBe(
      "第 1 次迭代 · 已完成"
    );
  });

  it("清除失败：原因以本地命令反馈呈现，进度行保留", async () => {
    const { api } = await openWorkspace({ goal: goalOf("paused") });
    vi.mocked(api.tasks.goalClear).mockRejectedValueOnce(
      new Error("任务已归档，请先恢复任务再清除目标")
    );

    fireEvent.click(control("goal-clear")!);

    await waitFor(() =>
      expect(feedback()).toContain(
        "清除目标失败：任务已归档，请先恢复任务再清除目标"
      )
    );
    expect(screen.getByTestId("goal-progress-row")).toBeTruthy();
  });

  it("已清除的目标：状态快照到达时进度行退场；重启恢复（快照为已清除）也不渲染", async () => {
    const { listeners } = await openWorkspace({ goal: goalOf("paused") });
    const emit = emitter(listeners);

    await emit({ type: "goal-changed", goal: goalOf("cleared") }, { activity });
    expect(screen.queryByTestId("goal-progress-row")).toBeNull();

    cleanup();
    await openWorkspace({ goal: goalOf("cleared") });
    expect(screen.queryByTestId("goal-progress-row")).toBeNull();
  });

  it("已归档的任务：进度行只读，不提供目标操作", async () => {
    const { api, listeners } = await openWorkspace({ goal: goalOf("paused") });
    expect(screen.getByTestId("goal-controls")).toBeTruthy();

    // 任务变为已归档（任务列表刷新后）：目标操作撤下，目标与状态照常可见
    vi.mocked(api.tasks.list).mockResolvedValue([task("A", true), task("B")]);
    await emitter(listeners)(
      { type: "goal-changed", goal: goalOf("paused") },
      { activity }
    );
    await waitFor(() =>
      expect(screen.queryByTestId("goal-controls")).toBeNull()
    );
    expect(statusText()).toBe("已暂停");
  });

  it("下一轮没能发起而暂停：宿主附带的原因显示为进度行的暂停原因，之后不带原因的快照即清除", async () => {
    const { listeners } = await openWorkspace({ goal: goalOf("active") });
    const emit = emitter(listeners);

    await emit(
      {
        type: "goal-changed",
        goal: goalOf("paused"),
        pauseReason:
          "无法发起下一轮：所选 Provider Profile 不存在，请重新选择模型",
      },
      { activity }
    );
    expect(statusText()).toBe("已暂停");
    expect(screen.getByTestId("goal-progress-reason").textContent).toBe(
      "无法发起下一轮：所选 Provider Profile 不存在，请重新选择模型"
    );

    await emit({ type: "goal-changed", goal: goalOf("active") }, { activity });
    expect(screen.queryByTestId("goal-progress-reason")).toBeNull();
  });

  it("/compact 在目标进行中：专门提示先暂停目标，不执行压缩、输入保留", async () => {
    const { api, listeners } = await openWorkspace({ goal: goalOf("active") });
    const emit = emitter(listeners);
    // 目标循环期间任务恒为执行中（以运行中的活动态模拟续跑轮进行中）
    await emit({ type: "goal-changed", goal: goalOf("active") });
    await screen.findByTestId("composer-enqueue");

    submitByEnter("/compact");

    await waitFor(() =>
      expect(feedback()).toContain(
        "目标进行中不能压缩历史：请先暂停目标（完成判定依赖完整历史）（输入已保留）"
      )
    );
    expect(api.tasks.compact).not.toHaveBeenCalled();
    expect(composer().value).toBe("/compact");
  });

  it("/compact 在目标已暂停 / 已完成时照常可用", async () => {
    const { api } = await openWorkspace({ goal: goalOf("paused") });

    submit("/compact");

    // 发送参数与直发消息同一组快照：任务保存的模型随压缩请求传入
    await waitFor(() =>
      expect(api.tasks.compact).toHaveBeenCalledWith(
        "A",
        "profile",
        "test-model"
      )
    );
    expect(feedback()).toContain("已压缩");
  });

  it("其他斜杠命令在目标进行中：仍是「忙时命令不入队」，可用时机说准为目标暂停或结束后", async () => {
    const { api, listeners } = await openWorkspace({ goal: goalOf("active") });
    const emit = emitter(listeners);
    await emit({ type: "goal-changed", goal: goalOf("active") });
    await screen.findByTestId("composer-enqueue");

    submitByEnter("/status");

    await waitFor(() =>
      expect(feedback()).toContain(
        "命令 /status 不入队：目标暂停或结束后可用（输入已保留）"
      )
    );
    expect(composer().value).toBe("/status");
  });

  it("普通任务忙时从命令菜单选中无参命令（Enter）：提示不入队，输入同样保留", async () => {
    const { api, listeners } = await openWorkspace({ goal: null });
    // 回复进行中（没有目标）：以运行中的活动态模拟
    await emitter(listeners)({
      type: "queue-changed",
      reason: "enqueue",
      queue: [],
      paused: false,
      sendingId: null,
    });
    await screen.findByTestId("composer-enqueue");

    submitByEnter("/status");

    await waitFor(() =>
      expect(feedback()).toContain(
        "命令 /status 不入队：回复结束后可用（输入已保留）"
      )
    );
    expect(api.tasks.send).not.toHaveBeenCalled();
    expect(composer().value).toBe("/status");
  });
});
