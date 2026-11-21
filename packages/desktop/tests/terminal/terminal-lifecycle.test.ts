import { describe, expect, it } from "vitest";

import { type TaskRecord } from "@codexlike/agent-core";
import {
  createSqliteTaskStore,
  createTerminalSessionManager,
  type PtyExitEvent,
  type PtyPort,
  type PtyProcess,
  type PtySpawnRequest,
} from "@codexlike/agent-core/node";

import {
  aliveSessionCount,
  closeTaskSessions,
  persistExitedSessionSnapshots,
  recordTerminalSessionEvent,
  settleTerminalSessionRowsOnStartup,
  settleTerminalSessionsOnStartup,
} from "../../src/terminal/terminal-lifecycle";

/**
 * 终端会话生命周期硬边的宿主侧组合件（ADR 0033 票07，fake pty 驱动）：
 * 存活计数（退出屏障「N 个终端会话将关闭」与归档确认卡共用口径）、
 * closeTaskSessions（任务归档「先杀后归档」的第一步，顺手闭合 03 票
 * 「任务移除后 terminal-exited 事件无现场静默丢弃」的未决口——杀会话
 * 发生在归档写入前，事件现场完整）、settleTerminalSessionsOnStartup
 * （重启收尾：注册表清空，UI 无幽灵会话）。
 */

/** fake PtyPort：记录每次 spawn，产出可控 fake 进程（与 terminal-session-ipc 测试同款） */
function createFakePort(options?: { autoExitOnKill?: boolean }) {
  const autoExitOnKill = options?.autoExitOnKill ?? true;
  interface FakePtyRecord {
    request: PtySpawnRequest;
    written: string[];
    killed: boolean;
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
        written: [],
        killed: false,
        exited: false,
        emitData(text) {
          for (const listener of [...dataListeners]) listener(text);
        },
        exit(event = { exitCode: 0 }) {
          if (record.exited) return;
          record.exited = true;
          for (const listener of [...exitListeners]) listener(event);
        },
      };
      records.push(record);
      const process: PtyProcess = {
        pid: 4000 + records.length,
        write(data) {
          record.written.push(data);
        },
        resize() {},
        kill() {
          record.killed = true;
          // 真实 pty 语义（02 票适配器保证 kill 后死透）：kill 后 exit 事件到达
          if (autoExitOnKill) record.exit({ exitCode: 0 });
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

/** 造一个注入小 killAllTimeoutMs 的管理器（防测试吃满 2s 兜底） */
function makeManager(options?: { autoExitOnKill?: boolean }) {
  const { port, records } = createFakePort(options);
  const manager = createTerminalSessionManager({ port, killAllTimeoutMs: 50 });
  return { manager, records };
}

function spawn(
  manager: ReturnType<typeof createTerminalSessionManager>,
  taskId: string
) {
  const outcome = manager.spawn({
    taskId,
    shell: "git-bash",
    origin: "user",
    cwd: "C:\\work\\demo",
  });
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.sessionId;
}

/** 驱动 fake 进程的 exit 事件把会话推到终态（kill 不直接置终态，先行调用 manager.kill） */
function exitSession(record: {
  exit(event?: { exitCode: number; signal?: number }): void;
}) {
  record.exit({ exitCode: 0 });
}

/** 最小合法任务记录（terminal_sessions 有 tasks 外键，terminal 行先行落父行） */
function taskRow(id = "task-1"): TaskRecord {
  return {
    id,
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
  };
}

describe("aliveSessionCount：存活会话计数（退出屏障与归档确认共用口径）", () => {
  it("只计 running：已退出会话不计入", () => {
    const { manager, records } = makeManager();
    spawn(manager, "task-1");
    const exited = spawn(manager, "task-1"); // records[1]
    manager.kill(exited);
    exitSession(records[1]!);

    expect(aliveSessionCount(manager, ["task-1"])).toBe(1);
  });

  it("跨任务求和：全局口径为各现存任务存活数之和", () => {
    const { manager } = makeManager();
    spawn(manager, "task-1");
    spawn(manager, "task-1");
    spawn(manager, "task-2");

    expect(aliveSessionCount(manager, ["task-1", "task-2"])).toBe(3);
    expect(aliveSessionCount(manager, ["task-1"])).toBe(2);
    expect(aliveSessionCount(manager, [])).toBe(0);
  });
});

describe("closeTaskSessions：任务归档的先杀后归档第一步", () => {
  it("终止任务全部存活会话并等待各自 exit 后 resolve", async () => {
    const { manager, records } = makeManager();
    const a = spawn(manager, "task-1");
    const b = spawn(manager, "task-1");
    const other = spawn(manager, "task-2");

    const exited: string[] = [];
    const unsubscribe = manager.onEvent((event) => {
      if (event.kind === "terminal-exited") exited.push(event.record.sessionId);
    });

    await closeTaskSessions(manager, "task-1", { timeoutMs: 200 });

    // 该任务的两个会话都被 kill 且 exit 事件先于 resolve 推进（归档前现场完整，
    // 03 票未决口闭合）；其他任务的会话不受牵连
    expect(exited.sort()).toEqual([a, b].sort());
    expect(manager.session(a)?.status).toBe("exited");
    expect(manager.session(b)?.status).toBe("exited");
    expect(manager.session(other)?.status).toBe("running");
    unsubscribe();
  });

  it("任务无存活会话时立即返回（幂等可重入）", async () => {
    const { manager } = makeManager();
    await closeTaskSessions(manager, "task-empty");
    await closeTaskSessions(manager, "task-empty");
  });

  it("进程从不发 exit 时按兜底超时放行，不阻塞归档", async () => {
    const { manager } = makeManager({ autoExitOnKill: false });
    spawn(manager, "task-1"); // fake 进程收到 kill 但不发 exit

    const startedAt = Date.now();
    await closeTaskSessions(manager, "task-1", { timeoutMs: 30 });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

describe("settleTerminalSessionsOnStartup：重启收尾", () => {
  it("注册表清空：存活会话先按已退出收尾、已退出会话 discard，list-for 无残留", async () => {
    const { manager, records } = makeManager();
    const running = spawn(manager, "task-1"); // records[0]
    const exited = spawn(manager, "task-1"); // records[1]
    manager.kill(exited);
    exitSession(records[1]!);

    await settleTerminalSessionsOnStartup(manager, ["task-1"]);

    expect(manager.sessionsFor("task-1")).toEqual([]);
    // 存活会话在收尾中被 kill 后按已退出收尾再 discard（注册表全空——
    // session() 已查不到；正常重启时注册表为空，此步是防御性收尾）
    expect(manager.session(running)).toBeUndefined();
    expect(records[0]!.killed).toBe(true);
  });

  it("空注册表（正常重启形态）no-op 立即返回", async () => {
    const { manager } = makeManager();
    await settleTerminalSessionsOnStartup(manager, ["task-1"]);
    expect(manager.sessionsFor("task-1")).toEqual([]);
  });
});

/**
 * 快照落库三组合件（ADR 0033 票 08，main.ts 三处挂点的实现本体）：
 * recordTerminalSessionEvent（manager.onEvent → 表行的落库桥：spawn 即写
 * 骨架、exit 推进终态+快照）、persistExitedSessionSnapshots（退出屏障
 * flush：killAll 返回后逐条推进，app.quit 关库前兜底）、
 * settleTerminalSessionRowsOnStartup（重启收尾库层衔接：残留 running 行
 * 置终态，UI 从库读之前完成）。
 */
describe("recordTerminalSessionEvent：落库桥（spawn 即写骨架 / exit 推进终态快照）", () => {
  it("terminal-started 即写 running 骨架行（进程中途被杀也有「曾开过」留痕）", () => {
    const store = createSqliteTaskStore(":memory:");
    store.insertTask(taskRow());
    const { manager } = makeManager();
    const sessionId = spawn(manager, "task-1");
    // 与生产装配同序：桥在会话可 spawn 之前注册（started 事件即发），
    // 这里直接驱动一条 started 事件
    const started = manager.session(sessionId);
    recordTerminalSessionEvent(store, {
      kind: "terminal-started",
      record: started!,
    });
    const row = store.terminalSession(sessionId);
    expect(row).toMatchObject({
      sessionId,
      taskId: "task-1",
      status: "running",
      createdAt: started!.createdAt,
    });
    expect(row?.exitedAt).toBeUndefined();
    expect(row?.snapshot).toBeUndefined();
    store.close();
  });

  it("terminal-exited 推进终态并写入定格快照（exitCode/signal 缺省容忍）", () => {
    const store = createSqliteTaskStore(":memory:");
    store.insertTask(taskRow());
    const { manager, records } = makeManager();
    // 桥先于 spawn 注册（生产装配同序）：started 即写骨架行，exit 推进终态
    manager.onEvent((event) => recordTerminalSessionEvent(store, event));
    const sessionId = spawn(manager, "task-1");
    records[0]!.emitData("构建日志第一行\n");
    records[0]!.emitData("构建日志最后一行\n");
    manager.kill(sessionId); // fake port kill 后自动 exit（exit 齐全语义）

    const row = store.terminalSession(sessionId);
    expect(row?.status).toBe("exited");
    expect(row?.exitedAt).not.toBeUndefined();
    expect(row?.exitCode).toBe(0);
    expect(row?.snapshot).toContain("构建日志最后一行");
    store.close();
  });
});

describe("persistExitedSessionSnapshots：退出屏障 flush 快照落库", () => {
  it("killAll 返回后逐条把 exited 记录推进落库（桥漏写的行由 flush 兜底，幂等）", () => {
    const store = createSqliteTaskStore(":memory:");
    store.insertTask(taskRow());
    const { manager, records } = makeManager();
    // 骨架行由 spawn 即写（生产装配桥保证）；本测试手动落骨架行，
    // 会话 exit 不经桥——模拟「事件桥漏写」的行，由 flush 兜底推进
    const done = spawn(manager, "task-1"); // records[0]
    const missed = spawn(manager, "task-1"); // records[1]
    for (const sessionId of [done, missed]) {
      recordTerminalSessionEvent(store, {
        kind: "terminal-started",
        record: manager.session(sessionId)!,
      });
    }
    manager.kill(done);
    exitSession(records[0]!);
    manager.kill(missed);
    exitSession(records[1]!);

    persistExitedSessionSnapshots(store, manager, ["task-1"]);

    const snapshotOf = (sessionId: string) =>
      store.terminalSession(sessionId)?.snapshot;
    expect(store.terminalSession(done)).toMatchObject({ status: "exited" });
    expect(store.terminalSession(missed)).toMatchObject({
      status: "exited",
      exitedAt: manager.session(missed)?.exitedAt,
      exitCode: 0,
    });
    expect(snapshotOf(missed)).toBe(manager.session(missed)?.snapshot);
    // 幂等：重复 flush 不产生副作用（同值重写）
    persistExitedSessionSnapshots(store, manager, ["task-1"]);
    expect(snapshotOf(missed)).toBe(manager.session(missed)?.snapshot);
    store.close();
  });

  it("只推进现存任务的 exited 记录：running 会话与未知任务的清单不落快照", () => {
    const store = createSqliteTaskStore(":memory:");
    store.insertTask(taskRow());
    const { manager, records } = makeManager();
    const alive = spawn(manager, "task-1"); // records[0]
    persistExitedSessionSnapshots(store, manager, ["task-1"]);
    expect(store.terminalSession(alive)).toBeNull();
    // 已退出会话但任务清单不含其归属（孤儿）：不推进（行已随任务删除）
    const orphan = spawn(manager, "task-gone"); // records[1]
    manager.kill(orphan);
    exitSession(records[1]!);
    persistExitedSessionSnapshots(store, manager, ["task-1"]);
    expect(store.terminalSession(orphan)).toBeNull();
    store.close();
  });
});

describe("settleTerminalSessionRowsOnStartup：重启收尾库层衔接", () => {
  it("残留 running 行按收尾时刻置终态（exitCode/快照缺省），在 UI 从库读之前完成", () => {
    const store = createSqliteTaskStore(":memory:");
    store.insertTask(taskRow());
    recordTerminalSessionEvent(store, {
      kind: "terminal-started",
      record: {
        sessionId: "term-crash",
        taskId: "task-1",
        name: "git-bash · 1",
        shell: "git-bash",
        origin: "agent",
        status: "running",
        createdAt: "2026-11-21T08:00:00.000Z",
      },
    });
    settleTerminalSessionRowsOnStartup(store, "2026-11-21T09:00:00.000Z");
    const row = store.terminalSession("term-crash");
    expect(row).toMatchObject({
      status: "exited",
      exitedAt: "2026-11-21T09:00:00.000Z",
    });
    expect(row?.exitCode).toBeUndefined();
    expect(row?.signal).toBeUndefined();
    expect(row?.snapshot).toBeUndefined();
    store.close();
  });
});
