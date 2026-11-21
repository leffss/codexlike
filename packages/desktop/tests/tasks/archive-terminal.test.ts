import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import {
  createAgentResourceSnapshot,
  createTaskManager,
  createSqliteTaskStore,
  createTerminalSessionManager,
  createWorktreeService,
  type PtyExitEvent,
  type PtyPort,
  type PtyProcess,
  type PtySpawnRequest,
} from "@codexlike/agent-core/node";

import { registerTaskHandlers } from "../../src/tasks/task-ipc";
import { createProfileStore } from "../../src/profiles/profile-store";

/**
 * 任务归档的「先杀后归档」挂点（ADR 0033 票07）：归档确认已由渲染端完成
 * （任务有存活会话时提示后关闭），主进程 archive handler 在写入归档前终止
 * 该任务全部存活会话并等待 exit——terminal-exited 事件在归档前推进，执行
 * 现场完整，闭合 03 票「任务移除后事件无现场静默丢弃」的未决口。
 * 未注入 terminalSessions 时维持既有行为（可选装配）。
 */

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  dialog: {},
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(name, handler),
  },
}));

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  handlers.clear();
});

function invoke(name: string, ...args: unknown[]): any {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`未注册通道 ${name}`);
  return handler({}, ...args);
}

/** fake PtyPort：kill 后自动 exit（真实 pty「kill 后死透」语义），可控退出事件 */
function createFakePort() {
  const records: {
    killed: boolean;
    exited: boolean;
    exit(event?: { exitCode: number; signal?: number }): void;
  }[] = [];
  const port: PtyPort = {
    spawn() {
      const exitListeners: ((event: PtyExitEvent) => void)[] = [];
      const record = {
        killed: false,
        exited: false,
        exit(event = { exitCode: 0 }) {
          if (record.exited) return;
          record.exited = true;
          for (const listener of [...exitListeners]) listener(event);
        },
      };
      records.push(record);
      const process: PtyProcess = {
        pid: 5000 + records.length,
        write() {},
        resize() {},
        kill() {
          record.killed = true;
          record.exit({ exitCode: 0 });
        },
        onData() {
          return () => {};
        },
        onExit(listener) {
          exitListeners.push(listener);
          return () => {
            const index = exitListeners.indexOf(listener);
            if (index >= 0) exitListeners.splice(index, 1);
          };
        },
      };
      return process;
    },
  };
  return { port, records };
}

async function setup(options?: {
  terminalSessions?: ReturnType<typeof createTerminalSessionManager>;
}) {
  const root = mkdtempSync(join(tmpdir(), "archive-terminal-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const store = createSqliteTaskStore(join(home, "task-workbench.db"));
  cleanup.push(() => store.close());
  const manager = createTaskManager({
    persistence: store,
    resourcesFor: ({ workspacePath }: { workspacePath: string }) =>
      createAgentResourceSnapshot({
        workspacePath,
        globalDir: home,
        compatibleGlobalDir: join(root, "compatible"),
        findGitRoot: () => null,
      }),
  });
  const profiles = createProfileStore({
    dir: home,
    safeStorage: {
      isEncryptionAvailable: async () => true,
      encryptString: async (text: string) => Buffer.from(text),
      decryptString: async (bytes: Buffer) => bytes.toString(),
    },
  });
  const worktrees = createWorktreeService({
    worktreesDir: join(home, "worktrees"),
  });
  registerTaskHandlers({
    manager,
    profiles,
    getWindow: () => null,
    dataDir: home,
    worktreeService: worktrees,
    resourcesFor: ({ workspacePath }: { workspacePath: string }) =>
      createAgentResourceSnapshot({
        workspacePath,
        globalDir: home,
        compatibleGlobalDir: join(root, "compatible"),
        findGitRoot: () => null,
      }),
    ...(options?.terminalSessions
      ? { terminalSessions: options.terminalSessions }
      : {}),
  });
  return { manager, workspace };
}

/** 直接经 manager.create 建任务（不走 tasks:start——它会真发首轮消息） */
function createTask(
  manager: ReturnType<typeof createTaskManager>,
  workspace: string
): { id: string; workspacePath: string } {
  return manager.create({
    title: "初始任务",
    workspacePath: workspace,
  }).record;
}

it("归档带存活会话的任务：先杀等 exit（事件在归档写入前推进）再写归档", async () => {
  const { port } = createFakePort();
  const terminalSessions = createTerminalSessionManager({ port });
  const { manager, workspace } = await setup({ terminalSessions });
  const task = createTask(manager, workspace);

  // 事件监听记录每个 terminal-exited 到达时的归档状态（未归档 = null）；
  // 订阅先于一切 kill（事件不丢）
  const archivedAtAtExit: (string | null)[] = [];
  const unsubscribe = terminalSessions.onEvent((event) => {
    if (event.kind !== "terminal-exited") return;
    if (event.record.taskId !== task.id) return;
    archivedAtAtExit.push(
      manager.list().find((record) => record.id === task.id)?.archivedAt ?? null
    );
  });

  // 任务下两个存活会话 + 一个已退出会话（已退出的不重复 kill）
  terminalSessions.spawn({
    taskId: task.id,
    shell: "git-bash",
    origin: "user",
    cwd: task.workspacePath,
  });
  terminalSessions.spawn({
    taskId: task.id,
    shell: "git-bash",
    origin: "agent",
    cwd: task.workspacePath,
  });
  const done = terminalSessions.spawn({
    taskId: task.id,
    shell: "powershell",
    origin: "user",
    cwd: task.workspacePath,
  });
  if (!done.ok) throw new Error(done.reason);
  terminalSessions.kill(done.sessionId); // fake 自动 exit → 终态

  await invoke("tasks:archive", task.id, true);

  // 全部会话终态（存活被杀、事件齐全），归档已写入，且事件都先于归档
  expect(
    terminalSessions.sessionsFor(task.id).map((record) => record.status)
  ).toEqual(["exited", "exited", "exited"]);
  expect(
    manager.list().find((record) => record.id === task.id)?.archivedAt
  ).not.toBeNull();
  expect(archivedAtAtExit).toHaveLength(3);
  expect(archivedAtAtExit.every((at) => at === null)).toBe(true);
  unsubscribe();
});

it("归档无会话任务照常归档（terminalSessions 注入下无存活也不出错）", async () => {
  const { port } = createFakePort();
  const terminalSessions = createTerminalSessionManager({ port });
  const { manager, workspace } = await setup({ terminalSessions });
  const task = createTask(manager, workspace);

  await invoke("tasks:archive", task.id, true);

  expect(
    manager.list().find((record) => record.id === task.id)?.archivedAt
  ).not.toBeNull();
});

it("未注入 terminalSessions 时维持既有行为（归档不触终端）", async () => {
  const { manager, workspace } = await setup();
  const task = createTask(manager, workspace);

  await invoke("tasks:archive", task.id, true);

  expect(
    manager.list().find((record) => record.id === task.id)?.archivedAt
  ).not.toBeNull();
});
