import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@codexlike/agent-core/node";
import {
  CONTINUATION_ANCHOR,
  FAILED,
  PASSED,
  ipcInvoke as invoke,
  setupGoalApp,
  type GoalApp,
  type PendingRound,
} from "./goal-harness";

/**
 * 目标模式（ADR 0035）票 03 的宿主侧：续跑循环——判定未过自动续跑、判定自身
 * 故障的处置（fail-open 定案）、逐轮记账、中断语义、轮间窗口的输入队列互锁、
 * 判定在途与轮间窗口的运行口径。装配见 goal-harness.ts。
 */
const waitFor = (check: () => unknown) => vi.waitFor(check, { timeout: 8000 });
const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

const GOAL = "让示例测试全部通过";

/** 续跑轮请求：最后一条 user 消息是续跑指令 */
const isContinuation = (lastUserText: string) =>
  lastUserText.includes(CONTINUATION_ANCHOR);
const holdContinuation = (app: GoalApp) => app.holdWhere(isContinuation);

/** 设定目标并等到首轮回合的请求到达 */
async function startGoal(app: GoalApp, taskId: string): Promise<PendingRound> {
  await invoke("goal-set", taskId, GOAL, { providerProfileId: app.profile.id });
  return app.hold(GOAL);
}

/** 一个写入类工具（任务建为 ask 档：调用需审批）与一个只读工具 */
function tools(executed: string[]): ToolDefinition[] {
  return [
    {
      name: "note",
      description: "记一条笔记（写入类）",
      permission: "write",
      parameters: { type: "object" },
      async execute(args) {
        executed.push(String((args as { text?: string }).text));
        return { output: "已记录", isError: false };
      },
    },
  ];
}

describe("续跑循环：判定未过自动续跑", () => {
  it("判定未过 → 自动发起下一轮：nextAction 进入续跑指令；续跑轮不产生用户气泡", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-continue");
    const round = await startGoal(app, task.id);
    round.write("做了一部分。");
    round.finish();
    (await app.nextVerdict()).respond(FAILED);

    // 无需用户操作，下一轮工作请求自动到达；模型看到的是续跑指令（含下一步方向与判定理由）
    const continuation = await holdContinuation(app);
    expect(continuation.lastUserText).toContain("继续实现剩余步骤");
    expect(continuation.lastUserText).toContain("尚有步骤未完成");
    expect(continuation.lastUserText).toContain(GOAL);
    // 续跑轮照常带工具（工作轮，不是判定请求）
    expect(Array.isArray(continuation.body.tools)).toBe(true);
    // 不产生用户气泡：用户消息只有建任务与目标原文；续跑指令以独立角色落库
    expect(app.userTexts(task.id)).toEqual([`建立任务-goal-continue`, GOAL]);
    expect(app.messageRoles(task.id)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "goal-continuation",
    ]);
    // 循环进行中：目标仍进行中，任务没有回到空闲
    expect(app.goalOf(task.id)?.status).toBe("active");
    expect(invoke("execution", task.id).running).toBe(true);

    // 续跑轮结束 → 再次判定 → 通过 → 已完成
    continuation.write("剩余步骤已完成。");
    continuation.finish();
    (await app.nextVerdict()).respond(PASSED);
    await app.idle(task.id);

    expect(app.goalOf(task.id)?.status).toBe("completed");
    expect(
      app
        .verificationsOf(task.id)
        .map((record) => [record.round, record.outcome])
    ).toEqual([
      [1, "unpassed"],
      [2, "passed"],
    ]);
    // 第二次判定的输入里有续跑轮的工作（历史完整）
    expect(app.requestCount()).toBe(5);
  }, 15_000);

  it("多轮（≥2 轮未过）后判定通过 → 已完成；每轮验证记录留痕，标记行数据可逐轮回看", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-rounds");
    const round = await startGoal(app, task.id);
    round.write("第一轮回复");
    round.finish();

    // 第 1、2 轮未过 → 各自动续跑一轮
    (await app.nextVerdict()).respond(FAILED);
    const second = await holdContinuation(app);
    second.write("第二轮回复");
    second.finish();
    (await app.nextVerdict()).respond({
      passed: false,
      reason: "还差收尾",
      nextAction: "补上收尾检查",
    });
    const third = await holdContinuation(app);
    expect(third.lastUserText).toContain("补上收尾检查");
    third.write("第三轮回复");
    third.finish();
    // 第 3 次判定通过
    (await app.nextVerdict()).respond(PASSED);
    await app.idle(task.id);

    expect(app.goalOf(task.id)).toMatchObject({
      status: "completed",
      idleStreak: 0,
      failureStreak: 0,
    });
    // 全部验证记录留痕：三轮各有结论与下一步方向
    expect(
      app
        .verificationsOf(task.id)
        .map((record) => [record.round, record.outcome, record.nextAction])
    ).toEqual([
      [1, "unpassed", "继续实现剩余步骤"],
      [2, "unpassed", "补上收尾检查"],
      [3, "passed", ""],
    ]);
    // 事件序：每轮「验证中 → 结论」成对出现，最后以状态（已完成）收束
    expect(
      app.goalEvents(task.id).map((envelope) => envelope.event.type)
    ).toEqual([
      "goal-changed",
      "goal-verifying",
      "goal-verification",
      "goal-verifying",
      "goal-verification",
      "goal-verifying",
      "goal-verification",
      "goal-changed",
    ]);
    // 用户只说过一次话：两轮续跑都没有新增用户消息
    expect(app.userTexts(task.id)).toEqual([`建立任务-goal-rounds`, GOAL]);
    expect(
      app.messageRoles(task.id).filter((role) => role === "goal-continuation")
    ).toHaveLength(2);
  }, 15_000);

  it("轮内工具照常：续跑轮里可更新工作计划、调用需审批的工具；审批处理完毕回到循环，续跑轮结束后照常判定", async () => {
    const executed: string[] = [];
    const app = await setupGoalApp({ tools: tools(executed) });
    const task = await app.newTask("goal-tools");
    const round = await startGoal(app, task.id);
    round.write("首轮只做了分析");
    round.finish();
    (await app.nextVerdict()).respond(FAILED);

    const continuation = await holdContinuation(app);
    // 续跑轮里先更新工作计划（只读，直接执行），再调用写入类工具（ask 档 → 等待审批）
    continuation.toolCall("update_plan", {
      steps: [
        { content: "补齐实现", status: "completed" },
        { content: "记下结论", status: "in_progress" },
      ],
    });
    await holdContinuation(app).then((next) =>
      next.toolCall("note", { text: "续跑轮里的笔记" })
    );

    // 审批等待：回合挂起，任务呈现为等待用户
    await waitFor(() =>
      expect(invoke("pendingApprovals", task.id).length).toBe(1)
    );
    expect(executed).toEqual([]);
    expect(app.activityOf(task.id)).toMatchObject({
      running: true,
      waitingForUser: true,
    });
    // 等待期间目标仍在进行中（没有因为等待而离开循环）
    expect(app.goalOf(task.id)?.status).toBe("active");
    const [approval] = invoke("pendingApprovals", task.id);
    invoke("respondApproval", task.id, approval.id, "approve");

    // 审批后工具执行、回合继续 → 正常收尾
    const resumed = await holdContinuation(app);
    expect(executed).toEqual(["续跑轮里的笔记"]);
    resumed.write("续跑轮收尾");
    resumed.finish();
    (await app.nextVerdict()).respond(PASSED);
    await app.idle(task.id);

    expect(app.goalOf(task.id)?.status).toBe("completed");
    // 本轮有实质工具活动：验证记录如实记账
    expect(app.verificationsOf(task.id)[1]).toMatchObject({
      round: 2,
      outcome: "passed",
      toolActivity: true,
    });
    // 计划更新随任务落库（工作计划与目标两层并存）
    expect(
      invoke("messages", task.id).filter(
        (item: any) =>
          item.kind === "tool-call" && item.call.toolName === "update_plan"
      )
    ).toHaveLength(1);
  }, 15_000);

  it("空转计数逐轮落库：未过且无实质工具活动逐轮 +1；只改计划不算活动；有实质工具活动清零", async () => {
    const executed: string[] = [];
    const app = await setupGoalApp({ tools: tools(executed) });
    const task = await app.newTask("goal-idle");
    const round = await startGoal(app, task.id);
    const fail = async (current: PendingRound) => {
      current.finish();
      (await app.nextVerdict()).respond(FAILED);
      return holdContinuation(app);
    };

    // 第 1、2 轮：只回文字，判定未过 → 空转计数 1、2
    round.write("空谈");
    let current = await fail(round);
    expect(app.goalOf(task.id)?.idleStreak).toBe(1);
    current.write("还是空谈");
    current = await fail(current);
    expect(app.goalOf(task.id)?.idleStreak).toBe(2);

    // 第 3 轮：调用写入类工具（审批后实际执行）→ 有实质工具活动，空转计数清零
    current.toolCall("note", { text: "真正的改动" });
    await waitFor(() =>
      expect(invoke("pendingApprovals", task.id).length).toBe(1)
    );
    invoke(
      "respondApproval",
      task.id,
      invoke("pendingApprovals", task.id)[0].id,
      "approve"
    );
    current = await fail(await holdContinuation(app));
    expect(app.goalOf(task.id)?.idleStreak).toBe(0);
    expect(app.verificationsOf(task.id)[2]).toMatchObject({
      round: 3,
      outcome: "unpassed",
      toolActivity: true,
    });
    expect(executed).toEqual(["真正的改动"]);

    // 第 4 轮：只更新工作计划（不算实质工具活动）→ 空转计数重新从 1 起算
    // （计数到 3 的阻断在票 05，见 goal-guardrails-ipc.test.ts）
    current.toolCall("update_plan", {
      steps: [{ content: "看起来在干活", status: "in_progress" }],
    });
    current = await fail(await holdContinuation(app));
    expect(app.goalOf(task.id)?.idleStreak).toBe(1);
    expect(
      app
        .verificationsOf(task.id)
        .map((record) => [record.round, record.outcome, record.toolActivity])
    ).toEqual([
      [1, "unpassed", false],
      [2, "unpassed", false],
      [3, "unpassed", true],
      [4, "unpassed", false],
    ]);

    current.write("继续推进");
    current.finish();
    (await app.nextVerdict()).respond(PASSED);
    await app.idle(task.id);
    expect(app.goalOf(task.id)).toMatchObject({
      status: "completed",
      idleStreak: 0,
    });
  }, 20_000);
});

describe("判定自身故障（fail-open 定案）", () => {
  it("判定不可用的轮次目标照常续跑（不暂停）：续跑指令如实告知上一轮判定不可用；故障轮不计入空转计数", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-unavailable");
    const round = await startGoal(app, task.id);
    round.write("做了一部分");
    round.finish();
    // 第 1 次判定：请求失败
    (await app.nextVerdict()).fail();

    const continuation = await holdContinuation(app);
    // 目标没有暂停，循环继续
    expect(app.goalOf(task.id)?.status).toBe("active");
    expect(invoke("execution", task.id).running).toBe(true);
    // 续跑指令如实告知：上一轮判定不可用、没有结论，请继续推进——不冒充判定结论
    expect(continuation.lastUserText).toContain("完成判定不可用");
    expect(continuation.lastUserText).toContain("继续");
    expect(continuation.lastUserText).not.toContain("【下一步方向】");
    // 验证记录如实记为「判定不可用」：不是通过，也不是正常的未过
    expect(app.verificationsOf(task.id)[0]).toMatchObject({
      round: 1,
      passed: false,
      outcome: "unavailable",
      reason: expect.stringContaining("完成判定不可用"),
    });
    // 故障轮不计入空转计数，连续故障计数记 1
    expect(app.goalOf(task.id)).toMatchObject({
      idleStreak: 0,
      failureStreak: 1,
    });

    continuation.write("接着做");
    continuation.finish();
    (await app.nextVerdict()).respond(PASSED);
    await app.idle(task.id);
    expect(app.goalOf(task.id)?.status).toBe("completed");
  }, 15_000);

  it("连续 3 轮判定不可用 → 已暂停：原因可见、不再续跑；故障轮任何情况下不记为通过", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-unavailable-x3");
    const round = await startGoal(app, task.id);
    round.write("第一轮");
    round.finish();

    // 第 1、2 轮判定不可用（请求失败 / 坏输出）：各续跑一轮
    (await app.nextVerdict()).fail();
    const second = await holdContinuation(app);
    expect(app.goalOf(task.id)?.failureStreak).toBe(1);
    expect(app.goalOf(task.id)?.status).toBe("active");
    second.write("第二轮");
    second.finish();
    (await app.nextVerdict()).garbage();
    const third = await holdContinuation(app);
    expect(app.goalOf(task.id)?.failureStreak).toBe(2);
    expect(app.goalOf(task.id)?.status).toBe("active");

    // 第 3 轮判定仍不可用 → 目标转已暂停，不再续跑
    third.write("第三轮");
    third.finish();
    (await app.nextVerdict()).fail();
    await app.idle(task.id);

    const goal = app.goalOf(task.id);
    expect(goal).toMatchObject({ status: "paused", failureStreak: 3 });
    // 三轮都不是通过；目标没有被误判为已完成
    expect(
      app.verificationsOf(task.id).map((record) => record.outcome)
    ).toEqual(["unavailable", "unavailable", "unavailable"]);
    // 原因对用户可见：最后一次判定结论（标记行）之后紧跟已暂停的状态
    const events = app.goalEvents(task.id);
    expect(events.at(-2)?.event).toMatchObject({
      type: "goal-verification",
      verification: { round: 3, outcome: "unavailable" },
    });
    expect(events.at(-1)?.event).toMatchObject({
      type: "goal-changed",
      goal: { status: "paused", failureStreak: 3 },
    });
    // 暂停后不重复续跑：没有新的模型请求
    const requests = app.requestCount();
    await settle();
    expect(app.requestCount()).toBe(requests);
    expect(invoke("execution", task.id).running).toBe(false);
  }, 15_000);

  it("出现一次正常结论（未过）后连续故障计数清零，再故障从 1 重新起算", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-failure-reset");
    const round = await startGoal(app, task.id);
    round.write("第一轮");
    round.finish();

    (await app.nextVerdict()).fail();
    let current = await holdContinuation(app);
    expect(app.goalOf(task.id)?.failureStreak).toBe(1);
    current.write("第二轮");
    current.finish();
    (await app.nextVerdict()).fail();
    current = await holdContinuation(app);
    expect(app.goalOf(task.id)?.failureStreak).toBe(2);

    // 正常的未过结论：连续故障计数清零
    current.write("第三轮");
    current.finish();
    (await app.nextVerdict()).respond(FAILED);
    current = await holdContinuation(app);
    expect(app.goalOf(task.id)).toMatchObject({
      status: "active",
      failureStreak: 0,
      idleStreak: 1,
    });

    // 再次故障：从 1 起算，目标照常续跑（不会被前两轮的故障累计成暂停）
    current.write("第四轮");
    current.finish();
    (await app.nextVerdict()).fail();
    current = await holdContinuation(app);
    expect(app.goalOf(task.id)).toMatchObject({
      status: "active",
      failureStreak: 1,
      idleStreak: 1,
    });
    current.write("第五轮");
    current.finish();
    (await app.nextVerdict()).respond(PASSED);
    await app.idle(task.id);
  }, 15_000);
});

describe("中断语义", () => {
  it("续跑轮进行中 Stop → 已暂停：中断后不重复续跑", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-stop-continuation");
    const round = await startGoal(app, task.id);
    round.write("首轮回复");
    round.finish();
    (await app.nextVerdict()).respond(FAILED);
    const continuation = await holdContinuation(app);
    continuation.write("续跑轮写到一半");

    expect(invoke("interrupt", task.id)).toBe(true);
    await app.idle(task.id);

    expect(app.goalOf(task.id)?.status).toBe("paused");
    // 中断的续跑轮不判定：验证记录只有第 1 轮那一条
    expect(app.verificationsOf(task.id)).toHaveLength(1);
    expect(app.pendingVerdicts()).toBe(0);
    const requests = app.requestCount();
    await settle();
    expect(app.requestCount()).toBe(requests);
    expect(invoke("execution", task.id).running).toBe(false);
    expect(app.messageRoles(task.id)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "goal-continuation",
      "assistant",
    ]);
  }, 15_000);

  it("判定在途被中断 → 不续跑、不留结论，目标转已暂停", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-stop-verifying");
    const round = await startGoal(app, task.id);
    round.write("首轮回复");
    round.finish();
    // 判定请求已到达、尚未应答时点停止
    await app.nextVerdict();
    expect(invoke("interrupt", task.id)).toBe(true);
    await app.idle(task.id);

    expect(app.goalOf(task.id)?.status).toBe("paused");
    expect(app.verificationsOf(task.id)).toEqual([]);
    expect(app.hasRequestWhere(isContinuation)).toBe(false);
    // 界面侧的收束信号：最后一条目标事件是已暂停（「验证中」占位随之撤下）
    expect(app.goalEvents(task.id).at(-1)?.event).toMatchObject({
      type: "goal-changed",
      goal: { status: "paused" },
    });
    const requests = app.requestCount();
    await settle();
    expect(app.requestCount()).toBe(requests);
  }, 15_000);

  it("轮间窗口（上一轮已收尾、续跑轮尚未发起）点停止 → 已暂停：待发起的续跑轮不再发起", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-stop-between");
    const round = await startGoal(app, task.id);
    round.write("首轮回复");
    round.finish();
    const verdict = await app.nextVerdict();
    const gate = app.armProfileGate();
    verdict.respond(FAILED);
    // 续跑轮发起卡在轮间窗口：此刻没有在途回合可中断
    await gate.reached;
    expect(invoke("execution", task.id)).toMatchObject({
      running: true,
      executionId: null,
    });

    expect(invoke("interrupt", task.id)).toBe(true);
    expect(app.goalOf(task.id)?.status).toBe("paused");
    // 放行后给「本不该发生」的续跑轮留出发起时间，再断言它确实没有发起
    const requestsAtStop = app.requestCount();
    gate.release();
    await settle(400);
    await app.idle(task.id);

    expect(app.hasRequestWhere(isContinuation)).toBe(false);
    expect(app.requestCount()).toBe(requestsAtStop);
    expect(app.goalOf(task.id)?.status).toBe("paused");
  }, 15_000);

  it("轮间窗口点停止时有排队消息：目标转已暂停后排队消息自动发出（唤醒在暂停之后），同时并发名额让出", async () => {
    const app = await setupGoalApp({ concurrencyLimit: () => 1 });
    const task = await app.newTask("goal-stop-between-queue");
    const round = await startGoal(app, task.id);
    await invoke("send", task.id, "补充一句", app.profile.id);
    // 唯一的并发席被目标任务占着：另一个任务的首条发送进入任务排队
    await invoke("start", {
      requestId: "goal-stop-between-other",
      projectId: null,
      text: "排队等待的任务",
    });
    round.write("首轮回复");
    round.finish();
    const verdict = await app.nextVerdict();
    const gate = app.armProfileGate();
    verdict.respond(FAILED);
    await gate.reached;

    expect(invoke("interrupt", task.id)).toBe(true);
    expect(app.goalOf(task.id)?.status).toBe("paused");
    gate.release();

    // 循环结束让出并发名额、输入队列解除互锁：排队消息自动发出（无需手动恢复
    // 队列），任务排队里的任务也开跑。两条首条执行共用唯一的并发席，先后不定，
    // 但都必须各自跑完
    const outstanding = new Set(["补充一句", "排队等待的任务"]);
    while (outstanding.size > 0) {
      const current = await app.holdWhere((text) => outstanding.has(text));
      outstanding.delete(current.lastUserText);
      current.write(`${current.lastUserText}的处理结果`);
      current.finish();
      await settle(300);
    }
    await waitFor(() =>
      expect(
        invoke("list").every((item: any) => item.activity?.running !== true)
      ).toBe(true)
    );

    // 排队消息是普通回合：目标保持已暂停，不发判定、不续跑；待发起的续跑轮作废
    expect(app.goalOf(task.id)?.status).toBe("paused");
    expect(app.pendingVerdicts()).toBe(0);
    expect(app.hasRequestWhere(isContinuation)).toBe(false);
    expect(app.userTexts(task.id)).toEqual([
      "建立任务-goal-stop-between-queue",
      GOAL,
      "补充一句",
    ]);
    expect(invoke("view", task.id).queueState).toMatchObject({
      paused: false,
      queue: [],
    });
    const other = app.manager
      .list()
      .find((item) => item.title === "排队等待的任务");
    expect(app.userTexts(other!.id)).toEqual(["排队等待的任务"]);
    // 没有任何多余的模型请求（建任务、首轮、判定、排队消息、排队任务各一次）
    expect(app.requestCount()).toBe(5);
  }, 15_000);

  it("续跑轮出错（模型请求失败）：不判定，目标转已暂停", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-continuation-error");
    const round = await startGoal(app, task.id);
    round.write("首轮回复");
    round.finish();
    (await app.nextVerdict()).respond(FAILED);
    (await holdContinuation(app)).fail();
    await app.idle(task.id);

    expect(app.goalOf(task.id)?.status).toBe("paused");
    expect(app.verificationsOf(task.id)).toHaveLength(1);
    expect(app.pendingVerdicts()).toBe(0);
  }, 15_000);

  it("续跑轮发起失败（任务所用模型在轮间被删除）：目标转已暂停，不留「进行中却没有回合」", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-continue-start-fail");
    const round = await startGoal(app, task.id);
    round.write("首轮回复");
    round.finish();
    const verdict = await app.nextVerdict();
    const gate = app.armProfileGate();
    verdict.respond(FAILED);
    // 续跑轮发起卡在解析发送参数之前：此刻删除任务所用模型
    await gate.reached;
    await app.removeProfile();
    gate.release();
    await app.idle(task.id);
    await settle();

    // 目标已暂停（不是停在「进行中却没有回合」）；暂停不是因为连续故障
    //（上一轮是正常的未过结论，连续故障计数为 0）
    expect(app.goalOf(task.id)).toMatchObject({
      status: "paused",
      failureStreak: 0,
    });
    expect(invoke("execution", task.id).running).toBe(false);
    // 没有发出任何续跑轮请求，续跑指令也没有落库
    expect(app.hasRequestWhere(isContinuation)).toBe(false);
    expect(app.messageRoles(task.id)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    // 已离开进行中：任务回到普通形态，输入队列恢复（不再互锁）。暂停原因对用户
    // 可见：随已暂停的状态快照下发（票 04 追加 C——不再只进主进程日志）
    expect(app.goalEvents(task.id).at(-1)?.event).toMatchObject({
      type: "goal-changed",
      goal: { status: "paused" },
      pauseReason: expect.stringContaining("Provider Profile 不存在"),
    });
  }, 15_000);
});

describe("输入队列互锁：轮间窗口（显式守卫）", () => {
  it("目标进行中且任务空闲（轮间窗口，没有在途执行登记）：队首不被取走；目标离开进行中后才发出", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-queue-window");
    const round = await startGoal(app, task.id);
    await invoke("send", task.id, "补充甲", app.profile.id);
    round.write("首轮回复");
    round.finish();
    const verdict = await app.nextVerdict();
    const gate = app.armProfileGate();
    verdict.respond(FAILED);
    await gate.reached;

    // 真实到达「目标进行中 × 任务空闲」：没有执行登记（executionId 为 null）、任务状态
    // 空闲、上一轮已收尾；任务仍呈现为执行中只因目标循环在进行
    expect(invoke("execution", task.id)).toMatchObject({
      running: true,
      executionId: null,
      waitingForUser: false,
    });
    expect(app.manager.get(task.id)?.record.status).toBe("idle");
    expect(app.goalOf(task.id)?.status).toBe("active");
    // 上一轮收尾时的队列唤醒没有取走队首：没有「正在发出」的条目（被闸口卡住的
    // 是续跑轮的发起，不是某条排队消息的发送）
    expect(invoke("view", task.id).queueState).toMatchObject({
      sendingId: null,
    });
    // 轮间窗口提交的消息同样入队（不直发）；入队触发的队列泵同样不取队首
    await invoke("send", task.id, "补充乙", app.profile.id);
    await settle();
    expect(app.hasRequest("补充甲")).toBe(false);
    expect(app.hasRequest("补充乙")).toBe(false);
    expect(invoke("view", task.id).queueState).toMatchObject({
      sendingId: null,
    });
    expect(app.queueTexts(task.id)).toEqual(["补充甲", "补充乙"]);
    expect(app.userTexts(task.id)).toEqual([
      `建立任务-goal-queue-window`,
      GOAL,
    ]);

    // 放行：续跑轮发起，循环继续；队列照旧互锁
    gate.release();
    const continuation = await holdContinuation(app);
    await settle();
    expect(app.queueTexts(task.id)).toEqual(["补充甲", "补充乙"]);

    // 判定通过 → 目标已完成（离开进行中）→ 队列恢复逐条自动发出
    continuation.write("续跑轮收尾");
    continuation.finish();
    (await app.nextVerdict()).respond(PASSED);
    const first = await app.hold("补充甲");
    expect(app.hasRequest("补充乙")).toBe(false);
    first.write("甲的处理结果");
    first.finish();
    await app.reply("补充乙");
    await app.idle(task.id);

    expect(app.userTexts(task.id)).toEqual([
      `建立任务-goal-queue-window`,
      GOAL,
      "补充甲",
      "补充乙",
    ]);
    expect(app.goalOf(task.id)?.status).toBe("completed");
  }, 15_000);

  it("轮间窗口任务仍占任务并发一席：满员时其他任务的排队不会趁窗口抢位开跑", async () => {
    const app = await setupGoalApp({ concurrencyLimit: () => 1 });
    const task = await app.newTask("goal-seat");
    // 目标首轮进行中（占唯一的并发席）：另一个任务的首条发送因满员进入任务排队
    const round = await startGoal(app, task.id);
    await invoke("start", {
      requestId: "goal-seat-other",
      projectId: null,
      text: "排队等待的任务",
    });
    round.write("首轮回复");
    round.finish();
    const verdict = await app.nextVerdict();
    const gate = app.armProfileGate();
    verdict.respond(FAILED);
    await gate.reached;

    // 轮间窗口：目标任务没有在途执行登记，但仍占席——排队任务不得开跑
    expect(invoke("execution", task.id)?.executionId).toBe(null);
    expect(
      invoke("list").find((item: any) => item.title === "排队等待的任务")
        .activity
    ).toMatchObject({ running: false, queued: true });
    await settle();
    expect(app.hasRequest("排队等待的任务")).toBe(false);

    gate.release();
    const continuation = await holdContinuation(app);
    expect(app.hasRequest("排队等待的任务")).toBe(false);

    // 目标完成后名额让出：排队任务开跑
    continuation.write("收尾");
    continuation.finish();
    (await app.nextVerdict()).respond(PASSED);
    const other = await app.hold("排队等待的任务");
    other.write("排队任务的处理结果");
    other.finish();
    await waitFor(() =>
      expect(
        invoke("list").every((item: any) => item.activity?.running !== true)
      ).toBe(true)
    );
  }, 15_000);
});

describe("运行口径：判定在途与轮间窗口", () => {
  it("判定在途与轮间窗口任务都呈现为执行中（侧栏不显示空闲）；判定在途带「验证中」副状态，循环结束才回到空闲", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-activity");
    const round = await startGoal(app, task.id);
    round.write("首轮回复");
    round.finish();
    const verdict = await app.nextVerdict();
    const gate = app.armProfileGate();

    // 判定在途：回合已结束（终态事件已下发），但任务仍是执行中，副状态为验证中
    expect(app.activityOf(task.id)).toMatchObject({
      running: true,
      waitingForUser: false,
      goalPhase: "verifying",
    });
    expect(invoke("view", task.id).activity).toMatchObject({
      running: true,
      goalPhase: "verifying",
    });
    expect(
      app
        .goalEvents(task.id)
        .find((envelope) => envelope.event.type === "goal-verifying")?.activity
    ).toMatchObject({ running: true, goalPhase: "verifying" });
    // 目标首轮回合的终态事件自身的活动态同样不得呈现为空闲（它早于「验证中」
    // 信号下发；建任务那一轮的终态事件与目标无关，取最后一个即目标首轮的）
    expect(
      app.delivered
        .filter(
          (envelope) =>
            envelope.taskId === task.id &&
            envelope.event.type === "assistant-done"
        )
        .at(-1)?.activity
    ).toMatchObject({ running: true });

    // 轮间窗口：不再验证中，但仍是执行中
    verdict.respond(FAILED);
    await gate.reached;
    expect(app.activityOf(task.id)).toMatchObject({ running: true });
    expect(app.activityOf(task.id).goalPhase).toBeUndefined();
    gate.release();

    const continuation = await holdContinuation(app);
    continuation.write("收尾");
    continuation.finish();
    (await app.nextVerdict()).respond(PASSED);
    await app.idle(task.id);

    // 循环结束：回到空闲（完成未查看提醒照旧口径）
    expect(app.activityOf(task.id)).toMatchObject({
      running: false,
      outcome: "completed",
    });
  }, 15_000);
});
