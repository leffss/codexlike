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
import { createApplicationExit } from "../../src/lifecycle/application-exit";
import { createSqliteInputQueueStore } from "../../src/tasks/input-queue-store";
import { registerTaskHandlers } from "../../src/tasks/task-ipc";
import { listenMock } from "./mock-server";

// 接缝：真实任务 IPC / 退出生命周期；只替换 Electron 通道与外部模型、系统加密。
// 同一 SQLite 文件的两个生产连接实际关闭再重开，不借助 SQL 查询判断恢复状态。
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
  const handler = handlers.get(`sessions:${name}`);
  if (!handler) throw new Error(`未注册通道 sessions:${name}`);
  return handler({}, ...args);
}
const waitFor = (check: () => unknown) => vi.waitFor(check, { timeout: 8000 });

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "input-queue-restart-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  // 父目录刻意不存在，两个生产 store 必须自行建目录。
  const dbPath = join(root, "fresh", "session-workbench.db");
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
  let credentialsGate: Promise<void> | undefined;
  let readingCredentials: (() => void) | undefined;
  const profiles = createProfileStore({
    dir: root,
    safeStorage: {
      isEncryptionAvailable: async () => true,
      encryptString: async (text) => Buffer.from(text),
      decryptString: async (bytes) => {
        readingCredentials?.();
        await credentialsGate;
        return bytes.toString();
      },
    },
  });
  function holdCredentials() {
    let release!: () => void;
    credentialsGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      readingCredentials = resolve;
    });
    cleanup.push(release);
    return { entered, release };
  }
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
    const manager = createTaskManager({ persistence, resourcesFor });
    const runtime = registerTaskHandlers({
      manager,
      profiles,
      getWindow: () => null,
      dataDir: root,
      queueStore,
      resourcesFor,
      worktreeService: createWorktreeService({
        worktreesDir: join(root, "worktrees"),
      }),
    });
    const exit = createApplicationExit({
      runtime,
      publish: () => {},
      finish: () => {},
    });
    let closed = false;
    async function close() {
      if (closed) return;
      runtime.freeze();
      await runtime.stopAndDrain();
      queueStore.close();
      persistence.close();
      closed = true;
      handlers.clear();
    }
    cleanup.push(close);
    return { runtime, exit, close };
  }
  async function reply(text: string, finish = true) {
    await waitFor(() => expect(responses.has(text)).toBe(true));
    const res = responses.get(text)!;
    res.write(
      `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: { content: `${text}的回答` }, finish_reason: null }] })}\n\n`
    );
    if (finish) {
      res.write(
        `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`
      );
      res.end("data: [DONE]\n\n");
    }
  }
  async function start(text: string) {
    const record = await invoke("start", {
      requestId: text,
      projectId: null,
      text,
      providerProfileId: profile.id,
    });
    await waitFor(() => expect(requests).toContain(text));
    return record.id as string;
  }
  return { open, profile, profiles, requests, reply, start, holdCredentials };
}

it("真实 SQLite 重开后由启动入口逐条消费，未创建窗口或查看任务也能推进", async () => {
  const app = await setup();
  const first = app.open();
  const id = await app.start("退出前执行");
  await invoke("send", id, "恢复第一条", app.profile.id);
  await invoke("send", id, "恢复第二条", app.profile.id);
  const before = invoke("view", id).queueState.queue;
  await first.close();

  const reopened = app.open();
  // 注册服务不等于服务就绪；主进程显式启用前不得自动请求模型。
  expect(app.requests).toEqual(["退出前执行"]);
  expect(invoke("view", id).queueState.queue).toEqual(before);
  expect(invoke("view", id).queueState.paused).toBe(false);
  reopened.runtime.startInputQueues();
  // 恢复后不再调用 view/hydration；外部模型收到请求独立证明后台执行。
  await app.reply("恢复第一条", false);
  expect(app.requests).toEqual(["退出前执行", "恢复第一条"]);
  await app.reply("恢复第一条");
  await app.reply("恢复第二条");
  await waitFor(() => expect(reopened.runtime.hasWork()).toBe(false));
  expect(invoke("view", id).queueState.queue).toEqual([]);
  expect(
    invoke("messages", id)
      .filter((item: any) => item.message?.role === "user")
      .map((item: any) => item.message.content)
  ).toEqual(["退出前执行", "恢复第一条", "恢复第二条"]);
}, 30_000);

it("失效 Profile 的任务只保留自己的队首，不阻塞其他任务恢复消费", async () => {
  const app = await setup();
  const doomed = await app.profiles.create({
    name: "重启前删除的模型",
    model: "mock",
    apiKey: "test",
    baseURL: "http://127.0.0.1:1/v1",
  });
  const first = app.open();
  const failing = await app.start("失败任务首轮");
  const healthy = await app.start("正常任务首轮");
  await invoke("send", failing, "失效快照排队", doomed.id);
  await invoke("send", healthy, "正常快照排队", app.profile.id);
  await first.close();
  expect(await app.profiles.remove(doomed.id)).toBe(true);

  const reopened = app.open();
  reopened.runtime.startInputQueues();
  await app.reply("正常快照排队");
  await waitFor(() => expect(reopened.runtime.hasWork()).toBe(false));
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(app.requests).not.toContain("失效快照排队");
  expect(
    invoke("view", failing).queueState.queue.map((entry: any) => entry.text)
  ).toEqual(["失效快照排队"]);
  expect(invoke("view", failing).queueState.paused).toBe(false);
  expect(invoke("view", healthy).queueState.queue).toEqual([]);
}, 30_000);

it("启动恢复仍等待凭据时退出必须排空该发送，不能先关库或发出模型请求", async () => {
  const app = await setup();
  const first = app.open();
  const id = await app.start("凭据门控前执行");
  await invoke("send", id, "仍在解密的队首", app.profile.id);
  const before = invoke("view", id).queueState.queue;
  await first.close();

  const reopened = app.open();
  const gate = app.holdCredentials();
  reopened.runtime.startInputQueues();
  await gate.entered;
  expect(app.requests).toEqual(["凭据门控前执行"]);
  reopened.exit.request();
  expect(reopened.exit.state().phase).toBe("confirming");
  reopened.exit.answer(reopened.exit.state().id, true);
  let drained = false;
  const stopping = reopened.exit.flushed(reopened.exit.state().id).then(() => {
    drained = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(drained).toBe(false);
  gate.release();
  await stopping;
  expect(reopened.exit.state().phase).toBe("ready");
  expect(invoke("view", id).queueState.queue).toEqual(before);
  expect(invoke("view", id).queueState.paused).toBe(false);
  expect(app.requests).toEqual(["凭据门控前执行"]);
}, 30_000);

it("正常退出中断插话不清除用户暂停，重开后保持原队列并可手动恢复", async () => {
  const app = await setup();
  const first = app.open();
  const id = await app.start("用户准备停止");
  await invoke("send", id, "暂停保留一", app.profile.id);
  await invoke("send", id, "暂停保留二", app.profile.id);
  invoke("interrupt", id);
  await waitFor(() => expect(first.runtime.hasWork()).toBe(false));
  const before = invoke("view", id).queueState.queue;
  expect(invoke("view", id).queueState.paused).toBe(true);
  await invoke("send", id, "未完成的插话", app.profile.id);
  await app.reply("未完成的插话", false);
  first.exit.request();
  first.exit.answer(first.exit.state().id, true);
  await first.exit.flushed(first.exit.state().id);
  expect(first.exit.state().phase).toBe("ready");
  await first.close();

  const reopened = app.open();
  reopened.runtime.startInputQueues();
  expect(invoke("view", id).queueState.paused).toBe(true);
  expect(invoke("view", id).queueState.queue).toEqual(before);
  expect(app.requests).toEqual(["用户准备停止", "未完成的插话"]);
  invoke("queue-resume", id);
  await app.reply("暂停保留一");
  await app.reply("暂停保留二");
  await waitFor(() => expect(reopened.runtime.hasWork()).toBe(false));
  expect(invoke("view", id).queueState.queue).toEqual([]);
  expect(invoke("view", id).queueState.paused).toBe(false);
}, 30_000);

it("取消退出不能把仍在进行的插话当作完成，暂停直到本轮真正结束", async () => {
  const app = await setup();
  const host = app.open();
  const id = await app.start("插话前执行");
  await invoke("send", id, "插话后排队", app.profile.id);
  invoke("interrupt", id);
  await waitFor(() => expect(host.runtime.hasWork()).toBe(false));
  await invoke("send", id, "正在插话", app.profile.id);
  await app.reply("正在插话", false);
  host.exit.request();
  host.exit.answer(host.exit.state().id, false);
  expect(invoke("view", id).queueState.paused).toBe(true);
  expect(app.requests).toEqual(["插话前执行", "正在插话"]);
  await app.reply("正在插话");
  await app.reply("插话后排队");
  await waitFor(() => expect(host.runtime.hasWork()).toBe(false));
  expect(invoke("view", id).queueState.paused).toBe(false);
}, 30_000);

it("退出确认期间回复完成也不消费队首，取消退出后无需查看即可继续", async () => {
  const app = await setup();
  const host = app.open();
  host.runtime.startInputQueues();
  const id = await app.start("退出确认中的执行");
  await invoke("send", id, "取消退出后消费", app.profile.id);
  host.exit.request();
  expect(host.exit.state().phase).toBe("confirming");
  await app.reply("退出确认中的执行");
  await waitFor(() => expect(invoke("execution", id).running).toBe(false));
  expect(app.requests).toEqual(["退出确认中的执行"]);
  expect(invoke("view", id).queueState.paused).toBe(false);
  expect(
    invoke("view", id).queueState.queue.map((entry: any) => entry.text)
  ).toEqual(["取消退出后消费"]);

  host.exit.answer(host.exit.state().id, false);
  await app.reply("取消退出后消费");
  await waitFor(() => expect(host.runtime.hasWork()).toBe(false));
  expect(invoke("view", id).queueState.queue).toEqual([]);
}, 30_000);
