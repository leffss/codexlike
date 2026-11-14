import { expect, it, vi } from "vitest";
import type { CodexLikeApi } from "../../src/shared/ipc";

const bridge = vi.hoisted(() => ({
  api: null as CodexLikeApi | null,
  invoke: vi.fn(async (..._args: unknown[]) => true),
}));
vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: CodexLikeApi) => {
      bridge.api = api;
    },
  },
  ipcRenderer: { invoke: bridge.invoke },
}));

it("公开preload桥只转发项目置顶、有效交互载荷和撤销，不暴露直接启用授权", async () => {
  await import("../../src/preload");
  const api = bridge.api!;
  await api.projects.setPinned("project", true);
  expect(bridge.invoke).toHaveBeenLastCalledWith(
    "projects:set-pinned",
    "project",
    true
  );
  const response = {
    kind: "approval",
    decision: "approve",
    scope: "task",
  } as const;
  await api.tasks.respondInteraction("task", "request", response);
  expect(bridge.invoke).toHaveBeenLastCalledWith(
    "tasks:respond-interaction",
    "task",
    "request",
    response
  );
  await api.tasks.revokeAutoApprove("task");
  expect(bridge.invoke).toHaveBeenLastCalledWith(
    "tasks:revoke-auto-approve",
    "task"
  );
  expect(api.tasks).not.toHaveProperty("setAutoApprove");
  await api.tasks.respondApproval("task", "request", "always");
  expect(bridge.invoke).toHaveBeenLastCalledWith(
    "tasks:respond-approval",
    "task",
    "request",
    "always"
  );
});
