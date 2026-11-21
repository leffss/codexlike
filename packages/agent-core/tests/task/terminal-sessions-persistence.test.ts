import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSqliteTaskStore } from "../../src/task/persistence";
import { createTaskManager } from "../../src/task/manager";
import type { TerminalSessionRecord } from "../../src/terminal/types";
import type { TaskRecord } from "../../src/task/types";

/**
 * 终端会话落库（ADR 0033 票 08 / ADR 0021 纪律）：`terminal_sessions` 单表
 * CREATE TABLE IF NOT EXISTS 无迁移，旧库打开自动补建；spawn 即写骨架行、
 * exit 时推进终态与快照（动态列 patch，先例 updateSubagent）；重启收尾把
 * 残留 running 行置终态。快照只供回看——不进模型上下文的边界由恢复数据面
 * （TaskManager.terminalSessions 只被 view 并行字段消费）结构性保证。
 */

/** 最小合法任务记录（先例 sqlite-store.test.ts） */
function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    creationRequestId: null,
    title: "demo",
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
    ...overrides,
  };
}

/** spawn 时刻的骨架 record（running，终态字段缺省） */
function runningRecord(
  overrides: Partial<TerminalSessionRecord> = {}
): TerminalSessionRecord {
  return {
    sessionId: "term-1",
    taskId: "task-1",
    name: "git-bash · 1",
    shell: "git-bash",
    origin: "user",
    status: "running",
    createdAt: "2026-11-21T08:00:01.000Z",
    ...overrides,
  };
}

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "terminal-persistence-"));
  tempDirs.push(dir);
  return join(dir, "fresh", "tasks.db");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("terminal_sessions 落库（票 08）", () => {
  it("旧库打开自动补建：建表写入后关库重开，行原样读回（无迁移）", () => {
    const dbPath = tempDbPath();
    const first = createSqliteTaskStore(dbPath);
    first.insertTask(taskRecord());
    first.insertTerminalSession(runningRecord());
    first.close();
    // 重开：CREATE TABLE IF NOT EXISTS 幂等，行不丢
    const reopened = createSqliteTaskStore(dbPath);
    const rows = reopened.listTerminalSessions("task-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "term-1",
      taskId: "task-1",
      name: "git-bash · 1",
      shell: "git-bash",
      origin: "user",
      status: "running",
      createdAt: "2026-11-21T08:00:01.000Z",
    });
    expect(rows[0]?.exitedAt).toBeUndefined();
    reopened.close();
  });

  it("exit 推进：updateTerminalSession 写入终态与快照，读取含退出码/信号", () => {
    const store = createSqliteTaskStore(":memory:");
    store.insertTask(taskRecord());
    store.insertTerminalSession(runningRecord());
    store.updateTerminalSession("term-1", {
      status: "exited",
      exitedAt: "2026-11-21T08:01:00.000Z",
      exitCode: 0,
      signal: undefined,
      snapshot: "命令输出尾部原文",
    });
    const record = store.terminalSession("term-1");
    expect(record).toMatchObject({
      status: "exited",
      exitedAt: "2026-11-21T08:01:00.000Z",
      exitCode: 0,
      snapshot: "命令输出尾部原文",
    });
    expect(record?.signal).toBeUndefined();
    store.close();
  });

  it("缺省容忍：兜底置终态的 record 无 exitCode/signal/快照，读回字段缺省不报错", () => {
    const store = createSqliteTaskStore(":memory:");
    store.insertTask(taskRecord());
    store.insertTerminalSession(runningRecord());
    // killAll 兜底路径：只有 status + exitedAt（exitCode/signal/快照全缺省）
    store.updateTerminalSession("term-1", {
      status: "exited",
      exitedAt: "2026-11-21T08:02:00.000Z",
    });
    const record = store.terminalSession("term-1");
    expect(record?.status).toBe("exited");
    expect(record?.exitedAt).toBe("2026-11-21T08:02:00.000Z");
    expect(record?.exitCode).toBeUndefined();
    expect(record?.signal).toBeUndefined();
    expect(record?.snapshot).toBeUndefined();
    store.close();
  });

  it("settleRunningTerminalSessions：残留 running 行按收尾时刻置终态，终态行不动", () => {
    const store = createSqliteTaskStore(":memory:");
    store.insertTask(taskRecord());
    // 一行残留 running（崩溃进程的骨架行），一行已被 killAll 推进为终态
    store.insertTerminalSession(runningRecord({ sessionId: "term-crash" }));
    store.insertTerminalSession(
      runningRecord({
        sessionId: "term-done",
        name: "git-bash · 2",
        status: "exited",
        exitedAt: "2026-11-21T08:03:00.000Z",
        exitCode: 0,
        snapshot: "已完成会话的快照",
      })
    );
    store.settleRunningTerminalSessions("2026-11-21T09:00:00.000Z");
    const crashed = store.terminalSession("term-crash");
    expect(crashed).toMatchObject({
      status: "exited",
      exitedAt: "2026-11-21T09:00:00.000Z",
    });
    expect(crashed?.exitCode).toBeUndefined();
    expect(crashed?.signal).toBeUndefined();
    expect(crashed?.snapshot).toBeUndefined();
    // 已终态行不被改写（重开幂等：completedAt/快照语义同款）
    expect(store.terminalSession("term-done")).toMatchObject({
      exitedAt: "2026-11-21T08:03:00.000Z",
      exitCode: 0,
      snapshot: "已完成会话的快照",
    });
    // 二次收尾无 running 行可改，无副作用
    store.settleRunningTerminalSessions("2026-11-21T09:30:00.000Z");
    expect(store.terminalSession("term-crash")).toMatchObject({
      exitedAt: "2026-11-21T09:00:00.000Z",
    });
    store.close();
  });

  it("updateTerminalSession 目标不存在静默忽略（与 updateSubagent 同语义）", () => {
    const store = createSqliteTaskStore(":memory:");
    expect(() =>
      store.updateTerminalSession("missing", { status: "exited" })
    ).not.toThrow();
    store.close();
  });

  it("任务清单按创建顺序返回，未知任务返回空数组", () => {
    const store = createSqliteTaskStore(":memory:");
    store.insertTask(taskRecord());
    store.insertTerminalSession(
      runningRecord({
        sessionId: "term-a",
        createdAt: "2026-11-21T08:00:01.000Z",
      })
    );
    store.insertTerminalSession(
      runningRecord({
        sessionId: "term-b",
        name: "git-bash · 2",
        createdAt: "2026-11-21T08:00:02.000Z",
      })
    );
    expect(
      store.listTerminalSessions("task-1").map((r) => r.sessionId)
    ).toEqual(["term-a", "term-b"]);
    expect(store.listTerminalSessions("missing")).toEqual([]);
    store.close();
  });

  it("removeProject 级联清理：项目移除时 terminal_sessions 行随任务数据一并删除", () => {
    const store = createSqliteTaskStore(":memory:");
    const project = {
      id: "project-1",
      name: "demo",
      workspacePath: "C:\\work\\demo",
      pinned: false,
      collapsed: false,
      createdAt: "2026-11-21T08:00:00.000Z",
    };
    store.insertProject(project);
    store.insertTask(taskRecord({ id: "task-1", projectId: "project-1" }));
    store.insertTerminalSession(runningRecord());
    store.removeProject("project-1");
    expect(store.listTerminalSessions("task-1")).toEqual([]);
    expect(store.terminalSession("term-1")).toBeNull();
    store.close();
  });

  it("TaskManager.terminalSessions：恢复快照一次读出（view 并行字段数据面）", () => {
    const dbPath = tempDbPath();
    const first = createSqliteTaskStore(dbPath);
    first.insertTask(taskRecord());
    first.insertTerminalSession(runningRecord({ sessionId: "term-live" }));
    first.updateTerminalSession("term-live", {
      status: "exited",
      exitedAt: "2026-11-21T08:01:00.000Z",
      exitCode: 0,
      snapshot: "重启前最后一次输出的尾部",
    });
    first.close();
    // 等价重启：新 manager 从库读恢复快照（不经内存注册表）
    const reopened = createSqliteTaskStore(dbPath);
    const manager = createTaskManager({ persistence: reopened });
    const rows = manager.terminalSessions("task-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "term-live",
      status: "exited",
      snapshot: "重启前最后一次输出的尾部",
    });
    expect(manager.terminalSessions("missing")).toEqual([]);
    reopened.close();
  });
});

describe("terminal_sessions 标题列（标题功能轮）", () => {
  it("标题随 exit patch 落库：关库重开读回 OSC 动态值 / 用户改名；旧行 NULL 读回缺省", () => {
    const dbPath = tempDbPath();
    const store = createSqliteTaskStore(dbPath);
    store.insertTask(taskRecord());
    // 骨架行无标题 → 读回无 title 字段（回退 name 呈现）
    store.insertTerminalSession(runningRecord());
    store.updateTerminalSession("term-1", {
      status: "exited",
      exitedAt: "2026-11-21T08:01:00.000Z",
      exitCode: 0,
      snapshot: "output",
      title: "部署终端",
      titleSource: "user",
    });
    store.close();
    const reopened = createSqliteTaskStore(dbPath);
    const rows = reopened.listTerminalSessions("task-1");
    expect(rows[0]).toMatchObject({
      sessionId: "term-1",
      title: "部署终端",
      titleSource: "user",
      status: "exited",
    });
    reopened.close();

    // 无标题的会话（OSC 未发过、未改名）：读回 title/titleSource 缺省
    const plain = createSqliteTaskStore(":memory:");
    plain.insertTask(taskRecord());
    plain.insertTerminalSession(runningRecord({ sessionId: "term-2" }));
    const row = plain.listTerminalSessions("task-1")[0]!;
    expect(row.title).toBeUndefined();
    expect(row.titleSource).toBeUndefined();
    plain.close();
  });
});
