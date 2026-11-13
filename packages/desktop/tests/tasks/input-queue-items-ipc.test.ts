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
  createWorktreeService,
} from "@codexlike/agent-core/node";
import type { BrowserWindow } from "electron";
import type { TaskEventEnvelope } from "../../src/shared/ipc";
import { createProfileStore } from "../../src/profiles/profile-store";
import { createSqliteInputQueueStore } from "../../src/tasks/input-queue-store";
import { registerTaskHandlers } from "../../src/tasks/task-ipc";
import { listenMock } from "./mock-server";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
}));
vi.mock("electron", () => ({
  dialog: {},
  ipcMain: {
    handle: (name: string, fn: (...args: any[]) => any) =>
      handlers.set(name, fn),
  },
}));
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  handlers.clear();
});
function invoke(name: string, ...args: unknown[]): any {
  const handler = handlers.get(`sessions:${name}`);
  if (!handler) throw new Error(`未注册通道 sessions:${name}`);
  return handler({}, ...args);
}
const waitFor = (check: () => unknown) => vi.waitFor(check, { timeout: 8000 });

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "queue-items-ipc-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const dbPath = join(root, "nested", "session-workbench.db");
  const persistence = createSqliteTaskStore(dbPath);
  cleanup.push(() => persistence.close());
  const queueStore = createSqliteInputQueueStore(dbPath);
  cleanup.push(() => queueStore.close());
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
  const requests: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      const text = JSON.parse(body).messages.findLast(
        (message: any) => message.role === "user"
      ).content;
      requests.push(text);
      responses.set(text, res);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
    });
  });
  const port = await listenMock(server);
  cleanup.push(() => {
    server.close();
    server.closeAllConnections();
  });
  const profile = await profiles.create({
    name: "可控模型",
    model: "mock",
    apiKey: "test",
    baseURL: `http://127.0.0.1:${port}/v1`,
  });
  const delivered: TaskEventEnvelope[][] = [[], []];
  const windows = delivered.map(
    (events) =>
      ({
        isDestroyed: () => false,
        webContents: {
          send: (_channel: string, event: TaskEventEnvelope) =>
            events.push(structuredClone(event)),
        },
      }) as unknown as BrowserWindow
  );
  registerTaskHandlers({
    manager,
    profiles,
    dataDir: root,
    queueStore,
    resourcesFor,
    getWindow: () => windows[0]!,
    getWindows: () => windows,
    worktreeService: createWorktreeService({
      worktreesDir: join(root, "worktrees"),
    }),
  });
  cleanup.push(async () => {
    for (const session of manager.list()) invoke("interrupt", session.id);
    await waitFor(() =>
      expect(
        manager
          .list()
          .every((session) => !invoke("execution", session.id).running)
      ).toBe(true)
    );
  });
  async function start(text = "首轮") {
    const record = await invoke("start", {
      requestId: crypto.randomUUID(),
      projectId: null,
      text,
    });
    await waitFor(() => expect(responses.has(text)).toBe(true));
    return record.id as string;
  }
  async function finish(text: string) {
    await waitFor(() => expect(responses.has(text)).toBe(true));
    const res = responses.get(text)!;
    res.write(
      `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: { content: "完成" }, finish_reason: "stop" }] })}\n\n`
    );
    res.end("data: [DONE]\n\n");
  }
  async function pause(id: string) {
    invoke("interrupt", id);
    await waitFor(() => expect(invoke("execution", id).running).toBe(false));
  }
  return { profile, start, finish, pause, requests, delivered, dbPath };
}

it("编辑 IPC 原地更新：顺序与快照不动，事件推送全部窗口，消费发出编辑后文本", async () => {
  const app = await setup();
  const id = await app.start();
  await invoke("send", id, "排队甲", app.profile.id);
  await invoke("send", id, "排队乙", app.profile.id);
  const view = invoke("view", id);
  const [first, second] = view.queueState.queue;
  const bad = view.sequence;
  // 身份与参数校验
  expect(() =>
    invoke("queue-update", "missing", first.id, "x", "排队甲")
  ).toThrow(/任务不存在/);
  expect(() => invoke("queue-update", id, 5, "x", "排队甲")).toThrow(
    /条目标识/
  );
  expect(() => invoke("queue-update", id, first.id, "  ", "排队甲")).toThrow(
    /不能为空/
  );
  expect(() => invoke("queue-update", id, first.id, "改", "过期原文")).toThrow(
    /其他窗口/
  );
  expect(() =>
    invoke("queue-update", id, first.id, "改", "排队甲", ["ok.md", 5])
  ).toThrow(/引用/);
  expect(invoke("view", id).queueState.queue).toEqual(view.queueState.queue);

  const result = invoke(
    "queue-update",
    id,
    first.id,
    "排队甲（修订）",
    "排队甲"
  );
  expect(result.queue.map((item: any) => item.text)).toEqual([
    "排队甲（修订）",
    "排队乙",
  ]);
  expect(result.queue[0]).toMatchObject({
    id: first.id,
    position: first.position,
    mentionPaths: [],
    providerProfileId: app.profile.id,
  });
  expect(result.sequence).toBeGreaterThan(bad);
  for (const events of app.delivered) {
    expect(events.at(-1)).toMatchObject({
      taskId: id,
      event: { type: "queue-changed", reason: "update", queue: result.queue },
    });
  }
  const reopened = createSqliteInputQueueStore(app.dbPath);
  try {
    expect(reopened.list(id).map((item) => item.text)).toEqual([
      "排队甲（修订）",
      "排队乙",
    ]);
  } finally {
    reopened.close();
  }

  // 消费发出的是编辑后的文本
  await app.finish("首轮");
  await app.finish("排队甲（修订）");
  await app.finish("排队乙");
  await waitFor(() => expect(invoke("execution", id).running).toBe(false));
  expect(app.requests).toEqual(["首轮", "排队甲（修订）", "排队乙"]);
}, 30_000);

it("迟到保存不复活已取出发送的条目：出队后编辑/删除/重排全部拒绝，事件流含 sending 锁定信号", async () => {
  const app = await setup();
  const id = await app.start();
  await invoke("send", id, "排队甲", app.profile.id);
  const entry = invoke("view", id).queueState.queue[0];

  // 首轮结束 → 甲被取出发送：请求到达但响应保持挂起——本轮未结束，
  // 甲以「正在发出」保留在队列视图中（置顶、锁定、可稳定观察）
  await app.finish("首轮");
  await waitFor(() => expect(app.requests).toContain("排队甲"));
  await waitFor(() =>
    expect(invoke("view", id).queueState.sendingId).toBe(entry.id)
  );
  const duringFlight = invoke("view", id);
  expect(duringFlight.queueState.queue.map((item: any) => item.id)).toEqual([
    entry.id,
  ]);
  // UI 区分信号经事件推送：dequeue 携带锁定 id
  const dequeueEvents = app.delivered[0]!.filter(
    (envelope) =>
      envelope.taskId === id &&
      (envelope.event as any).type === "queue-changed" &&
      (envelope.event as any).reason === "dequeue"
  );
  expect(dequeueEvents.at(-1)).toMatchObject({
    event: { sendingId: entry.id },
  });

  // 主进程强制：已取出发送的条目不能被迟到的编辑/删除/重排复活
  expect(() =>
    invoke("queue-update", id, entry.id, "迟到改写", "排队甲")
  ).toThrow(/不存在|已发出/);
  expect(() => invoke("queue-remove", id, entry.id)).toThrow(/不存在|已发出/);
  expect(() => invoke("queue-reorder", id, [entry.id])).toThrow(/不一致/);
  expect(invoke("view", id).queueState.sendingId).toBe(entry.id);

  // 放行发送：本轮结束后移出视图，队列清空
  await app.finish("排队甲");
  await waitFor(() => expect(invoke("view", id).queueState.queue).toEqual([]));
  await waitFor(() =>
    expect(invoke("view", id).queueState.sendingId).toBeNull()
  );
  await waitFor(() => expect(invoke("execution", id).running).toBe(false));
}, 30_000);

it("重排 IPC：暂停窗口内合法重排生效并持久化，清单不一致拒绝且顺序不变，恢复后按新序消费", async () => {
  const app = await setup();
  const id = await app.start("首轮任务");
  // 首轮进行中入队三条（忙时入队），再停止进入暂停：稳定重排窗口
  await invoke("send", id, "甲", app.profile.id);
  await invoke("send", id, "乙", app.profile.id);
  await invoke("send", id, "丙", app.profile.id);
  await app.pause(id);
  const ids = () =>
    invoke("view", id).queueState.queue.map((item: any) => item.text);
  expect(ids()).toEqual(["甲", "乙", "丙"]);
  expect(invoke("view", id).queueState.paused).toBe(true);
  // 参数校验
  expect(() => invoke("queue-reorder", id, "not-array")).toThrow(/顺序清单/);
  expect(() => invoke("queue-reorder", id, ["x", 5])).toThrow(/顺序清单/);
  expect(() => invoke("queue-reorder", id, ["甲"])).toThrow(/不一致/);
  const view = invoke("view", id);
  const order = view.queueState.queue.map((item: any) => item.id);
  const reordered = [order[2], order[0], order[1]];
  const result = invoke("queue-reorder", id, reordered);
  expect(result.queue.map((item: any) => item.text)).toEqual([
    "丙",
    "甲",
    "乙",
  ]);
  expect(app.delivered[0]!.at(-1)).toMatchObject({
    taskId: id,
    event: { type: "queue-changed", reason: "reorder" },
  });
  // 持久化：另开连接读同一库
  const reopened = createSqliteInputQueueStore(app.dbPath);
  try {
    expect(reopened.list(id).map((item) => item.id)).toEqual(reordered);
  } finally {
    reopened.close();
  }
  // 清单不一致拒绝且顺序不变
  expect(() => invoke("queue-reorder", id, [order[0], order[1]])).toThrow(
    /不一致/
  );
  expect(ids()).toEqual(["丙", "甲", "乙"]);
  // 恢复后按新顺序消费
  invoke("queue-resume", id);
  await app.finish("丙");
  await app.finish("甲");
  await app.finish("乙");
  await waitFor(() => expect(invoke("view", id).queueState.queue).toEqual([]));
  expect(app.requests).toEqual(["首轮任务", "丙", "甲", "乙"]);
}, 30_000);

it("删除 IPC 校验任务/条目身份；空闲暂停时向所有窗口推送权威快照，删除后不消费", async () => {
  const app = await setup();
  const id = await app.start();
  await invoke("send", id, "待删除", app.profile.id);
  await invoke("send", id, "保留", app.profile.id);
  const [removed, kept] = invoke("view", id).queueState.queue;
  await app.pause(id);
  const before = invoke("view", id);
  expect(() => invoke("queue-remove", "missing", removed.id)).toThrow(
    /任务不存在/
  );
  expect(() => invoke("queue-remove", id, 5)).toThrow(/标识/);
  expect(() => invoke("queue-remove", id, "missing")).toThrow(/不存在/);
  const result = invoke("queue-remove", id, removed.id);
  expect(result.queue).toEqual([kept]);
  expect(result.paused).toBe(true);
  for (const events of app.delivered) {
    expect(events.at(-1)).toMatchObject({
      taskId: id,
      event: {
        type: "queue-changed",
        reason: "remove",
        queue: [kept],
        paused: true,
      },
    });
    expect(events.at(-1)!.sequence).toBeGreaterThan(before.sequence);
  }
  expect(invoke("view", id).queueState.queue).toEqual([kept]);
  const reopened = createSqliteInputQueueStore(app.dbPath);
  try {
    expect(reopened.list(id)).toEqual([kept]);
  } finally {
    reopened.close();
  }
  invoke("queue-resume", id);
  await app.finish("保留");
  await waitFor(() => expect(invoke("execution", id).running).toBe(false));
  expect(app.requests).toEqual(["首轮", "保留"]);
}, 30_000);
