import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";

import { beforeEach, expect, it, vi } from "vitest";

import { registerApplicationExit } from "../../src/lifecycle/exit-ipc";
import type { TaskExitRuntime } from "../../src/lifecycle/application-exit";
import { IPC } from "../../src/shared/ipc";

/**
 * 退出屏障的 flush 挂点（票02）：退出请求被接受（close / before-quit 拦截）
 * 时同步调用 flush 回调——窗口仍在、销毁前，把启动现场防抖中未落盘的变化刷出。
 * 仅替换 Electron 系统边界（app / ipcMain），退出状态机用真实实现。
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

function register(flush: () => void) {
  registerApplicationExit({
    window: win as unknown as BrowserWindow,
    runtime,
    closeStorage: () => {},
    releaseResources: async () => {},
    flushPendingWrites: flush,
  });
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

/** 走完退出状态机到 ready：flushing → flushed → stopping → ready（finish） */
async function driveToReady() {
  requestClose();
  const sender = { sender: win.webContents };
  const state = (await bus.ipcHandlers.get(IPC.application.exitState)!(
    sender
  )) as { id: string; phase: string };
  await bus.ipcHandlers.get(IPC.application.flushed)!(sender, state.id);
  await vi.waitFor(() => {
    // finish 里 releaseResources 后 app.quit（mock），状态应已 ready
    if (runtime.stopAndDrain.mock.calls.length === 0) throw new Error("未排空");
  });
}

it("close 退出请求被接受时同步调用 flush（窗口仍存活）", () => {
  const flush = vi.fn();
  register(flush);
  const event = requestClose();
  expect(flush).toHaveBeenCalledOnce();
  expect(event.preventDefault).toHaveBeenCalledOnce();
});

it("before-quit 退出请求同样触发 flush（app.quit 路径）", () => {
  const flush = vi.fn();
  register(flush);
  const event = requestQuit();
  expect(flush).toHaveBeenCalledOnce();
  expect(event.preventDefault).toHaveBeenCalledOnce();
});

it("每个退出入口都尝试 flush（幂等无害）；退出已到 ready（正在收尾）时不再 flush", async () => {
  const flush = vi.fn();
  register(flush);
  requestClose();
  expect(flush).toHaveBeenCalledOnce();
  // before-quit 是另一个退出入口（app.quit 路径先于 close）：
  // request 幂等但每个入口都调用 flush——flush 自身幂等（无挂起变化则 no-op）
  requestQuit();
  expect(flush).toHaveBeenCalledTimes(2);

  await driveToReady(); // 内部再次 requestClose：第三次 flush（当时尚未 ready）
  requestClose();
  expect(flush).toHaveBeenCalledTimes(3); // ready 后短路，不再 flush
});

it("未提供 flush 回调时退出屏障照常工作（可选装配）", async () => {
  registerApplicationExit({
    window: win as unknown as BrowserWindow,
    runtime,
    closeStorage: () => {},
    releaseResources: async () => {},
  });
  const event = requestClose();
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(win.webContents.send).toHaveBeenCalledWith(
    IPC.application.exitChanged,
    expect.objectContaining({ phase: "flushing" })
  );
});
