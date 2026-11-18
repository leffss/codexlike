import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";

import { beforeEach, expect, it, vi } from "vitest";

import { registerApplicationExit } from "../../src/lifecycle/exit-ipc";
import type { TaskExitRuntime } from "../../src/lifecycle/application-exit";
import { IPC } from "../../src/shared/ipc";
import { createTrayResidency } from "../../src/tray/tray-residency";

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
  Tray: class {
    on() {}
    setToolTip() {}
    setContextMenu() {}
    displayBalloon() {}
  },
  Menu: { buildFromTemplate: (template: unknown) => template },
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
  minimized = false;
  focused = false;
  maximized = false;
  show() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
    this.focused = false;
  }
  focus() {
    this.focused = true;
  }
  restore() {
    this.minimized = false;
  }
  maximize() {
    this.maximized = true;
    this.visible = true;
  }
  isVisible() {
    return this.visible;
  }
  isMinimized() {
    return this.minimized;
  }
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

function registerWithTray(pendingMaximize = false) {
  const settings = { launchAtLogin: false, residencyHintShown: true };
  const tray = createTrayResidency({
    window: win as unknown as BrowserWindow,
    iconPath: "test.ico",
    initialLaunchAtLogin: false,
    pendingMaximize,
    settings: {
      get: async () => settings,
      set: async (patch) => Object.assign(settings, patch),
    },
    onToggleLaunchAtLogin: () => {},
    quit: () => requestQuit(),
  });
  const options = {
    window: win as unknown as BrowserWindow,
    runtime,
    closeStorage: () => {},
    releaseResources: async () => {},
    minimizeToTray: () => {
      void tray.minimizeToTray();
    },
    showMainWindow: () => tray.showMainWindow(),
  };
  registerApplicationExit(options);
}

function exitState() {
  return bus.ipcHandlers.get(IPC.application.exitState)!({
    sender: win.webContents,
  }) as { id: string; phase: string; error?: string };
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

it("隐藏到托盘后退出，有运行任务的确认窗口必须显示并聚焦", async () => {
  registerWithTray();
  runtime.hasWork = () => true;
  requestClose();
  expect(win.visible).toBe(false);
  expect(exitState().phase).toBe("idle");

  requestQuit();
  expect(exitState().phase).toBe("confirming");
  expect(win.visible).toBe(true);
  expect(win.focused).toBe(true);
  const state = exitState();
  await bus.ipcHandlers.get(IPC.application.answerExit)!(
    { sender: win.webContents },
    state.id,
    false
  );
  expect(exitState().phase).toBe("idle");
  expect(runtime.thaw).toHaveBeenCalledOnce();
  requestClose();
  expect(win.visible).toBe(false);
  expect(exitState().phase).toBe("idle");
});

it("隐藏窗口退出时保存失败，错误必须显示并聚焦且可以再驻留", async () => {
  registerWithTray();
  requestClose();
  requestQuit();
  expect(exitState().phase).toBe("flushing");
  // 无需回答的保存阶段仍静默，不能把每次托盘退出变成强制弹窗。
  expect(win.visible).toBe(false);
  const state = exitState();
  await bus.ipcHandlers.get(IPC.application.flushed)!(
    { sender: win.webContents },
    state.id,
    "磁盘只读"
  );

  expect(exitState()).toMatchObject({
    phase: "error",
    error: expect.stringContaining("磁盘只读"),
  });
  expect(win.visible).toBe(true);
  expect(win.focused).toBe(true);
  expect(runtime.thaw).toHaveBeenCalledOnce();
  requestClose();
  expect(win.visible).toBe(false);
});

it("窗口最小化时退出确认先恢复再显示聚焦", () => {
  registerWithTray();
  runtime.hasWork = () => true;
  win.minimized = true;
  win.visible = false;

  requestQuit();

  expect(exitState().phase).toBe("confirming");
  expect(win.minimized).toBe(false);
  expect(win.visible).toBe(true);
  expect(win.focused).toBe(true);
});

it("静默启动退出确认保留首次显示时的最大化恢复", () => {
  win.visible = false;
  registerWithTray(true);
  runtime.hasWork = () => true;

  requestQuit();

  expect(exitState().phase).toBe("confirming");
  expect(win.visible).toBe(true);
  expect(win.maximized).toBe(true);
  expect(win.focused).toBe(true);
});

it("隐藏窗口退出收尾失败也显示错误并恢复执行", async () => {
  registerWithTray();
  runtime.stopAndDrain.mockRejectedValueOnce(new Error("收尾失败"));
  requestClose();
  requestQuit();
  await bus.ipcHandlers.get(IPC.application.flushed)!(
    { sender: win.webContents },
    exitState().id
  );

  expect(exitState()).toMatchObject({
    phase: "error",
    error: expect.stringContaining("收尾失败"),
  });
  expect(win.visible).toBe(true);
  expect(win.focused).toBe(true);
  expect(runtime.thaw).toHaveBeenCalledOnce();
});

it("无待处理工作时隐藏窗口可静默完成退出，不额外弹出", async () => {
  registerWithTray();
  requestClose();
  requestQuit();
  await bus.ipcHandlers.get(IPC.application.flushed)!(
    { sender: win.webContents },
    exitState().id
  );

  expect(exitState().phase).toBe("ready");
  expect(win.visible).toBe(false);
  expect(win.focused).toBe(false);
});

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
