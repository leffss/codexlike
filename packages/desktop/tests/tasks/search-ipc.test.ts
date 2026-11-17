import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createAgentResourceSnapshot,
  createTaskManager,
  createSqliteTaskStore,
  createWorktreeService,
  type ProjectRecord,
  type TaskRecord,
  type TaskSearchResult,
} from "@codexlike/agent-core/node";
import { registerTaskHandlers } from "../../src/tasks/task-ipc";
import { listenMock } from "./mock-server";
import { createProfileStore } from "../../src/profiles/profile-store";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  dialog: {},
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(name, handler),
  },
}));
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  handlers.clear();
});
async function invoke<T>(name: string, ...args: unknown[]): Promise<T> {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`未注册通道 ${name}`);
  return handler({}, ...args) as T;
}
// vi.waitFor 默认 1000ms 低于并行负载下 mock 一轮的实际耗时；条件均为终态
// 信号，预算对齐用例上限内（见 workbench-ipc.test.ts 同说明）。
const waitFor = (check: () => unknown) => vi.waitFor(check, { timeout: 4000 });

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "task-search-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "nested", "home");
  const firstPath = join(root, "项目甲");
  const secondPath = join(root, "项目乙");
  mkdirSync(firstPath);
  mkdirSync(secondPath);
  let store = createSqliteTaskStore(join(home, "task-workbench.db"));
  cleanup.push(() => store.close());
  const profiles = createProfileStore({
    dir: home,
    safeStorage: {
      isEncryptionAvailable: async () => true,
      encryptString: async (text) => Buffer.from(text),
      decryptString: async (bytes) => bytes.toString(),
    },
  });
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: { content: "助手正文：星河检索" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
      );
    });
  });
  const mockPort = await listenMock(server);
  cleanup.push(() => {
    server.close();
    server.closeAllConnections();
  });
  const profile = await profiles.create({
    name: "私密配置名称",
    apiKey: "sk-private-search-secret",
    baseURL: `http://127.0.0.1:${mockPort}/v1`,
    models: ["private-model-config"],
  });
  function register() {
    const resourcesFor = ({ workspacePath }: { workspacePath: string }) =>
      createAgentResourceSnapshot({
        workspacePath,
        globalDir: home,
        compatibleGlobalDir: join(root, "compatible"),
        findGitRoot: () => null,
      });
    const manager = createTaskManager({ persistence: store, resourcesFor });
    registerTaskHandlers({
      manager,
      profiles,
      getWindow: () => null,
      dataDir: home,
      worktreeService: createWorktreeService({
        worktreesDir: join(home, "worktrees"),
      }),
      resourcesFor,
    });
  }
  register();
  const first = await invoke<ProjectRecord>("projects:add", firstPath);
  const second = await invoke<ProjectRecord>("projects:add", secondPath);
  return {
    root,
    first,
    second,
    profile,
    async create(text: string, projectId: string | null) {
      const task = await invoke<TaskRecord>("tasks:start", {
        requestId: text,
        projectId,
        ...(projectId === null ? { workspacePath: firstPath } : {}),
        text,
      });
      await waitFor(async () =>
        expect(await invoke("tasks:execution", task.id)).toMatchObject({
          running: false,
        })
      );
      return task;
    },
    reopen() {
      store.close();
      store = createSqliteTaskStore(join(home, "task-workbench.db"));
      register();
    },
  };
}

it("空输入不返回全库，特殊字符是字面文本，私有配置与目录内容不参与搜索", async () => {
  const app = await setup();
  const task = await app.create("普通正文", null);
  await invoke(
    "tasks:rename",
    task.id,
    "SQL ' OR 1=1 -- 100%_\\路径 [a] MiXeD"
  );
  writeFileSync(join(app.first.workspacePath, "secret.txt"), "磁盘私密关键词");
  for (const query of [
    "",
    "   ",
    "不存在",
    "sk-private-search-secret",
    "private-model-config",
    "私密配置名称",
    "磁盘私密关键词",
    "项目甲",
  ]) {
    expect(await invoke("tasks:search", query, true)).toEqual([]);
  }
  for (const query of [
    "' OR 1=1 --",
    "%_",
    "\\路径",
    "[a]",
    "mixed",
    "  MiXeD  ",
  ]) {
    expect(await invoke("tasks:search", query)).toMatchObject([
      { id: task.id },
    ]);
  }
  expect(await invoke("tasks:search", "' OR 2=2 --")).toEqual([]);
  await expect(invoke("tasks:search", null)).rejects.toThrow("search");
  await expect(invoke("tasks:search", "普通", "false")).rejects.toThrow(
    "search"
  );
});

it("归档默认排除且可选纳入；重命名、归档、恢复与新消息后重新查询读取最新持久内容", async () => {
  const app = await setup();
  const task = await app.create("历史正文", null);
  await invoke("tasks:rename", task.id, "旧标题");
  expect(await invoke("tasks:search", "旧标题")).toHaveLength(1);
  await invoke("tasks:rename", task.id, "新标题");
  expect(await invoke("tasks:search", "旧标题")).toEqual([]);
  await invoke("tasks:archive", task.id, true);
  app.reopen();
  expect(await invoke("tasks:search", "新标题")).toEqual([]);
  const archived = await invoke<TaskSearchResult[]>(
    "tasks:search",
    "新标题",
    true
  );
  expect(archived).toHaveLength(1);
  expect(archived[0]).toMatchObject({
    id: task.id,
    archivedAt: expect.any(String),
  });
  expect(await invoke("tasks:search", "新标题", false)).toEqual([]);
  await invoke("tasks:archive", task.id, false);
  expect(await invoke("tasks:search", "新标题")).toHaveLength(1);
  await invoke("tasks:send", task.id, "后续新增正文", app.profile.id);
  await waitFor(async () =>
    expect(await invoke("tasks:execution", task.id)).toMatchObject({
      running: false,
    })
  );
  expect(await invoke("tasks:search", "后续新增正文")).toMatchObject([
    { id: task.id },
  ]);
});

it("标题与用户/助手正文跨项目和独立归属查询；折叠和真实SQLite重开不影响覆盖", async () => {
  const app = await setup();
  const a = await app.create("初始甲正文", app.first.id);
  const b = await app.create("用户正文唯一线索", app.second.id);
  const c = await app.create("同目录但无项目归属", null);
  await invoke("tasks:rename", a.id, "仅标题流星");
  await invoke("tasks:rename", b.id, "没有关键词的标题");
  await invoke("projects:set-collapsed", app.second.id, true);
  app.reopen();
  expect(await invoke("tasks:search", "仅标题流星")).toEqual([
    {
      id: a.id,
      title: "仅标题流星",
      projectId: app.first.id,
      projectName: "项目甲",
      archivedAt: null,
    },
  ]);
  expect(await invoke("tasks:search", "用户正文唯一线索")).toEqual([
    {
      id: b.id,
      title: "没有关键词的标题",
      projectId: app.second.id,
      projectName: "项目乙",
      archivedAt: null,
    },
  ]);
  expect(await invoke("tasks:search", "同目录但无项目归属")).toEqual([
    {
      id: c.id,
      title: c.title,
      projectId: null,
      projectName: null,
      archivedAt: null,
    },
  ]);
  const results = await invoke<{ id: string }[]>("tasks:search", "星河检索");
  expect(results.map((item) => item.id).sort()).toEqual(
    [a.id, b.id, c.id].sort()
  );
});
