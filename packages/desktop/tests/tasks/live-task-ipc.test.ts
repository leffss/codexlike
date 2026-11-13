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
// vi.waitFor 默认 1000ms 低于并行负载下 mock 一轮的实际耗时；条件均为终态
// 信号，预算对齐用例上限内（见 workbench-ipc.test.ts 同说明）。
const waitFor = (check: () => unknown) => vi.waitFor(check, { timeout: 4000 });
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "live-task-ipc-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "project");
  mkdirSync(workspace);
  const persistence = createSqliteTaskStore(
    join(root, "nested", "sessions.db")
  );
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
    model: "mock",
    apiKey: "test",
    baseURL: `http://127.0.0.1:${mockPort}/v1`,
  });
  const delivered: TaskEventEnvelope[] = [];
  // 任务→任务改名（票 03）：事件流双发 task:events 与 session:events，两侧序列必须一致。
  const deliveredOnTaskChannel: TaskEventEnvelope[] = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, envelope: TaskEventEnvelope) => {
        if (channel === "session:events")
          delivered.push(structuredClone(envelope));
        else if (channel === "task:events")
          deliveredOnTaskChannel.push(structuredClone(envelope));
      },
    },
  } as unknown as BrowserWindow;
  registerTaskHandlers({
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
  return { profile, project, frame, delivered, deliveredOnTaskChannel };
}

it("运行期思考随现场恢复但不扩大历史持久化范围，等待工具可从统一现场取得", async () => {
  const app = await setup();
  const a = await invoke("start", {
    requestId: "thinking",
    projectId: null,
    text: "思考任务",
  });
  await app.frame("思考任务", {
    reasoning_content: "只存在运行期的思考",
    content: "正文",
  });
  await app.frame(
    "思考任务",
    {
      tool_calls: [
        {
          index: 0,
          id: "write",
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({ path: "a.txt", content: "成果" }),
          },
        },
      ],
    },
    "tool_calls"
  );
  await waitFor(() =>
    expect(invoke("view", a.id).activity.waitingForUser).toBe(true)
  );
  const view = invoke("view", a.id);
  expect(view.pendingInteractions).toHaveLength(1);
  expect(
    view.events.find((envelope: any) => envelope.event.type === "tool-call")
      .event.call
  ).toMatchObject({
    toolName: "write_file",
    arguments: '{"path":"a.txt","content":"成果"}',
  });
  expect(JSON.stringify(view)).toContain("只存在运行期的思考");
  // 执行中（终态未落库）：持久化历史不含本轮思考——快照固定于执行起点
  expect(JSON.stringify(invoke("messages", a.id))).not.toContain(
    "只存在运行期的思考"
  );
  invoke("interrupt", a.id);
  await waitFor(() => expect(invoke("execution", a.id).running).toBe(false));
  expect(invoke("view", a.id).pendingInteractions).toEqual([]);
  expect(
    invoke("view", a.id).events.find(
      (envelope: any) => envelope.event.type === "tool-result"
    ).event.call.isError
  ).toBe(true);
  expect(
    invoke(
      "respond-interaction",
      a.id,
      view.pendingInteractions[0].request.id,
      { kind: "approval", decision: "approve" }
    )
  ).toBe(false);
  // 中断终态落库（票 02）：思考全文随终态消息的 reasoning 字段持久化，
  // 消息正文（content，即模型上下文来源）仍不含思考
  await waitFor(() =>
    expect(
      invoke("messages", a.id).some(
        (item: any) => item.message?.aborted === true
      )
    ).toBe(true)
  );
  const finalMessages: any[] = invoke("messages", a.id);
  const interrupted = finalMessages.find(
    (item) => item.kind === "message" && item.message.aborted === true
  )?.message;
  expect(interrupted?.reasoning).toBe("只存在运行期的思考");
  expect(interrupted?.content).not.toContain("只存在运行期的思考");
  // 事件流双发（票 03）：task:events 与 session:events 收到完全一致的信封序列
  expect(app.deliveredOnTaskChannel).toEqual(app.delivered);
});

it("启动前失败不覆盖上一轮现场与水位，重试仍沿原序号递增", async () => {
  const app = await setup();
  const a = await invoke("start", {
    requestId: "retry-live",
    projectId: null,
    text: "上一轮",
  });
  await app.frame("上一轮", { content: "上一轮结果" }, "stop");
  await waitFor(() => expect(invoke("execution", a.id).running).toBe(false));
  const before = invoke("view", a.id);
  await expect(
    invoke("send", a.id, "$missing-skill 启动失败", app.profile.id)
  ).rejects.toThrow();
  expect(invoke("view", a.id)).toEqual(before);
  await invoke("send", a.id, "重试成功", app.profile.id);
  expect(invoke("view", a.id).sequence).toBeGreaterThan(before.sequence);
  await app.frame("重试成功", { content: "重试结果" }, "stop");
  await waitFor(() => expect(invoke("execution", a.id).running).toBe(false));
});

it("显式停止立即标记中断，迟到正文不复活现场，继续发送使用新 executionId", async () => {
  const app = await setup();
  const a = await invoke("start", {
    requestId: "stop",
    projectId: null,
    text: "停止任务",
  });
  await app.frame("停止任务", { content: "保留部分" });
  await waitFor(() =>
    expect(JSON.stringify(invoke("view", a.id))).toContain("保留部分")
  );
  const executionId = invoke("view", a.id).executionId;
  expect(invoke("interrupt", a.id)).toBe(true);
  expect(invoke("view", a.id).activity).toMatchObject({
    running: false,
    waitingForUser: false,
    outcome: "interrupted",
  });
  await app.frame("停止任务", { content: "迟到污染" }, "stop");
  await waitFor(() => expect(invoke("execution", a.id).running).toBe(false));
  expect(JSON.stringify(invoke("view", a.id))).not.toContain("迟到污染");
  await invoke("send", a.id, "继续任务", app.profile.id);
  expect(invoke("view", a.id).executionId).not.toBe(executionId);
  await app.frame("继续任务", { content: "新的现场" }, "stop");
  await waitFor(() => expect(invoke("execution", a.id).running).toBe(false));
  expect(invoke("view", a.id).activity.outcome).toBe("completed");
  expect(JSON.stringify(invoke("view", a.id))).not.toContain("迟到污染");
});

it("完成未查看与执行状态分离，旧水位查看不会吞掉后来的完成提醒", async () => {
  const app = await setup();
  const a = await invoke("start", {
    requestId: "read",
    projectId: null,
    text: "读取任务",
  });
  const before = invoke("view", a.id);
  await app.frame("读取任务", { content: "完成结果" }, "stop");
  await waitFor(() => expect(invoke("execution", a.id).running).toBe(false));
  expect(invoke("list")[0].activity).toMatchObject({
    outcome: "completed",
    unread: true,
    running: false,
  });
  invoke("mark-viewed", a.id, before.sequence);
  expect(invoke("list")[0].activity.unread).toBe(true);
  const view = invoke("view", a.id);
  invoke("mark-viewed", a.id, view.sequence);
  expect(invoke("view", a.id).activity).toMatchObject({
    outcome: "completed",
    unread: false,
    running: false,
  });
  expect(() => invoke("mark-viewed", a.id, view.sequence + 1)).toThrow("水位");
});

it("模型未结束时公开现场包含后台完整增量，快照水位可无漏无重衔接两个任务", async () => {
  const app = await setup();
  const a = await invoke("start", {
    requestId: "a",
    projectId: app.project.id,
    text: "任务A",
  });
  const b = await invoke("start", {
    requestId: "b",
    projectId: null,
    text: "任务B",
  });
  await app.frame("任务A", { content: "A第一段" });
  await app.frame("任务B", { content: "B独立输出" });
  await waitFor(() => {
    expect(
      invoke("view", a.id)
        .events.filter((item: any) => item.event.type === "assistant-delta")
        .map((item: any) => item.event.delta)
        .join("")
    ).toBe("A第一段");
  });
  const snapshot = invoke("view", a.id);
  expect(snapshot.activity.running).toBe(true);
  expect(snapshot.executionId).toBe(invoke("execution", a.id).executionId);
  expect(
    invoke("messages", a.id).filter(
      (item: any) => item.message?.role === "assistant"
    )
  ).toHaveLength(0);
  await app.frame("任务A", { content: "A第二段" });
  await waitFor(() =>
    expect(invoke("view", a.id).sequence).toBeGreaterThan(snapshot.sequence)
  );
  const next = invoke("view", a.id);
  const joined = [
    ...snapshot.events,
    ...app.delivered.filter(
      (item) => item.sessionId === a.id && item.sequence > snapshot.sequence
    ),
  ];
  expect(
    joined
      .filter((item: any) => item.event.type === "assistant-delta")
      .map((item: any) => item.event.delta)
      .join("")
  ).toBe("A第一段A第二段");
  expect(
    next.events.every(
      (item: any) =>
        item.sessionId === a.id && item.executionId === snapshot.executionId
    )
  ).toBe(true);
  expect(JSON.stringify(next)).not.toContain("B独立输出");
  await app.frame("任务A", {}, "stop");
  await app.frame("任务B", {}, "stop");
  await waitFor(() =>
    expect(
      invoke("execution", a.id).running || invoke("execution", b.id).running
    ).toBe(false)
  );
});
