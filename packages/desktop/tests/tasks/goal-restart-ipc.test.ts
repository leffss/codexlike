import { describe, expect, it } from "vitest";
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
 * 目标模式（ADR 0035「重启与恢复」）票 06 的宿主侧：应用被强杀后重启，
 * 「进行中」的目标恢复为「已暂停」，由用户经控制面恢复——不自动续跑、不产生
 * 任何模型消耗。装配见 goal-harness.ts 的 killAndRestart（在途回合与挂起的
 * 判定原样留着，只把库交给新一代）。结果一律经 IPC 读回。
 */
const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

const GOAL = "让示例测试全部通过";
/** 恢复指令的稳定锚（buildGoalContinuationInput 的恢复段） */
const RESUME_ANCHOR = "目标此前被暂停，现已恢复";
const isContinuation = (lastUserText: string) =>
  lastUserText.includes(CONTINUATION_ANCHOR);
const holdContinuation = (app: GoalApp) => app.holdWhere(isContinuation);

/** 设定目标并等到首轮回合的请求到达 */
async function startGoal(app: GoalApp, taskId: string): Promise<PendingRound> {
  await invoke("goalSet", taskId, GOAL, { providerProfileId: app.profile.id });
  return app.hold(GOAL);
}

/** 指定任务落库的消息（按时间顺序） */
const messagesOf = (taskId: string) =>
  invoke("messages", taskId).filter((item: any) => item.kind === "message") as {
    message: { role: string; content: string; createdAt: string };
  }[];

/**
 * 目标跑到「判定未过 → 续跑轮在途」时强杀（等价 taskkill /F：续跑轮的回复
 * 永远不会到达）。返回新一代与强杀前的快照。
 */
async function killDuringContinuation(requestId: string) {
  const app = await setupGoalApp();
  const task = await app.newTask(requestId);
  const first = await startGoal(app, task.id);
  first.write("第一轮回复");
  first.finish();
  (await app.nextVerdict()).respond(FAILED);
  await holdContinuation(app);
  const before = {
    goal: app.goalOf(task.id)!,
    verifications: app.verificationsOf(task.id),
    userTexts: app.userTexts(task.id),
    messageRoles: messagesOf(task.id).map((item) => item.message.role),
    // 停机前最后一条落库消息：续跑轮的内部输入
    lastMessageAt: messagesOf(task.id).at(-1)!.message.createdAt,
    requests: app.requestCount(),
  };
  return { task, before, restarted: app.killAndRestart() };
}

describe("重启恢复为暂停态：强杀之后", () => {
  it("续跑轮在途时被强杀：重启后目标「已暂停」，原文、验证记录与累计时长保留；任务侧补记中断提示，目标无特判", async () => {
    const { task, before, restarted } = await killDuringContinuation(
      "goal-killed-continuation"
    );
    expect(before.goal.status).toBe("active");
    expect(before.messageRoles).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "goal-continuation",
    ]);

    const goal = restarted.goalOf(task.id);
    // 状态与身份：同一条目标，原文、预算与对账基线不变，不再处于进行中
    expect(goal).toMatchObject({
      id: before.goal.id,
      text: GOAL,
      status: "paused",
      activeSince: null,
      budgetTokens: before.goal.budgetTokens,
      baselineTokens: before.goal.baselineTokens,
    });
    // 累计时长闭合在停机前最后一次有记录的活动上：目标设定 → 续跑指令落库
    expect(goal!.activeMs).toBe(
      Date.parse(before.lastMessageAt) - Date.parse(before.goal.activeSince!)
    );
    // 逐轮验证历史完整：强杀前那条判定结论原样可读
    expect(restarted.verificationsOf(task.id)).toEqual(before.verifications);

    // 任务侧口径（无特判）：循环不在新进程里存活，任务空闲、不占执行态
    expect(invoke("execution", task.id).running).toBe(false);
    expect(restarted.activityOf(task.id)).toMatchObject({
      running: false,
      // 残留的 streaming 由启动收尾补记中断提示 → 与普通任务一致的「已中断」未读提醒
      outcome: "interrupted",
      unread: true,
    });
    // 消息流：强杀前的消息原样，续跑指令之后没有回复，只多出任务侧的中断提示
    expect(restarted.messageRoles(task.id)).toEqual([
      ...before.messageRoles,
      "assistant",
    ]);
    const hint = messagesOf(task.id).at(-1)!.message;
    expect(hint).toMatchObject({ aborted: true });
    expect(hint.content).toContain("应用退出而中断");
    expect(restarted.userTexts(task.id)).toEqual(before.userTexts);
  }, 15_000);

  it("重启后不点恢复：没有任何模型请求——不续跑、不判定", async () => {
    const { task, restarted, before } =
      await killDuringContinuation("goal-killed-silent");

    await settle(400);

    expect(restarted.requestCount()).toBe(before.requests);
    expect(restarted.pendingVerdicts()).toBe(0);
    expect(restarted.goalOf(task.id)?.status).toBe("paused");
  }, 15_000);

  it("重启后用户手发一条消息：作为普通回合运行，回合结束不判定、不续跑，目标保持「已暂停」", async () => {
    const { task, restarted, before } = await killDuringContinuation(
      "goal-killed-plain-message"
    );

    await invoke("send", task.id, "重启后的普通消息", restarted.profile.id);
    await restarted.reply("重启后的普通消息");
    await restarted.idle(task.id);
    await settle(300);

    // 只有那条消息自己的工作轮：没有判定、没有续跑，验证记录没有增加
    expect(restarted.requestCount()).toBe(before.requests + 1);
    expect(restarted.pendingVerdicts()).toBe(0);
    expect(restarted.verificationsOf(task.id)).toEqual(before.verifications);
    expect(restarted.goalOf(task.id)).toMatchObject({
      status: "paused",
      activeSince: null,
    });
    // 这条消息是用户说的：如实呈现为用户消息；回合结束任务回到空闲
    expect(restarted.userTexts(task.id)).toEqual([
      ...before.userTexts,
      "重启后的普通消息",
    ]);
    expect(restarted.activityOf(task.id)).toMatchObject({ running: false });
  }, 15_000);

  it("点恢复：从暂停点续跑——以内部输入发起（不产生用户气泡），判定通过 → 已完成；累计时长与验证记录延续", async () => {
    const { task, restarted, before } =
      await killDuringContinuation("goal-killed-resume");
    const paused = restarted.goalOf(task.id)!;

    const resumed = await invoke("goalResume", task.id);

    // 恢复 = 状态机转回进行中：同一条目标，已闭合的累计时长原样带过去
    expect(resumed).toMatchObject({
      id: paused.id,
      status: "active",
      activeMs: paused.activeMs,
    });
    // 恢复后的那一轮是内部输入：带目标原文与恢复指令，不是用户发言
    const round = await restarted.holdWhere((last) =>
      last.includes(RESUME_ANCHOR)
    );
    expect(round.lastUserText).toContain(GOAL);
    round.write("暂停点之后的工作");
    round.finish();
    (await restarted.nextVerdict()).respond(PASSED);
    await restarted.idle(task.id);

    const done = restarted.goalOf(task.id)!;
    expect(done).toMatchObject({ status: "completed", idleStreak: 0 });
    expect(done.activeMs).toBeGreaterThanOrEqual(paused.activeMs);
    // 验证记录延续：重启前那条原样，恢复后的判定是第 2 轮
    const verifications = restarted.verificationsOf(task.id);
    expect(verifications[0]).toEqual(before.verifications[0]);
    expect(
      verifications.map((record) => [record.round, record.outcome])
    ).toEqual([
      [1, "unpassed"],
      [2, "passed"],
    ]);
    expect(restarted.userTexts(task.id)).toEqual(before.userTexts);
    expect(restarted.messageRoles(task.id).slice(-2)).toEqual([
      "goal-continuation",
      "assistant",
    ]);
    // 请求：恢复的续跑轮 + 判定，恰好两个
    expect(restarted.requestCount()).toBe(before.requests + 2);
    expect(restarted.activityOf(task.id)).toMatchObject({ running: false });
  }, 15_000);

  it("判定在途时被强杀：重启后目标同样「已暂停」，在途的判定不留结论；任务本就空闲，任务侧没有中断提醒", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-killed-verdict");
    const first = await startGoal(app, task.id);
    first.write("第一轮回复");
    first.finish();
    await app.nextVerdict();
    const before = {
      goal: app.goalOf(task.id)!,
      lastMessageAt: messagesOf(task.id).at(-1)!.message.createdAt,
      requests: app.requestCount(),
    };
    expect(before.goal.status).toBe("active");

    const restarted = app.killAndRestart();

    const goal = restarted.goalOf(task.id);
    expect(goal).toMatchObject({ status: "paused", activeSince: null });
    // 累计时长闭合在第一轮回复落库的时刻
    expect(goal!.activeMs).toBe(
      Date.parse(before.lastMessageAt) - Date.parse(before.goal.activeSince!)
    );
    expect(restarted.verificationsOf(task.id)).toEqual([]);
    // 回合已正常结束：没有残留执行，任务侧既有的空闲口径——不补中断提示、没有未读提醒
    expect(restarted.messageRoles(task.id)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    // 最后一条是第一轮的正常回复，不是任务侧的中断提示
    expect(messagesOf(task.id).at(-1)!.message.content).toBe("第一轮回复");
    expect(restarted.activityOf(task.id)).toMatchObject({
      running: false,
      outcome: null,
      unread: false,
    });
    expect(invoke("execution", task.id).running).toBe(false);

    await settle(300);
    expect(restarted.requestCount()).toBe(before.requests);
  }, 15_000);

  describe("终态的目标重启后逐字段不变", () => {
    /** 把目标推到指定终态；status 是 GOAL_STATUS_NAMES 口径的终态名 */
    const cases: [string, (app: GoalApp, taskId: string) => Promise<void>][] = [
      [
        "已完成",
        async (app, taskId) => {
          const first = await startGoal(app, taskId);
          first.write("第一轮回复");
          first.finish();
          (await app.nextVerdict()).respond(PASSED);
          await app.idle(taskId);
        },
      ],
      [
        "已清除",
        async (app, taskId) => {
          await startGoal(app, taskId);
          await invoke("goalClear", taskId);
          await app.idle(taskId);
        },
      ],
    ];
    for (const [status, drive] of cases) {
      it(`「${status}」`, async () => {
        const app = await setupGoalApp();
        const task = await app.newTask(`goal-killed-${status}`);
        await drive(app, task.id);
        const before = app.goalOf(task.id);
        const verifications = app.verificationsOf(task.id);

        const restarted = app.killAndRestart();

        expect(restarted.goalOf(task.id)).toEqual(before);
        expect(restarted.verificationsOf(task.id)).toEqual(verifications);
        expect(restarted.activityOf(task.id)).toMatchObject({ running: false });
      }, 15_000);
    }
  });
});
