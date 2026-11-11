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
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      bodies.push(JSON.parse(body));
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
  return { profile, requests: () => requests, bodies };
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

it("各新建入口草稿经宿主保存，真实关闭重开 SQLite 后恢复且不产生历史", async () => {
  const app = setup();
  const { profile } = await provider(app);
  const project = await invoke("projects:add", app.workspace);
  const independent = { kind: "new", projectId: null };
  const inProject = { kind: "new", projectId: project.id };
  const first = await invoke("workbench:read", independent);
  expect(first.value.preferences).toEqual({
    providerProfileId: profile.id,
    thinkingEffort: "auto",
    approvalMode: "ask",
  });
  await invoke("workbench:write", independent, {
    revision: first.revision + 1,
    value: {
      ...first.value,
      text: "独立入口未发送",
      workspacePath: app.workspace,
    },
  });
  const second = await invoke("workbench:read", inProject);
  await invoke("workbench:write", inProject, {
    revision: second.revision + 1,
    value: { ...second.value, text: "项目入口未发送" },
  });
  app.reopen();
  expect((await invoke("workbench:read", independent)).value).toMatchObject({
    requestId: first.value.requestId,
    text: "独立入口未发送",
    workspacePath: app.workspace,
  });
  expect((await invoke("workbench:read", inProject)).value.text).toBe(
    "项目入口未发送"
  );
  expect(await invoke("sessions:list")).toEqual([]);
  expect(existsSync(join(app.home, "sessions"))).toBe(false);
});

it("成功首次发送只消费同一意图，失败保留设置；迟到保存不能复活已消费草稿", async () => {
  const app = setup();
  const { profile } = await provider(app);
  const target = { kind: "new", projectId: null };
  const saved = await invoke("workbench:read", target);
  const value = {
    ...saved.value,
    text: "$missing-skill 待重试",
    preferences: {
      providerProfileId: profile.id,
      thinkingEffort: "high",
      approvalMode: "full-access",
    },
  };
  await invoke("workbench:write", target, { revision: 2, value });
  const request = {
    requestId: value.requestId,
    projectId: null,
    text: value.text,
    ...value.preferences,
  };
  await expect(invoke("sessions:start", request)).rejects.toThrow();
  expect((await invoke("workbench:read", target)).value).toEqual(value);
  const session = await invoke("sessions:start", {
    ...request,
    text: "重试成功",
  });
  await vi.waitFor(async () =>
    expect((await invoke("sessions:execution", session.id)).running).toBe(false)
  );
  expect(
    (await invoke("workbench:read", { kind: "session", sessionId: session.id }))
      .value.preferences
  ).toEqual(value.preferences);
  const consumed = await invoke("workbench:read", target);
  expect(consumed.value.text).toBe("");
  expect(consumed.value.preferences.approvalMode).toBe("ask");
  expect(consumed.value.requestId).not.toBe(value.requestId);
  expect(
    (await invoke("workbench:write", target, { revision: 100, value })).accepted
  ).toBe(false);
  expect((await invoke("workbench:read", target)).value.text).toBe("");
});

it("普通草稿、阅读位置、问答文本和偏好独立持久，拒绝迟到保存与伪造问答", async () => {
  const app = setup();
  await provider(app, true);
  const session = await invoke("sessions:start", {
    requestId: "question-draft",
    projectId: null,
    text: "询问",
  });
  await vi.waitFor(async () =>
    expect(
      (await invoke("sessions:pending-interactions", session.id)).length
    ).toBe(1)
  );
  const [interaction] = await invoke(
    "sessions:pending-interactions",
    session.id
  );
  const target = { kind: "session", sessionId: session.id };
  const original = await invoke("workbench:read", target);
  const question = {
    index: 0,
    answers: {
      q: { selectedOptionIds: [], text: "未提交回答", skipped: false },
    },
  };
  const value = {
    ...original.value,
    text: "普通输入独立保存",
    readingPosition: { scrollTop: 432, anchorId: "message-a", offset: -12 },
    preferences: {
      ...original.value.preferences,
      thinkingEffort: "off",
      approvalMode: "full-access",
    },
    questionDrafts: { [interaction.request.id]: question },
  };
  expect(
    (await invoke("workbench:write", target, { revision: 3, value })).accepted
  ).toBe(true);
  expect(
    (
      await invoke("workbench:write", target, {
        revision: 2,
        value: original.value,
      })
    ).accepted
  ).toBe(false);
  expect(() =>
    invoke("workbench:write", target, {
      revision: 4,
      value: { ...value, questionDrafts: { forged: question } },
    })
  ).toThrow("问答");
  await invoke("sessions:interrupt", session.id);
  await vi.waitFor(async () =>
    expect((await invoke("sessions:execution", session.id)).running).toBe(false)
  );
  app.reopen();
  expect((await invoke("workbench:read", target)).value).toEqual(value);
  expect(await invoke("sessions:pending-interactions", session.id)).toEqual([]);
  expect(
    await invoke(
      "sessions:respond-interaction",
      session.id,
      interaction.request.id,
      { kind: "questions", answers: [] }
    )
  ).toBe(false);
  expect(
    (await invoke("workbench:read", { kind: "new", projectId: null })).value
      .preferences.approvalMode
  ).toBe("ask");
});

it("实际模型请求使用发送快照，中途偏好只影响下一次；缺失配置不静默替换", async () => {
  const app = setup();
  const model = await provider(app, true);
  const other = await app.profiles.create({
    name: "另一个模型",
    model: "next-model",
    apiKey: "other-secret",
    baseURL: model.profile.baseURL,
  });
  const session = await invoke("sessions:start", {
    requestId: "freeze-settings",
    projectId: null,
    text: "第一轮",
    thinkingEffort: "high",
  });
  await vi.waitFor(async () =>
    expect(
      (await invoke("sessions:pending-interactions", session.id)).length
    ).toBe(1)
  );
  const [interaction] = await invoke(
    "sessions:pending-interactions",
    session.id
  );
  const target = { kind: "session", sessionId: session.id };
  const saved = await invoke("workbench:read", target);
  await invoke("workbench:write", target, {
    revision: saved.revision + 1,
    value: {
      ...saved.value,
      preferences: {
        providerProfileId: other.id,
        thinkingEffort: "low",
        approvalMode: "full-access",
      },
    },
  });
  await invoke(
    "sessions:respond-interaction",
    session.id,
    interaction.request.id,
    {
      kind: "questions",
      answers: [
        {
          questionId: "q",
          status: "answered",
          selectedOptionIds: ["yes"],
          text: "",
        },
      ],
    }
  );
  await vi.waitFor(async () =>
    expect((await invoke("sessions:execution", session.id)).running).toBe(false)
  );
  expect(
    model.bodies.slice(0, 2).map((body) => [body.model, body.reasoning_effort])
  ).toEqual([
    ["mock", "high"],
    ["mock", "high"],
  ]);
  await invoke("sessions:send", session.id, "第二轮");
  await vi.waitFor(async () =>
    expect((await invoke("sessions:execution", session.id)).running).toBe(false)
  );
  expect(model.bodies[2]).toMatchObject({
    model: "next-model",
    reasoning_effort: "low",
  });
  expect(
    JSON.stringify((await invoke("workbench:read", target)).value)
  ).not.toContain("other-secret");
  await app.profiles.remove(other.id);
  const before = model.requests();
  await expect(
    invoke("sessions:send", session.id, "不能换默认模型")
  ).rejects.toThrow("不存在");
  expect(model.requests()).toBe(before);
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
