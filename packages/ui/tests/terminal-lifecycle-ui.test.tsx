// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApplicationExit } from "../src/components/ApplicationExit";
import { ArchiveTerminalDialog } from "../src/components/ArchiveTerminalDialog";

/**
 * 终端生命周期硬边的渲染端确认面（ADR 0033 票07）：
 * - 退出确认卡在 confirming 且携带 ExitState.terminalSessions 时渲染
 *   「N 个终端会话将关闭」提示行（数据面来自主进程 request 时刻快照）；
 * - 归档确认卡（任务有存活会话时）的文案与取消/确认两条路径——确认后
 *   宿主「先杀后归档」，取消则不发起归档 IPC。
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderExit(state: {
  id: string;
  phase: string;
  terminalSessions?: number;
}) {
  const exitListeners = new Set<(event: typeof state) => void>();
  vi.stubGlobal("codexlike", {
    application: {
      exitState: vi.fn(async () => ({ id: "", phase: "idle" })),
      answerExit: vi.fn(async () => {}),
      flushed: vi.fn(async () => {}),
      onExitState: (listener: (event: typeof state) => void) => {
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
    },
  });
  render(
    <ApplicationExit
      state={{ flush: vi.fn(async () => {}) } as never}
      children={<div />}
    />
  );
  return {
    async confirm(stateUpdate: typeof state) {
      for (const listener of exitListeners) listener(stateUpdate);
      await waitFor(() => screen.getByTestId("exit-confirm"));
    },
  };
}

describe("ApplicationExit：退出确认的终端会话提示行", () => {
  it("confirming 携带存活终端数时渲染「N 个终端会话将关闭」", async () => {
    const harness = renderExit({ id: "", phase: "idle" });

    await harness.confirm({
      id: "exit-1",
      phase: "confirming",
      terminalSessions: 3,
    });

    expect(screen.getByTestId("exit-terminal-note").textContent).toBe(
      "3 个终端会话将关闭。"
    );
    expect(screen.getByTestId("exit-confirm")).toBeTruthy();
  });

  it("无终端参与（字段缺省或 0）时不渲染终端提示行（既有确认卡形状不变）", async () => {
    const harness = renderExit({ id: "", phase: "idle" });

    await harness.confirm({ id: "exit-2", phase: "confirming" });

    expect(screen.queryByTestId("exit-terminal-note")).toBeNull();
    expect(screen.getByTestId("exit-confirm")).toBeTruthy();
  });
});

describe("ArchiveTerminalDialog：归档带存活会话任务的确认", () => {
  it("渲染任务名与存活会话数（确认后宿主先杀后归档）", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ArchiveTerminalDialog
        taskTitle="整理日志"
        aliveCount={2}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );

    expect(screen.getByTestId("archive-terminal-dialog")).toBeTruthy();
    expect(screen.getByText(/整理日志/)).toBeTruthy();
    expect(
      screen.getByText(/2 个终端会话仍在运行，归档将关闭它们/)
    ).toBeTruthy();
  });

  it("确认回调触发一次（归档并关闭会话路径）", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ArchiveTerminalDialog
        taskTitle="任务"
        aliveCount={1}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );

    fireEvent.click(screen.getByTestId("archive-terminal-confirm"));

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("取消回调触发一次，不触发确认（拒绝路径：会话继续运行）", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ArchiveTerminalDialog
        taskTitle="任务"
        aliveCount={1}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );

    fireEvent.click(screen.getByTestId("archive-terminal-cancel"));

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Escape 等价取消（拒绝路径）", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ArchiveTerminalDialog
        taskTitle="任务"
        aliveCount={1}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );

    fireEvent.keyDown(screen.getByTestId("archive-terminal-dialog"), {
      key: "Escape",
    });

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
