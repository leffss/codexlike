// E2E（工单 13）：spawn_subagent 子代理委派的真实应用冒烟。
// 路径：建 Profile（本地 mock 按请求特征分流主/子两级）→ 设置页子代理配置区
// （并发上限改为 2 保存）→ 建会话 → 委派调研 → 嵌套卡片运行→完成、报告可展开 →
// 断言子代理请求独立上下文（含 task 不含主会话原文）且工具表无 spawn_subagent（防递归）
// → 主模型第二轮收到报告（回流）→ 重启后嵌套卡片恢复（报告持久化）。
// 运行：pnpm --filter @codexlike/desktop run test:e2e:subagents（先 pnpm build）。
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

const DELEGATE_TASK = "E2E委派调研任务标记";
const REPORT_MARKER = "E2E子代理报告标记XYZ";
const SUBAGENT_SYSTEM_MARK = "CodexLike 的子代理";

/**
 * 场景脚本（按请求特征分流三级）：
 * - 子代理请求（system 含子代理标记）→ SSE 回文本报告；
 * - 主会话请求且消息含委派指令 → SSE 回 spawn_subagent tool_call；
 * - 主会话请求且消息含报告（工具结果回填后）→ SSE 回汇总文本。
 * 全部请求体由骨架记录（seenBodies，主/子两级上下文隔离的真实证据）。
 */
async function main() {
  const { server, port, seenBodies } = await startMockProvider(
    (ctx, { body }) => {
      // 子代理请求：独立上下文（system 为子代理固定指令）
      if (body.includes(SUBAGENT_SYSTEM_MARK)) {
        ctx.textRound(`${REPORT_MARKER}：调研完成，共 3 个入口。`);
        return;
      }
      // 主会话第二轮：报告已作为工具结果回填（优先判断——第二轮请求含全部历史原文）
      if (body.includes(REPORT_MARKER)) {
        ctx.textRound("子代理的报告已汇总。");
        return;
      }
      // 主会话第一轮：发起 spawn_subagent 委派
      if (body.includes("委派调研一下测试入口")) {
        ctx.toolCallRound("call-delegate-1", "spawn_subagent", {
          task: DELEGATE_TASK,
        });
        return;
      }
      ctx.res.writeHead(422);
      ctx.res.end("unexpected request");
    }
  );
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-subagents-"));
  mkdirSync(join(homeDir, "workspace"), { recursive: true });

  let app;
  try {
    const { app: launchedApp, window } = await launchApp({ homeDir });
    app = launchedApp;

    // 1) 设置页创建 Profile
    await window.getByRole("button", { name: "设置", exact: true }).click();
    await window.getByTestId("profile-create").click();
    const profileForm = window.locator("form");
    await profileForm.getByLabel("名称").fill("Mock");
    await profileForm.getByLabel("baseURL").fill(`http://127.0.0.1:${port}/v1`);
    await profileForm.getByLabel("API Key").fill("sk-e2e");
    await profileForm.getByLabel("模型").fill("mock-model");
    await profileForm.getByRole("button", { name: /保存|创建/ }).click();
    await window.getByText("Mock").first().waitFor();

    // 2) 子代理配置区：并发上限改为 2 保存（对后续会话生效）
    const concurrencyInput = window.getByTestId("subagent-concurrency-input");
    await concurrencyInput.fill("2");
    await window.getByTestId("subagent-settings-save").click();
    await window
      .getByTestId("subagent-settings-message")
      .waitFor({ timeout: 10_000 });
    const savedMessage = await window
      .getByTestId("subagent-settings-message")
      .textContent();
    assert(
      savedMessage?.includes("已保存") === true,
      `子代理设置保存失败：${savedMessage}`
    );
    console.log("[e2e] 设置页子代理配置区：并发上限 2 已保存");

    // 3) 建会话 + 委派调研
    await window.getByRole("button", { name: "返回工作台" }).click();
    await prepareDraft(window, { approvalMode: "assist" });
    const composer = window.getByTestId("composer-input");
    await composer.fill("委派调研一下测试入口");
    await composer.press("Enter");

    // 4) 嵌套卡片：运行中出现 → 完成态 + 报告展开可见
    const subagentCard = window.getByTestId("subagent-card");
    await subagentCard.waitFor({ timeout: 20_000 });
    await subagentCard.waitFor({ state: "visible", timeout: 20_000 });
    // 完成态（data-subagent-state 变为 done）+ 报告内容可见
    await window
      .locator('[data-testid="subagent-card"][data-subagent-state="done"]')
      .waitFor({ timeout: 20_000 });
    const reportText = await window
      .getByTestId("subagent-report")
      .textContent();
    assert(
      reportText?.includes(REPORT_MARKER) === true,
      `嵌套卡片报告缺失标记：${reportText}`
    );
    console.log("[e2e] 嵌套卡片完成，最终报告可见");

    // 5) 子代理请求：独立上下文（含 task、不含主会话原文）+ 工具表无 spawn_subagent
    const subagentBody = seenBodies.find((body) =>
      body.includes(SUBAGENT_SYSTEM_MARK)
    );
    assert(
      subagentBody !== undefined,
      "未观察到子代理模型请求（独立上下文未发生）"
    );
    assert(
      subagentBody.includes(DELEGATE_TASK) === true,
      "子代理请求未携带任务描述"
    );
    assert(
      subagentBody.includes("委派调研一下测试入口") === false,
      "子代理请求不应包含主会话历史"
    );
    // 工具表断言按 tools[].function.name 精确匹配（system 提示文本本身含 spawn_subagent 字样）
    assert(
      subagentBody.includes('"name":"spawn_subagent"') === false,
      "子代理工具表不应含 spawn_subagent（防递归）"
    );
    assert(
      subagentBody.includes('"name":"read_file"') === true,
      "子代理工具表应含完整工具集（read_file 对照）"
    );
    console.log("[e2e] 子代理独立上下文 + 防递归（真实请求体验证）");

    // 6) 主模型第二轮：报告作为工具结果回流主会话上下文
    const mainSecondRound = seenBodies.find(
      (body) =>
        body.includes(REPORT_MARKER) && !body.includes(SUBAGENT_SYSTEM_MARK)
    );
    assert(
      mainSecondRound !== undefined,
      "主模型第二轮未收到子代理报告（回流失败）"
    );
    await window.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="message-assistant"]').length >=
        1,
      null,
      { timeout: 20_000 }
    );
    console.log("[e2e] 报告回流主会话上下文（第二轮请求体验证）");

    // 7) 重启应用：嵌套卡片恢复（报告随 spawn_subagent 调用记录持久化）
    await closeApp(app);
    const { app: relaunchedApp, window: relaunchedWindow } = await launchApp({
      homeDir,
    });
    app = relaunchedApp;
    await relaunchedWindow
      .locator('[data-testid="subagent-card"][data-subagent-state="done"]')
      .waitFor({ timeout: 15_000 });
    const restoredReport = await relaunchedWindow
      .getByTestId("subagent-report")
      .textContent();
    assert(
      restoredReport?.includes(REPORT_MARKER) === true,
      `重启后嵌套卡片报告缺失：${restoredReport}`
    );
    console.log("[e2e] 重启后嵌套卡片恢复（持久化验证）");

    await closeApp(app);
    console.log("[e2e] 工单 13 子代理冒烟通过 ✅");
  } catch (error) {
    console.error("[e2e] 子代理冒烟失败 ❌", error);
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
