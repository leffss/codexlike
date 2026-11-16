import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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
import { registerTaskHandlers } from "../../src/tasks/task-ipc";
import { createProfileStore } from "../../src/profiles/profile-store";
import { listenMock } from "./mock-server";

/**
 * 任务排队 IPC/任务层集成（任务并发上限票 02 / ADR 0022）：执行中任务数
 * 达到上限时，新任务的首条发送入队不执行（任务照常创建、活动态 queued），
 * 名额释放后按 FIFO 自动开跑；等待用户交互的任务占名额；调大立即补跑、
 * 调小不中断运行中的。
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

/** 问答触发前缀：带该前缀的首条消息第一轮挂起等用户回答，回答后第二轮收尾 */
const ASK_PREFIX = "排队提问：";

async function setup(options?: { limit?: number }) {
  const root = mkdtempSync(join(tmpdir(), "task-queue-ipc-"));
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
      const messages = JSON.parse(body).messages;
      const text = messages.findLast(
        (message: any) => message.role === "user"
      ).content;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      if (text.startsWith(ASK_PREFIX)) {
        // 问答轮次按会话内 assistant 消息数判定（多任务各挂各的问答互不
        // 干扰；回答后的第二轮请求已含 assistant 消息，不再挂起）
        const asking =
          messages.filter((message: any) => message.role === "assistant")
            .length === 0;
        const delta = asking
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "queue-ask",
                  type: "function",
                  function: {
                    name: "ask_user_question",
                    arguments: JSON.stringify({
                      questions: [
                        {
                          id: "platform",
                          header: "平台",
                          question: "优先支持哪个平台？",
                          multiSelect: false,
                          options: [{ id: "windows", label: "Windows" }],
                        },
                      ],
                    }),
                  },
                },
              ],
            }
          : { content: "已收到回答" };
        for (const choice of [
          { delta, finish_reason: null },
          { delta: {}, finish_reason: asking ? "tool_calls" : "stop" },
        ]) {
          res.write(
            `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, ...choice }] })}\n\n`
          );
        }
        res.end("data: [DONE]\n\n");
        return;
      }
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
  // 上限注入：可变变量模拟主进程设置缓存（调大/调小直接改值即生效）
  let concurrencyLimit = options?.limit ?? 2;
  const runtime = registerTaskHandlers({
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
  /** 首条回复保持进行中（不发 finish）：任务停在执行中 */
  async function holdReply(text: string, content = `${text}进行中`) {
    await waitFor(() => expect(responses.has(text)).toBe(true));
    const res = responses.get(text)!;
    res.write(
      `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`
    );
  }
  return {
    profile,
    project,
    finish,
    holdReply,
    hasRequest: (text: string) => responses.has(text),
    delivered,
    askPrefix: ASK_PREFIX,
    /** 任务排队推进通道：生产由设置保存回调触发（main.ts 装配），测试直调 */
    pump: () => runtime.pumpTaskQueue(),
    setLimit(next: number) {
      concurrencyLimit = next;
    },
  };
}

it("上限 2 时第 3 个任务的首条执行入队不执行；结束一个后自动开跑，顺序严格 FIFO", async () => {
  const app = await setup({ limit: 2 });
  const first = await invoke("start", {
    requestId: "gate-first",
    projectId: null,
    text: "任务甲首条",
  });
  const second = await invoke("start", {
    requestId: "gate-second",
    projectId: null,
    text: "任务乙首条",
  });
  // 两个任务执行中（回复保持进行中）
  await app.holdReply("任务甲首条");
  await app.holdReply("任务乙首条");
  expect(invoke("execution", first.id).running).toBe(true);
  expect(invoke("execution", second.id).running).toBe(true);

  // 第 3 个任务：任务照常创建（侧栏可见），首条执行入队不发出
  const third = await invoke("start", {
    requestId: "gate-third",
    projectId: null,
    text: "任务丙首条",
  });
  const listed = invoke("list").find((task: any) => task.id === third.id);
  expect(listed).toBeDefined();
  expect(listed.activity.queued).toBe(true);
  // 模型从未收到第 3 条请求
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(app.hasRequest("任务丙首条")).toBe(false);

  // 结束任务甲（名额释放）→ 队首（唯一排队者）自动开跑
  await app.finish("任务甲首条");
  await waitFor(() => expect(app.hasRequest("任务丙首条")).toBe(true));
  await waitFor(() =>
    expect(
      invoke("list").find((task: any) => task.id === third.id).activity.queued
    ).toBe(false)
  );
  // 开跑即执行中：queued 撤销与 running 并存
  expect(invoke("execution", third.id).running).toBe(true);

  // 收尾：丙完成、乙完成
  await app.finish("任务丙首条");
  await app.finish("任务乙首条");
  await waitFor(() =>
    expect(invoke("execution", third.id).running).toBe(false)
  );
  const thirdMessages = invoke("messages", third.id)
    .filter((item: any) => item.message?.role === "user")
    .map((item: any) => item.message.content);
  expect(thirdMessages).toEqual(["任务丙首条"]);
}, 30_000);

it("排队严格 FIFO：两个排队任务按发起顺序先后开跑", async () => {
  const app = await setup({ limit: 1 });
  const first = await invoke("start", {
    requestId: "fifo-first",
    projectId: null,
    text: "占坑任务",
  });
  await app.holdReply("占坑任务");

  const second = await invoke("start", {
    requestId: "fifo-second",
    projectId: null,
    text: "排队二",
  });
  const third = await invoke("start", {
    requestId: "fifo-third",
    projectId: null,
    text: "排队三",
  });
  expect(
    invoke("list").find((task: any) => task.id === second.id).activity.queued
  ).toBe(true);
  expect(
    invoke("list").find((task: any) => task.id === third.id).activity.queued
  ).toBe(true);

  // 名额释放：先开跑排队二（发起在前）；排队三等待
  await app.finish("占坑任务");
  await waitFor(() => expect(app.hasRequest("排队二")).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(app.hasRequest("排队三")).toBe(false);
  // 排队二结束 → 排队三开跑
  await app.finish("排队二");
  await waitFor(() => expect(app.hasRequest("排队三")).toBe(true));
  await app.finish("排队三");
  await waitFor(() =>
    expect(invoke("execution", third.id).running).toBe(false)
  );
}, 30_000);

it("等待审批/问答的任务占名额：3 个在等用户时第 4 个任务排队", async () => {
  const app = await setup({ limit: 3 });
  const waiting: any[] = [];
  for (const label of ["一", "二", "三"]) {
    const task = await invoke("start", {
      requestId: `wait-${label}`,
      projectId: null,
      text: `${app.askPrefix}挂起${label}`,
    });
    waiting.push(task);
  }
  // 三个任务都停在等待用户回答（waiting-user 占名额，ADR 0022）
  for (const task of waiting) {
    await waitFor(() =>
      expect(invoke("execution", task.id).waitingForUser).toBe(true)
    );
  }

  // 第 4 个任务：满员（3 个 waiting-user 占坑）→ 排队不执行
  const fourth = await invoke("start", {
    requestId: "wait-fourth",
    projectId: null,
    text: "任务丁首条",
  });
  expect(
    invoke("list").find((task: any) => task.id === fourth.id).activity.queued
  ).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(app.hasRequest("任务丁首条")).toBe(false);

  // 回答其中一个问题：该任务完成释放名额 → 第 4 个任务自动开跑
  const pending = invoke("pending-interactions", waiting[0].id);
  expect(pending).toHaveLength(1);
  expect(
    invoke("respond-interaction", waiting[0].id, pending[0].request.id, {
      kind: "questions",
      answers: [
        {
          questionId: "platform",
          status: "answered",
          selectedOptionIds: ["windows"],
          text: "",
        },
      ],
    })
  ).toBe(true);
  await waitFor(() => expect(app.hasRequest("任务丁首条")).toBe(true));
  await app.finish("任务丁首条");
  await waitFor(() =>
    expect(invoke("execution", fourth.id).running).toBe(false)
  );
  // 收尾：另外两个等待中的任务中断退出
}, 30_000);

it("调大（2→4）排队任务立即补位开跑；调小（4→2）运行中不被中断、新任务继续排队", async () => {
  const app = await setup({ limit: 2 });
  const first = await invoke("start", {
    requestId: "resize-first",
    projectId: null,
    text: "调整甲",
  });
  const second = await invoke("start", {
    requestId: "resize-second",
    projectId: null,
    text: "调整乙",
  });
  await app.holdReply("调整甲");
  await app.holdReply("调整乙");
  const third = await invoke("start", {
    requestId: "resize-third",
    projectId: null,
    text: "调整丙",
  });
  expect(
    invoke("list").find((task: any) => task.id === third.id).activity.queued
  ).toBe(true);

  // 调大上限：设置保存回调触发推进（此处经 runtime 通道模拟）→ 立即补跑
  app.setLimit(4);
  app.pump();
  await waitFor(() => expect(app.hasRequest("调整丙")).toBe(true));
  await app.holdReply("调整丙");
  expect(invoke("execution", third.id).running).toBe(true);

  // 调小上限：运行中的三个不被中断（照常回复推进）；新任务继续排队
  app.setLimit(2);
  const fourth = await invoke("start", {
    requestId: "resize-fourth",
    projectId: null,
    text: "调整丁",
  });
  expect(
    invoke("list").find((task: any) => task.id === fourth.id).activity.queued
  ).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(app.hasRequest("调整丁")).toBe(false);
  // 运行中的照常完成（不被中断）
  await app.finish("调整甲");
  await app.finish("调整乙");
  await app.finish("调整丙");
  await waitFor(() =>
    expect(invoke("execution", first.id).running).toBe(false)
  );

  // 自然降下后：新上限 2 内开跑排队的调整丁
  await waitFor(() => expect(app.hasRequest("调整丁")).toBe(true));
  await app.finish("调整丁");
  await waitFor(() =>
    expect(invoke("execution", fourth.id).running).toBe(false)
  );
}, 30_000);

it("排队变更作为任务事件信封推送：入队携带 queued 活动态与队列快照", async () => {
  const app = await setup({ limit: 1 });
  const first = await invoke("start", {
    requestId: "envelope-first",
    projectId: null,
    text: "信封甲",
  });
  await app.holdReply("信封甲");
  const second = await invoke("start", {
    requestId: "envelope-second",
    projectId: null,
    text: "信封乙",
  });

  // 入队即推送：信封 activity 带 queued，事件携带全局队列快照
  const events = app.delivered.filter(
    (envelope) =>
      envelope.taskId === second.id &&
      (envelope.event as any).type === "task-queue-changed"
  );
  expect(events.length).toBeGreaterThanOrEqual(1);
  expect(events.at(-1)!.activity.queued).toBe(true);
  expect((events.at(-1)!.event as any).reason).toBe("enqueue");
  expect(
    (events.at(-1)!.event as any).queue.map((item: any) => item.taskId)
  ).toEqual([second.id]);

  // 空位开跑：dequeue 信封到达、queued 撤销
  await app.finish("信封甲");
  await waitFor(() => expect(app.hasRequest("信封乙")).toBe(true));
  const dequeued = app.delivered.filter(
    (envelope) =>
      envelope.taskId === second.id &&
      (envelope.event as any).type === "task-queue-changed" &&
      (envelope.event as any).reason === "dequeue"
  );
  expect(dequeued.length).toBeGreaterThanOrEqual(1);
  expect(dequeued.at(-1)!.activity.queued).toBe(false);
  await app.finish("信封乙");
}, 30_000);
