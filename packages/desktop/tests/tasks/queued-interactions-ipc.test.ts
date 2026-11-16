import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, vi, it } from "vitest";
import {
  createAgentResourceSnapshot,
  createBuiltinTools,
  createTaskManager,
  createSqliteTaskStore,
  createWorktreeService,
} from "@codexlike/agent-core/node";
import type { BrowserWindow } from "electron";
import type { TaskEventEnvelope } from "../../src/shared/ipc";
import { registerTaskHandlers } from "../../src/tasks/task-ipc";
import { createProfileStore } from "../../src/profiles/profile-store";
import { listenMock } from "./mock-server";

/**
 * 排队任务交互 IPC/任务层集成（任务并发上限票 04 / ADR 0022）：排队任务在
 * 输入队列语义上视同「忙」——排队期间继续发送的消息进入该任务输入队列
 * （不直接执行），开跑后首条先发、队列消息按序跟上（ADR 0013 机制原样）；
 * 中断排队任务立即出队回空闲，输入队列条目保留且暂停消费，名额让给后续
 * 排队任务；中断后重新发消息若仍满员则重新排队。
 */
const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => any>(),
}));
vi.mock("electron", () => ({
  dialog: {},
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => any) =>
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

async function setup(options?: { limit?: number }) {
  const root = mkdtempSync(join(tmpdir(), "queued-interactions-ipc-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "project");
  mkdirSync(workspace);
  const persistence = createSqliteTaskStore(join(root, "nested", "tasks.db"));
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
      const text = JSON.parse(body).messages.findLast(
        (message: any) => message.role === "user"
      ).content;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      // 默认挂起等测试显式 finish：占坑任务与进行中的回复由此控制
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
    model: "mock",
    apiKey: "test",
    baseURL: `http://127.0.0.1:${mockPort}/v1`,
  });
  const delivered: TaskEventEnvelope[] = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      send: (_channel: string, envelope: TaskEventEnvelope) =>
        delivered.push(structuredClone(envelope)),
    },
  } as unknown as BrowserWindow;
  // 上限注入：可变变量模拟主进程设置缓存
  let concurrencyLimit = options?.limit ?? 1;
  registerTaskHandlers({
    manager,
    profiles,
    getWindow: () => window,
    dataDir: root,
    concurrencyLimit: () => concurrencyLimit,
    worktreeService: createWorktreeService({
      worktreesDir: join(root, "worktrees"),
    }),
    resourcesFor,
  });
  cleanup.push(async () => {
    for (const task of manager.list()) invoke("interrupt", task.id);
    await waitFor(() =>
      expect(
        manager.list().every((task) => !invoke("execution", task.id).running)
      ).toBe(true)
    );
  });
  const project = manager.addProject(workspace);
  /** 对已挂起的响应直接发 finish（让进行中的回复结束） */
  async function finish(text: string) {
    await waitFor(() => expect(responses.has(text)).toBe(true));
    const res = responses.get(text)!;
    res.write(
      `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`
    );
    res.end("data: [DONE]\n\n");
  }
  /** 首条回复保持进行中（不发 finish）：任务停在执行中占名额 */
  async function holdReply(text: string) {
    await waitFor(() => expect(responses.has(text)).toBe(true));
    const res = responses.get(text)!;
    res.write(
      `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: { content: `${text}进行中` }, finish_reason: null }] })}\n\n`
    );
  }
  return {
    profile,
    project,
    finish,
    holdReply,
    hasRequest: (text: string) => responses.has(text),
    delivered,
  };
}

it("排队期间发送的消息进入输入队列不直接执行；开跑后首条先发、队列消息按序跟上", async () => {
  const app = await setup({ limit: 1 });
  const holder = await invoke("start", {
    requestId: "qi-holder",
    projectId: null,
    text: "占位任务",
  });
  await app.holdReply("占位任务");
  const queued = await invoke("start", {
    requestId: "qi-queued",
    projectId: null,
    text: "排队任务首条",
  });
  expect(
    invoke("list").find((task: any) => task.id === queued.id).activity.queued
  ).toBe(true);

  // 排队期间继续发消息：进入输入队列（快照含文本），模型未收到
  await invoke("send", queued.id, "排队补充一", app.profile.id);
  await invoke("send", queued.id, "排队补充二", app.profile.id);
  const view = invoke("view", queued.id);
  expect(view.queueState.queue.map((item: any) => item.text)).toEqual([
    "排队补充一",
    "排队补充二",
  ]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(app.hasRequest("排队补充一")).toBe(false);
  expect(app.hasRequest("排队补充二")).toBe(false);

  // 名额释放：FIFO 先开跑排队首条——输入队列消息不得插队提前执行
  await app.finish("占位任务");
  await waitFor(() => expect(app.hasRequest("排队任务首条")).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(app.hasRequest("排队补充一")).toBe(false);
  expect(app.hasRequest("排队补充二")).toBe(false);

  // 首条回复结束：输入队列按序自动发出（先一后二，ADR 0013 机制原样）
  await app.finish("排队任务首条");
  await waitFor(() => expect(app.hasRequest("排队补充一")).toBe(true));
  await app.finish("排队补充一");
  await waitFor(() => expect(app.hasRequest("排队补充二")).toBe(true));
  await app.finish("排队补充二");
  await waitFor(() =>
    expect(invoke("execution", queued.id).running).toBe(false)
  );
  // 消息流完整保留：首条与两条补充按发出顺序落库
  const userTexts = invoke("messages", queued.id)
    .filter((item: any) => item.message?.role === "user")
    .map((item: any) => item.message.content);
  expect(userTexts).toEqual(["排队任务首条", "排队补充一", "排队补充二"]);
  void holder;
}, 30_000);

it("中断排队任务立即出队回空闲：首条补落为已发送未回复、输入队列保留且暂停、名额让给后续排队任务", async () => {
  const app = await setup({ limit: 1 });
  const holder = await invoke("start", {
    requestId: "qi-stop-holder",
    projectId: null,
    text: "中断占位",
  });
  await app.holdReply("中断占位");
  const first = await invoke("start", {
    requestId: "qi-stop-first",
    projectId: null,
    text: "排队甲首条",
  });
  const second = await invoke("start", {
    requestId: "qi-stop-second",
    projectId: null,
    text: "排队乙首条",
  });
  // 排队期间给排队甲追加一条消息（进输入队列）
  await invoke("send", first.id, "排队甲补充", app.profile.id);

  // 中断排队甲：出队回空闲（返回 true），排队乙仍在队
  expect(invoke("interrupt", first.id)).toBe(true);
  expect(
    invoke("list").find((task: any) => task.id === first.id).activity.queued
  ).toBe(false);
  expect(
    invoke("list").find((task: any) => task.id === second.id).activity.queued
  ).toBe(true);
  // 出队事件作为任务事件信封推送（remove 原因，queued 撤销）
  const removedEvents = app.delivered.filter(
    (envelope) =>
      envelope.taskId === first.id &&
      (envelope.event as any).type === "task-queue-changed" &&
      (envelope.event as any).reason === "remove"
  );
  expect(removedEvents.length).toBeGreaterThanOrEqual(1);
  expect(removedEvents.at(-1)!.activity.queued).toBe(false);
  // 已发消息保留（spec 用户故事 8 / review 修复 F1）：首条从未触发执行，
  // 出队时补落为已发送未回复的 user message（不触发模型请求），并经
  // user-message 事件推送接管本地回显；输入队列条目原样保留且暂停消费
  const firstUserTexts = invoke("messages", first.id)
    .filter((item: any) => item.message?.role === "user")
    .map((item: any) => item.message.content);
  expect(firstUserTexts).toEqual(["排队甲首条"]);
  const backfillEvents = app.delivered.filter(
    (envelope) =>
      envelope.taskId === first.id &&
      (envelope.event as any).type === "user-message" &&
      (envelope.event as any).message.content === "排队甲首条"
  );
  expect(backfillEvents.length).toBeGreaterThanOrEqual(1);
  const view = invoke("view", first.id);
  expect(view.queueState.queue.map((item: any) => item.text)).toEqual([
    "排队甲补充",
  ]);
  expect(view.queueState.paused).toBe(true);

  // 名额释放：开跑的是排队乙（名额让给后续排队任务），排队甲不重发
  await app.finish("中断占位");
  await waitFor(() => expect(app.hasRequest("排队乙首条")).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(app.hasRequest("排队甲首条")).toBe(false);
  expect(app.hasRequest("排队甲补充")).toBe(false);
  await app.finish("排队乙首条");
  await waitFor(() =>
    expect(invoke("execution", second.id).running).toBe(false)
  );
  // 排队甲保持空闲：中断后未自动执行任何消息
  expect(invoke("execution", first.id).running).toBe(false);
  void holder;
}, 30_000);

it("中断排队后重新发消息：旧首条补落为已发送未回复，仍满员则重新排队，开跑后输入队列按插话语义恢复消费", async () => {
  const app = await setup({ limit: 1 });
  const holder = await invoke("start", {
    requestId: "qi-resend-holder",
    projectId: null,
    text: "重发占位",
  });
  await app.holdReply("重发占位");
  const task = await invoke("start", {
    requestId: "qi-resend",
    projectId: null,
    text: "重发任务首条",
  });
  // 排队期间追加一条消息，随后中断出队（输入队列保留且暂停）
  await invoke("send", task.id, "中断前补充", app.profile.id);
  expect(invoke("interrupt", task.id)).toBe(true);
  expect(
    invoke("list").find((item: any) => item.id === task.id).activity.queued
  ).toBe(false);

  // 重新发消息：仍满员 → 重新排队（中断丢弃的旧快照不复活、不重复补落）
  await invoke("send", task.id, "重新发送", app.profile.id);
  expect(
    invoke("list").find((item: any) => item.id === task.id).activity.queued
  ).toBe(true);

  // 名额释放：开跑的是重发的消息；中断前的首条快照不再执行（已补落）
  await app.finish("重发占位");
  await waitFor(() => expect(app.hasRequest("重新发送")).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(app.hasRequest("重发任务首条")).toBe(false);
  // 重发消息回复结束：暂停按插话语义解除，输入队列的旧消息自动跟上
  await app.finish("重新发送");
  await waitFor(() => expect(app.hasRequest("中断前补充")).toBe(true));
  await app.finish("中断前补充");
  await waitFor(() => expect(invoke("execution", task.id).running).toBe(false));
  // 消息流完整：旧首条补落在前（已发送未回复），重发与补充随后执行落库
  const userTexts = invoke("messages", task.id)
    .filter((item: any) => item.message?.role === "user")
    .map((item: any) => item.message.content);
  expect(userTexts).toEqual(["重发任务首条", "重新发送", "中断前补充"]);
  void holder;
}, 30_000);
