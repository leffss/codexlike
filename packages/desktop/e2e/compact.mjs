// E2E（工单 08）：/compact 手动压缩的真实应用冒烟。
// 路径：建 Profile（本地 mock，stream 分流：对话走 SSE、压缩走 JSON）→ 建任务
// → 4 轮对话 → /compact → 断言摘要卡片折叠可见、消息流只剩摘要 + 最近 3 轮、
// /status 显示已压缩 → 继续对话断言真实请求体含摘要与最近 3 轮（不含被压缩轮次）
// → 重启应用断言摘要卡片仍可见（持久化恢复）。
// 运行：pnpm --filter @codexlike/desktop run test:e2e:compact（先 pnpm build）。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  assert,
  closeApp,
  launchApp,
  prepareDraft,
  startMockProvider,
} from "./helpers.mjs";

const SUMMARY_MARKER = "E2E压缩摘要标记ABC";

/** 发送一条普通消息并等回复完成（assistant 消息数增至 target） */
async function sendAndAwait(window, composer, text, targetAssistantCount) {
  await composer.fill(text);
  await composer.press("Enter");
  await window.waitForFunction(
    (target) =>
      document.querySelectorAll('[data-testid="message-assistant"]').length >=
      target,
    targetAssistantCount,
    { timeout: 20_000 }
  );
}

/**
 * 场景脚本（mock 分流）：
 * - 对话（stream:true）→ SSE 回复「收到。」；
 * - 压缩（非流式，system 含压缩指令标记）→ JSON 返回摘要全文。
 * 全部请求体由骨架记录（seenBodies，注入上下文的真实证据）。
 */
async function main() {
  let holdCompact = true;
  let heldSummary;
  const finishSummary = (ctx) =>
    ctx.respondJson({
      id: "chatcmpl-e2e-compact",
      object: "chat.completion",
      created: 0,
      model: "mock-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: SUMMARY_MARKER },
          finish_reason: "stop",
        },
      ],
    });
  const { server, port, seenBodies } = await startMockProvider(
    (ctx, { body }) => {
      const isStream =
        body.includes('"stream":true') || body.includes('"stream": true');
      if (isStream) {
        ctx.textRound("收到。");
        return;
      }
      if (holdCompact) heldSummary = () => finishSummary(ctx);
      else finishSummary(ctx);
    }
  );
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-compact-"));
  mkdirSync(join(homeDir, "workspace"), { recursive: true });

  let app;
  try {
    const { app: launchedApp, window } = await launchApp({ homeDir });
    app = launchedApp;

    // 1) 设置页创建 Profile
    await window.getByTestId("settings-open").click();
    await window.getByTestId("profile-create").click();
    const profileForm = window.locator("form");
    await profileForm.getByLabel("名称").fill("Mock");
    await profileForm.getByLabel("baseURL").fill(`http://127.0.0.1:${port}/v1`);
    await profileForm.getByLabel("API Key").fill("sk-e2e");
    await profileForm.getByLabel("模型 1").fill("mock-model");
    // 设置页现在有两个「保存」按钮（Profile 表单与搜索源区），限定在表单内点击
    await window
      .locator("form")
      .getByRole("button", { name: /保存|创建/ })
      .click();
    await window.getByText("Mock").first().waitFor();

    // 2) 建任务 + 4 轮对话（压缩需超过 3 轮）
    await window.getByTestId("settings-back").click();
    await prepareDraft(window);
    const composer = window.getByTestId("composer-input");
    for (let i = 1; i <= 4; i += 1) {
      await sendAndAwait(window, composer, `第${i}轮问题`, i);
    }

    // 挂起Compact后A→B→A：停止入口恢复，停止不改历史；再后台完成同样更新。
    await window.getByTestId("new-task").click();
    await sendAndAwait(window, composer, "任务B", 1);
    const chooseA = () =>
      window.getByTestId("task-item").filter({ hasText: "第1轮问题" }).click();
    const chooseB = () =>
      window.getByTestId("task-item").filter({ hasText: "任务B" }).click();
    await chooseA();
    await composer.fill("/compact");
    await composer.press("Enter");
    await window.getByTestId("compacting-indicator").waitFor();
    await chooseB();
    await chooseA();
    await window.getByTestId("compacting-indicator").waitFor();
    await window.getByTestId("composer-stop").click();
    await window
      .getByTestId("compacting-indicator")
      .waitFor({ state: "hidden" });
    assert(
      (await window.getByTestId("message-user").count()) === 4,
      "停止Compact不裁旧历史"
    );
    assert(
      (await window.getByTestId("message-compact-summary").count()) === 0,
      "停止Compact不生成摘要"
    );
    heldSummary?.();
    heldSummary = undefined;

    // 3) /compact：命令菜单出现 /compact，选中执行
    await composer.fill("/comp");
    const menu = window.getByTestId("composer-menu");
    await menu.waitFor({ timeout: 5_000 });
    assert(
      (await menu.textContent())?.includes("/compact") === true,
      "命令菜单未展示 /compact"
    );
    await composer.press("Enter");

    await window.getByTestId("compacting-indicator").waitFor();
    await chooseB();
    await chooseA();
    await window.getByTestId("compacting-indicator").waitFor();
    await window.waitForFunction(async () => {
      const task = (await window.codexlike.tasks.list()).find(
        (s) => s.title === "第1轮问题"
      );
      const view = await window.codexlike.tasks.view(task.id);
      return view.activity.running && view.activity.operation === "compact";
    });
    assert(typeof heldSummary === "function", "压缩请求已进入模型闸门");
    heldSummary();
    heldSummary = undefined;
    holdCompact = false;
    // 摘要卡片出现（被压缩历史折叠为一张卡片）
    const summaryCard = window.getByTestId("message-compact-summary");
    await summaryCard.waitFor({ timeout: 20_000 });
    console.log("[e2e] /compact：摘要卡片已渲染");

    // 压缩请求体：system 是压缩指令、携带被压缩的前 2 轮
    const compactBody = seenBodies.find(
      (body) =>
        body.includes(SUMMARY_MARKER) === false &&
        body.includes("对话历史压缩器")
    );
    assert(compactBody !== undefined, "未发出压缩请求（system 压缩指令缺失）");
    // 4 轮 - 保留 3 轮 = 被压缩 1 轮（第 1 轮的 user + assistant）
    assert(compactBody.includes("第1轮问题") === true, "压缩请求未携带第 1 轮");
    assert(
      compactBody.includes("第2轮问题") === false,
      "压缩请求不应携带保留的第 2 轮"
    );
    assert(
      compactBody.includes("第3轮问题") === false,
      "压缩请求不应携带保留的第 3 轮"
    );

    // 消息流结构：摘要卡片 + 最近 3 轮（3 条 user 原文）
    assert(
      (await window.getByTestId("message-user").count()) === 3,
      "压缩后应只剩 3 条用户消息"
    );
    // 折叠态默认不显示摘要全文（details 未展开时内容不可见），展开后可见
    const summaryFullText = window.getByText(SUMMARY_MARKER).first();
    assert(
      (await summaryFullText.isVisible()) === false,
      "摘要卡片折叠态不应显示全文"
    );
    await summaryCard.locator("summary").click();
    await summaryFullText.waitFor({ timeout: 5_000, state: "visible" });
    console.log("[e2e] 摘要卡片可展开查看全文；最近 3 轮保留");

    // 4) /status：已压缩标记 + 压缩后用量
    await composer.fill("/status");
    await composer.press("Enter");
    const statusCard = window.getByTestId("command-feedback");
    await statusCard.waitFor({ timeout: 10_000 });
    const statusText = await statusCard.textContent();
    assert(
      statusText?.includes("已压缩") === true,
      `/status 未显示已压缩标记：${statusText}`
    );
    assert(statusText?.includes("tokens") === true, "/status 未显示压缩后用量");
    assert(
      statusText?.includes("2 条历史消息") === true,
      `/status 未显示压缩条数：${statusText}`
    );
    console.log("[e2e] /status：已压缩标记与压缩后用量可见");

    // 5) 压缩后继续对话：真实请求体 = 摘要 + 最近 3 轮 + 新消息（不含被压缩轮次）
    const bodiesBefore = seenBodies.length;
    // 压缩后消息流只剩 3 条 assistant（第 2-4 轮），新回复是第 4 条
    await sendAndAwait(window, composer, "压缩后继续问", 4);
    const afterBodies = seenBodies.slice(bodiesBefore).join("\n");
    assert(
      afterBodies.includes(SUMMARY_MARKER) === true,
      "压缩后对话请求未携带摘要"
    );
    assert(
      afterBodies.includes("第2轮问题") === true,
      "压缩后对话请求未保留第 2 轮"
    );
    assert(
      afterBodies.includes("第4轮问题") === true,
      "压缩后对话请求未保留第 4 轮"
    );
    assert(
      afterBodies.includes("压缩后继续问") === true,
      "压缩后对话请求未携带新消息"
    );
    assert(
      afterBodies.split("第1轮问题").length - 1 === 0,
      "被压缩的第 1 轮原文不应再进入对话请求"
    );
    console.log("[e2e] 压缩后继续对话：请求体 = 摘要 + 最近 3 轮 + 新消息");

    // 6) 挂起Compact时退出：取消保留执行；确认等flush再停止，不重放摘要请求。
    holdCompact = true;
    await composer.fill("/compact");
    await composer.press("Enter");
    await window.getByTestId("compacting-indicator").waitFor();
    await chooseB();
    await app.evaluate(({ app }) => app.quit());
    await window.getByTestId("exit-cancel").click();
    await chooseA();
    await window.getByTestId("compacting-indicator").waitFor();
    const requestsBeforeExit = seenBodies.length;
    const exited = new Promise((resolve) =>
      app.process().once("exit", resolve)
    );
    await app.evaluate(({ app }) => app.quit());
    await window.getByTestId("exit-confirm").click();
    let timeout;
    try {
      await Promise.race([
        exited,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Compact确认退出未排空")),
            10_000
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    app = null;
    // 重启应用：原摘要卡片仍可见，中止的再次Compact没有改写历史。
    const { app: relaunchedApp, window: relaunchedWindow } = await launchApp({
      homeDir,
    });
    app = relaunchedApp;
    await relaunchedWindow
      .getByTestId("message-compact-summary")
      .waitFor({ timeout: 15_000 });
    // 摘要 + 第 2-4 轮 + 压缩后新发的 1 条 = 4 条用户消息
    assert(
      (await relaunchedWindow.getByTestId("message-user").count()) === 4,
      "重启后用户消息应为压缩后的 4 条"
    );
    assert(seenBodies.length === requestsBeforeExit, "重启不重放Compact或消息");
    console.log(
      "[e2e] Compact切换、停止、后台完成、退出取消/确认及重启零重放通过"
    );

    await closeApp(app);
    console.log("[e2e] 工单 08 compact 冒烟通过 ✅");
  } catch (error) {
    console.error("[e2e] compact 冒烟失败 ❌", error);
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
