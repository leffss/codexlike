import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createAgentResourceSnapshot,
  createTaskManager,
  createSqliteTaskStore,
  createWorktreeService,
  workbenchKey,
  type WorkbenchEntry,
} from "@codexlike/agent-core/node";
import { registerTaskHandlers } from "../../src/tasks/task-ipc";
import { createProfileStore } from "../../src/profiles/profile-store";
import { listenMock } from "./mock-server";

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
/**
 * vi.waitFor 默认预算 1000ms 远低于用例自身 5s 上限：并行全量跑时
 * mock 一轮（HTTP/SSE + SQLite 落库 + 资源快照）偶发超 1s，等待条件
 * 本身都是终态信号（running/messages/请求数），不存在靠更长轮询掩盖的
 * 竞态——把预算对齐到用例上限之内，消除负载下的假超时。
 */
const waitFor = (check: () => unknown) => vi.waitFor(check, { timeout: 4000 });
function setup(now?: () => string, beforeResources?: () => void) {
  const root = mkdtempSync(join(tmpdir(), "workbench-ipc-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "nested", "home");
  const workspace = join(root, "普通项目");
  mkdirSync(workspace);
  let store = createSqliteTaskStore(join(home, "session-workbench.db"));
  cleanup.push(() => store.close());
  const safeStorage = {
    isEncryptionAvailable: async () => true,
    encryptString: async (text: string) => Buffer.from(text),
    decryptString: async (bytes: Buffer) => bytes.toString(),
  };
  const profiles = createProfileStore({ dir: home, safeStorage });
  const worktrees = createWorktreeService({
    worktreesDir: join(home, "worktrees"),
  });
  let manager: ReturnType<typeof createTaskManager>;
  function register() {
    const resourcesFor = ({ workspacePath }: { workspacePath: string }) => {
      beforeResources?.();
      return createAgentResourceSnapshot({
        workspacePath,
        globalDir: home,
        compatibleGlobalDir: join(root, "compatible"),
        findGitRoot: () => null,
      });
    };
    manager = createTaskManager({ persistence: store, resourcesFor, now });
    registerTaskHandlers({
      manager,
      profiles,
      getWindow: () => null,
      dataDir: home,
      worktreeService: worktrees,
      resourcesFor,
    });
  }
  register();
  return {
    root,
    home,
    workspace,
    profiles,
    safeStorage,
    worktrees,
    get manager() {
      return manager;
    },
    reopen() {
      store.close();
      store = createSqliteTaskStore(join(home, "session-workbench.db"));
      register();
    },
  };
}

async function provider(
  app: ReturnType<typeof setup>,
  ask = false,
  finishGate?: Promise<void>,
  compactGate?: { entered: () => void; release: Promise<void> }
) {
  let requests = 0;
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", async () => {
      bodies.push(JSON.parse(body));
      requests += 1;
      if (!JSON.parse(body).stream) {
        compactGate?.entered();
        await compactGate?.release;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "summary",
            object: "chat.completion",
            created: 0,
            model: "mock",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "任务摘要" },
                finish_reason: "stop",
              },
            ],
          })
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (finishGate && requests === 3) {
        res.write(
          `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: { content: "后台增量" }, finish_reason: null }] })}\n\n`
        );
        await finishGate;
      }
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
  const mockPort = await listenMock(server);
  cleanup.push(() => {
    server.close();
    server.closeAllConnections();
  });
  const profile = await app.profiles.create({
    name: "默认模型",
    model: "mock",
    apiKey: "test",
    baseURL: `http://127.0.0.1:${mockPort}/v1`,
  });
  return { profile, requests: () => requests, bodies };
}

it("首次发送才分配专用目录和任务；重复请求只执行一遍且归属始终显式", async () => {
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
  await waitFor(async () =>
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
    text: "仍是独立任务",
  });
  expect(local).toMatchObject({
    projectId: project.id,
    workspacePath: app.workspace,
  });
  expect(standalone).toMatchObject({
    projectId: null,
    workspacePath: app.workspace,
  });
  await waitFor(async () =>
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

it("目录与首条消息建立失败可用同一草稿重试，无空任务且只清理本次空专用目录", async () => {
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
  await waitFor(async () =>
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
  await waitFor(async () =>
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
  expect(() => invoke("sessions:archive", session.id, true)).toThrow("先停止");
  expect(
    (await invoke("sessions:list")).find((s: any) => s.id === session.id)
      .archivedAt
  ).toBeNull();
  expect(await invoke("sessions:execution", session.id)).toEqual(state);
  // 等待用户交互期间直发被明确拒绝（review 修复，spec 用户故事 17）：不入队
  //（排队消息会卡在无法消费的时机），执行通道不被覆盖，executionId 稳定
  await expect(
    invoke("sessions:send", session.id, "重复发送", model.profile.id)
  ).rejects.toThrow("任务正在等待审批或问答");
  expect((await invoke("sessions:execution", session.id)).executionId).toBe(
    state.executionId
  );
  expect(await invoke("sessions:interrupt", session.id)).toBe(true);
  await waitFor(async () =>
    expect(await invoke("sessions:execution", session.id)).toMatchObject({
      executionId: null,
      running: false,
      waitingForUser: false,
      pendingInteractionIds: [],
    })
  );
});

it("拒绝伪造项目、目录覆盖和非法设置，不创建任务或目录", async () => {
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
  await waitFor(async () =>
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

it("首条消息接受后不再解密默认配置，成功重试不重放且新文本取得新意图", async () => {
  const app = setup();
  const model = await provider(app);
  const target = { kind: "new", projectId: null };
  const saved = await invoke("workbench:read", target);
  invoke("workbench:write", target, {
    revision: 1,
    value: { ...saved.value, text: "首个意图" },
  });
  let reads = 0;
  const decrypt = vi
    .spyOn(app.safeStorage, "decryptString")
    .mockImplementation(async (bytes) => {
      if (++reads > 2)
        throw new Error("injected keychain unavailable after start");
      return bytes.toString();
    });
  const request = {
    requestId: saved.value.requestId,
    projectId: null,
    text: "首个意图",
  };
  const first = await invoke("sessions:start", request);
  await waitFor(() =>
    expect(invoke("sessions:execution", first.id).running).toBe(false)
  );
  expect((await invoke("sessions:start", request)).id).toBe(first.id);
  decrypt.mockRestore();
  const next = await invoke("workbench:read", target);
  expect(next.value.requestId).not.toBe(request.requestId);
  expect(next.value.preferences).toEqual({
    providerProfileId: model.profile.id,
    thinkingEffort: "auto",
    approvalMode: "ask",
  });
  invoke("workbench:write", target, {
    revision: next.revision + 1,
    value: { ...next.value, text: "全新任务" },
  });
  const second = await invoke("sessions:start", {
    requestId: next.value.requestId,
    projectId: null,
    text: "全新任务",
  });
  await waitFor(() =>
    expect(invoke("sessions:execution", second.id).running).toBe(false)
  );
  expect(second.id).not.toBe(first.id);
  expect(model.bodies.map((body) => body.messages.at(-1).content)).toEqual([
    "首个意图",
    "全新任务",
  ]);
});

it("首条已执行但草稿落盘失败，重启重试补偿消费而不重放并允许下一个新任务", async () => {
  const app = setup();
  const model = await provider(app);
  const target = { kind: "new", projectId: null };
  const saved = await invoke("workbench:read", target);
  const value = {
    ...saved.value,
    text: "已接收任务",
    preferences: { ...saved.value.preferences, thinkingEffort: "high" },
  };
  invoke("workbench:write", target, { revision: 1, value });
  const request = {
    requestId: value.requestId,
    projectId: null,
    text: value.text,
    ...value.preferences,
  };
  const fault = new DatabaseSync(join(app.home, "session-workbench.db"));
  try {
    fault.exec(
      `CREATE TRIGGER fail_consume BEFORE UPDATE ON workbench_state WHEN OLD.key = '${workbenchKey(target as { kind: "new"; projectId: null })}' BEGIN SELECT RAISE(ABORT, 'injected consume disk failure'); END`
    );
    await expect(invoke("sessions:start", request)).rejects.toThrow(
      "injected consume disk failure"
    );
    const [first] = invoke("sessions:list");
    await waitFor(() =>
      expect(invoke("sessions:execution", first.id).running).toBe(false)
    );
    expect((await invoke("workbench:read", target)).value).toEqual(value);
    fault.exec("DROP TRIGGER fail_consume");
    app.reopen();
    expect((await invoke("sessions:start", request)).id).toBe(first.id);
    const consumed = await invoke("workbench:read", target);
    expect(consumed.value.requestId).not.toBe(value.requestId);
    expect(consumed.value.text).toBe("");
    expect(
      (await invoke("workbench:read", { kind: "session", sessionId: first.id }))
        .value.preferences.thinkingEffort
    ).toBe("high");
    invoke("workbench:write", target, {
      revision: consumed.revision + 1,
      value: { ...consumed.value, text: "补偿后新任务" },
    });
    const second = await invoke("sessions:start", {
      requestId: consumed.value.requestId,
      projectId: null,
      text: "补偿后新任务",
    });
    await waitFor(() =>
      expect(invoke("sessions:execution", second.id).running).toBe(false)
    );
    expect(second.id).not.toBe(first.id);
    expect((await invoke("sessions:start", request)).id).toBe(first.id);
    expect(model.bodies.map((body) => body.messages.at(-1).content)).toEqual([
      "已接收任务",
      "补偿后新任务",
    ]);
  } finally {
    fault.close();
  }
});

it("补偿已接受意图不能清空失败后编辑的新文本，而应保存为新的可发送意图", async () => {
  const app = setup();
  const model = await provider(app);
  const target = { kind: "new", projectId: null } as const;
  const saved = await invoke("workbench:read", target);
  invoke("workbench:write", target, {
    revision: 1,
    value: { ...saved.value, text: "首个已接受任务" },
  });
  const request = {
    requestId: saved.value.requestId,
    projectId: null,
    text: "首个已接受任务",
  };
  const fault = new DatabaseSync(join(app.home, "session-workbench.db"));
  try {
    fault.exec(
      "CREATE TRIGGER fail_consume BEFORE UPDATE ON workbench_state BEGIN SELECT RAISE(ABORT, 'injected consume failure'); END"
    );
    await expect(invoke("sessions:start", request)).rejects.toThrow(
      "injected consume failure"
    );
    fault.exec("DROP TRIGGER fail_consume");
  } finally {
    fault.close();
  }
  const [first] = invoke("sessions:list");
  await waitFor(() =>
    expect(invoke("sessions:execution", first.id).running).toBe(false)
  );
  invoke("workbench:write", target, {
    revision: 2,
    value: { ...saved.value, text: "失败后准备的不同任务" },
  });
  expect(
    (
      await invoke("sessions:start", {
        ...request,
        text: "失败后准备的不同任务",
      })
    ).id
  ).toBe(first.id);
  const next = await invoke("workbench:read", target);
  expect(next.value.text).toBe("失败后准备的不同任务");
  expect(next.value.requestId).not.toBe(request.requestId);
  const second = await invoke("sessions:start", {
    requestId: next.value.requestId,
    projectId: null,
    text: next.value.text,
  });
  await waitFor(() =>
    expect(invoke("sessions:execution", second.id).running).toBe(false)
  );
  expect(model.bodies.map((body) => body.messages.at(-1).content)).toEqual([
    "首个已接受任务",
    "失败后准备的不同任务",
  ]);
});

it("普通草稿、阅读位置、问答文本和偏好独立持久，拒绝迟到保存与伪造问答", async () => {
  const app = setup();
  await provider(app, true);
  const session = await invoke("sessions:start", {
    requestId: "question-draft",
    projectId: null,
    text: "询问",
  });
  await waitFor(async () =>
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
  await waitFor(async () =>
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

it("Compact裁去问答所在轮次后仍能保存只读草稿与新输入，重开不复活授权且拒绝跨任务请求", async () => {
  const app = setup();
  const model = await provider(app, true);
  const session = await invoke("sessions:start", {
    requestId: "compact-question-draft",
    projectId: null,
    text: "将被压缩的问答轮次",
  });
  await waitFor(() =>
    expect(invoke("sessions:pending-interactions", session.id)).toHaveLength(1)
  );
  const [interaction] = invoke("sessions:pending-interactions", session.id);
  const target = { kind: "session", sessionId: session.id };
  const original = await invoke("workbench:read", target);
  const questionDrafts = {
    [interaction.request.id]: {
      index: 0,
      answers: {
        q: { selectedOptionIds: [], text: "保留未提交回答", skipped: false },
      },
    },
  };
  invoke("workbench:write", target, {
    revision: 1,
    value: { ...original.value, questionDrafts },
  });
  invoke("sessions:interrupt", session.id);
  await waitFor(() =>
    expect(invoke("sessions:execution", session.id).running).toBe(false)
  );
  for (let round = 0; round < 4; round++) {
    await invoke(
      "sessions:send",
      session.id,
      `后续任务${round}`,
      model.profile.id
    );
    await waitFor(() =>
      expect(invoke("sessions:execution", session.id).running).toBe(false)
    );
  }
  await invoke("sessions:compact", session.id, model.profile.id);
  expect(
    invoke("sessions:messages", session.id).some(
      (item: any) =>
        item.kind === "message" &&
        item.message.id === interaction.request.turnId
    )
  ).toBe(false);
  expect(
    invoke("workbench:write", target, {
      revision: 2,
      value: { ...original.value, questionDrafts, text: "压缩后编辑" },
    }).accepted
  ).toBe(true);
  app.reopen();
  expect((await invoke("workbench:read", target)).value).toMatchObject({
    text: "压缩后编辑",
    questionDrafts,
  });
  expect(invoke("sessions:messages", session.id)).toContainEqual(
    expect.objectContaining({
      kind: "interaction",
      interaction: expect.objectContaining({ status: "cancelled" }),
    })
  );
  expect(
    invoke("sessions:respond-interaction", session.id, interaction.request.id, {
      kind: "questions",
      answers: [],
    })
  ).toBe(false);
  const other = await invoke("sessions:start", {
    requestId: "other-draft",
    projectId: null,
    text: "另一任务",
  });
  await waitFor(() =>
    expect(invoke("sessions:execution", other.id).running).toBe(false)
  );
  for (const invalidDrafts of [
    questionDrafts,
    { forged: Object.values(questionDrafts)[0] },
  ]) {
    expect(() =>
      invoke(
        "workbench:write",
        { kind: "session", sessionId: other.id },
        {
          revision: 3,
          value: { ...original.value, questionDrafts: invalidDrafts },
        }
      )
    ).toThrow("问答草稿与任务请求不匹配");
  }
  await invoke("sessions:send", session.id, "压缩后编辑", model.profile.id);
  await waitFor(() =>
    expect(invoke("sessions:execution", session.id).running).toBe(false)
  );
  expect(model.bodies.at(-1).messages.at(-1).content).toBe("压缩后编辑");
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
  await waitFor(async () =>
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
  await waitFor(async () =>
    expect((await invoke("sessions:execution", session.id)).running).toBe(false)
  );
  expect(
    model.bodies.slice(0, 2).map((body) => [body.model, body.reasoning_effort])
  ).toEqual([
    ["mock", "high"],
    ["mock", "high"],
  ]);
  await invoke("sessions:send", session.id, "第二轮");
  await waitFor(async () =>
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

it("执行已占位但Core尚未更新状态时，过时的idle列表也不能绕过归档保护", async () => {
  let sessionId: string | undefined;
  let checked = false;
  const app = setup(undefined, () => {
    if (!sessionId) return;
    expect(
      invoke("sessions:list").find((s: any) => s.id === sessionId).status
    ).toBe("idle");
    expect(invoke("sessions:execution", sessionId)).toMatchObject({
      running: true,
      executionId: expect.any(String),
    });
    expect(() => invoke("sessions:archive", sessionId, true)).toThrow("先停止");
    checked = true;
  });
  const model = await provider(app);
  const record = await invoke("sessions:start", {
    requestId: "reserved",
    projectId: null,
    text: "初始",
  });
  await waitFor(() =>
    expect(invoke("sessions:execution", record.id).running).toBe(false)
  );
  sessionId = record.id;
  await invoke("sessions:send", sessionId, "开始另一轮", model.profile.id);
  await waitFor(() =>
    expect(invoke("sessions:execution", sessionId).running).toBe(false)
  );
  expect(checked).toBe(true);
  expect(invoke("sessions:list")[0].archivedAt).toBeNull();
});

it("归档抢先于异步发送准备完成时拒绝启动，恢复后历史仍可继续", async () => {
  const app = setup();
  const model = await provider(app);
  const session = await invoke("sessions:start", {
    requestId: "race",
    projectId: null,
    text: "初始任务",
  });
  await waitFor(() =>
    expect(invoke("sessions:execution", session.id).running).toBe(false)
  );
  const history = invoke("sessions:messages", session.id);
  const available = await app.profiles.list();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lookup = vi
    .spyOn(app.profiles, "list")
    .mockImplementationOnce(async () => {
      await gate;
      return available;
    });
  const sending = invoke(
    "sessions:send",
    session.id,
    "不得在归档后启动",
    model.profile.id
  );
  const rejected = expect(sending).rejects.toThrow("归档");
  expect(
    invoke("sessions:archive", session.id, true).archivedAt
  ).not.toBeNull();
  release();
  await rejected;
  lookup.mockRestore();
  expect(invoke("sessions:messages", session.id)).toEqual(history);
  expect(model.requests()).toBe(1);
  expect(invoke("sessions:archive", session.id, false).archivedAt).toBeNull();
  await invoke("sessions:send", session.id, "恢复后继续", model.profile.id);
  await waitFor(() =>
    expect(invoke("sessions:execution", session.id).running).toBe(false)
  );
  expect(model.requests()).toBe(2);
});

it("独立与项目任务按用户使用排序、置顶优先，重开保留整理与归档历史", async () => {
  let clock = "2026-11-11T01:00:00.000Z";
  const app = setup(() => clock);
  await provider(app);
  const project = invoke("projects:add", app.workspace);
  const a = await invoke("sessions:start", {
    requestId: "sort-a",
    projectId: project.id,
    text: "项目历史",
  });
  await waitFor(() =>
    expect(invoke("sessions:execution", a.id).running).toBe(false)
  );
  clock = "2026-11-11T02:00:00.000Z";
  const b = await invoke("sessions:start", {
    requestId: "sort-b",
    projectId: null,
    workspacePath: app.workspace,
    text: "同目录独立历史",
  });
  await waitFor(() =>
    expect(invoke("sessions:execution", b.id).running).toBe(false)
  );
  const ids = () => invoke("sessions:list").map((s: any) => s.id);
  expect(ids()).toEqual([b.id, a.id]);
  clock = "2026-11-11T03:00:00.000Z";
  invoke("sessions:mark-used", a.id);
  expect(ids()).toEqual([a.id, b.id]);
  clock = "2026-11-11T04:00:00.000Z";
  invoke("sessions:rename", b.id, "独立标题已改");
  expect(ids()).toEqual([a.id, b.id]);
  invoke("sessions:set-pinned", b.id, true);
  expect(ids()).toEqual([b.id, a.id]);
  invoke("projects:set-collapsed", project.id, true);
  const marker = join(app.workspace, "成果.txt");
  writeFileSync(marker, "不因归档删除");
  const history = invoke("sessions:messages", b.id);
  invoke("sessions:archive", b.id, true);
  app.reopen();
  expect(invoke("projects:list")[0]).toMatchObject({
    id: project.id,
    collapsed: true,
  });
  expect(invoke("sessions:list")[0]).toMatchObject({
    id: b.id,
    pinned: true,
    projectId: null,
    title: "独立标题已改",
    lastUsedAt: "2026-11-11T02:00:00.000Z",
    archivedAt: clock,
  });
  expect(invoke("sessions:messages", b.id)).toEqual(history);
  expect(invoke("sessions:archive", b.id, false)).toMatchObject({
    projectId: null,
    workspacePath: app.workspace,
    archivedAt: null,
  });
  expect(readFileSync(marker, "utf8")).toBe("不因归档删除");
  invoke("sessions:set-pinned", b.id, false);
  expect(ids()).toEqual([a.id, b.id]);
});

it("发送登记最近使用，后台增量与完成不抢走后来查看的任务位置", async () => {
  let clock = "2026-11-11T01:00:00.000Z";
  const app = setup(() => clock);
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const model = await provider(app, false, gate);
  const a = await invoke("sessions:start", {
    requestId: "stream-a",
    projectId: null,
    text: "A",
  });
  await waitFor(() =>
    expect(invoke("sessions:execution", a.id).running).toBe(false)
  );
  clock = "2026-11-11T02:00:00.000Z";
  const b = await invoke("sessions:start", {
    requestId: "stream-b",
    projectId: null,
    text: "B",
  });
  await waitFor(() =>
    expect(invoke("sessions:execution", b.id).running).toBe(false)
  );
  clock = "2026-11-11T03:00:00.000Z";
  await invoke("sessions:send", a.id, "后台工作", model.profile.id);
  try {
    expect(invoke("sessions:list").map((s: any) => s.id)).toEqual([a.id, b.id]);
    await waitFor(() => expect(model.requests()).toBe(3));
    expect(() => invoke("sessions:archive", a.id, true)).toThrow("先停止");
    clock = "2026-11-11T04:00:00.000Z";
    invoke("sessions:mark-used", b.id);
    expect(invoke("sessions:list").map((s: any) => s.id)).toEqual([b.id, a.id]);
  } finally {
    clock = "2026-11-11T05:00:00.000Z";
    finish();
    await waitFor(() =>
      expect(invoke("sessions:execution", a.id).running).toBe(false)
    );
  }
  expect(invoke("sessions:list").map((s: any) => s.id)).toEqual([b.id, a.id]);
});

it("归档及恢复真实 Worktree 仅整理记录，来源、分支与成果文件原样保留", async () => {
  const app = setup();
  const model = await provider(app);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", app.workspace, ...args], { encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "sidebar@test.local");
  git("config", "user.name", "Sidebar Test");
  writeFileSync(join(app.workspace, "source.txt"), "来源成果");
  git("add", "source.txt");
  git("commit", "-m", "fixture");
  const project = invoke("projects:add", app.workspace);
  // 04尚未合入时用公开创建接口准备真实Worktree，不断言其创建实现。
  const worktree = await app.worktrees.createForTask({
    taskId: "archive-worktree",
    workspacePath: app.workspace,
  });
  const session = app.manager.create({
    id: "archive-worktree",
    projectId: project.id,
    workspacePath: worktree.path,
    workspaceMode: "worktree",
    workspaceOriginPath: app.workspace,
  }).record;
  await invoke("sessions:send", session.id, "保留隔离成果", model.profile.id);
  await waitFor(() =>
    expect(invoke("sessions:execution", session.id).running).toBe(false)
  );
  const marker = join(worktree.path, "keep.txt");
  writeFileSync(marker, "未提交成果");
  const before = git("worktree", "list", "--porcelain");
  const history = invoke("sessions:messages", session.id);
  invoke("sessions:archive", session.id, true);
  expect(readFileSync(marker, "utf8")).toBe("未提交成果");
  expect(readFileSync(join(app.workspace, "source.txt"), "utf8")).toBe(
    "来源成果"
  );
  app.reopen();
  expect(invoke("sessions:messages", session.id)).toEqual(history);
  expect(invoke("sessions:archive", session.id, false)).toMatchObject({
    projectId: project.id,
    workspaceMode: "worktree",
    workspaceOriginPath: app.workspace,
    workspacePath: worktree.path,
  });
  expect(git("worktree", "list", "--porcelain")).toBe(before);
  expect(readFileSync(marker, "utf8")).toBe("未提交成果");
});

it("任务移入与移出只改变显式归属，SQLite重开后目录历史与偏好保持", async () => {
  const app = setup();
  await provider(app);
  const project = invoke("projects:add", app.workspace);
  const record = await invoke("sessions:start", {
    requestId: "membership-local",
    projectId: null,
    workspacePath: app.workspace,
    text: "独立历史",
    approvalMode: "assist",
  });
  await waitFor(() =>
    expect(invoke("sessions:execution", record.id).running).toBe(false)
  );
  invoke("sessions:set-pinned", record.id, true);
  const { activity: _activity, ...before } = invoke("sessions:list")[0];
  const history = invoke("sessions:messages", record.id);
  expect(invoke("sessions:set-project", record.id, project.id)).toMatchObject({
    ...before,
    projectId: project.id,
  });
  app.reopen();
  expect(invoke("sessions:list")[0]).toMatchObject({
    ...before,
    projectId: project.id,
  });
  expect(invoke("sessions:set-project", record.id, null)).toMatchObject(before);
  app.reopen();
  expect(invoke("sessions:list")[0]).toMatchObject(before);
  expect(invoke("sessions:messages", record.id)).toEqual(history);
});

it("确认移除仅删除显式所属含归档记录，清除现场与首次发送重试而保留同目录独立任务", async () => {
  const app = setup();
  const model = await provider(app);
  const project = invoke("projects:add", app.workspace);
  const marker = join(app.workspace, "keep.txt");
  writeFileSync(marker, "不删除磁盘成果");
  const request = {
    requestId: "moved-in-removed",
    projectId: null,
    workspacePath: app.workspace,
    text: "移入后删除",
  };
  const member = await invoke("sessions:start", request);
  const standalone = await invoke("sessions:start", {
    ...request,
    requestId: "keep-independent",
    text: "保留独立",
  });
  const archived = await invoke("sessions:start", {
    requestId: "removed-archive",
    projectId: project.id,
    text: "归档历史",
  });
  await waitFor(() =>
    expect(
      invoke("sessions:list").every(
        (s: any) => !invoke("sessions:execution", s.id).running
      )
    ).toBe(true)
  );
  invoke("sessions:set-project", member.id, project.id);
  invoke("sessions:archive", archived.id, true);
  const before = invoke("sessions:list");
  const survivorView = invoke("sessions:view", standalone.id);
  expect(invoke("projects:remove", project.id, false)).toBeNull();
  expect(invoke("sessions:list")).toEqual(before);
  expect(invoke("projects:list")).toEqual([project]);
  expect(invoke("projects:remove", project.id, true)).toEqual({
    projectId: project.id,
    sessionIds: expect.arrayContaining([member.id, archived.id]),
  });
  expect(invoke("projects:list")).toEqual([]);
  expect(invoke("sessions:list").map((s: any) => s.id)).toEqual([
    standalone.id,
  ]);
  expect(invoke("sessions:view", standalone.id)).toEqual(survivorView);
  for (const id of [member.id, archived.id]) {
    expect(invoke("sessions:view", id)).toBeNull();
    expect(invoke("sessions:messages", id)).toEqual([]);
    expect(invoke("sessions:resources", id)).toBeNull();
    await expect(
      invoke("sessions:send", id, "不应执行", model.profile.id)
    ).rejects.toThrow(/不存在|移除|损坏/);
  }
  await expect(invoke("sessions:start", request)).rejects.toThrow("已移除");
  app.reopen();
  await expect(invoke("sessions:start", request)).rejects.toThrow("已移除");
  expect(invoke("sessions:list").map((s: any) => s.id)).toEqual([
    standalone.id,
  ]);
  expect(readFileSync(marker, "utf8")).toBe("不删除磁盘成果");
  await invoke(
    "sessions:send",
    standalone.id,
    "独立仍可执行",
    model.profile.id
  );
  await waitFor(() =>
    expect(invoke("sessions:execution", standalone.id).running).toBe(false)
  );
  expect(model.requests()).toBe(4);
});

it("目录匹配遵循真实路径，Worktree移出只回来源且移除不删独立副本", async () => {
  const app = setup();
  await provider(app);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", app.workspace, ...args], { encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "membership@test.local");
  git("config", "user.name", "Membership Test");
  writeFileSync(join(app.workspace, "source.txt"), "来源");
  git("add", "source.txt");
  git("commit", "-m", "fixture");
  const project = invoke("projects:add", app.workspace);
  const alias = join(app.root, "alias");
  symlinkSync(
    app.workspace,
    alias,
    process.platform === "win32" ? "junction" : "dir"
  );
  const local = await invoke("sessions:start", {
    requestId: "alias",
    projectId: null,
    workspacePath: alias,
    text: "别名目录",
  });
  const sibling = `${app.workspace}-other`;
  mkdirSync(sibling);
  const wrong = invoke("projects:add", sibling);
  const worktree = await invoke("sessions:start", {
    requestId: "origin-only",
    projectId: project.id,
    workspaceMode: "worktree",
    text: "隔离成果",
  });
  const owned = await invoke("sessions:start", {
    requestId: "owned-tree",
    projectId: project.id,
    workspaceMode: "worktree",
    text: "所属隔离成果",
  });
  await waitFor(() =>
    expect(
      invoke("sessions:list").every(
        (s: any) => !invoke("sessions:execution", s.id).running
      )
    ).toBe(true)
  );
  expect(() => invoke("sessions:set-project", local.id, wrong.id)).toThrow(
    "目录不匹配"
  );
  expect(invoke("sessions:set-project", local.id, project.id).projectId).toBe(
    project.id
  );
  invoke("sessions:set-project", local.id, null);
  invoke("sessions:set-project", worktree.id, null);
  const copyProject = invoke("projects:add", worktree.workspacePath);
  expect(() =>
    invoke("sessions:set-project", worktree.id, copyProject.id)
  ).toThrow("来源项目");
  expect(() => invoke("sessions:set-project", worktree.id, wrong.id)).toThrow(
    "来源项目"
  );
  expect(invoke("sessions:set-project", worktree.id, project.id)).toMatchObject(
    {
      workspacePath: worktree.workspacePath,
      workspaceOriginPath: app.workspace,
    }
  );
  invoke("sessions:set-project", worktree.id, null);
  const history = invoke("sessions:messages", worktree.id);
  for (const record of [worktree, owned])
    writeFileSync(join(record.workspacePath, "keep.txt"), "隔离成果不能删");
  const branches = git("worktree", "list", "--porcelain");
  invoke("projects:remove", project.id, true);
  expect(invoke("sessions:view", owned.id)).toBeNull();
  app.reopen();
  expect(invoke("sessions:messages", worktree.id)).toEqual(history);
  expect(
    invoke("sessions:list").find((s: any) => s.id === worktree.id)
  ).toMatchObject({
    projectId: null,
    workspaceOriginPath: app.workspace,
    workspacePath: worktree.workspacePath,
  });
  expect(git("worktree", "list", "--porcelain")).toBe(branches);
  for (const record of [worktree, owned])
    expect(readFileSync(join(record.workspacePath, "keep.txt"), "utf8")).toBe(
      "隔离成果不能删"
    );
  const readded = invoke("projects:add", app.workspace);
  expect(
    invoke("sessions:set-project", worktree.id, readded.id).projectId
  ).toBe(readded.id);
});

it("准备Worktree期间项目被移除，首次发送必须重查且不留悬挂记录", async () => {
  const app = setup();
  const model = await provider(app);
  const project = invoke("projects:add", app.workspace);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", app.workspace, ...args], { encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "membership@test.local");
  git("config", "user.name", "Membership Test");
  writeFileSync(join(app.workspace, "source.txt"), "保留来源");
  git("add", "source.txt");
  git("commit", "-m", "fixture");
  const original = app.worktrees.createForTask;
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // 闸门只控制外部Git返回时机，实际创建与安全回滚仍走真实实现。
  vi.spyOn(app.worktrees, "createForTask").mockImplementationOnce(
    async (input) => {
      const result = await original(input);
      entered();
      await gate;
      return result;
    }
  );
  const sending = invoke("sessions:start", {
    requestId: "project-removed-during-prepare",
    projectId: project.id,
    workspaceMode: "worktree",
    text: "不能启动",
  });
  const rejected = expect(sending).rejects.toThrow("项目不存在或已移除");
  await ready;
  invoke("projects:remove", project.id, true);
  release();
  await rejected;
  expect(invoke("sessions:list")).toEqual([]);
  expect(model.requests()).toBe(0);
});

it("等待问答或宿主执行占位时不能移出移除，停止后才可整理且独立等待不阻塞原项目", async () => {
  let target: { id: string; projectId: string } | undefined;
  let reservedChecked = false;
  const app = setup(undefined, () => {
    const active = target;
    if (!active) return;
    expect(invoke("sessions:execution", active.id).running).toBe(true);
    expect(() => invoke("sessions:set-project", active.id, null)).toThrow(
      "先停止"
    );
    expect(() => invoke("projects:remove", active.projectId, true)).toThrow(
      "先停止"
    );
    reservedChecked = true;
  });
  const model = await provider(app, true);
  const project = invoke("projects:add", app.workspace);
  const record = await invoke("sessions:start", {
    requestId: "protected-member",
    projectId: project.id,
    text: "等待问题",
  });
  await waitFor(() =>
    expect(invoke("sessions:execution", record.id).waitingForUser).toBe(true)
  );
  const view = invoke("sessions:view", record.id);
  expect(() => invoke("sessions:set-project", record.id, null)).toThrow(
    "先停止"
  );
  expect(() => invoke("projects:remove", project.id, true)).toThrow("先停止");
  expect(invoke("sessions:view", record.id)).toEqual(view);
  invoke("sessions:interrupt", record.id);
  await waitFor(() =>
    expect(invoke("sessions:execution", record.id).running).toBe(false)
  );
  target = { id: record.id, projectId: project.id };
  await invoke("sessions:send", record.id, "再次运行", model.profile.id);
  await waitFor(() =>
    expect(invoke("sessions:execution", record.id).running).toBe(false)
  );
  expect(reservedChecked).toBe(true);
  target = undefined;
  invoke("sessions:set-project", record.id, null);
  invoke("projects:remove", project.id, true);
  expect(invoke("sessions:view", record.id)).not.toBeNull();
});

it("移除抢先于异步发送准备完成时不能通过旧Core缓存复活已删除任务", async () => {
  const app = setup();
  const model = await provider(app);
  const project = invoke("projects:add", app.workspace);
  const record = await invoke("sessions:start", {
    requestId: "remove-vs-send",
    projectId: project.id,
    text: "首轮",
  });
  await waitFor(() =>
    expect(invoke("sessions:execution", record.id).running).toBe(false)
  );
  const available = await app.profiles.list();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(app.profiles, "list").mockImplementationOnce(async () => {
    await gate;
    return available;
  });
  const sending = invoke(
    "sessions:send",
    record.id,
    "不应执行",
    model.profile.id
  );
  const rejected = expect(sending).rejects.toThrow("已移除");
  invoke("projects:remove", project.id, true);
  release();
  await rejected;
  expect(invoke("sessions:list")).toEqual([]);
  expect(invoke("sessions:messages", record.id)).toEqual([]);
  expect(model.requests()).toBe(1);
});

it("压缩执行也复用宿主占位，不能在异步生成摘要期间移除项目", async () => {
  const app = setup();
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = await provider(app, false, undefined, {
    entered,
    release: gate,
  });
  const project = invoke("projects:add", app.workspace);
  const record = await invoke("sessions:start", {
    requestId: "compact-protected",
    projectId: project.id,
    text: "首轮",
  });
  await waitFor(() =>
    expect(invoke("sessions:execution", record.id).running).toBe(false)
  );
  for (let i = 0; i < 3; i++) {
    await invoke("sessions:send", record.id, `后续${i}`, model.profile.id);
    await waitFor(() =>
      expect(invoke("sessions:execution", record.id).running).toBe(false)
    );
  }
  const beforeCompact = invoke("sessions:view", record.id);
  const compacting = invoke("sessions:compact", record.id, model.profile.id);
  await ready;
  try {
    expect(invoke("sessions:execution", record.id).running).toBe(true);
    const view = invoke("sessions:view", record.id);
    expect(view.activity).toMatchObject({
      running: true,
      operation: "compact",
      outcome: null,
    });
    expect(view.executionId).toBe(
      invoke("sessions:execution", record.id).executionId
    );
    expect(view.executionId).not.toBe(beforeCompact.executionId);
    expect(view.sequence).toBeGreaterThan(beforeCompact.sequence);
    expect(view.events.map((envelope: any) => envelope.event.type)).toEqual([
      "compact-start",
    ]);
    expect(invoke("sessions:list")[0].activity).toEqual(view.activity);
    expect(() => invoke("sessions:set-project", record.id, null)).toThrow(
      "先停止"
    );
    expect(() => invoke("projects:remove", project.id, true)).toThrow("先停止");
  } finally {
    release();
    await compacting;
  }
  expect(invoke("sessions:execution", record.id).running).toBe(false);
});

it("SQLite移除中途失败整体回滚，历史现场与重试意图不出现半删除", async () => {
  const app = setup();
  await provider(app);
  const project = invoke("projects:add", app.workspace);
  const request = {
    requestId: "atomic-remove",
    projectId: project.id,
    text: "原始历史",
  };
  const record = await invoke("sessions:start", request);
  await waitFor(() =>
    expect(invoke("sessions:execution", record.id).running).toBe(false)
  );
  const before = invoke("sessions:view", record.id);
  // 仅在临时测试库注入存储故障；断言仍经宿主公开接口，不查询私有表布局。
  const fault = new DatabaseSync(join(app.home, "session-workbench.db"));
  try {
    fault.exec(
      "CREATE TRIGGER fail_project_removal BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'injected disk failure'); END"
    );
    expect(() => invoke("projects:remove", project.id, true)).toThrow(
      "injected disk failure"
    );
    expect(invoke("projects:list")).toEqual([project]);
    expect(invoke("sessions:view", record.id)).toEqual(before);
    expect((await invoke("sessions:start", request)).id).toBe(record.id);
    fault.exec("DROP TRIGGER fail_project_removal");
  } finally {
    fault.close();
  }
  invoke("projects:remove", project.id, true);
  expect(invoke("sessions:view", record.id)).toBeNull();
});

it("同目录独立任务等待中仍可移除空项目，不能按目录误判运行保护范围", async () => {
  const app = setup();
  await provider(app, true);
  const project = invoke("projects:add", app.workspace);
  const record = await invoke("sessions:start", {
    requestId: "standalone-waiting",
    projectId: null,
    workspacePath: app.workspace,
    text: "独立等待",
  });
  await waitFor(() =>
    expect(invoke("sessions:execution", record.id).waitingForUser).toBe(true)
  );
  const before = invoke("sessions:view", record.id);
  expect(invoke("projects:remove", project.id, true)).toEqual({
    projectId: project.id,
    sessionIds: [],
  });
  expect(invoke("sessions:view", record.id)).toEqual(before);
  invoke("sessions:interrupt", record.id);
  await waitFor(() =>
    expect(invoke("sessions:execution", record.id).running).toBe(false)
  );
});

it("移除与03工作现场及06搜索组合：同事务清理明确归属，迟到读写不复活", async () => {
  const app = setup();
  await provider(app);
  const project = invoke("projects:add", app.workspace);
  const member = await invoke("sessions:start", {
    requestId: "combined-member",
    projectId: project.id,
    text: "组合成员",
  });
  const independent = await invoke("sessions:start", {
    requestId: "combined-independent",
    projectId: null,
    workspacePath: app.workspace,
    text: "组合独立",
  });
  await waitFor(() =>
    expect(
      invoke("sessions:list").every(
        (s: any) => !invoke("sessions:execution", s.id).running
      )
    ).toBe(true)
  );
  const ownedTargets = [
    { kind: "new", projectId: project.id },
    { kind: "session", sessionId: member.id },
  ] as const;
  const keptTargets = [
    { kind: "new", projectId: null },
    { kind: "session", sessionId: independent.id },
  ] as const;
  const saved: WorkbenchEntry[] = [];
  for (const target of [...ownedTargets, ...keptTargets]) {
    const entry = await invoke("workbench:read", target);
    const next = {
      revision: entry.revision + 1,
      value: { ...entry.value, text: "保留准确归属草稿" },
    };
    invoke("workbench:write", target, next);
    saved.push(next);
  }
  expect(invoke("sessions:search", "组合", true)).toHaveLength(2);
  invoke("sessions:set-project", independent.id, project.id);
  expect(invoke("sessions:search", "组合独立")[0].projectId).toBe(project.id);
  invoke("sessions:set-project", independent.id, null);
  invoke("projects:remove", project.id, true);
  for (const target of ownedTargets) {
    expect(app.manager.readWorkbench(workbenchKey(target))).toBeNull();
    expect(() => invoke("workbench:read", target)).toThrow("不存在");
    expect(() =>
      invoke("workbench:write", target, { ...saved[0], revision: 999 })
    ).toThrow("不存在");
  }
  for (let i = 0; i < keptTargets.length; i++)
    expect(await invoke("workbench:read", keptTargets[i])).toEqual(
      saved[i + 2]
    );
  expect(invoke("sessions:search", "组合", true)).toMatchObject([
    { id: independent.id, projectId: null },
  ]);
  app.reopen();
  for (const target of ownedTargets)
    expect(app.manager.readWorkbench(workbenchKey(target))).toBeNull();
  expect(invoke("sessions:search", "组合成员", true)).toEqual([]);
  const another = invoke("projects:add", app.workspace);
  const available = await app.profiles.list();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(app.profiles, "list").mockImplementationOnce(async () => {
    await gate;
    return available;
  });
  const target = { kind: "new", projectId: another.id } as const;
  const reading = invoke("workbench:read", target);
  const rejected = expect(reading).rejects.toThrow("不存在");
  invoke("projects:remove", another.id, true);
  release();
  await rejected;
  expect(app.manager.readWorkbench(workbenchKey(target))).toBeNull();
});

it("首次发送成功后补偿草稿消费仍在等待时移除项目，旧requestId不得返回删除记录或回滚磁盘", async () => {
  const app = setup();
  const model = await provider(app);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", app.workspace, ...args], { encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "membership@test.local");
  git("config", "user.name", "Membership Test");
  writeFileSync(join(app.workspace, "source.txt"), "保留源文件");
  git("add", "source.txt");
  git("commit", "-m", "fixture");
  const project = invoke("projects:add", app.workspace);
  const available = await app.profiles.list();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const draftTarget = { kind: "new", projectId: project.id } as const;
  const draft = await invoke("workbench:read", draftTarget);
  const request = {
    requestId: draft.value.requestId,
    projectId: project.id,
    workspaceMode: "worktree",
    text: "已执行过不能回滚",
  };
  const fault = new DatabaseSync(join(app.home, "session-workbench.db"));
  try {
    fault.exec(
      "CREATE TRIGGER fail_consume BEFORE UPDATE ON workbench_state BEGIN SELECT RAISE(ABORT, 'injected consume failure'); END"
    );
    await expect(invoke("sessions:start", request)).rejects.toThrow(
      "injected consume failure"
    );
    fault.exec("DROP TRIGGER fail_consume");
  } finally {
    fault.close();
  }
  vi.spyOn(app.profiles, "list").mockImplementationOnce(async () => {
    await gate;
    return available;
  });
  const sending = invoke("sessions:start", request);
  const duplicate = invoke("sessions:start", request);
  const rejected = expect(sending).rejects.toThrow("已移除");
  const duplicateRejected = expect(duplicate).rejects.toThrow("已移除");
  await waitFor(() => expect(invoke("sessions:list")[0]?.status).toBe("idle"));
  await waitFor(() => expect(model.requests()).toBe(1));
  await waitFor(() =>
    expect(
      invoke("sessions:execution", invoke("sessions:list")[0].id).running
    ).toBe(false)
  );
  const record = invoke("sessions:list")[0];
  invoke("projects:remove", project.id, true);
  release();
  await Promise.all([rejected, duplicateRejected]);
  expect(existsSync(record.workspacePath)).toBe(true);
  expect(readFileSync(join(record.workspacePath, "source.txt"), "utf8")).toBe(
    "保留源文件"
  );
  expect(
    app.manager.readWorkbench(
      workbenchKey({ kind: "session", sessionId: record.id })
    )
  ).toBeNull();
  expect(invoke("sessions:list")).toEqual([]);
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
