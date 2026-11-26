import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { GOAL_STATUS_NAMES, type GoalStatus } from "../../src/goal/types";
import type { GoalTransition } from "../../src/goal/state-machine";
import type { InteractionRecord } from "../../src/interaction/types";
import type { ProviderProfile } from "../../src/provider/provider-profile";
import {
  createSqliteTaskStore,
  type TaskPersistence,
} from "../../src/task/persistence";
import { createTaskManager } from "../../src/task/manager";

/**
 * 目标模式（ADR 0035「重启与恢复」，GLOSSARY「目标模式」）票 06：应用重启后
 * 「进行中」的目标恢复为「已暂停」，由用户手动恢复——不在用户不知情时自动续跑。
 * 接缝：createTaskManager 的启动收尾（残留态重置处）。同一持久层上重建管理器
 * 即等价应用重启；结果一律经 manager 的目标 API 读回，不直查表。
 *
 * 累计时长（编排者裁决）：停机时长不计入。进程被杀的时刻无从得知，进行中
 * 区段闭合在「该任务落库里最晚的时间戳」上——下面的期望值全部手算。
 */
const BASE = Date.parse("2026-11-25T08:00:00.000Z");
/** 距基准时刻 offsetMs 的 ISO 时间戳 */
const at = (offsetMs: number) => new Date(BASE + offsetMs).toISOString();
/** 停机 5 小时：强杀到下次启动之间隔着的时长（不得计入累计时长） */
const DOWNTIME = 5 * 3_600_000;

/** 手拨时钟：每一步的时刻由用例显式给出 */
function clock(start: string) {
  let current = start;
  return {
    now: () => current,
    set(atTime: string) {
      current = atTime;
    },
  };
}

const tempStores: ReturnType<typeof createSqliteTaskStore>[] = [];
const tempDirs: string[] = [];
afterEach(() => {
  for (const store of tempStores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function memoryStore() {
  const store = createSqliteTaskStore(":memory:");
  tempStores.push(store);
  return store;
}

/** 不应有任何模型请求的装配：工厂被调用即用例失败 */
function noModel() {
  return () => {
    throw new Error("本用例不应有模型请求");
  };
}

const GOAL_TEXT = "让示例测试全部通过";

/** 判定未过的结论（判定模型的应答文本，JSON） */
const UNPASSED = JSON.stringify({
  passed: false,
  reason: "尚有步骤未完成",
  nextAction: "继续实现",
});

const profile: ProviderProfile = {
  id: "profile-1",
  name: "Mock",
  baseURL: "https://example.invalid/v1",
  apiKey: "sk-test",
  models: ["mock"],
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

/** 一轮工作回复的流式应答（ai v7 起流式文本须包裹 text-start / text-end） */
function workStream(text: string): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "text-start", id: "text-1" });
      controller.enqueue({ type: "text-delta", id: "text-1", delta: text });
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

/** 一条工具审批请求的交互记录（status / resolvedAt 由用例按需覆盖） */
function pendingInteraction(
  taskId: string,
  createdAt: string
): InteractionRecord {
  return {
    request: {
      kind: "approval",
      id: "approval",
      taskId,
      turnId: "turn",
      toolCallId: "call",
      source: { kind: "main" },
      toolName: "run_terminal_command",
      command: "npm test",
      commandWord: "npm",
      createdAt,
    },
    status: "pending",
    response: null,
    resolvedAt: null,
    cancelReason: null,
  };
}

describe("重启恢复为暂停态（ADR 0035「重启与恢复」）", () => {
  it("目标进行中时应用重启：恢复为「已暂停」，目标原文、预算与连续计数逐字段不变，不发起任何模型请求", () => {
    const store = memoryStore();
    const time = clock(at(0));
    const manager = createTaskManager({
      persistence: store,
      now: time.now,
      languageModelFor: noModel(),
    });
    const task = manager.create({ workspacePath: "C:/work/demo" });
    time.set(at(10_000));
    manager.setGoal(task.id, GOAL_TEXT);
    const before = manager.goal(task.id)!;
    expect(before.status).toBe("active");

    time.set(at(10_000 + DOWNTIME));
    const restarted = createTaskManager({
      persistence: store,
      now: time.now,
      languageModelFor: noModel(),
    });

    const restored = restarted.goal(task.id);
    expect(restored).not.toBeNull();
    expect(restored!.status).toBe("paused");
    // 不再处于进行中：没有进行中区段在计时
    expect(restored!.activeSince).toBeNull();
    // 除状态、累计时长与更新时间外逐字段不变（累计时长的记账见下方时长用例）
    const { status, activeSince, activeMs, updatedAt, ...restoredRest } =
      restored!;
    const {
      status: _s,
      activeSince: _as,
      activeMs: _am,
      updatedAt: _u,
      ...beforeRest
    } = before;
    expect(restoredRest).toEqual(beforeRest);
    // 状态转换发生在这次启动：记录的更新时间是重启时刻
    expect(updatedAt).toBe(at(10_000 + DOWNTIME));
  });

  it("停机时长不计入累计时长：进行中区段闭合在该任务落库里最晚的时间戳上，不取重启时刻", () => {
    const store = memoryStore();
    const time = clock(at(0));
    const manager = createTaskManager({
      persistence: store,
      now: time.now,
      languageModelFor: noModel(),
    });
    const task = manager.create({ workspacePath: "C:/work/demo" });
    time.set(at(10_000));
    manager.setGoal(task.id, GOAL_TEXT);
    // 停机前落库的记录：目标原文（20 秒处发出）与其后的一条续跑指令（30 秒处）
    store.insertMessage({
      id: "m-goal",
      taskId: task.id,
      role: "user",
      content: GOAL_TEXT,
      createdAt: at(20_000),
    });
    store.insertMessage({
      id: "m-continuation",
      taskId: task.id,
      role: "goal-continuation",
      content: "【目标续跑】继续推进",
      createdAt: at(30_000),
    });

    time.set(at(30_000 + DOWNTIME));
    const restarted = createTaskManager({
      persistence: store,
      now: time.now,
      languageModelFor: noModel(),
    });

    // 进行中 = 设定（10 秒）到最后一条落库记录（30 秒）= 20 秒；
    // 此后到重启之间的 5 小时停机不计入
    expect(restarted.goal(task.id)).toMatchObject({
      status: "paused",
      activeMs: 20_000,
      activeSince: null,
    });
  });

  it("落库里没有晚于进行中起点的时间戳（目标刚恢复就退出）：这一段按 0 计，此前已闭合的时长保留", () => {
    const store = memoryStore();
    const time = clock(at(0));
    const manager = createTaskManager({
      persistence: store,
      now: time.now,
      languageModelFor: noModel(),
    });
    const task = manager.create({ workspacePath: "C:/work/demo" });
    time.set(at(10_000));
    manager.setGoal(task.id, GOAL_TEXT);
    // 第一段进行中：10 秒 → 20 秒，暂停时闭合为 10 秒
    time.set(at(20_000));
    manager.transitionGoal(task.id, "pause");
    // 恢复（30 秒处另起一段）之后任务没有任何落库活动就退出了
    time.set(at(30_000));
    manager.transitionGoal(task.id, "resume");
    expect(manager.goal(task.id)).toMatchObject({
      status: "active",
      activeMs: 10_000,
      activeSince: at(30_000),
    });

    time.set(at(30_000 + DOWNTIME));
    const restarted = createTaskManager({
      persistence: store,
      now: time.now,
      languageModelFor: noModel(),
    });

    // 恢复后的这一段没有任何活动记录：按 0 计，累计仍是第一段的 10 秒
    expect(restarted.goal(task.id)).toMatchObject({
      status: "paused",
      activeMs: 10_000,
      activeSince: null,
    });
  });

  describe("闭合终点取自该任务全部落库记录里最晚的时间戳", () => {
    /**
     * 装配一个被杀现场：目标在 10 秒处设定，write 写入的记录是此后唯一的
     * 落库活动（都在 30 秒处）；5 小时后重启，返回重启后的目标记录。
     */
    function restartAfter(
      write: (context: {
        store: TaskPersistence;
        taskId: string;
        goalId: string;
      }) => void
    ) {
      const store = memoryStore();
      const time = clock(at(0));
      const manager = createTaskManager({
        persistence: store,
        now: time.now,
        languageModelFor: noModel(),
      });
      const task = manager.create({ workspacePath: "C:/work/demo" });
      time.set(at(10_000));
      const goal = manager.setGoal(task.id, GOAL_TEXT);
      write({ store, taskId: task.id, goalId: goal.id });
      time.set(at(30_000 + DOWNTIME));
      const restarted = createTaskManager({
        persistence: store,
        now: time.now,
        languageModelFor: noModel(),
      });
      return restarted.goal(task.id);
    }

    // 期望值相同：进行中 = 设定（10 秒）到该类记录（30 秒）= 20 秒，停机不计
    const cases: [
      string,
      (context: {
        store: TaskPersistence;
        taskId: string;
        goalId: string;
      }) => void,
    ][] = [
      [
        "消息",
        ({ store, taskId }) =>
          store.insertMessage({
            id: "m",
            taskId,
            role: "assistant",
            content: "回复到一半",
            createdAt: at(30_000),
          }),
      ],
      [
        "工具调用（记录以工具开始的时刻为准）",
        ({ store, taskId }) =>
          store.insertToolCall({
            id: "call",
            taskId,
            toolName: "run_terminal_command",
            arguments: "{}",
            output: "",
            isError: false,
            createdAt: at(30_000),
          }),
      ],
      [
        "等待中的审批 / 问答（请求发出的时刻）",
        ({ store, taskId }) =>
          store.insertInteraction(pendingInteraction(taskId, at(30_000))),
      ],
      [
        "已回应的审批 / 问答（回应的时刻）",
        ({ store, taskId }) =>
          store.insertInteraction({
            ...pendingInteraction(taskId, at(20_000)),
            status: "resolved",
            resolvedAt: at(30_000),
          }),
      ],
      [
        "逐轮验证记录（判定结论落库的时刻）",
        ({ store, taskId, goalId }) =>
          store.insertGoalVerification({
            id: "v1",
            taskId,
            goalId,
            round: 1,
            passed: false,
            outcome: "unpassed",
            reason: "尚有步骤未完成",
            nextAction: "继续实现",
            toolActivity: true,
            createdAt: at(30_000),
          }),
      ],
      [
        "子代理委派（启动的时刻）",
        ({ store, taskId }) =>
          store.insertSubagent({
            id: "sub",
            taskId,
            task: "调研笔记",
            status: "running",
            queuedAt: at(20_000),
            startedAt: at(30_000),
            completedAt: null,
          }),
      ],
      [
        "子代理的逐轮消息",
        ({ store, taskId }) =>
          store.insertSubagentMessage({
            id: "sm",
            taskId,
            subagentId: "sub",
            content: "第一轮正文",
            createdAt: at(30_000),
          }),
      ],
      [
        "子代理的工具调用",
        ({ store, taskId }) =>
          store.insertSubagentToolCall({
            id: "sc",
            taskId,
            subagentId: "sub",
            toolName: "read_file",
            arguments: "{}",
            output: "内容",
            isError: false,
            createdAt: at(30_000),
          }),
      ],
    ];
    for (const [source, write] of cases) {
      it(`${source}`, () => {
        expect(restartAfter(write)).toMatchObject({
          status: "paused",
          activeMs: 20_000,
          activeSince: null,
        });
      });
    }
  });

  it("落库时间戳晚于重启时刻（系统时钟回拨后启动）：终点夹到重启时刻，不产生「未来」的时长", () => {
    const store = memoryStore();
    const time = clock(at(0));
    const manager = createTaskManager({
      persistence: store,
      now: time.now,
      languageModelFor: noModel(),
    });
    const task = manager.create({ workspacePath: "C:/work/demo" });
    time.set(at(10_000));
    manager.setGoal(task.id, GOAL_TEXT);
    // 这条记录写于 1 小时处；之后系统时钟被回拨，下次启动时时钟只走到 10 分钟处
    store.insertMessage({
      id: "m",
      taskId: task.id,
      role: "assistant",
      content: "回复",
      createdAt: at(3_600_000),
    });

    time.set(at(600_000));
    const restarted = createTaskManager({
      persistence: store,
      now: time.now,
      languageModelFor: noModel(),
    });

    // 进行中最多记到重启时刻：10 秒 → 10 分钟 = 9 分 50 秒
    expect(restarted.goal(task.id)).toMatchObject({
      status: "paused",
      activeMs: 590_000,
      activeSince: null,
    });
  });

  it("启动收尾自己补记的记录（中断提示等，时间戳是重启时刻）不算作停机前的活动", () => {
    const store = memoryStore();
    const time = clock(at(0));
    const manager = createTaskManager({
      persistence: store,
      now: time.now,
      languageModelFor: noModel(),
    });
    const task = manager.create({ workspacePath: "C:/work/demo" });
    time.set(at(10_000));
    manager.setGoal(task.id, GOAL_TEXT);
    // 强杀现场：续跑轮在途（任务残留 streaming）、一条等待中的审批、
    // 一个运行中的子代理——停机前最后一次有记录的活动是 25 秒处的审批请求
    store.insertMessage({
      id: "m-continuation",
      taskId: task.id,
      role: "goal-continuation",
      content: "【目标续跑】继续推进",
      createdAt: at(20_000),
    });
    store.insertSubagent({
      id: "sub",
      taskId: task.id,
      task: "调研笔记",
      status: "running",
      queuedAt: at(22_000),
      startedAt: at(23_000),
      completedAt: null,
    });
    store.insertInteraction(pendingInteraction(task.id, at(25_000)));
    store.updateTask(task.id, { status: "streaming" });

    time.set(at(25_000 + DOWNTIME));
    const restarted = createTaskManager({
      persistence: store,
      now: time.now,
      languageModelFor: noModel(),
    });

    // 前提：任务侧的启动收尾照常补记了中断提示，它的时间戳是重启时刻
    expect(restarted.messages(task.id).at(-1)).toMatchObject({
      aborted: true,
      createdAt: at(25_000 + DOWNTIME),
    });
    // 进行中 = 设定（10 秒）到 25 秒 = 15 秒，不含停机的 5 小时
    expect(restarted.goal(task.id)).toMatchObject({
      status: "paused",
      activeMs: 15_000,
      activeSince: null,
    });
  });

  describe("终态与已暂停的目标重启后逐字段不变", () => {
    // 推进到各状态所经的转换（规格定案的转换表）
    const routes: [GoalStatus, GoalTransition[]][] = [
      ["paused", ["pause"]],
      ["completed", ["complete"]],
      ["unmet", ["unmet"]],
      ["budget-limited", ["budget-limit"]],
      ["cleared", ["pause", "clear"]],
    ];
    for (const [status, route] of routes) {
      it(`「${GOAL_STATUS_NAMES[status]}」`, () => {
        const store = memoryStore();
        const time = clock(at(0));
        const manager = createTaskManager({
          persistence: store,
          now: time.now,
          languageModelFor: noModel(),
        });
        const task = manager.create({ workspacePath: "C:/work/demo" });
        // 先有任务用量再设定目标：对账基线拍成非默认值（重启必须原样带过去）
        manager.addUsage(task.id, { mainInputTokens: 1_200 });
        time.set(at(10_000));
        manager.setGoal(task.id, GOAL_TEXT);
        expect(manager.goal(task.id)!.baselineTokens).toBe(1_200);
        manager.setGoalBudget(task.id, 500_000);
        // 第一段进行中 30 秒后离开进行中；连续计数经 updateGoal 带上非默认值
        time.set(at(40_000));
        for (const transition of route)
          manager.transitionGoal(task.id, transition);
        store.updateGoal(manager.goal(task.id)!.id, {
          idleStreak: 2,
          failureStreak: 1,
        });
        const before = manager.goal(task.id);
        expect(before!.status).toBe(status);

        time.set(at(40_000 + DOWNTIME));
        const restarted = createTaskManager({
          persistence: store,
          now: time.now,
          languageModelFor: noModel(),
        });

        // 护栏给出的停留态（未达成 / 预算受限）原因要留给用户看：状态与计数都不被改写
        expect(restarted.goal(task.id)).toEqual(before);
      });
    }
  });

  it("逐任务处理：各任务的终点只取自己的落库记录，没有目标的任务不受影响", () => {
    const store = memoryStore();
    const time = clock(at(0));
    const manager = createTaskManager({
      persistence: store,
      now: time.now,
      languageModelFor: noModel(),
    });
    const [first, second, plain] = [
      manager.create({ workspacePath: "C:/work/first" }),
      manager.create({ workspacePath: "C:/work/second" }),
      manager.create({ workspacePath: "C:/work/plain" }),
    ];
    time.set(at(10_000));
    for (const task of [first, second]) manager.setGoal(task.id, GOAL_TEXT);
    const message = (taskId: string, createdAt: string) =>
      store.insertMessage({
        id: `m-${taskId}`,
        taskId,
        role: "assistant",
        content: "回复",
        createdAt,
      });
    message(first.id, at(30_000));
    message(second.id, at(50_000));
    message(plain.id, at(70_000));

    time.set(at(70_000 + DOWNTIME));
    const restarted = createTaskManager({
      persistence: store,
      now: time.now,
      languageModelFor: noModel(),
    });

    expect(restarted.goal(first.id)).toMatchObject({
      status: "paused",
      activeMs: 20_000,
    });
    expect(restarted.goal(second.id)).toMatchObject({
      status: "paused",
      activeMs: 40_000,
    });
    expect(restarted.goal(plain.id)).toBeNull();
  });

  it("真实流程：一轮工作加一次判定后被杀，重开库后目标「已暂停」、验证记录与累计时长保留；恢复后账目延续、连续计数清零", async () => {
    const directory = mkdtempSync(join(tmpdir(), "goal-restart-"));
    tempDirs.push(directory);
    const dbPath = join(directory, "task.db");
    const time = clock(at(0));
    const store = createSqliteTaskStore(dbPath);
    const model = new MockLanguageModelV4({
      doStream: async () => ({ stream: workStream("第一轮回复") }),
      doGenerate: async () => generateResult(UNPASSED),
    });
    const manager = createTaskManager({
      persistence: store,
      now: time.now,
      languageModelFor: () => model,
      modelMaxRetries: () => 0,
    });
    const task = manager.create({ workspacePath: "C:/work/demo" });
    time.set(at(10_000));
    manager.setGoal(task.id, GOAL_TEXT);
    const agent = manager.get(task.id)!;
    for await (const _event of agent.sendMessage({
      text: GOAL_TEXT,
      profile,
    })) {
      // 事件流不是本用例的观察对象
    }
    // 判定在 30 秒处落下结论；续跑轮还没发起，进程就被杀了（目标仍「进行中」）
    time.set(at(30_000));
    const verdict = await manager.verifyGoal(task.id, {
      profile,
      toolActivity: false,
    });
    if (verdict.kind !== "verified")
      throw new Error(`应落验证记录，实际 ${verdict.kind}`);
    expect(manager.goal(task.id)).toMatchObject({ status: "active" });
    store.close();

    time.set(at(30_000 + DOWNTIME));
    const reopened = createSqliteTaskStore(dbPath);
    try {
      const restarted = createTaskManager({
        persistence: reopened,
        now: time.now,
        languageModelFor: noModel(),
      });

      expect(restarted.goal(task.id)).toMatchObject({
        status: "paused",
        // 进行中 = 设定（10 秒）到判定结论落库（30 秒）
        activeMs: 20_000,
        activeSince: null,
        // 连续计数随目标落库：转已暂停不清零
        idleStreak: 1,
      });
      expect(restarted.goalVerifications(task.id)).toEqual([
        verdict.verification,
      ]);

      // 用户恢复：从暂停点续跑，累计时长延续、连续计数清零、另起一段
      time.set(at(30_000 + DOWNTIME + 60_000));
      restarted.transitionGoal(task.id, "resume");
      expect(restarted.goal(task.id)).toMatchObject({
        status: "active",
        activeMs: 20_000,
        activeSince: at(30_000 + DOWNTIME + 60_000),
        idleStreak: 0,
      });
      expect(restarted.goalVerifications(task.id)).toEqual([
        verdict.verification,
      ]);
    } finally {
      reopened.close();
    }
  });
});
