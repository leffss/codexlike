import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
 * 任务级模型选择的 IPC 面（票 02，ADR 0024 二元组）：tasks.send / tasks.compact
 * 携带 model（Profile 引用之外的第二元），主进程解析后传给 agent-task——
 * 外部可观察结果：OpenAI 兼容端点收到的请求体 model 字段与任务记录落库值。
 * Seam：registerTaskHandlers 的 IPC 通道 + mock HTTP 端点 + manager 任务记录。
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

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "task-model-ipc-"));
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
  /** 端点收到的 chat/completions 请求体（按到达顺序） */
  const requestBodies: { model: string; messages: unknown[] }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requestBodies.push({ model: parsed.model, messages: parsed.messages });
      const text = parsed.messages.findLast(
        (message: { role: string }) => message.role === "user"
      ).content;
      if (parsed.stream !== true) {
        // 非流式（compact 的 generateText）：返回 chat.completion JSON
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "mock",
            object: "chat.completion",
            created: 0,
            model: parsed.model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: `摘要 ${text}` },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      res.write(
        `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: parsed.model, choices: [{ index: 0, delta: { content: `已收到 ${text}` }, finish_reason: null }] })}\n\n`
      );
      res.end(
        `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: parsed.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`
      );
    });
  });
  const mockPort = await listenMock(server);
  cleanup.push(() => {
    server.close();
    server.closeAllConnections();
  });
  const profile = await profiles.create({
    name: "多模型",
    models: ["mock-first", "mock-second"],
    apiKey: "test",
    baseURL: `http://127.0.0.1:${mockPort}/v1`,
  });
  const window = {
    isDestroyed: () => false,
    webContents: {
      send: (_channel: string, envelope: TaskEventEnvelope) => envelope,
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
  const record = await invoke("start", {
    requestId: "req-1",
    projectId: null,
    text: "第一条",
    workspacePath: workspace,
  });
  // 收尾先中断运行中的任务再关库（与 task-queue-ipc.test.ts 同款）：避免
  // 事件流尾部在 store close 后写库造成 unhandled rejection
  cleanup.push(async () => {
    for (const task of manager.list()) invoke("interrupt", task.id);
    await waitFor(() =>
      expect(
        manager.list().every((task) => !invoke("execution", task.id)?.running)
      ).toBe(true)
    );
  });
  return { invoke, manager, profile, requestBodies, record, persistence };
}

describe("tasks.send / tasks.compact 携带任务级 model（票 02 二元组）", () => {
  it("send 传 model：端点请求体用该模型，任务记录落库 (profileId, model)", async () => {
    const { invoke, profile, requestBodies, manager, record } = await setup();
    // start 首条已产生请求 0（未传 model → 第一项）；第二条带 mock-second
    await invoke(
      "send",
      record.id,
      "第二条",
      profile.id,
      undefined,
      undefined,
      undefined,
      "mock-second"
    );
    await waitFor(() => expect(requestBodies.length).toBeGreaterThan(1));
    expect(requestBodies[1]?.model).toBe("mock-second");
    expect(manager.get(record.id)?.record.model).toBe("mock-second");
    expect(manager.get(record.id)?.record.providerProfileId).toBe(profile.id);
  });

  it("send 不传 model：端点请求体回退 Profile 列表第一项（兼容）", async () => {
    const { invoke, profile, requestBodies, manager, record } = await setup();
    // start 首条同样未传 model：两轮请求都用列表第一项
    await invoke("send", record.id, "你好", profile.id);
    await waitFor(() => expect(requestBodies.length).toBeGreaterThan(1));
    expect(requestBodies.map((body) => body.model)).toEqual([
      "mock-first",
      "mock-first",
    ]);
    expect(manager.get(record.id)?.record.model).toBe("mock-first");
  });

  it("compact 传 model：压缩请求体用该模型", async () => {
    const { invoke, profile, requestBodies, record } = await setup();
    await invoke("send", record.id, "第一轮", profile.id);
    await waitFor(() => expect(requestBodies.length).toBeGreaterThan(0));
    await invoke("send", record.id, "第二轮", profile.id);
    await waitFor(() => expect(requestBodies.length).toBeGreaterThan(1));
    await invoke("send", record.id, "第三轮", profile.id);
    await waitFor(() => expect(requestBodies.length).toBeGreaterThan(2));
    await invoke("send", record.id, "第四轮", profile.id);
    await waitFor(() => expect(requestBodies.length).toBeGreaterThan(3));
    // 等任务空闲再压缩（发送返回只代表请求已到达端点，回复可能仍在流式收尾）
    await waitFor(() =>
      expect(invoke("execution", record.id)?.running).toBe(false)
    );
    const before = requestBodies.length;
    await invoke("compact", record.id, profile.id, "mock-second");
    await waitFor(() => expect(requestBodies.length).toBe(before + 1));
    expect(requestBodies[requestBodies.length - 1]?.model).toBe("mock-second");
  });
});
