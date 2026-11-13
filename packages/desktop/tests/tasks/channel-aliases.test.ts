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
 * 任务→任务改名（票 03）的 expand 兼容：每个 tasks:* channel 与对应
 * sessions:* channel 必须注册同一 handler——现有 UI 与 e2e 经旧 channel
 * 调用不改仍绿，票 06 contract 阶段删除旧注册。
 */
it("全部 sessions:* channel 与 tasks:* 双注册同一 handler", async () => {
  const root = mkdtempSync(join(tmpdir(), "channel-aliases-"));
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

  // IPC.tasks 与 IPC.sessions 键一一对应；同名键的 handler 必须是同一函数。
  const taskKeys = Object.keys(IPC.tasks).sort();
  const sessionKeys = Object.keys(IPC.sessions).sort();
  expect(taskKeys).toEqual(sessionKeys);
  expect(taskKeys.length).toBeGreaterThan(0);
  for (const key of taskKeys) {
    const taskChannel = IPC.tasks[key as keyof typeof IPC.tasks];
    const sessionChannel = IPC.sessions[key as keyof typeof IPC.sessions];
    expect(handlers.get(taskChannel), `${key}: ${taskChannel} 未注册`).toBe(
      handlers.get(sessionChannel)
    );
  }

  // 新 channel 独立可用：list 返回数组、view 参数校验照常生效。
  const window = {
    isDestroyed: () => false,
    webContents: { send: () => {} },
  } as unknown as BrowserWindow;
  expect(window).toBeDefined();
  expect(handlers.get("tasks:list")!({}, undefined)).toEqual([]);
  expect(() => handlers.get("tasks:view")!({}, 42)).toThrow(
    "view：sessionId 必须是字符串"
  );
});
