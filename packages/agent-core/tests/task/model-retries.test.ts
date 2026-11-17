import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteTaskStore } from "../../src/task/persistence";
import { createAgentTask } from "../../src/task/agent-task";
import type { TaskEvent, TaskRecord } from "../../src/task/types";
import { createBuiltinTools } from "../../src/tools/builtin";

/**
 * 模型请求重试次数（执行设置，ADR 0024「重试不做 failover」+ ADR 0017 resolver
 * 范式，GLOSSARY「执行设置」）：maxRetries 经 options.modelMaxRetries 逐次解析
 * 注入（agent-core 不依赖存储实现），作用于对话 streamText、compact generateText
 * 与子代理 streamText。Seam：AgentTask 公共接口 + MockLanguageModelV4 的调用
 * 记录（doStream/doGenerate 的实际发起次数 = 重试行为的可观察结果）+ 落库文案。
 * 错误用可自动重试的 5xx APICallError 且带 retry-after-ms: 1 响应头——退避压到
 * 1ms，测试不真等 SDK 默认 2s 起步的指数退避。
 */
const profile = {
  id: "profile-1",
  name: "GLM",
  baseURL: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "sk-test",
  model: "glm-4.7",
};

function taskRecord(): TaskRecord {
  return {
    id: "task-1",
    title: "demo",
    workspacePath: "C:/work/demo",
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

/** 可自动重试的 5xx 错误（isRetryable 默认 statusCode >= 500 为 true） */
function retryableError(attempt: number) {
  return new APICallError({
    message: `第 ${attempt} 次尝试失败`,
    url: "https://example.com/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 500,
    responseBody: "",
    // 退避压到 1ms（SDK 尊重 retry-after-ms 响应头），重试多次也不拖慢测试
    responseHeaders: { "retry-after-ms": "1" },
  });
}

/** 每次模型调用都失败（对话 doStream / 压缩 doGenerate 共用形态） */
function alwaysFailingModel() {
  const model = new MockLanguageModelV4({
    // wrapper 先 push 再调本函数：doStreamCalls.length 已含本次调用（第 N 次）
    doStream: async () => {
      throw retryableError(model.doStreamCalls.length);
    },
    doGenerate: async () => {
      throw retryableError(model.doGenerateCalls.length);
    },
  });
  return model;
}

function fakeClock() {
  let tick = 0;
  return () => `2026-11-11T08:00:${String(++tick).padStart(2, "0")}.000Z`;
}

const tempStores: ReturnType<typeof createSqliteTaskStore>[] = [];

function makeTask(options: { modelMaxRetries?: () => number } = {}) {
  const persistence = createSqliteTaskStore(":memory:");
  tempStores.push(persistence);
  const record = taskRecord();
  persistence.insertTask(record);
  const model = alwaysFailingModel();
  const task = createAgentTask({
    record,
    persistence,
    history: persistence.listMessages(record.id),
    languageModelFor: () => model,
    now: fakeClock(),
    modelMaxRetries: options.modelMaxRetries,
  });
  return { task, persistence, model };
}

/**
 * 压缩场景装配：注入足够长的历史（对话轮用成功模型跑会先失败，故直接
 * 历史注入——与 compact.test.ts 既有先例同构），模型仅 doGenerate 失败。
 */
function makeCompactTask(options: { modelMaxRetries?: () => number } = {}) {
  const persistence = createSqliteTaskStore(":memory:");
  tempStores.push(persistence);
  const record = taskRecord();
  persistence.insertTask(record);
  let streamCall = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      streamCall += 1;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-start", id: "text-1" });
            controller.enqueue({
              type: "text-delta",
              id: "text-1",
              delta: `第${streamCall}轮回复`,
            });
            controller.enqueue({ type: "text-end", id: "text-1" });
            controller.enqueue({
              type: "finish",
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: undefined,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: {
                  total: 2,
                  text: undefined,
                  reasoning: undefined,
                },
              },
              finishReason: { unified: "stop" as const, raw: "stop" },
            });
            controller.close();
          },
        }),
      };
    },
    doGenerate: async () => {
      throw retryableError(model.doGenerateCalls.length);
    },
  });
  const task = createAgentTask({
    record,
    persistence,
    history: Array.from({ length: 8 }, (_, index) => ({
      id: `history-${index}`,
      taskId: "task-1",
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `历史 ${index}`,
      createdAt: `2026-11-11T08:00:0${index}.000Z`,
    })),
    languageModelFor: () => model,
    now: fakeClock(),
    modelMaxRetries: options.modelMaxRetries,
  });
  return { task, persistence, model };
}

afterEach(() => {
  for (const store of tempStores.splice(0)) {
    store.close();
  }
});

async function collect(
  iterable: AsyncIterable<TaskEvent>
): Promise<TaskEvent[]> {
  const events: TaskEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

describe("AgentTask 对话 maxRetries（执行设置 resolver 注入）", () => {
  it("注入 3：SDK 实际发起 4 次调用（首次 + 3 次重试），error 文案携带配置值", async () => {
    const { task, model, persistence } = makeTask({
      modelMaxRetries: () => 3,
    });

    const events = await collect(task.sendMessage({ text: "开工", profile }));

    expect(model.doStreamCalls).toHaveLength(4);
    const errors = events.filter(
      (event): event is Extract<TaskEvent, { type: "error" }> =>
        event.type === "error"
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message.content).toContain("已重试 3 次");
    expect(errors[0]!.message.content).toContain("模型请求失败");
    expect(
      persistence.listMessages("task-1").filter((m) => m.role === "error")
    ).toHaveLength(1);
  });

  it("注入 0：快速失败仅 1 次调用，文案不再声称「已重试」", async () => {
    const { task, model } = makeTask({ modelMaxRetries: () => 0 });

    const events = await collect(task.sendMessage({ text: "开工", profile }));

    expect(model.doStreamCalls).toHaveLength(1);
    const errors = events.filter(
      (event): event is Extract<TaskEvent, { type: "error" }> =>
        event.type === "error"
    );
    expect(errors).toHaveLength(1);
    // 0 次重试时不能出现「已重试」（票面：配置为 0 时不再声称「已重试」）
    expect(errors[0]!.message.content).not.toContain("已重试");
    expect(errors[0]!.message.content).toContain("模型请求失败");
    expect(errors[0]!.message.content).toContain("第 1 次尝试失败");
  });

  it("未注入 resolver：用默认 2（保持 SDK 现默认，ADR 0024）", async () => {
    const { task, model } = makeTask();

    await collect(task.sendMessage({ text: "开工", profile }));

    expect(model.doStreamCalls).toHaveLength(3);
  });

  it("回合开始快照：进行中回合不受中途调大影响，下一回合按新值执行", async () => {
    // 首次读取返回 1，此后返回 3：快照语义下第一回合 2 次调用（1+1）；
    // 第二回合按新值 3 发起 4 次调用（3+1）
    let reads = 0;
    const resolver = () => {
      reads += 1;
      return reads === 1 ? 1 : 3;
    };
    const { task, model } = makeTask({ modelMaxRetries: resolver });

    await collect(task.sendMessage({ text: "第一回合", profile }));
    expect(model.doStreamCalls).toHaveLength(2);

    // 第二回合重新解析：此时 resolver 返回 3，4 次调用
    await collect(task.sendMessage({ text: "第二回合", profile }));
    expect(model.doStreamCalls).toHaveLength(2 + 4);
  });
});

describe("AgentTask compact maxRetries（执行设置 resolver 注入）", () => {
  it("注入 3：压缩请求实际发起 4 次调用（首次 + 3 次重试），失败提示携带配置值", async () => {
    const { task, model } = makeCompactTask({ modelMaxRetries: () => 3 });

    await expect(task.compact({ profile })).rejects.toThrow(
      "模型请求失败（已重试 3 次）"
    );

    expect(model.doGenerateCalls).toHaveLength(4);
  });

  it("注入 0：快速失败仅 1 次调用，提示不再声称「已重试」", async () => {
    const { task, model } = makeCompactTask({ modelMaxRetries: () => 0 });

    await expect(task.compact({ profile })).rejects.toThrow(
      "模型请求失败（HTTP 500）：第 1 次尝试失败"
    );

    expect(model.doGenerateCalls).toHaveLength(1);
  });
});

describe("子代理 maxRetries（执行设置 resolver 注入）", () => {
  const subProfile = {
    ...profile,
    id: "sub-profile-1",
    name: "GLM 子代理",
  };

  /** 主模型：第一轮委派子代理，第二轮回最终文本 */
  function delegatingMainModel() {
    let call = 0;
    return new MockLanguageModelV4({
      doStream: async () => {
        call += 1;
        const stream = new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            if (call === 1) {
              controller.enqueue({
                type: "tool-call",
                toolCallId: "delegate-1",
                toolName: "spawn_subagent",
                input: JSON.stringify({ task: "独立检索并汇总" }),
              });
            } else {
              controller.enqueue({ type: "text-start", id: "text-1" });
              controller.enqueue({
                type: "text-delta",
                id: "text-1",
                delta: "收到报告",
              });
              controller.enqueue({ type: "text-end", id: "text-1" });
            }
            controller.enqueue({
              type: "finish",
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: undefined,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: {
                  total: 2,
                  text: undefined,
                  reasoning: undefined,
                },
              },
              finishReason: {
                unified:
                  call === 1 ? ("tool-calls" as const) : ("stop" as const),
                raw: call === 1 ? "tool_calls" : "stop",
              },
            });
            controller.close();
          },
        });
        return { stream };
      },
    });
  }

  function makeSubagentTask(options: { modelMaxRetries?: () => number }) {
    const persistence = createSqliteTaskStore(":memory:");
    tempStores.push(persistence);
    const record = taskRecord();
    persistence.insertTask(record);
    const mainModel = delegatingMainModel();
    const subModel = new MockLanguageModelV4({
      doStream: async () => {
        throw retryableError(subModel.doStreamCalls.length);
      },
    });
    const task = createAgentTask({
      record,
      persistence,
      history: persistence.listMessages(record.id),
      languageModelFor: (p) => (p.id === subProfile.id ? subModel : mainModel),
      tools: createBuiltinTools(),
      subagents: {
        tools: createBuiltinTools(),
        languageModelFor: (p) =>
          p.id === subProfile.id ? subModel : mainModel,
        settings: () => ({ maxConcurrent: 3 }),
        resolveProfile: async () => subProfile,
        modelMaxRetries: options.modelMaxRetries,
      },
      now: fakeClock(),
    });
    return { task, persistence, subModel };
  }

  it("注入 3：子代理请求实际发起 4 次调用（首次 + 3 次重试），失败报告携带配置值", async () => {
    const { task, subModel, persistence } = makeSubagentTask({
      modelMaxRetries: () => 3,
    });

    const events = await collect(
      task.sendMessage({ text: "委派检索", profile })
    );

    expect(subModel.doStreamCalls).toHaveLength(4);
    // 失败原因作为子代理报告回流主任务（spawn_subagent 卡片的 call.output）
    const reports = events
      .filter(
        (event): event is Extract<TaskEvent, { type: "tool-result" }> =>
          event.type === "tool-result"
      )
      .map((event) => event.call.output);
    const report = reports.find((text) => text.includes("子代理执行失败"));
    expect(report).toContain("已重试 3 次");
    expect(report).toContain("第 4 次尝试失败");
    // 主任务不因子代理失败而崩：最终文本回复照常
    expect(events.some((event) => event.type === "assistant-done")).toBe(true);
    expect(
      persistence.listMessages("task-1").filter((m) => m.role === "error")
    ).toHaveLength(0);
  });

  it("注入 0：子代理快速失败仅 1 次调用，报告不再声称「已重试」", async () => {
    const { task, subModel } = makeSubagentTask({ modelMaxRetries: () => 0 });

    const events = await collect(
      task.sendMessage({ text: "委派检索", profile })
    );

    expect(subModel.doStreamCalls).toHaveLength(1);
    const reports = events
      .filter(
        (event): event is Extract<TaskEvent, { type: "tool-result" }> =>
          event.type === "tool-result"
      )
      .map((event) => event.call.output);
    const report = reports.find((text) => text.includes("子代理执行失败"));
    expect(report).toBeDefined();
    expect(report).not.toContain("已重试");
    expect(report).toContain("第 1 次尝试失败");
  });
});
