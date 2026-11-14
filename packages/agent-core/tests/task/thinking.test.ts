import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import {
  createLanguageModelFromProfile,
  type CreateLanguageModelOptions,
} from "../../src/provider/language-model";
import type { ProviderProfile } from "../../src/provider/provider-profile";
import { createSqliteTaskStore } from "../../src/task/persistence";
import { createAgentTask } from "../../src/task/agent-task";
import type { TaskEvent, TaskRecord } from "../../src/task/types";

/** 测试用 Provider Profile（apiKey 不会被真实使用：模型工厂注入 mock / fetch 替身） */
const profile: ProviderProfile = {
  id: "profile-1",
  name: "GLM",
  baseURL: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "sk-test",
  model: "glm-4.7",
};

function taskRecord(): TaskRecord {
  return {
    id: "session-1",
    title: "demo",
    workspacePath: "C:\\work\\demo",
    providerProfileId: null,
    model: null,
    status: "idle",
    workspaceMode: "local",
    projectId: null,
    workspaceOriginPath: null,
    approvalMode: "assist",
    archivedAt: null,
    createdAt: "2026-11-11T08:00:00.000Z",
    updatedAt: "2026-11-11T08:00:00.000Z",
  };
}

function usage() {
  return {
    inputTokens: {
      total: 1,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 2, text: undefined, reasoning: undefined },
  };
}

function finishWith(reason: "stop" | "tool-calls") {
  return {
    usage: usage(),
    finishReason: { unified: reason, raw: reason.replace("-", "") },
  };
}

/** 文本轮流式（ai v7：text-start/delta/end 包裹） */
function textRound(
  deltas: string[]
): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "text-start", id: "text-1" });
      for (const delta of deltas) {
        controller.enqueue({ type: "text-delta", id: "text-1", delta });
      }
      controller.enqueue({ type: "text-end", id: "text-1" });
      controller.enqueue({ type: "finish", ...finishWith("stop") });
      controller.close();
    },
  });
}

/** 思考 + 正文混合轮流式（provider 层 reasoning-start/delta/end part 形状） */
function reasoningTextRound(
  reasoning: string[],
  text: string[]
): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "reasoning-start", id: "rs-1" });
      for (const delta of reasoning) {
        controller.enqueue({ type: "reasoning-delta", id: "rs-1", delta });
      }
      controller.enqueue({ type: "reasoning-end", id: "rs-1" });
      controller.enqueue({ type: "text-start", id: "text-1" });
      for (const delta of text) {
        controller.enqueue({ type: "text-delta", id: "text-1", delta });
      }
      controller.enqueue({ type: "text-end", id: "text-1" });
      controller.enqueue({ type: "finish", ...finishWith("stop") });
      controller.close();
    },
  });
}

/** 工具调用轮流式（可选前置 reasoning；验证档位快照跨轮与思考消息关联） */
function toolCallRound(reasoning: string[] = []) {
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      if (reasoning.length > 0) {
        controller.enqueue({ type: "reasoning-start", id: "rs-1" });
        for (const delta of reasoning) {
          controller.enqueue({ type: "reasoning-delta", id: "rs-1", delta });
        }
        controller.enqueue({ type: "reasoning-end", id: "rs-1" });
      }
      controller.enqueue({
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "read_file",
        input: JSON.stringify({ path: "README.md" }),
      });
      controller.enqueue({
        type: "finish",
        usage: usage(),
        finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
      });
      controller.close();
    },
  });
}

type ScriptedStep =
  | { kind: "text"; deltas: string[] }
  | { kind: "reasoning-text"; reasoning: string[]; text: string[] }
  | { kind: "tool"; reasoning?: string[] };

function scriptedModel(
  steps: ScriptedStep[],
  /** 记录每次 doStream 收到的 prompt（验证思考不进入后续请求上下文） */
  prompts?: unknown[]
) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      if (prompts !== undefined) {
        prompts.push(prompt);
      }
      const step = steps[Math.min(call++, steps.length - 1)]!;
      if (step.kind === "tool") {
        return { stream: toolCallRound(step.reasoning) };
      }
      if (step.kind === "reasoning-text") {
        return { stream: reasoningTextRound(step.reasoning, step.text) };
      }
      return { stream: textRound(step.deltas) };
    },
  });
}

function fakeClock() {
  let tick = 0;
  return () => `2026-11-11T08:00:${String(++tick).padStart(2, "0")}.000Z`;
}

async function collect(
  iterable: AsyncIterable<TaskEvent>
): Promise<TaskEvent[]> {
  const events: TaskEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

/** 装配任务：factoryCalls 记录模型工厂每次调用的 (profile, options) */
function makeSession(
  model: MockLanguageModelV4,
  factoryCalls?: {
    profile: ProviderProfile;
    options: CreateLanguageModelOptions | undefined;
  }[]
) {
  const persistence = createSqliteTaskStore(":memory:");
  const record = taskRecord();
  persistence.insertTask(record);
  const session = createAgentTask({
    record,
    persistence,
    languageModelFor: (modelProfile, options) => {
      factoryCalls?.push({ profile: modelProfile, options });
      return model;
    },
    now: fakeClock(),
  });
  return { session, persistence };
}

describe("sendMessage 思考档位快照（GLOSSARY「思考档位」）", () => {
  it("档位随发送固定快照：工具循环每一轮的模型构造都收到同一档位", async () => {
    const factoryCalls: {
      profile: ProviderProfile;
      options: CreateLanguageModelOptions | undefined;
    }[] = [];
    const model = scriptedModel([
      { kind: "tool" },
      { kind: "text", deltas: ["已读取文件"] },
    ]);
    const { session } = makeSession(model, factoryCalls);

    const events = await collect(
      session.sendMessage({
        text: "读一下 README",
        profile,
        thinkingEffort: "high",
      })
    );

    expect(events.at(-1)?.type).toBe("assistant-done");
    expect(factoryCalls.length).toBe(2);
    for (const call of factoryCalls) {
      expect(call.options?.thinkingEffort).toBe("high");
      expect(call.profile.id).toBe("profile-1");
    }
  });

  it("未传档位等价 auto：既有调用方不受影响", async () => {
    const factoryCalls: {
      profile: ProviderProfile;
      options: CreateLanguageModelOptions | undefined;
    }[] = [];
    const model = scriptedModel([{ kind: "text", deltas: ["你好"] }]);
    const { session } = makeSession(model, factoryCalls);

    await collect(session.sendMessage({ text: "打个招呼", profile }));

    expect(factoryCalls.length).toBe(1);
    expect(factoryCalls[0]?.options?.thinkingEffort).toBe("auto");
  });

  it("两次发送可各用不同档位：任务不记忆，第二次未传回到 auto", async () => {
    const factoryCalls: {
      profile: ProviderProfile;
      options: CreateLanguageModelOptions | undefined;
    }[] = [];
    const model = scriptedModel([{ kind: "text", deltas: ["好"] }]);
    const { session } = makeSession(model, factoryCalls);

    await collect(
      session.sendMessage({ text: "第一问", profile, thinkingEffort: "low" })
    );
    await collect(
      session.sendMessage({ text: "第二问", profile, thinkingEffort: "off" })
    );
    await collect(session.sendMessage({ text: "第三问", profile }));

    expect(factoryCalls.map((call) => call.options?.thinkingEffort)).toEqual([
      "low",
      "off",
      "auto",
    ]);
  });

  it("枚举外的档位值在发送入口被拒绝，不伪造控制值发往服务端", async () => {
    const model = scriptedModel([{ kind: "text", deltas: ["你好"] }]);
    const { session, persistence } = makeSession(model);

    await expect(
      collect(
        session.sendMessage({
          text: "你好",
          profile,
          thinkingEffort: JSON.parse('"max"'),
        })
      )
    ).rejects.toThrow("无效的思考档位");
    // 入口拒绝：不落任何消息、任务保持可用
    expect(persistence.listMessages("session-1")).toEqual([]);
    expect(persistence.listTasks().at(0)?.status).toBe("idle");
    const second = await collect(
      session.sendMessage({ text: "再来", profile })
    );
    expect(second.at(-1)?.type).toBe("assistant-done");
  });
});

describe("主任务 reasoning 流（fullStream → 独立任务事件）", () => {
  it("reasoning-delta 转为 assistant-reasoning 事件：消息关联正确、增量有序、与正文分离", async () => {
    const model = scriptedModel([
      {
        kind: "reasoning-text",
        reasoning: ["先思考", "再核对"],
        text: ["答案", "如下"],
      },
    ]);
    const { session } = makeSession(model);

    const events = await collect(
      session.sendMessage({ text: "为什么", profile, thinkingEffort: "medium" })
    );

    const start = events.find((event) => event.type === "assistant-start");
    const reasoningDeltas = events.filter(
      (event) => event.type === "assistant-reasoning"
    );
    expect(reasoningDeltas.map((event) => event.delta)).toEqual([
      "先思考",
      "再核对",
    ]);
    for (const event of reasoningDeltas) {
      expect(event.messageId).toBe(
        start?.type === "assistant-start" ? start.messageId : undefined
      );
    }
    const textDeltas = events.filter(
      (event) => event.type === "assistant-delta"
    );
    expect(textDeltas.map((event) => event.delta)).toEqual(["答案", "如下"]);
    // 事件顺序：思考先于正文（模型输出顺序保持）
    const firstReasoningIndex = events.findIndex(
      (event) => event.type === "assistant-reasoning"
    );
    const firstTextIndex = events.findIndex(
      (event) => event.type === "assistant-delta"
    );
    expect(firstReasoningIndex).toBeGreaterThan(-1);
    expect(firstReasoningIndex).toBeLessThan(firstTextIndex);
  });

  it("思考随终态消息写入 StoredMessage.reasoning（票 02）：content 仍只含正文", async () => {
    const model = scriptedModel([
      {
        kind: "reasoning-text",
        reasoning: ["内部推理内容", "，继续想"],
        text: ["正文回答"],
      },
    ]);
    const { session, persistence } = makeSession(model);

    await collect(session.sendMessage({ text: "回答我", profile }));

    const messages = persistence.listMessages("session-1");
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "回答我"],
      ["assistant", "正文回答"],
    ]);
    // 思考全文（多个增量拼接）随终态 assistant 消息落库，供恢复后回看
    expect(messages[1]?.reasoning).toBe("内部推理内容，继续想");
  });

  it("思考不进入后续请求上下文：下一轮模型收到的 prompt 不含思考文本", async () => {
    const prompts: unknown[] = [];
    const model = scriptedModel(
      [
        {
          kind: "reasoning-text",
          reasoning: ["第一轮思考"],
          text: ["第一轮回答"],
        },
        {
          kind: "reasoning-text",
          reasoning: ["第二轮思考"],
          text: ["第二轮回答"],
        },
      ],
      prompts
    );
    const { session } = makeSession(model);

    await collect(session.sendMessage({ text: "第一问", profile }));
    await collect(session.sendMessage({ text: "第二问", profile }));

    expect(prompts.length).toBe(2);
    expect(JSON.stringify(prompts[1])).not.toContain("第一轮思考");
    expect(JSON.stringify(prompts[1])).not.toContain("第二轮思考");
    expect(JSON.stringify(prompts[1])).toContain("第一轮回答");
    expect(JSON.stringify(prompts[1])).toContain("第二问");
  });

  it("工具轮之间的思考同属一条助手消息：连续轮次不串流到别的消息", async () => {
    const model = scriptedModel([
      { kind: "tool", reasoning: ["调用前思考"] },
      { kind: "reasoning-text", reasoning: ["回填后思考"], text: ["最终回答"] },
    ]);
    const { session } = makeSession(model);

    const events = await collect(
      session.sendMessage({ text: "做点事", profile })
    );

    expect(events.some((event) => event.type === "tool-call")).toBe(true);

    const start = events.find((event) => event.type === "assistant-start");
    const reasoning = events.filter(
      (event) => event.type === "assistant-reasoning"
    );
    for (const event of reasoning) {
      expect(event.messageId).toBe(
        start?.type === "assistant-start" ? start.messageId : undefined
      );
    }
  });
});

describe("主任务 reasoning 终态（完成 / 中断 / 错误收敛）", () => {
  it("仅思考无正文被中断：reasoning 事件已流出部分保留，assistant-aborted 收敛不残留进行中", async () => {
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const gatedReasoningStream = new ReadableStream<LanguageModelV4StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "reasoning-start", id: "rs-1" });
        controller.enqueue({
          type: "reasoning-delta",
          id: "rs-1",
          delta: "思考到一半",
        });
        await gate;
        controller.enqueue({
          type: "reasoning-delta",
          id: "rs-1",
          delta: "（不应出现）",
        });
        controller.enqueue({ type: "reasoning-end", id: "rs-1" });
        controller.close();
      },
    });
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        if (call++ === 0) {
          return { stream: gatedReasoningStream };
        }
        return { stream: textRound(["中断后的新回答"]) };
      },
    });
    const { session, persistence } = makeSession(model);

    const controller = new AbortController();
    const events: TaskEvent[] = [];
    for await (const event of session.sendMessage({
      text: "想想看",
      profile,
      signal: controller.signal,
    })) {
      events.push(event);
      if (event.type === "assistant-reasoning") {
        controller.abort();
      }
    }
    openGate();

    // 中断收敛：终态事件为 assistant-aborted，正文为空
    expect(events.at(-1)?.type).toBe("assistant-aborted");
    const lastEvent = events.at(-1);
    if (lastEvent?.type === "assistant-aborted") {
      expect(lastEvent.message.content).toBe("");
    }
    // 已流出的 reasoning 保留，中断后不再追加
    const reasoning = events.filter(
      (event) => event.type === "assistant-reasoning"
    );
    expect(reasoning.map((event) => event.delta)).toEqual(["思考到一半"]);
    // 中断终态同样带思考落库（票 02：重启后中断轮次的过程可回看）
    const messages = persistence.listMessages("session-1");
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "想想看"],
      ["assistant", ""],
    ]);
    expect(messages[1]?.reasoning).toBe("思考到一半");
  });

  it("模型错误：reasoning 事件已流出部分保留，error 事件收敛", async () => {
    // 真实形态：流先输出 reasoning，随后中途出错（网络断开 / HTTP 5xx）
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({ type: "reasoning-start", id: "rs-1" });
            controller.enqueue({
              type: "reasoning-delta",
              id: "rs-1",
              delta: "出错前的思考",
            });
            controller.enqueue({ type: "reasoning-end", id: "rs-1" });
            // SDK 解析层在流失败时发 error part（比 controller.error 更贴近真实路径）
            controller.enqueue({
              type: "error",
              error: new APICallError({
                url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
                requestBodyValues: {},
                statusCode: 500,
                message: "Internal Server Error",
              }),
            });
            controller.close();
          },
        }),
      }),
    });
    const { session, persistence } = makeSession(model);

    const events = await collect(
      session.sendMessage({ text: "会失败", profile })
    );

    // 已流出的 reasoning 事件保留在事件流中，随后 error 事件收敛
    expect(
      events
        .filter((event) => event.type === "assistant-reasoning")
        .map((event) => event.delta)
    ).toEqual(["出错前的思考"]);
    const errorEvent = events.find((event) => event.type === "error");
    expect(errorEvent).toBeDefined();
    // 错误提示落库，思考不落库
    const messages = persistence.listMessages("session-1");
    expect(JSON.stringify(messages)).not.toContain("出错前的思考");
  });
});

describe("主任务入口 → 真实 provider 工厂（fetch 替身全链路）", () => {
  /** OpenAI 兼容端点最小成功响应（非流式路径备用） */
  it("reasoning SSE 经真实工厂：assistant-reasoning 事件流出，且第二轮请求 body 不回传思考", async () => {
    const seenBodies: string[] = [];
    /** 受控 SSE：reasoning_content 与 content 交错，随后工具调用（触发第二轮请求） */
    const fetchSpy = async (
      _input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      seenBodies.push(String(init?.body));
      const index = seenBodies.length;
      const chunks: Record<string, unknown>[] = [];
      if (index === 1) {
        chunks.push(
          { reasoning_content: "真实端点思考" },
          { content: "先看看文件" },
          {
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"a.txt"}' },
              },
            ],
          }
        );
      } else {
        chunks.push(
          { reasoning_content: "第二轮思考" },
          { content: "最终答案" }
        );
      }
      const frames = [
        ...chunks.map((delta) => ({
          id: "chatcmpl-thinking",
          object: "chat.completion.chunk",
          created: 0,
          model: profile.model,
          choices: [{ index: 0, delta, finish_reason: null }],
        })),
        {
          id: "chatcmpl-thinking",
          object: "chat.completion.chunk",
          created: 0,
          model: profile.model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: index === 1 ? "tool_calls" : "stop",
            },
          ],
        },
      ];
      return new Response(
        frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } }
      );
    };

    const persistence = createSqliteTaskStore(":memory:");
    const record = taskRecord();
    persistence.insertTask(record);
    const session = createAgentTask({
      record,
      persistence,
      languageModelFor: (modelProfile, options) =>
        createLanguageModelFromProfile(modelProfile, {
          ...options,
          fetch: fetchSpy,
        }),
      now: fakeClock(),
    });

    const events = await collect(
      session.sendMessage({
        text: "读 a.txt",
        profile,
        thinkingEffort: "high",
      })
    );

    // 事件层：思考作为独立事件流出，正文分离
    expect(
      events
        .filter((event) => event.type === "assistant-reasoning")
        .map((event) => event.delta)
    ).toEqual(["真实端点思考", "第二轮思考"]);
    expect(
      events
        .filter((event) => event.type === "assistant-delta")
        .map((e) => e.delta)
    ).toEqual(["先看看文件", "最终答案"]);

    // HTTP 契约：第一条 high 档；思考不回传第二轮（provider transformParams 剥离）
    const first = JSON.parse(seenBodies[0]!);
    expect(first.thinking).toEqual({ type: "enabled" });
    expect(first.reasoning_effort).toBe("high");
    const second = JSON.parse(seenBodies[1]!);
    expect(JSON.stringify(second)).not.toContain("真实端点思考");
    expect(JSON.stringify(second)).not.toContain("第二轮思考");
    // 落库：content 与思考分离，思考全文进 reasoning 字段（跨工具轮拼接）
    const messages = persistence.listMessages("session-1");
    const assistant = messages.find((message) => message.role === "assistant");
    expect(assistant?.content).not.toContain("真实端点思考");
    expect(assistant?.reasoning).toBe("真实端点思考第二轮思考");
  });
});
