// E2E（工单 06）：会话打断（停止按钮）+ 中断点跨重启恢复的真实应用冒烟。
// 路径：设置页建 Profile（本地 mock SSE）→ 建会话
// ① 流式输出中点停止 → 本轮立即中断、UI 标记中断点
// ② 中断后继续发新消息 → 正常完成回复
// ③ 工具执行中（sleep 30 长命令）点停止 → 子进程被杀、结果标记用户中断、无后续模型请求
// ④ 重启应用 → 中断标记与工具卡片完整恢复。
// 运行：pnpm --filter @codexlike/desktop run test:e2e:interrupt（先 pnpm build）。
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

/**
 * 场景脚本（按请求序号）：
 * ① 慢速流式（长文分段，供流式中途点停止）；
 * ② 中断后的新消息 → 快速完整回复；
 * ③ run_terminal_command 长命令（sleep 30）tool_call → 工具执行中点停止。
 * ④ 不应存在（中断后模型不再被请求）——requestCount 断言。
 */
async function main() {
  const {
    server,
    port,
    requestCount: getRequestCount,
  } = await startMockProvider((ctx, { index }) => {
    if (index === 1) {
      // ① 慢速流式：20 段、每段 300ms（共 6 秒），保证点击停止时仍在输出
      ctx.textChunksRound(
        Array.from({ length: 20 }, (_, i) => `第${i}段长文。`),
        300
      );
      return;
    }
    if (index === 2) {
      // ② 中断后的新消息：快速完整回复
      ctx.textRound("中断后的新回答。");
      return;
    }
    if (index === 3) {
      // ③ 工具调用：长命令（sleep 30），供执行中点停止
      ctx.toolCallRound("call-sleep", "run_terminal_command", {
        command: "echo started; sleep 30",
        timeoutMs: 120000,
      });
      return;
    }
    // ④ 中断后模型不应再被请求
    ctx.textRound("（不应被请求）");
  });
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-stop-"));
  mkdirSync(join(homeDir, "workspace"));

  let app;
  try {
    // 0) 启动 → 设置页创建 Profile（指向本地 mock）
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
    // 设置页现在有两个「保存」按钮（Profile 表单与搜索源区），限定在表单内点击
    await window
      .locator("form")
      .getByRole("button", { name: /保存|创建/ })
      .click();
    await window.getByText("Mock").first().waitFor();
    await window.getByTestId("settings-back").click();

    // ① 流式输出中点停止：本轮立即中断，UI 标记中断点
    await prepareDraft(window, { approvalMode: "assist" });
    await window.getByTestId("composer-input").fill("慢慢写一篇长文");
    await window.getByTestId("composer-send").click();
    // 等流式文本真正开始（停止才有「部分内容保留」可断言）
    await window
      .getByTestId("message-assistant")
      .getByText("第0段长文")
      .waitFor({ timeout: 15_000 });
    await window.getByTestId("composer-stop").click();

    await window
      .getByText("（已中断，以上为部分回复）")
      .first()
      .waitFor({ timeout: 10_000 });
    const partial = await window
      .getByTestId("message-assistant")
      .first()
      .textContent();
    assert(
      partial !== null && !partial.includes("第19段长文"),
      "中断后不应出现完整 20 段"
    );
    // 中断后发送按钮回来（streaming 复位），输入框恢复可用
    await window.getByTestId("composer-send").waitFor({ timeout: 10_000 });
    console.log("[e2e] 流式中断：立即停止，UI 标记中断点，输入区恢复");

    // ② 中断后继续发新消息：正常完成（上下文含中断前历史）
    await window.getByTestId("composer-input").fill("中断后再问一句");
    await window.getByTestId("composer-send").click();
    await window
      .getByText("中断后的新回答。")
      .first()
      .waitFor({ timeout: 15_000 });
    console.log("[e2e] 中断后继续发新消息：正常完成回复");

    // ③ 工具执行中点停止：长命令子进程被杀，结果标记用户中断
    await window.getByTestId("composer-input").fill("跑个长命令");
    await window.getByTestId("composer-send").click();
    const card = window.getByTestId("tool-call-card").first();
    await card.waitFor({ timeout: 20_000 });
    assert(
      (await card.getAttribute("data-tool-name")) === "run_terminal_command",
      "工具卡片未显示 run_terminal_command"
    );
    // 显式选择的 assist 档普通命令自动放行（GLOSSARY「审批模式」新三档）：卡片出现即已开始执行，
    // 停止落在执行中（子进程被杀）
    const stopAt = Date.now();
    await window.getByTestId("composer-stop").click();
    // 工具结果回流：卡片展开可见「已被用户中断」（子进程树被杀，不会等满 30 秒）
    await card.getByTestId("tool-call-toggle").click();
    await card.getByText("已被用户中断").waitFor({ timeout: 15_000 });
    const stoppedIn = Date.now() - stopAt;
    assert(stoppedIn < 15_000, `中断未即时生效（耗时 ${stoppedIn}ms）`);
    // 本轮终止：中断标记出现（assistant-aborted）
    await window
      .getByText("（已中断，以上为部分回复）")
      .nth(1)
      .waitFor({ timeout: 10_000 });
    console.log("[e2e] 工具执行中停止：子进程被杀，结果标记用户中断");

    // 中断后模型不再被请求（第 4 次请求不应发生）
    await new Promise((r) => setTimeout(r, 800));
    assert(
      getRequestCount() === 3,
      `工具中断后不应再有模型请求（实际 ${getRequestCount()} 次）`
    );
    // 中断后输入区再次恢复
    await window.getByTestId("composer-send").waitFor({ timeout: 10_000 });

    // ④ 重启应用：中断标记与工具卡片完整恢复
    await closeApp(app);
    const second = await launchApp({ homeDir });
    app = second.app;
    window = second.window;
    await window
      .getByTestId("session-item")
      .first()
      .waitFor({ timeout: 15_000 });
    await window.getByTestId("session-item").first().click();
    await window
      .getByTestId("message-user")
      .first()
      .waitFor({ timeout: 10_000 });
    const restoredMarks = await window
      .getByText("（已中断，以上为部分回复）")
      .count();
    assert(restoredMarks >= 2, "重启后中断点标记未恢复");
    const restoredCards = await window.getByTestId("tool-call-card").count();
    assert(restoredCards >= 1, "重启后工具卡片未恢复");
    const restoredCard = window.getByTestId("tool-call-card").first();
    await restoredCard.getByTestId("tool-call-toggle").click();
    await restoredCard.getByText("已被用户中断").waitFor({ timeout: 10_000 });
    console.log("[e2e] 重启恢复：中断标记与工具卡片（含中断结果）完整还原");

    await closeApp(app);
    console.log("[e2e] 打断冒烟通过 ✅");
  } catch (error) {
    console.error("[e2e] 打断冒烟失败 ❌", error);
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
