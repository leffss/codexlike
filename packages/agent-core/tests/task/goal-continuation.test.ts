import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";

import type { GoalVerificationRecord } from "../../src/goal/types";
import { buildCommitMessagePrompt } from "../../src/git/commit-message";
import {
  buildGoalContinuationInput,
  isGoalToolActivity,
} from "../../src/goal/continuation";
import type { ProviderProfile } from "../../src/provider/provider-profile";
import type { CreateLanguageModelOptions } from "../../src/provider/language-model";
import { createAgentTask, type AgentTask } from "../../src/task/agent-task";
import { createSqliteTaskStore } from "../../src/task/persistence";
import { createTaskManager } from "../../src/task/manager";
import type { TaskEvent } from "../../src/task/types";

/**
 * 目标模式（ADR 0035）票 03 的 agent-core 侧：续跑循环的记账与输入。
 * - 验证记录区分「判定正常给出未通过」与「判定自身故障」（结论种类），
 *   空转计数与连续故障计数逐轮落库（供票 05 的护栏消费）；
 * - 续跑指令构造（判定未过 → 下一步方向；判定不可用 → 如实告知）；
 * - 续跑轮是内部输入：进模型上下文、随任务落库，但不产生用户消息事件。
 * 接缝：TaskManager 的目标 API 与 AgentTask.sendMessage——结果一律经 manager
 * 读回；注入模型的请求内容经 MockLanguageModelV4 的调用记录观察。
 */
const profile: ProviderProfile = {
  id: "profile-1",
  name: "GLM",
  baseURL: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "sk-test",
  models: ["glm-4.7"],
};

const GOAL_TEXT = "让示例测试全部通过";

const PASSED_VERDICT = {
  passed: true,
  reason: "示例测试已全部通过",
  nextAction: "",
};
const FAILED_VERDICT = {
  passed: false,
  reason: "尚有步骤未完成",
  nextAction: "继续实现剩余步骤",
};

/** 不可自动重试类的请求失败（SDK 不会先重试，用例不等待退避） */
function unauthorized(): Error {
  return new APICallError({
    message: "Unauthorized",
    url: "https://example.com/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 401,
    responseBody: "",
  });
}

/** 固定时钟：每次调用递增一秒 */
function fakeClock(startSecond = 0) {
  let tick = startSecond;
  return () => {
    tick += 1;
    return `2026-11-25T08:00:${String(tick).padStart(2, "0")}.000Z`;
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

/** ai v7 起流式文本必须包裹 text-start / text-end part */
function textStream(
  deltas: string[]
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
        usage: usage(),
        finishReason: { unified: "stop" as const, raw: "stop" },
      });
      controller.close();
    },
  });
}

function generateResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: usage(),
    warnings: [],
  };
}

/** 一次工作轮的脚本：正文，或先发一组工具调用 */
type WorkStep =
  { text: string } | { toolCalls: { name: string; args: unknown }[] };

/**
 * 脚本化双通道模型：doStream 按脚本逐轮回放工作轮，doGenerate 按脚本逐次
 * 应答完成判定。脚本耗尽即抛错——多发的请求不该悄悄成功。
 */
function scriptedModel(script: {
  work: WorkStep[];
  verdicts: (string | Error)[];
}) {
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const step = script.work.shift();
      if (step === undefined) throw new Error("工作轮脚本已耗尽");
      if ("toolCalls" in step) {
        return {
          stream: new ReadableStream({
            start(controller) {
              for (const [index, call] of step.toolCalls.entries()) {
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: `call-${index}`,
                  toolName: call.name,
                  // 协议层携带的是 JSON 原文（SDK 按工具 schema 解析）
                  input: JSON.stringify(call.args),
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
      return { stream: textStream([step.text]) };
    },
    doGenerate: async () => {
      const step = script.verdicts.shift();
      if (step === undefined) throw new Error("判定脚本已耗尽");
      if (step instanceof Error) throw step;
      return generateResult(step);
    },
  });
  return model;
}

const tempStores: ReturnType<typeof createSqliteTaskStore>[] = [];

afterEach(() => {
  for (const store of tempStores.splice(0)) {
    store.close();
  }
});

/** 装配：真实任务 + 脚本化模型；每个用例一个独立目标 */
function setup(
  script: { work: WorkStep[]; verdicts: (string | Error)[] },
  options: {
    tools?: Parameters<typeof createTaskManager>[0]["tools"];
    approvalMode?: "ask" | "assist" | "full-access";
  } = {}
) {
  const store = createSqliteTaskStore(":memory:");
  tempStores.push(store);
  const model = scriptedModel(script);
  const modelRequests: (CreateLanguageModelOptions | undefined)[] = [];
  const manager = createTaskManager({
    persistence: store,
    tools: options.tools,
    languageModelFor: (_selected, options) => {
      modelRequests.push(options);
      return model;
    },
    modelMaxRetries: () => 0,
    now: fakeClock(),
  });
  const task = manager.create({
    workspacePath: "C:/work/demo",
    ...(options.approvalMode === undefined
      ? {}
      : { approvalMode: options.approvalMode }),
  });
  manager.setGoal(task.id, GOAL_TEXT);
  return { store, model, modelRequests, manager, task };
}

/** 收集一次 sendMessage 的事件流 */
async function collect(
  execution: AsyncIterable<TaskEvent>
): Promise<TaskEvent[]> {
  const events: TaskEvent[] = [];
  for await (const event of execution) events.push(event);
  return events;
}

/** 跑一轮回合并判定；返回本轮验证记录 */
async function round(
  manager: ReturnType<typeof createTaskManager>,
  task: AgentTask,
  options: { toolActivity?: boolean } = {}
): Promise<GoalVerificationRecord> {
  await collect(task.sendMessage({ text: "继续推进", profile }));
  const result = await manager.verifyGoal(task.id, {
    profile,
    toolActivity: options.toolActivity ?? false,
  });
  if (result.kind !== "verified")
    throw new Error(`本轮应落验证记录，实际 ${result.kind}`);
  return result.verification;
}

describe("验证记录的结论种类（判定未过 vs 判定自身故障）", () => {
  it("判定通过：outcome = passed；passed 字段照旧为 true", async () => {
    const { manager, task } = setup({
      work: [{ text: "已全部通过" }],
      verdicts: [JSON.stringify(PASSED_VERDICT)],
    });

    const record = await round(manager, task, { toolActivity: true });

    expect(record).toMatchObject({
      round: 1,
      passed: true,
      outcome: "passed",
      toolActivity: true,
    });
    // 经 manager 读回同一条记录
    expect(manager.goalVerifications(task.id)).toEqual([record]);
  });

  it("判定正常给出未通过：outcome = unpassed，passed 为 false，下一步方向留痕", async () => {
    const { manager, task } = setup({
      work: [{ text: "做了一部分" }],
      verdicts: [JSON.stringify(FAILED_VERDICT)],
    });

    const record = await round(manager, task);

    expect(record).toMatchObject({
      passed: false,
      outcome: "unpassed",
      toolActivity: false,
      reason: "尚有步骤未完成",
      nextAction: "继续实现剩余步骤",
    });
  });

  it("判定自身故障（请求失败 / 坏输出 / 模型不可用）：outcome = unavailable——passed 为 false，但与正常的未通过可区分", async () => {
    const requestFailed = setup({
      work: [{ text: "做了一部分" }],
      verdicts: [unauthorized()],
    });
    const failed = await round(requestFailed.manager, requestFailed.task);
    expect(failed).toMatchObject({ passed: false, outcome: "unavailable" });
    expect(failed.reason).toContain("完成判定不可用");

    const badOutput = setup({
      work: [{ text: "做了一部分" }],
      verdicts: ["我觉得已经做完了，不用再改了。"],
    });
    expect(await round(badOutput.manager, badOutput.task)).toMatchObject({
      passed: false,
      outcome: "unavailable",
    });

    // 任务当前模型不可用：不发请求，同样落 unavailable
    const noProfile = setup({ work: [{ text: "做了一部分" }], verdicts: [] });
    await collect(noProfile.task.sendMessage({ text: "继续推进", profile }));
    const result = await noProfile.manager.verifyGoal(noProfile.task.id, {
      toolActivity: true,
    });
    expect(result).toMatchObject({
      kind: "verified",
      verification: {
        passed: false,
        outcome: "unavailable",
        toolActivity: true,
      },
    });
    expect(noProfile.model.doGenerateCalls).toHaveLength(0);
  });
});

describe("空转计数与连续故障计数逐轮落库", () => {
  it("空转计数：未过且无实质工具活动逐轮 +1；有实质工具活动清零；通过清零", async () => {
    const { manager, task } = setup({
      work: [
        { text: "空谈" },
        { text: "空谈" },
        { text: "动手" },
        { text: "空谈" },
        { text: "收尾" },
      ],
      verdicts: [
        JSON.stringify(FAILED_VERDICT),
        JSON.stringify(FAILED_VERDICT),
        JSON.stringify(FAILED_VERDICT),
        JSON.stringify(FAILED_VERDICT),
        JSON.stringify(PASSED_VERDICT),
      ],
    });

    await round(manager, task, { toolActivity: false });
    expect(manager.goal(task.id)).toMatchObject({
      idleStreak: 1,
      failureStreak: 0,
    });

    await round(manager, task, { toolActivity: false });
    expect(manager.goal(task.id)).toMatchObject({
      idleStreak: 2,
      failureStreak: 0,
    });

    // 有实质工具活动的未过轮：空转计数清零
    await round(manager, task, { toolActivity: true });
    expect(manager.goal(task.id)).toMatchObject({
      idleStreak: 0,
      failureStreak: 0,
    });

    await round(manager, task, { toolActivity: false });
    expect(manager.goal(task.id)).toMatchObject({
      idleStreak: 1,
      failureStreak: 0,
    });

    // 通过：清零
    await round(manager, task, { toolActivity: false });
    expect(manager.goal(task.id)).toMatchObject({
      idleStreak: 0,
      failureStreak: 0,
    });
  });

  it("故障轮：连续故障计数 +1、空转计数保持原值（既不加也不清零）；出现正常结论后连续故障计数清零", async () => {
    const { manager, task } = setup({
      work: [
        { text: "空谈" },
        { text: "空谈" },
        { text: "空谈" },
        { text: "空谈" },
      ],
      verdicts: [
        JSON.stringify(FAILED_VERDICT),
        unauthorized(),
        "（不是判定结论）",
        JSON.stringify(FAILED_VERDICT),
      ],
    });

    await round(manager, task, { toolActivity: false });
    expect(manager.goal(task.id)).toMatchObject({
      idleStreak: 1,
      failureStreak: 0,
    });

    // 故障轮：故障计数 +1，空转计数保持 1
    await round(manager, task, { toolActivity: false });
    expect(manager.goal(task.id)).toMatchObject({
      idleStreak: 1,
      failureStreak: 1,
    });

    await round(manager, task, { toolActivity: true });
    expect(manager.goal(task.id)).toMatchObject({
      idleStreak: 1,
      failureStreak: 2,
    });

    // 正常结论（未过）：故障计数清零；该轮无工具活动 → 空转计数从保持的 1 续计到 2
    await round(manager, task, { toolActivity: false });
    expect(manager.goal(task.id)).toMatchObject({
      idleStreak: 2,
      failureStreak: 0,
    });
  });

  it("连续计数随目标落库：同一持久层重建管理器（等价应用重启）后原样可读", async () => {
    const { store, manager, task } = setup({
      work: [{ text: "空谈" }, { text: "空谈" }],
      verdicts: [JSON.stringify(FAILED_VERDICT), unauthorized()],
    });
    await round(manager, task, { toolActivity: false });
    await round(manager, task, { toolActivity: false });

    const restarted = createTaskManager({
      persistence: store,
      now: fakeClock(50),
    });
    expect(restarted.goal(task.id)).toMatchObject({
      status: "active",
      idleStreak: 1,
      failureStreak: 1,
    });
    // 逐轮事实同样留痕：每轮的结论种类与是否有实质工具活动
    expect(
      restarted
        .goalVerifications(task.id)
        .map((record) => [record.outcome, record.toolActivity])
    ).toEqual([
      ["unpassed", false],
      ["unavailable", false],
    ]);
  });

  it("恢复后连续计数从 0 起算：暂停再恢复是新的进行中区段", async () => {
    const { manager, task } = setup({
      work: [{ text: "空谈" }, { text: "空谈" }, { text: "空谈" }],
      verdicts: [
        unauthorized(),
        unauthorized(),
        JSON.stringify(FAILED_VERDICT),
      ],
    });

    await round(manager, task, { toolActivity: false });
    await round(manager, task, { toolActivity: false });
    expect(manager.goal(task.id)).toMatchObject({
      idleStreak: 0,
      failureStreak: 2,
    });

    manager.transitionGoal(task.id, "pause");
    manager.transitionGoal(task.id, "resume");
    expect(manager.goal(task.id)).toMatchObject({
      idleStreak: 0,
      failureStreak: 0,
    });

    await round(manager, task, { toolActivity: false });
    expect(manager.goal(task.id)).toMatchObject({
      idleStreak: 1,
      failureStreak: 0,
    });
  });
});

/* ------------------------------------------------------------------ */
/* 续跑指令构造与「实质工具活动」定义                                      */
/* ------------------------------------------------------------------ */

const GOAL = { text: GOAL_TEXT };

/** 一轮验证记录的最小形状（续跑指令只读结论种类、理由与下一步方向） */
const UNPASSED = {
  outcome: "unpassed",
  reason: "尚有步骤未完成",
  nextAction: "继续实现剩余步骤",
} as const;
const UNAVAILABLE = {
  outcome: "unavailable",
  reason: "完成判定不可用（HTTP 401），本轮没有判定结论",
  nextAction: "",
} as const;

describe("续跑指令构造（buildGoalContinuationInput）", () => {
  it("判定未过：下一步方向与判定理由进入续跑指令，并复述目标原文", () => {
    const text = buildGoalContinuationInput(GOAL, {
      kind: "verification",
      verification: UNPASSED,
    });

    expect(text).toContain(GOAL_TEXT);
    expect(text).toContain("尚有步骤未完成");
    expect(text).toContain("继续实现剩余步骤");
  });

  it("判定未过但判定模型没给下一步方向：指令仍成立，不留空的方向标题", () => {
    const text = buildGoalContinuationInput(GOAL, {
      kind: "verification",
      verification: { ...UNPASSED, nextAction: "" },
    });

    expect(text).toContain(GOAL_TEXT);
    expect(text).toContain("尚有步骤未完成");
    expect(text).not.toMatch(/下一步方向[：:]\s*(\n|$)/);
  });

  it("判定不可用：如实告知上一轮完成判定没有跑成、没有结论，请继续推进——不冒充判定结论", () => {
    const text = buildGoalContinuationInput(GOAL, {
      kind: "verification",
      verification: UNAVAILABLE,
    });

    // 说清是判定自身没跑成（带原因），目标未完成，请继续推进
    expect(text).toContain("完成判定不可用");
    expect(text).toContain("HTTP 401");
    expect(text).toContain(GOAL_TEXT);
    expect(text).toContain("继续");
    // 没有结论就没有「判定理由 / 下一步方向」：不把故障说明包装成模型的判断
    expect(text).not.toMatch(/下一步方向[：:]/);
    expect(text).not.toMatch(/判定理由[：:]/);
  });

  it("恢复（票 04 的接缝）：从暂停点继续推进，复述目标原文", () => {
    const text = buildGoalContinuationInput(GOAL, { kind: "resume" });

    expect(text).toContain("暂停");
    expect(text).toContain(GOAL_TEXT);
    expect(text).not.toContain("完成判定不可用");
  });
});

describe("实质工具活动（isGoalToolActivity）——空转计数的判据", () => {
  it("只改计划不算活动：update_plan 为 false，其余实际执行了的工具调用都算", () => {
    expect(isGoalToolActivity("update_plan", true)).toBe(false);
    for (const name of [
      "run_terminal_command",
      "read_file",
      "write_file",
      "spawn_subagent",
      "ask_user_question",
      "web_search",
      "mcp__github__search",
    ]) {
      expect(isGoalToolActivity(name, true)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 续跑轮：内部输入，不产生用户消息                                        */
/* ------------------------------------------------------------------ */

/** 提取 prompt 消息的纯文本：ai v7 传给 provider 层时 string content 会转为 parts 数组 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((part: { text?: string }) => part.text ?? "").join("");
  return String(content);
}

const CONTINUATION_TEXT =
  "【目标续跑】这是目标模式的内部续跑指令，请继续推进目标";

/** 发起一轮续跑（内部输入） */
function continuation(text = CONTINUATION_TEXT) {
  return { text, profile, goalContinuation: true as const };
}

/** 一个可观察副作用的写入类工具（ask 档下需要审批） */
function noteTool(executed: unknown[]) {
  return {
    name: "note",
    description: "记一条笔记（写入类，用于观察审批与执行）",
    permission: "write" as const,
    parameters: { type: "object" as const },
    async execute(input: unknown) {
      executed.push(input);
      return { output: "已记录", isError: false };
    },
  };
}

describe("续跑轮：内部输入，不产生用户消息", () => {
  it("续跑轮不发 user-message（消息流不产生用户气泡），首个事件是 goal-continuation；指令以 user 角色进入模型上下文，落库为独立角色", async () => {
    const { manager, task, model } = setup({
      work: [{ text: "首轮回复" }, { text: "续跑轮的回复" }],
      verdicts: [],
    });
    await collect(task.sendMessage({ text: GOAL_TEXT, profile }));

    const events = await collect(task.sendMessage(continuation()));

    // 事件流：没有用户消息事件；回合照常起止
    expect(events[0]?.type).toBe("goal-continuation");
    expect(events.some((event) => event.type === "user-message")).toBe(false);
    expect(events.at(-1)?.type).toBe("assistant-done");
    // 模型看到的对话：用户目标 → 助手 → 续跑指令（user 角色）
    const request = model.doStreamCalls[1]!.prompt;
    expect(request.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(textOf(request[3]!.content)).toBe(CONTINUATION_TEXT);
    // 落库：续跑指令既不丢，也不是用户消息——独立的 goal-continuation 角色
    expect(manager.messages(task.id).map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "goal-continuation",
      "assistant",
    ]);
    expect(
      manager
        .messages(task.id)
        .filter((message) => message.role === "user")
        .map((message) => message.content)
    ).toEqual([GOAL_TEXT]);
  });

  it("重启等价：重建任务后续跑指令仍以 user 角色回到模型上下文（不丢、不变成助手消息）", async () => {
    const { store, task } = setup({
      work: [{ text: "首轮回复" }, { text: "续跑轮的回复" }],
      verdicts: [],
    });
    await collect(task.sendMessage({ text: GOAL_TEXT, profile }));
    await collect(task.sendMessage(continuation()));

    const restartedModel = scriptedModel({
      work: [{ text: "重启后的回复" }],
      verdicts: [],
    });
    const restarted = createTaskManager({
      persistence: store,
      languageModelFor: () => restartedModel,
      modelMaxRetries: () => 0,
      now: fakeClock(50),
    });
    await collect(
      restarted.get(task.id)!.sendMessage({ text: "重启后的普通消息", profile })
    );

    const request = restartedModel.doStreamCalls[0]!.prompt;
    expect(request.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(textOf(request[3]!.content)).toBe(CONTINUATION_TEXT);
  });

  it("轮内工具照常：续跑轮里可以更新工作计划、执行工具并拿到结果，再正常收尾", async () => {
    const executed: unknown[] = [];
    const { manager, task } = setup(
      {
        work: [
          { text: "首轮回复" },
          {
            toolCalls: [
              {
                name: "update_plan",
                args: {
                  steps: [
                    { content: "梳理剩余步骤", status: "completed" },
                    { content: "补齐失败用例", status: "in_progress" },
                  ],
                },
              },
              { name: "note", args: { text: "续跑轮里写的笔记" } },
            ],
          },
          { text: "续跑轮收尾" },
        ],
        verdicts: [],
      },
      { tools: [noteTool(executed)] }
    );
    await collect(task.sendMessage({ text: GOAL_TEXT, profile }));

    const events = await collect(task.sendMessage(continuation()));

    expect(
      events
        .filter((event) => event.type === "tool-result")
        .map((event) => {
          if (event.type !== "tool-result") throw new Error("类型收窄");
          return [event.call.toolName, event.call.isError];
        })
    ).toEqual([
      ["update_plan", false],
      ["note", false],
    ]);
    expect(executed).toEqual([{ text: "续跑轮里写的笔记" }]);
    expect(events.at(-1)?.type).toBe("assistant-done");
    // 计划更新随任务落库：工作计划与目标两层并存，续跑轮内照常工作
    expect(
      manager
        .transcript(task.id)
        .filter(
          (item) =>
            item.kind === "tool-call" && item.call.toolName === "update_plan"
        )
    ).toHaveLength(1);
  });

  it("审批等待照旧：ask 档下续跑轮内的写入暂停等待审批，批准后才执行，回合继续到正常收尾", async () => {
    const executedAt: number[] = [];
    const { task } = setup(
      {
        work: [
          { text: "首轮回复" },
          { toolCalls: [{ name: "note", args: { text: "要审批的写入" } }] },
          { text: "续跑轮收尾" },
        ],
        verdicts: [],
      },
      {
        tools: [
          {
            ...noteTool([]),
            async execute() {
              executedAt.push(Date.now());
              return { output: "已记录", isError: false };
            },
          },
        ],
        approvalMode: "ask",
      }
    );
    await collect(task.sendMessage({ text: GOAL_TEXT, profile }));

    let approvedAt = 0;
    const events: TaskEvent[] = [];
    for await (const event of task.sendMessage(continuation())) {
      events.push(event);
      if (event.type === "interaction-request") {
        // 回合在此挂起：隔一小段再批准，执行必须发生在批准之后
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(executedAt).toEqual([]);
        approvedAt = Date.now();
        task.respondApproval(event.interaction.request.id, "approve");
      }
    }

    expect(approvedAt).toBeGreaterThan(0);
    expect(executedAt).toHaveLength(1);
    expect(executedAt[0]!).toBeGreaterThanOrEqual(approvedAt);
    // 事件序：审批请求 →（挂起）→ 批准落定 → 工具执行 → 回合收尾
    expect(events.map((event) => event.type)).toEqual([
      "goal-continuation",
      "assistant-start",
      "tool-call",
      "interaction-request",
      "interaction-resolved",
      "tool-result",
      "assistant-delta",
      "assistant-done",
    ]);
  });

  it("续跑轮被中断：已生成的部分文本保留为中断的助手消息，任务回到可用", async () => {
    const { store, task } = setup({
      work: [{ text: "首轮回复" }],
      verdicts: [],
    });
    await collect(task.sendMessage({ text: GOAL_TEXT, profile }));
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const halting = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          async start(controller) {
            controller.enqueue({ type: "text-start", id: "text-1" });
            controller.enqueue({
              type: "text-delta",
              id: "text-1",
              delta: "续跑轮写到一半",
            });
            await gate;
            controller.enqueue({ type: "text-end", id: "text-1" });
            controller.enqueue({
              type: "finish",
              usage: usage(),
              finishReason: { unified: "stop", raw: "stop" },
            });
            controller.close();
          },
        }),
      }),
    });
    const resumed = createTaskManager({
      persistence: store,
      languageModelFor: () => halting,
      modelMaxRetries: () => 0,
      now: fakeClock(50),
    });
    const controller = new AbortController();
    const events: TaskEvent[] = [];
    for await (const event of resumed
      .get(task.id)!
      .sendMessage({ ...continuation(), signal: controller.signal })) {
      events.push(event);
      if (event.type === "assistant-delta") controller.abort();
    }
    openGate();

    expect(events.at(-1)?.type).toBe("assistant-aborted");
    expect(
      resumed
        .messages(task.id)
        .map((message) => [message.role, message.aborted === true])
    ).toEqual([
      ["user", false],
      ["assistant", false],
      ["goal-continuation", false],
      ["assistant", true],
    ]);
    expect(resumed.list()[0]?.status).toBe("idle");
  });

  it("子代理可在续跑轮内委派：spawn_subagent 照常派发、报告回填，续跑轮正常收尾", async () => {
    const store = createSqliteTaskStore(":memory:");
    tempStores.push(store);
    const subProfile: ProviderProfile = {
      ...profile,
      id: "sub-profile",
      name: "子代理模型",
    };
    const main = scriptedModel({
      work: [
        { text: "首轮回复" },
        {
          toolCalls: [
            { name: "spawn_subagent", args: { task: "调研剩余的失败用例" } },
          ],
        },
        { text: "续跑轮收尾" },
      ],
      verdicts: [],
    });
    const sub = scriptedModel({
      work: [{ text: "子代理报告：还有两个失败用例" }],
      verdicts: [],
    });
    const languageModelFor = (selected: ProviderProfile) =>
      selected.id === subProfile.id ? sub : main;
    const manager = createTaskManager({
      persistence: store,
      languageModelFor,
      modelMaxRetries: () => 0,
      now: fakeClock(),
      subagents: {
        tools: [],
        languageModelFor,
        settings: () => ({ maxConcurrent: 1 }),
        resolveModel: async () => ({
          profile: subProfile,
          model: subProfile.models[0]!,
        }),
      },
    });
    const task = manager.create({ workspacePath: "C:/work/demo" });
    await collect(task.sendMessage({ text: GOAL_TEXT, profile }));

    const events = await collect(task.sendMessage(continuation()));

    // 事件序：续跑轮以 goal-continuation 开始（没有用户消息），委派照常流转
    // （排队 → 启动 → 正文 → 报告），报告回填后主任务接着收尾
    expect(events[0]?.type).toBe("goal-continuation");
    expect(events.some((event) => event.type === "user-message")).toBe(false);
    expect(events.map((event) => event.type)).toEqual([
      "goal-continuation",
      "assistant-start",
      "tool-call",
      "subagent-queued",
      "subagent-start",
      "subagent-text-delta",
      "subagent-report",
      "tool-result",
      "assistant-delta",
      "assistant-done",
    ]);
    // 子代理的报告作为 spawn_subagent 的结果回填主任务
    const report = events.find((event) => event.type === "subagent-report");
    expect(report).toMatchObject({
      report: "子代理报告：还有两个失败用例",
      ok: true,
    });
    const delegated = events.find(
      (event) =>
        event.type === "tool-result" && event.call.toolName === "spawn_subagent"
    );
    expect(delegated).toMatchObject({
      type: "tool-result",
      call: { isError: false, output: "子代理报告：还有两个失败用例" },
    });
    // 委派记录随任务落库（完成态），续跑轮的回复照常是助手消息
    expect(manager.subagents(task.id)).toEqual([
      expect.objectContaining({
        record: expect.objectContaining({ status: "completed" }),
      }),
    ]);
    expect(manager.messages(task.id).map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "goal-continuation",
      "assistant",
    ]);
  });

  it("对话型目标的判定引导：发给判定模型的指令带有「对话型、咨询型目标直接通过」与「证据不足不通过」两条规则", async () => {
    const { manager, task, model } = setup({
      work: [{ text: "闭包是指函数与其词法环境的组合……" }],
      verdicts: [JSON.stringify(PASSED_VERDICT)],
    });
    await collect(task.sendMessage({ text: GOAL_TEXT, profile }));
    await manager.verifyGoal(task.id, { profile });

    // 不断言 prompt 逐字内容：只断言两条规则确实进了实际发出的判定请求（system 消息）
    const rules = textOf(model.doGenerateCalls[0]!.prompt[0]!.content)
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2));
    expect(
      rules.some(
        (rule) => /对话型|咨询型/.test(rule) && /直接判定通过/.test(rule)
      )
    ).toBe(true);
    expect(
      rules.some((rule) => /证据不足/.test(rule) && /(不|未)通过/.test(rule))
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 续跑指令与其他按角色分列的场合：压缩保留、提交消息生成排除              */
/* ------------------------------------------------------------------ */

describe("续跑指令（goal-continuation 角色）在其他按角色分列的场合", () => {
  it("/compact 保留续跑指令：保留轮次里的续跑指令不被压缩删掉，仍以 user 角色回到模型上下文", async () => {
    const { manager, task, model } = setup({
      work: [
        { text: "第一轮回复" },
        { text: "第二轮回复" },
        { text: "第三轮回复" },
        { text: "第四轮回复" },
        { text: "压缩后的回复" },
      ],
      // compact 的摘要生成与完成判定同走 doGenerate：这里第一条是摘要正文
      verdicts: ["（第一轮的摘要）"],
    });
    await collect(task.sendMessage({ text: GOAL_TEXT, profile }));
    await collect(task.sendMessage(continuation("续跑指令甲")));
    await collect(task.sendMessage(continuation("续跑指令乙")));
    await collect(task.sendMessage({ text: "第四轮的普通消息", profile }));

    // 缺省保留最近 3 轮（一轮 = user 角色开头的一段，续跑指令各算一轮）：
    // 第 1 轮被摘要替换，第 2–4 轮原样保留——其中的续跑指令不能丢
    const result = await task.compact({ profile });

    expect(result.compactedMessages).toBe(2);
    expect(
      manager
        .messages(task.id)
        .map((message) => [message.role, message.content])
    ).toEqual([
      ["compact-summary", "（第一轮的摘要）"],
      ["goal-continuation", "续跑指令甲"],
      ["assistant", "第二轮回复"],
      ["goal-continuation", "续跑指令乙"],
      ["assistant", "第三轮回复"],
      ["user", "第四轮的普通消息"],
      ["assistant", "第四轮回复"],
    ]);

    // 压缩后接着对话：保留下来的续跑指令仍在模型上下文里
    await collect(task.sendMessage({ text: "压缩后的消息", profile }));
    const request = model.doStreamCalls.at(-1)!.prompt;
    const texts = request.map((message) => textOf(message.content));
    expect(texts).toContain("续跑指令甲");
    expect(texts).toContain("续跑指令乙");
  });

  it("提交消息生成不把续跑指令当成对话内容：任务记录里只有用户发言与助手回复", () => {
    const prompt = buildCommitMessagePrompt(
      [
        { role: "user", content: "让示例测试全部通过" },
        { role: "goal-continuation", content: "【目标续跑】请继续推进目标" },
        { role: "assistant", content: "示例测试已全部通过。" },
      ],
      ["src/a.ts"]
    );

    expect(prompt).toContain("用户：让示例测试全部通过");
    expect(prompt).toContain("助手：示例测试已全部通过。");
    expect(prompt).not.toContain("目标续跑");
  });
});
