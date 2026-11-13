import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createAgentResourceSnapshot,
  createBuiltinTools,
  createSessionManager,
  createSqliteSessionStore,
  createWorktreeService,
} from "@codexlike/agent-core/node";
import type { BrowserWindow } from "electron";
import type { SessionEventEnvelope } from "../../src/shared/ipc";
import { registerSessionHandlers } from "../../src/sessions/session-ipc";
import { createSqliteInputQueueStore } from "../../src/sessions/input-queue-store";
import { createProfileStore } from "../../src/profiles/profile-store";
import { listenMock } from "./mock-server";

/**
 * 输入队列 IPC/会话层集成（票 01）：忙时 send 不再报错而是入队（主进程单一真相），
 * 队列变更作为会话事件信封推送，回复结束后自动逐条消费。
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
  const handler = handlers.get(`sessions:${name}`);
  if (!handler) throw new Error(`未注册通道 sessions:${name}`);
  return handler({}, ...args);
}
const waitFor = (check: () => unknown) => vi.waitFor(check, { timeout: 8000 });

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "input-queue-ipc-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "project");
  mkdirSync(workspace);
  const dbPath = join(root, "nested", "session-workbench.db");
  const persistence = createSqliteSessionStore(dbPath);
  cleanup.push(() => persistence.close());
  // 队列持久化：同一 db 文件的独立连接（生产布局一致，ADR 0013）
  const queueStore = createSqliteInputQueueStore(dbPath);
  cleanup.push(() => queueStore.close());
  const resourcesFor = ({ workspacePath }: { workspacePath: string }) =>
    createAgentResourceSnapshot({
      workspacePath,
      globalDir: root,
      compatibleGlobalDir: join(root, "compatible"),
      findGitRoot: () => null,
    });
  const manager = createSessionManager({
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
    model: "mock",
    apiKey: "test",
    baseURL: `http://127.0.0.1:${mockPort}/v1`,
  });
  const delivered: SessionEventEnvelope[] = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      send: (_channel: string, envelope: SessionEventEnvelope) =>
        delivered.push(structuredClone(envelope)),
    },
  } as unknown as BrowserWindow;
  registerSessionHandlers({
    manager,
    profiles,
    getWindow: () => window,
    dataDir: root,
    queueStore,
    worktreeService: createWorktreeService({
      worktreesDir: join(root, "worktrees"),
    }),
    resourcesFor,
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
  async function reply(
    text: string,
    content = `${text}的回答`,
    finish: string | null = "stop"
  ) {
    await waitFor(() => expect(responses.has(text)).toBe(true));
    const res = responses.get(text)!;
    res.write(
      `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`
    );
    if (finish) {
      res.write(
        `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`
      );
      res.end("data: [DONE]\n\n");
    }
  }
  return {
    profile,
    project,
    reply,
    finish,
    hasRequest: (text: string) => responses.has(text),
    delivered,
  };
}

it("忙时 send 不报错而入队：事件信封推送队列快照，view 携带队列", async () => {
  const app = await setup();
  const session = await invoke("start", {
    requestId: "queue-enqueue",
    projectId: null,
    text: "首轮任务",
  });
  // 首轮回复保持进行中（不发 finish）→ 会话忙
  await app.reply("首轮任务", "首轮进行中", null);

  // 忙时 send 两条：不再抛「会话正在执行」，而是入队（主进程单一真相）
  await invoke("send", session.id, "排队一", app.profile.id);
  await invoke("send", session.id, "排队二", app.profile.id);

  // 队列变更作为会话事件信封推送（复用 sessionId/sequence/executionId）
  const queued = app.delivered.filter(
    (envelope) =>
      envelope.sessionId === session.id &&
      (envelope.event as any).type === "queue-changed"
  );
  expect(queued.length).toBeGreaterThanOrEqual(2);
  const last = queued.at(-1)!;
  expect((last.event as any).queue.map((item: any) => item.text)).toEqual([
    "排队一",
    "排队二",
  ]);
  expect(last.sequence).toBeGreaterThan(queued[0]!.sequence);
  // 参数快照随消息保存
  expect((last.event as any).queue[0]).toMatchObject({
    providerProfileId: app.profile.id,
    thinkingEffort: "auto",
    approvalMode: "ask",
  });
  // view 快照：切回会话时队列原样可见
  const view = invoke("view", session.id);
  expect(view.queue.map((item: any) => item.text)).toEqual([
    "排队一",
    "排队二",
  ]);

  // 收尾：完成首轮 → 自动逐条消费两条 → 队列清空
  await app.finish("首轮任务");
  await app.reply("排队一");
  await app.reply("排队二");
  await waitFor(() => expect(invoke("view", session.id).queue).toEqual([]));
  await waitFor(() =>
    expect(invoke("execution", session.id).running).toBe(false)
  );
  // 消费按入队顺序进入会话消息历史
  const userTexts = invoke("messages", session.id)
    .filter((item: any) => item.message?.role === "user")
    .map((item: any) => item.message.content);
  expect(userTexts).toEqual(["首轮任务", "排队一", "排队二"]);
}, 30_000);

it("逐条消费：第一条回复完成前不发下一条，dequeue 事件随轮次推送", async () => {
  const app = await setup();
  const session = await invoke("start", {
    requestId: "queue-sequence",
    projectId: null,
    text: "首轮",
  });
  await app.reply("首轮", "进行中", null);
  await invoke("send", session.id, "甲", app.profile.id);
  await invoke("send", session.id, "乙", app.profile.id);

  // 首轮结束 → 自动取队首「甲」；「甲」的回复保持进行中
  await app.finish("首轮");
  await app.reply("甲", "甲的回答", null);
  // 「甲」回复未完成：「乙」不得被发出（模型未收到请求）
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(app.hasRequest("乙")).toBe(false);
  // 出队事件已推送（「甲」被取出发送）
  const dequeued = app.delivered.filter(
    (envelope) =>
      envelope.sessionId === session.id &&
      (envelope.event as any).type === "queue-changed" &&
      (envelope.event as any).reason === "dequeue"
  );
  expect(dequeued.length).toBeGreaterThanOrEqual(1);
  expect((dequeued.at(-1)!.event as any).queue.map((i: any) => i.text)).toEqual(
    // 票 03：甲已取出发送——从持久层移除，以「正在发出」置顶保留在视图
    ["甲", "乙"]
  );
  expect((dequeued.at(-1)!.event as any).sendingId).toBeDefined();

  // 「甲」完成 → 「乙」随后自动发出
  await app.finish("甲");
  await app.reply("乙");
  await waitFor(() =>
    expect(invoke("execution", session.id).running).toBe(false)
  );
  await waitFor(() => expect(invoke("view", session.id).queue).toEqual([]));
}, 30_000);

it("排队存在时点停止：当前回复中断、队列原样保留并进入暂停（事件与 view 可见）", async () => {
  const app = await setup();
  const session = await invoke("start", {
    requestId: "queue-pause-on-stop",
    projectId: null,
    text: "首轮任务",
  });
  await app.reply("首轮任务", "首轮进行中", null);
  await invoke("send", session.id, "排队一", app.profile.id);

  // 排队存在时点停止：中断当前回复，队列保留并进入暂停
  expect(invoke("interrupt", session.id)).toBe(true);
  const view = invoke("view", session.id);
  expect(view.queue.map((item: any) => item.text)).toEqual(["排队一"]);
  expect(view.queuePaused).toBe(true);

  // 置暂停推送 queue-changed(pause) 事件信封（携带暂停后快照）
  const pauseEvents = app.delivered.filter(
    (envelope) =>
      envelope.sessionId === session.id &&
      (envelope.event as any).type === "queue-changed" &&
      (envelope.event as any).reason === "pause"
  );
  expect(pauseEvents.length).toBeGreaterThanOrEqual(1);
  expect(
    (pauseEvents.at(-1)!.event as any).queue.map((i: any) => i.text)
  ).toEqual(["排队一"]);
  expect((pauseEvents.at(-1)!.event as any).paused).toBe(true);

  // 中断落定（空闲）后暂停保持：队列不被消费
  await waitFor(() =>
    expect(invoke("execution", session.id).running).toBe(false)
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(app.hasRequest("排队一")).toBe(false);
  expect(invoke("view", session.id).queuePaused).toBe(true);

  // 收尾：手动恢复并让排队消息完成
  invoke("queue-resume", session.id);
  await app.reply("排队一");
  await waitFor(() =>
    expect(invoke("execution", session.id).running).toBe(false)
  );
  await waitFor(() => expect(invoke("view", session.id).queue).toEqual([]));
}, 30_000);

it("暂停期间插话直发：插话回复结束后自动恢复队列消费", async () => {
  const app = await setup();
  const session = await invoke("start", {
    requestId: "queue-pause-interject",
    projectId: null,
    text: "首轮任务",
  });
  await app.reply("首轮任务", "首轮进行中", null);
  await invoke("send", session.id, "排队一", app.profile.id);
  invoke("interrupt", session.id);
  await waitFor(() =>
    expect(invoke("execution", session.id).running).toBe(false)
  );

  // 暂停期间直接发新消息：会话空闲走直发（不排队、无需先解除暂停）
  await invoke("send", session.id, "插话", app.profile.id);
  await waitFor(() => expect(app.hasRequest("插话")).toBe(true));
  expect(
    invoke("view", session.id).queue.map((item: any) => item.text)
  ).toEqual(["排队一"]);

  // 插话的回复结束 → 暂停自动解除、队列继续消费
  await app.reply("插话");
  await app.reply("排队一");
  await waitFor(() =>
    expect(invoke("execution", session.id).running).toBe(false)
  );
  await waitFor(() => expect(invoke("view", session.id).queue).toEqual([]));
  expect(invoke("view", session.id).queuePaused).toBe(false);
  // 顺序：首轮（中断）→ 插话 → 排队一
  const userTexts = invoke("messages", session.id)
    .filter((item: any) => item.message?.role === "user")
    .map((item: any) => item.message.content);
  expect(userTexts).toEqual(["首轮任务", "插话", "排队一"]);
}, 30_000);

it("手动恢复（queue-resume）：清暂停标志并立即从队首继续消费", async () => {
  const app = await setup();
  const session = await invoke("start", {
    requestId: "queue-manual-resume",
    projectId: null,
    text: "首轮任务",
  });
  await app.reply("首轮任务", "首轮进行中", null);
  await invoke("send", session.id, "排队一", app.profile.id);
  invoke("interrupt", session.id);
  await waitFor(() =>
    expect(invoke("execution", session.id).running).toBe(false)
  );

  const result = invoke("queue-resume", session.id);
  expect(result.paused).toBe(false);
  expect(result.queue.map((item: any) => item.text)).toEqual(["排队一"]);
  // 恢复立即触发消费：队首发出
  await app.reply("排队一");
  await waitFor(() =>
    expect(invoke("execution", session.id).running).toBe(false)
  );
  await waitFor(() => expect(invoke("view", session.id).queue).toEqual([]));
}, 30_000);

it("清空（queue-clear）：全部作废删除、队列消失、无消费", async () => {
  const app = await setup();
  const session = await invoke("start", {
    requestId: "queue-clear",
    projectId: null,
    text: "首轮任务",
  });
  await app.reply("首轮任务", "首轮进行中", null);
  await invoke("send", session.id, "排队一", app.profile.id);
  await invoke("send", session.id, "排队二", app.profile.id);
  invoke("interrupt", session.id);
  await waitFor(() =>
    expect(invoke("execution", session.id).running).toBe(false)
  );

  const result = invoke("queue-clear", session.id);
  expect(result.queue).toEqual([]);
  expect(result.paused).toBe(false);
  const view = invoke("view", session.id);
  expect(view.queue).toEqual([]);
  expect(view.queuePaused).toBe(false);

  // 清空后不再消费：模型从未收到排队消息
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(app.hasRequest("排队一")).toBe(false);
  expect(app.hasRequest("排队二")).toBe(false);
}, 30_000);
