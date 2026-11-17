import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";

import { beforeEach, expect, it, vi } from "vitest";

import { registerApplicationExit } from "../../src/lifecycle/exit-ipc";
import type { TaskExitRuntime } from "../../src/lifecycle/application-exit";
import { IPC } from "../../src/shared/ipc";

/**
 * 托盘驻留的 close 分流（ADR 0025，GLOSSARY「托盘驻留」「退出屏障」）：
 * 注入 minimizeToTray 后，idle/error 下的用户关闭（点 X）只驻留——
 * preventDefault + hide，不进退出屏障；退出流程进行中维持屏障拦截，
 * ready 后放行真退出。未注入时维持旧屏障行为（exit-flush.test.ts 覆盖）。
 */

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
let runtime: TaskExitRuntime & {
  stopAndDrain: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  bus.appHandlers.clear();
  bus.ipcHandlers.clear();
  win = new FakeWindow();
  runtime = {
    hasWork: vi.fn(() => false),
    freeze: vi.fn(),
    thaw: vi.fn(),
    stopAndDrain: vi.fn(async () => {}),
  };
});

function register() {
  const minimizeToTray = vi.fn();
  const flush = vi.fn();
  registerApplicationExit({
    window: win as unknown as BrowserWindow,
    runtime,
    closeStorage: () => {},
    releaseResources: async () => {},
    flushPendingWrites: flush,
    minimizeToTray,
  });
  return { minimizeToTray, flush };
}

function requestClose() {
  const event = { preventDefault: vi.fn() };
  win.emit("close", event);
  return event;
}

function requestQuit() {
  const event = { preventDefault: vi.fn() };
  bus.appHandlers.get("before-quit")!(event);
  return event;
}

it("idle 下点 X：preventDefault 并驻留（hide），不进退出屏障", () => {
  const { minimizeToTray, flush } = register();
  const event = requestClose();
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(minimizeToTray).toHaveBeenCalledOnce();
  expect(flush).not.toHaveBeenCalled();
  expect(win.webContents.send).not.toHaveBeenCalled();
});

it("退出流程中（before-quit 已进屏障）close 维持屏障，不驻留", () => {
  const { minimizeToTray } = register();
  const quitEvent = requestQuit();
  expect(quitEvent.preventDefault).toHaveBeenCalledOnce();
  const event = requestClose();
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(minimizeToTray).not.toHaveBeenCalled();
});

it("等待退出确认时（confirming）close 仍维持屏障，不驻留", () => {
  const { minimizeToTray } = register();
  runtime.hasWork = vi.fn(() => true);
  requestQuit(); // idle → confirming（有运行中任务）
  const event = requestClose();
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(minimizeToTray).not.toHaveBeenCalled();
  expect(win.webContents.send).toHaveBeenCalledWith(
    IPC.application.exitChanged,
    expect.objectContaining({ phase: "confirming" })
  );
});

it("退出已到 ready 后 close 放行（不拦截也不驻留）", async () => {
  const { minimizeToTray } = register();
  requestQuit();
  const sender = { sender: win.webContents };
  const state = (await bus.ipcHandlers.get(IPC.application.exitState)!(
    sender
  )) as { id: string };
  await bus.ipcHandlers.get(IPC.application.flushed)!(sender, state.id);
  await vi.waitFor(() => {
    if (runtime.stopAndDrain.mock.calls.length === 0) throw new Error("未排空");
  });
  const event = requestClose();
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(minimizeToTray).not.toHaveBeenCalled();
});
