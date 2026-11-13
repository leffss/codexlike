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
 * 任务→任务改名（票 03）expand 兼容：preload 按新名暴露 tasks 命名空间与
 * onTaskEvent；旧名 sessions / onSessionEvent 保留且必须仍走旧 channel
 * （e2e 对 sessions:* 的 handler 劫持依赖旧 channel 上的真实流量）。
 */
it("tasks 走新 channel，sessions/onSessionEvent 保留走旧 channel", async () => {
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

  await api.sessions.list();
  expect(bridge.invoke).toHaveBeenLastCalledWith("sessions:list");
  await api.sessions.markViewed("task-1", 3);
  expect(bridge.invoke).toHaveBeenLastCalledWith(
    "sessions:mark-viewed",
    "task-1",
    3
  );

  // 事件订阅：新旧 API 各自订阅对应事件流 channel，互不串扰。
  const releaseTask = api.onTaskEvent(() => {});
  expect(bridge.subscriptions.has("task:events")).toBe(true);
  releaseTask();
  expect(bridge.subscriptions.has("task:events")).toBe(false);

  const releaseSession = api.onSessionEvent(() => {});
  expect(bridge.subscriptions.has("session:events")).toBe(true);
  releaseSession();
  expect(bridge.subscriptions.has("session:events")).toBe(false);
});
