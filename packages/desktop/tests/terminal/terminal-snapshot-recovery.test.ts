import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import {
  createSqliteTaskStore,
  createTaskManager,
  createTerminalSessionManager,
  type PtyExitEvent,
  type PtyPort,
  type PtyProcess,
  type PtySpawnRequest,
} from "@codexlike/agent-core/node";
import type { TaskRecord } from "@codexlike/agent-core";
import type { BrowserWindow } from "electron";

import { IPC } from "../../src/shared/ipc";
import { registerTerminalSessionHandlers } from "../../src/terminal/terminal-session-ipc";
import {
  recordTerminalSessionEvent,
  settleTerminalSessionRowsOnStartup,
} from "../../src/terminal/terminal-lifecycle";
import { createLiveTasks } from "../../src/tasks/live-tasks";

/**
 * 快照落库 + 重启回看（ADR 0033 票 08）：真实 SQLite 重开的等价重启路径
 * （先例 subagent-recovery / task-queue-restart）。覆盖三条终止路径的落库
 * 时机（spawn 即写骨架行 / kill 等 exit 推进终态+快照 / killAll 屏障语义）、
 * 重启收尾库层衔接（残留 running 行置终态）、恢复下发（view 并行字段
 * terminals 一次读出）与回看兜底（subscribe 从库行取快照回放）。
 * main.ts 的三处挂点装配以同序桥接复现（事件桥 → 收尾 → flush）。
 */

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

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  handlers.clear();
});

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`未注册通道 ${channel}`);
  return handler({}, ...args);
}

/** fake PtyPort：记录每次 spawn，kill 后自动交付 exit（exit 齐全语义） */
function createFakePort() {
  interface FakePtyRecord {
    request: PtySpawnRequest;
    exited: boolean;
    emitData(text: string): void;
    exit(event?: { exitCode: number; signal?: number }): void;
  }
  const records: FakePtyRecord[] = [];
  const port: PtyPort = {
    spawn(request) {
      const dataListeners: ((data: string) => void)[] = [];
      const exitListeners: ((event: PtyExitEvent) => void)[] = [];
      const record: FakePtyRecord = {
        request,
        emitData(text) {
          for (const listener of [...dataListeners]) listener(text);
        },
        exit(event = { exitCode: 0 }) {
          if (record.exited) return;
          record.exited = true;
          for (const listener of [...exitListeners]) listener(event);
        },
        exited: false,
      };
      records.push(record);
      const process: PtyProcess = {
        pid: 4000 + records.length,
        write() {},
        resize() {},
        kill() {
          // 真实 pty 语义（02 票适配器保证 kill 后死透）：kill 后 exit 到达
          record.exit({ exitCode: 0 });
        },
        onData(listener) {
          dataListeners.push(listener);
          return () => {
            const index = dataListeners.indexOf(listener);
            if (index >= 0) dataListeners.splice(index, 1);
          };
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

function taskRow(id: string): TaskRecord {
  return {
    id,
    creationRequestId: null,
    title: "长命令任务",
    workspacePath: "C:\\work\\demo",
    providerProfileId: null,
    model: null,
    status: "idle",
    workspaceMode: "local",
    projectId: null,
    workspaceOriginPath: null,
    approvalMode: "assist",
    autoApprove: false,
    mainInputTokens: 0,
    mainOutputTokens: 0,
    subagentInputTokens: 0,
    subagentOutputTokens: 0,
    archivedAt: null,
    pinned: false,
    lastUsedAt: "2026-11-21T08:00:00.000Z",
    createdAt: "2026-11-21T08:00:00.000Z",
    updatedAt: "2026-11-21T08:00:00.000Z",
  };
}

it("落库时机：spawn 即写骨架行，kill 等 exit 齐全后推进终态与定格快照（killAll 屏障语义同款）", () => {
  const root = mkdtempSync(join(tmpdir(), "terminal-snapshot-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = createSqliteTaskStore(":memory:");
  cleanup.push(() => store.close());
  store.insertTask(taskRow("task-1"));

  const { port, records } = createFakePort();
  const sessions = createTerminalSessionManager({ port, killAllTimeoutMs: 50 });
  // 生产装配同序（main.ts）：事件桥先于任何 spawn 注册
  sessions.onEvent((event) => recordTerminalSessionEvent(store, event));

  const spawned = sessions.spawn({
    taskId: "task-1",
    shell: "git-bash",
    origin: "agent",
    cwd: "C:\\work\\demo",
  });
  if (!spawned.ok) throw new Error(spawned.reason);
  // spawn 即写：exit 前进程被杀也有「曾开过」的 running 骨架行
  expect(store.terminalSession(spawned.sessionId)).toMatchObject({
    sessionId: spawned.sessionId,
    taskId: "task-1",
    status: "running",
  });

  records[0]!.emitData("构建日志第一行\n");
  records[0]!.emitData("构建日志最后一行\n");
  sessions.kill(spawned.sessionId); // fake port kill 后自动 exit

  // exit 齐全后推进：终态 + 定格快照（含尾部原文）
  const row = store.terminalSession(spawned.sessionId);
  expect(row).toMatchObject({
    status: "exited",
    exitCode: 0,
  });
  expect(row?.snapshot).toContain("构建日志最后一行");
  expect(row?.exitedAt).not.toBeUndefined();

  // 退出屏障路径（releaseResources 语义）：killAll 等 exit 后行推进
  const second = sessions.spawn({
    taskId: "task-1",
    shell: "git-bash",
    origin: "user",
    cwd: "C:\\work\\demo",
  });
  if (!second.ok) throw new Error(second.reason);
  records[1]!.emitData("屏障前输出\n");
  void sessions.killAll();
  expect(store.terminalSession(second.sessionId)).toMatchObject({
    status: "exited",
    exitCode: 0,
  });
  expect(store.terminalSession(second.sessionId)?.snapshot).toContain(
    "屏障前输出"
  );
});

it("重启收尾置终态 → 恢复下发（view 并行字段一次读出）→ 回看兜底（subscribe 取快照回放）", () => {
  const root = mkdtempSync(join(tmpdir(), "terminal-snapshot-recovery-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = join(root, "fresh", "tasks.db");
  const first = createSqliteTaskStore(dbPath);
  cleanup.push(() => {
    if (!firstClosed) first.close();
  });
  let firstClosed = false;
  first.insertTask(taskRow("task-1"));

  const { port, records } = createFakePort();
  const sessions = createTerminalSessionManager({ port, killAllTimeoutMs: 50 });
  sessions.onEvent((event) => recordTerminalSessionEvent(first, event));

  // 会话一：正常退出路径（快照已定格落库）
  const normal = sessions.spawn({
    taskId: "task-1",
    shell: "git-bash",
    origin: "agent",
    cwd: "C:\\work\\demo",
  });
  if (!normal.ok) throw new Error(normal.reason);
  records[0]!.emitData("重启前最后一次输出\n");
  sessions.kill(normal.sessionId);

  // 会话二：模拟崩溃——保持 running 直接关库（骨架行残留 running）
  const crashed = sessions.spawn({
    taskId: "task-1",
    shell: "git-bash",
    origin: "user",
    cwd: "C:\\work\\demo",
  });
  if (!crashed.ok) throw new Error(crashed.reason);

  // 等价重启：关库 → 重开 → 收尾置终态（main.ts 启动收尾区同点）→ view
  first.close();
  firstClosed = true;
  const reopened = createSqliteTaskStore(dbPath);
  cleanup.push(() => reopened.close());
  settleTerminalSessionRowsOnStartup(reopened, "2026-11-21T09:00:00.000Z");

  // 收尾：崩溃残留行按收尾时刻置终态（exitCode/快照缺省容忍）
  expect(reopened.terminalSession(crashed.sessionId)).toMatchObject({
    status: "exited",
    exitedAt: "2026-11-21T09:00:00.000Z",
  });
  expect(reopened.terminalSession(crashed.sessionId)?.exitCode).toBeUndefined();
  expect(reopened.terminalSession(crashed.sessionId)?.snapshot).toBeUndefined();

  // 恢复下发：view 并行字段 terminals 一次读出「已退出」组（不走按需拉取）
  const restored = createTaskManager({ persistence: reopened });
  const view = createLiveTasks(restored).view("task-1")!;
  expect(view.terminals).toHaveLength(2);
  const byName = new Map(view.terminals.map((row) => [row.name, row]));
  const normalRow = byName.get("git-bash · 1");
  const crashedRow = byName.get("git-bash · 2");
  expect(normalRow).toMatchObject({
    sessionId: normal.sessionId,
    status: "exited",
    exitCode: 0,
    snapshot: expect.stringContaining("重启前最后一次输出"),
  });
  // 崩溃残留行：置终态但快照缺省（渲染容忍，回放空缓冲）
  expect(crashedRow).toMatchObject({
    sessionId: crashed.sessionId,
    status: "exited",
    exitedAt: "2026-11-21T09:00:00.000Z",
  });
  expect(crashedRow?.snapshot).toBeUndefined();
  // 模型上下文边界：恢复载荷的 history（transcript）不含终端快照文本
  expect(JSON.stringify(view.history)).not.toContain("重启前最后一次输出");

  // 回看兜底：subscribe 经 restoredSession 查库行，快照作为 buffered 回放
  //（main.ts 注入 persistence.terminalSession 同款）
  const window = {
    isDestroyed: () => true,
    webContents: { send: () => {} },
  } as unknown as BrowserWindow;
  registerTerminalSessionHandlers({
    sessions: createTerminalSessionManager({ port, killAllTimeoutMs: 50 }),
    workspaceFor: () => null,
    shell: () => "git-bash",
    restoredSession: (sessionId) => reopened.terminalSession(sessionId),
    getWindow: () => window,
    pushTaskEvent: () => {},
  });
  const subscribed = invoke(IPC.terminals.subscribe, normal.sessionId) as {
    ok: boolean;
    buffered?: string;
  };
  expect(subscribed.ok).toBe(true);
  expect(subscribed.buffered).toContain("重启前最后一次输出");
  // 崩溃残留行：回放空缓冲（快照缺省容忍）
  const crashedSubscribe = invoke(
    IPC.terminals.subscribe,
    crashed.sessionId
  ) as {
    ok: boolean;
    buffered?: string;
  };
  expect(crashedSubscribe.ok).toBe(true);
  expect(crashedSubscribe.buffered).toBe("");
});
