// @vitest-environment jsdom
// 真实 RailPanel/状态 hook/提交按钮；IPC 与 Monaco 编辑器为外部边界。
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { GitStatus } from "@codexlike/agent-core";

import { RailPanel } from "../src/components/RailPanel";

vi.mock("../src/components/MonacoDiff", () => ({
  default: (props: { original: string; modified: string }) => (
    <div data-testid="diff-editor">
      {props.original} → {props.modified}
    </div>
  ),
}));

const status: GitStatus = {
  isGitRepo: true,
  branch: "fix/audit",
  files: [{ path: "same.ts", kind: "modified" }],
};
function props(
  overrides: Partial<ComponentProps<typeof RailPanel>> = {}
): ComponentProps<typeof RailPanel> {
  return {
    open: true,
    taskId: "a",
    taskTitle: "检视",
    selectedProfileId: "profile",
    changesRevision: 0,
    resources: null,
    resourcesLoading: false,
    resourcesError: null,
    onRefreshResources() {},
    onChangesCount() {},
    subagents: [],
    subagentFocus: null,
    ...overrides,
  };
}
function installGit(git: object) {
  Object.defineProperty(window, "codexlike", {
    configurable: true,
    // terminals 最小 stub：RailPanel 的 useTerminalSessions 挂载即拉取
    //（本文件聚焦 diff 刷新，终端数据路径由 terminal-rail-switch 覆盖）
    value: {
      git,
      onTaskEvent: () => () => {},
      terminals: {
        listFor: async () => [],
        onSessionData: () => () => {},
        subscribe: async (sessionId: string) => ({
          ok: false as const,
          reason: sessionId,
        }),
        unsubscribe: async () => {},
        write: async () => ({ ok: false as const, reason: "stub" }),
        resize: async () => {},
        kill: async () => ({ ok: false as const, reason: "stub" }),
        create: async () => ({ ok: false as const, reason: "stub" }),
        session: async () => null,
      },
    },
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
afterEach(() => cleanup());

describe("右栏同路径 diff 刷新", () => {
  it.each(["success", "error"] as const)(
    "旧 status 的迟到 %s 不覆盖新 revision/任务，不触发过期 diff",
    async (outcome) => {
      const stale = deferred<GitStatus>();
      const getStatus = vi
        .fn()
        .mockResolvedValueOnce(status)
        .mockReturnValueOnce(stale.promise)
        .mockResolvedValue({ ...status, branch: "new-branch" });
      const diff = vi.fn(async () => ({ original: "", modified: "当前内容" }));
      installGit({ status: getStatus, diff });
      const view = render(<RailPanel {...props()} />);
      fireEvent.click(await screen.findByTestId("changes-file-item"));
      await screen.findByTestId("diff-editor");
      view.rerender(<RailPanel {...props({ changesRevision: 1 })} />);
      view.rerender(
        <RailPanel {...props({ taskId: "b", changesRevision: 2 })} />
      );
      await waitFor(() =>
        expect(screen.getByTestId("changes-branch").textContent).toBe(
          "new-branch"
        )
      );
      fireEvent.click(screen.getByTestId("changes-file-item"));
      await screen.findByTestId("diff-editor");
      const calls = diff.mock.calls.length;
      await act(async () => {
        if (outcome === "success")
          stale.resolve({ ...status, branch: "stale-branch" });
        else stale.reject(new Error("stale-error"));
      });
      expect(screen.getByTestId("changes-branch").textContent).toBe(
        "new-branch"
      );
      expect(screen.queryByText("stale-error")).toBeNull();
      expect(screen.getByTestId("diff-editor").textContent).toContain(
        "当前内容"
      );
      expect(diff.mock.calls.length).toBe(calls);
    }
  );

  it("成功刷新后选中文件消失即清空 diff，不保留过期检视", async () => {
    let next = status;
    installGit({
      status: vi.fn(async () => next),
      diff: vi.fn(async () => ({ original: "base", modified: "旧内容" })),
    });
    render(<RailPanel {...props()} />);
    fireEvent.click(await screen.findByTestId("changes-file-item"));
    await screen.findByTestId("diff-editor");
    next = { isGitRepo: true, branch: "fix/audit", files: [] };
    fireEvent.click(screen.getByTestId("changes-refresh"));
    await waitFor(() =>
      expect(screen.queryByTestId("changes-file-item")).toBeNull()
    );
    expect(screen.queryByTestId("changes-diff-path")).toBeNull();
    expect(screen.queryByTestId("diff-editor")).toBeNull();
  });

  it("回答结束 revision、手动刷新及提交后重新读取选中的同路径内容", async () => {
    let version = "VERSION_ONE";
    installGit({
      status: vi.fn(async () => status),
      diff: vi.fn(async () => ({
        path: "same.ts",
        original: "base",
        modified: version,
      })),
      commit: vi.fn(async () => ({ committed: true, commitHash: "abc1234" })),
    });
    const view = render(<RailPanel {...props()} />);
    fireEvent.click(await screen.findByTestId("changes-file-item"));
    await waitFor(() =>
      expect(screen.getByTestId("diff-editor").textContent).toContain(
        "VERSION_ONE"
      )
    );
    version = "VERSION_TWO";
    view.rerender(<RailPanel {...props({ changesRevision: 1 })} />);
    await waitFor(() =>
      expect(screen.getByTestId("diff-editor").textContent).toContain(
        "VERSION_TWO"
      )
    );
    version = "VERSION_THREE";
    fireEvent.click(screen.getByTestId("changes-refresh"));
    await waitFor(() =>
      expect(screen.getByTestId("diff-editor").textContent).toContain(
        "VERSION_THREE"
      )
    );
    version = "VERSION_AFTER_COMMIT";
    fireEvent.change(screen.getByTestId("changes-commit-message"), {
      target: { value: "test commit" },
    });
    fireEvent.click(screen.getByTestId("changes-commit"));
    await waitFor(() =>
      expect(screen.getByTestId("diff-editor").textContent).toContain(
        "VERSION_AFTER_COMMIT"
      )
    );
  });
});
