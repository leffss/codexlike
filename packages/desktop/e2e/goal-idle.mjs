// E2E（goal-mode 票 05，ADR 0035「护栏」）：空转阻断——连续 3 轮判定未过且无
// 实质工具活动 → 「未达成」暂停并呈现原因（非终止，可恢复）。
// 场景脚本（stub 两条线；index 各线独立计数）：
//   工作轮：① 建任务 ② 目标首轮 ③④ 续跑轮（都只回文字，不调用任何工具）
//           ⑤ 阻断后排队消息的消费
//   判定轮：①②③ 未过（第 3 次挂起，留出「第 3 轮判定在途」的观察窗口）
// 断言只经真实界面、公开 IPC 与外部请求：
// 1) 第 1、2 轮只回文字、判定未过：照常续跑（未达阈值）；
// 2) 第 3 轮后目标转「未达成」：进度行状态与原因（连续 3 轮判定未过且无实质
//    工具活动），三行「未完成」标记留痕；
// 3) 不再续跑（没有第 4 轮请求）；输入队列恢复自动发出；任务回到空闲；
// 4) 重启后「未达成」原样保持，原因与标记可回看。
// 运行：pnpm test:e2e:goal-idle（先 pnpm build）。
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

const IDLE_REPLIES = ["第二轮：还是只是说说", "第三轮：依旧只是说说"];
const UNPASSED = (round) => ({
  passed: false,
  reason: `尚有步骤未完成（第 ${round} 轮）`,
  nextAction: `继续第 ${round + 1} 步`,
});
const MARKERS = [1, 2, 3].map(
  (round) => `第 ${round} 次迭代 · 未完成 · 下一步：继续第 ${round + 1} 步`
);
/** 第 3 次判定在 stub 侧的挂起时长：期间「验证中」可见，目标仍进行 */
const THIRD_VERDICT_HOLD_MS = 1500;

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
const same = (actual, expected) =>
  JSON.stringify(actual) === JSON.stringify(expected);

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

/** 公开 IPC 可读的目标、验证记录与任务状态 */
async function readGoalState(window) {
  return window.evaluate(async () => {
    const task = (await window.codexlike.tasks.list())[0];
    const view = await window.codexlike.tasks.view(task.id);
    return {
      goal: view.goal,
      taskStatus: task.status,
      verifications: (await window.codexlike.tasks.messages(task.id))
        .filter((item) => item.kind === "goal-verification")
        .map((item) => ({
          round: item.verification.round,
          outcome: item.verification.outcome,
          toolActivity: item.verification.toolActivity,
        })),
    };
  });
}

async function main() {
  const { server, port, seenBodies, requestCount } =
    await startGoalMockProvider({
      // 工作轮脚本：续跑轮必须确实是续跑轮（请求的最后一条 user 消息是续跑指令）。
      // 首轮慢速流（15 秒）：期间入队一条消息。续跑轮只回文字、不调用任何工具。
      work(ctx, { body, index }) {
        if (index === 1) return ctx.textRound("任务已建立");
        if (index === 2)
          return ctx.textChunksRound(
            Array.from({ length: 60 }, (_, i) => `首轮第${i}段。`),
            250
          );
        const isContinuation = (lastUserText(body) ?? "").includes(
          CONTINUATION_ANCHOR
        );
        if (isContinuation && index === 3)
          return ctx.textRound(IDLE_REPLIES[1]);
        if (isContinuation && index === 4)
          return ctx.textRound(IDLE_REPLIES[2]);
        if (index === 5) return ctx.textRound("甲的处理结果");
        return ctx.textRound(WORK_SENTINEL);
      },
      // 判定脚本（index 只数判定请求）：三次未过；其余哨兵——阻断后不该再有判定
      verdict(ctx, { index }) {
        if (index <= 2) return ctx.verdictRound(UNPASSED(index), "raw");
        if (index === 3) {
          setTimeout(
            () => ctx.verdictRound(UNPASSED(index), "raw"),
            THIRD_VERDICT_HOLD_MS
          );
          return;
        }
        return ctx.verdictRound(
          { passed: false, reason: VERDICT_SENTINEL, nextAction: "无" },
          "raw"
        );
      },
    });
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-goal-idle-"));
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

    // ---- 1) /goal 设定；首轮慢速流期间入队一条消息（目标进行中不自动消费） ----
    await composer.fill(`/goal ${GOAL_TEXT}`);
    await composer.press("Enter");
    await waitAssistantText(window, "首轮第0段。");
    await row.waitFor({ timeout: 10_000 });
    await composer.fill("补充甲");
    await composer.press("Enter");
    await window.getByTestId("queue-count").getByText("待发 1 条").waitFor({
      timeout: 10_000,
    });

    // ---- 2) 前两轮：只回文字、判定未过、无实质工具活动 → 未达阈值，照常续跑 ----
    // 循环走得快（续跑轮与判定即时应答）：以第 3 次判定的挂起窗口为确定性的观察点。
    // 同一轮次分组里较早的回复会被折叠，观察点用标记行与「验证中」占位，不用中间回复。
    await window
      .locator('[data-testid="goal-verifying-marker"][data-goal-round="3"]')
      .waitFor({ timeout: 45_000 });
    assert(
      (await row.getAttribute("data-goal-status")) === "active",
      "两轮空转后、第 3 次判定在途：目标应仍在进行（未达阈值，阻断发生在判定之后）"
    );
    assert(
      (await progressStatus(window)) === "验证中",
      `第 3 次判定在途时进度行应显示「验证中」（实际 ${await progressStatus(window)}）`
    );
    assert(
      same(await markerTexts(window), MARKERS.slice(0, 2)),
      `前两轮后应有两行「未完成」标记（实际 ${JSON.stringify(await markerTexts(window))}）`
    );
    // 排队消息在目标进行期间始终没有抢发
    assert(
      (await window.getByTestId("queue-count").textContent())?.includes("1") ===
        true,
      "前两轮续跑期间排队消息应原样保留（不自动消费）"
    );
    console.log(
      "[e2e] 前两轮只回文字、判定未过：未达阈值，照常续跑；第 3 次判定在途目标仍进行"
    );

    // ---- 3) 第 3 次判定未过：连续 3 轮空转 → 「未达成」 ----
    await row
      .and(window.locator('[data-goal-status="unmet"]'))
      .waitFor({ timeout: 30_000 });
    assert(
      (await progressStatus(window)) === "未达成",
      `进度行状态应为「未达成」（实际 ${await progressStatus(window)}）`
    );
    assert(
      (await window.getByTestId("goal-progress-reason").textContent()) ===
        "连续 3 轮判定未过且无实质工具活动",
      "未达成应呈现原因"
    );
    // 标记行口径不变：三轮都是判定给出的「未完成 · 下一步」，阻断原因由进度行承载
    assert(
      same(await markerTexts(window), MARKERS),
      `三行标记应为三轮「未完成」（实际 ${JSON.stringify(await markerTexts(window))}）`
    );
    // 未设预算：预算控件是不限入口；未达成不是预算问题，没有「加预算」入口
    assert(
      (await window.getByTestId("goal-budget-trigger").textContent()) ===
        "预算 不限",
      "未设预算的目标不应因预算受影响"
    );
    assert(
      (await window.getByTestId("goal-budget-add").count()) === 0,
      "未达成态不应出现「加预算」入口"
    );
    console.log(
      "[e2e] 连续 3 轮判定未过且无实质工具活动：目标转「未达成」，原因与三行标记可见"
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
      "未达成后侧栏不应再显示运行中"
    );
    // 请求时序：建任务 → 首轮 → 判定 → 续跑 → 判定 → 续跑 → 判定 →（阻断，无第 4 轮）→ 排队消息
    assert(
      same(seenBodies.map(classify), [
        "工作轮:建立任",
        `工作轮:${GOAL_TEXT.slice(0, 3)}`,
        "判定",
        "续跑轮",
        "判定",
        "续跑轮",
        "判定",
        "工作轮:补充甲",
      ]),
      `请求时序不符：${JSON.stringify(seenBodies.map(classify))}`
    );
    assert(
      requestCount() === 8,
      `建任务 + 首轮 + 两次续跑 + 三次判定 + 一条排队消息应恰好 8 个请求（实际 ${requestCount()}）`
    );
    const unmet = await readGoalState(window);
    assert(
      unmet.goal?.status === "unmet" &&
        unmet.goal.idleStreak === 3 &&
        unmet.goal.failureStreak === 0 &&
        unmet.goal.budgetTokens === null,
      `公开 IPC 的目标状态不符：${JSON.stringify(unmet.goal)}`
    );
    assert(
      same(unmet.verifications, [
        { round: 1, outcome: "unpassed", toolActivity: false },
        { round: 2, outcome: "unpassed", toolActivity: false },
        { round: 3, outcome: "unpassed", toolActivity: false },
      ]),
      `三轮验证记录应如实为未过且无实质工具活动：${JSON.stringify(unmet.verifications)}`
    );
    // 阻断后那条普通消息的回合不触发判定、不改目标状态；任务回到空闲
    assert(
      unmet.taskStatus === "idle" && unmet.goal?.status === "unmet",
      `任务应回到空闲且目标停在未达成：${JSON.stringify(unmet)}`
    );
    console.log(
      "[e2e] 未达成后不再续跑（恰好 8 个请求）；输入队列恢复自动发出，任务回到空闲"
    );

    // ---- 5) 两条脚本线都未越界 ----
    for (const sentinel of [WORK_SENTINEL, VERDICT_SENTINEL]) {
      assert(
        (await window.getByText(sentinel, { exact: true }).count()) === 0,
        `不应出现哨兵文本：${sentinel}`
      );
    }

    // ---- 6) 重启后「未达成」原样保持 ----
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
        .getAttribute("data-goal-status")) === "unmet",
      "重启后目标应保持「未达成」"
    );
    assert(
      (await window.getByTestId("goal-progress-reason").textContent()) ===
        "连续 3 轮判定未过且无实质工具活动",
      "重启后未达成的原因仍可见"
    );
    assert(
      same(await markerTexts(window), MARKERS),
      `重启后三行标记应由落库数据恢复（实际 ${JSON.stringify(await markerTexts(window))}）`
    );
    assert(
      (await sidebarShowsRunning(window)) === false,
      "重启后未达成的目标不应自行续跑"
    );

    await closeApp(app);
    app = undefined;
    console.log("[e2e] 重启恢复：「未达成」原样保持，原因与三行标记可回看");
    console.log("[e2e] 目标模式空转阻断护栏场景通过 ✅");
  } catch (error) {
    console.error("[e2e] 目标模式空转阻断护栏场景失败 ❌", error);
    // 失败现场：请求时序、消息流里的助手文本与进度行状态（排障用）
    console.error("[e2e] 请求时序：", JSON.stringify(seenBodies.map(classify)));
    try {
      console.error(
        "[e2e] 助手文本：",
        JSON.stringify(
          await app
            .windows()[0]
            ?.getByTestId("message-assistant")
            .allTextContents()
        )
      );
    } catch {
      // 窗口已不可用
    }
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
