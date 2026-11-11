// E2E 思考档位（票 02，GLOSSARY「思考档位」）：从输入框胶囊选择贯通 IPC 与 agent-core
// 到本地 mock provider 的实际请求 JSON，并验证主会话思考折叠展示与正文隔离、
// 运行中切档只影响下一条消息。
// 场景：
// 1) 五档逐条发送 → 实际 HTTP body 字段符合 spec 契约（auto 无控制字段；
//    low/medium/high = thinking.type=enabled + reasoning_effort；off = disabled）。
// 2) reasoning_content SSE → 思考折叠块出现，与正文隔离，可展开 / 收起。
// 3) 运行中（工具轮回填的第二轮请求前）切档 → 第二轮 body 仍是发送时快照，
//    下一条消息才采用新档位。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { assert, closeApp, launchApp, startMockProvider } from "./helpers.mjs";

/** 五档 → 期望 body 字段（spec 接入契约表） */
const EFFORT_BODIES = [
  ["auto", { thinking: undefined, reasoningEffort: undefined }],
  ["low", { thinking: { type: "enabled" }, reasoningEffort: "low" }],
  ["medium", { thinking: { type: "enabled" }, reasoningEffort: "medium" }],
  ["high", { thinking: { type: "enabled" }, reasoningEffort: "high" }],
  ["off", { thinking: { type: "disabled" }, reasoningEffort: undefined }],
];

async function main() {
  const { server, port, seenBodies } = await startMockProvider(
    (ctx, { index }) => {
      // 场景 1+2：每条消息一轮文本（场景 2 的第 6 个请求返回 reasoning + 正文）
      if (index === 6) {
        ctx.send({
          delta: { reasoning_content: "先想想怎么回答" },
          finish_reason: null,
        });
        ctx.send({
          delta: { reasoning_content: "再核对一遍" },
          finish_reason: null,
        });
        ctx.send({ delta: { content: "这是正文回答" }, finish_reason: null });
        setTimeout(() => ctx.finishWith("stop"), 30);
        return;
      }
      // 场景 3：第 7 个请求返回工具调用（read_file 预置文件），第 8 个请求收尾文本
      if (index === 7) {
        ctx.toolCallRound("call-thinking", "read_file", { path: "note.txt" });
        return;
      }
      ctx.textRound("收到");
    }
  );
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-thinking-"));
  const workspaceDir = join(homeDir, "workspace");
  mkdirSync(workspaceDir);
  // 场景 3 的工具调用目标：工作区内预置文件（read_file 真实执行）
  writeFileSync(join(workspaceDir, "note.txt"), "思考档位 e2e 预置内容");

  let app;
  try {
    const first = await launchApp({ homeDir });
    app = first.app;
    let window = first.window;

    // 准备：设置页创建 Profile（baseURL 指向本地 mock）→ 新建会话
    await window.getByRole("button", { name: "设置", exact: true }).click();
    await window.getByRole("button", { name: "+ 新建 Profile" }).click();
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
    await window.getByTestId("new-session").click();
    await window.getByTestId("create-session-confirm").click();
    await window
      .getByTestId("session-item")
      .first()
      .waitFor({ timeout: 10_000 });

    const effortSelect = window.getByTestId("thinking-effort-select");
    // 胶囊默认自动（select 值 auto），无会话时已被禁用、建会话后可用
    assert(
      (await effortSelect.inputValue()) === "auto",
      "思考档位胶囊默认值不是 auto"
    );

    // ---- 场景 1：五档逐条发送 → 实际请求 body 符合契约 ----
    for (let i = 0; i < EFFORT_BODIES.length; i++) {
      const [effort] = EFFORT_BODIES[i];
      await effortSelect.selectOption(effort);
      await window
        .getByTestId("composer-input")
        .fill(`第${i + 1}条：档位 ${effort}`);
      await window.getByTestId("composer-send").click();
      // click 自带 actionability 等待（streaming 中是停止按钮，流结束才恢复发送）；
      // 再等本条请求真正到达 mock 端
      for (let tick = 0; tick < 100 && seenBodies.length < i + 1; tick++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert(
        seenBodies.length === i + 1,
        `第${i + 1}条消息（${effort} 档）的请求未到达 mock 端`
      );
    }
    EFFORT_BODIES.forEach(([effort, expected], i) => {
      const body = JSON.parse(seenBodies[i]);
      if (expected.thinking === undefined) {
        assert(
          body.thinking === undefined,
          `${effort} 档不应附加 thinking 字段：${seenBodies[i]}`
        );
      } else {
        assert(
          JSON.stringify(body.thinking) === JSON.stringify(expected.thinking),
          `${effort} 档 body.thinking 不正确：${seenBodies[i]}`
        );
      }
      if (expected.reasoningEffort === undefined) {
        assert(
          body.reasoning_effort === undefined,
          `${effort} 档不应附加 reasoning_effort 字段：${seenBodies[i]}`
        );
      } else {
        assert(
          body.reasoning_effort === expected.reasoningEffort,
          `${effort} 档 body.reasoning_effort 不正确：${seenBodies[i]}`
        );
      }
    });
    console.log("[e2e] 五档胶囊选择 → 实际请求 JSON 字段全部符合契约");

    // ---- 场景 2：reasoning SSE → 折叠展示、与正文隔离、可展开 / 收起 ----
    await window.getByTestId("composer-input").fill("带思考的回答");
    await window.getByTestId("composer-send").click();
    // 等第 6 个请求（含 reasoning SSE）到达 mock 端，再断言 UI 展示
    for (let tick = 0; tick < 100 && seenBodies.length < 6; tick++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(seenBodies.length === 6, `预期 6 个请求，实际 ${seenBodies.length}`);

    const thinkingBlock = window.getByTestId("thinking-block").first();
    await thinkingBlock.waitFor({ timeout: 20_000 });
    // 默认收起：思考内容不可见
    const thinkingContent = thinkingBlock.getByTestId("thinking-content");
    assert(
      !(await thinkingContent.isVisible()),
      "思考块应默认收起（内容不可见）"
    );
    // 展开可见思考内容
    await thinkingBlock.getByTestId("thinking-toggle").click();
    await thinkingContent.waitFor({ timeout: 10_000 });
    const thinkingText = await thinkingContent.textContent();
    assert(
      thinkingText !== null &&
        thinkingText.includes("先想想怎么回答") &&
        thinkingText.includes("再核对一遍") &&
        !thinkingText.includes("这是正文回答"),
      `思考内容不完整或混入正文：${thinkingText ?? "(空)"}`
    );
    // 正文区（与思考折叠块同气泡但独立渲染）：含正文、不含思考
    const assistantBubbles = window.getByTestId("message-assistant");
    const lastIndex = (await assistantBubbles.count()) - 1;
    const bubbleText = await assistantBubbles
      .nth(lastIndex)
      .getByTestId("assistant-content")
      .textContent();
    assert(
      bubbleText !== null && bubbleText.includes("这是正文回答"),
      "正文回答未出现在助手气泡"
    );
    assert(
      bubbleText !== null && !bubbleText.includes("先想想怎么回答"),
      "思考内容混入了正文气泡"
    );
    // 收起后内容再次不可见
    await thinkingBlock.getByTestId("thinking-toggle").click();
    assert(!(await thinkingContent.isVisible()), "点击收起后思考内容应不可见");
    console.log("[e2e] reasoning 流：折叠块与正文隔离，可展开 / 收起");

    // ---- 场景 3：运行中切档只影响下一条消息 ----
    // 发送 medium 档消息：第 1 轮工具调用 →（运行中把胶囊切到 off）→
    // 回填后的第 2 轮请求仍应是 medium 快照；下一条消息才用 off
    await effortSelect.selectOption("medium");
    await window.getByTestId("composer-input").fill("读一下 note.txt");
    await window.getByTestId("composer-send").click();
    // 工具卡片出现 = 第 1 轮运行中：此刻切档（为下一条消息预置）
    const toolCard = window.getByTestId("tool-call-card").first();
    await toolCard.waitFor({ timeout: 20_000 });
    assert(
      (await toolCard.getAttribute("data-tool-name")) === "read_file",
      "运行中应出现 read_file 工具卡片"
    );
    await effortSelect.selectOption("off");
    // 等本轮全部请求到达：第 8 个请求（工具回填后的最终文本轮）才是快照断言对象
    for (let i = 0; i < 100 && seenBodies.length < 8; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(seenBodies.length === 8, `预期 8 个请求，实际 ${seenBodies.length}`);
    // 等最终文本回复渲染（本轮结束）
    await window
      .getByTestId("message-assistant")
      .nth(6)
      .waitFor({ timeout: 20_000 });
    await new Promise((r) => setTimeout(r, 300));
    const secondRound = JSON.parse(seenBodies[7]);
    assert(
      secondRound.thinking !== undefined &&
        secondRound.thinking.type === "enabled" &&
        secondRound.reasoning_effort === "medium",
      `运行中切档不应影响本轮：第 2 轮请求应为 medium 快照，实际 ${seenBodies[7]}`
    );
    // 下一条消息采用新档位 off
    await window.getByTestId("composer-input").fill("新档位消息");
    await window.getByTestId("composer-send").click();
    for (let i = 0; i < 100 && seenBodies.length < 9; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(seenBodies.length === 9, `预期 9 个请求，实际 ${seenBodies.length}`);
    const nextMessage = JSON.parse(seenBodies[8]);
    assert(
      nextMessage.thinking !== undefined &&
        nextMessage.thinking.type === "disabled",
      `下一条消息应采用新档位 off：${seenBodies[8]}`
    );
    assert(
      nextMessage.reasoning_effort === undefined,
      "off 档不应附加 reasoning_effort"
    );
    console.log("[e2e] 运行中切档：本轮保持 medium 快照，下一条消息采用 off");

    await closeApp(app);
    console.log("[e2e] 思考档位主会话全链路通过 ✅");
  } catch (error) {
    console.error("[e2e] 思考档位场景失败 ❌", error);
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
