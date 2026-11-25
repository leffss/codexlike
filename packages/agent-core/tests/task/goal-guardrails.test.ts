import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";

import { isGoalToolActivity } from "../../src/goal/continuation";
import {
  goalSpentTokens,
  isGoalBudgetExceeded,
  taskUsageTokens,
} from "../../src/goal/budget";
import type { GoalRecord } from "../../src/goal/types";
import type { ProviderProfile } from "../../src/provider/provider-profile";
import type { ToolDefinition } from "../../src/tools/types";
import { createSqliteTaskStore } from "../../src/task/persistence";
import { createTaskManager } from "../../src/task/manager";
import type { TaskEvent } from "../../src/task/types";

/**
 * 目标模式（ADR 0035）票 05 的 agent-core 侧：两道护栏的数据面。
 * - token 预算是目标级参数：目标设定时对任务用量账目拍基线，目标消耗 =
 *   当前账目 − 基线（GLOSSARY「任务用量」口径）；
 * - 「实质工具活动」只认实际执行了的工具调用（被拒绝 / 参数无效 / 未注册的
 *   调用不算活动）。
 * 接缝：TaskManager 的目标 API 与 AgentTask.sendMessage 的事件流——结果一律
 * 经 manager 读回，不直查表。
 */
const profile: ProviderProfile = {
  id: "profile-1",
  name: "GLM",
  baseURL: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "sk-test",
  models: ["glm-4.7"],
};

const GOAL_TEXT = "让示例测试全部通过";

/** 固定时钟：每次调用递增一秒 */
function fakeClock(startSecond = 0) {
  let tick = startSecond;
  return () => {
    tick += 1;
    return `2026-11-26T08:00:${String(tick).padStart(2, "0")}.000Z`;
  };
}

/** 一次模型调用的 usage：缺省 (输入 1, 输出 2)，可按脚本指定 */
function usage(tokens: [number, number] = [1, 2]) {
  return {
    inputTokens: {
      total: tokens[0],
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: tokens[1], text: undefined, reasoning: undefined },
  };
}

/** ai v7 起流式文本必须包裹 text-start / text-end part */
function textStream(deltas: string[], tokens: [number, number]) {
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      controller.enqueue({ type: "text-start", id: "text-1" });
      for (const delta of deltas) {
        controller.enqueue({ type: "text-delta", id: "text-1", delta });
      }
      controller.enqueue({ type: "text-end", id: "text-1" });
      controller.enqueue({
        type: "finish",
        usage: usage(tokens),
        finishReason: { unified: "stop" as const, raw: "stop" },
      });
      controller.close();
    },
  });
}

function generateResult(text: string, tokens: [number, number]) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: usage(tokens),
    warnings: [],
  };
}

/** 一次脚本化的非流式调用：返回文本，或以给定错误失败 */
type GenerateStep =
  { text: string; tokens?: [number, number] } | { fail: Error };

/** 一次工作轮的脚本：正文，或先发一组工具调用 */
type WorkStep =
  | { text: string; tokens?: [number, number] }
  | { toolCalls: { name: string; rawInput: string }[] };

/**
 * 脚本化双通道模型：doStream 按脚本逐轮回放工作轮（工具调用的入参以协议层
 * 的 JSON 原文给出，可构造非法入参），doGenerate 按脚本逐次应答非流式调用
 * （完成判定 / 压缩）。脚本耗尽即抛错——多发的请求不该悄悄成功。
 */
function scriptedModel(script: { work: WorkStep[]; generate: GenerateStep[] }) {
  return new MockLanguageModelV4({
    doStream: async () => {
      const step = script.work.shift();
      if (step === undefined) throw new Error("工作轮脚本已耗尽");
      if ("toolCalls" in step) {
        return {
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              for (const [index, call] of step.toolCalls.entries()) {
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: `call-${index}`,
                  toolName: call.name,
                  input: call.rawInput,
                });
              }
              controller.enqueue({
                type: "finish",
                usage: usage(),
                finishReason: {
                  unified: "tool-calls" as const,
                  raw: "tool_calls",
                },
              });
              controller.close();
            },
          }),
        };
      }
      return { stream: textStream([step.text], step.tokens ?? [1, 2]) };
    },
    doGenerate: async () => {
      const step = script.generate.shift();
      if (step === undefined) throw new Error("非流式脚本已耗尽");
      if ("fail" in step) throw step.fail;
      return generateResult(step.text, step.tokens ?? [1, 2]);
    },
  });
}

const tempStores: ReturnType<typeof createSqliteTaskStore>[] = [];

afterEach(() => {
  for (const store of tempStores.splice(0)) {
    store.close();
  }
});

/** 装配：真实任务 + 脚本化模型；模型经 provider 工厂注入（与生产同一条路） */
function setup(
  script: { work: WorkStep[]; generate: GenerateStep[] },
  options: {
    tools?: ToolDefinition[];
    approvalMode?: "ask" | "assist" | "full-access";
  } = {}
) {
  const store = createSqliteTaskStore(":memory:");
  tempStores.push(store);
  const model = scriptedModel(script);
  const manager = createTaskManager({
    persistence: store,
    tools: options.tools,
    languageModelFor: () => model,
    modelMaxRetries: () => 0,
    now: fakeClock(),
  });
  const task = manager.create({
    workspacePath: "C:/work/demo",
    ...(options.approvalMode === undefined
      ? {}
      : { approvalMode: options.approvalMode }),
  });
  return { store, model, manager, task };
}

/** 收集一次 sendMessage 的事件流 */
async function collect(
  execution: AsyncIterable<TaskEvent>
): Promise<TaskEvent[]> {
  const events: TaskEvent[] = [];
  for await (const event of execution) events.push(event);
  return events;
}

/** 目标记录（纯函数用例的最小合法形状） */
function goalOf(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    id: "goal-1",
    taskId: "task-1",
    text: GOAL_TEXT,
    status: "active",
    activeMs: 0,
    activeSince: "2026-11-26T08:00:00.000Z",
    createdAt: "2026-11-26T08:00:00.000Z",
    updatedAt: "2026-11-26T08:00:00.000Z",
    idleStreak: 0,
    failureStreak: 0,
    budgetTokens: null,
    baselineTokens: 0,
    ...overrides,
  };
}

describe("token 预算：目标级参数与对账基线", () => {
  it("设定目标时对任务用量拍基线：目标消耗自此起算，任务此前的用量不计入；未设预算即不限", async () => {
    const app = setup({ work: [{ text: "先聊一句" }], generate: [] });
    // 目标之前：一轮对话（主任务列 1+2）与子代理列的既有账目（4+5）
    await collect(app.task.sendMessage({ text: "先聊一句", profile }));
    app.manager.addUsage(app.task.id, {
      subagentInputTokens: 4,
      subagentOutputTokens: 5,
    });

    const goal = app.manager.setGoal(app.task.id, GOAL_TEXT);

    expect(goal).toMatchObject({ budgetTokens: null, baselineTokens: 12 });
    expect(app.manager.goal(app.task.id)).toMatchObject({
      budgetTokens: null,
      baselineTokens: 12,
    });
  });

  it("同一任务先后有多个目标时各算各的：第二个目标的基线是它的设定时刻账目", async () => {
    const app = setup({
      work: [{ text: "第一个目标的工作" }, { text: "第二个目标的工作" }],
      generate: [],
    });
    app.manager.setGoal(app.task.id, "第一个目标");
    await collect(app.task.sendMessage({ text: "第一个目标的工作", profile }));
    // 第一个目标完成时账目：3
    app.manager.transitionGoal(app.task.id, "complete");

    const second = app.manager.setGoal(app.task.id, "第二个目标");
    expect(second.baselineTokens).toBe(3);

    await collect(app.task.sendMessage({ text: "第二个目标的工作", profile }));
    // 任务账目已是 6；第一个目标的基线原样保留（历史不被改写）
    expect(app.manager.list()[0]).toMatchObject({
      mainInputTokens: 2,
      mainOutputTokens: 4,
    });
    expect(app.manager.goal(app.task.id)).toMatchObject({
      text: "第二个目标",
      baselineTokens: 3,
    });
  });
});

describe("TaskManager.setGoalBudget（设定 / 调整预算）", () => {
  it("设定预算落库并可经 goal 读回；进行中与预算受限（加预算）时都可调整，状态与连续计数不受影响", () => {
    const app = setup({ work: [], generate: [] });
    app.manager.setGoal(app.task.id, GOAL_TEXT);

    expect(app.manager.setGoalBudget(app.task.id, 200_000)).toMatchObject({
      status: "active",
      budgetTokens: 200_000,
      baselineTokens: 0,
    });
    expect(app.manager.goal(app.task.id)?.budgetTokens).toBe(200_000);

    // 预算受限态直接加预算：改的只是预算，停留状态留给用户显式恢复
    app.manager.transitionGoal(app.task.id, "budget-limit");
    app.manager.setGoalBudget(app.task.id, 500_000);

    expect(app.manager.goal(app.task.id)).toMatchObject({
      status: "budget-limited",
      budgetTokens: 500_000,
      baselineTokens: 0,
    });
  });

  it("非法预算与已结束的目标以中文原因拒绝，原记录不变", () => {
    const app = setup({ work: [], generate: [] });
    expect(() => app.manager.setGoalBudget("missing-task", 100)).toThrow(
      "任务不存在"
    );
    expect(() => app.manager.setGoalBudget(app.task.id, 100)).toThrow(
      "任务尚未设定目标"
    );

    app.manager.setGoal(app.task.id, GOAL_TEXT);
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => app.manager.setGoalBudget(app.task.id, invalid)).toThrow(
        "token 预算必须是正整数"
      );
    }
    expect(app.manager.goal(app.task.id)?.budgetTokens).toBeNull();

    app.manager.transitionGoal(app.task.id, "complete");
    expect(() => app.manager.setGoalBudget(app.task.id, 100)).toThrow(
      "目标已完成，不能修改预算"
    );
    app.manager.transitionGoal(app.task.id, "clear");
    expect(() => app.manager.setGoalBudget(app.task.id, 100)).toThrow(
      "目标已清除，不能修改预算"
    );
    expect(app.manager.goal(app.task.id)?.budgetTokens).toBeNull();
  });
});

describe("对账口径：目标消耗 = 任务用量账目 − 基线（GLOSSARY「任务用量」）", () => {
  const PASSED_VERDICT = {
    passed: true,
    reason: "示例测试已全部通过",
    nextAction: "",
  };

  it("主任务各轮、子代理、压缩与完成判定自身的用量都计入目标消耗", async () => {
    // 四轮对话凑够可压缩的历史（/compact 默认保留最近 3 轮）
    const app = setup({
      work: [1, 2, 3, 4].map((index) => ({
        text: `第${index}轮回复`,
        tokens: [10, 20],
      })),
      generate: [
        { text: "旧历史摘要", tokens: [1000, 2000] },
        { text: JSON.stringify(PASSED_VERDICT), tokens: [100, 200] },
      ],
    });
    app.manager.setGoal(app.task.id, GOAL_TEXT);
    for (const index of [1, 2, 3, 4]) {
      await collect(app.task.sendMessage({ text: `第${index}轮`, profile }));
    }
    // 子代理列的账目（子代理运行时与宿主辅助调用同一入账入口）
    app.manager.addUsage(app.task.id, {
      subagentInputTokens: 40,
      subagentOutputTokens: 50,
    });
    await app.task.compact({ profile });
    await app.manager.verifyGoal(app.task.id, { profile });

    const goal = app.manager.goal(app.task.id)!;
    const usage = taskUsageTokens(app.manager.list()[0]!);
    // 工作轮 4 × 30 + 子代理 90 + 压缩 3000 + 判定 300
    expect(usage).toBe(3510);
    expect(goalSpentTokens(goal, usage)).toBe(3510);
    // 未设预算：账目再大也不超
    expect(isGoalBudgetExceeded(goal, usage)).toBe(false);
  });

  it("用量达到预算即超限，差一个 token 不超；基线之前任务的用量不计入", () => {
    const goal = goalOf({ budgetTokens: 1000, baselineTokens: 500 });
    // 任务账目 1499 → 目标消耗 999
    expect(goalSpentTokens(goal, 1499)).toBe(999);
    expect(isGoalBudgetExceeded(goal, 1499)).toBe(false);
    // 任务账目 1500 → 目标消耗 1000：预算用尽即受限
    expect(isGoalBudgetExceeded(goal, 1500)).toBe(true);
    // 未设预算恒不超
    expect(isGoalBudgetExceeded(goalOf({ budgetTokens: null }), 10 ** 12)).toBe(
      false
    );
  });
});

/** 一个写入类工具（ask 档下需要审批）；执行记录供断言副作用 */
function noteTool(executed: unknown[]): ToolDefinition {
  return {
    name: "note",
    description: "记一条笔记（写入类）",
    permission: "write",
    parameters: { type: "object" },
    async execute(input) {
      executed.push(input);
      return { output: "已记录", isError: false };
    },
  };
}

/** 一个执行即出错的工具（如命令非零退出）：执行了，但结果是错误 */
function boomTool(): ToolDefinition {
  return {
    name: "boom",
    description: "必定失败的工具",
    permission: "write",
    parameters: { type: "object" },
    async execute() {
      return { output: "命令以状态码 1 退出", isError: true };
    },
  };
}

/** 拉取事件流；审批请求按到达顺序以 decisions 逐一响应 */
async function drive(
  task: ReturnType<typeof setup>["task"],
  text: string,
  decisions: ("approve" | "reject")[]
): Promise<TaskEvent[]> {
  const events: TaskEvent[] = [];
  for await (const event of task.sendMessage({ text, profile })) {
    events.push(event);
    if (event.type === "interaction-request") {
      const decision = decisions.shift();
      if (decision === undefined) throw new Error("审批脚本已耗尽");
      task.respondApproval(event.interaction.request.id, decision);
    }
  }
  return events;
}

describe("实质工具活动：只认实际执行了的工具调用", () => {
  it("isGoalToolActivity：未执行的调用（被拒绝 / 参数无效 / 未注册）不算；执行了即使结果出错仍算；只改计划不算", () => {
    expect(isGoalToolActivity("write_file", true)).toBe(true);
    expect(isGoalToolActivity("write_file", false)).toBe(false);
    // 实际执行但结果出错（如命令非零退出）仍是活动
    expect(isGoalToolActivity("run_terminal_command", true)).toBe(true);
    // 只改计划不算，无论是否执行
    expect(isGoalToolActivity("update_plan", true)).toBe(false);
    expect(isGoalToolActivity("update_plan", false)).toBe(false);
  });

  it("tool-result 事件如实标注是否实际执行：被用户拒绝、参数无效、工具不存在 → 未执行；执行完成（含结果出错）→ 已执行", async () => {
    const executed: unknown[] = [];
    const app = setup(
      {
        work: [
          {
            toolCalls: [
              { name: "note", rawInput: '{"text":"会被拒绝的调用"}' },
              { name: "note", rawInput: '{"broken":' },
              { name: "ghost_tool", rawInput: "{}" },
              { name: "note", rawInput: '{"text":"正常执行"}' },
              { name: "boom", rawInput: "{}" },
              {
                name: "update_plan",
                rawInput:
                  '{"steps":[{"content":"只改计划","status":"in_progress"}]}',
              },
            ],
          },
          { text: "收尾" },
        ],
        generate: [],
      },
      { tools: [noteTool(executed), boomTool()], approvalMode: "ask" }
    );

    const events = await drive(app.task, GOAL_TEXT, [
      "reject",
      "approve",
      "approve",
    ]);

    expect(
      events
        .filter((event) => event.type === "tool-result")
        .map((event) => {
          if (event.type !== "tool-result") throw new Error("类型收窄");
          return [event.call.toolName, event.executed, event.call.isError];
        })
    ).toEqual([
      ["note", false, true],
      ["note", false, true],
      ["ghost_tool", false, true],
      ["note", true, false],
      ["boom", true, true],
      ["update_plan", true, false],
    ]);
    // 未执行的调用没有副作用：note 只在被批准的那一次真正执行
    expect(executed).toEqual([{ text: "正常执行" }]);
  });
});
