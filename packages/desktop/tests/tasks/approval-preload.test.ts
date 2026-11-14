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
  await api.sessions.respondInteraction("task", "request", response);
  expect(bridge.invoke).toHaveBeenLastCalledWith(
    "sessions:respond-interaction",
    "task",
    "request",
    response
  );
  await api.sessions.revokeAutoApprove("task");
  expect(bridge.invoke).toHaveBeenLastCalledWith(
    "sessions:revoke-auto-approve",
    "task"
  );
  expect(api.sessions).not.toHaveProperty("setAutoApprove");
  await api.sessions.respondApproval("task", "request", "always");
  expect(bridge.invoke).toHaveBeenLastCalledWith(
    "sessions:respond-approval",
    "task",
    "request",
    "always"
  );
});
