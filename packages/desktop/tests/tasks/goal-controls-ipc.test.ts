import { describe, expect, it, vi } from "vitest";
import {
  GOAL_TEXT_MAX_LENGTH,
  type GoalRecord,
  type ToolDefinition,
} from "@codexlike/agent-core/node";
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
 * 目标模式（ADR 0035，GLOSSARY「目标」「目标模式」「完成判定」）票 04 的宿主侧：
 * 控制面——恢复 / 编辑 / 清除的状态推进与事件下发、Stop 后输入队列恢复自动发出
 * （规格故事 12）、目标进行中的 /compact、续跑轮发起失败的暂停原因。
 * 装配见 goal-harness.ts（真实 TaskManager + 两条脚本化线的本地 mock）。
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

/** 等某条排队消息的请求到达并应答（不手动恢复队列） */
async function answer(app: GoalApp, text: string, reply = `${text}的处理结果`) {
  const round = await app.hold(text);
  round.write(reply);
  await round.finish();
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

/** 把当前目标停在「已暂停」并等到任务空闲；返回暂停时的目标记录 */
async function pauseGoal(
  app: GoalApp,
  taskId: string,
  round: PendingRound
): Promise<GoalRecord> {
  round.write("写到一半");
  expect(invoke("interrupt", taskId)).toBe(true);
  await app.idle(taskId);
  const paused = app.goalOf(taskId);
  expect(paused).toMatchObject({ status: "paused", activeSince: null });
  return paused!;
}

/** 等一轮续跑到达、收尾并判定通过（目标 → 已完成）；返回这一轮续跑轮请求 */
async function passContinuation(
  app: GoalApp,
  taskId: string
): Promise<PendingRound> {
  const continuation = await holdContinuation(app);
  continuation.write("续跑轮收尾");
  continuation.finish();
  (await app.nextVerdict()).respond(PASSED);
  await app.idle(taskId);
  return continuation;
}

/** 停在「已暂停」且已有一轮验证记录的目标：返回暂停时的目标记录 */
async function pausedWithHistory(
  app: GoalApp,
  taskId: string
): Promise<GoalRecord> {
  const round = await startGoal(app, taskId);
  round.write("首轮回复");
  round.finish();
  (await app.nextVerdict()).respond(FAILED);
  const continuation = await holdContinuation(app);
  continuation.write("续跑轮回复");
  return pauseGoal(app, taskId, continuation);
}

describe("目标进行中点 Stop 后输入队列恢复自动发出（规格故事 12）", () => {
  it("首轮回合在途点 Stop：目标转已暂停，排队消息自动逐条发出、作为普通回合运行", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("stop-queue-turn");
    const round = await startGoal(app, task.id);
    await invoke("send", task.id, "补充甲", app.profile.id);
    await invoke("send", task.id, "补充乙", app.profile.id);
    expect(app.queueTexts(task.id)).toEqual(["补充甲", "补充乙"]);

    round.write("写到一半");
    expect(invoke("interrupt", task.id)).toBe(true);

    // 无需手动恢复队列：目标转已暂停后排队消息自动发出；发一条、等其回复完成、再发下一条
    const first = await app.hold("补充甲");
    expect(invoke("view", task.id).queueState.paused).toBe(false);
    expect(app.goalOf(task.id)?.status).toBe("paused");
    expect(app.hasRequest("补充乙")).toBe(false);
    first.write("甲的处理结果");
    first.finish();
    await answer(app, "补充乙");
    await app.idle(task.id);

    expect(app.userTexts(task.id)).toEqual([
      "建立任务-stop-queue-turn",
      GOAL,
      "补充甲",
      "补充乙",
    ]);
    expect(app.queueTexts(task.id)).toEqual([]);
    // 被中断的回合不判定；排队消息是普通回合，同样不判定、不续跑
    expect(app.verificationsOf(task.id)).toEqual([]);
    expect(app.pendingVerdicts()).toBe(0);
    expect(invoke("view", task.id).queueState.paused).toBe(false);
    expect(app.goalOf(task.id)?.status).toBe("paused");
    await settle();
    expect(app.hasRequestWhere(isContinuation)).toBe(false);
  }, 15_000);

  it("判定在途点 Stop：判定被中断不留结论，目标转已暂停，排队消息自动发出", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("stop-queue-verifying");
    const round = await startGoal(app, task.id);
    await invoke("send", task.id, "补充一句", app.profile.id);
    round.write("首轮回复");
    round.finish();
    await app.nextVerdict();

    expect(invoke("interrupt", task.id)).toBe(true);
    await answer(app, "补充一句");
    await app.idle(task.id);

    expect(app.goalOf(task.id)?.status).toBe("paused");
    expect(app.verificationsOf(task.id)).toEqual([]);
    expect(app.userTexts(task.id)).toEqual([
      "建立任务-stop-queue-verifying",
      GOAL,
      "补充一句",
    ]);
    expect(app.queueTexts(task.id)).toEqual([]);
    expect(invoke("view", task.id).queueState.paused).toBe(false);
  }, 15_000);

  it("目标的首条执行因满员在任务排队中点 Stop（名额刚空出、尚未开跑）：出队并转已暂停，排队期间追加的消息随即自动发出", async () => {
    const app = await setupGoalApp({ concurrencyLimit: () => 1 });
    const task = await app.newTask("stop-queued-goal");
    // 另一个任务占着唯一的并发席：目标的首轮进入任务排队，排队期间追加的消息进入输入队列
    const blocker = await app.newTask("stop-queued-blocker");
    void invoke("send", blocker.id, "占位的长回合", app.profile.id);
    const seat = await app.hold("占位的长回合");
    await invoke("goal-set", task.id, GOAL, {
      providerProfileId: app.profile.id,
    });
    expect(
      invoke("list").find((item: any) => item.id === task.id).activity
    ).toMatchObject({ running: false, queued: true });
    await invoke("send", task.id, "补充一句", app.profile.id);

    // 名额空出：任务排队推进，目标的首条执行开始发起、卡在读发送参数上（尚未出队开跑）
    const gate = app.armProfileGate();
    seat.write("占位回合的处理结果");
    seat.finish();
    await gate.reached;

    expect(invoke("interrupt", task.id)).toBe(true);
    expect(app.goalOf(task.id)?.status).toBe("paused");
    expect(
      invoke("list").find((item: any) => item.id === task.id).activity.queued
    ).toBe(false);
    // 输入队列不进入「队列暂停」，排队消息立即进入发送
    expect(invoke("view", task.id).queueState.paused).toBe(false);
    expect(app.queueTexts(task.id)).toEqual(["补充一句"]);
    gate.release();

    // 此刻没有别的触发点（没有在途回合的收尾、也没有待发起的续跑轮）：这条
    // 排队消息只能靠停止时的补唤醒发出
    await answer(app, "补充一句");
    await app.idle(task.id);
    expect(app.userTexts(task.id)).toEqual([
      "建立任务-stop-queued-goal",
      GOAL,
      "补充一句",
    ]);
    expect(app.queueTexts(task.id)).toEqual([]);
    expect(app.goalOf(task.id)?.status).toBe("paused");
    expect(app.verificationsOf(task.id)).toEqual([]);
  }, 15_000);

  it("非目标的停止路径不变：普通任务 Stop 仍把输入队列置为「队列暂停」，手动恢复后才发出", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("stop-queue-plain");
    const sending = invoke("send", task.id, "进行中的消息", app.profile.id);
    await app.hold("进行中的消息");
    await invoke("send", task.id, "排队消息", app.profile.id);

    expect(invoke("interrupt", task.id)).toBe(true);
    await app.idle(task.id);
    await sending.catch(() => {});

    expect(invoke("view", task.id).queueState.paused).toBe(true);
    await settle();
    expect(app.hasRequest("排队消息")).toBe(false);
    invoke("queueResume", task.id);
    await answer(app, "排队消息");
    await app.idle(task.id);
  }, 15_000);

  it("目标已暂停后，排队消息的普通回合在途再点 Stop：停止的不是目标循环，输入队列照旧置为「队列暂停」", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("stop-queue-normal-turn");
    const round = await startGoal(app, task.id);
    await invoke("send", task.id, "补充甲", app.profile.id);
    round.write("首轮回复");
    // 目标 Stop：队列自动发出，「补充甲」作为普通回合开始运行
    expect(invoke("interrupt", task.id)).toBe(true);
    await app.hold("补充甲");

    // 「补充甲」的回合进行中再入队一条，然后停止这个普通回合
    await invoke("send", task.id, "补充乙", app.profile.id);
    expect(invoke("interrupt", task.id)).toBe(true);
    await settle();

    expect(invoke("view", task.id).queueState.paused).toBe(true);
    expect(app.hasRequest("补充乙")).toBe(false);
    await waitFor(() => expect(app.queueTexts(task.id)).toEqual(["补充乙"]));
    expect(app.goalOf(task.id)?.status).toBe("paused");
  }, 15_000);
});

describe("恢复（tasks:goal-resume）：从暂停点续跑", () => {
  it("已暂停的目标转回进行中，以内部输入从暂停点续跑；累计时长不重置；回合结束照常判定，通过 → 已完成", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("resume-basic");
    const round = await startGoal(app, task.id);
    const paused = await pauseGoal(app, task.id, round);

    const resumed = await invoke("goalResume", task.id);

    expect(resumed).toMatchObject({
      id: paused.id,
      status: "active",
      text: GOAL,
    });
    // 累计账目连续：暂停前已闭合的时长原样保留，新的进行中段从此刻另起
    expect(resumed.activeMs).toBe(paused.activeMs);
    expect(resumed.activeSince).not.toBeNull();
    // 续跑指令：从暂停点继续、复述目标原文；不产生用户气泡
    const continuation = await holdContinuation(app);
    expect(continuation.lastUserText).toContain("目标此前被暂停，现已恢复");
    expect(continuation.lastUserText).toContain(GOAL);
    expect(app.userTexts(task.id)).toEqual(["建立任务-resume-basic", GOAL]);
    // 状态快照已下发；循环重新存活（任务呈现为执行中）
    expect(app.goalEvents(task.id).at(-1)?.event).toMatchObject({
      type: "goal-changed",
      goal: { status: "active" },
    });
    expect(invoke("execution", task.id).running).toBe(true);

    // 恢复后的那一轮结束即回到常态：idle 边界判定 → 通过 → 已完成
    continuation.write("续跑轮收尾");
    continuation.finish();
    (await app.nextVerdict()).respond(PASSED);
    await app.idle(task.id);
    expect(app.goalOf(task.id)).toMatchObject({ status: "completed" });
    expect(app.verificationsOf(task.id).map((record) => record.round)).toEqual([
      1,
    ]);
    expect(invoke("execution", task.id).running).toBe(false);
  }, 15_000);

  it.each(["paused", "budget-limited", "unmet"] as const)(
    "从「%s」恢复：同样转回进行中并从暂停点续跑，连续计数从 0 起算",
    async (status) => {
      const app = await setupGoalApp();
      const task = await app.newTask(`resume-${status}`);
      const round = await startGoal(app, task.id);
      await pauseGoal(app, task.id, round);
      // 把目标推进到指定的可恢复态（经 agent-core 的公共转换入口；循环此刻不在进行）
      if (status !== "paused") {
        app.manager.transitionGoal(task.id, "resume");
        app.manager.transitionGoal(
          task.id,
          status === "unmet" ? "unmet" : "budget-limit"
        );
      }
      expect(app.goalOf(task.id)?.status).toBe(status);

      const resumed = await invoke("goalResume", task.id);

      expect(resumed).toMatchObject({
        status: "active",
        idleStreak: 0,
        failureStreak: 0,
      });
      const continuation = await passContinuation(app, task.id);
      expect(continuation.lastUserText).toContain(GOAL);
      expect(app.goalOf(task.id)?.status).toBe("completed");
    },
    15_000
  );

  it("任务有在途回合时不能恢复：以明确原因拒绝、目标保持已暂停；回合结束后可恢复", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("resume-busy");
    const round = await startGoal(app, task.id);
    await invoke("send", task.id, "补充一句", app.profile.id);
    round.write("首轮回复");
    expect(invoke("interrupt", task.id)).toBe(true);
    // 排队消息的普通回合在途
    const queued = await app.hold("补充一句");

    await expect(invoke("goalResume", task.id)).rejects.toThrow(
      "任务正在执行，请等回复结束后再恢复目标"
    );
    expect(app.goalOf(task.id)?.status).toBe("paused");
    expect(app.hasRequestWhere(isContinuation)).toBe(false);
    expect(invoke("execution", task.id).executionId).not.toBeNull();

    queued.write("补充一句的处理结果");
    queued.finish();
    await app.idle(task.id);
    await invoke("goalResume", task.id);
    await passContinuation(app, task.id);
    expect(app.goalOf(task.id)?.status).toBe("completed");
  }, 15_000);

  it("任务正在等待审批或问答时不能恢复：以明确原因拒绝，目标保持已暂停", async () => {
    const executed: string[] = [];
    const app = await setupGoalApp({ tools: tools(executed) });
    const task = await app.newTask("resume-waiting");
    const round = await startGoal(app, task.id);
    await invoke("send", task.id, "调用写入工具", app.profile.id);
    round.write("首轮回复");
    expect(invoke("interrupt", task.id)).toBe(true);
    // 排队消息的普通回合发起了需要审批的工具调用：任务等待用户
    const queued = await app.hold("调用写入工具");
    queued.toolCall("note", { text: "一条笔记" });
    await waitFor(() =>
      expect(invoke("pendingApprovals", task.id).length).toBe(1)
    );

    await expect(invoke("goalResume", task.id)).rejects.toThrow(
      "任务正在等待审批或问答，请先回应后再恢复目标"
    );
    expect(app.goalOf(task.id)?.status).toBe("paused");

    // 回应后回合继续并正常收尾；任务空闲后可以恢复
    invoke(
      "respondApproval",
      task.id,
      invoke("pendingApprovals", task.id)[0].id,
      "approve"
    );
    const resumedTurn = await app.hold("调用写入工具");
    expect(executed).toEqual(["一条笔记"]);
    resumedTurn.write("笔记已记下");
    resumedTurn.finish();
    await app.idle(task.id);
    await invoke("goalResume", task.id);
    await passContinuation(app, task.id);
    expect(app.goalOf(task.id)?.status).toBe("completed");
  }, 15_000);

  it("不可恢复的情形以中文原因拒绝且不留副作用：已完成、无目标、参数不合法、任务已归档", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("resume-reject");
    const round = await startGoal(app, task.id);
    round.write("首轮回复");
    round.finish();
    (await app.nextVerdict()).respond(PASSED);
    await app.idle(task.id);
    const plain = await app.newTask("resume-reject-plain");
    const archived = await app.newTask("resume-reject-archived");
    await pauseGoal(app, archived.id, await startGoal(app, archived.id));
    await invoke("archive", archived.id, true);
    const eventsBefore = app.goalEvents(task.id).length;
    const requestsBefore = app.requestCount();

    await expect(invoke("goalResume", task.id)).rejects.toThrow(
      "目标已完成，不能恢复"
    );
    await expect(invoke("goalResume", plain.id)).rejects.toThrow(
      "任务尚未设定目标"
    );
    await expect(invoke("goalResume", 42)).rejects.toThrow("参数不合法");
    await expect(invoke("goalResume", archived.id)).rejects.toThrow(
      "任务已归档"
    );
    expect(app.goalEvents(task.id).length).toBe(eventsBefore);
    expect(invoke("execution", task.id).running).toBe(false);
    expect(app.goalOf(archived.id)?.status).toBe("paused");
    // 自始至终没有为「恢复」发出任何模型请求
    expect(app.requestCount()).toBe(requestsBefore);
  }, 20_000);

  it("恢复时下一轮没能发起（任务所用模型已删除）：目标回到已暂停，原因对用户可见并抛回调用方", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = await setupGoalApp();
    const task = await app.newTask("resume-start-fail");
    const round = await startGoal(app, task.id);
    await pauseGoal(app, task.id, round);
    await app.removeProfile();

    await expect(invoke("goalResume", task.id)).rejects.toThrow(
      "无法发起下一轮：所选 Provider Profile 不存在，请重新选择模型"
    );

    // 不留「进行中却没有回合」；暂停原因随快照下发（进度行的暂停原因）
    expect(app.goalOf(task.id)?.status).toBe("paused");
    expect(invoke("execution", task.id).running).toBe(false);
    expect(app.goalEvents(task.id).at(-1)?.event).toMatchObject({
      type: "goal-changed",
      goal: { status: "paused" },
      pauseReason:
        "无法发起下一轮：所选 Provider Profile 不存在，请重新选择模型",
    });
    expect(app.hasRequestWhere(isContinuation)).toBe(false);
    expect(app.messageRoles(task.id)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  }, 15_000);
});

describe("编辑（tasks:goal-edit）：修改目标文本", () => {
  it("已暂停时编辑：同一条目标记录的文本原地更新并下发快照，验证记录保留；恢复后的续跑指令与下一次判定按新文本", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("edit-paused");
    const paused = await pausedWithHistory(app, task.id);
    expect(app.verificationsOf(task.id)).toHaveLength(1);
    const eventsBefore = app.goalEvents(task.id).length;

    const edited = await invoke(
      "goalEdit",
      task.id,
      "  修订后的目标：示例与集成测试全部通过  "
    );

    // 同一条目标记录（id 不变），只有文本变了；完整快照下发
    expect(edited).toEqual({
      ...paused,
      text: "修订后的目标：示例与集成测试全部通过",
    });
    expect(app.goalOf(task.id)).toEqual(edited);
    expect(
      app
        .goalEvents(task.id)
        .slice(eventsBefore)
        .map((item) => item.event)
    ).toEqual([{ type: "goal-changed", goal: edited }]);
    // 编辑前那一轮的验证记录仍挂在同一条目标下；目标仍已暂停、任务空闲
    expect(
      app
        .verificationsOf(task.id)
        .map((record) => [record.round, record.goalId])
    ).toEqual([[1, paused.id]]);
    expect(invoke("execution", task.id).running).toBe(false);

    // 恢复：续跑指令复述新文本；下一次判定的输入以新文本为目标
    await invoke("goalResume", task.id);
    const continuation = await holdContinuation(app);
    expect(continuation.lastUserText).toContain(
      "【目标】修订后的目标：示例与集成测试全部通过"
    );
    expect(continuation.lastUserText).not.toContain(GOAL);
    continuation.write("续跑轮收尾");
    continuation.finish();
    const verdict = await app.nextVerdict();
    const prompt = String(
      (verdict.body.messages as { role: string; content: unknown }[]).find(
        (message) => message.role === "user"
      )?.content
    );
    expect(prompt).toContain(
      "【目标】\n\n修订后的目标：示例与集成测试全部通过"
    );
    verdict.respond(PASSED);
    await app.idle(task.id);
    expect(app.goalOf(task.id)).toMatchObject({
      id: paused.id,
      status: "completed",
      text: "修订后的目标：示例与集成测试全部通过",
    });
    expect(
      app
        .verificationsOf(task.id)
        .map((record) => [record.round, record.goalId])
    ).toEqual([
      [1, paused.id],
      [2, paused.id],
    ]);
  }, 15_000);

  it("进行中不能编辑：提示先暂停目标；文本不变、不下发快照", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("edit-active");
    await startGoal(app, task.id);
    const eventsBefore = app.goalEvents(task.id).length;

    await expect(invoke("goalEdit", task.id, "改过的目标")).rejects.toThrow(
      "目标进行中，不能编辑：请先暂停目标"
    );

    expect(app.goalOf(task.id)?.text).toBe(GOAL);
    expect(app.goalEvents(task.id).length).toBe(eventsBefore);
  }, 15_000);

  it("不可编辑与无效输入以中文原因拒绝且原文不变：已完成、已归档、无目标、空文本、超长、参数类型", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("edit-reject");
    const round = await startGoal(app, task.id);
    round.write("首轮回复");
    round.finish();
    (await app.nextVerdict()).respond(PASSED);
    await app.idle(task.id);
    const plain = await app.newTask("edit-reject-plain");
    const archived = await app.newTask("edit-reject-archived");
    await pauseGoal(app, archived.id, await startGoal(app, archived.id));
    await invoke("archive", archived.id, true);
    const editable = await app.newTask("edit-reject-blank");
    await pauseGoal(app, editable.id, await startGoal(app, editable.id));

    await expect(invoke("goalEdit", task.id, "改过的目标")).rejects.toThrow(
      "目标已完成，不能编辑"
    );
    expect(app.goalOf(task.id)?.text).toBe(GOAL);
    await expect(invoke("goalEdit", archived.id, "改过的目标")).rejects.toThrow(
      "任务已归档"
    );
    expect(app.goalOf(archived.id)?.text).toBe(GOAL);
    await expect(invoke("goalEdit", plain.id, "新目标")).rejects.toThrow(
      "任务尚未设定目标"
    );
    await expect(invoke("goalEdit", editable.id, " \n ")).rejects.toThrow(
      "目标不能为空"
    );
    await expect(
      invoke("goalEdit", editable.id, "长".repeat(GOAL_TEXT_MAX_LENGTH + 1))
    ).rejects.toThrow("目标文本过长");
    await expect(invoke("goalEdit", editable.id, 42)).rejects.toThrow(
      "参数不合法"
    );
    expect(app.goalOf(editable.id)?.text).toBe(GOAL);
  }, 25_000);
});

describe("清除（tasks:goal-clear）：目标退场，任务回到普通对话", () => {
  it("已暂停时清除：目标转「已清除」并下发快照（进度行退场），任务回空闲、验证记录仍随任务可查，可重新设定目标", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("clear-paused");
    const paused = await pausedWithHistory(app, task.id);

    const cleared = await invoke("goalClear", task.id);

    expect(cleared).toEqual({
      ...paused,
      status: "cleared",
      updatedAt: expect.any(String),
    });
    expect(app.goalOf(task.id)).toEqual(cleared);
    expect(app.goalEvents(task.id).at(-1)?.event).toEqual({
      type: "goal-changed",
      goal: cleared,
    });
    expect(invoke("execution", task.id).running).toBe(false);
    // 历史验证记录随任务留痕（仍归属被清除的那条目标）
    expect(
      app
        .verificationsOf(task.id)
        .map((record) => [record.round, record.goalId])
    ).toEqual([[1, paused.id]]);

    // 回到普通对话：普通消息不触发完成判定，目标保持已清除
    void invoke("send", task.id, "清除后的普通消息", app.profile.id);
    await app.reply("清除后的普通消息");
    await app.idle(task.id);
    expect(app.pendingVerdicts()).toBe(0);
    expect(app.goalOf(task.id)?.status).toBe("cleared");
    expect(
      app
        .verificationsOf(task.id)
        .map((record) => [record.round, record.goalId])
    ).toEqual([[1, paused.id]]);

    // 未结束目标的名额让出：可以重新设定目标（新的一条目标记录）
    const next = await invoke("goal-set", task.id, "第二个目标", {
      providerProfileId: app.profile.id,
    });
    expect(next).toMatchObject({ status: "active", text: "第二个目标" });
    expect(next.id).not.toBe(paused.id);
    await app.reply("第二个目标");
    (await app.nextVerdict()).respond(PASSED);
    await app.idle(task.id);
  }, 15_000);

  it("进行中清除（回合在途）：在途回合立即中断，不判定不续跑；任务回空闲，排队消息自动发出", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("clear-active-turn");
    const round = await startGoal(app, task.id);
    await invoke("send", task.id, "补充一句", app.profile.id);
    round.write("写到一半");

    expect((await invoke("goalClear", task.id)).status).toBe("cleared");

    await answer(app, "补充一句");
    await app.idle(task.id);
    // 在途回合被中断（与 Stop 同一路径）：那条助手消息是中断态；之后的回合照常
    expect(
      app.manager
        .messages(task.id)
        .filter((message) => message.role === "assistant")
        .map((message) => message.aborted === true)
    ).toEqual([false, true, false]);
    expect(app.verificationsOf(task.id)).toEqual([]);
    expect(app.pendingVerdicts()).toBe(0);
    expect(invoke("execution", task.id).running).toBe(false);
    expect(invoke("view", task.id).queueState).toMatchObject({
      paused: false,
      queue: [],
    });
    expect(app.userTexts(task.id)).toEqual([
      "建立任务-clear-active-turn",
      GOAL,
      "补充一句",
    ]);
    expect(app.messageRoles(task.id)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    await settle();
    expect(app.hasRequestWhere(isContinuation)).toBe(false);
    expect(app.goalOf(task.id)?.status).toBe("cleared");
  }, 15_000);

  it("进行中清除（判定在途）：判定被中断不留结论，目标已清除、不续跑", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("clear-active-verifying");
    const round = await startGoal(app, task.id);
    round.write("首轮回复");
    round.finish();
    await app.nextVerdict();

    expect((await invoke("goalClear", task.id)).status).toBe("cleared");
    await app.idle(task.id);

    expect(app.goalOf(task.id)?.status).toBe("cleared");
    expect(app.verificationsOf(task.id)).toEqual([]);
    expect(app.pendingVerdicts()).toBe(0);
    expect(app.hasRequestWhere(isContinuation)).toBe(false);
    expect(app.goalEvents(task.id).at(-1)?.event).toMatchObject({
      type: "goal-changed",
      goal: { status: "cleared" },
    });
    expect(invoke("execution", task.id).running).toBe(false);
  }, 15_000);

  it("进行中清除（轮间窗口）：待发起的续跑轮作废，循环结束让出并发名额，排队消息自动发出", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("clear-between");
    const round = await startGoal(app, task.id);
    await invoke("send", task.id, "补充一句", app.profile.id);
    round.write("首轮回复");
    round.finish();
    const verdict = await app.nextVerdict();
    const gate = app.armProfileGate();
    verdict.respond(FAILED);
    await gate.reached;
    expect(invoke("execution", task.id).running).toBe(true);

    expect((await invoke("goalClear", task.id)).status).toBe("cleared");
    // 循环随即结束：此刻没有在途执行登记，任务不再呈现为执行中
    expect(invoke("execution", task.id).running).toBe(false);
    gate.release();
    await settle(400);

    expect(app.hasRequestWhere(isContinuation)).toBe(false);
    // 第 1 轮已落库的结论保留；排队消息作为普通回合自动发出，不再判定
    expect(app.verificationsOf(task.id)).toHaveLength(1);
    await answer(app, "补充一句");
    await app.idle(task.id);
    expect(app.userTexts(task.id)).toEqual([
      "建立任务-clear-between",
      GOAL,
      "补充一句",
    ]);
    expect(app.pendingVerdicts()).toBe(0);
    expect(app.goalOf(task.id)?.status).toBe("cleared");
  }, 15_000);

  it("恢复的下一轮还在发起途中时清除：循环立即结束，并发名额随即让出（不等那一轮发起落定）", async () => {
    const app = await setupGoalApp({ concurrencyLimit: () => 1 });
    const task = await app.newTask("clear-resume-window");
    const round = await startGoal(app, task.id);
    await pauseGoal(app, task.id, round);
    const other = await app.newTask("clear-resume-window-other");

    // 恢复的下一轮卡在读发送参数上：循环已存活，占着唯一的并发席
    const gate = app.armProfileGate();
    const resuming = invoke("goalResume", task.id);
    await gate.reached;
    expect(invoke("execution", task.id).running).toBe(true);
    // 另一个任务的首条发送因满员进入任务排队，等任务排队开跑
    await invoke("send", other.id, "另一个任务的消息", app.profile.id);
    expect(
      invoke("list").find((item: any) => item.id === other.id).activity
    ).toMatchObject({ running: false, queued: true });
    expect(app.hasRequest("另一个任务的消息")).toBe(false);

    expect((await invoke("goalClear", task.id)).status).toBe("cleared");

    // 此刻没有在途执行登记可中断，也没有待落定的回合收尾：另一个任务随即开跑
    // 只能靠清除自己补的唤醒
    const otherRound = await app.hold("另一个任务的消息");
    otherRound.write("另一个任务的处理结果");
    otherRound.finish();
    gate.release();
    // 恢复的调用落定：那一轮没有发起，目标保持已清除
    expect((await resuming).status).toBe("cleared");
    expect(app.hasRequestWhere(isContinuation)).toBe(false);
    await waitFor(() =>
      expect(
        invoke("list").every((item: any) => item.activity?.running !== true)
      ).toBe(true)
    );
  }, 15_000);

  it("已暂停时清除，而普通回合正在运行：不打断这个回合（它不属于目标循环），回合照常结束", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("clear-paused-running");
    const round = await startGoal(app, task.id);
    await invoke("send", task.id, "补充一句", app.profile.id);
    round.write("首轮回复");
    expect(invoke("interrupt", task.id)).toBe(true);
    const queued = await app.hold("补充一句");

    expect((await invoke("goalClear", task.id)).status).toBe("cleared");

    // 回合没有被中断：执行登记仍在，照常写入并正常收尾
    expect(invoke("execution", task.id).executionId).not.toBeNull();
    queued.write("补充一句的处理结果");
    queued.finish();
    await app.idle(task.id);
    expect(app.manager.messages(task.id).at(-1)).toMatchObject({
      role: "assistant",
      content: "补充一句的处理结果",
    });
    expect(app.manager.messages(task.id).at(-1)?.aborted).not.toBe(true);
    expect(app.goalOf(task.id)?.status).toBe("cleared");
    expect(app.pendingVerdicts()).toBe(0);
  }, 15_000);

  it("已完成的目标可清除；已清除后不可恢复、重复清除被状态机拒绝；无目标 / 已归档 / 参数不合法以中文原因拒绝", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("clear-reject");
    const round = await startGoal(app, task.id);
    round.write("首轮回复");
    round.finish();
    (await app.nextVerdict()).respond(PASSED);
    await app.idle(task.id);
    expect(app.goalOf(task.id)?.status).toBe("completed");
    const plain = await app.newTask("clear-reject-plain");
    const archived = await app.newTask("clear-reject-archived");
    await pauseGoal(app, archived.id, await startGoal(app, archived.id));
    await invoke("archive", archived.id, true);

    expect((await invoke("goalClear", task.id)).status).toBe("cleared");
    expect(app.verificationsOf(task.id)).toHaveLength(1);
    await expect(invoke("goalResume", task.id)).rejects.toThrow(
      "目标已清除，不能恢复"
    );
    await expect(invoke("goalEdit", task.id, "改过的目标")).rejects.toThrow(
      "目标已清除，不能编辑"
    );
    await expect(invoke("goalClear", task.id)).rejects.toThrow(
      "目标已清除，不能清除"
    );
    await expect(invoke("goalClear", plain.id)).rejects.toThrow(
      "任务尚未设定目标"
    );
    await expect(invoke("goalClear", archived.id)).rejects.toThrow(
      "任务已归档"
    );
    expect(app.goalOf(archived.id)?.status).toBe("paused");
    await expect(invoke("goalClear", 42)).rejects.toThrow("参数不合法");
  }, 20_000);
});

describe("/compact 与目标状态（ADR 0035：完成判定依赖完整历史）", () => {
  /** 断言一次 /compact 被拒且没有发出任何模型请求 */
  async function expectCompactRejected(app: GoalApp, taskId: string) {
    const before = app.requestCount();
    await expect(invoke("compact", taskId, app.profile.id)).rejects.toThrow(
      "目标进行中，请先暂停目标再压缩历史"
    );
    expect(app.requestCount()).toBe(before);
    // 被拒的压缩不留执行登记：目标循环照旧
    expect(app.goalOf(taskId)?.status).toBe("active");
  }

  it("目标进行中（回合在途 / 判定在途 / 轮间窗口）不能压缩历史：以「请先暂停目标」拒绝，不发压缩请求", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("compact-active");
    const round = await startGoal(app, task.id);

    // 回合在途
    await expectCompactRejected(app, task.id);
    // 判定在途
    round.write("首轮回复");
    round.finish();
    const verdict = await app.nextVerdict();
    await expectCompactRejected(app, task.id);
    // 轮间窗口
    const gate = app.armProfileGate();
    verdict.respond(FAILED);
    await gate.reached;
    await expectCompactRejected(app, task.id);
    gate.release();

    // 循环没有被这些拒绝打断：续跑轮照常发起
    const continuation = await holdContinuation(app);
    continuation.write("续跑轮收尾");
    continuation.finish();
    (await app.nextVerdict()).respond(PASSED);
    await app.idle(task.id);
    expect(app.goalOf(task.id)?.status).toBe("completed");
  }, 15_000);

  it("目标已暂停时 /compact 照常可用：压缩请求照常发出并成功；压缩后恢复目标，续跑与判定照常", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("compact-paused");
    // 攒够可压缩的历史（/compact 保留最近 3 轮）：再聊三个普通回合
    for (const text of ["第二问", "第三问", "第四问"]) {
      void invoke("send", task.id, text, app.profile.id);
      await answer(app, text);
      await app.idle(task.id);
    }
    const round = await startGoal(app, task.id);
    await pauseGoal(app, task.id, round);

    const compacting = invoke("compact", task.id, app.profile.id);
    const compactRequest = await app.holdWhere(
      (_text, body) => body.stream !== true
    );
    // 压缩请求不带工具、不是判定请求；目标原文所在的早期轮次在被压缩的历史里
    expect(compactRequest.body.tools).toBeUndefined();
    expect(JSON.stringify(compactRequest.body)).not.toContain(
      "[goal-verification]"
    );
    compactRequest.json("此前对话的摘要");
    expect(await compacting).toMatchObject({
      compactedMessages: expect.any(Number),
    });
    expect(invoke("execution", task.id).running).toBe(false);
    expect(app.goalOf(task.id)?.status).toBe("paused");

    // 压缩后恢复目标：续跑照常发起（续跑指令复述目标原文，不依赖被压缩的轮次），
    // 判定读压缩后的历史
    await invoke("goalResume", task.id);
    const continuation = await holdContinuation(app);
    expect(continuation.lastUserText).toContain(GOAL);
    continuation.write("续跑轮收尾");
    continuation.finish();
    const verdict = await app.nextVerdict();
    expect(JSON.stringify(verdict.body)).toContain("此前对话的摘要");
    verdict.respond(PASSED);
    await app.idle(task.id);
    expect(app.goalOf(task.id)?.status).toBe("completed");
  }, 20_000);

  it("目标已完成（终态）后 /compact 照常可用", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("compact-completed");
    const round = await startGoal(app, task.id);
    round.write("首轮回复");
    round.finish();
    (await app.nextVerdict()).respond(PASSED);
    await app.idle(task.id);
    expect(app.goalOf(task.id)?.status).toBe("completed");

    // 历史不足时以 /compact 自己的原因拒绝（不是目标的原因），即已进入常规压缩流程
    await expect(invoke("compact", task.id, app.profile.id)).rejects.toThrow(
      "没有可压缩的内容"
    );
  }, 15_000);

  it("非目标任务的 /compact 文案不变：普通回合执行中被拒时仍是通用的「任务正在执行」", async () => {
    const app = await setupGoalApp();
    const task = await app.newTask("compact-plain");
    void invoke("send", task.id, "进行中的消息", app.profile.id);
    await app.hold("进行中的消息");

    await expect(invoke("compact", task.id, app.profile.id)).rejects.toThrow(
      "任务正在执行或等待用户回应，请先停止再整理"
    );
  }, 15_000);
});
