// E2E（goal-mode 票 04，ADR 0035）：控制面——暂停 / 恢复 / 编辑 / 清除。
// 场景脚本（stub 两条线，见 goal-stub.mjs；index 各线独立计数，工作轮按请求内容应答）：
//   工作轮：① 建任务 ② 第一个目标首轮（慢速流）③ 排队消息「补充甲」的消费
//          ④ 第一个目标恢复后的续跑轮 ⑤ 第二个目标首轮（慢速流）⑥ 修订后续跑
//          ⑦ 第三个目标首轮（慢速流）⑧ 排队消息「补充乙」的消费；其余哨兵。
//   判定轮：①② 通过（各自的目标文本被断言）；其余哨兵。
// 断言只经真实界面、公开 IPC 与外部请求：
// 1) 六态按钮矩阵：进行中可暂停/清除、无恢复、编辑禁用；已暂停可恢复/编辑/清除、
//    无暂停；已完成后无暂停/恢复、编辑禁用、可清除；
// 2) 目标进行中执行 /compact：专门提示「请先暂停目标」、不发压缩请求、输入保留；
//    其他命令仍是「忙时命令不入队」，可用时机说准为目标暂停或结束后；
// 3) Stop 带排队消息（规格故事 12）：目标转已暂停，排队消息自动发出（不进入队列暂停、
//    不趁停止抢发），作为普通回合运行、不触发判定；随后点「恢复」从暂停点续跑；
// 4) 暂停按钮与 Stop 等效；编辑：取消不改文本，保存后进度行显示新文本，恢复后的
//    续跑指令与判定请求都按新文本；
// 5) 进行中清除：进度行退场、在途回合中断、不判定不续跑、任务回空闲、排队消息自动
//    发出；逐轮验证记录仍随任务可查；重启后进度行不再出现、标记行留痕。
// 运行：pnpm test:e2e:goal-controls（先 pnpm build）。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  assert,
  closeApp,
  createMockProfile,
  launchApp,
  prepareDraft,
} from "./helpers.mjs";
import { startGoalMockProvider } from "./goal-stub.mjs";

const GOAL_1 = "让示例测试全部通过";
const GOAL_2 = "第二个目标：初版文本";
const GOAL_2_EDITED = "第二个目标：修订后的文本";
const GOAL_3 = "第三个目标：将被清除";
const WORK_SENTINEL = "工作轮脚本越界哨兵";
const VERDICT_SENTINEL = "判定线越界哨兵";
const CONTINUATION_ANCHOR = "【目标续跑】";
const PASSED = { passed: true, reason: "示例测试已全部通过", nextAction: "" };
const PASSED_MARKER = "第 1 次迭代 · 已完成";
const ABORTED_HINT = "（已中断，以上为部分回复）";

/** 请求体里最后一条 user 消息的文本（非 JSON / 无 user 消息返回 null） */
function lastUserText(body) {
  try {
    const messages = JSON.parse(body).messages;
    return (
      messages.findLast((message) => message.role === "user")?.content ?? null
    );
  } catch {
    return null;
  }
}

/** 请求分类：判定 / 续跑轮 / 普通工作轮（按最后一条 user 消息） */
function classify(body) {
  if (body.includes("[goal-verification]")) return "判定";
  const text = lastUserText(body) ?? "";
  if (text.includes(CONTINUATION_ANCHOR)) return "续跑轮";
  return `工作轮:${text.slice(0, 6)}`;
}

const chunks = (label, count) =>
  Array.from({ length: count }, (_, i) => `${label}第${i}段。`);
const same = (actual, expected) =>
  JSON.stringify(actual) === JSON.stringify(expected);
const markerTexts = (window) =>
  window.getByTestId("goal-verification-marker").allTextContents();
const progressStatus = (window) =>
  window.getByTestId("goal-progress-status").textContent();
const feedbackText = (window) =>
  window.getByTestId("command-feedback").textContent();

/** 侧栏首个任务是否显示「运行中」（没有徽章 = 空闲且已查看，不算运行中） */
async function sidebarShowsRunning(window) {
  const badge = window.getByTestId("task-activity").first();
  if ((await badge.count()) === 0) return false;
  return (await badge.textContent())?.includes("运行中") === true;
}

/**
 * 进度行按钮组的当前形态：不出现为 null，出现则取可用性（true 可用 / false 禁用）。
 * 读的是真实按钮，六态矩阵在真实界面上逐项核对。
 */
async function controlState(window) {
  const state = {};
  for (const id of ["goal-pause", "goal-resume", "goal-edit", "goal-clear"]) {
    const locator = window.getByTestId(id);
    state[id] =
      (await locator.count()) === 0 ? null : !(await locator.isDisabled());
  }
  return state;
}

const ACTIVE_CONTROLS = {
  "goal-pause": true,
  "goal-resume": null,
  "goal-edit": false,
  "goal-clear": true,
};
const RESUMABLE_CONTROLS = {
  "goal-pause": null,
  "goal-resume": true,
  "goal-edit": true,
  "goal-clear": true,
};
const COMPLETED_CONTROLS = {
  "goal-pause": null,
  "goal-resume": null,
  "goal-edit": false,
  "goal-clear": true,
};

async function waitAssistantText(window, text) {
  await window
    .getByTestId("message-assistant")
    .getByText(text, { exact: true })
    .waitFor({ timeout: 30_000 });
}

/**
 * 某条被中断的回复上的「已中断」提示：限定在那条消息内定位。消息流会把较早的
 * 轮次折叠收起（不在 DOM 里），按全局序号数提示不可靠。
 */
const abortedHintOf = (window, textFragment) =>
  window
    .getByTestId("message-assistant")
    .filter({ hasText: textFragment })
    .getByText(ABORTED_HINT, { exact: true });

/** 等到任务空闲（发送按钮回来、侧栏不显示运行中） */
async function waitIdle(window) {
  await window.getByTestId("composer-send").waitFor({ timeout: 30_000 });
  await window
    .getByTestId("queue-bar")
    .waitFor({ state: "detached", timeout: 10_000 });
}

/** 目标进行中提交一条斜杠命令：走「加入队列」按钮（与 Enter 等效），读回本地命令反馈 */
async function submitCommandWhileBusy(window, text) {
  const composer = window.getByTestId("composer-input");
  await composer.fill(text);
  const enqueue = window.getByTestId("composer-enqueue");
  await enqueue.waitFor({ timeout: 10_000 });
  await enqueue.click();
}

async function main() {
  /** 停止 / 清除是否已被点击：工作轮脚本据此识别排队消息是否抢在目标离开进行中之前发出 */
  let stopClicked = false;
  let clearClicked = false;
  /** 判定请求体（场景末尾断言各自的目标文本） */
  const verdictBodies = [];
  const { server, port, seenBodies, requestCount } =
    await startGoalMockProvider({
      work(ctx, { body }) {
        const text = lastUserText(body) ?? "";
        if (text === "建立任务") return ctx.textRound("任务已建立");
        if (text === GOAL_1)
          return ctx.textChunksRound(chunks("首轮", 40), 250);
        // 互锁哨兵：「补充甲」若在点停止之前到达，说明排队消息抢在目标离开进行中之前
        // 被发出——回哨兵文本，场景末尾的哨兵断言据此失败。
        if (text === "补充甲")
          return ctx.textRound(stopClicked ? "甲的处理结果" : WORK_SENTINEL);
        // 恢复后的续跑轮用慢速流：留出「进行中」的观察窗口（回复太快会直接判定通过）
        if (text.includes(CONTINUATION_ANCHOR) && text.includes(GOAL_1))
          return ctx.textChunksRound(chunks("恢复后续跑", 8), 300);
        if (text === GOAL_2)
          return ctx.textChunksRound(chunks("次轮", 40), 250);
        if (text.includes(CONTINUATION_ANCHOR) && text.includes(GOAL_2_EDITED))
          return ctx.textChunksRound(chunks("修订后续跑", 8), 300);
        if (text === GOAL_3)
          return ctx.textChunksRound(chunks("三轮", 40), 250);
        if (text === "补充乙")
          return ctx.textRound(clearClicked ? "乙的处理结果" : WORK_SENTINEL);
        return ctx.textRound(WORK_SENTINEL);
      },
      verdict(ctx, { body, index }) {
        if (index === 1 || index === 2) {
          verdictBodies.push(body);
          return ctx.verdictRound(PASSED, index === 1 ? "raw" : "code-fence");
        }
        return ctx.verdictRound(
          { passed: false, reason: VERDICT_SENTINEL, nextAction: "无" },
          "raw"
        );
      },
    });
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-goal-ctl-"));
  mkdirSync(join(homeDir, "workspace"));

  let app;
  try {
    const first = await launchApp({ homeDir });
    app = first.app;
    let window = first.window;
    await createMockProfile(window, { name: "Mock", port });
    await prepareDraft(window, { approvalMode: "assist" });
    const composer = window.getByTestId("composer-input");
    const row = window.getByTestId("goal-progress-row");

    // ---- 0) 建任务 ----
    await composer.fill("建立任务");
    await composer.press("Enter");
    await waitAssistantText(window, "任务已建立");
    await window.getByTestId("composer-send").waitFor({ timeout: 10_000 });

    // ---- 1) 第一个目标：进行中的按钮矩阵；目标进行中的斜杠命令口径 ----
    await composer.fill(`/goal ${GOAL_1}`);
    await composer.press("Enter");
    await waitAssistantText(window, "首轮第0段。");
    await row.waitFor({ timeout: 10_000 });
    assert(
      (await row.getAttribute("data-goal-status")) === "active",
      "设定后目标应为「进行中」"
    );
    assert(
      same(await controlState(window), ACTIVE_CONTROLS),
      `进行中的按钮矩阵不符：${JSON.stringify(await controlState(window))}`
    );
    // /compact：专门提示先暂停目标；不发压缩请求；输入保留
    const requestsBeforeCompact = requestCount();
    await submitCommandWhileBusy(window, "/compact");
    await window
      .getByTestId("command-feedback")
      .filter({ hasText: "请先暂停目标" })
      .waitFor({ timeout: 10_000 });
    assert(
      (await feedbackText(window))?.includes("完成判定依赖完整历史") === true,
      `/compact 的提示应说明原因（判定依赖完整历史）（实际 ${await feedbackText(window)}）`
    );
    assert(
      (await composer.inputValue()) === "/compact",
      "/compact 被拒后应保留输入"
    );
    assert(
      requestCount() === requestsBeforeCompact,
      "目标进行中的 /compact 不应发出任何模型请求"
    );
    // 其他斜杠命令：仍是「忙时命令不入队」，可用时机说准为目标暂停或结束后
    await submitCommandWhileBusy(window, "/status");
    await window
      .getByTestId("command-feedback")
      .filter({ hasText: "目标暂停或结束后可用" })
      .waitFor({ timeout: 10_000 });
    assert((await composer.inputValue()) === "/status", "命令被拒后应保留输入");
    await composer.fill("");
    console.log(
      "[e2e] 进行中：可暂停/清除、无恢复、编辑禁用；/compact 提示「请先暂停目标」且不发请求"
    );

    // ---- 2) Stop 带排队消息：目标转已暂停，排队消息自动逐条发出 ----
    await composer.fill("补充甲");
    await composer.press("Enter");
    await window
      .getByTestId("queue-count")
      .getByText("待发 1 条")
      .waitFor({ timeout: 10_000 });
    stopClicked = true;
    await window.getByTestId("composer-stop").click();
    await abortedHintOf(window, "首轮第0段。").waitFor({ timeout: 15_000 });
    await window
      .getByTestId("goal-progress-status")
      .getByText("已暂停", { exact: true })
      .waitFor({ timeout: 15_000 });
    assert(
      (await row.getAttribute("data-goal-status")) === "paused",
      "Stop 后目标应为「已暂停」"
    );
    assert(
      same(await controlState(window), RESUMABLE_CONTROLS),
      `已暂停的按钮矩阵不符：${JSON.stringify(await controlState(window))}`
    );
    // 排队消息自动发出：不进入「队列暂停」（没有恢复/清空队列的操作）
    await waitAssistantText(window, "甲的处理结果");
    await waitIdle(window);
    assert(
      (await window.getByTestId("queue-paused").count()) === 0 &&
        (await window.getByTestId("queue-resume").count()) === 0,
      "目标进行中点 Stop 后输入队列不应进入「队列暂停」"
    );
    assert(
      (await sidebarShowsRunning(window)) === false,
      "排队消息的回合结束后任务应回到空闲"
    );
    assert(
      (await row.getAttribute("data-goal-status")) === "paused",
      "排队消息的回合结束后目标应保持「已暂停」"
    );
    assert(
      verdictBodies.length === 0,
      "排队消息是普通回合：目标已暂停，不应触发完成判定"
    );
    console.log(
      "[e2e] Stop 带排队消息：目标「已暂停」，排队消息自动发出并作为普通回合运行"
    );

    // ---- 3) 恢复：从暂停点续跑；回合结束照常判定，通过 → 已完成 ----
    await window.getByTestId("goal-resume").click();
    // 续跑轮的慢速流进行中：目标已回到「进行中」，按钮矩阵与设定时一致
    await waitAssistantText(window, "恢复后续跑第0段。");
    assert(
      (await row.getAttribute("data-goal-status")) === "active",
      "恢复后目标应回到「进行中」"
    );
    assert(
      (await progressStatus(window)) === "进行中",
      "恢复后进度行状态应为「进行中」"
    );
    assert(
      same(await controlState(window), ACTIVE_CONTROLS),
      `恢复后进行中的按钮矩阵不符：${JSON.stringify(await controlState(window))}`
    );
    await row
      .and(window.locator('[data-goal-status="completed"]'))
      .waitFor({ timeout: 30_000 });
    assert(
      (await progressStatus(window)) === "已完成",
      "恢复后的那一轮判定通过，进度行应为「已完成」"
    );
    assert(
      (await window.getByTestId("goal-progress-round").textContent()) ===
        "第 1 轮",
      "第一个目标完成后进度行应为「第 1 轮」"
    );
    await waitIdle(window);
    assert(
      same(await markerTexts(window), [PASSED_MARKER]),
      `应有一行「${PASSED_MARKER}」标记（实际 ${JSON.stringify(await markerTexts(window))}）`
    );
    assert(
      same(await controlState(window), COMPLETED_CONTROLS),
      `已完成的按钮矩阵不符：${JSON.stringify(await controlState(window))}`
    );
    console.log(
      "[e2e] 恢复：从暂停点续跑 → 判定通过 → 已完成；已完成后无暂停/恢复、编辑禁用、可清除"
    );

    // ---- 4) 暂停按钮（与 Stop 等效）+ 编辑目标 ----
    await composer.fill(`/goal ${GOAL_2}`);
    await composer.press("Enter");
    await waitAssistantText(window, "次轮第0段。");
    assert(
      (await row.getAttribute("data-goal-status")) === "active",
      "已完成后再设定新目标应为「进行中」"
    );
    await window.getByTestId("goal-pause").click();
    await abortedHintOf(window, "次轮第0段。").waitFor({ timeout: 15_000 });
    await window
      .getByTestId("goal-progress-status")
      .getByText("已暂停", { exact: true })
      .waitFor({ timeout: 15_000 });
    // 取消编辑：目标文本不变
    await window.getByTestId("goal-edit").click();
    const editInput = window.getByTestId("goal-edit-input");
    await editInput.waitFor({ timeout: 10_000 });
    assert((await editInput.inputValue()) === GOAL_2, "编辑框应预填目标全文");
    await editInput.fill("不该保存的文本");
    await window.getByTestId("goal-edit-cancel").click();
    await editInput.waitFor({ state: "detached", timeout: 10_000 });
    assert(
      (await window.getByTestId("goal-progress-summary").textContent()) ===
        GOAL_2,
      "取消编辑后目标文本应不变"
    );
    // 保存编辑：进度行显示新文本
    await window.getByTestId("goal-edit").click();
    await editInput.fill(GOAL_2_EDITED);
    await window.getByTestId("goal-edit-save").click();
    await editInput.waitFor({ state: "detached", timeout: 10_000 });
    assert(
      (await window.getByTestId("goal-progress-summary").textContent()) ===
        GOAL_2_EDITED,
      "保存后进度行应显示新的目标文本"
    );
    // 恢复：续跑指令复述新文本；判定请求以新文本为目标
    await window.getByTestId("goal-resume").click();
    await waitAssistantText(window, "修订后续跑第0段。");
    await row
      .and(window.locator('[data-goal-status="completed"]'))
      .waitFor({ timeout: 30_000 });
    await waitIdle(window);
    assert(
      (await window.getByTestId("goal-progress-round").textContent()) ===
        "第 1 轮",
      "第二个目标完成后进度行应为「第 1 轮」（历次目标轮次互不串）"
    );
    assert(
      same(await markerTexts(window), [PASSED_MARKER, PASSED_MARKER]),
      `两个目标各留一行判定标记（实际 ${JSON.stringify(await markerTexts(window))}）`
    );
    console.log(
      "[e2e] 暂停按钮 = Stop；编辑：取消不改文本，保存后按新文本续跑与判定"
    );

    // ---- 5) 进行中清除：进度行退场、在途回合中断、排队消息自动发出 ----
    await composer.fill(`/goal ${GOAL_3}`);
    await composer.press("Enter");
    await waitAssistantText(window, "三轮第0段。");
    await composer.fill("补充乙");
    await composer.press("Enter");
    await window
      .getByTestId("queue-count")
      .getByText("待发 1 条")
      .waitFor({ timeout: 10_000 });
    clearClicked = true;
    await window.getByTestId("goal-clear").click();
    await row.waitFor({ state: "detached", timeout: 15_000 });
    await abortedHintOf(window, "三轮第0段。").waitFor({ timeout: 15_000 });
    await waitAssistantText(window, "乙的处理结果");
    await waitIdle(window);
    assert(
      (await sidebarShowsRunning(window)) === false,
      "清除后任务应回到空闲"
    );
    const requestsAfterClear = requestCount();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert(
      requestCount() === requestsAfterClear,
      "清除后不应续跑、不应判定（不应有新的模型请求）"
    );
    assert(
      verdictBodies.length === 2,
      "被清除的目标没有完成判定（只有前两个目标各一次）"
    );
    assert(
      seenBodies.filter((body) => classify(body) === "续跑轮").length === 2,
      "被清除的目标没有续跑轮"
    );
    assert(
      same(await markerTexts(window), [PASSED_MARKER, PASSED_MARKER]),
      "清除后逐轮验证记录的标记行仍随任务可回看"
    );
    console.log(
      "[e2e] 清除：进度行退场、在途回合中断、不判定不续跑，排队消息自动发出，任务回空闲"
    );

    // ---- 6) 两条脚本线都未越界；请求时序（含两条互锁哨兵） ----
    for (const sentinel of [WORK_SENTINEL, VERDICT_SENTINEL]) {
      assert(
        (await window.getByText(sentinel, { exact: true }).count()) === 0,
        `不应出现哨兵文本：${sentinel}`
      );
    }
    assert(
      same(seenBodies.map(classify), [
        "工作轮:建立任务",
        `工作轮:${GOAL_1.slice(0, 6)}`,
        "工作轮:补充甲",
        "续跑轮",
        "判定",
        `工作轮:${GOAL_2.slice(0, 6)}`,
        "续跑轮",
        "判定",
        `工作轮:${GOAL_3.slice(0, 6)}`,
        "工作轮:补充乙",
      ]),
      `请求时序不符：${JSON.stringify(seenBodies.map(classify))}`
    );
    assert(
      requestCount() === 10,
      `建任务 + 三个目标首轮 + 两次续跑 + 两次判定 + 两条排队应恰好 10 个请求（实际 ${requestCount()}）`
    );
    // 判定请求各自以当时的目标文本为目标
    assert(
      verdictBodies[0]?.includes(GOAL_1) === true &&
        verdictBodies[1]?.includes(GOAL_2_EDITED) === true,
      "两次判定请求应分别带第一个目标与修订后的第二个目标的文本"
    );

    // ---- 7) 公开 IPC 可读：清除后的目标记录、验证记录与任务状态 ----
    const taskId = await window.evaluate(
      async () => (await window.codexlike.tasks.list())[0].id
    );
    const persisted = await window.evaluate(async (id) => {
      const view = await window.codexlike.tasks.view(id);
      const items = await window.codexlike.tasks.messages(id);
      return {
        goal: view.goal,
        verifications: items
          .filter((item) => item.kind === "goal-verification")
          .map((item) => ({
            goalId: item.verification.goalId,
            round: item.verification.round,
            outcome: item.verification.outcome,
          })),
        taskStatus: (await window.codexlike.tasks.list()).find(
          (task) => task.id === id
        ).status,
      };
    }, taskId);
    assert(
      persisted.goal?.status === "cleared" && persisted.goal?.text === GOAL_3,
      "view.goal 应为「已清除」的当前目标（原文保留）"
    );
    assert(
      same(
        persisted.verifications.map((record) => [record.round, record.outcome]),
        [
          [1, "passed"],
          [1, "passed"],
        ]
      ) &&
        persisted.verifications[0]?.goalId !==
          persisted.verifications[1]?.goalId,
      `两个目标各有一条第 1 轮通过的验证记录：${JSON.stringify(persisted.verifications)}`
    );
    assert(persisted.taskStatus === "idle", "清除后任务应回到空闲");
    console.log("[e2e] 落库可读：目标「已清除」，两条验证记录分属两个目标");

    // ---- 8) 重启：进度行不再出现（已清除），标记行由落库数据恢复 ----
    await closeApp(app);
    app = undefined;
    const second = await launchApp({ homeDir });
    app = second.app;
    window = second.window;
    await window.getByTestId("task-item").first().waitFor({ timeout: 15_000 });
    await window.getByTestId("task-item").first().click();
    await window
      .getByTestId("goal-verification-marker")
      .first()
      .waitFor({ timeout: 15_000 });
    assert(
      (await window.getByTestId("goal-progress-row").count()) === 0,
      "重启后已清除的目标不应再出现进度行"
    );
    assert(
      same(await markerTexts(window), [PASSED_MARKER, PASSED_MARKER]),
      `重启后两行标记应由落库数据恢复（实际 ${JSON.stringify(await markerTexts(window))}）`
    );

    await closeApp(app);
    app = undefined;
    console.log("[e2e] 重启恢复：进度行不再出现，标记行留痕可回看");
    console.log("[e2e] 目标模式控制面场景通过 ✅");
  } catch (error) {
    console.error("[e2e] 目标模式控制面场景失败 ❌", error);
    process.exitCode = 1;
    try {
      await closeApp(app);
    } catch {
      // 已关闭
    }
  } finally {
    server.close();
    rmSync(homeDir, { recursive: true, force: true });
  }
}

await main();
