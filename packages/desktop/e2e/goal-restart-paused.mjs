// E2E（goal-mode 票 06，ADR 0035「重启与恢复」）：目标进行中时应用被强杀，
// 重启后恢复为「已暂停」，由用户手动恢复——不自动续跑、不产生任何模型消耗。
// 场景脚本（stub 两条线，见 goal-stub.mjs；index 各线独立计数）：
//   工作轮：① 建任务 ② 目标首轮 ③ 续跑轮（挂起不应答：强杀点）
//           [强杀 → 重启] ④ 重启后用户手发的一条普通消息
//           ⑤ 点恢复后的续跑轮（慢速流）
//   判定轮：① 未过（给下一步方向）② 通过
// 强杀手法沿用 subagent-interrupted：续跑轮请求在 mock 挂起（应用停在运行中），
// taskkill /T /F 强杀进程树（真实被杀路径，不走退出确认屏障），同 homeDir 重启。
// 断言只经真实界面、公开 IPC 与外部请求：
// 1) 重启后目标「已暂停」：目标原文、标记行 / 验证记录完整；任务侧补记中断
//    提示、侧栏「已中断」未读提醒（与普通任务同口径，目标无特判）；
// 2) 累计时长闭合在停机前最后一次落库的活动上，不含停机时长，且此后不再增长；
// 3) 重启后到点恢复之前 stub 的请求数不增加（不续跑、不判定）；
// 4) 重启后用户手发的一条消息只是普通回合：回合结束不判定、不续跑；
// 5) 点恢复：以内部输入从暂停点续跑（不产生用户气泡）→ 判定通过 → 已完成。
// 运行：pnpm test:e2e:goal-restart-paused（先 pnpm build）。
import { execFile } from "node:child_process";
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
/** 恢复指令的稳定锚（buildGoalContinuationInput 的恢复段） */
const RESUME_ANCHOR = "目标此前被暂停，现已恢复";
/** 任务侧启动收尾补记的中断提示（agent-core createTaskManager） */
const RESTART_HINT = "上次执行因应用退出而中断";
const PLAIN_MESSAGE = "重启后的普通消息";
const UNPASSED = {
  passed: false,
  reason: "尚有步骤未完成",
  nextAction: "继续实现",
};
const PASSED = { passed: true, reason: "目标已达成", nextAction: "无" };

const MARKER_1 = "第 1 次迭代 · 未完成 · 下一步：继续实现";
const MARKER_2 = "第 2 次迭代 · 已完成";

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
 * 未到」的一个间隔内成立，等待的起点稍晚就永远等不到。
 */
const segments = (label, count) =>
  Array.from({ length: count }, (_, i) => `${label}第${i}段。\n\n`);

/** 强杀进程树（Windows taskkill /T /F，先例 subagent-interrupted / exit-recovery） */
async function killApp(app) {
  const child = app.process();
  const done = new Promise((resolve) => child.once("exit", () => resolve()));
  if (process.platform === "win32") {
    await new Promise((resolve) =>
      execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () =>
        resolve()
      )
    );
  } else {
    child.kill("SIGKILL");
  }
  await done;
}

/** 等待条件成立（轮询 + 截止期断言，exit-recovery until 同款） */
async function until(predicate, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    assert(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const markerTexts = (window) =>
  window.getByTestId("goal-verification-marker").allTextContents();
const userBubbleTexts = (window) =>
  window.getByTestId("message-user").allTextContents();
const progressStatus = (window) =>
  window.getByTestId("goal-progress-status").textContent();
const elapsedText = (window) =>
  window.getByTestId("goal-progress-elapsed").textContent();
const same = (actual, expected) =>
  JSON.stringify(actual) === JSON.stringify(expected);

async function waitAssistantText(window, text) {
  await window
    .getByTestId("message-assistant")
    .getByText(text, { exact: true })
    .waitFor({ timeout: 30_000 });
}

/** 侧栏首个任务的活动徽章文本（没有徽章 = 空闲且已查看） */
async function sidebarBadge(window) {
  const badge = window.getByTestId("task-activity").first();
  if ((await badge.count()) === 0) return null;
  return (await badge.textContent()) ?? null;
}

/**
 * 进度行按钮组的当前形态：不出现为 null，出现则取可用性（true 可用 / false 禁用）。
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
/** 已暂停：没有暂停，恢复可用，可编辑、可清除 */
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

/** 公开 IPC 可读的目标、验证记录与消息角色序列（当前任务） */
async function readGoalState(window) {
  return window.evaluate(async () => {
    const task = (await window.codexlike.tasks.list())[0];
    const items = await window.codexlike.tasks.messages(task.id);
    const messages = items.filter((item) => item.kind === "message");
    return {
      goal: (await window.codexlike.tasks.view(task.id)).goal,
      verifications: items
        .filter((item) => item.kind === "goal-verification")
        .map((item) => ({
          round: item.verification.round,
          outcome: item.verification.outcome,
          reason: item.verification.reason,
          nextAction: item.verification.nextAction,
        })),
      messageRoles: messages.map((item) => item.message.role),
      // 停机前最后一次有记录的活动：时间上最晚的一条落库消息
      lastMessageAt: messages
        .map((item) => item.message.createdAt)
        .sort()
        .at(-1),
    };
  });
}

async function main() {
  const { server, port, seenBodies, requestCount } =
    await startGoalMockProvider({
      work(ctx, { body }) {
        const text = lastUserText(body) ?? "";
        if (text === "建立任务") return ctx.textRound("任务已建立");
        if (text === GOAL_TEXT)
          // 首轮慢速流（约 3 秒）：回复落库明显晚于目标设定，重启后的累计时长
          // 在界面上是可见的非零值
          return ctx.textChunksRound(segments("首轮", 30), 100);
        if (text === PLAIN_MESSAGE) return ctx.textRound("普通消息的回答");
        if (text.includes(RESUME_ANCHOR))
          // 恢复后的那一轮用慢速流（约 6 秒）：留出「恢复后目标进行中」的观察窗口
          return ctx.textChunksRound(segments("恢复后续跑", 20), 300);
        if (text.includes(CONTINUATION_ANCHOR))
          // 判定未过后的续跑轮：挂起不答——应用停在运行中，等待被强杀。
          // 第一条 user 消息（目标原文）此刻已落库；这一轮的回复永远不会到达
          return undefined;
        return ctx.textRound(WORK_SENTINEL);
      },
      verdict(ctx, { index }) {
        if (index === 1) return ctx.verdictRound(UNPASSED, "raw");
        if (index === 2) return ctx.verdictRound(PASSED, "code-fence");
        return ctx.verdictRound(
          { passed: false, reason: VERDICT_SENTINEL, nextAction: "无" },
          "raw"
        );
      },
    });
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-goal-restart-"));
  mkdirSync(join(homeDir, "workspace"));

  let app;
  try {
    const first = await launchApp({ homeDir });
    app = first.app;
    let window = first.window;
    await createMockProfile(window, { name: "Mock", port });
    await prepareDraft(window, { approvalMode: "assist" });
    let composer = window.getByTestId("composer-input");
    let row = window.getByTestId("goal-progress-row");

    // ---- 0) 建任务 ----
    await composer.fill("建立任务");
    await composer.press("Enter");
    await waitAssistantText(window, "任务已建立");
    await window.getByTestId("composer-send").waitFor({ timeout: 10_000 });

    // ---- 1) /goal 设定：首轮结束 → 判定未过 → 续跑轮在途（挂起） ----
    await composer.fill(`/goal ${GOAL_TEXT}`);
    await composer.press("Enter");
    await waitAssistantText(window, "首轮第0段。");
    await row
      .and(window.locator('[data-goal-status="active"]'))
      .waitFor({ timeout: 15_000 });
    await window
      .getByTestId("goal-verification-marker")
      .filter({ hasText: MARKER_1 })
      .first()
      .waitFor({ timeout: 30_000 });
    // 续跑轮的工作请求到达 mock（应用停在运行中，等待被强杀）
    await until(
      () =>
        seenBodies.filter((body) => classify(body) === "续跑轮").length === 1,
      "判定未过后应发出续跑轮的工作请求"
    );
    await row
      .and(window.locator('[data-goal-status="active"]'))
      .waitFor({ timeout: 15_000 });
    assert(
      (await progressStatus(window)) === "进行中",
      `续跑轮进行中进度行状态应为「进行中」（实际 ${await progressStatus(window)}）`
    );
    assert(
      (await window.getByTestId("goal-progress-round").textContent()) ===
        "第 1 轮",
      "判定未过一轮后进度行应为「第 1 轮」"
    );
    assert(
      ((await sidebarBadge(window)) ?? "").includes("运行中"),
      `续跑轮进行中侧栏应显示运行中（实际 ${await sidebarBadge(window)}）`
    );
    assert(
      (await window.getByTestId("goal-verifying-marker").count()) === 0,
      "续跑轮进行中不应有「验证中」占位行"
    );
    // 停机前再多跑一会儿：让「强杀前的进行中时长」明显长于「闭合终点」
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const beforeKill = await readGoalState(window);
    const elapsedBeforeKill = await elapsedText(window);
    const requestsBeforeKill = requestCount();
    const killedAt = Date.now();
    assert(
      beforeKill.goal?.status === "active" &&
        beforeKill.goal.text === GOAL_TEXT,
      `强杀前目标应进行中且原文完整：${JSON.stringify(beforeKill.goal)}`
    );
    assert(
      same(beforeKill.messageRoles, [
        "user",
        "assistant",
        "user",
        "assistant",
        "goal-continuation",
      ]),
      `强杀前消息角色序列不符：${JSON.stringify(beforeKill.messageRoles)}`
    );
    console.log("[e2e] 续跑轮进行中（回复挂起）、判定未过一轮：强杀应用");

    // ---- 强杀进程树：真实被杀路径（不走退出确认屏障） ----
    await killApp(app);
    app = null;

    // ---- 2) 重启：目标「已暂停」，原文 / 标记行 / 验证记录完整 ----
    const second = await launchApp({ homeDir });
    app = second.app;
    window = second.window;
    // 定位器绑定在窗口上：重启后一律重新取
    composer = window.getByTestId("composer-input");
    row = window.getByTestId("goal-progress-row");
    const restartedAt = Date.now();
    // 任务侧口径：残留的 streaming 由启动收尾补记中断提示 → 侧栏「已中断」未读提醒
    // （与普通任务一致；冷启动自动恢复打开任务不算「查看」，提醒保留到显式打开）
    await until(
      async () => ((await sidebarBadge(window)) ?? "").includes("已中断"),
      "重启后侧栏应显示任务侧的「已中断」未读提醒"
    );
    assert(
      ((await sidebarBadge(window)) ?? "").includes("运行中") === false,
      "重启后目标任务不应再显示运行中（循环不在新进程里存活）"
    );
    await window.getByTestId("task-item").first().click();
    await row.waitFor({ timeout: 15_000 });
    await window
      .getByTestId("task-activity")
      .first()
      .waitFor({ state: "hidden", timeout: 15_000 });
    assert(
      (await row.getAttribute("data-goal-status")) === "paused",
      `重启后目标应为「已暂停」（实际 ${await row.getAttribute("data-goal-status")}）`
    );
    assert(
      (await progressStatus(window)) === "已暂停",
      `重启后进度行状态应为「已暂停」（实际 ${await progressStatus(window)}）`
    );
    assert(
      (await window.getByTestId("goal-progress-round").textContent()) ===
        "第 1 轮",
      "重启后进度行应由落库验证记录恢复「第 1 轮」"
    );
    assert(
      (await window.getByTestId("goal-progress-summary").textContent()) ===
        GOAL_TEXT,
      "重启后目标原文不丢失"
    );
    // 重启恢复的已暂停只显示「已暂停」：暂停说明不落库，没有停留原因
    assert(
      (await window.getByTestId("goal-progress-reason").count()) === 0,
      "重启恢复的已暂停目标不应显示停留原因"
    );
    assert(
      same(await controlState(window), RESUMABLE_CONTROLS),
      `重启后已暂停的按钮矩阵不符：${JSON.stringify(await controlState(window))}`
    );
    assert(
      same(await markerTexts(window), [MARKER_1]),
      `重启后标记行应由落库数据恢复（实际 ${JSON.stringify(await markerTexts(window))}）`
    );
    assert(
      (await window.getByTestId("goal-verifying-marker").count()) === 0,
      "重启后不应出现「验证中」占位行（占位不落库）"
    );
    // 任务侧补记的中断提示如实呈现（被杀的续跑轮没有回复，只有这条提示）
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: RESTART_HINT })
      .first()
      .waitFor({ timeout: 15_000 });
    assert(
      same(await userBubbleTexts(window), ["建立任务", GOAL_TEXT]),
      `重启后用户消息应只有两条（续跑轮不是用户消息；实际 ${JSON.stringify(await userBubbleTexts(window))}）`
    );
    const restarted = await readGoalState(window);
    assert(
      restarted.goal?.status === "paused" &&
        restarted.goal.id === beforeKill.goal.id &&
        restarted.goal.activeSince === null,
      `重启后目标记录不符：${JSON.stringify(restarted.goal)}`
    );
    assert(
      same(restarted.verifications, beforeKill.verifications),
      `重启后验证记录应与强杀前一致：${JSON.stringify(restarted.verifications)}`
    );
    assert(
      same(restarted.messageRoles, [...beforeKill.messageRoles, "assistant"]),
      `重启后消息角色序列不符（续跑指令后只应多出中断提示）：${JSON.stringify(restarted.messageRoles)}`
    );
    console.log(
      "[e2e] 重启恢复：目标「已暂停」，原文、标记行与验证记录完整；任务侧中断提示与未读提醒照常"
    );

    // ---- 3) 累计时长：闭合在停机前最后一次落库的活动上，不含停机时长 ----
    // 首段进行中自目标设定起算（此前没有闭合段）：进行中 = 续跑指令落库 − 设定。
    // 期望值取强杀前经公开 IPC 读到的最晚一条消息（续跑指令）的落库时刻。
    const expectedActiveMs =
      Date.parse(beforeKill.lastMessageAt) -
      Date.parse(beforeKill.goal.createdAt);
    assert(
      restarted.goal.activeMs === expectedActiveMs,
      `累计时长应闭合在续跑指令落库的时刻：期望 ${expectedActiveMs}ms，实际 ${restarted.goal.activeMs}ms`
    );
    // 停机不计：重启时补记的中断提示（时间戳是重启时刻）与「强杀 → 重启」之间
    // 的时长都没有算进去——累计时长不超过「强杀时刻 − 设定时刻」
    assert(
      Date.parse(restarted.lastMessageAt) >
        Date.parse(beforeKill.lastMessageAt),
      "重启时补记的中断提示应晚于停机前的最后一条消息"
    );
    assert(
      restarted.goal.activeMs <=
        killedAt - Date.parse(restarted.goal.createdAt),
      "累计时长不得计入停机时长（超过了强杀时刻）"
    );
    const elapsedAfterRestart = await elapsedText(window);
    // 界面层：重启后的累计时长就是首轮那 3 秒左右——强杀前一刻界面上多出的
    // 「续跑轮挂起的 2 秒」没有被算进去
    const secondsOf = (text) => Number.parseInt(text, 10);
    assert(
      secondsOf(elapsedAfterRestart) >= 3,
      `重启后累计时长应包含首轮的约 3 秒（实际 ${elapsedAfterRestart}）`
    );
    assert(
      secondsOf(elapsedAfterRestart) < secondsOf(elapsedBeforeKill),
      `重启后累计时长（${elapsedAfterRestart}）应短于强杀前一刻（${elapsedBeforeKill}）：挂起与停机的时间不计入`
    );
    // 不再处于进行中：界面上的累计时长不再增长
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert(
      (await elapsedText(window)) === elapsedAfterRestart,
      `重启后目标已暂停，累计时长不应继续增长（${elapsedAfterRestart} → ${await elapsedText(window)}）`
    );
    console.log(
      `[e2e] 累计时长闭合在停机前：强杀前 ${elapsedBeforeKill} → 重启后 ${elapsedAfterRestart}（停机 ${Math.round((restartedAt - killedAt) / 100) / 10} 秒不计入），此后不再增长`
    );

    // ---- 4) 不点恢复：没有任何模型请求（不续跑、不判定） ----
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert(
      requestCount() === requestsBeforeKill,
      `重启后到点恢复之前不应有任何模型请求（强杀前 ${requestsBeforeKill}，实际 ${requestCount()}）`
    );
    console.log("[e2e] 重启后不点恢复：请求数不增加（不续跑、不判定）");

    // ---- 5) 重启后用户手发的一条消息只是普通回合：不判定、不续跑 ----
    await composer.fill(PLAIN_MESSAGE);
    await composer.press("Enter");
    await waitAssistantText(window, "普通消息的回答");
    await window.getByTestId("composer-send").waitFor({ timeout: 15_000 });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert(
      requestCount() === requestsBeforeKill + 1,
      `手发的消息只应产生它自己的工作轮请求（期望 ${requestsBeforeKill + 1}，实际 ${requestCount()}）`
    );
    assert(
      seenBodies.filter((body) => classify(body) === "判定").length === 1,
      "重启后普通回合结束不应发起完成判定"
    );
    assert(
      (await row.getAttribute("data-goal-status")) === "paused",
      "重启后的普通回合不应把目标带回循环（目标应保持已暂停）"
    );
    assert(
      same(await markerTexts(window), [MARKER_1]),
      "重启后的普通回合不应新增标记行"
    );
    console.log(
      "[e2e] 重启后手发消息：普通回合运行，不判定、不续跑，目标保持已暂停"
    );

    // ---- 6) 点恢复：从暂停点续跑（内部输入，不产生用户气泡）→ 判定通过 → 已完成 ----
    const pausedGoal = (await readGoalState(window)).goal;
    const requestsBeforeResume = requestCount();
    await window.getByTestId("goal-resume").click();
    // 恢复即回到「进行中」并以内部输入发起续跑轮（慢速流进行中）。观察点先看
    // 状态，再看文本与反馈：不把任何等待排在状态观察之前。
    await row
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
    assert(
      ((await sidebarBadge(window)) ?? "").includes("运行中"),
      "恢复后侧栏应显示运行中"
    );
    await waitAssistantText(window, "恢复后续跑第0段。");
    await window
      .getByTestId("command-feedback")
      .filter({ hasText: "目标已恢复" })
      .first()
      .waitFor({ timeout: 5_000 });
    await row
      .and(window.locator('[data-goal-status="completed"]'))
      .waitFor({ timeout: 30_000 });
    await window.getByTestId("composer-send").waitFor({ timeout: 15_000 });
    assert(
      (await progressStatus(window)) === "已完成",
      `恢复后的循环最终判定通过，进度行应为「已完成」（实际 ${await progressStatus(window)}）`
    );
    assert(
      (await window.getByTestId("goal-progress-round").textContent()) ===
        "第 2 轮",
      "恢复后判定通过，进度行应为「第 2 轮」"
    );
    assert(
      same(await markerTexts(window), [MARKER_1, MARKER_2]),
      `恢复后标记行应为未过一轮加已完成一轮（实际 ${JSON.stringify(await markerTexts(window))}）`
    );
    assert(
      same(await controlState(window), COMPLETED_CONTROLS),
      `已完成的按钮矩阵不符：${JSON.stringify(await controlState(window))}`
    );
    assert(
      same(await userBubbleTexts(window), [
        "建立任务",
        GOAL_TEXT,
        PLAIN_MESSAGE,
      ]),
      `恢复后的续跑轮不应产生用户气泡（实际 ${JSON.stringify(await userBubbleTexts(window))}）`
    );
    const done = await readGoalState(window);
    assert(
      done.goal?.status === "completed" &&
        done.goal.activeMs >= pausedGoal.activeMs,
      `恢复后累计时长应延续：${JSON.stringify(done.goal)}`
    );
    assert(
      same(
        done.verifications.map((record) => [record.round, record.outcome]),
        [
          [1, "unpassed"],
          [2, "passed"],
        ]
      ),
      `验证记录不符：${JSON.stringify(done.verifications)}`
    );
    assert(
      same(done.messageRoles.slice(-2), ["goal-continuation", "assistant"]),
      `恢复后的续跑轮应以独立角色落库：${JSON.stringify(done.messageRoles)}`
    );
    // 请求时序：建任务 → 首轮 → 判定 → 续跑轮（被杀）→ 手发的消息 → 恢复的
    // 续跑轮 → 判定
    assert(
      same(seenBodies.map(classify), [
        "工作轮:建立任",
        `工作轮:${GOAL_TEXT.slice(0, 3)}`,
        "判定",
        "续跑轮",
        `工作轮:${PLAIN_MESSAGE.slice(0, 3)}`,
        "续跑轮",
        "判定",
      ]),
      `请求时序不符：${JSON.stringify(seenBodies.map(classify))}`
    );
    assert(
      requestCount() - requestsBeforeResume === 2,
      `恢复之后应恰好 2 个请求（恢复的续跑轮、判定；实际 ${requestCount() - requestsBeforeResume}）`
    );
    // 两个续跑轮请求里只有恢复后的那个带恢复指令（按各自最后一条 user 消息判别）
    const resumedInputs = seenBodies
      .filter((body) => classify(body) === "续跑轮")
      .map((body) => (lastUserText(body) ?? "").includes(RESUME_ANCHOR));
    assert(
      same(resumedInputs, [false, true]),
      `续跑轮请求里应只有恢复后的首轮带恢复指令（实际 ${JSON.stringify(resumedInputs)}）`
    );
    console.log(
      "[e2e] 点恢复：从暂停点续跑（无用户气泡）→ 判定通过 → 已完成，累计时长与验证记录延续"
    );

    // ---- 7) 两条脚本线都未越界 ----
    for (const sentinel of [WORK_SENTINEL, VERDICT_SENTINEL]) {
      assert(
        (await window.getByText(sentinel, { exact: true }).count()) === 0,
        `不应出现哨兵文本：${sentinel}`
      );
    }

    await closeApp(app);
    app = null;
    console.log("[e2e] 目标模式重启恢复为暂停态场景通过 ✅");
  } catch (error) {
    console.error("[e2e] 目标模式重启恢复为暂停态场景失败 ❌", error);
    // 失败现场：请求时序（排障用）
    console.error("[e2e] 请求时序：", JSON.stringify(seenBodies.map(classify)));
    process.exitCode = 1;
    try {
      await closeApp(app);
    } catch {
      // 已关闭或已被强杀
    }
  } finally {
    // 被杀那一轮的挂起请求连接先断开再关 server（subagent-interrupted 同款清理）
    server.closeAllConnections();
    server.close();
    rmSync(homeDir, { recursive: true, force: true });
  }
}

await main();
