import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";

import { beforeEach, expect, it, vi } from "vitest";

import { registerApplicationExit } from "../../src/lifecycle/exit-ipc";
import type { TaskExitRuntime } from "../../src/lifecycle/application-exit";
import { IPC } from "../../src/shared/ipc";

/**
 * 托盘驻留与终端存活的组合语义（ADR 0033 票07 + GLOSSARY「托盘驻留」
 * 「退出屏障」）：终端会话存活计入 hasWork 后，点 X（idle）仍只驻留不进
 * 屏障（close-to-tray 语义不被终端破坏）；托盘菜单「退出」走完整屏障——
 * 确认状态携带「N 个终端会话将关闭」，确认后退出、取消后留驻。
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
  visible = true;
  isDestroyed() {
    return false;
  }
  show() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  focus() {}
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
  runtime = {
    hasWork: vi.fn(() => false),
    freeze: vi.fn(),
    thaw: vi.fn(),
    stopAndDrain: vi.fn(async () => {}),
  };
});

/** 有存活终端会话的装配（hasWork 并入 + 计数注入，main.ts 组合的测试投影） */
function registerWithAliveSessions(count: number) {
  const minimizeToTray = vi.fn();
  runtime.hasWork = vi.fn(() => count > 0);
  registerApplicationExit({
    window: win as unknown as BrowserWindow,
    runtime,
    closeStorage: () => {},
    releaseResources: async () => {},
    minimizeToTray,
    showMainWindow: () => win.show(),
    terminalSessionCount: () => count,
  });
  return { minimizeToTray };
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

function exitState() {
  return bus.ipcHandlers.get(IPC.application.exitState)!({
    sender: win.webContents,
  }) as { id: string; phase: string; terminalSessions?: number };
}

it("有存活终端会话时点 X 仍只驻留：hide 不进屏障（close-to-tray 语义不被终端破坏）", () => {
  const { minimizeToTray } = registerWithAliveSessions(2);

  const event = requestClose();

  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(minimizeToTray).toHaveBeenCalledOnce();
  // 驻留的 visible 行为已由 close-to-tray.test.ts 覆盖；此处断言分流不进屏障
  expect(runtime.freeze).not.toHaveBeenCalled();
  expect(win.webContents.send).not.toHaveBeenCalled();
});

it("托盘退出走完整屏障：确认状态带「N 个终端会话将关闭」数据面", () => {
  registerWithAliveSessions(2);

  requestQuit();

  expect(exitState()).toMatchObject({
    phase: "confirming",
    terminalSessions: 2,
  });
  expect(win.visible).toBe(true); // 确认卡唤起主窗口
});

it("托盘退出取消后留驻：thaw 回 idle，再次点 X 仍驻留", async () => {
  registerWithAliveSessions(1);
  requestQuit();
  const state = exitState();

  await bus.ipcHandlers.get(IPC.application.answerExit)!(
    { sender: win.webContents },
    state.id,
    false
  );

  expect(exitState().phase).toBe("idle");
  expect(runtime.thaw).toHaveBeenCalledOnce();
  expect(runtime.stopAndDrain).not.toHaveBeenCalled();
  const event = requestClose();
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(exitState().phase).toBe("idle");
});

it("托盘退出确认后收尾：flushing → stopAndDrain → ready（会话清理由 releaseResources 承担）", async () => {
  const releaseResources = vi.fn(async () => {});
  runtime.hasWork = vi.fn(() => true);
  registerApplicationExit({
    window: win as unknown as BrowserWindow,
    runtime,
    closeStorage: () => {},
    releaseResources,
    minimizeToTray: vi.fn(),
    showMainWindow: () => win.show(),
    terminalSessionCount: () => 1,
  });
  requestQuit();
  const sender = { sender: win.webContents };
  const state = exitState();

  await bus.ipcHandlers.get(IPC.application.answerExit)!(
    sender,
    state.id,
    true
  );
  expect(exitState().phase).toBe("flushing");
  await bus.ipcHandlers.get(IPC.application.flushed)!(sender, state.id);
  await vi.waitFor(() => {
    if (runtime.stopAndDrain.mock.calls.length === 0) throw new Error("未排空");
  });
  expect(exitState().phase).toBe("ready");
});
