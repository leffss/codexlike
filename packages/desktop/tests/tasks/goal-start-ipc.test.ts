import { describe, expect, it } from "vitest";
import { GOAL_TEXT_MAX_LENGTH } from "@codexlike/agent-core/node";
import { PASSED, ipcInvoke as invoke, setupGoalApp } from "./goal-harness";

/**
 * 新建任务页 /goal（ADR 0035，tasks:start 带 goal 标记）：建任务、目标落库、
 * 目标原文作首条用户消息开跑——与任务态 /goal 同一语义（目标原文即首条指令
 * 与完成判定标准），只是任务此刻尚不存在。
 * 失败沿用首次发送的回滚：任务与目标都不留——持久层不依赖外键级联，
 * 回滚必须显式清目标行。装配见 goal-harness.ts。
 */

describe("tasks:start 带 goal（新建任务页 /goal）", () => {
  it("建任务即设目标：目标原文作为唯一一条用户消息发出首轮，goal-changed 下发", async () => {
    const app = await setupGoalApp();
    const text = "写一个mysql备份脚本";
    const task = await invoke("start", {
      requestId: "goal-start",
      projectId: null,
      text,
      goal: true,
      providerProfileId: app.profile.id,
    });

    expect(app.goalOf(task.id)).toMatchObject({ text, status: "active" });
    // 目标原文就是首条用户消息：不在建任务消息之后重复发送
    const round = await app.hold(text);
    expect(app.userTexts(task.id)).toEqual([text]);
    expect(app.goalEvents(task.id).at(0)?.event).toMatchObject({
      type: "goal-changed",
      goal: { text, status: "active" },
    });

    // 回合结束后自动进入完成判定；通过即完成
    round.write("备份脚本已就绪");
    round.finish();
    (await app.nextVerdict()).respond(PASSED);
    await app.idle(task.id);
    expect(app.goalOf(task.id)?.status).toBe("completed");
  }, 15_000);

  it("goal 缺省（普通首条消息）：不设目标、不判定", async () => {
    const app = await setupGoalApp();
    const task = await invoke("start", {
      requestId: "plain-start",
      projectId: null,
      text: "普通首条消息",
      providerProfileId: app.profile.id,
    });
    const round = await app.hold("普通首条消息");
    round.write("回复");
    round.finish();
    await app.idle(task.id);
    expect(app.goalOf(task.id)).toBeNull();
    expect(app.pendingVerdicts()).toBe(0);
  }, 15_000);

  it("目标被拒绝（超长）：不建任务、不落目标、不发模型请求", async () => {
    const app = await setupGoalApp();
    const before = app.requestCount();
    await expect(
      invoke("start", {
        requestId: "goal-too-long",
        projectId: null,
        text: "长".repeat(GOAL_TEXT_MAX_LENGTH + 1),
        goal: true,
        providerProfileId: app.profile.id,
      })
    ).rejects.toThrow("目标文本过长");
    expect(invoke("list")).toEqual([]);
    expect(app.requestCount()).toBe(before);
  }, 15_000);

  it("首轮启动失败：任务与目标一起回滚，不留孤儿目标行", async () => {
    const app = await setupGoalApp();
    const before = app.delivered.length;
    await expect(
      invoke("start", {
        requestId: "goal-rollback",
        projectId: null,
        text: "目标首轮会失败",
        goal: true,
        mentionPaths: ["不存在的文件.md"],
        providerProfileId: app.profile.id,
      })
    ).rejects.toThrow("@引用 的文件不存在");

    // 目标设定事件已下发（任务 id 从信封取得），随后任务与目标同滚
    const goalEvent = app.delivered
      .slice(before)
      .find(
        (envelope) =>
          envelope.event.type === "goal-changed" &&
          (envelope.event as { goal: unknown }).goal !== null
      );
    expect(goalEvent).toBeDefined();
    const taskId = goalEvent!.taskId;
    expect(app.manager.list().some((task) => task.id === taskId)).toBe(false);
    expect(app.manager.goal(taskId)).toBeNull();

    // 同一草稿标识可重试：这次用合法参数建任务并设目标
    const retried = await invoke("start", {
      requestId: "goal-rollback",
      projectId: null,
      text: "重试的目标",
      goal: true,
      providerProfileId: app.profile.id,
    });
    expect(app.goalOf(retried.id)).toMatchObject({
      text: "重试的目标",
      status: "active",
    });
    await app.reply("重试的目标");
    (await app.nextVerdict()).respond(PASSED);
    await app.idle(retried.id);
  }, 20_000);

  it("goal 不是布尔值：参数不合法，不建任务", async () => {
    const app = await setupGoalApp();
    // 入参校验在首个 await 之前：直调 handler 时为同步抛错（渲染层仍收到 rejection）
    expect(() =>
      invoke("start", {
        requestId: "goal-bad-flag",
        projectId: null,
        text: "目标",
        goal: "yes",
        providerProfileId: app.profile.id,
      })
    ).toThrow("首次发送：goal 必须是布尔值");
    expect(invoke("list")).toEqual([]);
  });

  it("满员：首轮进任务排队、目标保持进行中；名额空出后自动开跑并进入判定", async () => {
    const app = await setupGoalApp({ concurrencyLimit: () => 1 });
    const running = await app.newTask("goal-queue-slot");
    // 占满唯一执行名额
    const sending = invoke("send", running.id, "占满名额", app.profile.id);
    const slotRound = await app.hold("占满名额");

    const text = "排队中开跑的目标";
    const queued = await invoke("start", {
      requestId: "goal-queued",
      projectId: null,
      text,
      goal: true,
      providerProfileId: app.profile.id,
    });
    // 建任务即设目标；满员时首轮静默进任务排队（不是失败）
    expect(app.goalOf(queued.id)).toMatchObject({ text, status: "active" });
    expect(app.hasRequest(text)).toBe(false);

    // 名额空出：排队任务按 FIFO 自动开跑，目标原文作为首轮请求到达
    slotRound.write("名额已空出");
    slotRound.finish();
    await sending;
    await app.idle(running.id);
    const goalRound = await app.hold(text);
    expect(app.userTexts(queued.id)).toEqual([text]);
    goalRound.write("备份脚本已就绪");
    goalRound.finish();
    (await app.nextVerdict()).respond(PASSED);
    await app.idle(queued.id);
    expect(app.goalOf(queued.id)?.status).toBe("completed");
  }, 20_000);
});
