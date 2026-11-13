// E2E（票 05）：忙时输入区收口——双按钮并排、按钮入队生效、斜杠命令提示。
// 路径：设置页建 Profile（本地 mock SSE）→ 建任务
// ① 回复流式进行中，输入框有内容 →「加入队列」（主操作）与「停止」并排，无发送按钮
// ② 点「加入队列」与 Enter 等效：消息入队，队列条显示预览
// ③ 清空输入 → 仅停止按钮（与现状一致）
// ④ 忙时提交 /status → 提示不入队不执行（输入保留、队列条数不变）
// ⑤ 回复结束（空闲）→ 单发送按钮回归；原样重发 /status 正常执行
// 运行：pnpm --filter @codexlike/desktop run test:e2e:input-queue-composer（先 pnpm build）。
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

/**
 * 场景脚本（按请求序号）：
 * ① 慢速流式（12 段、每段 400ms ≈ 4.8s，供操作窗口）；
 * ② 排队消息的消费 → 快速完整回复。
 * /status 是本地查询命令，不产生模型请求。
 */
async function main() {
  const {
    server,
    port,
    requestCount: getRequestCount,
  } = await startMockProvider((ctx, { index }) => {
    if (index === 1) {
      ctx.textChunksRound(
        Array.from({ length: 12 }, (_, i) => `第${i}段长文。`),
        400
      );
      return;
    }
    if (index === 2) {
      ctx.textRound("排队消息的处理结果。");
      return;
    }
    ctx.textRound("（不应被请求）");
  });
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-queue-c-"));
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
    await window
      .locator("form")
      .getByRole("button", { name: /保存|创建/ })
      .click();
    await window.getByText("Mock").first().waitFor();
    await window.getByTestId("settings-back").click();

    await prepareDraft(window, { approvalMode: "assist" });
    await window.getByTestId("composer-input").fill("先做个长任务");
    await window.getByTestId("composer-send").click();
    // 等流式真正开始（操作窗口内回复仍在进行）
    await window
      .getByTestId("message-assistant")
      .getByText("第0段长文")
      .waitFor({ timeout: 15_000 });

    const input = window.getByTestId("composer-input");

    // ① 忙且有输入：双按钮并排（加入队列主操作 + 停止），无发送按钮
    await input.fill("排队消息");
    await window.getByTestId("composer-enqueue").waitFor({ timeout: 10_000 });
    await window.getByTestId("composer-stop").waitFor({ timeout: 10_000 });
    assert(
      (await window.getByTestId("composer-send").count()) === 0,
      "忙且有输入时不应出现发送按钮"
    );
    assert(
      (
        await window.getByTestId("composer-enqueue").getAttribute("class")
      )?.includes("bg-accent"),
      "「加入队列」应为 accent 主操作样式"
    );
    console.log("[e2e] 忙且有输入：加入队列与停止并排，无发送按钮");

    // ② 点「加入队列」与 Enter 等效：消息入队，队列条显示预览
    await window.getByTestId("composer-enqueue").click();
    await window.getByTestId("queue-bar").waitFor({ timeout: 10_000 });
    await window
      .getByTestId("queue-item-preview")
      .getByText("排队消息")
      .waitFor({ timeout: 10_000 });
    console.log("[e2e] 点「加入队列」按钮入队生效，队列条显示预览");

    // ③ 忙且无输入：仅停止按钮，外观与现状一致
    await input.fill("");
    await window
      .getByTestId("composer-enqueue")
      .waitFor({ state: "detached", timeout: 10_000 });
    await window.getByTestId("composer-stop").waitFor({ timeout: 10_000 });
    console.log("[e2e] 忙且无输入：仅停止按钮");

    // ④ 忙时提交斜杠命令：提示不入队不执行，输入保留、队列条数不变
    await input.fill("/status");
    await window.getByTestId("composer-enqueue").waitFor({ timeout: 10_000 });
    await window.getByTestId("composer-enqueue").click();
    await window
      .getByTestId("message-status")
      .filter({ hasText: "回复结束后可用" })
      .first()
      .waitFor({ timeout: 10_000 });
    assert(
      (await input.inputValue()) === "/status",
      "忙时命令提示后应保留输入，便于回复结束后重发"
    );
    await window.getByTestId("queue-count").getByText("待发 1 条").waitFor({
      timeout: 10_000,
    });
    console.log("[e2e] 忙时斜杠命令：提示不入队不执行，输入保留");

    // ⑤ 回复结束（空闲）：单发送按钮回归；排队消息自动消费完成、队列清空
    await window
      .getByText("排队消息的处理结果。")
      .first()
      .waitFor({ timeout: 30_000 });
    await window.getByTestId("queue-bar").waitFor({
      state: "detached",
      timeout: 10_000,
    });
    await window.getByTestId("composer-send").waitFor({ timeout: 10_000 });
    assert(
      (await window.getByTestId("composer-stop").count()) === 0,
      "空闲时不应再有停止按钮"
    );
    // 空闲命令行为不变：原样重发保留的 /status 正常执行
    await input.press("Enter");
    await window
      .getByTestId("message-status")
      .filter({ hasText: "任务状态" })
      .first()
      .waitFor({ timeout: 10_000 });
    console.log("[e2e] 空闲后：单发送按钮回归，保留的命令原样执行");

    // 模型恰好两轮请求：首轮 + 排队消费；/status 不产生请求
    assert(
      getRequestCount() === 2,
      `应恰好两轮模型请求（实际 ${getRequestCount()} 次）`
    );
    console.log("[e2e] 模型请求次数精确：命令未触发额外请求");

    await closeApp(app);
    console.log("[e2e] 忙时输入区收口通过 ✅");
  } catch (error) {
    console.error("[e2e] 忙时输入区收口失败 ❌", error);
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
