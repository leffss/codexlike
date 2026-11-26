// E2E（goal-mode 票 05，ADR 0035「护栏」）：token 预算——目标用量达到预算 →
// 「预算受限」（非终止，可加预算后恢复）。
// 场景脚本（stub 两条线；provider 级 usage：每次应答 100 输入 + 50 输出）：
//   工作轮：① 建任务 ② 目标首轮（慢速流，期间经进度行设定预算）③ 续跑轮
//           ④ 阻断后排队消息的消费 ⑤ 恢复后的续跑轮（慢速流）⑥ 再一轮续跑
//   判定轮：①②③ 未过（第 2 次挂起，留出观察窗口）④ 通过
// 断言只经真实界面、公开 IPC 与外部请求：
// 1) 进度行有预算入口；经预算控件设定预算（输入 → 保存）→ 落库并显示「用量 / 预算」；
// 2) 第 1 轮后未到预算，照常续跑；第 2 轮越线：回合与判定照常完成，之后才转
//    「预算受限」——状态、原因、用量的警示显示、「加预算」入口；
// 3) 不再续跑（阻断后没有新的续跑请求）；输入队列恢复自动发出；任务回到空闲；
// 4) 「预算受限」态直接加预算（一键 +10 万）：落库、显示更新，停留状态不变
//    （加预算不自动恢复）；恢复按钮对预算受限的目标可用；
// 5) 重启后「预算受限」原样保持，预算与用量可读；
// 6) 用户显式点「恢复」→ 从暂停点续跑（不产生用户气泡）→ 那一轮判定未过，
//    但目标用量按新预算对账、未再受限 → 照常续跑 → 判定通过 → 已完成。
// 观察点的纪律：循环走得快，「恢复后进行中」只在恢复那一轮的慢速流期间成立；
// 慢速流的各段自成一段（见 segments），状态观察之前不排任何别的等待。
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
/** 续跑指令的稳定锚（buildGoalContinuationInput 的首行）：判定后续跑与恢复都带它 */
const CONTINUATION_ANCHOR = "【目标续跑】";
/** 恢复的续跑指令独有的一句：按它把「恢复后的那一轮」与判定后的续跑轮区分开 */
const RESUME_ANCHOR = "现已恢复";

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
const PASSED = { passed: true, reason: "示例测试已全部通过", nextAction: "" };

const MARKERS = [
  "第 1 次迭代 · 未完成 · 下一步：继续第 2 步",
  "第 2 次迭代 · 未完成 · 下一步：继续第 3 步",
  "第 3 次迭代 · 未完成 · 下一步：继续第 4 步",
  "第 4 次迭代 · 已完成",
];

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

/** 请求分类：判定 / 续跑轮（判定后的续跑与恢复后的首轮同形）/ 普通工作轮 */
function classify(body) {
  if (body.includes("[goal-verification]")) return "判定";
  const text = lastUserText(body) ?? "";
  if (text.includes(CONTINUATION_ANCHOR)) return "续跑轮";
  return `工作轮:${text.slice(0, 3)}`;
}

/**
 * 慢速流的分段文本：每段自成一段（段间空行）。流式期间各段先后拼进同一条
 * 回复——不分段的话 `getByText(…, { exact: true })` 只在「本段已到、下一段
 * 未到」的一个间隔内成立，等待的起点稍晚就永远等不到（解锁态补跑时红过一次）。
 */
const segments = (label, count) =>
  Array.from({ length: count }, (_, i) => `${label}第${i}段。\n\n`);

const markerTexts = (window) =>
  window.getByTestId("goal-verification-marker").allTextContents();
const userBubbleTexts = (window) =>
  window.getByTestId("message-user").allTextContents();
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

/** 等到任务空闲（发送按钮回来、队列条不在） */
async function waitIdle(window) {
  await window.getByTestId("composer-send").waitFor({ timeout: 30_000 });
  await window
    .getByTestId("queue-bar")
    .waitFor({ state: "detached", timeout: 10_000 });
}

/** 侧栏首个任务是否显示「运行中」（没有徽章 = 空闲且已查看，不算运行中） */
async function sidebarShowsRunning(window) {
  const badge = window.getByTestId("task-activity").first();
  if ((await badge.count()) === 0) return false;
  return (await badge.textContent())?.includes("运行中") === true;
}

/**
 * 进度行的控制面按钮（票 04）：读的是真实按钮——null = 不出现，
 * true / false = 出现且可用 / 禁用。
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

/** 进行中：可暂停 / 清除，没有恢复，编辑禁用 */
const ACTIVE_CONTROLS = {
  "goal-pause": true,
  "goal-resume": null,
  "goal-edit": false,
  "goal-clear": true,
};
/** 可恢复的三态（已暂停 / 预算受限 / 未达成）一致：恢复可用，可编辑、可清除 */
const RESUMABLE_CONTROLS = {
  "goal-pause": null,
  "goal-resume": true,
  "goal-edit": true,
  "goal-clear": true,
};
/** 已完成：没有暂停 / 恢复，编辑禁用，可清除 */
const COMPLETED_CONTROLS = {
  "goal-pause": null,
  "goal-resume": null,
  "goal-edit": false,
  "goal-clear": true,
};

/** 公开 IPC 可读的目标、验证记录与任务用量账目 */
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

const expectedVerifications = (pairs) =>
  pairs.map(([round, outcome]) => ({ round, outcome }));

async function main() {
  /** 已到达的续跑轮请求数（判定后的续跑与恢复后的首轮都算） */
  let continuationsSeen = 0;
  const { server, port, seenBodies, requestCount } =
    await startGoalMockProvider({
      usage: USAGE,
      work(ctx, { body }) {
        const text = lastUserText(body) ?? "";
        if (text === "建立任务") return ctx.textRound("任务已建立");
        if (text === GOAL_TEXT)
          // 首轮慢速流（15 秒）：期间经进度行的预算控件设定预算
          return ctx.textChunksRound(segments("首轮", 60), 250);
        if (text.includes(CONTINUATION_ANCHOR)) {
          continuationsSeen += 1;
          // 恢复后的那一轮用慢速流（约 6 秒）：留出「恢复后目标进行中」的观察窗口
          if (text.includes(RESUME_ANCHOR))
            return ctx.textChunksRound(segments("恢复后续跑", 20), 300);
          return ctx.textRound(`续跑轮的回复 ${continuationsSeen}`);
        }
        if (text === "补充甲")
          // 互锁哨兵：「补充甲」只应在目标因预算受限离开进行中之后到达——那时
          // 已经有过一轮续跑；更早到达说明排队消息抢在阻断之前被发出
          return ctx.textRound(
            continuationsSeen >= 1 ? "甲的处理结果" : WORK_SENTINEL
          );
        return ctx.textRound(WORK_SENTINEL);
      },
      // 判定脚本（index 只数判定请求）：①②③ 未过——第 2 次挂起 1.5 秒，留出
      // 「第 1 轮后目标仍在进行」的观察窗口；第 3 次是恢复后那一轮的判定，未过
      // 才能证明「按新预算对账、不再受限而照常续跑」；第 4 次通过。其余哨兵。
      verdict(ctx, { index }) {
        if (index === 2) {
          setTimeout(() => ctx.verdictRound(UNPASSED(index), "raw"), 1500);
          return;
        }
        if (index <= 3) return ctx.verdictRound(UNPASSED(index), "raw");
        if (index === 4) return ctx.verdictRound(PASSED, "code-fence");
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
    await waitAssistantText(window, "续跑轮的回复 1");
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
      (await window.getByTestId("goal-progress-round").textContent()) ===
        "第 2 轮",
      "第 2 次判定在途进度行应为「第 2 轮」"
    );
    assert(
      same(await markerTexts(window), MARKERS.slice(0, 1)),
      `首行标记应为「${MARKERS[0]}」（实际 ${JSON.stringify(await markerTexts(window))}）`
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
      (await window.getByTestId("goal-progress-round").textContent()) ===
        "第 2 轮",
      "预算受限时进度行应为「第 2 轮」"
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
    // 恢复按钮对预算受限的目标可用（票 04 的控制面：三种可恢复态同一路径）
    assert(
      same(await controlState(window), RESUMABLE_CONTROLS),
      `预算受限的按钮矩阵不符：${JSON.stringify(await controlState(window))}`
    );
    // 在途回合与判定没有被预算打断：第二轮的回复与两次判定结论完整留痕
    assert(
      same(await markerTexts(window), MARKERS.slice(0, 2)),
      `两行标记应为「${MARKERS[0]}」「${MARKERS[1]}」（实际 ${JSON.stringify(await markerTexts(window))}）`
    );
    console.log(
      "[e2e] 目标用量达到预算 500：回合与判定照常完成后转「预算受限」，原因与用量可见，「加预算」与恢复入口就位"
    );

    // ---- 4) 不再续跑；输入队列恢复自动发出；任务回到空闲 ----
    await waitAssistantText(window, "甲的处理结果");
    await waitIdle(window);
    assert(
      (await sidebarShowsRunning(window)) === false,
      "预算受限后侧栏不应再显示运行中"
    );
    // 请求时序：建任务 → 首轮 → 判定 → 续跑 → 判定 →（阻断，无新的续跑请求）→ 排队消息
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
        expectedVerifications([
          [1, "unpassed"],
          [2, "unpassed"],
        ])
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
    // 加预算不自动恢复：停留状态留给用户显式恢复（恢复按钮照旧可用）
    assert(
      (await progressStatus(window)) === "预算受限",
      "加预算后目标应保持「预算受限」（恢复是另一个动作）"
    );
    assert(
      (await readGoalState(window)).goal?.budgetTokens === BUDGET + QUICK_ADD,
      "加预算应落库"
    );
    assert(
      same(await controlState(window), RESUMABLE_CONTROLS),
      `加预算后的按钮矩阵不符：${JSON.stringify(await controlState(window))}`
    );
    console.log(
      "[e2e] 预算受限态一键加预算：预算 500 → 100,500 已落库并显示，停留状态不变"
    );

    // ---- 6) 两条脚本线都未越界（此刻） ----
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
    const restartedRow = window.getByTestId("goal-progress-row");
    await restartedRow.waitFor({ timeout: 10_000 });
    assert(
      (await restartedRow.getAttribute("data-goal-status")) ===
        "budget-limited",
      "重启后目标应保持「预算受限」"
    );
    assert(
      (await window.getByTestId("goal-progress-round").textContent()) ===
        "第 2 轮",
      "重启后进度行应由落库验证记录恢复「第 2 轮」"
    );
    await waitBudgetText(window, "用量 750 / 100,500");
    assert(
      (await window.getByTestId("goal-progress-reason").textContent()) ===
        "目标用量已达到 token 预算",
      "重启后停留原因仍可见"
    );
    assert(
      same(await markerTexts(window), MARKERS.slice(0, 2)),
      `重启后两行标记应由落库数据恢复（实际 ${JSON.stringify(await markerTexts(window))}）`
    );
    assert(
      (await sidebarShowsRunning(window)) === false,
      "重启后预算受限的目标不应自行续跑"
    );
    console.log("[e2e] 重启恢复：「预算受限」原样保持，预算与用量可读");

    // ---- 8) 加预算后由用户显式恢复：从暂停点续跑 → 按新预算不再受限 → 已完成 ----
    const requestsBeforeResume = requestCount();
    await window.getByTestId("goal-resume").click();
    // 恢复即回到「进行中」并以内部输入发起续跑轮（慢速流进行中，约 6 秒的观察
    // 窗口）。观察点先看状态、再看文本与反馈：不把任何等待排在状态观察之前。
    await restartedRow
      .and(window.locator('[data-goal-status="active"]'))
      .waitFor({ timeout: 15_000 });
    assert(
      (await progressStatus(window)) === "进行中",
      `恢复后进度行状态应为「进行中」（实际 ${await progressStatus(window)}）`
    );
    assert(
      same(await controlState(window), ACTIVE_CONTROLS),
      `恢复后进行中的按钮矩阵不符：${JSON.stringify(await controlState(window))}`
    );
    // 预算是加过之后的 100,500：恢复进行中用量 750 未到线，不再标警示
    assert(
      (await budgetText(window)) === "用量 750 / 100,500" &&
        (await window
          .getByTestId("goal-budget-trigger")
          .getAttribute("data-over")) === null,
      `恢复进行中预算显示应为「用量 750 / 100,500」且不标警示（实际 ${await budgetText(window)}）`
    );
    // 续跑轮的回复正在流入（首段自成一段，不依赖流式拼接的瞬时文本）
    await waitAssistantText(window, "恢复后续跑第0段。");
    // 恢复走本地命令反馈（info 类反馈停留约 6 秒）
    await window
      .getByTestId("command-feedback")
      .filter({ hasText: "目标已恢复" })
      .waitFor({ timeout: 5_000 });
    await restartedRow
      .and(window.locator('[data-goal-status="completed"]'))
      .waitFor({ timeout: 30_000 });
    assert(
      (await progressStatus(window)) === "已完成",
      `恢复后的循环最终判定通过，进度行应为「已完成」（实际 ${await progressStatus(window)}）`
    );
    assert(
      (await window.getByTestId("goal-progress-round").textContent()) ===
        "第 4 轮",
      "判定通过后进度行应为「第 4 轮」"
    );
    await waitIdle(window);
    assert(
      (await sidebarShowsRunning(window)) === false,
      "目标完成后侧栏不应再显示运行中"
    );
    // 留痕：前三次未过（第 3 次是恢复后那一轮——未过但不再受限）、第 4 次通过
    assert(
      same(await markerTexts(window), MARKERS),
      `四行标记应为三轮「未完成」加一行「已完成」（实际 ${JSON.stringify(await markerTexts(window))}）`
    );
    assert(
      same(await controlState(window), COMPLETED_CONTROLS),
      `已完成的按钮矩阵不符：${JSON.stringify(await controlState(window))}`
    );
    // 用量 = 账目 − 基线：10 次应答 × 150 − 150 = 1,350 < 新预算 100,500
    await waitBudgetText(window, "用量 1,350 / 100,500");
    const done = await readGoalState(window);
    assert(
      done.goal?.status === "completed" &&
        done.goal.budgetTokens === BUDGET + QUICK_ADD &&
        done.goal.baselineTokens === 150 &&
        done.goal.idleStreak === 0,
      `公开 IPC 的目标状态不符：${JSON.stringify(done.goal)}`
    );
    assert(
      done.taskStatus === "idle" &&
        same(done.usage, {
          mainInputTokens: 1000,
          mainOutputTokens: 500,
          subagentInputTokens: 0,
          subagentOutputTokens: 0,
        }),
      `任务应回到空闲且用量账目为 10 次应答的累计：${JSON.stringify(done)}`
    );
    assert(
      same(
        done.verifications,
        expectedVerifications([
          [1, "unpassed"],
          [2, "unpassed"],
          [3, "unpassed"],
          [4, "passed"],
        ])
      ),
      `验证记录不符：${JSON.stringify(done.verifications)}`
    );
    // 恢复后的那一轮判定未过：目标用量 1,200 < 新预算 100,500，没有再次受限，
    // 循环照常续跑了一轮，直到判定通过
    assert(
      same(seenBodies.map(classify), [
        "工作轮:建立任",
        `工作轮:${GOAL_TEXT.slice(0, 3)}`,
        "判定",
        "续跑轮",
        "判定",
        "工作轮:补充甲",
        "续跑轮",
        "判定",
        "续跑轮",
        "判定",
      ]),
      `请求时序不符：${JSON.stringify(seenBodies.map(classify))}`
    );
    assert(
      requestCount() - requestsBeforeResume === 4,
      `恢复之后应恰好 4 个请求（恢复的续跑轮、判定、续跑轮、判定；实际 ${requestCount() - requestsBeforeResume}）`
    );
    // 三个续跑轮请求里只有第二次是「恢复」的内部输入（按各自最后一条 user 消息
    // 判别：更早的续跑指令会留在后续请求的历史里，不能按整个请求体判）
    const resumedInputs = seenBodies
      .filter((body) => classify(body) === "续跑轮")
      .map((body) => (lastUserText(body) ?? "").includes(RESUME_ANCHOR));
    assert(
      same(resumedInputs, [false, true, false]),
      `续跑轮请求里应只有恢复后的首轮带恢复指令（实际 ${JSON.stringify(resumedInputs)}）`
    );
    // 恢复后的续跑轮是内部输入：用户只说过建任务、目标原文与排队消息
    assert(
      same(await userBubbleTexts(window), ["建立任务", GOAL_TEXT, "补充甲"]),
      `恢复后的续跑轮不应产生用户气泡（实际 ${JSON.stringify(await userBubbleTexts(window))}）`
    );
    console.log(
      "[e2e] 加预算后显式恢复：从暂停点续跑（无用户气泡）→ 第 3 次判定未过但按新预算不再受限 → 续跑 → 第 4 次判定通过 → 已完成"
    );

    // ---- 9) 两条脚本线都未越界 ----
    for (const sentinel of [WORK_SENTINEL, VERDICT_SENTINEL]) {
      assert(
        (await window.getByText(sentinel, { exact: true }).count()) === 0,
        `不应出现哨兵文本：${sentinel}`
      );
    }

    await closeApp(app);
    app = undefined;
    console.log("[e2e] 目标模式 token 预算护栏场景通过 ✅");
  } catch (error) {
    console.error("[e2e] 目标模式 token 预算护栏场景失败 ❌", error);
    // 失败现场：请求时序（排障用）
    console.error("[e2e] 请求时序：", JSON.stringify(seenBodies.map(classify)));
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
