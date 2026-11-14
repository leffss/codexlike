// E2E（票 04）：重启自动继续与后台消费——真实 Electron 正常退出后重开。
// 路径：设置页建 Profile（本地 mock SSE）→ 三个任务各自排队
// ① 任务 A/B 回复进行中入队（非暂停）→ 确认退出（A/B 中断，队列持久保留）
// ② 重启后未打开的 A/B 队列由主进程后台自动逐条消费（模型请求顺序证明）
// ③ 任务 C 停止置暂停 → 重启后保持暂停、队列条内容与顺序与重启前一致，
//    恢复入口可用；手动「恢复」后从队首继续消费完毕。
// 运行：pnpm --filter @codexlike/desktop run test:e2e:input-queue-restart（先 pnpm build）。
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

/** 首轮回复一律「一段后挂起」：提供稳定入队窗口，由退出确认/停止负责中断。 */
const HELD_FIRST_ROUND = new Set([
  "重启自动继续首轮",
  "后台任务首轮",
  "暂停保留首轮",
]);
const REPLIES = new Map([
  ["重启排队甲", "甲的重启后答复。"],
  ["重启排队乙", "乙的重启后答复。"],
  ["后台排队消息", "后台排队已完成。"],
  ["暂停保留一", "暂停保留一的答复。"],
  ["暂停保留二", "暂停保留二的答复。"],
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

async function enqueue(window, text) {
  const input = window.getByTestId("composer-input");
  await input.fill(text);
  await input.press("Enter");
}

async function select(window, title) {
  await window.getByTestId("task-item").filter({ hasText: title }).click();
}

async function main() {
  const { server, port, seenBodies, requestCount } = await startMockProvider(
    (ctx, { body }) => {
      const text = firstUserText(body);
      if (HELD_FIRST_ROUND.has(text)) {
        ctx.send({
          delta: { content: `${text}流式进行中` },
          finish_reason: null,
        });
        return;
      }
      ctx.textRound(REPLIES.get(text) ?? "（不应被请求）");
    }
  );
  const bodies = () => seenBodies.map(firstUserText);
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-queue-restart-"));
  mkdirSync(join(homeDir, "workspace"));

  let app;
  try {
    // ── 第一次启动：三个任务各自留下队列，然后正常确认退出 ──
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
    await window.getByTestId("settings-back").click();

    // 任务 A：回复进行中入队两条（非暂停，留给重启自动继续）
    await prepareDraft(window);
    await window.getByTestId("composer-input").fill("重启自动继续首轮");
    await window.getByTestId("composer-send").click();
    await window
      .getByTestId("message-assistant")
      .getByText("重启自动继续首轮流式进行中")
      .waitFor({ timeout: 15_000 });
    await enqueue(window, "重启排队甲");
    await enqueue(window, "重启排队乙");
    await window
      .getByTestId("queue-count")
      .getByText("待发 2 条")
      .waitFor({ timeout: 10_000 });
    console.log("[e2e] 任务 A 忙时入队两条（非暂停）");

    // 任务 B：切走不中断，同样留下一条排队
    await prepareDraft(window);
    await window.getByTestId("composer-input").fill("后台任务首轮");
    await window.getByTestId("composer-send").click();
    await window
      .getByTestId("message-assistant")
      .getByText("后台任务首轮流式进行中")
      .waitFor({ timeout: 15_000 });
    await enqueue(window, "后台排队消息");
    await window.getByTestId("queue-bar").waitFor({ timeout: 10_000 });
    console.log("[e2e] 任务 B 后台执行中入队一条");

    // 任务 C：入队两条后点停止 → 队列暂停（用户意图，重启不得推翻）
    await prepareDraft(window);
    await window.getByTestId("composer-input").fill("暂停保留首轮");
    await window.getByTestId("composer-send").click();
    await window
      .getByTestId("message-assistant")
      .getByText("暂停保留首轮流式进行中")
      .waitFor({ timeout: 15_000 });
    await enqueue(window, "暂停保留一");
    await enqueue(window, "暂停保留二");
    await window
      .getByTestId("queue-count")
      .getByText("待发 2 条")
      .waitFor({ timeout: 10_000 });
    await window.getByTestId("composer-stop").click();
    await window.getByTestId("queue-paused").waitFor({ timeout: 10_000 });
    console.log("[e2e] 任务 C 停止置暂停：队列原样保留");

    // A/B 仍在执行 → 走退出确认；确认后保存屏障完成、A/B 被中断、进程正常退出
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
    console.log("[e2e] 确认退出：A/B 中断、队列持久保留、进程正常退出");

    // ── 第二次启动：同一数据目录，队列随任务恢复 ──
    const second = await launchApp({ homeDir });
    app = second.app;
    window = second.window;
    await window.getByTestId("new-task").waitFor();

    // C：重启后仍暂停，队列条内容与顺序与重启前一致；恢复入口可用
    await select(window, "暂停保留首轮");
    await window.getByTestId("queue-paused").waitFor({ timeout: 10_000 });
    await window
      .getByTestId("queue-count")
      .getByText("待发 2 条")
      .waitFor({ timeout: 10_000 });
    const previews = await window
      .getByTestId("queue-item-preview")
      .evaluateAll((nodes) => nodes.map((node) => node.textContent));
    assert(
      previews[0]?.includes("暂停保留一") &&
        previews[1]?.includes("暂停保留二"),
      `重启后队列顺序应保持一致（实际 ${JSON.stringify(previews)}）`
    );
    await delay(800);
    assert(!bodies().includes("暂停保留一"), "暂停态队列重启后不得自动消费");
    console.log("[e2e] 重启后暂停保留：队列不自动消费、内容与顺序一致");

    // A/B：从未切换查看，队列由主进程后台自动逐条消费（甲完成在乙之前）
    await until(
      () => bodies().includes("重启排队甲") && bodies().includes("重启排队乙"),
      "后台任务的队列没有被自动消费"
    );
    const orderA = bodies();
    assert(
      orderA.indexOf("重启排队甲") < orderA.indexOf("重启排队乙"),
      "重启后仍逐条消费：甲的回复完成前不得发乙"
    );
    await until(
      () => bodies().includes("后台排队消息"),
      "B 任务队列未后台消费"
    );
    console.log("[e2e] 未查看的 A/B 任务队列在后台自动逐条消费");

    // A：打开任务看到两条排队消息都已发出并完成，队列条消失
    await select(window, "重启自动继续首轮");
    await window
      .getByText("甲的重启后答复。")
      .first()
      .waitFor({ timeout: 15_000 });
    await window
      .getByText("乙的重启后答复。")
      .first()
      .waitFor({ timeout: 15_000 });
    await window.getByTestId("queue-bar").waitFor({
      state: "detached",
      timeout: 10_000,
    });
    // B：从未打开，其后台轮次已完成（执行状态空闲）
    const bIdle = await window.evaluate(async () => {
      const list = await window.codexlike.sessions.list();
      const record = list.find((session) => session.title === "后台任务首轮");
      return record ? record.activity.running === false : false;
    });
    assert(bIdle, "后台任务消费完成后应回到空闲");
    console.log("[e2e] 打开 A 看到自动消费完毕；B 未打开也已完成");

    // C：手动「恢复」→ 从队首继续消费完毕，队列条消失
    await select(window, "暂停保留首轮");
    await window.getByTestId("queue-resume").click();
    await window
      .getByText("暂停保留一的答复。")
      .first()
      .waitFor({ timeout: 15_000 });
    await window
      .getByText("暂停保留二的答复。")
      .first()
      .waitFor({ timeout: 15_000 });
    await window.getByTestId("queue-bar").waitFor({
      state: "detached",
      timeout: 10_000,
    });
    assert(
      requestCount() === 8,
      `重启后恰好五轮模型请求：A2+B1+C2（实际 ${requestCount()}）`
    );
    console.log("[e2e] 暂停任务手动恢复后消费完毕，模型请求次数精确");

    await closeApp(app);
    app = null;
    console.log("[e2e] 重启自动继续与后台消费冒烟通过 ✅");
  } catch (error) {
    console.error("[e2e] 重启自动继续冒烟失败 ❌", error);
    process.exitCode = 1;
  } finally {
    if (app) await closeApp(app).catch(() => {});
    server.closeAllConnections();
    server.close();
    rmSync(homeDir, { recursive: true, force: true });
  }
}

await main();
