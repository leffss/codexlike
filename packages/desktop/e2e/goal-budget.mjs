// E2E（goal-mode 票 05，ADR 0035「护栏」）：token 预算——目标用量达到预算 →
// 「预算受限」（非终止，可加预算后恢复）。
// 场景脚本（stub 两条线；provider 级 usage：每次应答 100 输入 + 50 输出）：
//   工作轮：① 建任务 ② 目标首轮（慢速流，期间经进度行设定预算）③ 续跑轮 ④ 阻断后排队消息的消费
//   判定轮：①② 未过
// 断言只经真实界面、公开 IPC 与外部请求：
// 1) 进度行有预算入口；经预算控件设定预算（输入 → 保存）→ 落库并显示「用量 / 预算」；
// 2) 第 1 轮后未到预算，照常续跑；第 2 轮越线：回合与判定照常完成，之后才转
//    「预算受限」——状态、原因、用量的警示显示、「加预算」入口；
// 3) 不再续跑（没有第 3 轮请求）；输入队列恢复自动发出；任务回到空闲；
// 4) 「预算受限」态直接加预算（一键 +10 万）：落库、显示更新，停留状态不变
//    （恢复经控制面，票 04）；
// 5) 重启后「预算受限」原样保持，预算与用量可读。
// 运行：pnpm test:e2e:goal-budget（先 pnpm build）。
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

const GOAL_TEXT = "让示例测试全部通过";
const WORK_SENTINEL = "工作轮脚本越界哨兵";
const VERDICT_SENTINEL = "判定线越界哨兵";
const CONTINUATION_ANCHOR = "【目标续跑】";

/** 每次模型应答上报 150 tokens（工作轮与判定都一样）：账目可手算 */
const USAGE = { promptTokens: 100, completionTokens: 50 };
/** 预算 500：目标内第 1 轮（工作 150 + 判定 150 = 300）未到，第 2 轮后 600 达到 */
const BUDGET = 500;
/** 一键加预算的第一档（+10 万） */
const QUICK_ADD = 100_000;

const UNPASSED = (round) => ({
  passed: false,
  reason: `尚有步骤未完成（第 ${round} 轮）`,
  nextAction: `继续第 ${round + 1} 步`,
});

const MARKER_1 = "第 1 次迭代 · 未完成 · 下一步：继续第 2 步";
const MARKER_2 = "第 2 次迭代 · 未完成 · 下一步：继续第 3 步";

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
  return `工作轮:${text.slice(0, 3)}`;
}

const markerTexts = (window) =>
  window.getByTestId("goal-verification-marker").allTextContents();
const progressStatus = (window) =>
  window.getByTestId("goal-progress-status").textContent();
const budgetText = (window) =>
  window.getByTestId("goal-budget-trigger").textContent();
const same = (actual, expected) =>
  JSON.stringify(actual) === JSON.stringify(expected);

/** 等预算控件的显示文本变成指定值（用量随任务列表刷新，略晚于状态快照） */
async function waitBudgetText(window, expected) {
  await window
    .getByTestId("goal-budget-trigger")
    .filter({ hasText: expected })
    .waitFor({ timeout: 15_000 });
}

async function waitAssistantText(window, text) {
  await window
    .getByTestId("message-assistant")
    .getByText(text, { exact: true })
    .waitFor({ timeout: 30_000 });
}

/** 侧栏首个任务是否显示「运行中」（没有徽章 = 空闲且已查看，不算运行中） */
async function sidebarShowsRunning(window) {
  const badge = window.getByTestId("task-activity").first();
  if ((await badge.count()) === 0) return false;
  return (await badge.textContent())?.includes("运行中") === true;
}

/** 公开 IPC 可读的目标与任务用量账目 */
async function readGoalState(window) {
  return window.evaluate(async () => {
    const task = (await window.codexlike.tasks.list())[0];
    const view = await window.codexlike.tasks.view(task.id);
    return {
      goal: view.goal,
      taskStatus: task.status,
      usage: {
        mainInputTokens: task.mainInputTokens,
        mainOutputTokens: task.mainOutputTokens,
        subagentInputTokens: task.subagentInputTokens,
        subagentOutputTokens: task.subagentOutputTokens,
      },
      verifications: (await window.codexlike.tasks.messages(task.id))
        .filter((item) => item.kind === "goal-verification")
        .map((item) => ({
          round: item.verification.round,
          outcome: item.verification.outcome,
        })),
    };
  });
}

async function main() {
  const { server, port, seenBodies, requestCount } =
    await startGoalMockProvider({
      usage: USAGE,
      work(ctx, { body, index }) {
        if (index === 1) return ctx.textRound("任务已建立");
        if (index === 2)
          // 首轮慢速流（15 秒）：期间经进度行的预算控件设定预算
          return ctx.textChunksRound(
            Array.from({ length: 60 }, (_, i) => `首轮第${i}段。`),
            250
          );
        const isContinuation = (lastUserText(body) ?? "").includes(
          CONTINUATION_ANCHOR
        );
        if (index === 3 && isContinuation) return ctx.textRound("续跑轮的回复");
        if (index === 4) return ctx.textRound("甲的处理结果");
        return ctx.textRound(WORK_SENTINEL);
      },
      // 判定脚本（index 只数判定请求）：两次未过（第 2 次挂起 1.5 秒，留出
      // 「第 1 轮后目标仍在进行」的确定性观察窗口）；其余哨兵——阻断后不该再有判定
      verdict(ctx, { index }) {
        if (index === 1) return ctx.verdictRound(UNPASSED(index), "raw");
        if (index === 2) {
          setTimeout(() => ctx.verdictRound(UNPASSED(index), "raw"), 1500);
          return;
        }
        return ctx.verdictRound(
          { passed: false, reason: VERDICT_SENTINEL, nextAction: "无" },
          "raw"
        );
      },
    });
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-goal-budget-"));
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

    // ---- 1) /goal 设定；首轮进行中经进度行的预算控件设定预算 ----
    await composer.fill(`/goal ${GOAL_TEXT}`);
    await composer.press("Enter");
    await waitAssistantText(window, "首轮第0段。");
    await row.waitFor({ timeout: 10_000 });
    const budgetTrigger = window.getByTestId("goal-budget-trigger");
    await budgetTrigger.waitFor({ timeout: 10_000 });
    assert(
      (await budgetText(window)) === "预算 不限",
      `未设预算时进度行应显示「预算 不限」入口（实际 ${await budgetText(window)}）`
    );
    await composer.fill("补充甲");
    await composer.press("Enter");
    await window.getByTestId("queue-count").getByText("待发 1 条").waitFor({
      timeout: 10_000,
    });

    await budgetTrigger.click();
    const budgetInput = window.getByTestId("goal-budget-input");
    await budgetInput.waitFor({ timeout: 5_000 });
    await budgetInput.fill(String(BUDGET));
    await window.getByTestId("goal-budget-save").click();
    // 保存后浮层收起；宿主快照到达，入口显示「用量 / 预算」（首轮的用量在其流式
    // 结束时才入账，此刻是 0 或 150，都未到预算）
    await window
      .getByTestId("goal-budget-editor")
      .waitFor({ state: "detached", timeout: 10_000 });
    await budgetTrigger
      .filter({ hasText: /^用量 \d[\d,]* \/ 500$/ })
      .waitFor({ timeout: 10_000 });
    assert(
      (await window
        .getByTestId("goal-budget-trigger")
        .getAttribute("data-over")) === null,
      "用量未到预算时不应标警示"
    );
    console.log(
      `[e2e] 进度行设定预算：入口由「预算 不限」变为「${await budgetText(window)}」`
    );

    // ---- 2) 第 1 轮后未到预算：照常续跑（第 2 次判定挂起期间的「验证中」窗口） ----
    await waitAssistantText(window, "续跑轮的回复");
    await window
      .locator('[data-testid="goal-verifying-marker"][data-goal-round="2"]')
      .waitFor({ timeout: 15_000 });
    assert(
      (await row.getAttribute("data-goal-status")) === "active",
      "第 1 轮后（目标用量 300 < 500）目标应仍在进行"
    );
    assert(
      (await progressStatus(window)) === "验证中",
      `第 2 次判定在途时进度行应显示「验证中」（实际 ${await progressStatus(window)}）`
    );
    assert(
      same(await markerTexts(window), [MARKER_1]),
      `首行标记应为「${MARKER_1}」（实际 ${JSON.stringify(await markerTexts(window))}）`
    );
    console.log(
      "[e2e] 第 1 轮后目标用量 300 未到预算：照常续跑，第 2 次判定在途显示「验证中」"
    );

    // ---- 3) 第 2 轮越线：回合与判定照常完成，之后转「预算受限」 ----
    await row
      .and(window.locator('[data-goal-status="budget-limited"]'))
      .waitFor({ timeout: 30_000 });
    assert(
      (await progressStatus(window)) === "预算受限",
      `进度行状态应为「预算受限」（实际 ${await progressStatus(window)}）`
    );
    assert(
      (await window.getByTestId("goal-progress-reason").textContent()) ===
        "目标用量已达到 token 预算",
      "预算受限应写明原因"
    );
    assert(
      (await window
        .getByTestId("goal-budget-trigger")
        .getAttribute("data-over")) === "true",
      "用量达到预算应以警示色标出"
    );
    assert(
      (await window.getByTestId("goal-budget-add").textContent()) === "加预算",
      "预算受限态应给出「加预算」入口"
    );
    // 在途回合与判定没有被预算打断：第二轮的回复与两次判定结论完整留痕
    assert(
      same(await markerTexts(window), [MARKER_1, MARKER_2]),
      `两行标记应为「${MARKER_1}」「${MARKER_2}」（实际 ${JSON.stringify(await markerTexts(window))}）`
    );
    console.log(
      "[e2e] 目标用量达到预算 500：回合与判定照常完成后转「预算受限」，原因与用量可见，「加预算」入口就位"
    );

    // ---- 4) 不再续跑；输入队列恢复自动发出；任务回到空闲 ----
    await waitAssistantText(window, "甲的处理结果");
    await window.getByTestId("queue-bar").waitFor({
      state: "detached",
      timeout: 10_000,
    });
    await window.getByTestId("composer-send").waitFor({ timeout: 10_000 });
    assert(
      (await sidebarShowsRunning(window)) === false,
      "预算受限后侧栏不应再显示运行中"
    );
    // 请求时序：建任务 → 首轮 → 判定 → 续跑 → 判定 →（阻断，无第 3 轮）→ 排队消息
    assert(
      same(seenBodies.map(classify), [
        "工作轮:建立任",
        `工作轮:${GOAL_TEXT.slice(0, 3)}`,
        "判定",
        "续跑轮",
        "判定",
        "工作轮:补充甲",
      ]),
      `请求时序不符：${JSON.stringify(seenBodies.map(classify))}`
    );
    assert(
      requestCount() === 6,
      `建任务 + 首轮 + 两次判定 + 一次续跑 + 一条排队消息应恰好 6 个请求（实际 ${requestCount()}）`
    );
    // 用量 = 任务用量账目 − 目标基线：阻断那一刻是 750（5 次应答 × 150）− 150 = 600；
    // 阻断后自动发出的那条排队消息再入账 150，目标用量显示随之到 750
    await waitBudgetText(window, "用量 750 / 500");
    const limited = await readGoalState(window);
    assert(
      limited.goal?.status === "budget-limited" &&
        limited.goal.budgetTokens === BUDGET &&
        limited.goal.baselineTokens === 150,
      `公开 IPC 的目标状态不符：${JSON.stringify(limited.goal)}`
    );
    assert(
      limited.taskStatus === "idle" &&
        same(limited.usage, {
          mainInputTokens: 600,
          mainOutputTokens: 300,
          subagentInputTokens: 0,
          subagentOutputTokens: 0,
        }),
      `任务应回到空闲且用量账目为 6 次应答的累计：${JSON.stringify(limited)}`
    );
    assert(
      same(
        limited.verifications,
        [
          [1, "unpassed"],
          [2, "unpassed"],
        ].map(([round, outcome]) => ({ round, outcome }))
      ),
      `验证记录不符：${JSON.stringify(limited.verifications)}`
    );
    console.log(
      "[e2e] 预算受限后不再续跑（恰好 6 个请求）；输入队列恢复自动发出，任务回到空闲"
    );

    // ---- 5) 「预算受限」态直接加预算：一键 +10 万 ----
    await window.getByTestId("goal-budget-add").click();
    await window.getByTestId("goal-budget-editor").waitFor({ timeout: 5_000 });
    await window
      .getByTestId("goal-budget-quick-add")
      .filter({ hasText: "+10 万" })
      .click();
    await window
      .getByTestId("goal-budget-editor")
      .waitFor({ state: "detached", timeout: 10_000 });
    await waitBudgetText(window, "用量 750 / 100,500");
    // 加预算不自动恢复：停留状态留给用户显式恢复
    assert(
      (await progressStatus(window)) === "预算受限",
      "加预算后目标应保持「预算受限」（恢复是另一个动作）"
    );
    assert(
      (await readGoalState(window)).goal?.budgetTokens === BUDGET + QUICK_ADD,
      "加预算应落库"
    );
    console.log(
      "[e2e] 预算受限态一键加预算：预算 500 → 100,500 已落库并显示，停留状态不变"
    );

    // ---- 6) 两条脚本线都未越界 ----
    for (const sentinel of [WORK_SENTINEL, VERDICT_SENTINEL]) {
      assert(
        (await window.getByText(sentinel, { exact: true }).count()) === 0,
        `不应出现哨兵文本：${sentinel}`
      );
    }

    // ---- 7) 重启后「预算受限」原样保持 ----
    await closeApp(app);
    app = undefined;
    const second = await launchApp({ homeDir });
    app = second.app;
    window = second.window;
    await window.getByTestId("task-item").first().waitFor({ timeout: 15_000 });
    await window.getByTestId("task-item").first().click();
    await window.getByTestId("goal-progress-row").waitFor({ timeout: 10_000 });
    assert(
      (await window
        .getByTestId("goal-progress-row")
        .getAttribute("data-goal-status")) === "budget-limited",
      "重启后目标应保持「预算受限」"
    );
    await waitBudgetText(window, "用量 750 / 100,500");
    assert(
      (await window.getByTestId("goal-progress-reason").textContent()) ===
        "目标用量已达到 token 预算",
      "重启后停留原因仍可见"
    );
    assert(
      same(await markerTexts(window), [MARKER_1, MARKER_2]),
      `重启后两行标记应由落库数据恢复（实际 ${JSON.stringify(await markerTexts(window))}）`
    );
    assert(
      (await sidebarShowsRunning(window)) === false,
      "重启后预算受限的目标不应自行续跑"
    );

    await closeApp(app);
    app = undefined;
    console.log("[e2e] 重启恢复：「预算受限」原样保持，预算与用量可读");
    console.log("[e2e] 目标模式 token 预算护栏场景通过 ✅");
  } catch (error) {
    console.error("[e2e] 目标模式 token 预算护栏场景失败 ❌", error);
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
