import { describe, expect, it } from "vitest";
import { GOAL_TEXT_MAX_LENGTH } from "@codexlike/agent-core/node";
import {
  FAILED,
  PASSED,
  ipcInvoke as invoke,
  setupGoalApp,
} from "./goal-harness";

/**
 * 目标模式（ADR 0035，GLOSSARY「目标」「目标模式」「完成判定」）票 02 的宿主侧：
 * /goal 命令解析与设定、goal 编排器（回合结束的 idle 边界 → 完成判定 → 已完成）、
 * 输入队列互锁、Stop = 暂停、应用退出屏障。
 * 续跑循环（判定未过 → 自动续跑）的行为见 goal-continuation-ipc.test.ts。
 * 装配见 goal-harness.ts。
 */

describe("/goal 命令解析与设定（tasks:goal-set）", () => {
  it("空目标与超长目标以中文原因拒绝：不落库、不发模型请求", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-parse");
    const before = app.requestCount();

    await expect(invoke("goal-set", task.id, "  \n ")).rejects.toThrow(
      "目标不能为空"
    );
    await expect(
      invoke("goal-set", task.id, "长".repeat(GOAL_TEXT_MAX_LENGTH + 1))
    ).rejects.toThrow("目标文本过长");
    await expect(invoke("goal-set", task.id, 42)).rejects.toThrow(
      "设定目标：参数不合法"
    );

    expect(app.goalOf(task.id)).toBeNull();
    expect(app.requestCount()).toBe(before);
  });

  it("有效目标：设定即「进行中」，目标原文作为用户消息发出首轮；view 携带目标、goal-changed 事件下发", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-set");
    expect(app.goalOf(task.id)).toBeNull();

    const goal = await invoke("goal-set", task.id, "让示例测试全部通过", {
      providerProfileId: app.profile.id,
    });

    expect(goal).toMatchObject({
      taskId: task.id,
      text: "让示例测试全部通过",
      status: "active",
      idleStreak: 0,
      failureStreak: 0,
    });
    // 首轮已发出：目标原文就是首条用户消息，回复进行中
    const round = await app.hold("让示例测试全部通过");
    expect(round.body.stream).toBe(true);
    expect(app.userTexts(task.id)).toEqual([
      "建立任务-goal-set",
      "让示例测试全部通过",
    ]);
    expect(app.goalOf(task.id)).toEqual(goal);
    // 任务侧状态照旧四值：首轮进行中为 streaming
    expect(invoke("list")[0]).toMatchObject({
      id: task.id,
      status: "streaming",
    });
    expect(app.goalEvents(task.id).at(-1)?.event).toEqual({
      type: "goal-changed",
      goal,
    });

    await round.write("首轮回复");
    await round.finish();
    // 回合结束即进入完成判定：应答后目标完成、任务回到空闲
    (await app.nextVerdict()).respond(PASSED);
    await app.idle(task.id);
  });

  it("任务不可设定目标的情形以中文原因拒绝：已归档、回复进行中", async () => {
    const app = await setupGoalApp();
    const running = await app.newTask("goal-running");
    const sending = invoke("send", running.id, "进行中的消息", app.profile.id);
    const round = await app.hold("进行中的消息");
    await expect(
      invoke("goal-set", running.id, "目标", {
        providerProfileId: app.profile.id,
      })
    ).rejects.toThrow("任务正在执行");
    expect(app.goalOf(running.id)).toBeNull();
    round.write("进行中的消息的回答");
    round.finish();
    await sending;
    await app.idle(running.id);

    const archived = await app.newTask("goal-archived");
    await invoke("archive", archived.id, true);
    await expect(
      invoke("goal-set", archived.id, "目标", {
        providerProfileId: app.profile.id,
      })
    ).rejects.toThrow("任务已归档");
    expect(app.goalOf(archived.id)).toBeNull();
  });

  it("首轮启动失败时目标回滚：不留「进行中却没有回合」的半成品，失败原因原样抛回", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-rollback");

    // 发送参数非法（思考档位越界）→ 首轮在启动处失败
    await expect(
      invoke("goal-set", task.id, "启动会失败的目标", {
        providerProfileId: app.profile.id,
        thinkingEffort: "bogus",
      })
    ).rejects.toThrow("无效的思考档位");
    expect(app.goalOf(task.id)).toBeNull();

    // 所选模型不存在同样回滚
    await expect(
      invoke("goal-set", task.id, "启动会失败的目标", {
        providerProfileId: "ghost-profile",
      })
    ).rejects.toThrow("Provider Profile 不存在");
    expect(app.goalOf(task.id)).toBeNull();

    // 回滚后任务照常可用：空闲、不占并发席，可以发普通消息
    expect(invoke("execution", task.id).running).toBe(false);
    void invoke("send", task.id, "回滚后的普通消息", app.profile.id);
    await app.reply("回滚后的普通消息");
    await app.idle(task.id);

    // 用合法参数可以重新设定
    const goal = await invoke("goal-set", task.id, "重新设定的目标", {
      providerProfileId: app.profile.id,
    });
    expect(goal.status).toBe("active");
    await app.reply("重新设定的目标");
    (await app.nextVerdict()).respond(PASSED);
    await app.idle(task.id);
  }, 15_000);
});

describe("goal 编排器：回合结束的 idle 边界（ADR 0035）", () => {
  it("编排器单次流转：首轮回合正常结束 → 自动发起完成判定 → 判定通过 → 目标「已完成」，标记行与状态事件下发", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-pass");
    await invoke("goal-set", task.id, "让示例测试全部通过", {
      providerProfileId: app.profile.id,
    });
    const round = await app.hold("让示例测试全部通过");

    // 回合正常结束 → 宿主在 idle 边界自动发起完成判定（无需用户操作）
    round.write("示例测试已全部通过。");
    round.finish();
    const verdictRequest = await app.nextVerdict();

    // 判定请求形状（票 01 对接契约 + 完成判定契约）：无工具、首部带标记、带目标与历史
    expect(verdictRequest.body.tools).toBeUndefined();
    expect(verdictRequest.body.stream).not.toBe(true);
    const body = JSON.stringify(verdictRequest.body);
    expect(body).toContain("[goal-verification]");
    expect(body).toContain("让示例测试全部通过");
    expect(body).toContain("示例测试已全部通过。");
    // 判定在途：目标仍进行中，任务仍占执行席（没有回到空闲的空窗）
    expect(app.goalOf(task.id)?.status).toBe("active");
    expect(invoke("execution", task.id).running).toBe(true);

    verdictRequest.respond(PASSED);
    await app.idle(task.id);

    // 判定通过 → 目标「已完成」，累计时长定格
    const goal = app.goalOf(task.id);
    expect(goal).toMatchObject({
      status: "completed",
      activeSince: null,
      idleStreak: 0,
      failureStreak: 0,
    });
    expect(goal?.activeMs).toBeGreaterThanOrEqual(0);
    expect(app.verificationsOf(task.id)).toEqual([
      {
        id: expect.any(String),
        taskId: task.id,
        goalId: goal?.id,
        round: 1,
        passed: true,
        outcome: "passed",
        reason: "示例测试已全部通过",
        nextAction: "",
        // 本轮没有工具调用：记录如实留痕（通过轮不参与空转计数）
        toolActivity: false,
        createdAt: expect.any(String),
      },
    ]);
    // 事件序：设定（进行中）→ 判定开始（验证中）→ 判定结论（标记行）→ 状态（已完成）
    const events = app
      .goalEvents(task.id)
      .map((envelope) => envelope.event.type);
    expect(events).toEqual([
      "goal-changed",
      "goal-verifying",
      "goal-verification",
      "goal-changed",
    ]);
    // 任务侧状态四值不变：目标完成后任务回到空闲
    expect(invoke("list")[0]).toMatchObject({ id: task.id, status: "idle" });
    expect(invoke("execution", task.id).running).toBe(false);
  }, 15_000);

  it("回合出错（模型请求失败）：不发起完成判定，目标转「已暂停」——不留「进行中却没有回合」的空转态", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-round-error");
    await invoke("goal-set", task.id, "让示例测试全部通过", {
      providerProfileId: app.profile.id,
    });
    (await app.hold("让示例测试全部通过")).fail();
    await app.idle(task.id);

    expect(app.goalOf(task.id)).toMatchObject({ status: "paused" });
    expect(app.pendingVerdicts()).toBe(0);
    expect(app.verificationsOf(task.id)).toEqual([]);
    expect(invoke("execution", task.id).running).toBe(false);
  }, 15_000);
});

describe("Stop 在目标进行中 = 暂停（ADR 0035）", () => {
  it("停止按钮：当前回合中断、目标转「已暂停」且不丢失、不发起完成判定、暂停后不自行续跑", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-stop");
    await invoke("goal-set", task.id, "让示例测试全部通过", {
      providerProfileId: app.profile.id,
    });
    const round = await app.hold("让示例测试全部通过");
    round.write("写到一半的回复");

    expect(invoke("interrupt", task.id)).toBe(true);
    await app.idle(task.id);

    // 目标不丢失：原文保留，状态转已暂停，累计时长定格
    expect(app.goalOf(task.id)).toMatchObject({
      taskId: task.id,
      text: "让示例测试全部通过",
      status: "paused",
      activeSince: null,
    });
    // 中断的回合不判定：没有「验证中」占位，也没有验证记录
    expect(app.pendingVerdicts()).toBe(0);
    expect(app.verificationsOf(task.id)).toEqual([]);
    expect(
      app
        .goalEvents(task.id)
        .some((envelope) => envelope.event.type === "goal-verifying")
    ).toBe(false);
    // 暂停后不得自行无限续跑：没有新的模型请求，任务保持空闲
    const requests = app.requestCount();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(app.requestCount()).toBe(requests);
    expect(invoke("execution", task.id).running).toBe(false);
    expect(app.goalOf(task.id)?.status).toBe("paused");
    expect(app.goalEvents(task.id).at(-1)?.event).toMatchObject({
      type: "goal-changed",
      goal: { status: "paused" },
    });
  }, 15_000);

  it("目标不在进行中时，停止按钮的行为不变（普通任务 / 已完成的目标）", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-stop-plain");
    const sending = invoke("send", task.id, "普通消息", app.profile.id);
    await app.hold("普通消息");

    expect(invoke("interrupt", task.id)).toBe(true);
    await app.idle(task.id);
    await sending.catch(() => {});

    // 没有目标：停止不产生任何目标事件
    expect(app.goalOf(task.id)).toBeNull();
    expect(app.goalEvents(task.id)).toEqual([]);
  }, 15_000);
});

describe("输入队列互锁（ADR 0035「暂停阀门」）", () => {
  it("目标进行中（含判定在途）排队消息不自动消费；终态后恢复逐条自动发出", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-queue");
    await invoke("goal-set", task.id, "让示例测试全部通过", {
      providerProfileId: app.profile.id,
    });
    const round = await app.hold("让示例测试全部通过");
    // 回复进行中提交的两条消息进入输入队列（不丢）
    await invoke("send", task.id, "补充甲", app.profile.id);
    await invoke("send", task.id, "补充乙", app.profile.id);
    expect(app.queueTexts(task.id)).toEqual(["补充甲", "补充乙"]);

    // 回合结束、判定在途（判定请求未应答）：排队消息不得被发出，队列原样保留
    round.write("首轮回复");
    round.finish();
    const verdict = await app.nextVerdict();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(app.userTexts(task.id)).toEqual([
      "建立任务-goal-queue",
      "让示例测试全部通过",
    ]);
    expect(app.queueTexts(task.id)).toEqual(["补充甲", "补充乙"]);
    expect(invoke("execution", task.id).running).toBe(true);

    // 判定通过 → 目标已完成（终态）→ 队列恢复自动逐条发出
    verdict.respond(PASSED);
    const first = await app.hold("补充甲");
    // 逐条消费：甲的回复未完成前乙不得发出（发一条、等其回复完成、再发下一条）
    expect(app.hasRequest("补充乙")).toBe(false);
    expect(app.queueTexts(task.id)).toEqual(["补充甲", "补充乙"]);
    first.write("甲的处理结果");
    first.finish();
    await app.reply("补充乙");
    await app.idle(task.id);

    expect(app.userTexts(task.id)).toEqual([
      "建立任务-goal-queue",
      "让示例测试全部通过",
      "补充甲",
      "补充乙",
    ]);
    expect(app.queueTexts(task.id)).toEqual([]);
    expect(app.goalOf(task.id)?.status).toBe("completed");
    // 排队消息的回合结束后不再判定：目标已不在进行中
    expect(app.pendingVerdicts()).toBe(0);
  }, 15_000);

  it("续跑期间队列持续互锁；目标离开进行中（已暂停）后，排队消息可恢复自动逐条发出", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-queue-paused");
    await invoke("goal-set", task.id, "让示例测试全部通过", {
      providerProfileId: app.profile.id,
    });
    const round = await app.hold("让示例测试全部通过");
    await invoke("send", task.id, "补充一句", app.profile.id);

    // 未过 → 自动续跑：目标仍在进行中，排队消息照旧不被发出
    round.write("首轮回复");
    round.finish();
    (await app.nextVerdict()).respond(FAILED);
    await app.holdWhere((text) => text.includes("【目标续跑】"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(app.userTexts(task.id)).toEqual([
      "建立任务-goal-queue-paused",
      "让示例测试全部通过",
    ]);
    expect(app.queueTexts(task.id)).toEqual(["补充一句"]);

    // 续跑轮进行中点停止：目标转已暂停（离开进行中）。停止路径沿用既有规则——
    // 有排队消息时输入队列进入「队列暂停」，手动恢复后自动发出（修正见票 04）
    expect(invoke("interrupt", task.id)).toBe(true);
    await app.idle(task.id);
    expect(app.goalOf(task.id)?.status).toBe("paused");
    expect(invoke("view", task.id).queueState.paused).toBe(true);
    invoke("queueResume", task.id);
    await app.reply("补充一句");
    await app.idle(task.id);

    expect(app.userTexts(task.id)).toEqual([
      "建立任务-goal-queue-paused",
      "让示例测试全部通过",
      "补充一句",
    ]);
    expect(app.queueTexts(task.id)).toEqual([]);
  }, 15_000);

  it("应用退出屏障：中断在途判定时不做任何目标编排（目标状态原样，重启后的恢复由恢复链路负责）", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("goal-exit");
    await invoke("goal-set", task.id, "让示例测试全部通过", {
      providerProfileId: app.profile.id,
    });
    const round = await app.hold("让示例测试全部通过");
    round.write("首轮回复");
    round.finish();
    // 判定在途时用户退出应用：退出屏障中断全部执行并排空
    await app.nextVerdict();
    await app.runtime.stopAndDrain();

    // 退出路径不改目标状态：不落结论、不暂停（与「回合在途被退出中断」同口径）
    expect(app.goalOf(task.id)?.status).toBe("active");
    expect(app.verificationsOf(task.id)).toEqual([]);
    expect(invoke("execution", task.id).running).toBe(false);
    app.runtime.thaw();
  }, 15_000);
});
