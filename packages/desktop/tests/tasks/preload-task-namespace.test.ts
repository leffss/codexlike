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
 * 会话→任务改名（票 06 contract）：preload 只暴露 tasks 命名空间与
 * onTaskEvent——旧名 sessions / onSessionEvent 必须不存在（旧名不存在，
 * 防止兼容层悄悄回流）。
 */
it("preload 暴露 tasks 走新 channel，旧 sessions/onSessionEvent 不存在", async () => {
  await import("../../src/preload");
  const api = bridge.api!;

  await api.tasks.list();
  expect(bridge.invoke).toHaveBeenLastCalledWith("tasks:list");
  await api.tasks.markViewed("task-1", 3);
  expect(bridge.invoke).toHaveBeenLastCalledWith(
    "tasks:mark-viewed",
    "task-1",
    3
  );

  // 旧命名空间与旧事件订阅入口已删除。
  expect("sessions" in api).toBe(false);
  expect("onSessionEvent" in api).toBe(false);

  // 事件订阅：onTaskEvent 订阅唯一的事件流 channel。
  const release = api.onTaskEvent(() => {});
  expect(bridge.subscriptions.has("task:events")).toBe(true);
  release();
  expect(bridge.subscriptions.has("task:events")).toBe(false);
  expect([...bridge.subscriptions.keys()]).toEqual([]);
});
