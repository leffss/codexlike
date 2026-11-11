import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createAgentResourceSnapshot,
  createSessionManager,
  createSqliteSessionStore,
  createWorktreeService,
} from "@codexlike/agent-core/node";
import { registerSessionHandlers } from "../../src/sessions/session-ipc";
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
function invoke(name: string, ...args: unknown[]): any {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`未注册通道 ${name}`);
  return handler({}, ...args);
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), "workbench-ipc-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "nested", "home");
  const workspace = join(root, "普通项目");
  mkdirSync(workspace);
  let store = createSqliteSessionStore(join(home, "session-workbench.db"));
  cleanup.push(() => store.close());
  const profiles = createProfileStore({
    dir: home,
    safeStorage: {
      isEncryptionAvailable: async () => true,
      encryptString: async (text) => Buffer.from(text),
      decryptString: async (bytes) => bytes.toString(),
    },
  });
  function register() {
    const resourcesFor = ({ workspacePath }: { workspacePath: string }) =>
      createAgentResourceSnapshot({
        workspacePath,
        globalDir: home,
        compatibleGlobalDir: join(root, "compatible"),
        findGitRoot: () => null,
      });
    const manager = createSessionManager({ persistence: store, resourcesFor });
    registerSessionHandlers({
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
  return {
    root,
    home,
    workspace,
    profiles,
    reopen() {
      store.close();
      store = createSqliteSessionStore(join(home, "session-workbench.db"));
      register();
    },
  };
}

async function provider(app: ReturnType<typeof setup>, ask = false) {
  let requests = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const asking = ask && requests === 1;
      const delta = asking
        ? {
            tool_calls: [
              {
                index: 0,
                id: "question",
                type: "function",
                function: {
                  name: "ask_user_question",
                  arguments: JSON.stringify({
                    questions: [
                      {
                        id: "q",
                        header: "任务",
                        question: "如何继续？",
                        multiSelect: false,
                        options: [{ id: "yes", label: "继续" }],
                      },
                    ],
                  }),
                },
              },
            ],
          }
        : { content: "已完成" };
      res.end(
        `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta, finish_reason: asking ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => {
    server.close();
    server.closeAllConnections();
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("未监听端口");
  const profile = await app.profiles.create({
    name: "默认模型",
    model: "mock",
    apiKey: "test",
    baseURL: `http://127.0.0.1:${address.port}/v1`,
  });
  return { profile, requests: () => requests };
}

it("首次发送才分配专用目录和会话；重复请求只执行一遍且归属始终显式", async () => {
  const app = setup();
  const model = await provider(app);
  const project = await invoke("projects:add", app.workspace);
  expect(existsSync(join(app.home, "sessions"))).toBe(false);
  expect(await invoke("sessions:list")).toEqual([]);
  const request = {
    requestId: "draft-standalone",
    projectId: null,
    text: "整理任务资料",
  };
  const [first, duplicate] = await Promise.all([
    invoke("sessions:start", request),
    invoke("sessions:start", request),
  ]);
  expect(first.id).toBe(duplicate.id);
  expect(first).toMatchObject({
    projectId: null,
    title: "整理任务资料",
    approvalMode: "ask",
    workspaceMode: "local",
    workspaceOriginPath: null,
  });
  expect(first.workspacePath).toBe(
    join(app.home, "sessions", first.id, "workspace")
  );
  expect(statSync(first.workspacePath).isDirectory()).toBe(true);
  await vi.waitFor(async () =>
    expect(
      (await invoke("sessions:messages", first.id)).filter(
        (item: any) => item.kind === "message"
      )
    ).toHaveLength(2)
  );
  expect(model.requests()).toBe(1);
  expect((await invoke("sessions:messages", first.id))[0].message.content).toBe(
    "整理任务资料"
  );
  const local = await invoke("sessions:start", {
    requestId: "draft-project",
    projectId: project.id,
    text: "项目任务",
  });
  const standalone = await invoke("sessions:start", {
    requestId: "draft-matching",
    projectId: null,
    workspacePath: app.workspace,
    text: "仍是独立会话",
  });
  expect(local).toMatchObject({
    projectId: project.id,
    workspacePath: app.workspace,
  });
  expect(standalone).toMatchObject({
    projectId: null,
    workspacePath: app.workspace,
  });
  await vi.waitFor(async () =>
    expect(
      (await invoke("sessions:list")).every(
        (session: any) => session.status === "idle"
      )
    ).toBe(true)
  );
  await invoke("sessions:rename", first.id, "持久标题");
  app.reopen();
  expect(
    (await invoke("sessions:list")).find((s: any) => s.id === first.id).title
  ).toBe("持久标题");
  expect((await invoke("sessions:start", request)).id).toBe(first.id);
  expect(model.requests()).toBe(3);
});

it("目录与首条消息建立失败可用同一草稿重试，无空会话且只清理本次空专用目录", async () => {
  const app = setup();
  await provider(app);
  const blocker = join(app.home, "sessions");
  writeFileSync(blocker, "用户已有文件");
  const request = { requestId: "retry", projectId: null, text: "开始任务" };
  await expect(invoke("sessions:start", request)).rejects.toThrow("专用目录");
  expect(await invoke("sessions:list")).toEqual([]);
  expect(readFileSync(blocker, "utf8")).toBe("用户已有文件");
  rmSync(blocker);
  await expect(
    invoke("sessions:start", { ...request, text: "$missing-skill 开始任务" })
  ).rejects.toThrow();
  expect(await invoke("sessions:list")).toEqual([]);
  expect(readdirSync(blocker)).toEqual([]);
  const record = await invoke("sessions:start", request);
  await vi.waitFor(async () =>
    expect((await invoke("sessions:execution", record.id)).running).toBe(false)
  );
  expect(await invoke("sessions:list")).toHaveLength(1);
  const keep = join(app.workspace, "keep.txt");
  writeFileSync(keep, "保留成果");
  await expect(
    invoke("sessions:start", {
      ...request,
      requestId: "user-directory",
      workspacePath: app.workspace,
      text: "$missing-skill 失败",
    })
  ).rejects.toThrow();
  expect(readFileSync(keep, "utf8")).toBe("保留成果");
  expect(await invoke("sessions:list")).toHaveLength(1);
  await expect(
    invoke("sessions:start", {
      ...request,
      requestId: "missing-dir",
      workspacePath: join(app.root, "missing"),
    })
  ).rejects.toThrow("工作区目录");
  expect(existsSync(join(app.root, "missing"))).toBe(false);
});

it("公开执行状态含稳定执行标识与等待状态，拒绝并发发送不会失去停止通道", async () => {
  const app = setup();
  const model = await provider(app, true);
  const session = await invoke("sessions:start", {
    requestId: "waiting",
    projectId: null,
    text: "询问我",
  });
  await vi.waitFor(async () =>
    expect(
      (await invoke("sessions:execution", session.id)).waitingForUser
    ).toBe(true)
  );
  const state = await invoke("sessions:execution", session.id);
  expect(state).toMatchObject({
    sessionId: session.id,
    executionId: expect.any(String),
    running: true,
    waitingForUser: true,
  });
  expect(state.pendingInteractionIds).toHaveLength(1);
  await expect(
    invoke("sessions:send", session.id, "重复发送", model.profile.id)
  ).rejects.toThrow("执行或等待");
  expect((await invoke("sessions:execution", session.id)).executionId).toBe(
    state.executionId
  );
  expect(await invoke("sessions:interrupt", session.id)).toBe(true);
  await vi.waitFor(async () =>
    expect(await invoke("sessions:execution", session.id)).toMatchObject({
      executionId: null,
      running: false,
      waitingForUser: false,
      pendingInteractionIds: [],
    })
  );
});

it("拒绝伪造项目、目录覆盖和非法设置，不创建会话或目录", async () => {
  const app = setup();
  await provider(app);
  const project = await invoke("projects:add", app.workspace);
  const base = { requestId: "invalid", projectId: null, text: "任务" };
  for (const patch of [
    { projectId: "missing" },
    { projectId: project.id, workspacePath: app.root },
    { workspaceMode: "worktree" },
    { thinkingEffort: "forged" },
    { approvalMode: "forged" },
    { providerProfileId: "missing" },
    { workspacePath: "relative" },
  ]) {
    await expect(
      invoke("sessions:start", { ...base, ...patch })
    ).rejects.toThrow();
  }
  expect(await invoke("sessions:list")).toEqual([]);
  expect(existsSync(join(app.home, "sessions"))).toBe(false);
});

it("空的非 Git 项目显式持久存在；规范路径重复添加不创建另一个项目", async () => {
  const app = setup();
  const project = await invoke("projects:add", app.workspace);
  expect(project).toMatchObject({
    name: "普通项目",
    workspacePath: app.workspace,
  });
  expect(project.id).toEqual(expect.any(String));
  expect(await invoke("projects:add", join(app.workspace, "."))).toEqual(
    project
  );
  expect(await invoke("sessions:list")).toEqual([]);
  app.reopen();
  expect(await invoke("projects:list")).toEqual([project]);
  expect(await invoke("sessions:list")).toEqual([]);
});
