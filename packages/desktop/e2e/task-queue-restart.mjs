// E2E（任务并发上限票 05 / ADR 0022）：排队持久化与重启恢复全链——真实
// Electron 正常退出后重开。路径：设置页建 Profile（本地 mock SSE）并把任务
// 并发上限设为 2 →
// ① 任务甲/乙首轮挂起占满名额，丙/丁/戊三条首条入队不执行（侧栏「排队中」
//    徽章可见）
// ② 结束甲 → 队首丙自动开跑（模型请求证明），名额重新占满
// ③ 公开 IPC 中断排队丁 → 立即出队回空闲（徽章消失），排队记录随之清除
// ④ 己在满员下入队（队列 戊→己）→ 确认退出（乙/丙被中断，排队持久保留）
// ⑤ 重启后戊/己按原顺序自动开跑（上限内、戊先己后），丁不复活（无请求、
//    无排队徽章），模型请求次数精确。
// 运行：pnpm --filter @codexlike/desktop run test:e2e:task-queue-restart（先 pnpm build）。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";

import {
  assert,
  closeApp,
  launchApp,
  prepareDraft,
  startMockProvider,
} from "./helpers.mjs";

/** 首轮一律「一段后挂起」：占名额的运行窗口由显式 finish / 中断 / 退出收口。 */
const HELD_FIRST_ROUND = new Set([
  "并发甲首轮",
  "并发乙首轮",
  "排队丙首轮",
  "排队戊首轮",
  "排队己首轮",
]);

function firstUserText(body) {
  const data = JSON.parse(body);
  return data.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
}

async function until(predicate, message, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (!(await predicate())) {
    assert(Date.now() < end, message);
    await delay(50);
  }
}

function exited(app) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("应用进程未正常结束")),
      20000
    );
    app.process().once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

/** 侧栏指定任务行的活动徽章语义（无徽章返回 null）。 */
async function badgeLabel(window, title) {
  const badge = window
    .getByTestId("task-item")
    .filter({ hasText: title })
    .getByTestId("task-activity");
  if ((await badge.count()) === 0) return null;
  return badge.first().getAttribute("aria-label");
}

async function select(window, title) {
  await window.getByTestId("task-item").filter({ hasText: title }).click();
}

/** 挂起中的响应上下文：显式 finish 收尾用 */
const heldResponses = new Map();

async function main() {
  const { server, port, seenBodies, requestCount } = await startMockProvider(
    (ctx, { body }) => {
      const text = firstUserText(body);
      if (HELD_FIRST_ROUND.has(text)) {
        ctx.send({
          delta: { content: `${text}流式进行中` },
          finish_reason: null,
        });
        heldResponses.set(text, ctx);
        return;
      }
      ctx.textRound("（不应被请求）");
    }
  );
  async function finishRound(text) {
    const ctx = heldResponses.get(text);
    assert(ctx, `等待 ${text} 的挂起响应超时`);
    ctx.finishWith("stop");
    heldResponses.delete(text);
  }
  const bodies = () => seenBodies.map(firstUserText);
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-task-queue-"));
  mkdirSync(join(homeDir, "workspace"));

  let app;
  try {
    // ── 第一次启动：设上限 2 → 甲乙占满 → 丙丁戊排队 → 结束甲丙开跑 →
    //    中断丁 → 己入队 → 确认退出 ──
    const first = await launchApp({ homeDir });
    app = first.app;
    let window = first.window;
    await window.getByTestId("settings-open").click();
    await window.getByTestId("profile-create").click();
    const profileForm = window.locator("form");
    await profileForm.getByLabel("名称").fill("Mock");
    await profileForm.getByLabel("baseURL").fill(`http://127.0.0.1:${port}/v1`);
    await profileForm.getByLabel("API Key").fill("sk-e2e");
    await profileForm.getByLabel("模型").fill("mock-model");
    await window
      .locator("form")
      .getByRole("button", { name: /保存|创建/ })
      .click();
    await window.getByText("Mock").first().waitFor();
    // 任务并发上限设为 2（票面全链前置）：保存后主进程缓存即时生效
    await window.getByTestId("execution-task-concurrency-input").fill("2");
    await window.getByTestId("execution-settings-save").click();
    await window.getByTestId("settings-back").click();
    console.log("[e2e] Profile 建好、任务并发上限设为 2");

    /** 发送新任务首条并等到任务创建（标题 = 首条文本前缀） */
    async function sendFirst(text) {
      await prepareDraft(window);
      await window.getByTestId("composer-input").fill(text);
      await window.getByTestId("composer-send").click();
    }

    // 甲/乙：首轮挂起占满两个名额
    await sendFirst("并发甲首轮");
    await window
      .getByTestId("message-assistant")
      .getByText("并发甲首轮流式进行中")
      .waitFor({ timeout: 15_000 });
    await sendFirst("并发乙首轮");
    await window
      .getByTestId("message-assistant")
      .getByText("并发乙首轮流式进行中")
      .waitFor({ timeout: 15_000 });
    console.log("[e2e] 甲乙首轮挂起：两个名额占满");

    // 丙/丁/戊：满员入队不执行（侧栏「排队中」徽章可见、任务内排队状态条）
    for (const text of ["排队丙首轮", "排队丁首轮", "排队戊首轮"]) {
      await sendFirst(text);
      await until(
        async () => (await badgeLabel(window, text)) === "排队中",
        `${text} 应显示「排队中」徽章`
      );
    }
    await window.getByTestId("task-queued-notice").waitFor({ timeout: 10_000 });
    await delay(500);
    assert(
      requestCount() === 2,
      `排队任务不得发出模型请求（实际 ${requestCount()} 轮）`
    );
    console.log("[e2e] 丙丁戊三条排队：徽章可见、无模型请求");

    // 结束甲 → 名额释放 → 队首丙自动开跑（后台执行，模型请求独立证明）
    await finishRound("并发甲首轮");
    await until(
      () => bodies().includes("排队丙首轮"),
      "名额释放后排队丙未自动开跑"
    );
    // 切到丙查看开跑后的流式输出（首条已按入队快照发出）
    await select(window, "排队丙首轮");
    await window
      .getByTestId("message-assistant")
      .getByText("排队丙首轮流式进行中")
      .first()
      .waitFor({ timeout: 15_000 });
    assert(
      requestCount() === 3,
      `丙开跑后恰好三轮模型请求（实际 ${requestCount()}）`
    );
    console.log("[e2e] 结束甲 → 排队丙自动开跑（队首 FIFO）");

    // 中断排队丁（公开 IPC，无专用 UI 按钮）：立即出队回空闲、徽章消失
    const interruptedId = await window.evaluate(async () => {
      const list = await window.codexlike.tasks.list();
      const record = list.find((task) => task.title === "排队丁首轮");
      return record ? record.id : null;
    });
    assert(interruptedId, "排队丁任务必须存在");
    const activityBefore = await window.evaluate(async (id) => {
      const list = await window.codexlike.tasks.list();
      return list.find((task) => task.id === id)?.activity ?? null;
    }, interruptedId);
    assert(activityBefore?.queued === true, "中断前丁应在排队");
    await window.evaluate(async (id) => {
      await window.codexlike.tasks.interrupt(id);
    }, interruptedId);
    await until(
      async () => (await badgeLabel(window, "排队丁首轮")) === null,
      "中断排队丁后徽章应立即消失（出队回空闲）"
    );
    console.log("[e2e] 中断排队丁：立即出队、徽章消失");

    // 己：满员（乙/丙）入队 → 队列 戊→己，随后确认退出
    await sendFirst("排队己首轮");
    await until(
      async () => (await badgeLabel(window, "排队己首轮")) === "排队中",
      "排队己应显示「排队中」徽章"
    );
    const done = exited(app);
    await app.evaluate(({ app }) => {
      app.quit();
    });
    await window.getByTestId("exit-confirm").click();
    const result = await done;
    assert(
      result.code === 0 && result.signal === null,
      "确认退出必须正常结束进程"
    );
    app = null;
    assert(
      requestCount() === 3,
      `退出前恰好三轮模型请求（实际 ${requestCount()}）`
    );
    console.log("[e2e] 确认退出：乙丙中断、戊己排队持久保留");

    // ── 第二次启动：同一数据目录，排队照序恢复自动开跑 ──
    const second = await launchApp({ homeDir });
    app = second.app;
    window = second.window;
    await window.getByTestId("new-task").waitFor();
    // 戊/己按原顺序自动开跑（上限 2 内，重启后无执行中）；丁不复活
    await until(
      () => bodies().includes("排队戊首轮") && bodies().includes("排队己首轮"),
      "重启后排队戊己未自动开跑"
    );
    assert(
      bodies().indexOf("排队戊首轮") < bodies().indexOf("排队己首轮"),
      "重启后开跑顺序应保持入队顺序（戊先己后）"
    );
    assert(
      !bodies().includes("排队丁首轮"),
      "被中断出队的丁重启后不得复活排队或开跑"
    );
    assert(
      requestCount() === 5,
      `重启后戊己开跑恰好五轮模型请求（实际 ${requestCount()}）`
    );
    await until(
      async () => (await badgeLabel(window, "排队丁首轮")) === null,
      "丁重启后不得出现排队徽章"
    );
    // 戊/己挂起运行中（占满重启后的两个名额）：徽章为「运行中」
    await until(
      async () =>
        (await badgeLabel(window, "排队戊首轮")) === "运行中" &&
        (await badgeLabel(window, "排队己首轮")) === "运行中",
      "重启后开跑的戊己应显示「运行中」徽章"
    );
    console.log("[e2e] 重启后戊己照序自动开跑、丁不复活，请求次数精确");

    await closeApp(app);
    app = null;
    console.log("[e2e] 任务排队持久化与重启恢复全链通过 ✅");
  } catch (error) {
    console.error("[e2e] 任务排队重启恢复场景失败 ❌", error);
    process.exitCode = 1;
  } finally {
    if (app) await closeApp(app).catch(() => {});
    server.closeAllConnections();
    server.close();
    rmSync(homeDir, { recursive: true, force: true });
  }
}

await main();
