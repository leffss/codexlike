// E2E（goal-mode 票 02，ADR 0035）：目标模式最小闭环的真实应用冒烟。
// 场景：/goal 设定 → 一轮 → 完成判定通过 → 已完成（含输入队列互锁与恢复断言），
// 外加 Stop = 暂停、暂停后回到普通对话、重启后目标与验证记录可读。
// 断言只经真实界面、公开 IPC 与外部请求（stub 两条脚本化线，见 goal-stub.mjs）：
// 1) 命令菜单能发现 /goal；空目标只给用法提示、不产生目标；
// 2) 设定走本地命令反馈，原文以用户消息呈现，进度行「进行中」（摘要 / 状态 / 时长），
//    侧栏照常显示运行中（占任务并发一席口径不变）；
// 3) 回复进行中入队两条 → 回合结束、判定在途期间不发出；判定通过 → 标记行
//    「第 1 次迭代 · 已完成」、进度行「已完成」→ 队列恢复逐条自动发出；
// 4) Stop 在目标进行中 = 暂停：目标转「已暂停」不丢失、不判定、不自行续跑；
//    暂停后的普通消息不触发判定；
// 5) 重启后进度行与标记行由落库数据恢复。
// 运行：pnpm test:e2e:goal（先 pnpm build）。
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
import {
  GOAL_VERIFICATION_MARKER,
  startGoalMockProvider,
} from "./goal-stub.mjs";

const GOAL_TEXT = "让示例测试全部通过";
const SECOND_GOAL_TEXT = "第二个目标：慢速任务";
const WORK_SENTINEL = "工作轮脚本越界哨兵";
const VERDICT_SENTINEL = "判定线越界哨兵";

/** 判定请求在 mock 侧的挂起时长：期间队列不得被消费（互锁窗口） */
const VERDICT_HOLD_MS = 800;

const PASSED = { passed: true, reason: "示例测试已全部通过", nextAction: "" };

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

/** 首个以指定文本为最后一条用户消息的请求序号（未出现为 -1） */
function requestIndexOf(seenBodies, text) {
  return seenBodies.findIndex((body) => lastUserText(body) === text);
}

async function sendAndAwait(window, text, reply) {
  await window.getByTestId("composer-input").fill(text);
  await window.getByTestId("composer-send").click();
  await window
    .getByTestId("message-assistant")
    .getByText(reply, { exact: true })
    .waitFor({ timeout: 20_000 });
}

async function main() {
  /** 判定是否已应答：工作轮脚本据此识别「排队消息是否抢在目标完成前发出」 */
  let verdictAnswered = false;
  const { server, port, seenBodies, requestCount } =
    await startGoalMockProvider({
      // 工作轮脚本（index 只数工作轮请求）：
      // ① 建任务；② 目标首轮（慢速流，留出入队窗口）；③④ 排队消息的消费；
      // ⑤ 第二个目标的首轮（慢速流，供点停止）；⑥ 暂停后的普通消息；其余哨兵。
      work(ctx, { index }) {
        if (index === 1) return ctx.textRound("任务已建立");
        if (index === 2)
          return ctx.textChunksRound(
            Array.from({ length: 20 }, (_, i) => `首轮第${i}段。`),
            250
          );
        // 互锁哨兵：「补充甲」若在判定应答之前到达，说明排队消息抢在目标完成前
        // 被发出——回哨兵文本，场景末尾的哨兵断言据此失败。
        if (index === 3 && !verdictAnswered)
          return ctx.textRound(WORK_SENTINEL);
        if (index === 3) return ctx.textRound("甲的处理结果");
        if (index === 4) return ctx.textRound("乙的处理结果");
        if (index === 5)
          return ctx.textChunksRound(
            Array.from({ length: 20 }, (_, i) => `慢速第${i}段。`),
            250
          );
        if (index === 6) return ctx.textRound("暂停后的普通回复");
        return ctx.textRound(WORK_SENTINEL);
      },
      // 判定脚本（index 只数判定请求）：① 挂起后以代码围栏形态给通过结论
      // （真实链路上验证解析容错）；其余哨兵——Stop 路径与暂停后的消息都不该判定。
      verdict(ctx, { index }) {
        if (index === 1) {
          setTimeout(() => {
            verdictAnswered = true;
            ctx.verdictRound(PASSED, "code-fence");
          }, VERDICT_HOLD_MS);
          return;
        }
        return ctx.verdictRound(
          { passed: false, reason: VERDICT_SENTINEL, nextAction: "无" },
          "raw"
        );
      },
    });
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-goal-"));
  mkdirSync(join(homeDir, "workspace"));

  let app;
  try {
    const first = await launchApp({ homeDir });
    app = first.app;
    let window = first.window;
    await createMockProfile(window, { name: "Mock", port });
    await prepareDraft(window, { approvalMode: "assist" });

    // ---- 0) 建任务；初始态：没有目标时不出现进度行 ----
    await sendAndAwait(window, "建立任务", "任务已建立");
    await window.getByTestId("composer-send").waitFor({ timeout: 10_000 });
    assert(
      (await window.getByTestId("goal-progress-row").count()) === 0,
      "未设定目标时不应出现目标进度行"
    );

    // ---- 1) 命令菜单能发现 /goal；空目标只给用法提示、不产生目标 ----
    const composer = window.getByTestId("composer-input");
    await composer.fill("/go");
    const menu = window.getByTestId("composer-menu");
    await menu.waitFor({ timeout: 5_000 });
    assert(
      (await menu.textContent())?.includes("/goal") === true,
      "命令菜单未展示 /goal"
    );
    await composer.fill("/goal   ");
    await menu.waitFor({ state: "hidden", timeout: 5_000 });
    await composer.press("Enter");
    await window
      .getByText("用法：/goal 目标描述（建议写明期望结果、约束与验证方式）", {
        exact: true,
      })
      .first()
      .waitFor({ timeout: 5_000 });
    assert(
      (await window.getByTestId("goal-progress-row").count()) === 0,
      "空目标不应产生目标"
    );
    console.log("[e2e] 命令菜单可见 /goal；空目标只给用法提示，不产生目标");

    // ---- 2) /goal 设定：本地命令反馈 + 原文作为用户消息 + 进度行「进行中」 ----
    await composer.fill(`/goal ${GOAL_TEXT}`);
    await composer.press("Enter");
    await window
      .getByText("已设定目标，进入目标模式：每轮回复结束后自动进行完成判定", {
        exact: true,
      })
      .first()
      .waitFor({ timeout: 5_000 });
    // 设定即触发首轮：目标原文作为用户消息呈现（不含命令前缀）
    await window
      .getByTestId("message-user")
      .filter({ hasText: GOAL_TEXT })
      .waitFor({ timeout: 10_000 });
    assert(
      (await window.getByTestId("message-user").last().textContent()) ===
        GOAL_TEXT,
      "目标原文应原样作为用户消息呈现"
    );
    const row = window.getByTestId("goal-progress-row");
    await row.waitFor({ timeout: 10_000 });
    assert(
      (await row.getAttribute("data-goal-status")) === "active",
      "设定后目标应为「进行中」"
    );
    assert(
      (await window.getByTestId("goal-progress-status").textContent()) ===
        "进行中",
      "进度行状态应为「进行中」"
    );
    assert(
      (await window.getByTestId("goal-progress-summary").textContent()) ===
        GOAL_TEXT,
      "进度行摘要应为有目标原文"
    );
    assert(
      (await window.getByTestId("goal-progress-elapsed").textContent()) !==
        null &&
        (await window.getByTestId("goal-progress-elapsed").textContent()) !==
          "",
      "进度行应显示累计时长"
    );
    assert(
      (await window.getByTestId("goal-progress-round").textContent()) ===
        "第 1 轮",
      "设定后进度行应为「第 1 轮」"
    );
    // 任务侧口径照旧：首轮进行中，侧栏显示运行中（占任务并发一席）
    await window
      .getByTestId("message-assistant")
      .getByText("首轮第0段。", { exact: true })
      .waitFor({ timeout: 15_000 });
    assert(
      (
        await window.getByTestId("task-activity").first().textContent()
      )?.includes("运行中") === true,
      "目标首轮进行中，侧栏应照常显示运行中"
    );
    console.log(
      "[e2e] /goal 设定：命令反馈可见，原文入消息流，进度行「进行中」，侧栏照常运行中"
    );

    // ---- 3) 回复进行中入队两条：队列条显示；回合结束、判定在途不发出 ----
    await composer.fill("补充甲");
    await composer.press("Enter");
    await composer.fill("补充乙");
    await composer.press("Enter");
    await window
      .getByTestId("queue-count")
      .getByText("待发 2 条")
      .waitFor({ timeout: 10_000 });
    // 判定在途窗口（判定脚本挂起 800ms）：排队消息不得被发出——由工作轮脚本的
    // 互锁哨兵在场景末尾断言（抢发时「补充甲」的回复会是哨兵文本）。
    await window
      .getByTestId("goal-verification-marker")
      .waitFor({ timeout: 30_000 });
    // 标记行与进度行
    assert(
      (await window.getByTestId("goal-verification-marker").textContent()) ===
        "第 1 次迭代 · 已完成",
      "消息流应出现「第 1 次迭代 · 已完成」标记行"
    );
    assert(
      (await row.getAttribute("data-goal-status")) === "completed",
      "判定通过后目标应为「已完成」"
    );
    assert(
      (await window.getByTestId("goal-progress-status").textContent()) ===
        "已完成",
      "进度行状态应为「已完成」"
    );
    assert(
      (await window.getByTestId("goal-progress-round").textContent()) ===
        "第 1 轮",
      "判定通过后进度行应为「第 1 轮」"
    );
    console.log(
      "[e2e] 首轮结束自动判定通过：标记行「第 1 次迭代 · 已完成」，目标「已完成」；判定在途队列未发出"
    );

    // ---- 4) 终态后队列恢复：逐条自动发出（发一条、等回复、再发下一条） ----
    await window
      .getByTestId("message-assistant")
      .getByText("甲的处理结果", { exact: true })
      .waitFor({ timeout: 30_000 });
    await window
      .getByTestId("message-assistant")
      .getByText("乙的处理结果", { exact: true })
      .waitFor({ timeout: 30_000 });
    await window.getByTestId("queue-bar").waitFor({
      state: "detached",
      timeout: 10_000,
    });
    await window.getByTestId("composer-send").waitFor({ timeout: 10_000 });
    // 请求时序：判定请求先于两条排队消息的工作轮请求
    const verdictAt = seenBodies.findIndex((body) =>
      body.includes(GOAL_VERIFICATION_MARKER)
    );
    const firstQueuedAt = requestIndexOf(seenBodies, "补充甲");
    assert(verdictAt > 0, "应有一次判定请求");
    assert(firstQueuedAt > verdictAt, "排队消息应在判定之后才发出");
    assert(
      requestCount() === 5,
      `建任务 + 首轮 + 判定 + 两条排队应恰好 5 个请求（实际 ${requestCount()}）`
    );
    // 用户消息按序进入消息流
    const userTexts = await window.evaluate(async () => {
      const [task] = await window.codexlike.tasks.list();
      return (await window.codexlike.tasks.messages(task.id))
        .filter(
          (item) => item.kind === "message" && item.message.role === "user"
        )
        .map((item) => item.message.content);
    });
    assert(
      JSON.stringify(userTexts) ===
        JSON.stringify(["建立任务", GOAL_TEXT, "补充甲", "补充乙"]),
      `用户消息顺序不符：${JSON.stringify(userTexts)}`
    );
    // 任务侧状态四值不变：目标完成后任务回到空闲
    assert(
      (await window.evaluate(
        async () => (await window.codexlike.tasks.list())[0].status
      )) === "idle",
      "目标完成后任务应回到空闲"
    );
    console.log(
      "[e2e] 目标完成后输入队列恢复：两条排队消息逐条自动发出，任务回到空闲"
    );

    // ---- 5) Stop 在目标进行中 = 暂停 ----
    await composer.fill(`/goal ${SECOND_GOAL_TEXT}`);
    await composer.press("Enter");
    await window
      .getByTestId("message-assistant")
      .getByText("慢速第0段。", { exact: true })
      .waitFor({ timeout: 15_000 });
    assert(
      (await row.getAttribute("data-goal-status")) === "active",
      "第二个目标设定后应「进行中」"
    );
    await window.getByTestId("composer-stop").click();
    await window
      .getByText("（已中断，以上为部分回复）", { exact: true })
      .first()
      .waitFor({ timeout: 10_000 });
    await window
      .getByTestId("goal-progress-status")
      .getByText("已暂停", { exact: true })
      .waitFor({ timeout: 10_000 });
    assert(
      (await row.getAttribute("data-goal-status")) === "paused",
      "停止后目标应为「已暂停」"
    );
    assert(
      (await window.getByTestId("goal-progress-summary").textContent()) ===
        SECOND_GOAL_TEXT,
      "暂停后目标不丢失"
    );
    // 中断的回合不判定；标记行仍是此前那一行
    assert(
      (await window.getByTestId("goal-verification-marker").count()) === 1,
      "停止不应产生新的判定标记行"
    );
    const afterStop = requestCount();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert(
      requestCount() === afterStop,
      "暂停后不得自行续跑（不应有新的模型请求）"
    );
    assert(
      (await row.getAttribute("data-goal-status")) === "paused",
      "暂停后目标应保持「已暂停」"
    );
    console.log(
      "[e2e] Stop = 暂停：目标转「已暂停」且不丢失，不判定、不自行续跑"
    );

    // ---- 6) 暂停后回到普通对话：普通消息不触发完成判定 ----
    await sendAndAwait(window, "暂停后的普通消息", "暂停后的普通回复");
    await window.getByTestId("composer-send").waitFor({ timeout: 10_000 });
    assert(
      seenBodies.filter((body) => body.includes(GOAL_VERIFICATION_MARKER))
        .length === 1,
      "目标已暂停，普通消息不应触发完成判定"
    );
    assert(
      requestCount() === 7,
      `暂停后的普通消息只应多一次工作轮请求（实际 ${requestCount()}）`
    );

    // ---- 7) 两条脚本线都未越界 ----
    for (const sentinel of [WORK_SENTINEL, VERDICT_SENTINEL]) {
      assert(
        (await window.getByText(sentinel, { exact: true }).count()) === 0,
        `不应出现哨兵文本：${sentinel}`
      );
    }
    assert(
      (await window.getByTestId("goal-verification-marker").textContent()) ===
        "第 1 次迭代 · 已完成",
      "标记行应保持「第 1 次迭代 · 已完成」"
    );
    const taskId = await window.evaluate(
      async () => (await window.codexlike.tasks.list())[0].id
    );

    // ---- 8) 重启后目标与验证记录随任务落库可读：进度行与标记行由落库数据恢复 ----
    await closeApp(app);
    const second = await launchApp({ homeDir });
    app = second.app;
    window = second.window;
    await window.getByTestId("task-item").first().waitFor({ timeout: 15_000 });
    await window.getByTestId("task-item").first().click();
    const restoredRow = window.getByTestId("goal-progress-row");
    await restoredRow.waitFor({ timeout: 10_000 });
    assert(
      (await restoredRow.getAttribute("data-goal-status")) === "paused",
      "重启后目标应保持「已暂停」"
    );
    assert(
      (await window.getByTestId("goal-progress-summary").textContent()) ===
        SECOND_GOAL_TEXT,
      "重启后目标原文不丢失"
    );
    assert(
      (await window.getByTestId("goal-progress-round").textContent()) ===
        "第 1 轮",
      "重启后进度行应恢复「第 1 轮」（第二个目标尚未完成判定）"
    );
    assert(
      (await window.getByTestId("goal-verification-marker").textContent()) ===
        "第 1 次迭代 · 已完成",
      "重启后标记行应由落库数据恢复"
    );
    // 公开 IPC 可读：view 携带目标，任务时间线含验证记录
    const persisted = await window.evaluate(async (id) => {
      const view = await window.codexlike.tasks.view(id);
      const verifications = (await window.codexlike.tasks.messages(id)).filter(
        (item) => item.kind === "goal-verification"
      );
      return {
        goal: view.goal,
        verifications,
      };
    }, taskId);
    assert(
      persisted.goal?.text === SECOND_GOAL_TEXT,
      "view.goal 应带当前目标原文"
    );
    assert(persisted.goal?.status === "paused", "view.goal 状态应为已暂停");
    assert(
      persisted.verifications.length === 1 &&
        persisted.verifications[0].verification.round === 1 &&
        persisted.verifications[0].verification.passed === true,
      "任务时间线应含第 1 轮通过的验证记录"
    );

    await closeApp(app);
    console.log(
      "[e2e] 重启恢复：进度行「已暂停」与标记行由落库数据恢复，目标与验证记录可读"
    );
    console.log("[e2e] 目标模式最小闭环场景通过 ✅");
  } catch (error) {
    console.error("[e2e] 目标模式最小闭环场景失败 ❌", error);
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
