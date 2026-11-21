import { expect, it, vi } from "vitest";
import type { CodexLikeApi } from "../../src/shared/ipc";

const bridge = vi.hoisted(() => ({
  api: null as CodexLikeApi | null,
  invoke: vi.fn(async (..._args: unknown[]) => undefined),
  subscriptions: new Map<string, unknown[]>(),
}));
vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: CodexLikeApi) => {
      bridge.api = api;
    },
  },
  ipcRenderer: {
    invoke: bridge.invoke,
    on: (channel: string, listener: unknown) => {
      const list = bridge.subscriptions.get(channel) ?? [];
      list.push(listener);
      bridge.subscriptions.set(channel, list);
    },
    removeListener: (channel: string, listener: unknown) => {
      const list = (bridge.subscriptions.get(channel) ?? []).filter(
        (item) => item !== listener
      );
      if (list.length === 0) bridge.subscriptions.delete(channel);
      else bridge.subscriptions.set(channel, list);
    },
  },
}));

/**
 * 终端会话 preload 面（ADR 0033 票03）：terminals 命名空间经 contextBridge
 * 暴露——操作 invoke 到 terminals:* channel，字节流订阅走专用通道
 * terminals:session-data（生命周期事件复用 task:events，不经本命名空间）。
 */
it("preload 暴露 terminals 命名空间，操作与字节流订阅各走其道", async () => {
  await import("../../src/preload");
  const api = bridge.api!;

  await api.terminals.create({ taskId: "task-1" });
  expect(bridge.invoke).toHaveBeenLastCalledWith("terminals:create", {
    taskId: "task-1",
  });
  await api.terminals.write("session-1", "ls\r");
  expect(bridge.invoke).toHaveBeenLastCalledWith(
    "terminals:write",
    "session-1",
    "ls\r"
  );
  await api.terminals.resize("session-1", { cols: 100, rows: 30 });
  expect(bridge.invoke).toHaveBeenLastCalledWith(
    "terminals:resize",
    "session-1",
    {
      cols: 100,
      rows: 30,
    }
  );
  await api.terminals.kill("session-1");
  expect(bridge.invoke).toHaveBeenLastCalledWith("terminals:kill", "session-1");
  await api.terminals.subscribe("session-1");
  expect(bridge.invoke).toHaveBeenLastCalledWith(
    "terminals:subscribe",
    "session-1"
  );
  await api.terminals.unsubscribe("session-1");
  expect(bridge.invoke).toHaveBeenLastCalledWith(
    "terminals:unsubscribe",
    "session-1"
  );
  await api.terminals.session("session-1");
  expect(bridge.invoke).toHaveBeenLastCalledWith(
    "terminals:session",
    "session-1"
  );
  await api.terminals.listFor("task-1");
  expect(bridge.invoke).toHaveBeenLastCalledWith(
    "terminals:list-for",
    "task-1"
  );

  // 字节流订阅：专用通道，退订即移除监听
  const release = api.terminals.onSessionData(() => {});
  expect(bridge.subscriptions.has("terminals:session-data")).toBe(true);
  release();
  expect(bridge.subscriptions.has("terminals:session-data")).toBe(false);
});
