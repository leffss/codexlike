import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { APICallError } from "ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ToolDefinition } from "../../src/tools/types";
import type { InteractionRecord } from "../../src/interaction/types";
import { describe, expect, it } from "vitest";

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
    expect(manager.messages("legacy")).toHaveLength(1);
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
