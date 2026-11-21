import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import {
  createAgentResourceSnapshot,
  createBuiltinTools,
  createTaskManager,
  createSqliteTaskStore,
  createTerminalSessionManager,
  createWorktreeService,
  type PtyExitEvent,
  type PtyPort,
  type PtyProcess,
  type PtySpawnRequest,
} from "@codexlike/agent-core/node";
import type { BrowserWindow } from "electron";
import type { TaskEventEnvelope } from "../../src/shared/ipc";
import { registerTaskHandlers } from "../../src/tasks/task-ipc";
import { listenMock } from "../tasks/mock-server";
import { createProfileStore } from "../../src/profiles/profile-store";
import { registerTerminalSessionHandlers } from "../../src/terminal/terminal-session-ipc";

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

function invoke(channel: string, ...args: unknown[]): any {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`未注册通道 ${channel}`);
  return handler({}, ...args);
}
const waitFor = (check: () => unknown) => vi.waitFor(check, { timeout: 4000 });

/** fake PtyPort：同 terminal-session-ipc.test.ts（kill 由用例显式 exit） */
function createFakePort() {
  const records: {
    request: PtySpawnRequest;
    killed: boolean;
    emitData(text: string): void;
    exit(event?: { exitCode: number }): void;
  }[] = [];
  const port: PtyPort = {
    spawn(request) {
      const dataListeners: ((data: string) => void)[] = [];
      const exitListeners: ((event: PtyExitEvent) => void)[] = [];
      const record = {
        request,
        killed: false,
        emitData(text: string) {
          for (const listener of [...dataListeners]) listener(text);
        },
        exit(event = { exitCode: 0 }) {
          for (const listener of [...exitListeners]) listener(event);
        },
      };
      records.push(record);
      const process: PtyProcess = {
        pid: 4000 + records.length,
        write: () => {},
        resize: () => {},
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

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "terminal-events-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "project");
  mkdirSync(workspace);
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
      encryptString: async (text) => Buffer.from(text),
      decryptString: async (bytes) => bytes.toString(),
    },
  });
  const responses = new Map<string, ServerResponse>();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      const messages = JSON.parse(body).messages;
      const text = messages.findLast(
        (message: any) => message.role === "user"
      ).content;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      responses.set(text, res);
    });
  });
  const mockPort = await listenMock(server);
  cleanup.push(() => {
    server.close();
    server.closeAllConnections();
  });
  const profile = await profiles.create({
    name: "可控模型",
    models: ["mock"],
    apiKey: "test",
    baseURL: `http://127.0.0.1:${mockPort}/v1`,
  });
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
  const taskRuntime = registerTaskHandlers({
    manager,
    profiles,
    getWindow: () => window,
    dataDir: root,
    worktreeService: createWorktreeService({
      worktreesDir: join(root, "worktrees"),
    }),
    resourcesFor,
  });
  cleanup.push(async () => {
    for (const task of manager.list()) invoke("tasks:interrupt", task.id);
    await waitFor(() =>
      expect(
        manager
          .list()
          .every((task) => !invoke("tasks:execution", task.id).running)
      ).toBe(true)
    );
  });
  const { port, records } = createFakePort();
  let sessionSeq = 0;
  const sessions = createTerminalSessionManager({
    port,
    generateId: () => `session-${(sessionSeq += 1)}`,
    killAllTimeoutMs: 10,
  });
  cleanup.push(() => sessions.killAll());
  // main.ts 同款装配：真桥（taskRuntime.pushTaskEvent）+ 真 workspaceFor
  registerTerminalSessionHandlers({
    sessions,
    workspaceFor: (taskId) => manager.get(taskId)?.record.workspacePath ?? null,
    shell: () => "git-bash",
    getWindow: () => window,
    pushTaskEvent: taskRuntime.pushTaskEvent,
  });
  async function frame(
    text: string,
    delta: unknown,
    finish: string | null = null
  ) {
    await waitFor(() => expect(responses.has(text)).toBe(true));
    const res = responses.get(text)!;
    res.write(
      `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    );
    if (finish) res.end("data: [DONE]\n\n");
  }
  return { manager, profile, workspace, records, sessions, sends, frame };
}

function terminalEnvelopes(sends: { channel: string; payload: unknown }[]) {
  return sends
    .filter((item) => item.channel === "task:events")
    .map((item) => item.payload as TaskEventEnvelope)
    .filter(
      (envelope) =>
        envelope.event.type === "terminal-started" ||
        envelope.event.type === "terminal-exited"
    );
}

it("空闲任务的终端启停事件经 taskEvents 下发（无执行现场延续水位）", async () => {
  const app = await setup();
  // 直接建任务（不跑模型轮）：任务空闲、无执行现场
  const task = app.manager.create({
    workspacePath: app.workspace,
    title: "终端事件任务",
    id: "task-idle",
  });
  const created = invoke("terminals:create", {
    taskId: task.id,
  }) as { ok: true; sessionId: string };
  await waitFor(() => expect(terminalEnvelopes(app.sends)).toHaveLength(1));
  const started = terminalEnvelopes(app.sends)[0]!;
  expect(started.taskId).toBe(task.id);
  expect(started.event).toMatchObject({
    type: "terminal-started",
    record: {
      sessionId: created.sessionId,
      taskId: task.id,
      status: "running",
    },
  });
  // 空闲任务的信封照常携带活动态（非排队非运行）
  expect(started.activity).toMatchObject({
    running: false,
    queued: false,
  });

  // kill → terminal-exited（终态快照随事件携带）
  invoke("terminals:kill", created.sessionId);
  app.records[0]!.exit({ exitCode: 1 });
  await waitFor(() => expect(terminalEnvelopes(app.sends)).toHaveLength(2));
  expect(terminalEnvelopes(app.sends)[1]!.event).toMatchObject({
    type: "terminal-exited",
    record: { sessionId: created.sessionId, status: "exited" },
  });

  // cwd 确实取自任务工作区（真 workspaceFor 缝隙）
  expect(app.records[0]!.request.cwd).toBe(app.workspace);
});

it("已完成任务（终态后）的终端事件照常下发，中断不杀会话（stopped 白名单）", async () => {
  const app = await setup();
  // 正常完成一轮：任务进入终态（terminalAt > 0）
  const a = await invoke("tasks:start", {
    requestId: "done-terminal",
    projectId: null,
    text: "完成任务",
  });
  await app.frame("完成任务", { content: "已完成" }, "stop");
  await waitFor(() =>
    expect(invoke("tasks:execution", a.id).running).toBe(false)
  );
  invoke("terminals:create", { taskId: a.id });
  await waitFor(() => expect(terminalEnvelopes(app.sends)).toHaveLength(1));
  expect(terminalEnvelopes(app.sends)[0]!.event.type).toBe("terminal-started");

  // 运行中中断（stopped = true）：终端会话不被连带终止、事件照常下发
  const b = await invoke("tasks:start", {
    requestId: "stopped-terminal",
    projectId: null,
    text: "中断任务",
  });
  await app.frame("中断任务", { content: "生成中" });
  await waitFor(() =>
    expect(invoke("tasks:execution", b.id).running).toBe(true)
  );
  expect(invoke("tasks:interrupt", b.id)).toBe(true);
  await waitFor(() =>
    expect(invoke("tasks:execution", b.id).running).toBe(false)
  );
  const created = invoke("terminals:create", {
    taskId: b.id,
  }) as { ok: true; sessionId: string };
  await waitFor(() => expect(terminalEnvelopes(app.sends)).toHaveLength(2));
  expect(terminalEnvelopes(app.sends)[1]!.event).toMatchObject({
    type: "terminal-started",
    record: { sessionId: created.sessionId, taskId: b.id },
  });
  // 停止期间字节流照常直写（会话存活的功能起点）：订阅后输出走专用通道
  expect(invoke("terminals:subscribe", created.sessionId)).toMatchObject({
    ok: true,
  });
  app.records[1]!.emitData("still-alive\n");
  await waitFor(() => {
    const payloads = app.sends.filter(
      (item) => item.channel === "terminals:session-data"
    );
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.payload).toEqual({
      sessionId: created.sessionId,
      data: "still-alive\n",
    });
  });

  // 不存在的任务：IPC 边界即拒绝（无 cwd 可解析），不会产生事件
  expect(() => invoke("terminals:create", { taskId: "task-gone" })).toThrow(
    "任务不存在"
  );
  expect(terminalEnvelopes(app.sends)).toHaveLength(2);
});
