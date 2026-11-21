// @vitest-environment jsdom
// 真实工作台、侧栏与输入框；只替换 IPC 和 jsdom 缺失的浏览器观察接口。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  ProviderProfile,
  WorkbenchEntry,
  WorkbenchTarget,
} from "@codexlike/agent-core";
import type {
  CodexLikeApi,
  ExitState,
  QueueOperationResult,
  QueuedMessage,
  TaskEventEnvelope,
  TaskListItem,
  TaskView,
} from "@codexlike/desktop/ipc";

import { WorkspacePage } from "../src/pages/WorkspacePage";
import { ApplicationExit } from "../src/components/ApplicationExit";
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

function queued(
  taskId: string,
  id = `${taskId}-1`,
  text = `${id} 排队文字`
): QueuedMessage {
  return {
    id,
    taskId,
    text,
    position: 0,
    mentionPaths: [],
    providerProfileId: profile.id,
    model: "test-model",
    thinkingEffort: "auto",
    approvalMode: "ask",
    createdAt: "2026-11-18T08:00:00Z",
  };
}

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
    queueState: { queue: [queued(taskId)], paused: true, sendingId: null },
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
  const exitListeners = new Set<(event: ExitState) => void>();
  const api = {
    workbench,
    application: {
      exitState: vi.fn(async (): Promise<ExitState> => ({
        id: "",
        phase: "idle",
      })),
      flushed: vi.fn(async (_id: string, _error?: string) => {}),
      onExitState: (listener: (event: ExitState) => void) => {
        exitListeners.add(listener);
        return () => {
          exitListeners.delete(listener);
        };
      },
    } satisfies Partial<CodexLikeApi["application"]>,
    tasks: {
      list: vi.fn(async () => [task("A"), task("B")]),
      view: vi.fn(async (id: string) => taskView(id)),
      resources: vi.fn(async () => null),
      workspaceFiles: vi.fn(async () => []),
      status: vi.fn(async () => null),
      markViewed: vi.fn(async () => {}),
      queueRemove: vi.fn<CodexLikeApi["tasks"]["queueRemove"]>(
        async (taskId) => ({
          taskId,
          sequence: 2,
          queue: [],
          paused: true,
          sendingId: null,
        })
      ),
      queueResume: vi.fn<CodexLikeApi["tasks"]["queueResume"]>(
        async (taskId) => ({
          taskId,
          sequence: 2,
          queue: [queued(taskId)],
          paused: false,
          sendingId: null,
        })
      ),
      queueUpdate: vi.fn<CodexLikeApi["tasks"]["queueUpdate"]>(
        async (taskId, itemId, text) => ({
          taskId,
          sequence: 2,
          queue: [queued(taskId, itemId, text)],
          paused: true,
          sendingId: null,
        })
      ),
      workspaceSharing: vi.fn(async () => ({
        workspacePath: null,
        runningTasks: [],
      })),
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
    // terminals 最小 stub：RailPanel 的 useTerminalSessions 挂载即拉取
    //（本文件聚焦队列编辑，终端数据路径由 terminal-rail-switch 覆盖）
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
  // 不安装生产 browser-stub，避免引入其内置数据或内部模块替身。
  vi.stubGlobal("codexlike", api);
  const state = createWorkspaceState(workbench);
  return { api, state, workbench, listeners, exitListeners };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function composer(): HTMLTextAreaElement {
  return screen.getByTestId("composer-input") as HTMLTextAreaElement;
}

function selectTask(id: string) {
  const button = screen
    .getAllByTestId("task-item")
    .find((item) => item.dataset.taskId === id);
  if (!button) throw new Error(`未找到任务 ${id}`);
  fireEvent.click(button);
}

function queueItem(id: string) {
  const item = screen
    .getAllByTestId("queue-item")
    .find((item) => item.dataset.itemId === id);
  if (!item) throw new Error(`未找到排队消息 ${id}`);
  return within(item);
}

async function openWorkspace() {
  const fixture = setup();
  const view = render(
    <WorkspacePage state={fixture.state} onOpenSettings={() => {}} />
  );
  await waitFor(() => expect(composer().value).toBe("A 原草稿"));
  await screen.findByTestId("queue-bar");
  return { ...fixture, ...view };
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("WorkspacePage 队列编辑与工作台草稿", () => {
  it("C01 保存期间继续输入，成功回包不清掉新文字且新文字可恢复", async () => {
    const { api, state, workbench } = await openWorkspace();
    const result = deferred<QueueOperationResult>();
    api.tasks.queueUpdate.mockReturnValueOnce(result.promise);
    fireEvent.click(queueItem("A-1").getByTestId("queue-item-preview"));
    fireEvent.click(screen.getByTestId("composer-save-edit"));
    fireEvent.change(composer(), { target: { value: "保存之后的新文字" } });
    await act(async () => {
      result.resolve({
        taskId: "A",
        sequence: 2,
        queue: [queued("A")],
        paused: true,
        sendingId: null,
      });
    });
    expect(composer().value).toBe("保存之后的新文字");
    expect(screen.queryByTestId("composer-cancel-edit")).toBeNull();
    await act(async () => {
      await state.flush();
    });
    const reopened = createWorkspaceState(workbench);
    await reopened.loadTask("A");
    expect(reopened.composer("A")).toBe("保存之后的新文字");
  });

  it.each(["reopened", "event"])(
    "C01 保存回包不得覆盖 %s 后的新队列",
    async (source) => {
      const { api, listeners } = await openWorkspace();
      const result = deferred<QueueOperationResult>();
      api.tasks.queueUpdate.mockReturnValueOnce(result.promise);
      fireEvent.click(queueItem("A-1").getByTestId("queue-item-preview"));
      fireEvent.click(screen.getByTestId("composer-save-edit"));
      if (source === "reopened") {
        selectTask("B");
        await waitFor(() => expect(composer().value).toBe("B 原草稿"));
        selectTask("A");
        await waitFor(() =>
          expect(screen.getByTestId("queue-item-preview").textContent).toBe(
            "A-1 排队文字"
          )
        );
      } else {
        await act(async () => {
          for (const listener of listeners)
            listener({
              taskId: "A",
              executionId: "execution",
              sequence: 3,
              activity,
              event: {
                type: "queue-changed",
                reason: "update",
                queue: [queued("A", "A-1", "新事件的队列文字")],
                paused: true,
                sendingId: null,
              },
            });
        });
      }
      await act(async () => {
        result.resolve({
          taskId: "A",
          sequence: source === "reopened" ? 20 : 2,
          queue: [queued("A", "A-1", "旧保存回包")],
          paused: true,
          sendingId: null,
        });
      });
      expect(screen.getByTestId("queue-item-preview").textContent).toBe(
        source === "reopened" ? "A-1 排队文字" : "新事件的队列文字"
      );
    }
  );

  it.each([true, false])(
    "C01 保存 success=%s 迟到时不能结束同一条目的新编辑实例",
    async (success) => {
      const { api, state, workbench } = await openWorkspace();
      const result = deferred<QueueOperationResult>();
      api.tasks.queueUpdate.mockReturnValueOnce(result.promise);
      fireEvent.click(queueItem("A-1").getByTestId("queue-item-preview"));
      fireEvent.click(screen.getByTestId("composer-save-edit"));
      fireEvent.click(screen.getByTestId("composer-cancel-edit"));
      fireEvent.click(queueItem("A-1").getByTestId("queue-item-preview"));
      // 文本、taskId、itemId 都相同，但这是取消后重新打开的新实例。
      await act(async () => {
        if (success)
          result.resolve({
            taskId: "A",
            sequence: 2,
            queue: [queued("A")],
            paused: true,
            sendingId: null,
          });
        else result.reject(new Error("旧保存失败"));
      });
      expect(screen.queryByTestId("composer-cancel-edit")).not.toBeNull();
      expect(composer().value).toBe("A-1 排队文字");
      expect(screen.queryByText(/旧保存失败/)).toBeNull();
      fireEvent.click(screen.getByTestId("composer-cancel-edit"));
      expect(composer().value).toBe("A 原草稿");
      await act(async () => {
        await state.flush();
      });
      const reopened = createWorkspaceState(workbench);
      await reopened.loadTask("A");
      expect(reopened.composer("A")).toBe("A 原草稿");
    }
  );

  it.each(["event", "operation"])(
    "C01 同任务 %s 新快照后，迟到旧 sequence 不能回滚队列",
    async (source) => {
      const { api, listeners } = await openWorkspace();
      const older = deferred<QueueOperationResult>();
      api.tasks.queueRemove.mockReturnValueOnce(older.promise);
      fireEvent.click(queueItem("A-1").getByTestId("queue-item-remove"));
      const newer: QueueOperationResult = {
        taskId: "A",
        sequence: 3,
        queue: [queued("A", "A-2", "新队列文字")],
        paused: false,
        sendingId: null,
      };
      if (source === "event") {
        await act(async () => {
          for (const listener of listeners)
            listener({
              taskId: "A",
              executionId: "execution",
              sequence: 3,
              activity,
              event: { type: "queue-changed", reason: "enqueue", ...newer },
            });
        });
      } else {
        api.tasks.queueResume.mockResolvedValueOnce(newer);
        fireEvent.click(screen.getByTestId("queue-resume"));
      }
      await waitFor(() =>
        expect(screen.getByTestId("queue-item-preview").textContent).toBe(
          "新队列文字"
        )
      );
      await act(async () => {
        older.resolve({
          taskId: "A",
          sequence: 2,
          queue: [queued("A", "old", "旧回包")],
          paused: true,
          sendingId: null,
        });
      });
      expect(screen.getByTestId("queue-item-preview").textContent).toBe(
        "新队列文字"
      );
      expect(screen.queryByTestId("queue-paused")).toBeNull();
    }
  );

  it.each([
    { back: false, success: true },
    { back: false, success: false },
    { back: true, success: true },
    { back: true, success: false },
  ])(
    "C01 导航 back=$back 后旧队列操作 success=$success 不串入当前页面",
    async ({ back, success }) => {
      const { api } = await openWorkspace();
      const result = deferred<QueueOperationResult>();
      api.tasks.queueRemove.mockReturnValueOnce(result.promise);
      fireEvent.click(queueItem("A-1").getByTestId("queue-item-remove"));
      selectTask("B");
      await waitFor(() => expect(composer().value).toBe("B 原草稿"));
      await waitFor(() =>
        expect(screen.getByTestId("queue-item-preview").textContent).toBe(
          "B-1 排队文字"
        )
      );
      if (back) {
        selectTask("A");
        await waitFor(() =>
          expect(screen.getByTestId("queue-item-preview").textContent).toBe(
            "A-1 排队文字"
          )
        );
      }
      await act(async () => {
        if (success)
          result.resolve({
            taskId: "A",
            sequence: 20,
            queue: [],
            paused: false,
            sendingId: null,
          });
        else result.reject(new Error("旧操作失败"));
      });
      expect(screen.queryByText(/旧操作失败/)).toBeNull();
      expect(screen.queryByTestId("queue-item-preview")?.textContent).toBe(
        back ? "A-1 排队文字" : "B-1 排队文字"
      );
    }
  );

  it.each(["removed", "sending"])(
    "F09 编辑目标 %s 后结束编辑，当前文字作为草稿保留",
    async (reason) => {
      const { state, workbench, listeners } = await openWorkspace();
      fireEvent.click(queueItem("A-1").getByTestId("queue-item-preview"));
      fireEvent.change(composer(), { target: { value: "仍需保留的修改" } });
      await act(async () => {
        for (const listener of listeners)
          listener({
            taskId: "A",
            executionId: "execution",
            sequence: 2,
            activity,
            event: {
              type: "queue-changed",
              reason: "remove",
              queue: reason === "removed" ? [] : [queued("A")],
              paused: true,
              sendingId: reason === "sending" ? "A-1" : null,
            },
          });
        await state.flush();
      });
      expect(screen.queryByTestId("composer-cancel-edit")).toBeNull();
      expect(composer().value).toBe("仍需保留的修改");
      await act(async () => {
        await state.flush();
      });
      const reopened = createWorkspaceState(workbench);
      await reopened.loadTask("A");
      expect(reopened.composer("A")).toBe("仍需保留的修改");
    }
  );

  it.each([true, false])(
    "F09 保存结算 success=%s：成功清空、失败保留编辑输入并持久保存",
    async (success) => {
      const { state, api, workbench } = await openWorkspace();
      if (!success)
        api.tasks.queueUpdate.mockRejectedValueOnce(new Error("CAS 冲突"));
      fireEvent.click(queueItem("A-1").getByTestId("queue-item-preview"));
      fireEvent.change(composer(), { target: { value: "队列修改" } });
      fireEvent.click(screen.getByTestId("composer-save-edit"));
      await waitFor(() =>
        expect(screen.queryByTestId("composer-cancel-edit")).toBeNull()
      );
      const expected = success ? "" : "队列修改";
      expect(composer().value).toBe(expected);
      if (!success)
        expect(screen.getByText(/保存排队消息失败：CAS 冲突/)).toBeTruthy();
      await act(async () => {
        await state.flush();
      });
      const reopened = createWorkspaceState(workbench);
      await reopened.loadTask("A");
      expect(reopened.composer("A")).toBe(expected);
    }
  );

  it("F09 真正退出的保存屏障不能把队列编辑覆盖原草稿", async () => {
    const { state, api, workbench, exitListeners } = setup();
    render(
      <ApplicationExit state={state}>
        <WorkspacePage state={state} onOpenSettings={() => {}} />
      </ApplicationExit>
    );
    await waitFor(() => expect(composer().value).toBe("A 原草稿"));
    fireEvent.click(queueItem("A-1").getByTestId("queue-item-preview"));
    await act(async () => {
      for (const listener of exitListeners)
        listener({ id: "exit-1", phase: "flushing" });
    });
    await waitFor(() =>
      expect(api.application.flushed).toHaveBeenCalledWith("exit-1")
    );
    const reopened = createWorkspaceState(workbench);
    await reopened.loadTask("A");
    expect(reopened.composer("A")).toBe("A 原草稿");
  });

  it.each(["A", "B"])(
    "F09 重新选择任务 %s 后返回 A，不把队列编辑当作草稿",
    async (target) => {
      const { state, workbench } = await openWorkspace();
      fireEvent.click(queueItem("A-1").getByTestId("queue-item-preview"));
      selectTask(target);
      await waitFor(() => expect(composer().value).toBe(`${target} 原草稿`));
      if (target !== "A") {
        selectTask("A");
        await waitFor(() => expect(composer().value).toBe("A 原草稿"));
      }
      expect(screen.queryByTestId("composer-cancel-edit")).toBeNull();
      await act(async () => {
        await state.flush();
      });
      const reopened = createWorkspaceState(workbench);
      await reopened.loadTask("A");
      expect(reopened.composer("A")).toBe("A 原草稿");
    }
  );

  it("F09 卸载后仍可从持久工作台恢复编辑前的原草稿", async () => {
    const { state, workbench, unmount } = await openWorkspace();
    fireEvent.click(queueItem("A-1").getByTestId("queue-item-preview"));
    fireEvent.change(composer(), { target: { value: "未保存的队列修改" } });
    await act(async () => {
      await state.flush();
    });
    unmount();
    await state.flush();
    const reopened = createWorkspaceState(workbench);
    await reopened.loadTask("A");
    expect(reopened.composer("A")).toBe("A 原草稿");
    expect(state.composer("A")).toBe("A 原草稿");
  });

  it("F09 A→新建→A：离开前恢复原草稿，flush 后再读取新建入口", async () => {
    const { state, workbench } = await openWorkspace();
    fireEvent.click(queueItem("A-1").getByTestId("queue-item-preview"));
    expect(composer().value).toBe("A-1 排队文字");
    await act(async () => {
      await state.flush();
    });

    let savedAtNewRead: string | undefined;
    const read = workbench.read.getMockImplementation()!;
    workbench.read.mockImplementation(async (target) => {
      if (target.kind === "new") {
        savedAtNewRead = (await read({ kind: "task", taskId: "A" })).value.text;
      }
      return read(target);
    });
    fireEvent.click(screen.getByTestId("new-task"));
    await screen.findByTestId("draft-project-select");
    expect(savedAtNewRead).toBe("A 原草稿");

    selectTask("A");
    await waitFor(() => expect(composer().value).toBe("A 原草稿"));
    expect(screen.queryByTestId("composer-cancel-edit")).toBeNull();
    const reopened = createWorkspaceState(workbench);
    await reopened.loadTask("A");
    expect(reopened.composer("A")).toBe("A 原草稿");
  });
});
