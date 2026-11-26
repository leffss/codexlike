// E2E（ADR 0035）：新建任务页 /goal 全链路。
// 场景：新建任务页（任务尚不存在）输入 /goal → 建任务即设目标 → 目标原文作为
// 首条用户消息开跑 → 首轮结束自动判定未过 → 续跑轮 → 判定通过 → 已完成；
// 另验证被拦命令（/status）提示后输入原样保留、不建任务。
// 断言只经真实界面、公开 IPC 与外部请求（stub 两条脚本化线，见 goal-stub.mjs）：
// 1) 新建任务页输 /status：提示「该命令需要先选择一个任务」，输入保留、不产生任务；
// 2) /goal 提交即建任务（只建一个）、目标「进行中」、进度行摘要为目标原文；
//    目标原文是唯一一条用户消息——不在建任务消息之后重复发送；
// 3) 首轮结束判定未过 → 标记行「未完成 · 下一步：补充恢复步骤」→ 自动续跑；
// 4) 续跑轮结束判定通过 → 标记行「已完成」、进度行「已完成」，用户消息仍只有目标原文；
// 5) 回到新建任务页：输入框为空（/goal 文本随建任务由宿主消费）；
// 6) 两条脚本线都未越界（哨兵文本不出现）。
// 运行：pnpm test:e2e:goal-new-task（先 pnpm build）。
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

const GOAL_TEXT = "写一个mysql备份脚本";
const WORK_SENTINEL = "工作轮脚本越界哨兵";
const VERDICT_SENTINEL = "判定线越界哨兵";

/** 指定任务的用户消息原文（按进入任务的顺序） */
function userTextsOf(window, taskId) {
  return window.evaluate(async (id) => {
    const items = await window.codexlike.tasks.messages(id);
    return items
      .filter((item) => item.kind === "message" && item.message.role === "user")
      .map((item) => item.message.content);
  }, taskId);
}

async function main() {
  const { server, port } = await startGoalMockProvider({
    // 工作轮脚本（index 只数工作轮请求）：① 首轮（慢速流，留出「进行中」窗口）；
    // ② 判定未过后的续跑轮（同样慢速，留出「仍在进行中」窗口）
    work(ctx, { index }) {
      if (index === 1)
        return ctx.textChunksRound(
          Array.from({ length: 12 }, (_, i) => `首轮第${i}段。`),
          200
        );
      if (index === 2)
        return ctx.textChunksRound(
          Array.from({ length: 10 }, (_, i) => `续跑第${i}段。`),
          200
        );
      return ctx.textRound(WORK_SENTINEL);
    },
    // 判定脚本（index 只数判定请求）：① 未过并给下一步方向；② 通过
    verdict(ctx, { index }) {
      if (index === 1)
        return ctx.verdictRound(
          { passed: false, reason: "缺少恢复步骤", nextAction: "补充恢复步骤" },
          "raw"
        );
      if (index === 2)
        return ctx.verdictRound(
          { passed: true, reason: "脚本与恢复步骤齐备", nextAction: "" },
          "raw"
        );
      return ctx.verdictRound(
        { passed: false, reason: VERDICT_SENTINEL, nextAction: "无" },
        "raw"
      );
    },
  });
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-goal-new-task-"));
  mkdirSync(join(homeDir, "workspace"));

  let app;
  try {
    const first = await launchApp({ homeDir });
    app = first.app;
    const window = first.window;
    await createMockProfile(window, { name: "Mock", port });
    await prepareDraft(window, { approvalMode: "assist" });
    const composer = window.getByTestId("composer-input");

    // ---- 0) 新建任务页被拦命令：提示后输入保留、不建任务 ----
    await composer.fill("/status");
    await composer.press("Enter");
    await window
      .getByText("该命令需要先选择一个任务", { exact: true })
      .first()
      .waitFor({ timeout: 5_000 });
    assert(
      (await composer.inputValue()) === "/status",
      "被拦命令的输入应原样保留"
    );
    assert(
      (await window.evaluate(
        async () => (await window.codexlike.tasks.list()).length
      )) === 0,
      "被拦命令不应建任务"
    );
    console.log("[e2e] 新建任务页 /status 被拦：提示可见、输入保留、不建任务");

    // ---- 1) /goal 在新建任务页：建任务即设目标，目标原文作首条用户消息 ----
    await composer.fill(`/goal ${GOAL_TEXT}`);
    await composer.press("Enter");
    await window
      .getByTestId("message-user")
      .filter({ hasText: GOAL_TEXT })
      .waitFor({ timeout: 15_000 });
    const row = window.getByTestId("goal-progress-row");
    await row.waitFor({ timeout: 10_000 });
    assert(
      (await row.getAttribute("data-goal-status")) === "active",
      "建任务后目标应为「进行中」"
    );
    assert(
      (await window.getByTestId("goal-progress-summary").textContent()) ===
        GOAL_TEXT,
      "进度行摘要应为目标原文"
    );
    // 只建一个任务；目标原文是唯一一条用户消息（没有重复发送）
    const tasks = await window.evaluate(
      async () => await window.codexlike.tasks.list()
    );
    assert(tasks.length === 1, `应只建一个任务（实际 ${tasks.length}）`);
    const userTexts = await userTextsOf(window, tasks[0].id);
    assert(
      JSON.stringify(userTexts) === JSON.stringify([GOAL_TEXT]),
      `用户消息应只有目标原文：${JSON.stringify(userTexts)}`
    );
    console.log(
      "[e2e] 新建任务页 /goal：建任务即设目标，目标原文作为唯一一条用户消息发出首轮"
    );

    // ---- 2) 首轮结束 → 判定未过 → 标记行附下一步 → 自动续跑 ----
    const firstMarker = window.getByTestId("goal-verification-marker").first();
    await firstMarker.waitFor({ timeout: 30_000 });
    assert(
      (await firstMarker.getAttribute("data-goal-verdict")) === "unpassed",
      "首轮判定应为「未完成」"
    );
    await firstMarker
      .getByTestId("goal-verification-next-step")
      .getByText("下一步：补充恢复步骤", { exact: false })
      .waitFor({ timeout: 5_000 });
    assert(
      (await row.getAttribute("data-goal-status")) === "active",
      "判定未过后目标应保持「进行中」"
    );

    // ---- 3) 续跑轮 → 判定通过 → 已完成 ----
    await window
      .getByTestId("message-assistant")
      .getByText("续跑第0段。", { exact: true })
      .waitFor({ timeout: 20_000 });
    await window
      .getByTestId("goal-progress-status")
      .getByText("已完成", { exact: true })
      .waitFor({ timeout: 30_000 });
    assert(
      (await row.getAttribute("data-goal-status")) === "completed",
      "判定通过后目标应为「已完成」"
    );
    const markers = window.getByTestId("goal-verification-marker");
    assert((await markers.count()) === 2, "两轮判定应留下两行标记");
    assert(
      (await markers.nth(1).getAttribute("data-goal-verdict")) === "passed",
      "第二轮判定应为「已完成」"
    );
    // 续跑轮是无用户气泡的内部输入：用户消息仍只有目标原文
    const afterTexts = await userTextsOf(window, tasks[0].id);
    assert(
      JSON.stringify(afterTexts) === JSON.stringify([GOAL_TEXT]),
      `续跑轮不应产生用户消息：${JSON.stringify(afterTexts)}`
    );
    console.log(
      "[e2e] 首轮未过自动续跑、第二轮通过：两行标记留痕，目标「已完成」"
    );

    // ---- 4) 草稿文本随建任务被宿主消费：回到新建任务页输入框为空 ----
    await window.getByTestId("new-task").click();
    await window.getByTestId("draft-select-workspace").waitFor({
      timeout: 10_000,
    });
    assert(
      (await window.getByTestId("composer-input").inputValue()) === "",
      "建任务后新建任务页的输入框应为空（/goal 文本随建任务消费）"
    );
    console.log("[e2e] 回到新建任务页：/goal 输入已随建任务消费，输入框为空");

    // ---- 5) 两条脚本线都未越界 ----
    for (const sentinel of [WORK_SENTINEL, VERDICT_SENTINEL]) {
      assert(
        (await window.getByText(sentinel, { exact: true }).count()) === 0,
        `不应出现哨兵文本：${sentinel}`
      );
    }
    await closeApp(app);
    console.log("[e2e] 新建任务页 /goal 全链路场景通过 ✅");
  } catch (error) {
    console.error("[e2e] 新建任务页 /goal 全链路场景失败 ❌", error);
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
