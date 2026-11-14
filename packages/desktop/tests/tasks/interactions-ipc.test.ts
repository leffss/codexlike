import { mkdtempSync, rmSync } from "node:fs";
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

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  handlers.clear();
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "codexlike-interaction-ipc-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = join(root, "tasks.sqlite");
  let persistence = createSqliteTaskStore(dbPath);
  cleanups.push(() => persistence.close());
  const resourcesFor = ({ workspacePath }: { workspacePath: string }) =>
    createAgentResourceSnapshot({
      workspacePath,
      globalDir: join(root, "home"),
      compatibleGlobalDir: join(root, "compatible"),
      findGitRoot: () => null,
    });
  const manager = createTaskManager({
    persistence,
    resourcesFor,
    tools: createBuiltinTools(),
  });
  const task = manager.create({ workspacePath: root, approvalMode: "ask" });
  registerTaskHandlers({
    manager,
    profiles: createProfileStore({
      dir: join(root, "profiles"),
      safeStorage: {
        isEncryptionAvailable: async () => true,
        encryptString: async (text) => Buffer.from(text),
        decryptString: async (bytes) => bytes.toString(),
      },
    }),
    getWindow: () => null,
    dataDir: root,
    worktreeService: createWorktreeService({
      worktreesDir: join(root, "worktrees"),
    }),
    resourcesFor,
  });
  return {
    task,
    manager,
    reopen() {
      persistence.close();
      persistence = createSqliteTaskStore(dbPath);
      return createTaskManager({
        persistence,
        resourcesFor,
        tools: createBuiltinTools(),
      });
    },
  };
}

function invoke(name: string, ...args: unknown[]) {
  const handler = handlers.get(name);
  if (handler === undefined) throw new Error(`未注册通道 ${name}`);
  return handler({}, ...args);
}

describe("统一用户交互 IPC", () => {
  it("撤销自动批准仅接受有效任务标识且幂等，不提供直接启用IPC", () => {
    const { task } = setup();
    for (const id of ["", null, 1, {}])
      expect(() => invoke("tasks:revoke-auto-approve", id)).toThrow(
        "参数不合法"
      );
    expect(() => invoke("tasks:revoke-auto-approve", "missing")).toThrow();
    expect(invoke("tasks:revoke-auto-approve", task.id)).toMatchObject({
      id: task.id,
      autoApprove: false,
    });
    expect(invoke("tasks:revoke-auto-approve", task.id)).toMatchObject({
      autoApprove: false,
    });
    expect(invoke("tasks:view", task.id)).toMatchObject({
      autoApprove: false,
    });
    expect(handlers.has("tasks:set-auto-approve")).toBe(false);
  });
  it("项目置顶 IPC 校验参数且保持项目原有列表顺序", () => {
    const { manager, task } = setup();
    const project = manager.addProject(task.record.workspacePath);
    expect(invoke("projects:set-pinned", project.id, true)).toMatchObject({
      id: project.id,
      pinned: true,
    });
    expect(invoke("projects:list")).toMatchObject([
      { id: project.id, pinned: true },
    ]);
    expect(invoke("projects:set-pinned", project.id, false)).toMatchObject({
      pinned: false,
    });
    for (const args of [
      ["", true],
      [project.id, "true"],
      [null, true],
    ]) {
      expect(() => invoke("projects:set-pinned", ...args)).toThrow(
        "参数不合法"
      );
    }
    expect(invoke("projects:set-pinned", "missing", true)).toBeNull();
  });
  it("任务授权拒绝非法和跨任务响应，重复不能重启授权，重开存储仍恢复授权与置顶", async () => {
    const { task, manager, reopen } = setup();
    const other = manager.create({
      workspacePath: task.record.workspacePath,
    });
    const project = manager.addProject(task.record.workspacePath);
    invoke("projects:set-pinned", project.id, true);
    let calls = 0;
    const server = createServer((_request, response) => {
      calls += 1;
      const delta =
        calls === 1
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "approval-call",
                  type: "function",
                  function: {
                    name: "run_terminal_command",
                    arguments: JSON.stringify({ command: "git --version" }),
                  },
                },
              ],
            }
          : { content: "完成" };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta, finish_reason: calls === 1 ? "tool_calls" : "stop" }] })}\n\n`
      );
      response.end("data: [DONE]\n\n");
    });
    const port = await listenMock(server);
    cleanups.push(() => {
      server.close();
      server.closeAllConnections();
    });
    const controller = new AbortController();
    const iterator = task
      .sendMessage({
        text: "检查 git",
        profile: {
          id: "mock",
          name: "Mock",
          baseURL: `http://127.0.0.1:${port}/v1`,
          apiKey: "test",
          model: "mock",
        },
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();
    try {
      let requestId = "";
      for (let index = 0; index < 20; index += 1) {
        const next = await iterator.next();
        if (next.done) break;
        if (next.value.type === "interaction-request") {
          requestId = next.value.interaction.request.id;
          break;
        }
      }
      expect(requestId).not.toBe("");
      const approval = {
        kind: "approval",
        decision: "approve",
        scope: "task",
      };
      for (const response of [
        { ...approval, scope: "global" },
        { ...approval, decision: "reject" },
      ])
        expect(() =>
          invoke("tasks:respond-interaction", task.id, requestId, response)
        ).toThrow();
      expect(
        invoke("tasks:respond-interaction", other.id, requestId, approval)
      ).toBe(false);
      expect(
        manager.list().find((record) => record.id === other.id)?.autoApprove
      ).not.toBe(true);
      expect(
        invoke("tasks:respond-interaction", task.id, requestId, approval)
      ).toBe(true);
      expect(invoke("tasks:view", task.id)).toMatchObject({
        autoApprove: true,
      });
      expect(
        invoke("tasks:respond-interaction", task.id, requestId, approval)
      ).toBe(false);
      while (!(await iterator.next()).done) {
        /* 排空本轮。 */
      }
      const restored = reopen();
      expect(
        restored.list().find((record) => record.id === task.id)
      ).toMatchObject({ autoApprove: true, approvalMode: "ask" });
      expect(restored.projects()).toMatchObject([
        { id: project.id, pinned: true },
      ]);
      expect(
        restored.list().find((record) => record.id === other.id)?.autoApprove
      ).not.toBe(true);
      restored.revokeAutoApprove(task.id);
      expect(
        reopen()
          .list()
          .find((record) => record.id === task.id)
      ).toMatchObject({ autoApprove: false });
    } finally {
      controller.abort();
      await iterator.return?.();
    }
  });
  it("仅合法响应能恢复所属任务，重复提交和跨任务响应均不消费请求", async () => {
    const { task, manager } = setup();
    const other = manager.create({
      workspacePath: task.record.workspacePath,
    });
    const bodies: string[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        bodies.push(body);
        const asking = bodies.length === 1;
        const delta = asking
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "call-question",
                  type: "function",
                  function: {
                    name: "ask_user_question",
                    arguments: JSON.stringify({
                      questions: [
                        {
                          id: "platform",
                          header: "平台",
                          question: "优先支持哪个平台？",
                          multiSelect: false,
                          options: [{ id: "windows", label: "Windows" }],
                        },
                      ],
                    }),
                  },
                },
              ],
            }
          : { content: "已收到你的选择。" };
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const choice of [
          { delta, finish_reason: null },
          { delta: {}, finish_reason: asking ? "tool_calls" : "stop" },
        ]) {
          response.write(
            `data: ${JSON.stringify({
              id: "ipc-test",
              object: "chat.completion.chunk",
              created: 0,
              model: "mock",
              choices: [{ index: 0, ...choice }],
            })}\n\n`
          );
        }
        response.end("data: [DONE]\n\n");
      });
    });
    const mockPort = await listenMock(server);
    cleanups.push(() => {
      server.close();
      server.closeAllConnections();
    });
    const controller = new AbortController();
    const iterator = task
      .sendMessage({
        text: "请询问平台偏好",
        profile: {
          id: "mock",
          name: "Mock",
          baseURL: `http://127.0.0.1:${mockPort}/v1`,
          apiKey: "test",
          model: "mock",
        },
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();
    try {
      let pending: { request: { id: string } } | undefined;
      for (let i = 0; i < 12; i += 1) {
        const next = await iterator.next();
        if (next.done) break;
        if (next.value.type === "interaction-request") {
          pending = next.value.interaction;
          break;
        }
      }
      expect(pending).toBeDefined();
      if (pending === undefined) throw new Error("未收到交互请求");
      const id = pending.request.id;
      const answer = {
        kind: "questions",
        answers: [
          {
            questionId: "platform",
            status: "answered",
            selectedOptionIds: ["windows"],
            text: "",
          },
        ],
      };
      expect(invoke("tasks:pending-interactions", task.id)).toHaveLength(1);
      expect(() =>
        invoke("tasks:respond-interaction", task.id, id, {
          kind: "approval",
          decision: "approve",
        })
      ).toThrow();
      expect(() =>
        invoke("tasks:respond-interaction", task.id, id, {
          ...answer,
          answers: [{ ...answer.answers[0], selectedOptionIds: ["forged"] }],
        })
      ).toThrow();
      expect(invoke("tasks:respond-interaction", other.id, id, answer)).toBe(
        false
      );
      expect(invoke("tasks:pending-interactions", task.id)).toHaveLength(1);
      expect(invoke("tasks:respond-interaction", task.id, id, answer)).toBe(
        true
      );
      expect(invoke("tasks:respond-interaction", task.id, id, answer)).toBe(
        false
      );
      while (!(await iterator.next()).done) {
        /* 排空本轮事件直到模型收尾。 */
      }
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toContain("windows");
      expect(manager.transcript(task.id)).toContainEqual(
        expect.objectContaining({
          kind: "interaction",
          interaction: expect.objectContaining({
            status: "resolved",
            response: answer,
          }),
        })
      );
      expect(invoke("tasks:pending-interactions", task.id)).toEqual([]);
    } finally {
      controller.abort();
      await iterator.return?.();
    }
  });

  it("拒绝不合法的任务和请求标识，不把渲染层对象当作授权", () => {
    setup();
    expect(() =>
      invoke("tasks:pending-interactions", { taskId: "other" })
    ).toThrow("taskId 必须是非空字符串");
    expect(() =>
      invoke("tasks:respond-interaction", "", "request", {
        kind: "approval",
        decision: "approve",
      })
    ).toThrow("参数不合法");
    expect(() => invoke("tasks:respond-interaction", "task", {}, {})).toThrow(
      "参数不合法"
    );
  });

  it("未知任务无待处理请求，也不能响应其他任务的请求", () => {
    setup();
    expect(invoke("tasks:pending-interactions", "unknown")).toEqual([]);
    expect(() =>
      invoke("tasks:respond-interaction", "unknown", "request", {
        kind: "approval",
        decision: "approve",
      })
    ).toThrow("任务不存在或已损坏");
  });
});
