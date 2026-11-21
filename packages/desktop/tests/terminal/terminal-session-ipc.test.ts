import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import {
  createTerminalSessionManager,
  type PtyExitEvent,
  type PtyPort,
  type PtyProcess,
  type PtySpawnRequest,
} from "@codexlike/agent-core/node";
import type { BrowserWindow } from "electron";
import type { TerminalSessionRecord } from "@codexlike/agent-core";

import {
  IPC,
  type TerminalSessionDataPayload,
  type TaskEventEnvelope,
} from "../../src/shared/ipc";
import { registerTerminalSessionHandlers } from "../../src/terminal/terminal-session-ipc";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
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

/** fake PTY 进程记录：spawn 请求、写入、resize、kill 与可控输出/退出 */
interface FakePtyRecord {
  request: PtySpawnRequest;
  written: string[];
  resized: { cols: number; rows: number }[];
  killed: boolean;
  emitData(text: string): void;
  exit(event?: { exitCode: number; signal?: number }): void;
}

/** fake PtyPort：记录每次 spawn，产出可控 fake 进程（绝不触 node-pty 真件） */
function createFakePort() {
  const records: FakePtyRecord[] = [];
  const port: PtyPort = {
    spawn(request) {
      const dataListeners: ((data: string) => void)[] = [];
      const exitListeners: ((event: PtyExitEvent) => void)[] = [];
      const record: FakePtyRecord = {
        request,
        written: [],
        resized: [],
        killed: false,
        emitData(text) {
          for (const listener of [...dataListeners]) listener(text);
        },
        exit(event = { exitCode: 0 }) {
          for (const listener of [...exitListeners]) listener(event);
        },
      };
      records.push(record);
      const process: PtyProcess = {
        pid: 4000 + records.length,
        write(data) {
          record.written.push(data);
        },
        resize(size) {
          record.resized.push(size);
        },
        kill() {
          record.killed = true;
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

async function setup(options?: {
  shell?: string;
  env?: Record<string, string>;
  /** 恢复兜底查询（票 08）：内存注册表无此会话时 subscribe 从库行取快照回放 */
  restoredSession?: (sessionId: string) => TerminalSessionRecord | null;
}) {
  const root = mkdtempSync(join(tmpdir(), "terminal-session-ipc-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "project");
  const { port, records } = createFakePort();
  let sessionSeq = 0;
  const sessions = createTerminalSessionManager({
    port,
    generateId: () => `session-${(sessionSeq += 1)}`,
    // fake 端口的 kill 不合成交付 exit（由用例显式驱动）；killAll 兜底超时
    // 放小，afterEach 清理不被 2s 默认兜底拖慢
    killAllTimeoutMs: 10,
  });
  cleanup.push(() => sessions.killAll());
  /** 主窗口收到的 send（channel, payload），按顺序记录 */
  const sends: { channel: string; payload: unknown }[] = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => {
        sends.push({ channel, payload: structuredClone(payload) });
      },
    },
  } as unknown as BrowserWindow;
  /** pushTaskEvent 桥的记录（本文件只验证映射，白名单行为归 live-tasks 集成测试） */
  const pushed: {
    taskId: string;
    event: Extract<
      TaskEventEnvelope["event"],
      {
        type: "terminal-started" | "terminal-exited" | "terminal-title-changed";
      }
    >;
  }[] = [];
  let shellSetting = options?.shell ?? "git-bash";
  registerTerminalSessionHandlers({
    sessions,
    workspaceFor: (taskId) => (taskId === "task-1" ? workspace : null),
    shell: () => shellSetting as "git-bash",
    env:
      options?.env ??
      ({ PATH: "/usr/bin", HOME: "/home/u", SECRET_TOKEN: "leak-me" } as Record<
        string,
        string
      >),
    restoredSession: options?.restoredSession,
    getWindow: () => window,
    pushTaskEvent: (taskId, event) => {
      // 桥契约收口：终端 IPC 只应下发 terminal-* 事件
      if (
        event.type !== "terminal-started" &&
        event.type !== "terminal-exited" &&
        event.type !== "terminal-title-changed"
      ) {
        throw new Error(`意外的任务事件：${event.type}`);
      }
      pushed.push({ taskId, event });
    },
  });
  return {
    workspace,
    records,
    sessions,
    sends,
    pushed,
    setShell(next: string) {
      shellSetting = next;
    },
  };
}

function dataPayloads(sends: { channel: string; payload: unknown }[]) {
  return sends.filter(
    (item): item is { channel: string; payload: TerminalSessionDataPayload } =>
      item.channel === IPC.terminals.sessionData
  );
}

function taskEvents(sends: { channel: string; payload: unknown }[]) {
  return sends.filter(
    (item): item is { channel: string; payload: TaskEventEnvelope } =>
      item.channel === IPC.taskEvents
  );
}

it("创建会话强制 cwd 为任务工作区、shell 跟随执行设置、env 走白名单", async () => {
  const app = await setup({
    env: { PATH: "/usr/bin", HOME: "/home/u", SECRET_TOKEN: "leak-me" },
  });
  const result = invoke(IPC.terminals.create, { taskId: "task-1" }) as {
    ok: boolean;
    sessionId?: string;
    reason?: string;
  };
  expect(result).toEqual({ ok: true, sessionId: "session-1" });
  expect(app.records).toHaveLength(1);
  const request = app.records[0]!.request;
  // cwd 一律任务工作区（ADR 0004）：IPC 面根本不接受 cwd 参数
  expect(request.cwd).toBe(app.workspace);
  expect(request.shell).toBe("git-bash");
  // origin 记录在管理器记录层（端口请求不带来源标记）
  expect(app.sessions.session("session-1")).toMatchObject({
    origin: "user",
    status: "running",
  });
  // env 白名单过滤：基础项透传、非白名单（密钥类）不进 PTY 子进程
  expect(request.env).toMatchObject({ PATH: "/usr/bin", HOME: "/home/u" });
  expect(request.env["SECRET_TOKEN"]).toBeUndefined();
  // 用户手开不带初始命令
  expect(request.initialCommand).toBeUndefined();

  // shell resolver 逐次解析：设置页保存后对下一次创建即时生效
  app.setShell("powershell");
  invoke(IPC.terminals.create, { taskId: "task-1" });
  expect(app.records[1]!.request.shell).toBe("powershell");

  // 任务不存在：中文异常抛回渲染进程
  expect(() => invoke(IPC.terminals.create, { taskId: "missing" })).toThrow(
    "任务不存在"
  );
  expect(() => invoke(IPC.terminals.create, { taskId: "" })).toThrow("taskId");
});

it("字节流三段式：订阅携缓冲回放，实时输出走专用通道，退订即停", async () => {
  const app = await setup();
  const { sessionId } = invoke(IPC.terminals.create, {
    taskId: "task-1",
  }) as { ok: true; sessionId: string };

  // 订阅前已有输出：进缓冲但不转发（01 票衔接——onSessionData 只转发订阅后输出）
  app.records[0]!.emitData("pre$ ");
  expect(dataPayloads(app.sends)).toHaveLength(0);

  // 订阅：返回记录副本与缓冲全量（初始回放数据源），不推读取水位
  const subscribed = invoke(IPC.terminals.subscribe, sessionId) as {
    ok: boolean;
    sessionId?: string;
    record?: { sessionId: string; status: string };
    buffered?: string;
    reason?: string;
  };
  expect(subscribed.ok).toBe(true);
  expect(subscribed.sessionId).toBe(sessionId);
  expect(subscribed.record).toMatchObject({ sessionId, status: "running" });
  expect(subscribed.buffered).toBe("pre$ ");

  // 实时输出经专用通道直写渲染端（不进 taskEvents）
  app.records[0]!.emitData("ls\r\n");
  const live = dataPayloads(app.sends);
  expect(live).toHaveLength(1);
  expect(live[0]!.payload).toEqual({ sessionId, data: "ls\r\n" });
  expect(taskEvents(app.sends)).toHaveLength(0);

  // 重复订阅幂等：不叠加转发（否则 xterm 收到重复字节）
  invoke(IPC.terminals.subscribe, sessionId);
  app.records[0]!.emitData("second\n");
  expect(dataPayloads(app.sends)).toHaveLength(2);
  expect(dataPayloads(app.sends)[1]!.payload).toEqual({
    sessionId,
    data: "second\n",
  });

  // 退订：转发停止，缓冲继续累积（再次订阅回放仍在）
  invoke(IPC.terminals.unsubscribe, sessionId);
  app.records[0]!.emitData("after-unsub\n");
  expect(dataPayloads(app.sends)).toHaveLength(2);
  const resubscribed = invoke(IPC.terminals.subscribe, sessionId) as {
    ok: boolean;
    buffered?: string;
  };
  expect(resubscribed.buffered).toBe("pre$ ls\r\nsecond\nafter-unsub\n");

  // 不存在的会话：明确拒绝
  expect(invoke(IPC.terminals.subscribe, "nope")).toMatchObject({
    ok: false,
  });
});

/**
 * 恢复回看兜底（ADR 0033 票 08）：重启后内存注册表为空，已退出会话只在
 * terminal_sessions 表——subscribe 按现路径最小接通：注册表未命中时查库行，
 * 快照作为 buffered 回放喂给 xterm（record.snapshot 不进 React 状态，
 * TerminalSessionView 的 subscribe buffered 路径不变）。
 */
it("恢复会话 subscribe 兜底：注册表未命中时从库行取快照回放，库行也没有维持拒绝", async () => {
  const restored = {
    sessionId: "term-restored",
    taskId: "task-1",
    name: "git-bash · 1",
    shell: "git-bash" as const,
    origin: "user" as const,
    status: "exited" as const,
    createdAt: "2026-11-21T08:00:00.000Z",
    exitedAt: "2026-11-21T08:05:00.000Z",
    exitCode: 0,
    snapshot: "重启前的输出尾部\n",
  };
  const app = await setup({
    restoredSession: (sessionId: string) =>
      sessionId === "term-restored" ? restored : null,
  });

  // 注册表无此会话：兜底查库行，快照作为 buffered 回放，record 为库行终态
  const result = invoke(IPC.terminals.subscribe, "term-restored") as {
    ok: boolean;
    sessionId?: string;
    record?: { status: string; snapshot?: string };
    buffered?: string;
    reason?: string;
  };
  expect(result.ok).toBe(true);
  expect(result.sessionId).toBe("term-restored");
  expect(result.record).toMatchObject({
    status: "exited",
    exitedAt: restored.exitedAt,
  });
  expect(result.buffered).toBe("重启前的输出尾部\n");

  // 兜底订阅不登记实时转发（已退出会话无实时字节），退订幂等无副作用
  invoke(IPC.terminals.unsubscribe, "term-restored");
  expect(dataPayloads(app.sends)).toHaveLength(0);

  // 库行也不存在（会话既不在注册表也不在库）：维持原拒绝
  expect(invoke(IPC.terminals.subscribe, "nope")).toMatchObject({
    ok: false,
  });

  // 缺省容忍：置终态但快照缺省的行（崩溃残留）回放空缓冲
  const appNoSnapshot = await setup({
    restoredSession: (sessionId: string) =>
      sessionId === "term-crash"
        ? { ...restored, sessionId: "term-crash", snapshot: undefined }
        : null,
  });
  const crashed = invoke(IPC.terminals.subscribe, "term-crash") as {
    ok: boolean;
    buffered?: string;
  };
  expect(crashed.ok).toBe(true);
  expect(crashed.buffered).toBe("");
  expect(appNoSnapshot.records).toHaveLength(0);
});

it("输入写入 PTY，kill 终止进程树，退出事件经 pushTaskEvent 桥接", async () => {
  const app = await setup();
  const { sessionId } = invoke(IPC.terminals.create, {
    taskId: "task-1",
  }) as { ok: true; sessionId: string };

  expect(invoke(IPC.terminals.write, sessionId, "echo hi\r")).toEqual({
    ok: true,
  });
  expect(app.records[0]!.written).toEqual(["echo hi\r"]);

  // terminal-started → pushTaskEvent（record 为当时完整副本）
  expect(app.pushed).toHaveLength(1);
  expect(app.pushed[0]).toMatchObject({
    taskId: "task-1",
    event: {
      type: "terminal-started",
      record: {
        sessionId,
        taskId: "task-1",
        origin: "user",
        status: "running",
      },
    },
  });

  expect(invoke(IPC.terminals.kill, sessionId)).toEqual({ ok: true });
  expect(app.records[0]!.killed).toBe(true);

  // 进程真实退出（kill 路径的 exit 由适配器保证）：终态事件 + 快照定格
  app.records[0]!.exit({ exitCode: 137 });
  await vi.waitFor(() => expect(app.pushed).toHaveLength(2));
  expect(app.pushed[1]).toMatchObject({
    taskId: "task-1",
    event: {
      type: "terminal-exited",
      record: { sessionId, status: "exited", exitCode: 137 },
    },
  });
  expect(app.pushed[1]!.event.record.snapshot).toBeDefined();

  // 退出后的 write/kill：明确拒绝（中文 reason），resize 静默
  expect(invoke(IPC.terminals.write, sessionId, "again\r")).toMatchObject({
    ok: false,
  });
  expect(invoke(IPC.terminals.kill, sessionId)).toMatchObject({ ok: false });
  expect(() =>
    invoke(IPC.terminals.resize, sessionId, { cols: 100, rows: 30 })
  ).not.toThrow();
  expect(app.records[0]!.resized).toHaveLength(0);
});

it("resize 透传 PTY，非法尺寸在边界拒绝，不存在会话静默", async () => {
  const app = await setup();
  const { sessionId } = invoke(IPC.terminals.create, {
    taskId: "task-1",
  }) as { ok: true; sessionId: string };
  invoke(IPC.terminals.resize, sessionId, { cols: 120, rows: 40 });
  expect(app.records[0]!.resized).toEqual([{ cols: 120, rows: 40 }]);
  // 不存在的会话：静默无异常（渲染端无需防御，01 票口径）
  expect(() =>
    invoke(IPC.terminals.resize, "nope", { cols: 80, rows: 24 })
  ).not.toThrow();
  // 参数不合法：中文异常
  expect(() =>
    invoke(IPC.terminals.resize, sessionId, { cols: "wide", rows: 40 })
  ).toThrow("resize");
});

it("session/listFor 提供快照段：单会话与任务内清单（含已退出）", async () => {
  const app = await setup();
  const a = invoke(IPC.terminals.create, { taskId: "task-1" }) as {
    ok: true;
    sessionId: string;
  };
  const b = invoke(IPC.terminals.create, { taskId: "task-1" }) as {
    ok: true;
    sessionId: string;
  };
  // 默认名「shell 类型 · 任务内序号」
  expect(invoke(IPC.terminals.session, a.sessionId)).toMatchObject({
    sessionId: a.sessionId,
    name: "git-bash · 1",
    taskId: "task-1",
  });
  expect(invoke(IPC.terminals.session, "nope")).toBeNull();
  const list = invoke(IPC.terminals.listFor, "task-1") as {
    sessionId: string;
  }[];
  expect(list.map((item) => item.sessionId)).toEqual([
    a.sessionId,
    b.sessionId,
  ]);
  expect(() => invoke(IPC.terminals.listFor, "")).toThrow("listFor");
  expect(() => invoke(IPC.terminals.session, 42)).toThrow("session");

  // 退出后仍在清单（快照回看，重启不恢复由 08 票落库）
  app.records[0]!.exit({ exitCode: 0 });
  await vi.waitFor(() =>
    expect(
      (invoke(IPC.terminals.listFor, "task-1") as { status: string }[])[0]!
        .status
    ).toBe("exited")
  );
});

it("改名与 OSC 标题（标题功能轮）：rename 生效、标题变化桥接 terminal-title-changed", async () => {
  const app = await setup();
  const { sessionId } = invoke(IPC.terminals.create, {
    taskId: "task-1",
  }) as { ok: true; sessionId: string };

  // OSC 0 标题到达 → record.title 更新（source=auto）→ 桥接 title-changed
  app.records[0]!.emitData("\u001b]0;MINGW64:/tmp\u0007");
  const bridged = app.pushed.filter(
    (item) => item.event.type === "terminal-title-changed"
  );
  expect(bridged).toHaveLength(1);
  expect(bridged[0]!.event.record).toMatchObject({
    sessionId,
    title: "MINGW64:/tmp",
    titleSource: "auto",
  });
  // 用户改名 → source=user，此后 OSC 不再覆盖
  expect(invoke(IPC.terminals.rename, sessionId, "  部署终端  ")).toEqual({
    ok: true,
  });
  expect(app.sessions.session(sessionId)).toMatchObject({
    title: "部署终端",
    titleSource: "user",
  });
  app.records[0]!.emitData("\u001b]0;MINGW64:/other\u0007");
  expect(app.sessions.session(sessionId)).toMatchObject({
    title: "部署终端",
  });
  // 改名后桥接仍逐次下发（rail 列表呈现跟随）
  expect(
    app.pushed.filter((item) => item.event.type === "terminal-title-changed")
  ).toHaveLength(2);

  // 拒绝面：空串 / 会话不存在（中文 reason 原样返回）
  expect(invoke(IPC.terminals.rename, sessionId, "   ")).toMatchObject({
    ok: false,
  });
  expect(invoke(IPC.terminals.rename, "no-such", "x")).toMatchObject({
    ok: false,
  });
  // 参数不合法：中文异常抛回渲染进程
  expect(() => invoke(IPC.terminals.rename, sessionId, 42)).toThrow("标题");
  expect(() => invoke(IPC.terminals.rename, "", "x")).toThrow("sessionId");
});
