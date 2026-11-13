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
    ["乙"]
  );

  // 「甲」完成 → 「乙」随后自动发出
  await app.finish("甲");
  await app.reply("乙");
  await waitFor(() =>
    expect(invoke("execution", session.id).running).toBe(false)
  );
  await waitFor(() => expect(invoke("view", session.id).queue).toEqual([]));
}, 30_000);
