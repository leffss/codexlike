// E2E（票 02）：队列暂停状态机——停止保留队列、恢复/清空与插话自动恢复。
// 路径：设置页建 Profile（本地 mock SSE）→ 建任务
// ① 回复进行中入队 → 点停止 → 当前回复中断、队列原样保留、队列条显示暂停态
//    （「已暂停」+「恢复」「清空」操作可见）
// ② 暂停期间直接发新消息（插话，无需先解除暂停）→ 插话回复结束 →
//    暂停自动解除、队列从队首自动继续 → 队列清空后队列条消失
// ③ 再次排队 → 停止 → 手动「恢复」→ 队列继续消费
// ④ 再次排队 → 停止 → 「清空」→ 队列条消失、模型不再被请求（无残留）。
// 运行：pnpm --filter @codexlike/desktop run test:e2e:input-queue-pause（先 pnpm build）。
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
 * ① 首轮慢速流式（12 段、每段 400ms，供入队与停止窗口）；
 * ② 插话 → 快速完整回复（结束后队列自动恢复）；
 * ③ 排队一的消费 → 快速完整回复；
 * ④ 第二轮慢速流式（手动恢复场景）；
 * ⑤ 「待恢复消息」的消费 → 快速完整回复；
 * ⑥ 第三轮慢速流式（清空场景）；
 * ⑦+ 不应被请求（清空后无消费）。
 */
async function main() {
  const {
    server,
    port,
    requestCount: getRequestCount,
  } = await startMockProvider((ctx, { index }) => {
    if (index === 1 || index === 4 || index === 6) {
      ctx.textChunksRound(
        Array.from({ length: 12 }, (_, i) => `第${i}段长文。`),
        400
      );
      return;
    }
    if (index === 2) {
      ctx.textRound("插话的处理结果。");
      return;
    }
    if (index === 3) {
      ctx.textRound("排队一的处理结果。");
      return;
    }
    if (index === 5) {
      ctx.textRound("恢复后消息的处理结果。");
      return;
    }
    ctx.textRound("（不应被请求）");
  });
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-queue-pause-"));
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

    // ① 回复进行中入队一条 → 点停止 → 队列保留并进入暂停态
    await prepareDraft(window, { approvalMode: "assist" });
    await window.getByTestId("composer-input").fill("先做个长任务");
    await window.getByTestId("composer-send").click();
    await window
      .getByTestId("message-assistant")
      .getByText("第0段长文")
      .waitFor({ timeout: 15_000 });

    const input = window.getByTestId("composer-input");
    await input.fill("排队第一条");
    await input.press("Enter");
    await window.getByTestId("queue-bar").waitFor({ timeout: 10_000 });

    await window.getByTestId("composer-stop").click();
    // 暂停可见：队列条显示「已暂停」并提供「恢复」「清空」操作
    await window.getByTestId("queue-paused").waitFor({ timeout: 10_000 });
    await window.getByTestId("queue-resume").waitFor({ timeout: 10_000 });
    await window.getByTestId("queue-clear").waitFor({ timeout: 10_000 });
    // 当前回复按现有中断行为终止；队列原样保留
    await window
      .getByText("（已中断，以上为部分回复）")
      .first()
      .waitFor({ timeout: 10_000 });
    await window
      .getByTestId("queue-item-preview")
      .getByText("排队第一条")
      .waitFor({ timeout: 10_000 });
    // 停止后输入区恢复（streaming 复位），暂停期间可直接发新消息
    await window.getByTestId("composer-send").waitFor({ timeout: 10_000 });
    console.log("[e2e] 停止后队列保留并进入暂停态：已暂停 + 恢复/清空可见");

    // ② 暂停期间直接发新消息（插话，无需先解除暂停）→ 快速完整回复
    await input.fill("插话一句");
    await input.press("Enter");
    await window
      .getByText("插话的处理结果。")
      .first()
      .waitFor({ timeout: 30_000 });
    // 插话回复结束 → 暂停自动解除、队列自动继续：排队消息发出并完成
    await window
      .getByText("排队一的处理结果。")
      .first()
      .waitFor({ timeout: 30_000 });
    // 队列清空 → 队列条消失（暂停标记随之消失，无残留）
    await window.getByTestId("queue-bar").waitFor({
      state: "detached",
      timeout: 10_000,
    });
    console.log("[e2e] 插话直发 → 回复结束自动恢复消费，队列清空条消失");

    // ③ 手动恢复：再排队 → 停止 → 点「恢复」→ 从队首继续消费
    await input.fill("第二轮长任务");
    await input.press("Enter");
    await window
      .getByTestId("message-assistant")
      .getByText("第0段长文")
      .nth(1)
      .waitFor({ timeout: 15_000 });
    await input.fill("待恢复消息");
    await input.press("Enter");
    await window
      .getByTestId("queue-item-preview")
      .getByText("待恢复消息")
      .waitFor({ timeout: 10_000 });
    await window.getByTestId("composer-stop").click();
    await window.getByTestId("queue-paused").waitFor({ timeout: 10_000 });

    await window.getByTestId("queue-resume").click();
    // 恢复：暂停标记消失，队列条回到正常排队态，随即自动消费
    await window.getByTestId("queue-paused").waitFor({
      state: "detached",
      timeout: 10_000,
    });
    await window
      .getByText("恢复后消息的处理结果。")
      .first()
      .waitFor({ timeout: 30_000 });
    await window.getByTestId("queue-bar").waitFor({
      state: "detached",
      timeout: 10_000,
    });
    console.log("[e2e] 手动恢复：清暂停标志并从队首继续消费");

    // ④ 清空：再排队两条 → 停止 → 点「清空」→ 队列条消失、模型不再被请求
    await input.fill("第三轮长任务");
    await input.press("Enter");
    await window
      .getByTestId("message-assistant")
      .getByText("第0段长文")
      .nth(2)
      .waitFor({ timeout: 15_000 });
    await input.fill("作废第一条");
    await input.press("Enter");
    await input.fill("作废第二条");
    await input.press("Enter");
    await window
      .getByTestId("queue-count")
      .getByText("待发 2 条")
      .waitFor({ timeout: 10_000 });
    await window.getByTestId("composer-stop").click();
    await window.getByTestId("queue-paused").waitFor({ timeout: 10_000 });

    await window.getByTestId("queue-clear").click();
    await window.getByTestId("queue-bar").waitFor({
      state: "detached",
      timeout: 10_000,
    });
    // 清空后不再消费：模型恰好被请求六轮（无第七次）
    await new Promise((r) => setTimeout(r, 800));
    assert(
      getRequestCount() === 6,
      `清空后不应再有模型请求（实际 ${getRequestCount()} 次）`
    );
    console.log("[e2e] 清空：全部作废、队列条消失、模型不再被请求");

    await closeApp(app);
    console.log("[e2e] 队列暂停状态机冒烟通过 ✅");
  } catch (error) {
    console.error("[e2e] 队列暂停状态机冒烟失败 ❌", error);
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
