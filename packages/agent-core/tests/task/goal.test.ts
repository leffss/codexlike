import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";

import {
  GOAL_STATUSES,
  GOAL_STATUS_NAMES,
  GOAL_TEXT_MAX_LENGTH,
  type GoalRecord,
  type GoalStatus,
} from "../../src/goal/types";
import {
  advanceGoal,
  GOAL_TRANSITION_NAMES,
  type GoalTransition,
} from "../../src/goal/state-machine";
import {
  GOAL_VERIFICATION_MARKER,
  parseGoalVerdict,
} from "../../src/goal/verifier";
import type { ProviderProfile } from "../../src/provider/provider-profile";
import type { CreateLanguageModelOptions } from "../../src/provider/language-model";
import { createLanguageModelFromProfile } from "../../src/index";
import { createAgentTask, type AgentTask } from "../../src/task/agent-task";
import { createSqliteTaskStore } from "../../src/task/persistence";
import { createTaskManager } from "../../src/task/manager";
import type { TaskEvent } from "../../src/task/types";

/**
 * 目标模式（ADR 0035，GLOSSARY「目标」「目标模式」「完成判定」）票 02：
 * 目标实体与六态状态机、完成判定（请求构造 / 响应解析容错 / fail-open）。
 * 接缝：TaskManager 的目标 API（setGoal / goal / transitionGoal / verifyGoal /
 * goalVerifications）——结果一律经 manager 读回观察，不直查表；
 * 注入模型的请求内容经 MockLanguageModelV4 的调用记录观察。
 */
const profile: ProviderProfile = {
  id: "profile-1",
  name: "GLM",
  baseURL: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "sk-test",
  models: ["glm-4.7"],
};

/** 固定时钟：每次调用递增一秒（时间推进可预期，累计时长断言可手算） */
function fakeClock(startSecond = 0) {
  let tick = startSecond;
  return () => {
    tick += 1;
    return `2026-11-25T08:00:${String(tick).padStart(2, "0")}.000Z`;
  };
}

const tempStores: ReturnType<typeof createSqliteTaskStore>[] = [];

function memoryStore() {
  const store = createSqliteTaskStore(":memory:");
  tempStores.push(store);
  return store;
}

/** 状态机纯函数用例的统一转换时刻 */
const AT = "2026-11-25T09:00:00.000Z";

afterEach(() => {
  for (const store of tempStores.splice(0)) {
    store.close();
  }
});

describe("TaskManager.setGoal（设定目标）", () => {
  it("设定后目标为「进行中」并随任务落库，可经 goal 读回", () => {
    const manager = createTaskManager({
      persistence: memoryStore(),
      now: fakeClock(),
    });
    const task = manager.create({ workspacePath: "C:/work/demo" });
    expect(manager.goal(task.id)).toBeNull();

    const goal = manager.setGoal(task.id, "  让示例测试全部通过  ");

    // 目标原文首尾去空白；同时充当首条指令与完成判定标准
    expect(goal).toMatchObject({
      taskId: task.id,
      text: "让示例测试全部通过",
      status: "active",
      // 累计时长从 0 起算，当前进行中段以设定时刻为起点
      activeMs: 0,
      activeSince: "2026-11-25T08:00:02.000Z",
      createdAt: "2026-11-25T08:00:02.000Z",
    });
    expect(manager.goal(task.id)).toEqual(goal);
  });

  it("无效目标不落库：空目标、超过长度上限、任务不存在均以中文原因拒绝", () => {
    const manager = createTaskManager({
      persistence: memoryStore(),
      now: fakeClock(),
    });
    expect(() => manager.setGoal("missing-task", "让测试通过")).toThrow(
      "任务不存在"
    );

    const task = manager.create({ workspacePath: "C:/work/demo" });
    expect(() => manager.setGoal(task.id, " \n\t ")).toThrow("目标不能为空");
    expect(() =>
      manager.setGoal(task.id, "长".repeat(GOAL_TEXT_MAX_LENGTH + 1))
    ).toThrow("目标文本过长");
    expect(manager.goal(task.id)).toBeNull();
  });

  it("一任务同时至多一个未结束的目标：目标进行中时重复设定被拒绝", () => {
    const manager = createTaskManager({
      persistence: memoryStore(),
      now: fakeClock(),
    });
    const task = manager.create({ workspacePath: "C:/work/demo" });
    const first = manager.setGoal(task.id, "第一个目标");

    expect(() => manager.setGoal(task.id, "第二个目标")).toThrow(
      "任务已有未结束的目标"
    );
    expect(manager.goal(task.id)).toEqual(first);
  });
});

/** 目标记录构造（状态机纯函数用例的最小合法形状） */
function goalOf(
  status: GoalStatus,
  overrides: Partial<GoalRecord> = {}
): GoalRecord {
  return {
    id: "goal-1",
    taskId: "task-1",
    text: "让示例测试全部通过",
    status,
    activeMs: 0,
    activeSince: status === "active" ? "2026-11-25T08:00:00.000Z" : null,
    createdAt: "2026-11-25T08:00:00.000Z",
    updatedAt: "2026-11-25T08:00:00.000Z",
    ...overrides,
  };
}

/** 把任务的目标推进到指定状态（经 manager 的公共转换入口，不手改库） */
function goalIn(
  manager: ReturnType<typeof createTaskManager>,
  taskId: string,
  status: GoalStatus
): GoalRecord {
  manager.setGoal(taskId, "让示例测试全部通过");
  const first: Record<GoalStatus, GoalTransition> = {
    active: "pause",
    paused: "pause",
    completed: "complete",
    unmet: "unmet",
    "budget-limited": "budget-limit",
    cleared: "pause",
  };
  manager.transitionGoal(taskId, first[status]);
  if (status === "cleared") manager.transitionGoal(taskId, "clear");
  return manager.goal(taskId)!;
}

describe("目标六态状态机（ADR 0035）", () => {
  // 期望转换表取自规格：进行中可暂停/完成/未达成/预算受限/清除；
  // 已暂停、预算受限、未达成可恢复或清除；已完成只可清除；已清除为终态。
  const allowed: Record<GoalStatus, GoalTransition[]> = {
    active: ["pause", "complete", "unmet", "budget-limit", "clear"],
    paused: ["resume", "clear"],
    "budget-limited": ["resume", "clear"],
    unmet: ["resume", "clear"],
    completed: ["clear"],
    cleared: [],
  };
  const transitions: GoalTransition[] = [
    "pause",
    "resume",
    "complete",
    "unmet",
    "budget-limit",
    "clear",
  ];

  it("每个状态只允许转换表内的转换，越界转换以中文原因拒绝且原记录不变", () => {
    for (const status of GOAL_STATUSES) {
      for (const transition of transitions) {
        const goal = goalOf(status);
        if (allowed[status].includes(transition)) {
          expect(() => advanceGoal(goal, transition, AT)).not.toThrow();
          continue;
        }
        expect(() => advanceGoal(goal, transition, AT)).toThrow(
          `目标${GOAL_STATUS_NAMES[status]}，不能${GOAL_TRANSITION_NAMES[transition]}`
        );
        expect(goal).toEqual(goalOf(status));
      }
    }
  });

  it("转换落到对应状态：暂停→已暂停、完成→已完成、阻断→未达成、超限→预算受限、恢复→进行中、清除→已清除", () => {
    expect(advanceGoal(goalOf("active"), "pause", AT).status).toBe("paused");
    expect(advanceGoal(goalOf("active"), "complete", AT).status).toBe(
      "completed"
    );
    expect(advanceGoal(goalOf("active"), "unmet", AT).status).toBe("unmet");
    expect(advanceGoal(goalOf("active"), "budget-limit", AT).status).toBe(
      "budget-limited"
    );
    expect(advanceGoal(goalOf("paused"), "resume", AT).status).toBe("active");
    expect(advanceGoal(goalOf("budget-limited"), "resume", AT).status).toBe(
      "active"
    );
    expect(advanceGoal(goalOf("unmet"), "resume", AT).status).toBe("active");
    expect(advanceGoal(goalOf("completed"), "clear", AT).status).toBe(
      "cleared"
    );
  });

  it("累计时长只计进行中的区段：离开进行中闭合当前段，恢复另起一段，其余状态不变", () => {
    // 08:00:00 起进行中，08:00:10 暂停 → 已计 10 秒
    const paused = advanceGoal(
      goalOf("active", { activeSince: "2026-11-25T08:00:00.000Z" }),
      "pause",
      "2026-11-25T08:00:10.000Z"
    );
    expect(paused).toMatchObject({
      status: "paused",
      activeMs: 10_000,
      activeSince: null,
      updatedAt: "2026-11-25T08:00:10.000Z",
    });
    // 暂停期间不计时：08:00:50 恢复，累计仍是 10 秒，新段从 08:00:50 起
    const resumed = advanceGoal(paused, "resume", "2026-11-25T08:00:50.000Z");
    expect(resumed).toMatchObject({
      status: "active",
      activeMs: 10_000,
      activeSince: "2026-11-25T08:00:50.000Z",
    });
    // 08:01:05 完成：再加 15 秒，合计 25 秒
    expect(
      advanceGoal(resumed, "complete", "2026-11-25T08:01:05.000Z")
    ).toMatchObject({
      status: "completed",
      activeMs: 25_000,
      activeSince: null,
    });
  });

  it("累计时长随目标落库：暂停后读回的记录带着已闭合的时长", () => {
    const manager = createTaskManager({
      persistence: memoryStore(),
      now: fakeClock(),
    });
    const task = manager.create({ workspacePath: "C:/work/demo" });
    manager.setGoal(task.id, "让示例测试全部通过");
    // create / setGoal 各取一次时刻，transitionGoal 再取一次：间隔 1 秒
    const paused = manager.transitionGoal(task.id, "pause");
    expect(paused).toMatchObject({ status: "paused", activeMs: 1_000 });
    expect(manager.goal(task.id)).toEqual(paused);
  });
});

describe("TaskManager.transitionGoal（目标状态推进）", () => {
  it("无目标或任务不存在时以中文原因拒绝", () => {
    const manager = createTaskManager({
      persistence: memoryStore(),
      now: fakeClock(),
    });
    const task = manager.create({ workspacePath: "C:/work/demo" });
    expect(() => manager.transitionGoal(task.id, "pause")).toThrow(
      "任务尚未设定目标"
    );
    expect(() => manager.transitionGoal("missing-task", "pause")).toThrow(
      "任务不存在"
    );
  });

  it("未结束的目标（进行中/已暂停/预算受限/未达成）占住名额；已完成或已清除后可再设定新目标", () => {
    const manager = createTaskManager({
      persistence: memoryStore(),
      now: fakeClock(),
    });
    for (const status of [
      "active",
      "paused",
      "budget-limited",
      "unmet",
    ] as const) {
      const task = manager.create({ workspacePath: "C:/work/demo" });
      goalIn(manager, task.id, status);
      expect(() => manager.setGoal(task.id, "新目标")).toThrow(
        "任务已有未结束的目标"
      );
    }
    for (const status of ["completed", "cleared"] as const) {
      const task = manager.create({ workspacePath: "C:/work/demo" });
      goalIn(manager, task.id, status);
      const next = manager.setGoal(task.id, "新目标");
      expect(next).toMatchObject({ taskId: task.id, status: "active" });
      expect(manager.goal(task.id)).toEqual(next);
    }
  });
});

describe("TaskManager.discardGoal（撤销尚未执行的目标）", () => {
  it("撤销当前目标后读回为 null，名额让出、任务可再设定新目标；无目标时幂等", () => {
    const manager = createTaskManager({
      persistence: memoryStore(),
      now: fakeClock(),
    });
    const task = manager.create({ workspacePath: "C:/work/demo" });
    expect(() => manager.discardGoal(task.id)).not.toThrow();

    manager.setGoal(task.id, "启动失败要回滚的目标");
    manager.discardGoal(task.id);

    expect(manager.goal(task.id)).toBeNull();
    expect(manager.setGoal(task.id, "重新设定的目标").status).toBe("active");
  });

  it("已有验证记录（首轮已执行）的目标不可撤销：验证历史随任务留痕，不产生悬空记录", async () => {
    const { manager } = setup(JSON.stringify(PASSED_VERDICT));
    const task = manager.create({ workspacePath: "C:/work/demo" });
    const goal = manager.setGoal(task.id, "让示例测试全部通过");
    await talk(task, "让示例测试全部通过");
    await manager.verifyGoal(task.id, { profile });

    expect(() => manager.discardGoal(task.id)).toThrow(
      "目标已开始执行，不能撤销"
    );
    expect(manager.goal(task.id)).toEqual(goal);
    expect(manager.goalVerifications(task.id)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* 完成判定（GLOSSARY「完成判定」）                                      */
/* ------------------------------------------------------------------ */

const PASSED_VERDICT = {
  passed: true,
  reason: "示例测试已全部通过",
  nextAction: "",
};

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

/** 完成判定的模型应答（非流式 generateText 的返回形状） */
function generateResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: usage(),
    warnings: [],
  };
}

/**
 * 脚本化双通道模型：doStream 服务工作轮（回显轮号），doGenerate 服务完成
 * 判定（返回给定文本，或以给定错误失败）。
 */
function verdictModel(verdictText: string, failWith?: Error) {
  let streamCall = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      streamCall += 1;
      return { stream: textStream([`第${streamCall}轮回复`]) };
    },
    doGenerate: async () => {
      if (failWith !== undefined) throw failWith;
      return generateResult(verdictText);
    },
  });
}

/** 提取 prompt 消息的纯文本：ai v7 传给 provider 层时 string content 会转为 parts 数组。 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((part: { text?: string }) => part.text ?? "").join("");
  return String(content);
}

/** 驱动一轮对话（user → assistant） */
async function talk(task: AgentTask, text: string): Promise<void> {
  for await (const _event of task.sendMessage({ text, profile })) {
    // 事件流本身不是本组用例的观察对象
  }
}

/** 装配：真实任务 + 双通道模型；记录每次 provider 工厂收到的选项（不重试，失败用例不等待退避） */
function setup(verdictText: string, failWith?: Error) {
  const persistence = memoryStore();
  const model = verdictModel(verdictText, failWith);
  const modelRequests: (CreateLanguageModelOptions | undefined)[] = [];
  const manager = createTaskManager({
    persistence,
    languageModelFor: (_selected, options) => {
      modelRequests.push(options);
      return model;
    },
    modelMaxRetries: () => 0,
    now: fakeClock(),
  });
  return { persistence, model, modelRequests, manager };
}

describe("TaskManager.verifyGoal（完成判定）", () => {
  it("判定请求：任务当前模型、不带工具、system 首部带 [goal-verification] 标记，输入含目标文本与完整消息历史", async () => {
    const { persistence, model, modelRequests, manager } = setup(
      JSON.stringify(PASSED_VERDICT)
    );
    const task = manager.create({ workspacePath: "C:/work/demo" });
    manager.setGoal(task.id, "让示例测试全部通过");
    await talk(task, "让示例测试全部通过");
    // 工作轮内的工具调用记录（判定的证据来源）：作为历史夹具写入
    persistence.insertToolCall({
      id: "call-1",
      taskId: task.id,
      toolName: "run_terminal_command",
      arguments: '{"command":"npm test"}',
      output: "120 passing",
      isError: false,
      createdAt: "2026-11-25T08:00:03.000Z",
    });

    const result = await manager.verifyGoal(task.id, { profile });

    // 请求结构：system（首部标记）+ user（目标 + 历史），无工具
    const call = model.doGenerateCalls[0]!;
    expect(call.tools).toBeUndefined();
    expect(call.prompt.map((message) => message.role)).toEqual([
      "system",
      "user",
    ]);
    expect(textOf(call.prompt[0]!.content)).toMatch(/^\[goal-verification\]/);
    const input = textOf(call.prompt[1]!.content);
    expect(input).toContain("让示例测试全部通过");
    expect(input).toContain("第1轮回复");
    expect(input).toContain("run_terminal_command");
    expect(input).toContain("npm test");
    expect(input).toContain("120 passing");
    // 任务当前模型：归一后的具体模型名随请求传入 provider 工厂
    expect(modelRequests.at(-1)?.model).toBe("glm-4.7");

    // 结论落为第 1 轮验证记录，归属当前目标
    expect(result).toMatchObject({
      kind: "verified",
      verification: {
        taskId: task.id,
        goalId: manager.goal(task.id)!.id,
        round: 1,
        passed: true,
        reason: "示例测试已全部通过",
        nextAction: "",
      },
    });
    expect(manager.goalVerifications(task.id)).toHaveLength(1);
  });

  it("任务用量（ADR 0029）：完成判定是任务内模型调用，usage 入主任务列", async () => {
    const { manager } = setup(JSON.stringify(PASSED_VERDICT));
    const task = manager.create({ workspacePath: "C:/work/demo" });
    manager.setGoal(task.id, "让示例测试全部通过");
    await talk(task, "让示例测试全部通过");
    // 工作轮 streamText 一次：(1, 2)
    expect(manager.list()[0]).toMatchObject({
      mainInputTokens: 1,
      mainOutputTokens: 2,
    });

    await manager.verifyGoal(task.id, { profile });

    // 判定 generateText 再入 (1, 2)；子代理列不动
    expect(manager.list()[0]).toMatchObject({
      mainInputTokens: 2,
      mainOutputTokens: 4,
      subagentInputTokens: 0,
      subagentOutputTokens: 0,
    });
  });

  it("目标不在进行中时不发起判定：已暂停的目标返回 skipped，模型未被请求", async () => {
    const { model, manager } = setup(JSON.stringify(PASSED_VERDICT));
    const task = manager.create({ workspacePath: "C:/work/demo" });
    manager.setGoal(task.id, "让示例测试全部通过");
    await talk(task, "让示例测试全部通过");
    manager.transitionGoal(task.id, "pause");

    expect(await manager.verifyGoal(task.id, { profile })).toEqual({
      kind: "skipped",
    });
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(manager.goalVerifications(task.id)).toEqual([]);
  });

  it("fail-open：模型请求失败时不抛错，落一条按未通过的验证记录并注明判定不可用；目标状态留给编排器处置", async () => {
    // 401（不可自动重试类）：SDK 对 5xx 会先自动重试，测试要观察「失败 → fail-open」
    const { manager } = setup(
      "（判定不会返回）",
      new APICallError({
        message: "Unauthorized",
        url: "https://example.com/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 401,
        responseBody: "",
      })
    );
    const task = manager.create({ workspacePath: "C:/work/demo" });
    manager.setGoal(task.id, "让示例测试全部通过");
    await talk(task, "让示例测试全部通过");

    const result = await manager.verifyGoal(task.id, { profile });

    expect(result).toMatchObject({
      kind: "verified",
      verification: { round: 1, passed: false },
    });
    if (result.kind !== "verified") throw new Error("应落验证记录");
    // 理由如实注明判定不可用及原因；下一步方向仍给出（未通过不是终态）
    expect(result.verification.reason).toContain("完成判定不可用");
    expect(result.verification.reason).toContain("HTTP 401");
    expect(result.verification.nextAction).not.toBe("");
    expect(manager.goalVerifications(task.id)).toHaveLength(1);
    // 判定不误报完成，也不把目标卡在判定里：状态原样，交编排器决定续跑或暂停
    expect(manager.goal(task.id)?.status).toBe("active");
  });

  it("fail-open：模型输出不是判定结论（坏输出）同样按未通过落记录，不抛错", async () => {
    const { manager } = setup("我觉得已经做完了，不用再改了。");
    const task = manager.create({ workspacePath: "C:/work/demo" });
    manager.setGoal(task.id, "让示例测试全部通过");
    await talk(task, "让示例测试全部通过");

    const result = await manager.verifyGoal(task.id, { profile });

    expect(result).toMatchObject({
      kind: "verified",
      verification: { round: 1, passed: false },
    });
    if (result.kind !== "verified") throw new Error("应落验证记录");
    expect(result.verification.reason).toContain("完成判定不可用");
  });

  it("任务当前模型不可用（宿主解析不到 Provider Profile）：不发请求，按 fail-open 落未通过记录", async () => {
    const { model, manager } = setup("（不会有请求）");
    const task = manager.create({ workspacePath: "C:/work/demo" });
    manager.setGoal(task.id, "让示例测试全部通过");
    await talk(task, "让示例测试全部通过");

    const result = await manager.verifyGoal(task.id, {});

    expect(model.doGenerateCalls).toHaveLength(0);
    expect(result).toMatchObject({
      kind: "verified",
      verification: { round: 1, passed: false },
    });
    if (result.kind !== "verified") throw new Error("应落验证记录");
    expect(result.verification.reason).toContain("完成判定不可用");
    expect(result.verification.reason).toContain("Provider Profile");
    expect(manager.goal(task.id)?.status).toBe("active");
  });

  it("判定在途被中断（Stop / 应用退出）：不产生结论、不落验证记录", async () => {
    const persistence = memoryStore();
    let markStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let streamCall = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        streamCall += 1;
        return { stream: textStream([`第${streamCall}轮回复`]) };
      },
      doGenerate: async (options) => {
        // 判定请求挂起，直到 signal 中断（模拟用户在验证期间点停止）
        markStarted();
        await new Promise<void>((_resolve, reject) => {
          options.abortSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          );
        });
        return generateResult("（不应到达）");
      },
    });
    const manager = createTaskManager({
      persistence,
      languageModelFor: () => model,
      modelMaxRetries: () => 0,
      now: fakeClock(),
    });
    const task = manager.create({ workspacePath: "C:/work/demo" });
    manager.setGoal(task.id, "让示例测试全部通过");
    await talk(task, "让示例测试全部通过");

    const controller = new AbortController();
    const pending = manager.verifyGoal(task.id, {
      profile,
      signal: controller.signal,
    });
    await requestStarted;
    controller.abort();

    expect(await pending).toEqual({ kind: "aborted" });
    expect(manager.goalVerifications(task.id)).toEqual([]);
    expect(manager.goal(task.id)?.status).toBe("active");
  });

  it("中断先于请求：signal 已中断时不发请求，直接返回 aborted", async () => {
    const { model, manager } = setup(JSON.stringify(PASSED_VERDICT));
    const task = manager.create({ workspacePath: "C:/work/demo" });
    manager.setGoal(task.id, "让示例测试全部通过");
    const controller = new AbortController();
    controller.abort();

    expect(
      await manager.verifyGoal(task.id, { profile, signal: controller.signal })
    ).toEqual({ kind: "aborted" });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("目标与逐轮验证记录随任务落库：同一持久层重建管理器（等价应用重启）后原样可读", async () => {
    const { persistence, manager } = setup(JSON.stringify(PASSED_VERDICT));
    const task = manager.create({ workspacePath: "C:/work/demo" });
    manager.setGoal(task.id, "让示例测试全部通过");
    await talk(task, "让示例测试全部通过");
    const result = await manager.verifyGoal(task.id, { profile });
    if (result.kind !== "verified") throw new Error("应落验证记录");
    const completed = manager.transitionGoal(task.id, "complete");

    const restarted = createTaskManager({
      persistence,
      languageModelFor: () => {
        throw new Error("重启后不应有模型请求");
      },
      now: fakeClock(50),
    });

    expect(restarted.goal(task.id)).toEqual(completed);
    expect(restarted.goalVerifications(task.id)).toEqual([result.verification]);
  });

  it("验证记录并入任务时间线：按判定时刻排在当轮回复之后，是消息流标记行的恢复数据源", async () => {
    const { persistence, manager } = setup(JSON.stringify(PASSED_VERDICT));
    const task = manager.create({ workspacePath: "C:/work/demo" });
    manager.setGoal(task.id, "让示例测试全部通过");
    await talk(task, "让示例测试全部通过");
    const before = manager.transcript(task.id);
    expect(before.map((item) => item.kind)).toEqual(["message", "message"]);

    const result = await manager.verifyGoal(task.id, { profile });
    if (result.kind !== "verified") throw new Error("应落验证记录");
    const { verification } = result;

    const transcript = manager.transcript(task.id);
    expect(transcript.map((item) => item.kind)).toEqual([
      "message",
      "message",
      "goal-verification",
    ]);
    expect(transcript.at(-1)).toEqual({
      kind: "goal-verification",
      verification,
    });
    // 重启后仍可回看（时间线读持久层，不依赖内存事件）
    const restarted = createTaskManager({ persistence, now: fakeClock(50) });
    expect(restarted.transcript(task.id).at(-1)).toEqual({
      kind: "goal-verification",
      verification,
    });
  });

  it("对接 e2e stub 识别契约（票 01）：真实 provider 工厂发出的判定请求不带 tools，system 首部带 [goal-verification]", async () => {
    let body: Record<string, unknown> = {};
    const manager = createTaskManager({
      persistence: memoryStore(),
      languageModelFor: (selected) =>
        createLanguageModelFromProfile(selected, {
          fetch: async (_input, init) => {
            body = JSON.parse(String(init?.body));
            return new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: JSON.stringify(PASSED_VERDICT),
                    },
                    finish_reason: "stop",
                  },
                ],
              }),
              { headers: { "content-type": "application/json" } }
            );
          },
        }),
      now: fakeClock(),
    });
    const task = manager.create({ workspacePath: "C:/work/demo" });
    manager.setGoal(task.id, "让示例测试全部通过");
    await talk(task, "让示例测试全部通过");

    await manager.verifyGoal(task.id, { profile });

    // stub 默认识别的两个条件（goal-stub.mjs isGoalVerificationRequest）：
    // ① 请求体不含非空 tools 数组；② 含判定标记。分线成立判定请求才走判定脚本线。
    expect(body).not.toHaveProperty("tools");
    expect(JSON.stringify(body)).not.toMatch(/"tools"\s*:\s*\[\s*[^\s\]]/);
    expect(JSON.stringify(body)).toContain(GOAL_VERIFICATION_MARKER);
    const messages = body.messages as { role: string; content: unknown }[];
    expect(messages[0]?.role).toBe("system");
    expect(textOf(messages[0]?.content)).toMatch(/^\[goal-verification\]/);
  });
});

describe("parseGoalVerdict（判定输出解析容错）", () => {
  const verdict = {
    passed: false,
    reason: "尚有步骤未完成",
    nextAction: "继续实现剩余步骤",
  };

  it("裸 JSON、代码围栏包裹、字符串字面量包裹三种形态解析出同一结论", () => {
    expect(parseGoalVerdict(JSON.stringify(verdict))).toEqual(verdict);
    expect(
      parseGoalVerdict(`\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``)
    ).toEqual(verdict);
    expect(parseGoalVerdict(JSON.stringify(JSON.stringify(verdict)))).toEqual(
      verdict
    );
  });

  it("结论前后夹带说明文字时仍能取出其中的 JSON 对象", () => {
    expect(
      parseGoalVerdict(`判定如下：\n${JSON.stringify(verdict)}\n以上。`)
    ).toEqual(verdict);
  });

  it("理由与下一步方向缺失时补空串，不因缺字段丢弃有效结论", () => {
    expect(parseGoalVerdict('{"passed":true}')).toEqual({
      passed: true,
      reason: "",
      nextAction: "",
    });
  });

  it("坏输出不给结论：非 JSON、缺 passed、passed 不是布尔、顶层是数组、空输出", () => {
    for (const text of [
      "我觉得已经做完了",
      '{"reason":"x","nextAction":"y"}',
      '{"passed":"yes","reason":"x","nextAction":"y"}',
      "[1,2]",
      "",
    ]) {
      expect(parseGoalVerdict(text)).toBeNull();
    }
  });
});
