// 一次性演示截图工具（非断言场景，不入 script/README 索引）：复用
// task-queue-restart 场景的前半链路，截取任务并发上限的三个画面——
// ① 设置页「执行」分区的任务并发上限输入项；② 满员时排队任务的侧栏
// 「排队中」徽章 + 任务内状态条与首条回显；③ 名额释放后队首自动开跑
// （徽章转「运行中」、流式输出可见）。开发目录与打包产物
// （CODEXLIKE_PACKAGED_EXE）均可用。PNG 输出到
// .scratch/task-concurrency-limit/screenshots/。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";

import {
  assert,
  closeApp,
  launchApp,
  prepareDraft,
  startMockProvider,
} from "./helpers.mjs";

const HELD_FIRST_ROUND = new Set(["并发甲首轮", "并发乙首轮", "排队丙首轮"]);

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

const heldResponses = new Map();
const outDir = resolve(
  import.meta.dirname ?? ".",
  "../../../.scratch/task-concurrency-limit/screenshots"
);

async function main() {
  mkdirSync(outDir, { recursive: true });
  const { server, port } = await startMockProvider((ctx, { body }) => {
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
  });
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-shot-task-queue-"));
  mkdirSync(join(homeDir, "workspace"));

  let app;
  try {
    const { app: launched, window } = await launchApp({ homeDir });
    app = launched;

    // Profile + 任务并发上限设为 2
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
    await window
      .getByTestId("execution-task-concurrency-input")
      .scrollIntoViewIfNeeded();
    await window.getByTestId("execution-task-concurrency-input").fill("2");
    await window.getByTestId("execution-settings-save").click();
    await delay(400);
    await window.screenshot({
      path: join(outDir, "01-settings-execution.png"),
    });
    console.log("[shot] ① 设置页执行分区输入项");
    await window.getByTestId("settings-back").click();

    // 甲乙占满 → 丙丁排队
    async function sendFirst(text) {
      await prepareDraft(window);
      await window.getByTestId("composer-input").fill(text);
      await window.getByTestId("composer-send").click();
    }
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
    for (const text of ["排队丙首轮", "排队丁首轮"]) {
      await sendFirst(text);
      await until(
        async () => (await badgeLabel(window, text)) === "排队中",
        `${text} 应显示「排队中」徽章`
      );
    }
    // 打开排队丙：状态条 + 首条回显 + 侧栏徽章同屏
    await select(window, "排队丙首轮");
    await window.getByTestId("task-queued-notice").waitFor({ timeout: 10_000 });
    await delay(600);
    await window.screenshot({ path: join(outDir, "02-queued-notice.png") });
    console.log("[shot] ② 满员排队：徽章 + 状态条 + 首条回显");

    // 结束甲 → 丙自动开跑（徽章转运行中、流式输出可见）
    heldResponses.get("并发甲首轮").finishWith("stop");
    heldResponses.delete("并发甲首轮");
    await until(
      async () => (await badgeLabel(window, "排队丙首轮")) === "运行中",
      "名额释放后丙应自动开跑（运行中徽章）"
    );
    await select(window, "排队丙首轮");
    await window
      .getByTestId("message-assistant")
      .getByText("排队丙首轮流式进行中")
      .first()
      .waitFor({ timeout: 15_000 });
    await delay(600);
    await window.screenshot({
      path: join(outDir, "03-running-after-pump.png"),
    });
    console.log("[shot] ③ 名额释放 → 队首自动开跑");

    await closeApp(app);
    app = null;
    console.log(`[shot] 截图完成，输出目录 ${outDir} ✅`);
  } catch (error) {
    console.error("[shot] 截图失败 ❌", error);
    process.exitCode = 1;
  } finally {
    if (app) await closeApp(app).catch(() => {});
    server.closeAllConnections();
    server.close();
    rmSync(homeDir, { recursive: true, force: true });
  }
}

await main();
