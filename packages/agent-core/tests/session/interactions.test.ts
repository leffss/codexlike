import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { APICallError } from "ai";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createWriteFileTool } from "../../src/tools/write-file";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ToolDefinition } from "../../src/tools/types";
import type { InteractionRecord } from "../../src/interaction/types";
import { describe, expect, it } from "vitest";

import { createInteractionController } from "../../src/interaction/controller";
import { createSessionManager } from "../../src/session/manager";
import { createSqliteSessionStore } from "../../src/session/persistence";
import type { SessionEvent } from "../../src/session/types";
import type { ProviderProfile } from "../../src/provider/provider-profile";

const profile: ProviderProfile = {
  id: "test",
  name: "测试",
  baseURL: "https://example.com/v1",
  apiKey: "test",
  model: "test",
};
const questions = [
  {
    id: "target",
    header: "目标",
    question: "选择目标环境？",
    multiSelect: true,
    options: [
      { id: "dev", label: "开发环境" },
      { id: "prod", label: "生产环境" },
    ],
  },
];
const answer = {
  kind: "questions",
  answers: [
    {
      questionId: "target",
      status: "answered",
      selectedOptionIds: ["dev"],
      text: "仅本地",
    },
  ],
};
type Call = { toolCallId: string; toolName: string; input: unknown };
function stream(calls: Call[] | string) {
  return {
    stream: new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        if (typeof calls === "string") {
          controller.enqueue({ type: "text-start", id: "text" });
          controller.enqueue({ type: "text-delta", id: "text", delta: calls });
          controller.enqueue({ type: "text-end", id: "text" });
        } else {
          for (const call of calls)
            controller.enqueue({
              type: "tool-call",
              ...call,
              input: JSON.stringify(call.input),
            });
        }
        controller.enqueue({
          type: "finish",
          finishReason: {
            unified: typeof calls === "string" ? "stop" : "tool-calls",
            raw: undefined,
          },
          usage: {
            inputTokens: {
              total: 1,
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 1, text: undefined, reasoning: undefined },
          },
        });
        controller.close();
      },
    }),
  };
}
function modelFor(...steps: (Call[] | string)[]) {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async () => stream(steps[Math.min(index++, steps.length - 1)]!),
  });
}
const ask: Call = {
  toolCallId: "model-call",
  toolName: "ask_user_question",
  input: { questions },
};
async function collect(iterable: AsyncIterable<SessionEvent>) {
  const events: SessionEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("用户交互公开 seam", () => {
  it("会话授权与全部当前审批同事务落库，失败回滚且不处理问答或其他会话", () => {
    const directory = mkdtempSync(join(tmpdir(), "approval-atomic-"));
    const path = join(directory, "session.db");
    const store = createSqliteSessionStore(path);
    const manager = createSessionManager({ persistence: store });
    const session = manager.create({ workspacePath: "C:/work" });
    const other = manager.create({ workspacePath: "C:/other" });
    const pending = (
      id: string,
      sessionId = session.id
    ): InteractionRecord => ({
      request: {
        id,
        sessionId,
        turnId: "turn",
        toolCallId: id,
        source: { kind: "main" },
        createdAt: "2026-01-01",
        kind: "approval",
        toolName: "write",
        command: "write",
        commandWord: "write",
      },
      status: "pending",
      response: null,
      resolvedAt: null,
      cancelReason: null,
    });
    store.insertInteraction(pending("a"));
    store.insertInteraction(pending("b"));
    store.insertInteraction({
      ...pending("q"),
      request: { ...pending("q").request, kind: "questions", questions },
    });
    store.insertInteraction(pending("other", other.id));
    const raw = new DatabaseSync(path);
    raw.exec(
      `CREATE TRIGGER fail_batch BEFORE UPDATE ON interactions WHEN OLD.id = 'b' BEGIN SELECT RAISE(ABORT, '批量失败'); END;`
    );
    expect(() =>
      store.approveSessionInteraction(session.id, "a", "2026-01-02")
    ).toThrow("批量失败");
    expect(
      store.listSessions().find((s) => s.id === session.id)?.autoApprove
    ).toBe(false);
    expect(store.listInteractions(session.id).map((i) => i.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    raw.exec("DROP TRIGGER fail_batch");
    expect(
      store.approveSessionInteraction(session.id, "other", "2026-01-02")
    ).toBeNull();
    expect(
      store.approveSessionInteraction(session.id, "q", "2026-01-02")
    ).toBeNull();
    const settled = store.approveSessionInteraction(
      session.id,
      "a",
      "2026-01-02"
    );
    expect(settled?.map((i) => i.response)).toEqual([
      { kind: "approval", decision: "approve", scope: "session" },
      { kind: "approval", decision: "approve", scope: "session" },
    ]);
    expect(
      store.listSessions().find((s) => s.id === session.id)?.autoApprove
    ).toBe(true);
    expect(store.listInteractions(session.id)[2]?.status).toBe("pending");
    expect(store.listInteractions(other.id)[0]?.status).toBe("pending");
    store.updateSession(session.id, { autoApprove: false });
    expect(
      store.approveSessionInteraction(session.id, "a", "2026-01-03")
    ).toBeNull();
    expect(
      store.listSessions().find((s) => s.id === session.id)?.autoApprove
    ).toBe(false);
    raw.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  it("控制器先持久化再批量更新内存和事件，失败不唤醒且审批并发入队不遗漏", async () => {
    const store = createSqliteSessionStore(":memory:");
    const session = createSessionManager({ persistence: store }).create({
      workspacePath: "C:/work",
    });
    let fail = true;
    let autoApprove = false;
    const seen: string[] = [];
    const controller = createInteractionController({
      persistence: {
        ...store,
        approveSessionInteraction(...args) {
          if (fail) throw new Error("保存失败");
          return store.approveSessionInteraction(...args);
        },
      },
      now: () => "2026-01-02",
      waiting() {},
      answered() {},
      autoApprove: () => autoApprove,
      autoApproved() {
        expect(store.listSessions()[0]?.autoApprove).toBe(true);
        autoApprove = true;
        seen.push("authorized");
      },
      emit(event) {
        if (event.type === "interaction-resolved") {
          expect(autoApprove).toBe(true);
          seen.push(event.interaction.request.id);
        }
      },
    });
    const request = (id: string) => ({
      kind: "approval" as const,
      id,
      sessionId: session.id,
      turnId: "turn",
      toolCallId: id,
      source: { kind: "main" as const },
      createdAt: "2026-01-01",
      toolName: "write",
      command: "write",
      commandWord: "write",
    });
    const a = controller.request(request("a"));
    const b = controller.request({
      ...request("b"),
      source: { kind: "subagent", subagentId: "sub", task: "写入" },
    });
    const q = controller.request({
      ...request("q"),
      kind: "questions",
      questions,
    });
    for (const input of [
      { kind: "approval", decision: "reject", scope: "session" },
      { kind: "approval", decision: "approve", scope: "bad" },
    ]) {
      expect(() => controller.respond("a", input)).toThrow();
    }
    const grant = { kind: "approval", decision: "approve", scope: "session" };
    expect(() => controller.respond("a", grant)).toThrow("保存失败");
    expect(autoApprove).toBe(false);
    expect(seen).toEqual([]);
    expect(controller.pending).toHaveLength(3);
    fail = false;
    expect(controller.respond("a", grant)).toBe(true);
    expect(controller.respond("a", grant)).toBe(false);
    expect(controller.pending.map((r) => r.request.id)).toEqual(["q"]);
    expect(seen).toEqual(["authorized", "a", "b"]);
    expect((await a).response).toEqual(grant);
    expect((await b).response).toEqual(grant);
    // 即使审批门先读到 false、随后授权再入队，也必须立即结算。
    expect((await controller.request(request("late"))).response).toEqual(grant);
    controller.cancel("结束");
    expect((await q).status).toBe("cancelled");
    store.close();
  });
  it("有效审批开启会话授权：当前轮后续与后轮自动批准，撤销即时恢复询问且不改变工具路径模式", async () => {
    const persistence = createSqliteSessionStore(":memory:");
    const modes: unknown[] = [];
    const tool: ToolDefinition = {
      name: "write",
      permission: "write",
      description: "写入",
      parameters: { type: "object" },
      async execute(_input, context) {
        modes.push(context.approvalMode);
        return { output: "完成", isError: false };
      },
    };
    const call = (id: string): Call => ({
      toolCallId: id,
      toolName: "write",
      input: {},
    });
    const model = modelFor(
      [call("a"), call("b")],
      "完成",
      [call("c")],
      "完成",
      [call("d"), call("e")],
      "完成"
    );
    const manager = createSessionManager({
      persistence,
      tools: [tool],
      languageModelFor: () => model,
    });
    const session = manager.create({
      workspacePath: "C:/work",
      approvalMode: "ask",
    });
    expect(session.record.autoApprove).toBe(false);
    const events: SessionEvent[] = [];
    let firstId = "";
    for await (const event of session.sendMessage({ text: "开始", profile })) {
      events.push(event);
      if (event.type === "interaction-request") {
        firstId = event.interaction.request.id;
        expect(
          session.respondInteraction(firstId, {
            kind: "approval",
            decision: "approve",
            scope: "session",
          })
        ).toBe(true);
        expect(session.record.autoApprove).toBe(true);
      }
    }
    expect(events.filter((e) => e.type === "interaction-request")).toHaveLength(
      1
    );
    expect(
      events.find((e) => e.type === "session-auto-approve-changed")
    ).toEqual({
      type: "session-auto-approve-changed",
      sessionId: session.id,
      autoApprove: true,
    });
    expect(
      (await collect(session.sendMessage({ text: "后轮", profile }))).some(
        (e) => e.type === "interaction-request"
      )
    ).toBe(false);
    expect(manager.revokeAutoApprove(session.id).autoApprove).toBe(false);
    expect(
      session.respondInteraction(firstId, {
        kind: "approval",
        decision: "approve",
        scope: "session",
      })
    ).toBe(false);
    expect(session.record.autoApprove).toBe(false);
    let count = 0;
    for await (const event of session.sendMessage({
      text: "撤销后",
      profile,
    })) {
      if (event.type === "interaction-request") {
        count++;
        session.respondInteraction(event.interaction.request.id, {
          kind: "approval",
          decision: "approve",
          scope: "once",
        });
      }
    }
    expect(count).toBe(2);
    expect(modes).toEqual(["ask", "ask", "ask", "ask", "ask"]);
    expect(persistence.listApprovals(session.id)).toEqual([]);
    persistence.close();
  });
  it("主子代理排队审批全部放行而问答仍等待，实时授权不改变本轮冻结模式", async () => {
    const store = createSqliteSessionStore(":memory:");
    const modes: unknown[] = [];
    const write: ToolDefinition = {
      name: "write",
      permission: "write",
      description: "写入",
      parameters: { type: "object" },
      async execute(_input, context) {
        modes.push(context.approvalMode);
        return { output: "完成", isError: false };
      },
    };
    const call = (id: string): Call => ({
      toolName: "write",
      toolCallId: id,
      input: {},
    });
    const main = modelFor(
      [
        ...["写入一", "写入二", "问答"].map((task) => ({
          toolName: "spawn_subagent",
          toolCallId: task,
          input: { task },
        })),
        call("main-a"),
        call("main-b"),
      ],
      "汇总"
    );
    const sub = new MockLanguageModelV4({
      doStream: async (options) => {
        const prompt = JSON.stringify(options.prompt);
        if (options.prompt.some((m) => m.role === "tool"))
          return stream("完成");
        return stream(
          prompt.includes("问答") ? [ask] : [call("sub-a"), call("sub-b")]
        );
      },
    });
    const manager = createSessionManager({
      persistence: store,
      tools: [write],
      languageModelFor: () => main,
      subagents: {
        tools: [write],
        languageModelFor: () => sub,
        settings: () => ({ maxConcurrent: 3 }),
        resolveProfile: async () => profile,
      },
    });
    const session = manager.create({
      workspacePath: "C:/work",
      approvalMode: "ask",
    });
    let count = 0;
    for await (const event of session.sendMessage({ text: "并行", profile })) {
      if (event.type === "interaction-request" && ++count === 4) {
        const pending = session.pendingInteractions;
        expect(
          pending.filter((r) => r.request.kind === "approval")
        ).toHaveLength(3);
        manager.setApprovalMode(session.id, "full-access");
        session.respondInteraction(
          pending.find((r) => r.request.kind === "approval")!.request.id,
          { kind: "approval", decision: "approve", scope: "session" }
        );
        expect(session.pendingInteractions).toHaveLength(1);
        expect(session.pendingInteractions[0]?.request.kind).toBe("questions");
        session.respondInteraction(
          session.pendingInteractions[0]!.request.id,
          answer
        );
      }
    }
    expect(count).toBe(4);
    expect(modes).toEqual(["ask", "ask", "ask", "ask", "ask", "ask"]);
    expect(
      store
        .listInteractions(session.id)
        .filter((r) => r.request.kind === "approval")
    ).toHaveLength(3);
    expect(manager.messages(session.id)[0]?.questionAnswers).toHaveLength(1);
    expect(session.record.autoApprove).toBe(true);
    store.close();
  });
  it("授权保存失败不执行工具；撤销保存失败保留授权，成功撤销在本轮立即发事件并重新询问", async () => {
    const store = createSqliteSessionStore(":memory:");
    let failGrant = true;
    let failRevoke = true;
    let executed = 0;
    const write: ToolDefinition = {
      name: "write",
      permission: "write",
      description: "写入",
      parameters: { type: "object" },
      async execute() {
        executed++;
        return { output: "完成", isError: false };
      },
    };
    const model = modelFor(
      ["a", "b"].map((id) => ({
        toolName: "write",
        toolCallId: id,
        input: {},
      })),
      "完成"
    );
    const persistence = {
      ...store,
      approveSessionInteraction(
        ...args: Parameters<typeof store.approveSessionInteraction>
      ) {
        if (failGrant) throw new Error("授权保存失败");
        return store.approveSessionInteraction(...args);
      },
      updateSession(...args: Parameters<typeof store.updateSession>) {
        if (args[1].autoApprove === false && failRevoke)
          throw new Error("撤销保存失败");
        return store.updateSession(...args);
      },
    };
    const manager = createSessionManager({
      persistence,
      tools: [write],
      languageModelFor: () => model,
    });
    const session = manager.create({
      workspacePath: "C:/work",
      approvalMode: "ask",
    });
    const other = manager.create({
      workspacePath: "C:/other",
      approvalMode: "ask",
    });
    let count = 0;
    const changes: boolean[] = [];
    for await (const event of session.sendMessage({ text: "执行", profile })) {
      if (event.type === "session-auto-approve-changed")
        changes.push(event.autoApprove);
      if (event.type === "interaction-request") {
        const id = event.interaction.request.id;
        const response = {
          kind: "approval",
          decision: "approve",
          scope: "session",
        };
        if (++count === 1) {
          expect(other.respondInteraction(id, response)).toBe(false);
          expect(() => session.respondInteraction(id, response)).toThrow(
            "授权保存失败"
          );
          expect(executed).toBe(0);
          expect(session.record.autoApprove).toBe(false);
          expect(session.pendingInteractions).toHaveLength(1);
          failGrant = false;
          session.respondInteraction(id, response);
        } else session.respondApproval(id, "always");
      }
      if (event.type === "tool-result" && executed === 1) {
        expect(() => manager.revokeAutoApprove(session.id)).toThrow(
          "撤销保存失败"
        );
        expect(session.record.autoApprove).toBe(true);
        expect(
          store.listSessions().find((s) => s.id === session.id)?.autoApprove
        ).toBe(true);
        failRevoke = false;
        expect(manager.revokeAutoApprove(session.id).autoApprove).toBe(false);
      }
    }
    expect(count).toBe(2);
    expect(changes).toEqual([true, false]);
    expect(executed).toBe(2);
    expect(other.record.autoApprove).toBe(false);
    expect(session.record.autoApprove).toBe(false);
    store.close();
  });
  it("批量授权事务已保存会话等待状态，不在提交后额外写库导致部分放行", async () => {
    const store = createSqliteSessionStore(":memory:");
    let committed = false;
    let executed = false;
    const manager = createSessionManager({
      persistence: {
        ...store,
        approveSessionInteraction(...args) {
          const result = store.approveSessionInteraction(...args);
          committed = result !== null;
          return result;
        },
        updateSession(...args) {
          if (committed) throw new Error("提交后不应再次保存等待状态");
          store.updateSession(...args);
        },
      },
      tools: [
        {
          name: "write",
          permission: "write",
          description: "写入",
          parameters: { type: "object" },
          async execute() {
            executed = true;
            return { output: "完成", isError: false };
          },
        },
      ],
      languageModelFor: () =>
        modelFor([{ toolName: "write", toolCallId: "a", input: {} }], "完成"),
    });
    const session = manager.create({
      workspacePath: "C:/work",
      approvalMode: "ask",
    });
    for await (const event of session.sendMessage({ text: "授权", profile })) {
      if (event.type === "interaction-request") {
        expect(
          session.respondInteraction(event.interaction.request.id, {
            kind: "approval",
            decision: "approve",
            scope: "session",
          })
        ).toBe(true);
        expect(store.listSessions()[0]?.status).toBe("streaming");
        committed = false;
      }
    }
    expect(executed).toBe(true);
    store.close();
  });
  it("自动批准跨重启保留但不重放pending，不提升真实文件访问边界", async () => {
    const directory = mkdtempSync(join(tmpdir(), "approval-restart-"));
    const workspace = join(directory, "workspace");
    mkdirSync(workspace);
    const outside = join(directory, "outside.txt");
    const path = join(directory, "session.db");
    const store = createSqliteSessionStore(path);
    const model = modelFor(
      [
        {
          toolCallId: "first",
          toolName: "write_file",
          input: { path: outside, content: "不应写入" },
        },
      ],
      "完成"
    );
    const manager = createSessionManager({
      persistence: store,
      tools: [createWriteFileTool()],
      languageModelFor: () => model,
    });
    const session = manager.create({
      workspacePath: workspace,
      approvalMode: "ask",
    });
    for await (const event of session.sendMessage({ text: "授权", profile })) {
      if (event.type === "interaction-request")
        session.respondInteraction(event.interaction.request.id, {
          kind: "approval",
          decision: "approve",
          scope: "session",
        });
    }
    expect(existsSync(outside)).toBe(false);
    expect(store.listToolCalls(session.id)[0]?.isError).toBe(true);
    const historical = store.listInteractions(session.id)[0]!;
    store.insertInteraction({
      ...historical,
      request: { ...historical.request, id: "leftover" },
      status: "pending",
      response: null,
      resolvedAt: null,
    });
    manager.setApprovalMode(session.id, "assist");
    session.cancelInteractions("停止");
    expect(session.record.autoApprove).toBe(true);
    store.close();
    const reopened = createSqliteSessionStore(path);
    const restoredModel = modelFor(
      [
        {
          toolCallId: "second",
          toolName: "write_file",
          input: { path: outside, content: "仍不可越界" },
        },
      ],
      "完成"
    );
    const restored = createSessionManager({
      persistence: reopened,
      tools: [createWriteFileTool()],
      languageModelFor: () => restoredModel,
    });
    expect(restoredModel.doStreamCalls).toHaveLength(0);
    expect(
      restored.interactions(session.id).find((r) => r.request.id === "leftover")
        ?.status
    ).toBe("cancelled");
    expect(restored.get(session.id)?.record.autoApprove).toBe(true);
    expect(
      restored.get(session.id)?.respondInteraction("leftover", {
        kind: "approval",
        decision: "approve",
        scope: "session",
      })
    ).toBe(false);
    const events = await collect(
      restored.get(session.id)!.sendMessage({ text: "新轮", profile })
    );
    expect(events.some((e) => e.type === "interaction-request")).toBe(false);
    expect(existsSync(outside)).toBe(false);
    expect(reopened.listToolCalls(session.id).every((c) => c.isError)).toBe(
      true
    );
    expect(
      restored.create({ workspacePath: workspace }).record.autoApprove
    ).toBe(false);
    // 未缓存会话也可撤销，返回新记录供空闲UI同步。
    const uncached = createSessionManager({ persistence: reopened });
    expect(uncached.revokeAutoApprove(session.id).autoApprove).toBe(false);
    expect(uncached.get(session.id)?.record.autoApprove).toBe(false);
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  });
  it("主工具落库失败时仍向消费者发送子代理问答取消终态", async () => {
    const store = createSqliteSessionStore(":memory:");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: ToolDefinition = {
      name: "slow",
      permission: "readonly",
      description: "等待",
      parameters: { type: "object" },
      async execute() {
        await gate;
        return { output: "完成", isError: false };
      },
    };
    const main = modelFor(
      [
        {
          toolCallId: "delegate",
          toolName: "spawn_subagent",
          input: { task: "提问" },
        },
        { toolCallId: "slow", toolName: "slow", input: {} },
      ],
      "后续"
    );
    const sub = modelFor([ask], "不应继续");
    const manager = createSessionManager({
      persistence: {
        ...store,
        insertToolCall() {
          throw new Error("模拟工具结果落库失败");
        },
      },
      tools: [slow],
      languageModelFor: () => main,
      subagents: {
        tools: [],
        languageModelFor: () => sub,
        settings: () => ({ maxConcurrent: 1 }),
        resolveProfile: async () => profile,
      },
    });
    const session = manager.create({ workspacePath: "C:/work" });
    const events: SessionEvent[] = [];
    for await (const event of session.sendMessage({ text: "任务", profile })) {
      events.push(event);
      if (event.type === "interaction-request") release();
    }
    expect(events.at(-1)?.type).toBe("error");
    expect(
      events.find((event) => event.type === "interaction-resolved")
    ).toMatchObject({ interaction: { status: "cancelled", response: null } });
    expect(session.pendingInteractions).toEqual([]);
    expect(store.listInteractions(session.id)[0]?.status).toBe("cancelled");
    expect(sub.doStreamCalls).toHaveLength(1);
    expect(main.doStreamCalls).toHaveLength(1);
    store.close();
  });
  it("单选预设与自定义互斥，非法混合响应后仍可提交纯自定义", async () => {
    const persistence = createSqliteSessionStore(":memory:");
    const model = modelFor(
      [
        {
          ...ask,
          input: { questions: [{ ...questions[0], multiSelect: false }] },
        },
      ],
      "完成"
    );
    const session = createSessionManager({
      persistence,
      languageModelFor: () => model,
    }).create({ workspacePath: "C:/work" });
    for await (const event of session.sendMessage({ text: "选择", profile })) {
      if (event.type !== "interaction-request") continue;
      expect(() =>
        session.respondInteraction(event.interaction.request.id, answer)
      ).toThrow("单选");
      expect(session.pendingInteractions).toHaveLength(1);
      session.respondInteraction(event.interaction.request.id, {
        kind: "questions",
        answers: [{ ...answer.answers[0], selectedOptionIds: [] }],
      });
    }
    expect(
      persistence.listMessages(session.id)[0]?.questionAnswers?.[0]?.answers[0]
    ).toMatchObject({ selectedOptions: [], text: "仅本地" });
    persistence.close();
  });
  it("主问答与两个子代理同时等待，停止同步取消全部且下一轮无旧请求", async () => {
    const persistence = createSqliteSessionStore(":memory:");
    const main = modelFor(
      [
        {
          toolCallId: "delegate-1",
          toolName: "spawn_subagent",
          input: { task: "任务一" },
        },
        {
          toolCallId: "delegate-2",
          toolName: "spawn_subagent",
          input: { task: "任务二" },
        },
        ask,
      ],
      "下一轮"
    );
    const sub = modelFor([ask]);
    const manager = createSessionManager({
      persistence,
      languageModelFor: () => main,
      subagents: {
        tools: [],
        languageModelFor: () => sub,
        settings: () => ({ maxConcurrent: 2 }),
        resolveProfile: async () => profile,
      },
    });
    const session = manager.create({ workspacePath: "C:/work" });
    const abort = new AbortController();
    let count = 0;
    for await (const event of session.sendMessage({
      text: "任务",
      profile,
      signal: abort.signal,
    })) {
      if (event.type === "interaction-request" && ++count === 3) {
        expect(session.pendingInteractions).toHaveLength(3);
        abort.abort();
        expect(session.pendingInteractions).toEqual([]);
      }
    }
    expect(count).toBe(3);
    expect(
      persistence.listInteractions(session.id).map((item) => item.status)
    ).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(sub.doStreamCalls).toHaveLength(2);
    expect(main.doStreamCalls).toHaveLength(1);
    expect(manager.messages(session.id)[0]?.questionAnswers).toBeUndefined();
    await collect(session.sendMessage({ text: "新轮", profile }));
    expect(session.pendingInteractions).toEqual([]);
    expect(persistence.listInteractions(session.id)).toHaveLength(3);
    persistence.close();
  });

  it("回答提交后中断仍保留快照，不请求后续模型", async () => {
    const persistence = createSqliteSessionStore(":memory:");
    const model = modelFor([ask], "新轮");
    const manager = createSessionManager({
      persistence,
      languageModelFor: () => model,
    });
    const session = manager.create({ workspacePath: "C:/work" });
    const abort = new AbortController();
    for await (const event of session.sendMessage({
      text: "任务",
      profile,
      signal: abort.signal,
    })) {
      if (event.type === "interaction-request") {
        session.respondInteraction(event.interaction.request.id, answer);
        abort.abort();
      }
    }
    expect(persistence.listInteractions(session.id)[0]?.status).toBe(
      "resolved"
    );
    expect(manager.messages(session.id)[0]?.questionAnswers).toHaveLength(1);
    expect(model.doStreamCalls).toHaveLength(1);
    await collect(session.sendMessage({ text: "下一轮", profile }));
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain("仅本地");
    persistence.close();
  });

  it("问答内置名称冲突显式拒绝，不静默覆盖宿主工具", async () => {
    const persistence = createSqliteSessionStore(":memory:");
    let executed = false;
    const model = modelFor([ask]);
    const manager = createSessionManager({
      persistence,
      languageModelFor: () => model,
      tools: [
        {
          name: "ask_user_question",
          permission: "readonly",
          description: "冲突",
          parameters: { type: "object" },
          async execute() {
            executed = true;
            return { output: "错误工具", isError: false };
          },
        },
      ],
    });
    const session = manager.create({ workspacePath: "C:/work" });
    await expect(
      collect(session.sendMessage({ text: "任务", profile }))
    ).rejects.toThrow("工具名称冲突：ask_user_question");
    expect(executed).toBe(false);
    expect(model.doStreamCalls).toHaveLength(0);
    expect(session.pendingInteractions).toEqual([]);
    persistence.close();
  });
  it("旧库迁移后重启即取消所有 pending（含 idle 会话），历史读取不依赖 get", () => {
    const directory = mkdtempSync(join(tmpdir(), "interaction-store-"));
    const path = join(directory, "session.db");
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_path TEXT NOT NULL, provider_profile_id TEXT, model TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO sessions VALUES ('legacy', '旧会话', 'C:/work', NULL, NULL, 'waiting-approval', '2026-01-01', '2026-01-01');
      INSERT INTO messages VALUES ('turn', 'legacy', 'user', '旧问题', '2026-01-01');`);
    raw.close();
    const first = createSqliteSessionStore(path);
    expect(first.listSessions()[0]?.status).toBe("waiting-user");
    expect(first.listMessages("legacy")[0]?.questionAnswers).toBeUndefined();
    const pending: InteractionRecord = {
      request: {
        kind: "questions",
        questions,
        id: "pending",
        sessionId: "legacy",
        turnId: "turn",
        toolCallId: "call",
        source: { kind: "main" },
        createdAt: "2026-01-02",
      },
      status: "pending",
      response: null,
      resolvedAt: null,
      cancelReason: null,
    };
    first.insertInteraction(pending);
    first.updateSession("legacy", { status: "idle" });
    first.close();
    const persistence = createSqliteSessionStore(path);
    const model = modelFor("不应调用");
    const manager = createSessionManager({
      persistence,
      languageModelFor: () => model,
    });
    expect(
      manager.transcript("legacy").find((item) => item.kind === "interaction")
    ).toMatchObject({
      interaction: {
        status: "cancelled",
        response: null,
        cancelReason: expect.stringContaining("重启"),
      },
    });
    expect(manager.get("legacy")?.pendingInteractions).toEqual([]);
    expect(manager.get("legacy")?.respondInteraction("pending", answer)).toBe(
      false
    );
    expect(model.doStreamCalls).toHaveLength(0);
    expect(manager.messages("legacy")).toHaveLength(2);
    expect(manager.messages("legacy")[0]).toMatchObject({
      id: "turn",
      content: "旧问题",
    });
    expect(manager.messages("legacy")[1]).toMatchObject({
      role: "assistant",
      aborted: true,
    });
    persistence.close();
    const reopened = createSqliteSessionStore(path);
    expect(reopened.listInteractions("legacy")[0]?.status).toBe("cancelled");
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("快照提交失败事务回滚 pending，修复所属消息后可原子提交且重复不写入", () => {
    const persistence = createSqliteSessionStore(":memory:");
    const manager = createSessionManager({ persistence });
    const session = manager.create({ workspacePath: "C:/work" });
    const interaction: InteractionRecord = {
      request: {
        kind: "questions",
        questions,
        id: "request",
        sessionId: session.id,
        turnId: "missing-turn",
        toolCallId: "call",
        source: { kind: "main" },
        createdAt: "2026-01-02",
      },
      status: "pending",
      response: null,
      resolvedAt: null,
      cancelReason: null,
    };
    persistence.insertInteraction(interaction);
    const final: InteractionRecord = {
      ...interaction,
      status: "resolved",
      resolvedAt: "2026-01-03",
      response: {
        kind: "questions",
        answers: [
          {
            questionId: "target",
            status: "answered",
            selectedOptionIds: ["dev"],
            text: "事务",
          },
        ],
      },
    };
    const snapshot = {
      interactionId: "request",
      source: { kind: "main" as const },
      answers: [
        {
          questionId: "target",
          question: "选择目标环境？",
          status: "answered" as const,
          selectedOptions: ["开发环境"],
          text: "事务",
        },
      ],
    };
    expect(() => persistence.settleInteraction(final, snapshot)).toThrow(
      "用户消息不存在"
    );
    expect(persistence.listInteractions(session.id)[0]?.status).toBe("pending");
    persistence.insertMessage({
      id: "missing-turn",
      sessionId: session.id,
      role: "user",
      content: "任务",
      createdAt: "2026-01-01",
    });
    expect(persistence.settleInteraction(final, snapshot)).toBe(true);
    expect(persistence.settleInteraction(final, snapshot)).toBe(false);
    expect(persistence.listMessages(session.id)[0]?.questionAnswers).toEqual([
      snapshot,
    ]);
    expect(persistence.listInteractions(session.id)).toEqual([final]);
    persistence.close();
  });

  it("已 abort 的信号立即收尾，问答不会注册等待或请求模型", async () => {
    const persistence = createSqliteSessionStore(":memory:");
    const model = modelFor([ask]);
    const manager = createSessionManager({
      persistence,
      languageModelFor: () => model,
    });
    const session = manager.create({ workspacePath: "C:/work" });
    const abort = new AbortController();
    abort.abort();
    const events = await collect(
      session.sendMessage({ text: "取消任务", profile, signal: abort.signal })
    );
    expect(events.at(-1)?.type).toBe("assistant-aborted");
    expect(model.doStreamCalls).toHaveLength(0);
    expect(persistence.listInteractions(session.id)).toEqual([]);
    persistence.close();
  });
  it("响应严格校验且非法响应不消耗请求；纯文本、多选、跳过可提交", async () => {
    const persistence = createSqliteSessionStore(":memory:");
    const richQuestions = [
      { ...questions[0]!, multiSelect: false },
      { ...questions[0]!, id: "multi", multiSelect: true },
      { ...questions[0]!, id: "text", options: [] },
      { ...questions[0]!, id: "skip" },
    ];
    const model = modelFor(
      [{ ...ask, input: { questions: richQuestions } }],
      "完成"
    );
    const manager = createSessionManager({
      persistence,
      languageModelFor: () => model,
    });
    const session = manager.create({ workspacePath: "C:/work" });
    const valid = {
      kind: "questions",
      answers: [
        { ...answer.answers[0]!, text: "" },
        {
          questionId: "multi",
          status: "answered",
          selectedOptionIds: ["dev", "prod"],
          text: "",
        },
        {
          questionId: "text",
          status: "answered",
          selectedOptionIds: [],
          text: "纯文本答案",
        },
        {
          questionId: "skip",
          status: "skipped",
          selectedOptionIds: [],
          text: "",
        },
      ],
    };
    const invalid: unknown[] = [
      null,
      [],
      {},
      { kind: "approval", decision: "approve" },
      answer,
      { ...valid, extra: true },
      ...[
        { ...answer.answers[0], questionId: "missing" },
        { ...answer.answers[0], selectedOptionIds: ["missing"] },
        { ...answer.answers[0], selectedOptionIds: ["dev", "prod"] },
        { ...answer.answers[0], selectedOptionIds: ["dev", "dev"] },
        { ...answer.answers[0], status: "skipped" },
        {
          ...answer.answers[0],
          status: "answered",
          selectedOptionIds: [],
          text: "  ",
        },
        { ...answer.answers[0], text: "x".repeat(8001) },
        { ...answer.answers[0], extra: true },
        { ...answer.answers[0], status: "unknown" },
        { ...answer.answers[0], questionId: "multi" },
      ].map((first) => ({
        ...valid,
        answers: [first, ...valid.answers.slice(1)],
      })),
    ];
    for await (const event of session.sendMessage({ text: "问题", profile })) {
      if (event.type !== "interaction-request") continue;
      for (const response of invalid) {
        expect(() =>
          session.respondInteraction(event.interaction.request.id, response)
        ).toThrow(/[\u4e00-\u9fff]/);
        expect(session.pendingInteractions).toHaveLength(1);
        expect(persistence.listInteractions(session.id)[0]?.status).toBe(
          "pending"
        );
        expect(
          manager.messages(session.id)[0]?.questionAnswers
        ).toBeUndefined();
      }
      expect(session.respondInteraction("不存在", valid)).toBe(false);
      expect(
        session.respondInteraction(event.interaction.request.id, valid)
      ).toBe(true);
    }
    expect(
      manager.messages(session.id)[0]?.questionAnswers?.[0]?.answers
    ).toMatchObject([
      { selectedOptions: ["开发环境"] },
      { selectedOptions: ["开发环境", "生产环境"] },
      { text: "纯文本答案" },
      { status: "skipped" },
    ]);
    persistence.close();
  });

  it("问答参数拒绝未知字段、超限与重复 ID，合法最大 8题×8选项可等待", async () => {
    const persistence = createSqliteSessionStore(":memory:");
    const bad: unknown[] = [
      { questions: [] },
      { questions: Array(9).fill(questions[0]) },
      { questions, extra: true },
      { questions: [questions[0], questions[0]] },
      ...[
        { ...questions[0], options: Array(9).fill(questions[0]!.options[0]) },
        {
          ...questions[0],
          options: [questions[0]!.options[0], questions[0]!.options[0]],
        },
        { ...questions[0], id: "x".repeat(65) },
        { ...questions[0], header: "x".repeat(81) },
        { ...questions[0], question: "x".repeat(2001) },
        { ...questions[0], multiSelect: "false" },
        { ...questions[0], options: [{ id: "a", label: "x".repeat(201) }] },
        {
          ...questions[0],
          options: [{ id: "a", label: "a", description: "x".repeat(1001) }],
        },
        { ...questions[0], options: [{ id: "a", label: "a", extra: "x" }] },
      ].map((question) => ({ questions: [question] })),
    ];
    const maximum = Array.from({ length: 8 }, (_, index) => ({
      ...questions[0]!,
      id: `q${index}`,
      options: Array.from({ length: 8 }, (_, option) => ({
        id: `o${option}`,
        label: `选项${option}`,
      })),
    }));
    const calls = bad.map((input, index) => ({
      ...ask,
      input,
      toolCallId: `invalid-${index}`,
    }));
    const model = modelFor(
      [...calls, { ...ask, input: { questions: maximum } }],
      "完成"
    );
    const manager = createSessionManager({
      persistence,
      languageModelFor: () => model,
    });
    const session = manager.create({ workspacePath: "C:/work" });
    let requests = 0;
    for await (const event of session.sendMessage({
      text: "验证输入",
      profile,
    })) {
      if (event.type === "interaction-request") {
        requests++;
        expect(persistence.listToolCalls(session.id)).toHaveLength(bad.length);
        expect(
          persistence.listToolCalls(session.id).every((call) => call.isError)
        ).toBe(true);
        session.respondInteraction(event.interaction.request.id, {
          kind: "questions",
          answers: maximum.map((question) => ({
            questionId: question.id,
            status: "answered",
            selectedOptionIds: ["o7"],
            text: "",
          })),
        });
      }
    }
    expect(requests).toBe(1);
    expect(persistence.listInteractions(session.id)).toHaveLength(1);
    persistence.close();
  });

  it.each(["abort", "cancel", "response-then-abort", "return"] as const)(
    "%s 终结等待且不执行后续工具，取消与拒绝不同",
    async (mode) => {
      const persistence = createSqliteSessionStore(":memory:");
      let executed = 0;
      const tool: ToolDefinition = {
        name: "write",
        permission: "write",
        description: "写入",
        parameters: { type: "object" },
        async execute() {
          executed++;
          return { output: "执行", isError: false };
        },
      };
      const model = modelFor(
        [{ toolCallId: "write-1", toolName: "write", input: {} }],
        "不应请求"
      );
      const manager = createSessionManager({
        persistence,
        tools: [tool],
        languageModelFor: () => model,
      });
      const session = manager.create({ workspacePath: "C:/work" });
      session.setApprovalMode("ask");
      const abort = new AbortController();
      const iterator = session
        .sendMessage({ text: "任务", profile, signal: abort.signal })
        [Symbol.asyncIterator]();
      let id = "";
      for (
        let next = await iterator.next();
        !next.done;
        next = await iterator.next()
      ) {
        if (next.value.type === "interaction-request") {
          id = next.value.interaction.request.id;
          break;
        }
      }
      expect(id).not.toBe("");
      expect(() =>
        session.respondInteraction(id, { kind: "approval", decision: "always" })
      ).toThrow("审批决定");
      if (mode === "response-then-abort")
        session.respondInteraction(id, {
          kind: "approval",
          decision: "approve",
        });
      if (mode === "cancel") {
        manager.cancelInteractions("应用已退出");
        persistence.close();
      } else if (mode === "return") await iterator.return?.();
      else abort.abort();
      while (!(await iterator.next()).done) {
        /* 消费收尾 */
      }
      expect(session.pendingInteractions).toEqual([]);
      expect(
        session.respondInteraction(id, {
          kind: "approval",
          decision: "approve",
        })
      ).toBe(false);
      expect(executed).toBe(0);
      expect(model.doStreamCalls).toHaveLength(1);
      if (mode !== "cancel") {
        const interaction = persistence.listInteractions(session.id)[0]!;
        expect(interaction.status).toBe(
          mode === "response-then-abort" ? "resolved" : "cancelled"
        );
        if (mode !== "response-then-abort")
          expect(interaction.response).toBeNull();
        persistence.close();
      }
    }
  );

  it("回答后模型失败仍保留快照，下一轮及恢复上下文不会丢失答案", async () => {
    const persistence = createSqliteSessionStore(":memory:");
    let step = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const index = step++;
        if (index === 0) return stream([ask]);
        if (index === 1)
          throw new APICallError({
            message: "failed",
            url: "https://example.com",
            requestBodyValues: {},
            statusCode: 401,
          });
        return stream("继续");
      },
    });
    const manager = createSessionManager({
      persistence,
      languageModelFor: () => model,
    });
    const session = manager.create({ workspacePath: "C:/work" });
    const events: SessionEvent[] = [];
    for await (const event of session.sendMessage({ text: "任务", profile })) {
      events.push(event);
      if (event.type === "interaction-request")
        session.respondInteraction(event.interaction.request.id, answer);
    }
    expect(events.at(-1)?.type).toBe("error");
    expect(manager.messages(session.id)[0]?.questionAnswers).toHaveLength(1);
    await collect(session.sendMessage({ text: "重试", profile }));
    expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain("仅本地");
    const restored = createSessionManager({
      persistence,
      languageModelFor: () => model,
    }).get(session.id)!;
    await collect(restored.sendMessage({ text: "恢复", profile }));
    expect(JSON.stringify(model.doStreamCalls[3]?.prompt)).toContain(
      "开发环境"
    );
    persistence.close();
  });
  it("主工具等待期间实时显示并行子代理的审批和问答，回答不依赖轮末 pump", async () => {
    const persistence = createSqliteSessionStore(":memory:");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowTool: ToolDefinition = {
      name: "slow",
      permission: "readonly",
      description: "等待交互",
      parameters: { type: "object" },
      async execute() {
        await gate;
        return { output: "已完成", isError: false };
      },
    };
    let mainStep = 0;
    const main = new MockLanguageModelV4({
      doStream: async () =>
        stream(
          mainStep++ === 0
            ? [
                {
                  toolCallId: "delegate-a",
                  toolName: "spawn_subagent",
                  input: { task: "审批任务" },
                },
                {
                  toolCallId: "delegate-b",
                  toolName: "spawn_subagent",
                  input: { task: "问答任务" },
                },
                { toolCallId: "slow-call", toolName: "slow", input: {} },
                { ...ask, toolCallId: "main-question" },
              ]
            : "汇总"
        ),
    });
    const counts = new Map<string, number>();
    let executions = 0;
    const writeTool: ToolDefinition = {
      name: "write",
      permission: "write",
      description: "写入",
      parameters: { type: "object" },
      async execute() {
        executions++;
        return { output: "写入", isError: false };
      },
    };
    const sub = new MockLanguageModelV4({
      doStream: async (options) => {
        const isApproval = JSON.stringify(options.prompt).includes("审批任务");
        const key = isApproval ? "a" : "b";
        const step = counts.get(key) ?? 0;
        counts.set(key, step + 1);
        return stream(
          step === 0
            ? [
                isApproval
                  ? {
                      toolCallId: "same-model-id",
                      toolName: "write",
                      input: {},
                    }
                  : { ...ask, toolCallId: "same-model-id" },
              ]
            : "报告不复述答案"
        );
      },
    });
    const manager = createSessionManager({
      persistence,
      languageModelFor: () => main,
      tools: [slowTool],
      subagents: {
        tools: [writeTool],
        languageModelFor: () => sub,
        settings: () => ({ maxConcurrent: 2 }),
        resolveProfile: async () => profile,
      },
    });
    const session = manager.create({ workspacePath: "C:/work" });
    session.setApprovalMode("ask");
    const requests: InteractionRecord[] = [];
    let slowDone = false;
    for await (const event of session.sendMessage({
      text: "并行工作",
      profile,
    })) {
      if (event.type === "tool-result" && event.call.id === "slow-call")
        slowDone = true;
      if (event.type === "interaction-request") {
        const request = event.interaction.request;
        requests.push(event.interaction);
        if (request.source.kind === "subagent") {
          expect(slowDone).toBe(false);
          expect(request.toolCallId).toBe("same-model-id");
          expect(request.source.task).toMatch(/任务/);
          if (requests.length === 2) {
            expect(session.pendingInteractions).toHaveLength(2);
            expect(new Set(requests.map((item) => item.request.id)).size).toBe(
              2
            );
            for (const item of requests)
              session.respondInteraction(
                item.request.id,
                item.request.kind === "approval"
                  ? { kind: "approval", decision: "approve" }
                  : answer
              );
            release();
          }
        } else {
          expect(slowDone).toBe(true);
          session.respondInteraction(request.id, answer);
        }
      }
    }
    expect(requests).toHaveLength(3);
    expect(executions).toBe(1);
    expect(new Set(requests.map((item) => item.request.turnId)).size).toBe(1);
    expect(manager.messages(session.id)[0]?.questionAnswers).toHaveLength(2);
    expect(JSON.stringify(main.doStreamCalls[1]?.prompt)).toContain("开发环境");
    expect(JSON.stringify(sub.doStreamCalls.at(-1)?.prompt)).toContain(
      "仅本地"
    );
    persistence.close();
  });
  it("Compact 保留问答快照与最近轮次归属，重启与即时上下文一致", async () => {
    const persistence = createSqliteSessionStore(":memory:");
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const index = call++;
        return stream(
          index === 0 || index === 4
            ? [{ ...ask, toolCallId: `ask-${index}` }]
            : "回复"
        );
      },
      doGenerate: async () => ({
        content: [{ type: "text", text: "省略答案的摘要" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: {
            total: 1,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 1, text: undefined, reasoning: undefined },
        },
        warnings: [],
      }),
    });
    const manager = createSessionManager({
      persistence,
      languageModelFor: () => model,
    });
    const session = manager.create({ workspacePath: "C:/work" });
    for await (const event of session.sendMessage({
      text: "第一轮问答",
      profile,
    })) {
      if (event.type === "interaction-request")
        session.respondInteraction(event.interaction.request.id, answer);
    }
    for (const text of ["第二轮", "第三轮", "第四轮"]) {
      for await (const event of session.sendMessage({ text, profile })) {
        if (event.type === "interaction-request")
          session.respondInteraction(event.interaction.request.id, answer);
      }
    }
    const before = manager.messages(session.id);
    const compacted = await session.compact({ profile });
    expect(compacted.keptMessages.map((message) => message.id)).toEqual(
      before.slice(2).map((message) => message.id)
    );
    expect(compacted.summaryMessage.questionAnswers).toBeUndefined();
    expect(compacted.keptMessages.at(-2)?.questionAnswers).toEqual(
      before.at(-2)?.questionAnswers
    );
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain(
      "开发环境"
    );
    await collect(session.sendMessage({ text: "压缩后", profile }));
    expect(JSON.stringify(model.doStreamCalls.at(-1)?.prompt)).toContain(
      "仅本地"
    );
    const restored = createSessionManager({
      persistence,
      languageModelFor: () => model,
    }).get(session.id)!;
    await collect(restored.sendMessage({ text: "重启后", profile }));
    expect(JSON.stringify(model.doStreamCalls.at(-1)?.prompt)).toContain(
      "仅本地"
    );
    expect(persistence.listInteractions(session.id)[0]?.request.turnId).toBe(
      before[0]?.id
    );
    expect(
      manager
        .transcript(session.id)
        .filter((item) => item.kind === "interaction")
    ).toHaveLength(1);
    persistence.close();
  });
  it("问答先落库再通知，等待用户提交，响应与触发消息快照原子可见", async () => {
    const persistence = createSqliteSessionStore(":memory:");
    const model = modelFor([ask], "已收到答案", "下一轮");
    const manager = createSessionManager({
      persistence,
      languageModelFor: () => model,
    });
    const session = manager.create({ workspacePath: "C:/work" });
    session.setApprovalMode("full-access");
    const events: SessionEvent[] = [];
    for await (const event of session.sendMessage({
      text: "开始任务",
      profile,
    })) {
      events.push(event);
      if (event.type === "interaction-request") {
        const { request } = event.interaction;
        expect(request.id).not.toBe("model-call");
        expect(request).toMatchObject({
          kind: "questions",
          source: { kind: "main" },
          toolCallId: "model-call",
        });
        expect(persistence.listInteractions(session.id)).toEqual([
          event.interaction,
        ]);
        expect(session.pendingInteractions).toEqual([event.interaction]);
        expect(manager.list()[0]?.status).toBe("waiting-user");
        expect(model.doStreamCalls).toHaveLength(1);
        expect(session.respondInteraction(request.id, answer)).toBe(true);
        expect(session.respondInteraction(request.id, answer)).toBe(false);
        expect(manager.messages(session.id)[0]?.questionAnswers).toMatchObject([
          {
            interactionId: request.id,
            answers: [
              {
                question: "选择目标环境？",
                selectedOptions: ["开发环境"],
                text: "仅本地",
              },
            ],
          },
        ]);
      }
    }
    expect(
      events.filter((event) => event.type === "interaction-request")
    ).toHaveLength(1);
    expect(session.pendingInteractions).toEqual([]);
    expect(persistence.listInteractions(session.id)[0]?.status).toBe(
      "resolved"
    );
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain("仅本地");
    await collect(session.sendMessage({ text: "继续", profile }));
    expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain(
      "开发环境"
    );
    expect(
      manager.messages(session.id).filter((message) => message.role === "user")
    ).toHaveLength(2);
    expect(
      manager
        .transcript(session.id)
        .filter((item) => item.kind === "interaction")
    ).toHaveLength(1);
    persistence.close();
  });
});
