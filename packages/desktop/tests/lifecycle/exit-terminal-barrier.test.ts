import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createApplicationExit } from "../../src/lifecycle/application-exit";
import { registerApplicationExit } from "../../src/lifecycle/exit-ipc";
import type { TaskExitRuntime } from "../../src/lifecycle/application-exit";
import { IPC } from "../../src/shared/ipc";

/**
 * 退出屏障并入终端会话（ADR 0033 票07）：有存活终端会话时进入确认流程，
 * 确认提示带「N 个终端会话将关闭」的数据面（ExitState.terminalSessions，
 * 文案渲染在 ui ApplicationExit）；确认后继续退出（会话由 releaseResources
 * 的 killAll 清理，03 票已并）、取消后 thaw 留驻。终端存活计入 hasWork 的
 * 组合在 main.ts 装配区（aliveSessionCount 单测见 terminal-lifecycle.test.ts）。
 */

function makeRuntime(
  hasWork: () => boolean = () => false
): TaskExitRuntime & { stopAndDrain: ReturnType<typeof vi.fn> } {
  return {
    hasWork: vi.fn(hasWork),
    freeze: vi.fn(),
    thaw: vi.fn(),
    stopAndDrain: vi.fn(async () => {}),
  };
}

describe("createApplicationExit：确认状态的终端计数数据面", () => {
  it("进入确认流程时携带存活终端会话数（「N 个终端会话将关闭」数据源）", () => {
    const runtime = makeRuntime(() => true);
    const published: unknown[] = [];
    const exit = createApplicationExit({
      runtime,
      publish: (state) => published.push(state),
      finish: () => {},
      terminalSessionCount: () => 2,
    });

    exit.request();

    expect(published.at(-1)).toMatchObject({
      phase: "confirming",
      terminalSessions: 2,
    });
  });

  it("确认后进入 flushing：进入终局收尾，状态不再携带终端计数", () => {
    const runtime = makeRuntime(() => true);
    const published: { phase: string; terminalSessions?: number }[] = [];
    const exit = createApplicationExit({
      runtime,
      publish: (state) => published.push(state),
      finish: () => {},
      terminalSessionCount: () => 3,
    });
    exit.request();
    const id = exit.state().id;

    exit.answer(id, true);

    expect(exit.state().phase).toBe("flushing");
    expect(exit.state().terminalSessions).toBeUndefined();
  });

  it("取消后 thaw 留驻：回到 idle 不退出（留驻路径）", () => {
    const runtime = makeRuntime(() => true);
    const exit = createApplicationExit({
      runtime,
      publish: () => {},
      finish: () => {},
      terminalSessionCount: () => 3,
    });
    exit.request();
    const id = exit.state().id;

    exit.answer(id, false);

    expect(exit.state().phase).toBe("idle");
    expect(runtime.thaw).toHaveBeenCalledOnce();
    expect(runtime.stopAndDrain).not.toHaveBeenCalled();
  });

  it("无存活会话（计数 0）时确认状态不带终端字段（提示行不渲染）", () => {
    const runtime = makeRuntime(() => true);
    const published: { phase: string; terminalSessions?: number }[] = [];
    const exit = createApplicationExit({
      runtime,
      publish: (state) => published.push(state),
      finish: () => {},
      terminalSessionCount: () => 0,
    });

    exit.request();

    expect(published.at(-1)).toMatchObject({ phase: "confirming" });
    expect(exit.state().terminalSessions).toBeUndefined();
  });

  it("未注入终端计数时状态形状兼容（既有退出屏障行为不变）", () => {
    const runtime = makeRuntime(() => true);
    const exit = createApplicationExit({
      runtime,
      publish: () => {},
      finish: () => {},
    });

    exit.request();

    expect(exit.state()).toEqual({
      id: expect.any(String),
      phase: "confirming",
    });
  });
});

/** registerApplicationExit 透传（exit-flush.test.ts 同款 electron mock 形态） */
const bus = vi.hoisted(() => ({
  appHandlers: new Map<string, (event: { preventDefault(): void }) => void>(),
  ipcHandlers: new Map<
    string,
    (event: unknown, ...args: unknown[]) => unknown
  >(),
}));

vi.mock("electron", () => ({
  app: {
    on: (name: string, handler: (event: { preventDefault(): void }) => void) =>
      void bus.appHandlers.set(name, handler),
    quit: () => {},
  },
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, ...args: unknown[]) => unknown
    ) => void bus.ipcHandlers.set(channel, handler),
  },
}));

class FakeWindow extends EventEmitter {
  webContents = { send: vi.fn() };
  isDestroyed() {
    return false;
  }
  destroy() {
    this.emit("closed");
  }
}

let win: FakeWindow;
let runtime: TaskExitRuntime & { stopAndDrain: ReturnType<typeof vi.fn> };

beforeEach(() => {
  bus.appHandlers.clear();
  bus.ipcHandlers.clear();
  win = new FakeWindow();
  runtime = makeRuntime();
});

it("注册层透传终端计数：托盘退出（before-quit）的确认状态带 N", async () => {
  runtime.hasWork = () => true;
  registerApplicationExit({
    window: win as unknown as BrowserWindow,
    runtime,
    closeStorage: () => {},
    releaseResources: async () => {},
    terminalSessionCount: () => 1,
  });

  const event = { preventDefault: vi.fn() };
  bus.appHandlers.get("before-quit")!(event);

  const state = (await bus.ipcHandlers.get(IPC.application.exitState)!({
    sender: win.webContents,
  })) as { phase: string; terminalSessions?: number };
  expect(state).toMatchObject({ phase: "confirming", terminalSessions: 1 });
  expect(win.webContents.send).toHaveBeenCalledWith(
    IPC.application.exitChanged,
    expect.objectContaining({ phase: "confirming", terminalSessions: 1 })
  );
});
