import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createAgentResourceSnapshot,
  createBuiltinTools,
  createTaskManager,
  createSqliteTaskStore,
  createWorktreeService,
} from "@codexlike/agent-core/node";
import type { BrowserWindow } from "electron";
import { IPC } from "../../src/shared/ipc";
import { registerTaskHandlers } from "../../src/tasks/task-ipc";
import { createProfileStore } from "../../src/profiles/profile-store";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  dialog: {},
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) =>
      handlers.set(name, fn),
  },
}));
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  handlers.clear();
});

/**
 * 会话→任务改名（票 06 contract）：票 03 的 expand 兼容层必须删除干净——
 * IPC 契约不再携带旧 sessions channel 常量，主进程也不再注册任何
 * `sessions:*` handler（旧名不存在，防止兼容层悄悄回流）。
 */
it("旧 sessions channel 兼容层已删除：IPC 无 sessions 键、无 sessions:* 注册", async () => {
  expect("sessions" in IPC).toBe(false);
  expect("sessionEvents" in IPC).toBe(false);

  const root = mkdtempSync(join(tmpdir(), "legacy-channels-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "project"));
  const persistence = createSqliteTaskStore(join(root, "tasks.db"));
  cleanup.push(() => persistence.close());
  const resourcesFor = ({ workspacePath }: { workspacePath: string }) =>
    createAgentResourceSnapshot({
      workspacePath,
      globalDir: root,
      compatibleGlobalDir: join(root, "compatible"),
      findGitRoot: () => null,
    });
  const manager = createTaskManager({
    persistence,
    resourcesFor,
    tools: createBuiltinTools(),
  });
  const profiles = createProfileStore({
    dir: root,
    safeStorage: {
      isEncryptionAvailable: async () => true,
      encryptString: async (text: string) => Buffer.from(text),
      decryptString: async (bytes: Buffer) => bytes.toString(),
    },
  });
  registerTaskHandlers({
    manager,
    profiles,
    getWindow: () => null,
    dataDir: root,
    worktreeService: createWorktreeService({
      worktreesDir: join(root, "worktrees"),
    }),
    resourcesFor,
  });

  expect([...handlers.keys()].filter((c) => c.startsWith("sessions:"))).toEqual(
    []
  );
  expect(handlers.has("session:events")).toBe(false);

  // 正式 channel 独立可用：list 返回数组、view 参数校验照常生效。
  const window = {
    isDestroyed: () => false,
    webContents: { send: () => {} },
  } as unknown as BrowserWindow;
  expect(window).toBeDefined();
  expect(handlers.get("tasks:list")!({}, undefined)).toEqual([]);
  expect(() => handlers.get("tasks:view")!({}, 42)).toThrow(
    "view：taskId 必须是字符串"
  );
});
