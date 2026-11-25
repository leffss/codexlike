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
  type Usage,
} from "./goal-harness";

/**
 * 目标模式（ADR 0035）票 05 的宿主侧：两道护栏。
 * - 空转阻断：连续 3 轮判定未过且无实质工具活动 → 「未达成」；
 * - token 预算：每次判定之后、下一轮发起之前对账（任务用量账目 − 基线），
 *   达到预算 → 「预算受限」（非终止）。
 * 装配见 goal-harness.ts（真实 TaskManager + 本地 OpenAI 兼容 mock，结果经 IPC 读回）。
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

/** 一个写入类工具（任务建为 ask 档：调用需审批） */
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

/** 一轮「只回文字、判定未过」的空转；返回续跑轮的请求 */
async function idleRound(
  app: GoalApp,
  current: PendingRound,
  text: string
): Promise<PendingRound> {
  current.write(text);
  current.finish();
  (await app.nextVerdict()).respond(FAILED);
  return holdContinuation(app);
}

describe("空转阻断：连续 3 轮判定未过且无实质工具活动", () => {
  it("第 3 轮空转 → 「未达成」：不再续跑，原因对用户可见，循环结束（输入队列与并发名额恢复）", async () => {
    const app = await setupGoalApp({ concurrencyLimit: () => 1 });
    const task = await app.newTask("goal-idle-block");
    const round = await startGoal(app, task.id);
    // 目标进行中排队的消息不自动消费；另一个任务因唯一的并发席被占而排队
    await invoke("send", task.id, "补充一句", app.profile.id);
    await invoke("start", {
      requestId: "goal-idle-block-other",
      projectId: null,
      text: "排队等待的任务",
    });

    // 第 1、2 轮空转：未达阈值，照常续跑
    let current = await idleRound(app, round, "空谈一");
    expect(app.goalOf(task.id)).toMatchObject({
      status: "active",
      idleStreak: 1,
    });
    current = await idleRound(app, current, "空谈二");
    expect(app.goalOf(task.id)).toMatchObject({
      status: "active",
      idleStreak: 2,
    });

    // 第 3 轮空转：连续 3 轮 → 未达成
    current.write("空谈三");
    current.finish();
    (await app.nextVerdict()).respond(FAILED);

    // 目标离开进行中：输入队列恢复自动发出——此前互锁的排队消息此刻才到达
    const queued = await app.hold("补充一句");
    expect(app.goalOf(task.id)).toMatchObject({
      status: "unmet",
      idleStreak: 3,
      failureStreak: 0,
    });
    // 三轮验证记录如实留痕：都是未过、都没有实质工具活动
    expect(
      app
        .verificationsOf(task.id)
        .map((record) => [record.round, record.outcome, record.toolActivity])
    ).toEqual([
      [1, "unpassed", false],
      [2, "unpassed", false],
      [3, "unpassed", false],
    ]);
    // 原因对用户可见：第 3 次判定的结论（标记行「未完成」）之后紧跟未达成的状态快照
    const events = app.goalEvents(task.id);
    expect(events.at(-2)?.event).toMatchObject({
      type: "goal-verification",
      verification: { round: 3, outcome: "unpassed" },
    });
    expect(events.at(-1)?.event).toMatchObject({
      type: "goal-changed",
      goal: { status: "unmet", idleStreak: 3 },
    });
    // 不再续跑：没有第 4 轮的续跑请求（此刻在途的只有排队消息的普通回合）
    await settle();
    expect(app.hasRequestWhere(isContinuation)).toBe(false);
    expect(app.goalOf(task.id)?.status).toBe("unmet");

    queued.write("补充一句的处理结果");
    queued.finish();
    await app.reply("排队等待的任务");
    await waitFor(() =>
      expect(
        invoke("list").every((item: any) => item.activity?.running !== true)
      ).toBe(true)
    );
    // 并发名额随循环结束让出：任务排队里的任务已开跑并收尾
    expect(app.hasRequest("排队等待的任务")).toBe(false);
    expect(app.userTexts(task.id)).toEqual([
      "建立任务-goal-idle-block",
      GOAL,
      "补充一句",
    ]);
    // 目标停在未达成：之后的普通回合不触发判定、不改目标状态
    expect(invoke("execution", task.id).running).toBe(false);
    expect(app.goalOf(task.id)?.status).toBe("unmet");
    expect(app.verificationsOf(task.id)).toHaveLength(3);
  }, 20_000);

  it("有实质工具活动的未过轮清零空转计数，不误触：两轮空转 → 一轮实际执行工具 → 再两轮空转仍照常续跑", async () => {
    const executed: string[] = [];
    const app = await setupGoalApp({ tools: tools(executed) });
    const task = await app.newTask("goal-idle-reset");
    const round = await startGoal(app, task.id);
    let current = await idleRound(app, round, "空谈一");
    current = await idleRound(app, current, "空谈二");
    expect(app.goalOf(task.id)?.idleStreak).toBe(2);

    // 第 3 轮：调用写入类工具，审批后实际执行 → 判定未过，但空转计数清零
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
    current = await idleRound(
      app,
      await holdContinuation(app),
      "工具执行完继续"
    );
    expect(executed).toEqual(["真正的改动"]);
    expect(app.goalOf(task.id)).toMatchObject({
      status: "active",
      idleStreak: 0,
    });
    expect(app.verificationsOf(task.id)[2]).toMatchObject({
      round: 3,
      outcome: "unpassed",
      toolActivity: true,
    });

    // 再两轮空转：计数 1、2——不把「两轮 + 之前两轮」累加成阻断
    current = await idleRound(app, current, "空谈三");
    current = await idleRound(app, current, "空谈四");
    expect(app.goalOf(task.id)).toMatchObject({
      status: "active",
      idleStreak: 2,
    });

    current.write("收尾");
    current.finish();
    (await app.nextVerdict()).respond(PASSED);
    await app.idle(task.id);
    expect(app.goalOf(task.id)).toMatchObject({
      status: "completed",
      idleStreak: 0,
    });
    expect(app.verificationsOf(task.id)).toHaveLength(6);
  }, 20_000);

  it("判定不可用的轮次不参与空转判定：两轮空转后夹着判定故障轮，不会因累计轮数被误判为未达成", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-idle-unavailable");
    const round = await startGoal(app, task.id);
    let current = await idleRound(app, round, "空谈一");
    current = await idleRound(app, current, "空谈二");
    expect(app.goalOf(task.id)?.idleStreak).toBe(2);

    // 第 3、4 轮：判定自身不可用（未达连续故障阈值）——故障轮不计空转
    current.write("第三轮");
    current.finish();
    (await app.nextVerdict()).fail();
    current = await holdContinuation(app);
    current.write("第四轮");
    current.finish();
    (await app.nextVerdict()).garbage();
    current = await holdContinuation(app);
    expect(app.goalOf(task.id)).toMatchObject({
      status: "active",
      idleStreak: 2,
      failureStreak: 2,
    });

    // 第 5 轮：正常的未过结论且无活动 → 空转计数才到 3 → 未达成
    current.write("空谈三");
    current.finish();
    (await app.nextVerdict()).respond(FAILED);
    await settle();
    expect(app.goalOf(task.id)).toMatchObject({
      status: "unmet",
      idleStreak: 3,
      failureStreak: 0,
    });
    expect(app.hasRequestWhere(isContinuation)).toBe(false);
  }, 20_000);
});

describe("实质工具活动只认实际执行了的调用（空转计数的输入）", () => {
  /** 首轮请求的最后一条 user 消息是目标原文，其后各轮是续跑指令 */
  const holdTail = (app: GoalApp, firstRound: boolean) =>
    firstRound ? app.hold(GOAL) : holdContinuation(app);

  it("每轮只发出被用户拒绝的调用同样是空转：连续 3 轮 → 未达成；被拒绝的调用从未执行", async () => {
    const executed: string[] = [];
    const app = await setupGoalApp({ tools: tools(executed) });
    const task = await app.newTask("goal-idle-rejected");
    const first = await startGoal(app, task.id);
    /** 一轮：模型调用写入类工具 → 用户拒绝 → 模型就此收尾 */
    const rejectedRound = async (
      current: PendingRound,
      firstRound: boolean,
      index: number
    ) => {
      current.toolCall("note", { text: `第${index}轮想写` });
      await waitFor(() =>
        expect(invoke("pendingApprovals", task.id).length).toBe(1)
      );
      invoke(
        "respondApproval",
        task.id,
        invoke("pendingApprovals", task.id)[0].id,
        "reject"
      );
      const tail = await holdTail(app, firstRound);
      tail.write(`第${index}轮：用户拒绝，未做改动`);
      tail.finish();
      (await app.nextVerdict()).respond(FAILED);
    };

    await rejectedRound(first, true, 1);
    let current = await holdContinuation(app);
    expect(app.goalOf(task.id)).toMatchObject({
      status: "active",
      idleStreak: 1,
    });
    await rejectedRound(current, false, 2);
    current = await holdContinuation(app);
    expect(app.goalOf(task.id)?.idleStreak).toBe(2);
    await rejectedRound(current, false, 3);
    await settle();

    expect(app.goalOf(task.id)).toMatchObject({
      status: "unmet",
      idleStreak: 3,
    });
    expect(
      app
        .verificationsOf(task.id)
        .map((record) => [record.round, record.toolActivity])
    ).toEqual([
      [1, false],
      [2, false],
      [3, false],
    ]);
    // 被拒绝的调用没有任何副作用；阻断后不再续跑
    expect(executed).toEqual([]);
    expect(app.hasRequestWhere(isContinuation)).toBe(false);
  }, 20_000);

  it("参数无效与不存在的工具调用不算活动：模型每轮只发出执行不了的调用 → 未达成", async () => {
    const executed: string[] = [];
    const app = await setupGoalApp({ tools: tools(executed) });
    const task = await app.newTask("goal-idle-ineffective");
    const first = await startGoal(app, task.id);
    /** 一轮：一次参数无效的调用 + 一次不存在工具的调用 → 模型收尾 */
    const ineffectiveRound = async (
      current: PendingRound,
      firstRound: boolean,
      index: number
    ) => {
      current.toolCall("note", '{"broken":');
      const afterInvalid = await holdTail(app, firstRound);
      afterInvalid.toolCall("ghost_tool", {});
      const tail = await holdTail(app, firstRound);
      tail.write(`第${index}轮：调用都没有执行`);
      tail.finish();
      (await app.nextVerdict()).respond(FAILED);
    };

    await ineffectiveRound(first, true, 1);
    let current = await holdContinuation(app);
    expect(app.goalOf(task.id)).toMatchObject({
      status: "active",
      idleStreak: 1,
    });
    await ineffectiveRound(current, false, 2);
    current = await holdContinuation(app);
    expect(app.goalOf(task.id)?.idleStreak).toBe(2);
    await ineffectiveRound(current, false, 3);
    await settle();

    expect(app.goalOf(task.id)).toMatchObject({
      status: "unmet",
      idleStreak: 3,
    });
    expect(executed).toEqual([]);
    // 这两种调用不进审批门；结果如实是「未执行」的错误结果
    expect(invoke("pendingApprovals", task.id)).toEqual([]);
    const calls = invoke("messages", task.id).filter(
      (item: any) => item.kind === "tool-call"
    );
    expect(
      calls.map((item: any) => [item.call.toolName, item.call.isError])
    ).toEqual([
      ["note", true],
      ["ghost_tool", true],
      ["note", true],
      ["ghost_tool", true],
      ["note", true],
      ["ghost_tool", true],
    ]);
    expect(calls[0].call.output).toContain("参数无效");
    expect(calls[1].call.output).toContain("未注册");
  }, 20_000);
});

describe("预算设置入口（goal-set-budget：进度行上的预算显示与设置）", () => {
  it("设定 / 调整预算：返回并落库更新后的目标、下发状态快照；目标状态与循环不受影响", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-budget-set");
    const round = await startGoal(app, task.id);

    expect(invoke("goal-set-budget", task.id, 200_000)).toMatchObject({
      status: "active",
      budgetTokens: 200_000,
      baselineTokens: 0,
    });
    expect(app.goalOf(task.id)?.budgetTokens).toBe(200_000);
    expect(app.goalEvents(task.id).at(-1)?.event).toMatchObject({
      type: "goal-changed",
      goal: { status: "active", budgetTokens: 200_000 },
    });

    // 进行中调整预算不打断在途回合：循环照旧
    expect(invoke("execution", task.id).running).toBe(true);
    invoke("goal-set-budget", task.id, 500_000);
    expect(app.goalOf(task.id)?.budgetTokens).toBe(500_000);

    round.write("收尾");
    round.finish();
    (await app.nextVerdict()).respond(PASSED);
    await app.idle(task.id);
    expect(app.goalOf(task.id)).toMatchObject({
      status: "completed",
      budgetTokens: 500_000,
    });
  }, 15_000);

  it("非法入参与已结束的目标以中文错误拒绝：非正整数、任务不存在、无目标、目标已完成", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-budget-invalid");
    expect(() => invoke("goal-set-budget", "missing-task", 100)).toThrow(
      "任务不存在"
    );
    expect(() => invoke("goal-set-budget", task.id, 100)).toThrow(
      "任务尚未设定目标"
    );
    for (const invalid of [0, -5, 1.5, "100", null, undefined]) {
      expect(() => invoke("goal-set-budget", task.id, invalid)).toThrow(
        "token 预算必须是正整数"
      );
    }

    const round = await startGoal(app, task.id);
    round.write("完成");
    round.finish();
    (await app.nextVerdict()).respond(PASSED);
    await app.idle(task.id);
    expect(() => invoke("goal-set-budget", task.id, 100)).toThrow(
      "目标已完成，不能修改预算"
    );
    expect(app.goalOf(task.id)?.budgetTokens).toBeNull();
  }, 15_000);
});

describe("token 预算：每次判定之后、下一轮发起之前对账（目标用量 = 任务用量账目 − 基线）", () => {
  /** 脚本化 usage：一轮工作 30 tokens、一次判定 20 tokens */
  const WORK: Usage = { promptTokens: 10, completionTokens: 20 };
  const VERDICT: Usage = { promptTokens: 10, completionTokens: 10 };

  /** 设定目标并给定预算；返回首轮回合的请求 */
  async function startBudgetedGoal(
    app: GoalApp,
    taskId: string,
    budget: number
  ): Promise<PendingRound> {
    const round = await startGoal(app, taskId);
    invoke("goal-set-budget", taskId, budget);
    return round;
  }

  it("目标用量达到预算 → 「预算受限」：未到的轮次照常续跑；达到的那一轮不被中途打断（判定照做、结论留痕），之后不再续跑", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-budget-limit");
    const round = await startBudgetedGoal(app, task.id, 100);

    // 第 1 轮：工作 30 + 判定 20 = 50，未到预算 → 照常续跑
    round.write("第一轮");
    round.finish(WORK);
    (await app.nextVerdict()).respond(FAILED, VERDICT);
    const second = await holdContinuation(app);
    expect(app.goalOf(task.id)?.status).toBe("active");

    // 第 2 轮：工作一轮就用了 200（此时已超预算）——回合照常跑完，不中途打断
    second.write("第二轮：大量读写");
    second.finish({ promptTokens: 100, completionTokens: 100 });
    // 该轮的完成判定照做（判定通过则目标完成，优先于预算）
    (await app.nextVerdict()).respond(FAILED, VERDICT);
    await app.idle(task.id);

    expect(app.goalOf(task.id)).toMatchObject({
      status: "budget-limited",
      budgetTokens: 100,
      baselineTokens: 0,
    });
    // 在途回合没有被预算打断：第二轮的回复与判定结论都完整留痕
    expect(
      app
        .verificationsOf(task.id)
        .map((record) => [record.round, record.outcome])
    ).toEqual([
      [1, "unpassed"],
      [2, "unpassed"],
    ]);
    expect(
      invoke("messages", task.id)
        .filter((item: any) => item.message?.role === "assistant")
        .map((item: any) => item.message.content)
    ).toEqual([
      "建立任务-goal-budget-limit的回答",
      "第一轮",
      "第二轮：大量读写",
    ]);
    // 原因对用户可见：第 2 次判定的结论之后紧跟预算受限的状态快照
    const events = app.goalEvents(task.id);
    expect(events.at(-2)?.event).toMatchObject({
      type: "goal-verification",
      verification: { round: 2, outcome: "unpassed" },
    });
    expect(events.at(-1)?.event).toMatchObject({
      type: "goal-changed",
      goal: { status: "budget-limited", budgetTokens: 100 },
    });
    // 不再续跑：没有第 3 轮的续跑请求，任务回到空闲
    await settle();
    expect(app.hasRequestWhere(isContinuation)).toBe(false);
    expect(invoke("execution", task.id).running).toBe(false);
  }, 20_000);

  it("达到预算的那一轮判定通过 → 「已完成」：完成优先于预算，不误报预算受限", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-budget-pass");
    const round = await startBudgetedGoal(app, task.id, 50);

    // 工作 30 + 判定 20 = 50：恰好达到预算，但判定通过
    round.write("做完了");
    round.finish(WORK);
    (await app.nextVerdict()).respond(PASSED, VERDICT);
    await app.idle(task.id);

    expect(app.goalOf(task.id)).toMatchObject({
      status: "completed",
      budgetTokens: 50,
    });
    expect(app.verificationsOf(task.id)).toHaveLength(1);
  }, 15_000);

  it("对账口径 = 任务用量账目（主任务列 + 子代理列），跨轮累计：子代理的用量同样计入预算", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-budget-subagent");
    const round = await startBudgetedGoal(app, task.id, 150);

    // 第 1 轮：主任务 50
    round.write("第一轮");
    round.finish(WORK);
    (await app.nextVerdict()).respond(FAILED, VERDICT);
    const second = await holdContinuation(app);
    // 子代理的用量入子代理列（子代理运行时经同一入账入口记账）：60
    app.manager.addUsage(task.id, {
      subagentInputTokens: 30,
      subagentOutputTokens: 30,
    });
    // 第 2 轮：主任务累计 100（< 150），加上子代理列是 160 → 达到预算
    second.write("第二轮");
    second.finish(WORK);
    (await app.nextVerdict()).respond(FAILED, VERDICT);
    await app.idle(task.id);

    expect(app.goalOf(task.id)?.status).toBe("budget-limited");
    // 账目如实：主任务 输入 40 / 输出 60，子代理 输入 30 / 输出 30
    expect(
      app.manager.list().find((item) => item.id === task.id)
    ).toMatchObject({
      mainInputTokens: 40,
      mainOutputTokens: 60,
      subagentInputTokens: 30,
      subagentOutputTokens: 30,
    });
  }, 20_000);

  it("未设预算 = 不限：用量再大也照常续跑，预算护栏不生效", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-no-budget");
    const round = await startGoal(app, task.id);
    const heavy: Usage = { promptTokens: 500_000, completionTokens: 500_000 };

    let current = round;
    for (const text of ["大轮次一", "大轮次二", "大轮次三"]) {
      current.write(text);
      current.finish(heavy);
      const verdict = await app.nextVerdict();
      if (text === "大轮次三") {
        verdict.respond(PASSED, heavy);
        break;
      }
      verdict.respond(FAILED, heavy);
      current = await holdContinuation(app);
      expect(app.goalOf(task.id)).toMatchObject({
        status: "active",
        budgetTokens: null,
      });
    }
    await app.idle(task.id);
    expect(app.goalOf(task.id)).toMatchObject({
      status: "completed",
      budgetTokens: null,
    });
  }, 20_000);

  it("对账基线：目标设定之前任务的用量不计入，不因既有用量被误判超预算", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-baseline");
    // 目标之前先聊一轮，用掉 1000
    await invoke("send", task.id, "预热", app.profile.id);
    const warm = await app.hold("预热");
    warm.write("预热回复");
    warm.finish({ promptTokens: 500, completionTokens: 500 });
    await app.idle(task.id);

    const round = await startBudgetedGoal(app, task.id, 100);
    expect(app.goalOf(task.id)?.baselineTokens).toBe(1000);

    // 目标用量 50 < 100：任务账目已是 1050，但不计入目标
    round.write("第一轮");
    round.finish(WORK);
    (await app.nextVerdict()).respond(FAILED, VERDICT);
    const second = await holdContinuation(app);
    expect(app.goalOf(task.id)?.status).toBe("active");
    // 目标用量累计到 100 → 预算受限
    second.write("第二轮");
    second.finish(WORK);
    (await app.nextVerdict()).respond(FAILED, VERDICT);
    await app.idle(task.id);
    expect(app.goalOf(task.id)).toMatchObject({
      status: "budget-limited",
      baselineTokens: 1000,
    });
  }, 20_000);

  it("预算受限态直接加预算：预算提高而停留状态不变（恢复由用户显式发起）；恢复后续跑按新预算对账", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-budget-raise");
    const round = await startBudgetedGoal(app, task.id, 100);
    round.write("第一轮");
    round.finish(WORK);
    (await app.nextVerdict()).respond(FAILED, VERDICT);
    const second = await holdContinuation(app);
    second.write("第二轮");
    second.finish(WORK);
    (await app.nextVerdict()).respond(FAILED, VERDICT);
    await app.idle(task.id);
    expect(app.goalOf(task.id)?.status).toBe("budget-limited");

    // 加预算：只改预算，不自动恢复（恢复经控制面）
    expect(invoke("goal-set-budget", task.id, 1000)).toMatchObject({
      status: "budget-limited",
      budgetTokens: 1000,
    });
    expect(app.goalEvents(task.id).at(-1)?.event).toMatchObject({
      type: "goal-changed",
      goal: { status: "budget-limited", budgetTokens: 1000 },
    });
    expect(invoke("execution", task.id).running).toBe(false);

    // 恢复（状态机入口；恢复 IPC 与按钮在票 04）：两个连续计数清零，对账基线不变
    app.manager.transitionGoal(task.id, "resume");
    expect(app.goalOf(task.id)).toMatchObject({
      status: "active",
      budgetTokens: 1000,
      baselineTokens: 0,
      idleStreak: 0,
      failureStreak: 0,
    });
    // 恢复后的回合到达 idle 边界：目标用量 100 < 新预算 1000，照常续跑
    await invoke("send", task.id, "恢复后继续", app.profile.id);
    const resumed = await app.hold("恢复后继续");
    resumed.write("继续推进");
    resumed.finish(WORK);
    (await app.nextVerdict()).respond(FAILED, VERDICT);
    const next = await holdContinuation(app);
    expect(app.goalOf(task.id)?.status).toBe("active");
    next.write("收尾");
    next.finish();
    (await app.nextVerdict()).respond(PASSED, VERDICT);
    await app.idle(task.id);
    expect(app.goalOf(task.id)?.status).toBe("completed");
  }, 20_000);
});
