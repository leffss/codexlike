// E2E（票 01）：输入队列——回复进行中提交的消息进入队列并自动逐条消费。
// 路径：设置页建 Profile（本地 mock SSE）→ 建任务
// ① 回复流式进行中，输入框仍可 Enter 提交两条消息 → 只读队列条显示预览与条数
// ② 当前回复结束 → 队列由主进程自动逐条发出（发一条、等其回复完成、再发下一条）
// ③ 队列清空后队列条消失；模型请求次数 = 首轮 + 两条排队。
// 运行：pnpm --filter @codexlike/desktop run test:e2e:input-queue（先 pnpm build）。
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
 * ① 慢速流式（12 段、每段 400ms ≈ 4.8s，供入队窗口）；
 * ② 排队一的消费 → 快速完整回复；
 * ③ 排队二的消费 → 快速完整回复。
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
      ctx.textRound("排队一的处理结果。");
      return;
    }
    if (index === 3) {
      ctx.textRound("排队二的处理结果。");
      return;
    }
    ctx.textRound("（不应被请求）");
  });
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-queue-"));
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
    await profileForm.getByLabel("模型 1").fill("mock-model");
    await window
      .locator("form")
      .getByRole("button", { name: /保存|创建/ })
      .click();
    await window.getByText("Mock").first().waitFor();
    await window.getByTestId("settings-back").click();

    // ① 回复进行中 Enter 提交：消息入队（不再被 streaming 拦截），队列条显示
    await prepareDraft(window, { approvalMode: "assist" });
    await window.getByTestId("composer-input").fill("先做个长任务");
    await window.getByTestId("composer-send").click();
    // 等流式真正开始（入队窗口内回复仍在进行）
    await window
      .getByTestId("message-assistant")
      .getByText("第0段长文")
      .waitFor({ timeout: 15_000 });

    // streaming 中 Enter：第一条入队 → 队列条出现
    const input = window.getByTestId("composer-input");
    await input.fill("排队第一条");
    await input.press("Enter");
    await window.getByTestId("queue-bar").waitFor({ timeout: 10_000 });
    await window
      .getByTestId("queue-item-preview")
      .getByText("排队第一条")
      .waitFor({ timeout: 10_000 });

    // streaming 中 Enter：第二条入队 → 条数更新
    await input.fill("排队第二条");
    await input.press("Enter");
    await window
      .getByTestId("queue-count")
      .getByText("待发 2 条")
      .waitFor({ timeout: 10_000 });
    console.log("[e2e] 回复进行中入队两条：队列条显示预览与条数");

    // ② 首轮结束 → 自动逐条消费：第一条排队消息发出并完成回复
    await window
      .getByText("排队一的处理结果。")
      .first()
      .waitFor({ timeout: 30_000 });
    // 第一条完成后第二条才发出（逐条消费），最终两条都进消息流
    await window
      .getByText("排队二的处理结果。")
      .first()
      .waitFor({ timeout: 30_000 });
    console.log("[e2e] 回复结束自动逐条消费：两条排队消息依次发出并完成");

    // ③ 队列清空 → 队列条消失
    await window.getByTestId("queue-bar").waitFor({
      state: "detached",
      timeout: 10_000,
    });
    // 模型恰好被请求三轮：首轮 + 两条排队（无多余请求）
    assert(
      getRequestCount() === 3,
      `应恰好三轮模型请求（实际 ${getRequestCount()} 次）`
    );
    console.log("[e2e] 队列清空队列条消失，模型请求次数精确");

    await closeApp(app);
    console.log("[e2e] 输入队列冒烟通过 ✅");
  } catch (error) {
    console.error("[e2e] 输入队列冒烟失败 ❌", error);
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
