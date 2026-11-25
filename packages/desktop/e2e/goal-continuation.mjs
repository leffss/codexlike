// E2E（goal-mode 票 03，ADR 0035）：续跑循环——判定未过自动续跑，多轮后通过。
// 场景脚本（stub 两条线，见 goal-stub.mjs；index 各线独立计数）：
//   工作轮：① 建任务 ② 目标首轮（慢速流） ③④ 续跑轮（④ 慢速流） ⑤⑥ 排队消息的消费
//   判定轮：①② 未过（各给下一步方向；①② 应答前挂起，留出「验证中」窗口）③ 通过（代码围栏形态）
// 断言只经真实界面、公开 IPC 与外部请求：
// 1) 回合结束进入「验证中」：标记行占位「第 N 次迭代 · 验证中」、进度行「验证中」，
//    判定在途期间侧栏仍显示运行中、停止按钮可用（不出现空闲空窗）；
// 2) 判定未过：标记行「第 N 次迭代 · 未完成 · 下一步：…」，无需用户操作自动发起
//    下一轮；续跑指令进入模型请求（带下一步方向与目标原文），消息流不产生用户气泡；
// 3) 目标进行中（含续跑轮与轮间）排队消息不自动消费；多轮后判定通过 →
//    「第 3 次迭代 · 已完成」、进度行「已完成」，三行标记按序留痕，队列恢复逐条发出；
// 4) 公开 IPC 可读：三轮验证记录、续跑指令以独立角色落库；
// 5) 重启后标记行由落库数据恢复，续跑轮仍不呈现为用户消息。
// 运行：pnpm test:e2e:goal-continuation（先 pnpm build）。
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

/** 判定请求在 mock 侧的挂起时长：期间「验证中」占位行与运行口径可见，队列不得被消费 */
const FIRST_VERDICT_HOLD_MS = 2500;
const SECOND_VERDICT_HOLD_MS = 2500;

const UNPASSED_1 = {
  passed: false,
  reason: "尚有步骤未完成",
  nextAction: "补齐失败用例",
};
const UNPASSED_2 = {
  passed: false,
  reason: "还差收尾",
  nextAction: "运行完整回归",
};
const PASSED = { passed: true, reason: "示例测试已全部通过", nextAction: "" };

const MARKER_1 = "第 1 次迭代 · 未完成 · 下一步：补齐失败用例";
const MARKER_2 = "第 2 次迭代 · 未完成 · 下一步：运行完整回归";
const MARKER_3 = "第 3 次迭代 · 已完成";

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

const markerTexts = (window) =>
  window.getByTestId("goal-verification-marker").allTextContents();
const userBubbleTexts = (window) =>
  window.getByTestId("message-user").allTextContents();
const progressStatus = (window) =>
  window.getByTestId("goal-progress-status").textContent();
/** 侧栏首个任务是否显示「运行中」（没有徽章 = 空闲且已查看，不算运行中） */
const sidebarShowsRunning = async (window) => {
  const badge = window.getByTestId("task-activity").first();
  if ((await badge.count()) === 0) return false;
  return (await badge.textContent())?.includes("运行中") === true;
};
const same = (actual, expected) =>
  JSON.stringify(actual) === JSON.stringify(expected);

async function waitAssistantText(window, text) {
  await window
    .getByTestId("message-assistant")
    .getByText(text, { exact: true })
    .waitFor({ timeout: 30_000 });
}

async function main() {
  /** 已应答的判定次数：工作轮脚本据此识别「排队消息是否抢在目标完成前发出」 */
  let verdictsAnswered = 0;
  const { server, port, seenBodies, requestCount } =
    await startGoalMockProvider({
      work(ctx, { body, index }) {
        if (index === 1) return ctx.textRound("任务已建立");
        if (index === 2)
          return ctx.textChunksRound(
            Array.from({ length: 20 }, (_, i) => `首轮第${i}段。`),
            250
          );
        // 续跑轮：请求的最后一条 user 消息必须是续跑指令
        const isContinuation = (lastUserText(body) ?? "").includes(
          CONTINUATION_ANCHOR
        );
        if (index === 3 && isContinuation)
          return ctx.textRound("续跑轮二的回复");
        if (index === 4 && isContinuation)
          return ctx.textChunksRound(
            Array.from({ length: 20 }, (_, i) => `第三轮第${i}段。`),
            250
          );
        // 互锁哨兵：「补充甲」若在第 3 次判定应答之前到达，说明排队消息抢在目标
        // 完成前被发出——回哨兵文本，场景末尾的哨兵断言据此失败。
        if (index === 5)
          return ctx.textRound(
            verdictsAnswered >= 3 ? "甲的处理结果" : WORK_SENTINEL
          );
        if (index === 6) return ctx.textRound("乙的处理结果");
        return ctx.textRound(WORK_SENTINEL);
      },
      // 挂起应答后再记账：哨兵要的是「目标是否已经判定通过」，不是请求是否到达
      verdict(ctx, { index }) {
        const answer = (verdict, format, holdMs) => {
          setTimeout(() => {
            ctx.verdictRound(verdict, format);
            verdictsAnswered += 1;
          }, holdMs);
        };
        if (index === 1)
          return answer(UNPASSED_1, "raw", FIRST_VERDICT_HOLD_MS);
        if (index === 2)
          return answer(UNPASSED_2, "raw", SECOND_VERDICT_HOLD_MS);
        if (index === 3) {
          verdictsAnswered += 1;
          return ctx.verdictRound(PASSED, "code-fence");
        }
        return ctx.verdictRound(
          { passed: false, reason: VERDICT_SENTINEL, nextAction: "无" },
          "raw"
        );
      },
    });
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-goal-cont-"));
  mkdirSync(join(homeDir, "workspace"));

  let app;
  try {
    const first = await launchApp({ homeDir });
    app = first.app;
    let window = first.window;
    await createMockProfile(window, { name: "Mock", port });
    await prepareDraft(window, { approvalMode: "assist" });
    const composer = window.getByTestId("composer-input");

    // ---- 0) 建任务 ----
    await composer.fill("建立任务");
    await composer.press("Enter");
    await waitAssistantText(window, "任务已建立");
    await window.getByTestId("composer-send").waitFor({ timeout: 10_000 });

    // ---- 1) /goal 设定：首轮进行中入队两条（目标进行中不自动消费） ----
    await composer.fill(`/goal ${GOAL_TEXT}`);
    await composer.press("Enter");
    await waitAssistantText(window, "首轮第0段。");
    await composer.fill("补充甲");
    await composer.press("Enter");
    await composer.fill("补充乙");
    await composer.press("Enter");
    const queueCount = window.getByTestId("queue-count");
    await queueCount.getByText("待发 2 条").waitFor({ timeout: 10_000 });

    // ---- 2) 验证中：标记行占位 + 进度行副状态 + 侧栏运行中 + 队列互锁 ----
    const verifyingRow = window.getByTestId("goal-verifying-marker");
    await verifyingRow.waitFor({ timeout: 30_000 });
    assert(
      (await verifyingRow.textContent()) === "第 1 次迭代 · 验证中",
      `判定在途应出现「第 1 次迭代 · 验证中」占位行（实际 ${await verifyingRow.textContent()}）`
    );
    assert(
      (await progressStatus(window)) === "验证中",
      `判定在途进度行状态应为「验证中」（实际 ${await progressStatus(window)}）`
    );
    assert(
      (await sidebarShowsRunning(window)) === true,
      "判定在途侧栏应照常显示运行中（不得出现空闲空窗）"
    );
    assert(
      (await window.getByTestId("composer-stop").count()) === 1,
      "判定在途停止按钮应保持可用（Stop = 暂停）"
    );
    assert(
      (await window.getByTestId("goal-verification-marker").count()) === 0,
      "判定在途不应提前出现结论标记行"
    );
    assert(
      (await queueCount.textContent())?.includes("2") === true,
      "判定在途排队消息应原样保留（不自动消费）"
    );
    console.log(
      "[e2e] 验证中：占位行「第 1 次迭代 · 验证中」，进度行「验证中」，侧栏运行中、停止可用、队列互锁"
    );

    // ---- 3) 判定未过：占位行原位变成「未完成 · 下一步」，自动发起续跑轮 ----
    const marker = window.getByTestId("goal-verification-marker");
    await marker.waitFor({ timeout: 30_000 });
    // 第 1 轮的占位行原位升级为结论行。循环走得快，此刻下一轮的「验证中」可能
    // 已经出现——只断言第 1 轮不再留有占位行（按 data-goal-round 区分）
    const verifyingOfRound = (round) =>
      window
        .locator(
          `[data-testid="goal-verifying-marker"][data-goal-round="${round}"]`
        )
        .count();
    assert(
      (await verifyingOfRound(1)) === 0,
      "结论到达后第 1 轮的「验证中」占位行应原位升级，不留第二行"
    );
    await waitAssistantText(window, "续跑轮二的回复");
    assert(
      same(await markerTexts(window), [MARKER_1]),
      `首行标记应为「${MARKER_1}」（实际 ${JSON.stringify(await markerTexts(window))}）`
    );
    assert(
      (await marker.first().getAttribute("data-goal-verdict")) === "unpassed",
      "未过标记行的 data-goal-verdict 应为 unpassed"
    );
    // 续跑指令进入了模型请求：带下一步方向、判定理由与目标原文
    const continuationBodies = seenBodies.filter(
      (body) => classify(body) === "续跑轮"
    );
    assert(
      continuationBodies.length >= 1,
      "判定未过后应自动发出续跑轮的工作请求"
    );
    const firstContinuation = continuationBodies[0];
    assert(
      (lastUserText(firstContinuation) ?? "").includes("补齐失败用例"),
      "续跑指令应带入下一步方向"
    );
    assert(
      (lastUserText(firstContinuation) ?? "").includes("尚有步骤未完成"),
      "续跑指令应带入判定理由"
    );
    assert(
      (lastUserText(firstContinuation) ?? "").includes(GOAL_TEXT),
      "续跑指令应复述目标原文"
    );
    console.log(
      "[e2e] 判定未过自动续跑：占位行原位升级为「未完成 · 下一步」，续跑指令带下一步方向"
    );

    // ---- 4) 第二轮：再次验证中 → 未过 → 第三轮（慢速流，期间观察运行口径与互锁） ----
    await verifyingRow.waitFor({ timeout: 30_000 });
    assert(
      (await verifyingRow.textContent()) === "第 2 次迭代 · 验证中",
      "第二轮判定在途应出现「第 2 次迭代 · 验证中」占位行"
    );
    await waitAssistantText(window, "第三轮第0段。");
    assert(
      same(await markerTexts(window), [MARKER_1, MARKER_2]),
      `前两行标记应为「${MARKER_1}」「${MARKER_2}」（实际 ${JSON.stringify(await markerTexts(window))}）`
    );
    assert(
      (await progressStatus(window)) === "进行中",
      `续跑轮进行中进度行状态应为「进行中」（实际 ${await progressStatus(window)}）`
    );
    assert(
      (await sidebarShowsRunning(window)) === true,
      "续跑轮进行中侧栏应显示运行中"
    );
    // 续跑轮不产生用户气泡：用户只说过「建立任务」与目标原文
    assert(
      same(await userBubbleTexts(window), ["建立任务", GOAL_TEXT]),
      `续跑轮不应产生用户气泡（实际 ${JSON.stringify(await userBubbleTexts(window))}）`
    );
    assert(
      (await queueCount.textContent())?.includes("2") === true,
      "续跑期间排队消息应原样保留（不自动消费）"
    );
    console.log(
      "[e2e] 第二轮：再次验证中 → 未完成；续跑轮无用户气泡，进度行「进行中」，队列持续互锁"
    );

    // ---- 5) 第三次判定通过 → 已完成：三行标记留痕；队列恢复逐条自动发出 ----
    await window
      .getByTestId("goal-progress-row")
      .and(window.locator('[data-goal-status="completed"]'))
      .waitFor({ timeout: 30_000 });
    assert(
      same(await markerTexts(window), [MARKER_1, MARKER_2, MARKER_3]),
      `三行标记应为「${MARKER_1}」「${MARKER_2}」「${MARKER_3}」（实际 ${JSON.stringify(await markerTexts(window))}）`
    );
    assert(
      (await progressStatus(window)) === "已完成",
      "判定通过后进度行状态应为「已完成」"
    );
    await waitAssistantText(window, "甲的处理结果");
    await waitAssistantText(window, "乙的处理结果");
    await window.getByTestId("queue-bar").waitFor({
      state: "detached",
      timeout: 10_000,
    });
    await window.getByTestId("composer-send").waitFor({ timeout: 10_000 });
    assert(
      (await sidebarShowsRunning(window)) === false,
      "目标完成后侧栏不应再显示运行中"
    );
    console.log(
      "[e2e] 多轮后判定通过：三行标记留痕，目标「已完成」，队列恢复逐条自动发出"
    );

    // ---- 6) 两条脚本线都未越界（含互锁哨兵：排队消息没有抢在目标完成前发出） ----
    for (const sentinel of [WORK_SENTINEL, VERDICT_SENTINEL]) {
      assert(
        (await window.getByText(sentinel, { exact: true }).count()) === 0,
        `不应出现哨兵文本：${sentinel}`
      );
    }
    // 请求时序：首轮 → 判定 → 续跑 → 判定 → 续跑 → 判定 → 两条排队消息
    assert(
      same(seenBodies.map(classify), [
        "工作轮:建立任务",
        `工作轮:${GOAL_TEXT.slice(0, 6)}`,
        "判定",
        "续跑轮",
        "判定",
        "续跑轮",
        "判定",
        "工作轮:补充甲",
        "工作轮:补充乙",
      ]),
      `请求时序不符：${JSON.stringify(seenBodies.map(classify))}`
    );
    assert(
      requestCount() === 9,
      `建任务 + 首轮 + 两次续跑 + 三次判定 + 两条排队应恰好 9 个请求（实际 ${requestCount()}）`
    );

    // ---- 7) 公开 IPC 可读：三轮验证记录、续跑指令以独立角色落库 ----
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
            round: item.verification.round,
            outcome: item.verification.outcome,
            passed: item.verification.passed,
            nextAction: item.verification.nextAction,
          })),
        messageRoles: items
          .filter((item) => item.kind === "message")
          .map((item) => item.message.role),
        taskStatus: (await window.codexlike.tasks.list()).find(
          (task) => task.id === id
        ).status,
      };
    }, taskId);
    assert(persisted.goal?.status === "completed", "目标状态应为已完成");
    assert(
      same(
        persisted.verifications.map((record) => [record.round, record.outcome]),
        [
          [1, "unpassed"],
          [2, "unpassed"],
          [3, "passed"],
        ]
      ),
      `三轮验证记录不符：${JSON.stringify(persisted.verifications)}`
    );
    assert(
      persisted.verifications[2]?.passed === true &&
        persisted.verifications[2]?.nextAction === "",
      "通过的验证记录应为 passed 且没有下一步方向"
    );
    // 续跑指令以独立角色落库（不是用户消息）；排队消息在目标完成后才发出
    assert(
      same(persisted.messageRoles, [
        "user",
        "assistant",
        "user",
        "assistant",
        "goal-continuation",
        "assistant",
        "goal-continuation",
        "assistant",
        "user",
        "assistant",
        "user",
        "assistant",
      ]),
      `消息角色序列不符：${JSON.stringify(persisted.messageRoles)}`
    );
    assert(
      persisted.taskStatus === "idle",
      "目标完成后任务应回到空闲（任务侧状态四值不变）"
    );
    console.log(
      "[e2e] 落库可读：三轮验证记录、两轮续跑指令（独立角色），任务回到空闲"
    );

    // ---- 8) 重启后标记行由落库数据恢复，续跑轮仍不呈现为用户消息 ----
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
        .getAttribute("data-goal-status")) === "completed",
      "重启后目标应保持「已完成」"
    );
    assert(
      same(await markerTexts(window), [MARKER_1, MARKER_2, MARKER_3]),
      `重启后三行标记应由落库数据恢复（实际 ${JSON.stringify(await markerTexts(window))}）`
    );
    assert(
      (await window.getByTestId("goal-verifying-marker").count()) === 0,
      "重启后不应出现「验证中」占位行（占位不落库）"
    );
    assert(
      same(await userBubbleTexts(window), [
        "建立任务",
        GOAL_TEXT,
        "补充甲",
        "补充乙",
      ]),
      `重启后用户消息应只有四条（续跑轮不是用户消息；实际 ${JSON.stringify(await userBubbleTexts(window))}）`
    );

    await closeApp(app);
    app = undefined;
    console.log("[e2e] 重启恢复：三行标记留痕可回看，续跑轮仍不呈现为用户消息");
    console.log("[e2e] 目标模式续跑循环场景通过 ✅");
  } catch (error) {
    console.error("[e2e] 目标模式续跑循环场景失败 ❌", error);
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
