import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createAgentResourceSnapshot,
  createBuiltinTools,
  DEFAULT_TASK_CONCURRENCY_LIMIT,
  createTaskManager,
  createSqliteTaskStore,
  createWorktreeService,
} from "@codexlike/agent-core/node";
import { registerTaskHandlers } from "../../src/tasks/task-ipc";
import { createSqliteInputQueueStore } from "../../src/tasks/input-queue-store";
import { createSqliteTaskQueueStore } from "../../src/tasks/task-queue-store";
import { createApplicationExit } from "../../src/lifecycle/application-exit";
import { createProfileStore } from "../../src/profiles/profile-store";
import { createLiveTasks } from "../../src/tasks/live-tasks";
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
  for (const fn of cleanup.splice(0).reverse()) await fn();
  handlers.clear();
});
function invoke(name: string, ...args: unknown[]): any {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`未注册通道 ${name}`);
  return handler({}, ...args);
}
// vi.waitFor 默认 1000ms 低于并行负载下 mock 一轮的实际耗时；条件均为终态
// 信号，预算对齐用例上限内（见 workbench-ipc.test.ts 同说明）。
const waitFor = (check: () => unknown) => vi.waitFor(check, { timeout: 4000 });
async function setup(options?: { limit?: number }) {
  const root = mkdtempSync(join(tmpdir(), "exit-recovery-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "project");
  mkdirSync(workspace);
  const dbPath = join(root, "fresh", "tasks.db");
  const persistence = createSqliteTaskStore(dbPath);
  const queueStore = createSqliteInputQueueStore(dbPath);
  const taskQueueStore = createSqliteTaskQueueStore(dbPath);
  let closed = false;
  const close = () => {
    if (!closed) {
      taskQueueStore.close();
      queueStore.close();
      persistence.close();
      closed = true;
    }
  };
  cleanup.push(close);
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
  let requests = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      requests++;
      const text = JSON.parse(body).messages.findLast(
        (m: any) => m.role === "user"
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
    name: "退出模型",
    models: ["mock"],
    apiKey: "test",
    baseURL: `http://127.0.0.1:${mockPort}/v1`,
  });
  const runtime = registerTaskHandlers({
    manager,
    profiles,
    getWindow: () => null,
    dataDir: root,
    queueStore,
    taskQueueStore,
    concurrencyLimit: () => options?.limit ?? DEFAULT_TASK_CONCURRENCY_LIMIT,
    worktreeService: createWorktreeService({
      worktreesDir: join(root, "worktrees"),
    }),
    resourcesFor,
  });
  let finished = false;
  const exit = createApplicationExit({
    runtime,
    publish: () => {},
    finish: () => {
      finished = true;
    },
  });
  cleanup.push(async () => {
    if (!closed) {
      runtime.freeze();
      await runtime.stopAndDrain();
    }
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
  return {
    root,
    dbPath,
    close,
    persistence,
    manager,
    profile,
    project,
    frame,
    exit,
    runtime,
    finished: () => finished,
    requests: () => requests,
  };
}

it("退出检测后台项目执行与独立等待；取消不停止，确认后必须等待保存屏障再中断", async () => {
  const app = await setup();
  const a = await invoke("tasks:start", {
    requestId: "a",
    projectId: app.project.id,
    text: "后台慢任务",
  });
  const b = await invoke("tasks:start", {
    requestId: "b",
    projectId: null,
    text: "独立等待",
  });
  await app.frame("后台慢任务", { content: "已生成部分" });
  await app.frame(
    "独立等待",
    {
      tool_calls: [
        {
          index: 0,
          id: "write",
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({
              path: "pending.txt",
              content: "不应写入",
            }),
          },
        },
      ],
    },
    "tool_calls"
  );
  await waitFor(() =>
    expect(invoke("tasks:view", b.id).activity.waitingForUser).toBe(true)
  );
  const request = invoke("tasks:pending-interactions", b.id)[0].request;
  app.exit.request();
  const first = app.exit.state();
  expect(first.phase).toBe("confirming");
  expect(invoke("tasks:execution", a.id).running).toBe(true);
  expect(invoke("tasks:pending-interactions", b.id)).toHaveLength(1);
  await expect(
    invoke("tasks:send", a.id, "退出竞态", app.profile.id)
  ).rejects.toThrow("正在退出");
  expect(() =>
    invoke("tasks:respond-interaction", b.id, request.id, {
      kind: "approval",
      decision: "approve",
    })
  ).toThrow("正在退出");
  app.exit.answer(first.id, false);
  expect(app.exit.state().phase).toBe("idle");
  await app.frame("后台慢任务", { content: "取消后继续生成" });
  await waitFor(() =>
    expect(JSON.stringify(invoke("tasks:view", a.id))).toContain(
      "取消后继续生成"
    )
  );
  expect(invoke("tasks:pending-interactions", b.id)).toHaveLength(1);
  app.exit.request();
  const second = app.exit.state();
  app.exit.answer(first.id, true);
  expect(app.exit.state().phase).toBe("confirming");
  app.exit.answer(second.id, true);
  expect(app.exit.state().phase).toBe("flushing");
  expect(app.finished()).toBe(false);
  expect(invoke("tasks:execution", a.id).running).toBe(true);
  await app.exit.flushed(second.id);
  expect(app.finished()).toBe(true);
  expect(invoke("tasks:execution", a.id).running).toBe(false);
  expect(invoke("tasks:pending-interactions", b.id)).toEqual([]);
  expect(app.manager.messages(a.id).at(-1)).toMatchObject({
    aborted: true,
    content: "已生成部分取消后继续生成",
  });
  const count = app.requests();
  app.close();
  const reopened = createSqliteTaskStore(app.dbPath);
  cleanup.push(() => reopened.close());
  const restored = createTaskManager({ persistence: reopened });
  const live = createLiveTasks(restored);
  expect(live.view(a.id)?.activity).toMatchObject({
    running: false,
    outcome: "interrupted",
  });
  expect(
    restored.get(b.id)?.respondInteraction(request.id, {
      kind: "approval",
      decision: "approve",
    })
  ).toBe(false);
  expect(
    restored.transcript(b.id).filter((item) => item.kind === "interaction")[0]
  ).toMatchObject({ interaction: { status: "cancelled" } });
  expect(app.requests()).toBe(count);
});

it("保存失败保留窗口与任务，返回后仍可取消等待；旧保存回执不能完成下一次退出", async () => {
  const app = await setup();
  const task = await invoke("tasks:start", {
    requestId: "save-error",
    projectId: null,
    text: "保存失败任务",
  });
  await app.frame("保存失败任务", { content: "继续保留" });
  app.exit.request();
  const id = app.exit.state().id;
  app.exit.answer(id, true);
  await app.exit.flushed(id, "磁盘不可写");
  expect(app.exit.state()).toMatchObject({
    phase: "error",
    error: expect.stringContaining("磁盘不可写"),
  });
  expect(app.finished()).toBe(false);
  expect(invoke("tasks:execution", task.id).running).toBe(true);
  app.exit.request();
  app.exit.answer(app.exit.state().id, true);
  await app.exit.flushed(id);
  expect(app.exit.state().phase).toBe("flushing");
  expect(app.finished()).toBe(false);
  await app.exit.flushed(app.exit.state().id);
  expect(app.finished()).toBe(true);
});

it.each(["取消退出", "保存失败"] as const)(
  "F05 %s 解冻后，冻结期间已空出的名额自动开跑排队队首",
  async (reason) => {
    const app = await setup({ limit: 1 });
    const running = await invoke("tasks:start", {
      requestId: "thaw-running",
      projectId: null,
      text: "冻结前占坑",
    });
    await app.frame("冻结前占坑", { content: "尚未结束" });
    const queued = await invoke("tasks:start", {
      requestId: "thaw-queued",
      projectId: null,
      text: "解冻后排队任务",
    });
    app.exit.request();
    const id = app.exit.state().id;
    expect(app.exit.state().phase).toBe("confirming");
    if (reason === "保存失败") app.exit.answer(id, true);
    await app.frame("冻结前占坑", {}, "stop");
    await waitFor(() => expect(app.runtime.hasWork()).toBe(false));
    expect(invoke("tasks:execution", running.id).running).toBe(false);
    expect(invoke("tasks:view", queued.id).activity.queued).toBe(true);
    expect(app.requests()).toBe(1);

    if (reason === "取消退出") app.exit.answer(id, false);
    else await app.exit.flushed(id, "注入保存失败");
    expect(app.finished()).toBe(false);
    await waitFor(() => expect(app.requests()).toBe(2));
    expect(invoke("tasks:view", queued.id).activity.queued).toBe(false);
    expect(invoke("tasks:execution", queued.id).running).toBe(true);
    await app.frame("解冻后排队任务", { content: "解冻后完成" }, "stop");
    await waitFor(() => expect(app.runtime.hasWork()).toBe(false));
  },
  15_000
);

it("退出提示期间不提前取消已接收的准备任务，取消退出后首次发送继续", async () => {
  const app = await setup();
  let settled = false;
  const start = invoke("tasks:start", {
    requestId: "cancel-preparing",
    projectId: app.project.id,
    text: "准备中取消退出",
  }).finally(() => {
    settled = true;
  });
  void start.catch(() => {});
  app.exit.request();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(settled).toBe(false);
  expect(app.requests()).toBe(0);
  app.exit.answer(app.exit.state().id, false);
  const task = await start;
  await app.frame("准备中取消退出", { content: "任务仍正常开始" }, "stop");
  await waitFor(() =>
    expect(invoke("tasks:execution", task.id).running).toBe(false)
  );
  expect(app.manager.messages(task.id).at(-1)?.content).toBe("任务仍正常开始");
});

it("退出闸门拦住已到达但仍等待profile的首次发送和后续发送，不创建空历史或模型请求", async () => {
  const app = await setup();
  const existing = app.manager.create({
    workspacePath: app.project.workspacePath,
  });
  const start = invoke("tasks:start", {
    requestId: "late-start",
    projectId: app.project.id,
    text: "迟到新建",
  }).catch((error: Error) => error);
  const send = invoke(
    "tasks:send",
    existing.id,
    "迟到发送",
    app.profile.id
  ).catch((error: Error) => error);
  app.exit.request();
  expect(app.exit.state().phase).toBe("confirming");
  const id = app.exit.state().id;
  app.exit.answer(id, true);
  await app.exit.flushed(id);
  expect(await start).toMatchObject({
    message: expect.stringContaining("正在退出"),
  });
  expect(await send).toMatchObject({
    message: expect.stringContaining("正在退出"),
  });
  expect(app.manager.list()).toHaveLength(1);
  expect(app.manager.messages(existing.id)).toEqual([]);
  expect(app.requests()).toBe(0);
  expect(app.finished()).toBe(true);
});

it("Compact也参与退出确认与中断，退出不替换未完成的压缩历史", async () => {
  const app = await setup();
  const task = await invoke("tasks:start", {
    requestId: "compact",
    projectId: null,
    text: "第0轮",
  });
  await app.frame("第0轮", { content: "第0轮答复" }, "stop");
  await waitFor(() =>
    expect(invoke("tasks:execution", task.id).running).toBe(false)
  );
  for (let i = 1; i < 4; i++) {
    await invoke("tasks:send", task.id, `第${i}轮`, app.profile.id);
    await app.frame(`第${i}轮`, { content: `第${i}轮答复` }, "stop");
    await waitFor(() =>
      expect(invoke("tasks:execution", task.id).running).toBe(false)
    );
  }
  const before = app.manager.messages(task.id);
  const compact = invoke("tasks:compact", task.id, app.profile.id).catch(
    (error: Error) => error
  );
  await waitFor(() => expect(app.requests()).toBe(5));
  app.exit.request();
  expect(app.exit.state().phase).toBe("confirming");
  const id = app.exit.state().id;
  app.exit.answer(id, true);
  await app.exit.flushed(id);
  expect(await compact).toBeInstanceOf(Error);
  expect(app.manager.messages(task.id).slice(0, before.length)).toEqual(before);
  expect(app.manager.messages(task.id).at(-1)).toMatchObject({
    aborted: true,
  });
  expect(app.finished()).toBe(true);
});

it("异常结束的持久执行归一为中断；二次重开不重复追加标记或自动构造模型", async () => {
  const app = await setup();
  const task = app.manager.create({
    projectId: app.project.id,
    workspacePath: app.project.workspacePath,
  });
  app.persistence.insertMessage({
    id: "orphan-user",
    taskId: task.id,
    role: "user",
    content: "异常前最后输入",
    createdAt: "2026-11-11T00:00:00.000Z",
  });
  app.persistence.updateTask(task.id, { status: "streaming" });
  app.close();
  for (let i = 0; i < 2; i++) {
    const store = createSqliteTaskStore(app.dbPath);
    try {
      const restored = createTaskManager({
        persistence: store,
        languageModelFor: () => {
          throw new Error("重启不得调用模型");
        },
      });
      expect(createLiveTasks(restored).view(task.id)?.activity).toMatchObject({
        running: false,
        waitingForUser: false,
        outcome: "interrupted",
      });
      expect(restored.messages(task.id)).toHaveLength(2);
      expect(restored.messages(task.id).at(-1)).toMatchObject({
        role: "assistant",
        aborted: true,
      });
      expect(restored.list()[0]?.status).toBe("idle");
    } finally {
      store.close();
    }
  }
});

it("恢复态中断未读提醒（2026-11-19 口径）：重启后 unread，查看一次后熄灭", async () => {
  const app = await setup();
  const task = app.manager.create({
    projectId: app.project.id,
    workspacePath: app.project.workspacePath,
  });
  app.persistence.insertMessage({
    id: "unread-user",
    taskId: task.id,
    role: "user",
    content: "中断前输入",
    createdAt: "2026-11-11T00:00:00.000Z",
  });
  app.persistence.updateTask(task.id, { status: "streaming" });
  app.close();
  const store = createSqliteTaskStore(app.dbPath);
  try {
    const restored = createTaskManager({
      persistence: store,
      languageModelFor: () => {
        throw new Error("重启不得调用模型");
      },
    });
    const live = createLiveTasks(restored);
    // 重启恢复的中断：本会话未查看 → 未读提醒（侧栏「已中断」徽章数据面）
    expect(live.activity(task.id)).toMatchObject({
      outcome: "interrupted",
      unread: true,
    });
    // 无现场水位恒为 0：越界水位仍拒绝；合法水位（view 返回 sequence=0）
    // 记为已查看，提醒熄灭（再次重启重新提醒，会话内不复活）
    expect(() => live.markViewed(task.id, 1)).toThrow("查看水位");
    live.markViewed(task.id, 0);
    expect(live.activity(task.id)).toMatchObject({
      outcome: "interrupted",
      unread: false,
    });
  } finally {
    store.close();
  }
});
