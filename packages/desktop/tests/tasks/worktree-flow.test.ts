import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import {
  createAgentResourceSnapshot,
  createTaskManager,
  createSqliteTaskStore,
  createWorktreeService,
} from "@codexlike/agent-core/node";
import { registerTaskHandlers } from "../../src/tasks/task-ipc";
import { listenMock } from "./mock-server";
import { createProfileStore } from "../../src/profiles/profile-store";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
}));
vi.mock("electron", () => ({
  dialog: {},
  ipcMain: {
    handle: (name: string, handler: (...args: any[]) => any) =>
      handlers.set(name, handler),
  },
}));
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
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
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}
async function setup(hold = false) {
  const root = mkdtempSync(join(tmpdir(), "worktree-start-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const home = join(root, "nested", "home");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@codexlike.local");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "tracked.txt"), "来源内容");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-m", "fixture");
  let store = createSqliteTaskStore(join(home, "session-workbench.db"));
  cleanups.push(() => store.close());
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
      if (hold) {
        res.flushHeaders();
        return;
      }
      res.end(
        `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: { content: "完成" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
      );
    });
  });
  const mockPort = await listenMock(server);
  cleanups.push(() => {
    server.close();
    server.closeAllConnections();
  });
  await profiles.create({
    name: "Mock",
    model: "mock",
    apiKey: "test",
    baseURL: `http://127.0.0.1:${mockPort}/v1`,
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
    return manager;
  }
  const manager = register();
  return {
    root,
    repo,
    home,
    manager,
    reopen() {
      store.close();
      store = createSqliteTaskStore(join(home, "session-workbench.db"));
      register();
    },
  };
}
async function idle(id: string) {
  await waitFor(async () =>
    expect((await invoke("sessions:execution", id)).running).toBe(false)
  );
}

it("共享提示按真实目录识别项目与独立执行，不误报隔离副本也不禁止并行", async () => {
  const app = await setup(true);
  const project = await invoke("projects:add", app.repo);
  const standalone = await invoke("sessions:start", {
    requestId: "shared-a",
    projectId: null,
    workspacePath: app.repo,
    text: "独立执行",
  });
  const target = { projectId: project.id, workspaceMode: "local" };
  expect(await invoke("sessions:workspace-sharing", target)).toMatchObject({
    workspacePath: app.repo,
    runningTasks: [{ id: standalone.id }],
  });
  const alias = join(app.root, "repo-alias");
  symlinkSync(app.repo, alias, "junction");
  expect(
    (
      await invoke("sessions:workspace-sharing", {
        projectId: null,
        workspacePath: alias,
      })
    ).runningTasks.map((item: any) => item.id)
  ).toEqual([standalone.id]);
  const sibling = join(app.root, "repo-other");
  mkdirSync(sibling);
  expect(
    (
      await invoke("sessions:workspace-sharing", {
        projectId: null,
        workspacePath: sibling,
      })
    ).runningTasks
  ).toEqual([]);
  expect(
    (
      await invoke("sessions:workspace-sharing", {
        ...target,
        workspaceMode: "worktree",
      })
    ).runningTasks
  ).toEqual([]);
  const local = await invoke("sessions:start", {
    ...target,
    requestId: "shared-b",
    text: "继续并行",
  });
  expect((await invoke("sessions:execution", standalone.id)).running).toBe(
    true
  );
  expect((await invoke("sessions:execution", local.id)).running).toBe(true);
  expect(
    (
      await invoke("sessions:workspace-sharing", { taskId: local.id })
    ).runningTasks.map((item: any) => item.id)
  ).toEqual([standalone.id]);
  const isolated = await invoke("sessions:start", {
    projectId: project.id,
    workspaceMode: "worktree",
    requestId: "isolated",
    text: "隔离",
  });
  expect(
    (await invoke("sessions:workspace-sharing", { taskId: isolated.id }))
      .runningTasks
  ).toEqual([]);
  for (const record of [standalone, local, isolated]) {
    await invoke("sessions:interrupt", record.id);
    await idle(record.id);
  }
});

it("非Git和Worktree目录创建失败保留用户文件，同请求修复后可重试", async () => {
  const app = await setup();
  const plain = join(app.root, "plain");
  mkdirSync(plain);
  writeFileSync(join(plain, "keep.txt"), "已有文件");
  const project = await invoke("projects:add", plain);
  const request = {
    requestId: "plain-retry",
    projectId: project.id,
    workspaceMode: "worktree",
    text: "处理任务",
  };
  await expect(invoke("sessions:start", request)).rejects.toThrow(
    "不是 git 仓库"
  );
  expect(await invoke("sessions:list")).toEqual([]);
  expect(readFileSync(join(plain, "keep.txt"), "utf8")).toBe("已有文件");
  const local = await invoke("sessions:start", {
    ...request,
    workspaceMode: "local",
  });
  await idle(local.id);
  const gitProject = await invoke("projects:add", app.repo);
  const blocker = join(app.home, "worktrees");
  writeFileSync(blocker, "不可删除的现有文件");
  const retry = {
    ...request,
    requestId: "mkdir-retry",
    projectId: gitProject.id,
  };
  await expect(invoke("sessions:start", retry)).rejects.toThrow();
  expect(readFileSync(blocker, "utf8")).toBe("不可删除的现有文件");
  expect(await invoke("sessions:list")).toHaveLength(1);
  rmSync(blocker);
  const worktree = await invoke("sessions:start", retry);
  await idle(worktree.id);
  expect(await invoke("sessions:list")).toHaveLength(2);
});

it("失败期间出现额外成果时保留副本并明确返回位置，不将失败显示为成功任务", async () => {
  const app = await setup();
  const project = await invoke("projects:add", app.repo);
  writeFileSync(
    join(app.repo, ".git", "hooks", "post-checkout"),
    "#!/bin/sh\nprintf result > extra.txt\n",
    { mode: 0o755 }
  );
  await expect(
    invoke("sessions:start", {
      requestId: "preserve-result",
      projectId: project.id,
      workspaceMode: "worktree",
      text: "$missing-skill 失败",
    })
  ).rejects.toThrow("已保留");
  expect(await invoke("sessions:list")).toEqual([]);
  const ids = readdirSync(join(app.home, "worktrees"));
  expect(ids).toHaveLength(1);
  expect(
    readFileSync(join(app.home, "worktrees", ids[0]!, "extra.txt"), "utf8")
  ).toBe("result");
});

it("首条消息启动失败撤销本次 Worktree 和分支，同一草稿可重试且用户目录不动", async () => {
  const app = await setup();
  const project = await invoke("projects:add", app.repo);
  const request = {
    requestId: "retry-worktree",
    projectId: project.id,
    workspaceMode: "worktree",
    text: "$missing-skill 启动失败",
  };
  await expect(invoke("sessions:start", request)).rejects.toThrow();
  expect(await invoke("sessions:list")).toEqual([]);
  expect(readdirSync(join(app.home, "worktrees"))).toEqual([]);
  expect(git(app.repo, "branch", "--list", "codexlike/*").trim()).toBe("");
  expect(readFileSync(join(app.repo, "tracked.txt"), "utf8")).toBe("来源内容");
  const record = await invoke("sessions:start", {
    ...request,
    text: "重试成功",
  });
  await idle(record.id);
  expect(await invoke("sessions:list")).toHaveLength(1);
  expect(readdirSync(join(app.home, "worktrees"))).toEqual([record.id]);
});

it("项目首次发送才创建独立 Worktree，双击幂等、来源与实际目录重开后保留", async () => {
  const app = await setup();
  const project = await invoke("projects:add", app.repo);
  expect(await invoke("sessions:list")).toEqual([]);
  expect(existsSync(join(app.home, "worktrees"))).toBe(false);
  expect(git(app.repo, "branch", "--list", "codexlike/*").trim()).toBe("");
  const request = {
    requestId: "worktree-draft",
    projectId: project.id,
    workspaceMode: "worktree",
    text: "隔离任务",
  };
  const [record, duplicate] = await Promise.all([
    invoke("sessions:start", request),
    invoke("sessions:start", request),
  ]);
  expect(duplicate.id).toBe(record.id);
  expect(record).toMatchObject({
    projectId: project.id,
    workspaceMode: "worktree",
    workspaceOriginPath: app.repo,
    workspacePath: join(app.home, "worktrees", record.id),
  });
  expect(git(record.workspacePath, "branch", "--show-current").trim()).toBe(
    `codexlike/${record.id}`
  );
  expect(git(app.repo, "branch", "--show-current").trim()).toBe("main");
  writeFileSync(join(record.workspacePath, "tracked.txt"), "隔离修改");
  expect(readFileSync(join(app.repo, "tracked.txt"), "utf8")).toBe("来源内容");
  await idle(record.id);
  expect(readdirSync(join(app.home, "worktrees"))).toEqual([record.id]);
  await invoke("sessions:archive", record.id, true);
  expect(readFileSync(join(record.workspacePath, "tracked.txt"), "utf8")).toBe(
    "隔离修改"
  );
  app.reopen();
  expect(await invoke("sessions:start", request)).toMatchObject({
    id: record.id,
    workspaceOriginPath: app.repo,
    workspacePath: record.workspacePath,
  });
  expect(
    (await invoke("sessions:messages", record.id)).filter(
      (item: any) => item.kind === "message" && item.message.role === "user"
    )
  ).toHaveLength(1);
});
