// E2E 时序保真（消息流重构票 01，GLOSSARY「消息段」）：一轮
// 「思考 → 正文 → 工具调用 → 思考 → 正文」交错回复在 DOM 中按事件发生
// 顺序排列——思考段不再被提升到轮次顶部合并、工具调用之后产生的正文
// 显示在工具卡之后。断言方式为严格 testid 序列（不靠文本过滤），
// 并验证思考折叠块与工具卡在新结构下的折叠交互不变、重启恢复形状。
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

/**
 * 消息流顶层段序列：每个列表项（li）自身的 testid，或其第一个带
 * testid 的子孙元素（thinking 块的 testid 在 details 上、li 是布局壳）。
 */
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
        // 第 1 轮：思考 → 正文（半段）→ read_file 工具调用（真实执行）
        ctx.send({
          delta: { reasoning_content: "先思考怎么读" },
          finish_reason: null,
        });
        ctx.send({ delta: { content: "先读文件，" }, finish_reason: null });
        ctx.toolCallRound("order-c1", "read_file", { path: "note.txt" });
        return;
      }
      if (index === 2) {
        // 第 2 轮（工具回填后）：再思考 → 最终正文
        ctx.send({
          delta: { reasoning_content: "再核对一遍" },
          finish_reason: null,
        });
        ctx.textRound("结论：内容正确");
        return;
      }
      ctx.textRound("收到");
    }
  );
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-order-"));
  const workspaceDir = join(homeDir, "workspace");
  mkdirSync(workspaceDir);
  writeFileSync(join(workspaceDir, "note.txt"), "时序 e2e 预置内容");

  let app;
  try {
    const first = await launchApp({ homeDir });
    app = first.app;
    let window = first.window;

    // 准备：设置页创建 Profile（baseURL 指向本地 mock）→ 新建会话
    await window.getByRole("button", { name: "设置", exact: true }).click();
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
    await window.getByRole("button", { name: "返回工作台" }).click();
    await prepareDraft(window);

    // 发送消息：模型按「思考 → 正文 → 工具 → 思考 → 正文」交错输出
    await window.getByTestId("composer-input").fill("读一下 note.txt");
    await window.getByTestId("composer-send").click();
    for (let tick = 0; tick < 100 && seenBodies.length < 2; tick++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(seenBodies.length === 2, `预期 2 个请求，实际 ${seenBodies.length}`);
    await window
      .getByTestId("message-assistant")
      .getByText("结论：内容正确")
      .waitFor({ timeout: 20_000 });
    await new Promise((r) => setTimeout(r, 300));

    // ---- 场景 1：严格 DOM 时序断言（testid 序列，不靠文本过滤）----
    const order = await segmentOrder(window);
    assert(Array.isArray(order), "消息流不存在");
    assert(
      JSON.stringify(order) ===
        JSON.stringify([
          "message-user",
          "thinking-block",
          "message-assistant",
          "tool-call-card",
          "thinking-block",
          "message-assistant",
        ]),
      `消息段顺序与事件发生顺序不一致：${JSON.stringify(order)}`
    );

    // 各段内容归属正确：两段思考独立成段、两段正文独立成段
    const thinkingTexts = await window.evaluate(() =>
      [...document.querySelectorAll('[data-testid="thinking-content"]')].map(
        (node) => node.textContent ?? ""
      )
    );
    assert(
      thinkingTexts.length === 2 &&
        thinkingTexts[0].includes("先思考怎么读") &&
        thinkingTexts[1].includes("再核对一遍"),
      `两段思考应交错独立存在：${JSON.stringify(thinkingTexts)}`
    );
    const assistantTexts = await window.evaluate(() =>
      [...document.querySelectorAll('[data-testid="assistant-content"]')].map(
        (node) => node.textContent ?? ""
      )
    );
    assert(
      assistantTexts.length === 2 &&
        assistantTexts[0].includes("先读文件，") &&
        !assistantTexts[0].includes("结论") &&
        assistantTexts[1].includes("结论：内容正确") &&
        !assistantTexts[1].includes("先读文件，"),
      `工具卡前后的两段正文应独立：${JSON.stringify(assistantTexts)}`
    );
    console.log("[e2e] 交错回复按事件发生顺序渲染（思考/正文/工具/思考/正文）");

    // ---- 场景 2：折叠交互在新结构下不变 ----
    const blocks = window.getByTestId("thinking-block");
    assert((await blocks.count()) === 2, "应有两个独立思考折叠块");
    const second = blocks.nth(1);
    const secondContent = second.getByTestId("thinking-content");
    assert(
      !(await secondContent.isVisible()),
      "思考块应默认收起（内容不可见）"
    );
    await second.getByTestId("thinking-toggle").click();
    await secondContent.waitFor({ timeout: 10_000 });
    assert(await secondContent.isVisible(), "展开后思考内容应可见");
    await second.getByTestId("thinking-toggle").click();
    assert(!(await secondContent.isVisible()), "收起后思考内容应不可见");

    const card = window.getByTestId("tool-call-card").first();
    assert(
      (await card.getAttribute("data-tool-name")) === "read_file",
      "工具卡应显示 read_file"
    );
    await card.getByTestId("tool-call-toggle").click();
    await card.getByText("时序 e2e 预置内容").waitFor({ timeout: 10_000 });
    console.log("[e2e] 思考折叠块与工具卡的折叠交互保持不变");

    // ---- 场景 3：重启恢复后段形状（同一消息段序列）----
    await closeApp(app);
    const secondLaunch = await launchApp({ homeDir });
    app = secondLaunch.app;
    window = secondLaunch.window;
    await window
      .getByTestId("session-item")
      .first()
      .waitFor({ timeout: 15_000 });
    await window.getByTestId("session-item").first().click();
    await window
      .getByTestId("message-user")
      .first()
      .waitFor({ timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 300));
    const restored = await segmentOrder(window);
    // 票 02 起落库历史带 reasoning：终态消息重建为思考段（位于终态消息位置，
    // 即工具卡之后）+ 终稿正文；运行期的多段思考拼接为终态全文
    assert(
      JSON.stringify(restored) ===
        JSON.stringify([
          "message-user",
          "tool-call-card",
          "thinking-block",
          "message-assistant",
        ]),
      `重启恢复后的消息段序列不正确：${JSON.stringify(restored)}`
    );
    const restoredThinking = await window
      .getByTestId("thinking-block")
      .first()
      .getByTestId("thinking-content")
      .textContent();
    assert(
      restoredThinking !== null &&
        restoredThinking.includes("先思考怎么读") &&
        restoredThinking.includes("再核对一遍"),
      `恢复后的思考全文应包含两段：${restoredThinking ?? "(空)"}`
    );
    const restoredText = await window
      .getByTestId("message-assistant")
      .last()
      .getByTestId("assistant-content")
      .textContent();
    assert(
      restoredText !== null &&
        restoredText.includes("先读文件，") &&
        restoredText.includes("结论：内容正确"),
      `恢复后的终稿正文应完整：${restoredText ?? "(空)"}`
    );
    console.log("[e2e] 重启恢复后消息段序列与终稿正文完整");

    await closeApp(app);
    console.log("[e2e] 消息段时序保真场景通过 ✅");
  } catch (error) {
    console.error("[e2e] 消息段时序保真场景失败 ❌", error);
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
