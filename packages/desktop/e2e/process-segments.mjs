// E2E 过程段逐段呈现（ADR 0015，GLOSSARY「轮次」「过程段」；取代原
// worked-history.mjs 的已工作折叠区场景）：
// 1) 轮完成后过程段平铺常驻：思考/中间正文卡/工具组各自显示段耗时，
//    被隔断的中间正文以过程卡（默认收起、摘要行回看）呈现；
// 2) 运行中的工具卡默认展开（参数与输出实时可见），完成后自动收起；
// 3) 连续同类工具呈统计分组（组头计数、含失败标记），展开组仍由原卡片
//    渲染，工具卡摘要行带耗时，失败详情在状态位可查；
// 4) 中断终态保留部分正文（可复制），错误终态正文不伪装成功。
// 运行：pnpm test:e2e:process-segments（先 pnpm build）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** 消息流顶层段序列（轮 li 与段 li 都收集，DOM 序即时序） */
async function segmentOrder(window) {
  return window.evaluate(() => {
    const stream = document.querySelector('[data-testid="message-stream"]');
    if (stream === null) return null;
    return [...stream.querySelectorAll("ol > li")].map((li) => {
      if (li.hasAttribute("data-testid")) return li.dataset.testid;
      const inner = li.querySelector("[data-testid]");
      return inner === null ? null : inner.dataset.testid;
    });
  });
}

async function main() {
  const { server, port, seenBodies } = await startMockProvider(
    (ctx, { index }) => {
      if (index === 1) {
        // 第 1 轮开始：思考 → 中间正文 → 第一个 read_file
        ctx.send({
          delta: { reasoning_content: "先规划读哪些文件" },
          finish_reason: null,
        });
        ctx.send({ delta: { content: "先读文件，" }, finish_reason: null });
        ctx.toolCallRound("worked-c1", "read_file", { path: "note.txt" });
        return;
      }
      if (index === 2) {
        ctx.toolCallRound("worked-c2", "read_file", { path: "note2.txt" });
        return;
      }
      if (index === 3) {
        // 连续第三个同类（目标缺失 → 失败卡，验证组头「含失败」与失败详情）
        ctx.toolCallRound("worked-c3", "read_file", { path: "missing.txt" });
        return;
      }
      if (index === 4) {
        // 慢速命令（约 2 秒）：给「运行中工具卡默认展开」留出观察窗口
        ctx.toolCallRound("worked-c4", "run_terminal_command", {
          command: "node slow.js",
        });
        return;
      }
      if (index === 5) {
        // 第 1 轮收尾：再思考 → 最终正文
        ctx.send({
          delta: { reasoning_content: "读完了，做个结论" },
          finish_reason: null,
        });
        ctx.textRound("调研完成：文件都看过了");
        return;
      }
      if (index === 6) {
        // 第 2 条消息：思考 + 慢速长文（供中途停止）
        ctx.send({
          delta: { reasoning_content: "开始写长文" },
          finish_reason: null,
        });
        ctx.textChunksRound(
          Array.from({ length: 20 }, (_, i) => `第${i}段长文。`),
          300
        );
        return;
      }
      if (index === 7) {
        ctx.send({
          delta: { content: "失败前保留的正文" },
          finish_reason: null,
        });
        ctx.toolCallRound("failed-c1", "read_file", { path: "note.txt" });
        return;
      }
      if (index === 8) {
        ctx.res.writeHead(401, { "content-type": "application/json" });
        ctx.res.end(
          JSON.stringify({
            error: { message: "测试失败", type: "invalid_api_key" },
          })
        );
        return;
      }
      ctx.textRound("收到");
    }
  );
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-process-"));
  const workspaceDir = join(homeDir, "workspace");
  mkdirSync(workspaceDir);
  writeFileSync(join(workspaceDir, "note.txt"), "第一个文件内容");
  writeFileSync(join(workspaceDir, "note2.txt"), "第二个文件内容");
  // 慢速脚本：空转 2 秒后退出（node <脚本> 在 assist 档自动放行）
  writeFileSync(join(workspaceDir, "slow.js"), "setTimeout(() => {}, 2000);\n");

  let app;
  try {
    const first = await launchApp({ homeDir });
    app = first.app;
    let window = first.window;

    // 准备：设置页创建 Profile → 新建任务
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
    await prepareDraft(window, { approvalMode: "assist" });

    // ---- 场景 0：运行中的工具卡默认展开（ADR 0015）----
    await window.getByTestId("composer-input").fill("调研这些文件");
    await window.getByTestId("composer-send").click();
    const termCard = window.locator(
      '[data-testid="tool-call-card"][data-tool-name="run_terminal_command"]'
    );
    await termCard.waitFor({ timeout: 30_000 });
    // 不点击卡头，输出区直接可见 = 运行中默认展开
    await termCard.getByTestId("tool-call-output").waitFor({ timeout: 10_000 });
    console.log("[e2e] 运行中的工具卡默认展开（参数与输出实时可见）");

    // ---- 场景 1：轮完成后过程段平铺常驻，各段自带工时 ----
    await window
      .getByTestId("message-assistant")
      .getByText("调研完成：文件都看过了")
      .waitFor({ timeout: 30_000 });
    for (let tick = 0; tick < 100 && seenBodies.length < 5; tick++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(seenBodies.length === 5, `预期 5 个请求，实际 ${seenBodies.length}`);
    await new Promise((r) => setTimeout(r, 300));

    // 完成后的工具卡自动收起：运行卡输出区移出 DOM（无需手动操作）
    await termCard
      .getByTestId("tool-call-output")
      .waitFor({ state: "detached", timeout: 30_000 });
    console.log("[e2e] 工具卡完成自动收起（输出区移出 DOM）");

    const order = await segmentOrder(window);
    assert(
      JSON.stringify(order) ===
        JSON.stringify([
          "message-turn",
          "message-user",
          "thinking-block",
          "process-text-block",
          "tool-call-group",
          "tool-call-card",
          "thinking-block",
          "message-assistant",
        ]),
      `轮完成后过程段应平铺常驻（思考/中间正文卡/工具组/单卡/思考/最终正文）：${JSON.stringify(order)}`
    );

    // 各段自带耗时：思考卡、中间正文卡、单张工具卡摘要行、组头跨度
    assert(
      (await window.getByTestId("thinking-duration").count()) === 2,
      "两个思考卡摘要行应显示段耗时"
    );
    assert(
      (await window.getByTestId("process-text-duration").count()) === 1,
      "中间正文卡摘要行应显示段耗时"
    );
    const processSummary = await window
      .getByTestId("process-text-summary")
      .textContent();
    assert(
      processSummary !== null && processSummary.includes("先读文件，"),
      `中间正文卡摘要行应显示首行：${processSummary ?? "(空)"}`
    );
    assert(
      (await window
        .locator(
          '[data-testid="tool-call-card"][data-tool-name="run_terminal_command"]'
        )
        .getByTestId("tool-call-duration")
        .count()) === 1,
      "单张工具卡摘要行应显示耗时"
    );
    assert(
      (await window.getByTestId("tool-call-group-duration").count()) === 1,
      "工具组组头应显示跨度汇总"
    );
    console.log("[e2e] 过程段平铺常驻：思考/中间正文卡/工具卡逐段自带耗时");

    // ---- 场景 2：连续同类工具统计分组 + 失败详情 ----
    const group = window.getByTestId("tool-call-group");
    assert((await group.count()) === 1, "应有一个连续同类工具统计组");
    assert(
      (await group.getAttribute("data-tool-name")) === "read_file" &&
        (await group.getAttribute("data-count")) === "3",
      "组头应统计 read_file × 3"
    );
    assert(
      (await window.getByTestId("tool-call-group-error").count()) === 1,
      "组内含失败卡时组头应有「含失败」标记"
    );
    assert(
      (await window.getByTestId("tool-call-card").count()) === 1,
      "组收起时除组外单卡外不应渲染组内原卡片"
    );

    // 展开组：3 张原卡，可展开看输出；失败卡状态位悬停可查错误详情
    await group.getByTestId("tool-call-group-toggle").click();
    await window.getByTestId("tool-call-group-items").waitFor();
    const cards = window.getByTestId("tool-call-card");
    assert((await cards.count()) === 4, "展开组后应有 4 张原卡片（3+1）");
    const firstCard = cards.nth(0);
    await firstCard.getByTestId("tool-call-toggle").click();
    await firstCard.getByText("第一个文件内容").waitFor({ timeout: 10_000 });
    assert(
      (await firstCard.getByTestId("tool-call-duration").count()) === 1,
      "工具卡摘要行应显示耗时"
    );
    const failedCard = window
      .locator('[data-testid="tool-call-card"]')
      .filter({ hasText: "missing.txt" });
    await failedCard.getByTestId("tool-call-toggle").click();
    const failedStatus = failedCard.getByTestId("tool-call-status");
    assert(
      (await failedStatus.textContent())?.includes("失败") === true,
      "失败卡状态位应显示失败"
    );
    const failedDetail = await failedStatus.getAttribute("title");
    assert(
      failedDetail !== null && failedDetail.length > 0,
      "失败详情应在状态位可查（悬停提示）"
    );
    console.log("[e2e] 连续同类统计分组 + 原卡渲染 + 耗时/失败详情");

    // ---- 场景 3：中断终态保留部分正文（可复制），思考卡收起 ----
    await window.evaluate(() => {
      window.interruptedMessage = null;
      window.removeInterruptedListener = window.codexlike.onTaskEvent(
        ({ event }) => {
          if (event.type === "assistant-aborted")
            window.interruptedMessage = event.message;
        }
      );
    });
    await window.getByTestId("composer-input").fill("写一篇长文");
    await window.getByTestId("composer-send").click();
    await window
      .getByTestId("message-assistant")
      .getByText("第0段长文")
      .waitFor({ timeout: 20_000 });
    const interruptedTurn = window.getByTestId("message-turn").last();
    assert(
      (await interruptedTurn.getByTestId("assistant-actions").count()) === 0,
      "流式部分正文不得提前显示操作栏"
    );
    await window.getByTestId("composer-stop").click();
    await window
      .getByText("（已中断，以上为部分回复）")
      .first()
      .waitFor({ timeout: 10_000 });

    const interruptedThinking = window.getByTestId("thinking-block").last();
    assert(
      await interruptedThinking.getByTestId("thinking-toggle").isVisible(),
      "中断轮的思考卡摘要行应可见（过程段平铺常驻）"
    );
    assert(
      !(await interruptedThinking.getByTestId("thinking-content").isVisible()),
      "中断轮的思考卡应自动收起（内容不可见）"
    );
    await interruptedTurn.getByTestId("assistant-copy").waitFor();
    assert(
      (await interruptedTurn.getByTestId("assistant-completed-at").count()) ===
        0,
      "中断正文不能显示成功完成时间"
    );
    const partialContent = await interruptedTurn
      .getByTestId("assistant-content")
      .textContent();
    const terminalContent = await window.evaluate(() => {
      window.removeInterruptedListener();
      return window.interruptedMessage?.content;
    });
    // 当前场景只有一个正文段，终态会用完整消息纠正增量；期望取公开终态原文，
    // 不把最后一次 delta 或经 Markdown 渲染/trim 后的文本当作原始正文。
    assert(
      typeof terminalContent === "string" && terminalContent.length > 0,
      "必须收到非空中断终态正文"
    );
    assert(
      partialContent === terminalContent,
      "纯文本场景的可见正文应与中断终态一致"
    );
    await interruptedTurn.getByTestId("assistant-copy").click();
    await interruptedTurn
      .getByTestId("assistant-copy-feedback")
      .filter({ hasText: "已复制" })
      .waitFor({ state: "attached" });
    const copiedContent = await app.evaluate(({ clipboard }) =>
      clipboard.readText()
    );
    assert(
      copiedContent === terminalContent,
      `中断正文应复制当前段原文且不含中断提示：${JSON.stringify({ expected: terminalContent, actual: copiedContent })}`
    );
    console.log("[e2e] 中断终态保留可复制正文，思考卡自动收起");

    // ---- 场景 4：错误终态保留的正文可复制，不伪装成功 ----
    await window.getByTestId("composer-input").fill("执行到一半失败");
    await window.getByTestId("composer-send").click();
    const failedTurn = window.getByTestId("message-turn").last();
    await failedTurn.getByTestId("message-error").waitFor({ timeout: 20_000 });
    await failedTurn.getByTestId("assistant-copy").waitFor();
    assert(
      (await failedTurn.getByTestId("assistant-completed-at").count()) === 0,
      "错误终态不能显示成功时间"
    );
    await failedTurn.getByTestId("assistant-copy").click();
    await failedTurn
      .getByTestId("assistant-copy-feedback")
      .filter({ hasText: "已复制" })
      .waitFor({ state: "attached" });
    assert(
      (await app.evaluate(({ clipboard }) => clipboard.readText())) ===
        "失败前保留的正文",
      "错误正文复制不能混入错误提示或先前轮次内容"
    );

    await closeApp(app);
    console.log("[e2e] 过程段逐段呈现场景通过 ✅");
  } catch (error) {
    console.error("[e2e] 过程段逐段呈现场景失败 ❌", error);
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
