import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import { registerTaskHandlers } from "../../src/tasks/task-ipc";
import { createApplicationExit } from "../../src/lifecycle/application-exit";
import { createProfileStore } from "../../src/profiles/profile-store";
import { createLiveTasks } from "../../src/tasks/live-tasks";
import { listenMock } from "./mock-server";

/**
 * 子代理恢复数据面（ADR 0021 票 03）：重启后子代理记录随初始 history 一次性
 * 到达 UI 侧——view 载荷的并行 subagents 字段（骨架+逐轮消息+工具调用一次读出，
 * 含重启收尾补记的 interrupted 骨架）；compact 替换 history 时并行字段保留。
 * 接缝：tasks:view IPC（与 exit-recovery 同款 mock 装配）+ close → 重开库 →
 * createLiveTasks → view 的等价重启路径。
 */
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

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "subagent-recovery-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "project");
  mkdirSync(workspace);
  // 子代理工具轮的读取对象（过程记录三件之一：subagent_tool_calls 行）
  writeFileSync(join(workspace, "note.txt"), "子代理要读的文件内容");
  const dbPath = join(root, "fresh", "tasks.db");
  const persistence = createSqliteTaskStore(dbPath);
  let closed = false;
  const close = () => {
    if (!closed) {
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
    // 生产装配同款（main.ts）：子代理工具集 = 任务工具集，模型回退当前任务所选
    // Profile（resolveProfile 返回 null = 同主模型，即 mock 端点）
    subagents: {
      tools: createBuiltinTools(),
      settings: () => ({ maxConcurrent: 3 }),
      resolveProfile: async () => null,
    },
  });
  const profiles = createProfileStore({
    dir: root,
    safeStorage: {
      isEncryptionAvailable: async () => true,
      encryptString: async (text) => Buffer.from(text),
      decryptString: async (bytes) => bytes.toString(),
    },
  });
  // mock 供应商：双键控——主/子代理首轮按用户原文键控；工具结果回填轮的
  // 最后一条 user 消息是数组（tool-result parts），改按请求序号键控（#n）。
  // compact 走 generateText（非流式）：直接回 JSON completion，不经 frame
  const responses = new Map<string | number, ServerResponse>();
  let requests = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      requests += 1;
      const payload = JSON.parse(body);
      const text = payload.messages.findLast(
        (m: any) => m.role === "user"
      ).content;
      if (payload.stream !== true) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "mock",
            object: "chat.completion",
            created: 0,
            model: "mock",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "历史压缩摘要" },
                finish_reason: "stop",
              },
            ],
          })
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      responses.set(requests, res);
      if (typeof text === "string") responses.set(text, res);
    });
  });
  const mockPort = await listenMock(server);
  cleanup.push(() => {
    server.close();
    server.closeAllConnections();
  });
  const profile = await profiles.create({
    name: "恢复模型",
    model: "mock",
    apiKey: "test",
    baseURL: `http://127.0.0.1:${mockPort}/v1`,
  });
  const runtime = registerTaskHandlers({
    manager,
    profiles,
    getWindow: () => null,
    dataDir: root,
    worktreeService: createWorktreeService({
      worktreesDir: join(root, "worktrees"),
    }),
    resourcesFor,
  });
  cleanup.push(async () => {
    if (!closed) {
      runtime.freeze();
      await runtime.stopAndDrain();
    }
  });
  const project = manager.addProject(workspace);
  /** 按文本或请求序号等待并推送一帧；finish 非空时结束该次流 */
  async function frame(
    key: string | number,
    delta: unknown,
    finish: string | null = null
  ) {
    await waitFor(() => expect(responses.has(key)).toBe(true));
    const res = responses.get(key)!;
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
    requestCount: () => requests,
  };
}

it("重启恢复：子代理骨架/逐轮消息/工具调用随初始 view 一次读出（含 interrupted 骨架），compact 替换 history 后并行字段保留", async () => {
  const app = await setup();
  const started = await invoke("tasks:start", {
    requestId: "sub-recovery",
    projectId: app.project.id,
    text: "委派调研",
  });
  // 请求序（确定）：#1 主任务委派轮 → #2/#3 子代理两轮 → #4 主任务汇总轮
  await app.frame(
    "委派调研",
    {
      tool_calls: [
        {
          index: 0,
          id: "spawn-1",
          type: "function",
          function: {
            name: "spawn_subagent",
            arguments: JSON.stringify({ task: "阅读 note.txt 汇报" }),
          },
        },
      ],
    },
    "tool_calls"
  );
  // 子代理过程轮：思考 + 正文 + 读文件工具（过程内容三件齐备）
  await app.frame(
    "阅读 note.txt 汇报",
    {
      reasoning_content: "子代理过程思考",
      content: "子代理中间轮正文",
      tool_calls: [
        {
          index: 0,
          id: "sub-read",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ path: "note.txt" }),
          },
        },
      ],
    },
    "tool_calls"
  );
  // 子代理报告轮：最后一条 user 消息是工具结果数组，按请求序号键控
  await app.frame(3, { content: "最终报告：已核实 note.txt" }, "stop");
  await app.frame(4, { content: "汇总完成" }, "stop");
  await waitFor(() =>
    expect(invoke("tasks:execution", started.id).running).toBe(false)
  );

  // 执行后的 view：并行字段随 history 同一载荷返回（快照固定于执行起点，
  // 本轮子代理经事件流重建——不与落库行重复计数）
  const liveView = invoke("tasks:view", started.id);
  expect(Array.isArray(liveView.subagents)).toBe(true);
  expect(liveView.subagents).toEqual([]);
  expect(
    liveView.events.some(
      (envelope: any) => envelope.event.type === "subagent-report"
    )
  ).toBe(true);

  // 补足可压缩轮次（compact 需超过保留轮数），请求 #5-#7
  for (let i = 1; i <= 3; i++) {
    await invoke("tasks:send", started.id, `第${i}轮`, app.profile.id);
    await app.frame(`第${i}轮`, { content: `第${i}轮答复` }, "stop");
    await waitFor(() =>
      expect(invoke("tasks:execution", started.id).running).toBe(false)
    );
  }
  // compact（非流式 mock 直接应答）：等待完成即可
  await expect(
    invoke("tasks:compact", started.id, app.profile.id)
  ).resolves.toMatchObject({
    compactedMessages: expect.any(Number),
  });

  // compact 整体替换 history 后：并行 subagents 字段保留且为完整过程数据
  const compacted = invoke("tasks:view", started.id);
  expect(JSON.stringify(compacted.history)).toContain("compact-summary");
  expect(compacted.subagents).toHaveLength(1);
  const finished = compacted.subagents[0];
  expect(finished.record).toMatchObject({
    taskId: started.id,
    task: "阅读 note.txt 汇报",
    status: "completed",
  });
  expect(finished.record.startedAt).not.toBeNull();
  expect(finished.record.completedAt).not.toBeNull();
  expect(finished.messages.map((row: any) => row.content)).toEqual([
    "子代理中间轮正文",
    "最终报告：已核实 note.txt",
  ]);
  expect(finished.messages[0].reasoning).toBe("子代理过程思考");
  expect(finished.toolCalls).toHaveLength(1);
  expect(finished.toolCalls[0]).toMatchObject({
    toolName: "read_file",
    isError: false,
  });
  const subagentId = finished.record.id;

  // 模拟另一条委派被杀时的残留（agent-core 层已守护真实被杀路径；
  // desktop 层验证恢复面把 interrupted 骨架一并读出）
  app.persistence.insertSubagent({
    id: "sub-killed",
    taskId: started.id,
    task: "被杀委派",
    status: "running",
    queuedAt: "2026-11-12T08:00:00.000Z",
    startedAt: "2026-11-12T08:00:01.000Z",
    completedAt: null,
  });
  app.persistence.insertSubagentMessage({
    id: "sm-killed",
    taskId: started.id,
    subagentId: "sub-killed",
    content: "中断前已流出的正文",
    createdAt: "2026-11-12T08:00:02.000Z",
  });

  // 等价重启：关库 → 重开 → 新 manager（启动收尾 interrupted）→ live view
  app.close();
  const reopened = createSqliteTaskStore(app.dbPath);
  cleanup.push(() => reopened.close());
  const restored = createTaskManager({ persistence: reopened });
  const view = createLiveTasks(restored).view(started.id)!;
  expect(view.subagents).toHaveLength(2);
  const byId = new Map(
    view.subagents.map((snapshot) => [snapshot.record.id, snapshot])
  );
  // 完成委派：完整过程数据与 compact 前一致（compact 不动子代理表）
  expect(byId.get(subagentId)).toEqual(finished);
  // 被杀委派：interrupted 骨架 + 已发生的部分内容
  expect(byId.get("sub-killed")?.record).toMatchObject({
    task: "被杀委派",
    status: "interrupted",
  });
  expect(byId.get("sub-killed")?.record.completedAt).not.toBeNull();
  expect(byId.get("sub-killed")?.messages.map((row) => row.content)).toEqual([
    "中断前已流出的正文",
  ]);
  // 恢复载荷与初始 history 同一次读出（并行字段不走按需拉取）
  expect(view.history.length).toBeGreaterThan(0);
  expect(JSON.stringify(view.history)).toContain("compact-summary");
});
