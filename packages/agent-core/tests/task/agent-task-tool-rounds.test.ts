import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { createSqliteTaskStore } from "../../src/task/persistence";
import { createAgentTask } from "../../src/task/agent-task";
import type { TaskEvent, TaskRecord } from "../../src/task/types";
import { createBuiltinTools } from "../../src/tools/builtin";

/**
 * 执行设置（ADR 0017，GLOSSARY「工具轮次」）：主任务工具轮次上限为逐次解析的
 * 取值函数（resolver 范式，先例为子代理并发设置）。行为级断言只看外部可见结果：
 * 撞限时机（tool-result 数）、落库 error 提示内容、回合开始快照语义与撞限后可继续。
 * 未注入时默认 200 的行为由 agent-task-tools.test.ts 既有满 200 轮测试守护，此处不重复。
 */

const profile = {
  id: "profile-1",
  name: "GLM",
  baseURL: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "sk-test",
  models: ["glm-4.7"],
};

function taskRecord(workspacePath: string): TaskRecord {
  return {
    id: "task-1",
    title: "demo",
    workspacePath,
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

function usage(input = 1, output = 2) {
  return {
    inputTokens: {
      total: input,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: output, text: undefined, reasoning: undefined },
  };
}

/** 工具调用轮流式（finishReason 为 tool-calls，工具由任务循环执行后回填） */
function toolCallRound(
  toolCalls: { toolCallId: string; toolName: string; input: unknown }[],
  tokens = usage()
) {
  const stream = new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (const call of toolCalls) {
        controller.enqueue({
          type: "tool-call",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: JSON.stringify(call.input),
        });
      }
      controller.enqueue({
        type: "finish",
        usage: tokens,
        finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
      });
      controller.close();
    },
  });
  return { stream };
}

/** 文本轮流式（ai v7：text-start/delta/end 包裹） */
function textRound(
  deltas: string[],
  tokens = usage()
): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "text-start", id: "text-1" });
      for (const delta of deltas) {
        controller.enqueue({ type: "text-delta", id: "text-1", delta });
      }
      controller.enqueue({ type: "text-end", id: "text-1" });
      controller.enqueue({
        type: "finish",
        usage: tokens,
        finishReason: { unified: "stop" as const, raw: "stop" },
      });
      controller.close();
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

/**
 * 失控循环模型：每次请求消耗一次「剩余工具轮」预算返回一轮 update_plan 调用
 * （toolCallId 全局递增唯一）；预算耗尽后改返最终文本（模拟模型收尾）。
 * 预算由测试跨回合显式调整（Infinity = 一直循环，直到撞限）。
 */
function loopingModel(budget: { remainingToolRounds: number }) {
  let callNo = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      if (budget.remainingToolRounds <= 0) {
        return { stream: textRound(["收尾"]) };
      }
      budget.remainingToolRounds -= 1;
      callNo += 1;
      return toolCallRound([
        {
          toolCallId: `loop-${callNo}`,
          toolName: "update_plan",
          input: {
            steps: [{ content: "循环步骤", status: "in_progress" }],
          },
        },
      ]);
    },
  });
}

function makeTask(
  model: MockLanguageModelV4,
  options: { toolRoundsLimit?: () => number } = {}
) {
  const persistence = createSqliteTaskStore(":memory:");
  const record = taskRecord("C:/work/demo");
  persistence.insertTask(record);
  const task = createAgentTask({
    record,
    persistence,
    history: persistence.listMessages(record.id),
    languageModelFor: () => model,
    tools: createBuiltinTools(),
    now: fakeClock(),
    toolRoundsLimit: options.toolRoundsLimit,
  });
  return { task, persistence };
}

function capErrorsOf(events: TaskEvent[]) {
  return events.filter(
    (event): event is Extract<TaskEvent, { type: "error" }> =>
      event.type === "error"
  );
}

describe("AgentTask 工具轮次上限（执行设置 resolver 注入）", () => {
  it("任务用量（ADR 0029）：一条消息内多轮 streamText 的真实 usage 逐次入账求和，落库主任务用量列", async () => {
    // 2 工具轮 + 1 收尾轮 = 一次 sendMessage 内 3 次 streamText，usage 各异
    const responses = [
      toolCallRound(
        [
          {
            toolCallId: "usage-1",
            toolName: "update_plan",
            input: { steps: [{ content: "步骤一", status: "completed" }] },
          },
        ],
        usage(10, 20)
      ),
      toolCallRound(
        [
          {
            toolCallId: "usage-2",
            toolName: "update_plan",
            input: { steps: [{ content: "步骤二", status: "completed" }] },
          },
        ],
        usage(30, 40)
      ),
      { stream: textRound(["收尾"], usage(5, 7)) },
    ];
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => responses[Math.min(call++, responses.length - 1)]!,
    });
    const { task, persistence } = makeTask(model);

    const events = await collect(task.sendMessage({ text: "跑两轮", profile }));
    expect(events.filter((event) => event.type === "tool-result")).toHaveLength(
      2
    );

    const stored = persistence.listTasks()[0];
    expect(stored?.mainInputTokens).toBe(45);
    expect(stored?.mainOutputTokens).toBe(67);
    // 子代理列不受主任务入账影响
    expect(stored?.subagentInputTokens ?? 0).toBe(0);
    persistence.close();
  });

  it("注入低值上限：满注入值轮后停止剩余调用，error 提示携带注入值", async () => {
    const model = loopingModel({
      remainingToolRounds: Number.POSITIVE_INFINITY,
    });
    const { task, persistence } = makeTask(model, { toolRoundsLimit: () => 3 });

    const events = await collect(task.sendMessage({ text: "开工", profile }));

    // 第 4 轮的调用被丢弃，恰好执行注入的 3 轮
    expect(events.filter((event) => event.type === "tool-result")).toHaveLength(
      3
    );
    const capErrors = capErrorsOf(events);
    expect(capErrors).toHaveLength(1);
    expect(capErrors[0]!.message.content).toContain("（3 轮）");
    expect(capErrors[0]!.message.content).toContain("工具轮次上限");
    // 提示随 transcript 落库（重启后仍可见）
    expect(
      persistence.listMessages("task-1").filter((m) => m.role === "error")
    ).toHaveLength(1);
    persistence.close();
  });

  it("回合开始快照：进行中回合不受中途调小影响（整个回合用开始时读到的值）", async () => {
    const model = loopingModel({
      remainingToolRounds: Number.POSITIVE_INFINITY,
    });
    // 首次读取返回 3，此后返回 1：若逐轮读取，回合会在第 1 轮后撞限；
    // 回合开始快照语义下应完整执行 3 轮
    let reads = 0;
    const { task, persistence } = makeTask(model, {
      toolRoundsLimit: () => (reads === 0 ? 3 : ((reads += 1), 1)),
    });

    const events = await collect(task.sendMessage({ text: "开工", profile }));

    expect(events.filter((event) => event.type === "tool-result")).toHaveLength(
      3
    );
    const capErrors = capErrorsOf(events);
    expect(capErrors).toHaveLength(1);
    expect(capErrors[0]!.message.content).toContain("（3 轮）");
    persistence.close();
  });

  it("撞限后可发消息继续：下一回合重新解析取值函数，按新值执行至最终回复", async () => {
    const budget = { remainingToolRounds: Number.POSITIVE_INFINITY };
    const model = loopingModel(budget);
    let limit = 2;
    const { task, persistence } = makeTask(model, {
      toolRoundsLimit: () => limit,
    });

    // 回合 1：上限 2，撞限落库
    const first = await collect(task.sendMessage({ text: "开工", profile }));
    expect(first.filter((event) => event.type === "tool-result")).toHaveLength(
      2
    );
    expect(capErrorsOf(first)).toHaveLength(1);

    // 回合 2：调大到 4——模型先做 4 轮工具调用再收尾，不再撞限且有最终文本
    limit = 4;
    budget.remainingToolRounds = 4;
    const second = await collect(
      task.sendMessage({ text: "继续剩余工作", profile })
    );
    expect(second.filter((event) => event.type === "tool-result")).toHaveLength(
      4
    );
    expect(capErrorsOf(second)).toHaveLength(0);
    expect(second.some((event) => event.type === "assistant-done")).toBe(true);
    // 回合 1 的撞限提示仍在库中（不因后续回合消失）
    expect(
      persistence.listMessages("task-1").filter((m) => m.role === "error")
    ).toHaveLength(1);
    persistence.close();
  });
});
