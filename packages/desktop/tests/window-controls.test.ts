import { EventEmitter } from "node:events";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { beforeEach, expect, it, vi } from "vitest";
import type { CodexLikeApi } from "../src/shared/ipc";
import { registerWindowControls } from "../src/window/window-controls";

const bridge = vi.hoisted(() => ({
  api: null as CodexLikeApi | null,
  event: null as IpcMainInvokeEvent | null,
  handlers: new Map<string, (event: IpcMainInvokeEvent) => unknown>(),
  listeners: new Map<string, Set<(event: unknown, state: unknown) => void>>(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: CodexLikeApi) => {
      bridge.api = api;
    },
  },
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: IpcMainInvokeEvent) => unknown
    ) => {
      if (bridge.handlers.has(channel)) throw new Error(`重复通道 ${channel}`);
      bridge.handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => bridge.handlers.delete(channel),
  },
  ipcRenderer: {
    invoke: async (channel: string) => {
      const handler = bridge.handlers.get(channel);
      if (!handler) throw new Error(`未注册通道 ${channel}`);
      return handler(bridge.event!);
    },
    on: (
      channel: string,
      listener: (event: unknown, state: unknown) => void
    ) => {
      const listeners = bridge.listeners.get(channel) ?? new Set();
      listeners.add(listener);
      bridge.listeners.set(channel, listeners);
    },
    removeListener: (
      channel: string,
      listener: (event: unknown, state: unknown) => void
    ) => bridge.listeners.get(channel)?.delete(listener),
  },
}));

// 仅替换 Electron 系统边界，preload 与窗口控制模块均使用真实实现。
class NativeWindow extends EventEmitter {
  maximized = false;
  destroyed = false;
  minimized = false;
  webContents = {
    mainFrame: {},
    isDestroyed: () => false,
    send: (channel: string, state: unknown) => {
      for (const listener of bridge.listeners.get(channel) ?? []) {
        listener({ sender: this.webContents }, state);
      }
    },
  };
  isDestroyed() {
    return this.destroyed;
  }
  isMaximized() {
    return this.maximized;
  }
  minimize() {
    this.minimized = true;
  }
  maximize() {
    this.maximized = true;
    this.emit("maximize");
  }
  unmaximize() {
    this.maximized = false;
    this.emit("unmaximize");
  }
  close() {
    const event = { preventDefault: vi.fn() };
    this.emit("close", event);
    if (event.preventDefault.mock.calls.length === 0) {
      this.destroyed = true;
      this.emit("closed");
    }
  }
}

let win: NativeWindow;
let controls: CodexLikeApi["windowControls"];
beforeEach(async () => {
  bridge.handlers.clear();
  bridge.listeners.clear();
  win = new NativeWindow();
  bridge.event = {
    sender: win.webContents,
    senderFrame: win.webContents.mainFrame,
  } as unknown as IpcMainInvokeEvent;
  registerWindowControls(win as unknown as BrowserWindow);
  await import("../src/preload");
  controls = bridge.api!.windowControls;
});

const commands = ["getState", "minimize", "toggleMaximize", "close"] as const;

it.each(commands)("%s 拒绝其他 WebContents 的请求", async (command) => {
  bridge.event = {
    sender: new NativeWindow().webContents,
    senderFrame: win.webContents.mainFrame,
  } as unknown as IpcMainInvokeEvent;
  await expect(controls[command]()).rejects.toThrow("窗口控制来源无效");
  expect([win.minimized, win.maximized, win.destroyed]).toEqual([
    false,
    false,
    false,
  ]);
});

it.each(commands)("%s 拒绝所属窗口的子 frame 和空 frame", async (command) => {
  for (const senderFrame of [{}, null]) {
    bridge.event = {
      sender: win.webContents,
      senderFrame,
    } as unknown as IpcMainInvokeEvent;
    await expect(controls[command]()).rejects.toThrow("窗口控制来源无效");
    expect([win.minimized, win.maximized, win.destroyed]).toEqual([
      false,
      false,
      false,
    ]);
  }
});

it.each(commands)("%s 拒绝已销毁窗口，不再访问原生窗口", async (command) => {
  win.destroyed = true;
  const readState = vi.spyOn(win, "isMaximized");
  const minimize = vi.spyOn(win, "minimize");
  const close = vi.spyOn(win, "close");
  await expect(controls[command]()).rejects.toThrow("窗口已销毁");
  expect(readState).not.toHaveBeenCalled();
  expect(minimize).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});

it("原生最大化和还原事件发布状态，取消订阅只移除自己的监听器", () => {
  const listener = vi.fn();
  const otherListener = vi.fn();
  const unsubscribe = controls.onStateChanged(listener);
  const unsubscribeOther = controls.onStateChanged(otherListener);
  win.maximize();
  win.unmaximize();
  expect(listener.mock.calls).toEqual([
    [{ maximized: true }],
    [{ maximized: false }],
  ]);
  unsubscribe();
  unsubscribe();
  win.maximize();
  expect(listener).toHaveBeenCalledTimes(2);
  expect(otherListener).toHaveBeenCalledTimes(3);
  unsubscribeOther();
  expect([...bridge.listeners.values()].every((set) => set.size === 0)).toBe(
    true
  );
});

it("closed 清理窗口控制通道和监听器，保留其他模块的监听并可重新注册", async () => {
  const listener = vi.fn();
  controls.onStateChanged(listener);
  const unrelated = vi.fn();
  win.on("maximize", unrelated);
  const unrelatedHandler = () => "保留";
  bridge.handlers.set("unrelated", unrelatedHandler);
  await controls.close();
  for (const command of commands) {
    await expect(controls[command]()).rejects.toThrow("未注册通道");
  }
  expect(win.listenerCount("maximize")).toBe(1);
  expect(win.listenerCount("unmaximize")).toBe(0);
  expect(win.listenerCount("closed")).toBe(0);
  win.emit("maximize");
  expect(unrelated).toHaveBeenCalledOnce();
  expect(listener).not.toHaveBeenCalled();
  expect(bridge.handlers.get("unrelated")).toBe(unrelatedHandler);
  const nextWindow = new NativeWindow();
  registerWindowControls(nextWindow as unknown as BrowserWindow);
  bridge.event = {
    sender: nextWindow.webContents,
    senderFrame: nextWindow.webContents.mainFrame,
  } as unknown as IpcMainInvokeEvent;
  await expect(controls.getState()).resolves.toEqual({ maximized: false });
});

it.each(["window", "webContents"])(
  "%s 销毁后不再发布迟到的原生事件",
  (target) => {
    const listener = vi.fn();
    controls.onStateChanged(listener);
    if (target === "window") win.destroyed = true;
    else vi.spyOn(win.webContents, "isDestroyed").mockReturnValue(true);
    win.emit("maximize");
    win.emit("unmaximize");
    expect(listener).not.toHaveBeenCalled();
  }
);

it("关闭委托原生 close，退出处理器仍可阻止销毁并保留窗口", async () => {
  const requestExit = vi.fn((event: { preventDefault(): void }) => {
    event.preventDefault();
  });
  win.on("close", requestExit);
  await expect(controls.close()).resolves.toBeUndefined();
  expect(requestExit).toHaveBeenCalledOnce();
  expect(win.isDestroyed()).toBe(false);
  await expect(controls.getState()).resolves.toEqual({ maximized: false });
});

it("根据原生状态切换最大化与还原", async () => {
  await expect(controls.toggleMaximize()).resolves.toBeUndefined();
  await expect(controls.getState()).resolves.toEqual({ maximized: true });
  await expect(controls.toggleMaximize()).resolves.toBeUndefined();
  await expect(controls.getState()).resolves.toEqual({ maximized: false });
});

it("通过公开桥最小化所属窗口", async () => {
  await expect(controls.minimize()).resolves.toBeUndefined();
  expect(win.minimized).toBe(true);
});

it("通过公开桥读取原生窗口的当前最大化状态", async () => {
  await expect(controls.getState()).resolves.toEqual({ maximized: false });
  win.maximized = true;
  await expect(controls.getState()).resolves.toEqual({ maximized: true });
});
