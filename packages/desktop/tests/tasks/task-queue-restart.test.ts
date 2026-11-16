import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createAgentResourceSnapshot,
  createTaskManager,
  createSqliteTaskStore,
  createWorktreeService,
} from "@codexlike/agent-core/node";
import { createProfileStore } from "../../src/profiles/profile-store";
import { createSqliteInputQueueStore } from "../../src/tasks/input-queue-store";
import { createSqliteTaskQueueStore } from "../../src/tasks/task-queue-store";
import { registerTaskHandlers } from "../../src/tasks/task-ipc";
import { listenMock } from "./mock-server";

// 接缝：真实任务 IPC / 退出生命周期；只替换 Electron 通道与外部模型、系统加密。
// 同一 SQLite 文件的生产连接（任务库 / 输入队列 / 任务排队）实际关闭再重开，
// 不借助 SQL 查询判断恢复状态。沿 input-queue-restart 先例（ADR 0013 /
// 任务并发上限票 05、ADR 0022）。
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
  for (const fn of cleanup.splice(0).reverse()) await fn();
  handlers.clear();
});
function invoke(name: string, ...args: unknown[]): any {
  const handler = handlers.get(`tasks:${name}`);
  if (!handler) throw new Error(`未注册通道 tasks:${name}`);
  return handler({}, ...args);
}
const waitFor = (check: () => unknown) => vi.waitFor(check, { timeout: 8000 });

async function setup(limit: number) {
  const root = mkdtempSync(join(tmpdir(), "task-queue-restart-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  // 父目录刻意不存在，三个生产 store 必须自行建目录。
  const dbPath = join(root, "fresh", "task-workbench.db");
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
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      responses.set(text, res);
    });
  });
  const port = await listenMock(server);
  cleanup.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const profiles = createProfileStore({
    dir: root,
    safeStorage: {
      isEncryptionAvailable: async () => true,
      encryptString: async (text) => Buffer.from(text),
      decryptString: async (bytes) => bytes.toString(),
    },
  });
  const profile = await profiles.create({
    name: "重启模型",
    model: "mock",
    apiKey: "test",
    baseURL: `http://127.0.0.1:${port}/v1`,
  });
  const resourcesFor = ({ workspacePath }: { workspacePath: string }) =>
    createAgentResourceSnapshot({
      workspacePath,
      globalDir: root,
      compatibleGlobalDir: join(root, "compatible"),
      findGitRoot: () => null,
    });
  function open() {
    const persistence = createSqliteTaskStore(dbPath);
    const queueStore = createSqliteInputQueueStore(dbPath);
    const taskQueueStore = createSqliteTaskQueueStore(dbPath);
    const manager = createTaskManager({ persistence, resourcesFor });
    const runtime = registerTaskHandlers({
      manager,
      profiles,
      getWindow: () => null,
      dataDir: root,
      queueStore,
      taskQueueStore,
      concurrencyLimit: () => limit,
      resourcesFor,
      worktreeService: createWorktreeService({
        worktreesDir: join(root, "worktrees"),
      }),
    });
    let closed = false;
    async function close() {
      if (closed) return;
      runtime.freeze();
      await runtime.stopAndDrain();
      taskQueueStore.close();
      queueStore.close();
      persistence.close();
      closed = true;
      handlers.clear();
    }
    cleanup.push(close);
    return { runtime, close };
  }
  /** 首条回复保持进行中（不发 finish）：任务停在执行中占名额 */
  async function holdReply(text: string) {
    await waitFor(() => expect(responses.has(text)).toBe(true));
    const res = responses.get(text)!;
    res.write(
      `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: { content: `${text}进行中` }, finish_reason: null }] })}\n\n`
    );
  }
  async function finish(text: string) {
    await waitFor(() => expect(responses.has(text)).toBe(true));
    const res = responses.get(text)!;
    res.write(
      `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`
    );
    res.end("data: [DONE]\n\n");
  }
  /** 新任务首条发送：返回任务 id（满员时入队不执行） */
  async function start(text: string): Promise<string> {
    const record = await invoke("start", {
      requestId: text,
      projectId: null,
      text,
    });
    return record.id as string;
  }
  function activity(taskId: string) {
    return invoke("list").find((task: any) => task.id === taskId).activity;
  }
  return {
    open,
    profile,
    requests,
    responses,
    holdReply,
    finish,
    start,
    activity,
    hasRequest: (text: string) => responses.has(text),
  };
}

it("排队中重启：启动泵一次后按原顺序自动开跑（上限内），顺序严格 FIFO", async () => {
  const app = await setup(2);
  const first = app.open();
  // 两个任务执行中（回复保持进行中占满上限 2）
  const runningA = await app.start("重启占坑甲");
  const runningB = await app.start("重启占坑乙");
  await app.holdReply("重启占坑甲");
  await app.holdReply("重启占坑乙");
  expect(invoke("execution", runningA).running).toBe(true);
  expect(invoke("execution", runningB).running).toBe(true);

  // 第 3、4 个任务：满员入队不执行
  const queuedC = await app.start("重启排队丙");
  const queuedD = await app.start("重启排队丁");
  expect(app.activity(queuedC).queued).toBe(true);
  expect(app.activity(queuedD).queued).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(app.hasRequest("重启排队丙")).toBe(false);
  expect(app.hasRequest("重启排队丁")).toBe(false);
  await first.close();

  // 重开后（生产由 main.ts 启动装配泵一次，测试走同一公开通道）：
  // 未泵前不自跑；泵后上限 2 内丙丁都开跑且丙先于丁
  const reopened = app.open();
  expect(app.requests).toEqual(["重启占坑甲", "重启占坑乙"]);
  expect(reopened.runtime.hasWork()).toBe(false);
  expect(app.activity(queuedC).queued).toBe(true);
  expect(app.activity(queuedD).queued).toBe(true);
  reopened.runtime.pumpTaskQueue();
  await waitFor(() => expect(app.hasRequest("重启排队丙")).toBe(true));
  await app.holdReply("重启排队丙");
  await waitFor(() => expect(app.hasRequest("重启排队丁")).toBe(true));
  expect(
    app.requests.indexOf("重启排队丙") < app.requests.indexOf("重启排队丁")
  ).toBe(true);
  expect(app.activity(queuedC).queued).toBe(false);
  expect(app.activity(queuedD).queued).toBe(false);

  // 收尾：丁完成、丙完成，首条消息按快照落库
  await app.finish("重启排队丁");
  await app.finish("重启排队丙");
  await waitFor(() => expect(reopened.runtime.hasWork()).toBe(false));
  const queuedCMessages = invoke("messages", queuedC)
    .filter((item: any) => item.message?.role === "user")
    .map((item: any) => item.message.content);
  expect(queuedCMessages).toEqual(["重启排队丙"]);
}, 30_000);

it("重启后仍排队任务打开可见：view 携带排队首条文本与 queued 活动态（状态条与首条回显的数据源）", async () => {
  const app = await setup(1);
  const first = app.open();
  const running = await app.start("重启可见占坑");
  await app.holdReply("重启可见占坑");
  const queued = await app.start("重启可见排队首条");
  expect(app.activity(queued).queued).toBe(true);
  await first.close();

  // 重启后（未泵前）：排队任务无任何 task-queue-changed 信封可重放
  //（view.events 为空），排队首条文本与 queued 活动态只能由 view 的
  // 排队快照字段恢复——ui 状态条与首条回显沿票 03 的 hydrate 路径接上
  const reopened = app.open();
  const view = invoke("view", queued);
  expect(view.events).toEqual([]);
  expect(view.activity.queued).toBe(true);
  expect(view.queuedStart).toBe("重启可见排队首条");
  // 侧栏数据源（tasks.list 活动态）同样恢复
  expect(app.activity(queued).queued).toBe(true);

  // 开跑出队后：快照不再含本任务，view 字段随之撤销
  reopened.runtime.pumpTaskQueue();
  await app.finish("重启可见排队首条");
  await waitFor(() => expect(reopened.runtime.hasWork()).toBe(false));
  const viewAfter = invoke("view", queued);
  expect(viewAfter.activity.queued).toBe(false);
  expect(viewAfter.queuedStart).toBeNull();
  void running;
}, 30_000);

it("中断出队清除持久化记录：重启后不复活排队、名额让给后续排队任务", async () => {
  const app = await setup(1);
  const first = app.open();
  const running = await app.start("独占名额");
  await app.holdReply("独占名额");
  expect(invoke("execution", running).running).toBe(true);

  const interrupted = await app.start("中断后不得复活");
  const survivor = await app.start("幸存排队者");
  expect(app.activity(interrupted).queued).toBe(true);
  expect(app.activity(survivor).queued).toBe(true);

  // 中断排队任务（票 04）：立即出队（remove 落库清除持久化记录）
  expect(invoke("interrupt", interrupted)).toBe(true);
  expect(app.activity(interrupted).queued).toBe(false);
  expect(app.activity(survivor).queued).toBe(true);
  await first.close();

  const reopened = app.open();
  reopened.runtime.pumpTaskQueue();
  // 幸存者开跑（上限 1）；被中断任务不复活：不排队、不请求
  await waitFor(() => expect(app.hasRequest("幸存排队者")).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(app.requests).not.toContain("中断后不得复活");
  expect(app.activity(interrupted).queued).toBe(false);
  expect(app.activity(survivor).queued).toBe(false);

  await app.finish("幸存排队者");
  await waitFor(() => expect(reopened.runtime.hasWork()).toBe(false));
}, 30_000);
