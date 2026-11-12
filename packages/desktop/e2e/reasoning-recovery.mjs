// E2E reasoning 落库与恢复（票 02，GLOSSARY「思考档位」，ADR 0011）：
// 思考随终态消息/委派记录落 SQLite，重启后主会话与子代理的思考段可展开回看；
// 运行期切走再切回（内存事件重放）思考不重复、不丢失；旧会话（无思考数据）
// 正常打开、不产生空思考块。
// 场景：
// 1) 会话 A：reasoning + 正文 → 会话 A 再发委派消息 → spawn_subagent（子代理
//    模型回自己的 reasoning + 报告）→ 主会话收尾。
// 2) 会话 B：纯正文（无 reasoning_content）→ 等价旧数据形状。
// 3) 运行中切走再切回：慢速 reasoning 流式期间切到新会话再切回，
//    思考段唯一且内容完整（不重复、不丢失），随后收尾。
// 4) closeApp → 重启（同 homeDir）→ 打开会话 A：thinking-block 可展开回看、
//    子代理卡内 subagent-thinking-block 不空白；打开会话 B：无空思考块。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  assert,
  closeApp,
  expandWorkedHistory,
  launchApp,
  prepareDraft,
  startMockProvider,
} from "./helpers.mjs";

/** 会话 A 第一条消息（reasoning + 正文轮） */
const A_QUESTION = "带思考的问题";
/** 会话 A 第二条消息（触发子代理委派） */
const A_DELEGATE = "委派调研任务";
/** 会话 B 消息（无 reasoning，旧数据形状） */
const B_QUESTION = "旧式会话消息";
/** 慢速思考消息（运行中切换场景） */
const A_SLOW = "慢速思考问题";

async function main() {
  const model = await startMockProvider((ctx, { body }) => {
    const parsed = JSON.parse(body);
    const messages = parsed.messages ?? [];
    // 子代理请求：独立上下文（system 含子代理固定角色指令，OpenAI 兼容
    // 端点把它放进 messages，直接在原始 body 上匹配）
    if (body.includes("CodexLike 的子代理")) {
      ctx.send({
        delta: { reasoning_content: "子代理重启前的思考" },
        finish_reason: null,
      });
      setTimeout(() => {
        ctx.send({ delta: { content: "子代理最终报告" }, finish_reason: null });
        setTimeout(() => ctx.finishWith("stop"), 30);
      }, 150);
      return;
    }
    const text =
      messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
    if (text.includes(A_QUESTION)) {
      ctx.send({
        delta: { reasoning_content: "重启前主会话思考" },
        finish_reason: null,
      });
      setTimeout(() => {
        ctx.send({ delta: { content: "主会话最终回答" }, finish_reason: null });
        setTimeout(() => ctx.finishWith("stop"), 30);
      }, 100);
      return;
    }
    if (text.includes(A_DELEGATE)) {
      // 没有子代理 tool 回填时委派；回填后收尾
      if (messages.some((m) => m.role === "tool")) {
        ctx.textRound("委派已收尾");
        return;
      }
      ctx.toolCallRound("delegate-e2e", "spawn_subagent", {
        task: "调研依赖版本",
      });
      return;
    }
    if (text.includes(A_SLOW)) {
      // 慢速 reasoning：两段之间留出切换窗口
      ctx.send({
        delta: { reasoning_content: "慢速思考第一段" },
        finish_reason: null,
      });
      setTimeout(() => {
        ctx.send({
          delta: { reasoning_content: "第二段" },
          finish_reason: null,
        });
        setTimeout(() => {
          ctx.send({ delta: { content: "慢速正文收尾" }, finish_reason: null });
          setTimeout(() => ctx.finishWith("stop"), 30);
        }, 300);
      }, 700);
      return;
    }
    // 会话 B：纯正文（无 reasoning_content）
    ctx.textRound("旧式正文回答");
  });
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-reasoning-rec-"));
  /** 票 04：展开会话内全部「已工作折叠区」（完成后过程段默认收起） */
  const expandAllHistories = async (window) => {
    const toggles = window.getByTestId("worked-history-toggle");
    const total = await toggles.count();
    for (let i = 0; i < total; i++) {
      await expandWorkedHistory(window, i);
    }
  };
  const workspaceDir = join(homeDir, "workspace");
  mkdirSync(workspaceDir);

  let app;
  try {
    const first = await launchApp({ homeDir, workspaceDir });
    app = first.app;
    let window = first.window;

    // 准备：Profile（mock 端点）→ 会话 A
    await window.evaluate(async (port) => {
      await window.codexlike.providerProfiles.create({
        name: "Reasoning Mock",
        baseURL: `http://127.0.0.1:${port}/v1`,
        apiKey: "sk-e2e",
        model: "mock-model",
      });
    }, model.port);
    await prepareDraft(window);

    // ---- 场景 1a：会话 A 主会话 reasoning + 正文 ----
    await window.getByTestId("composer-input").fill(A_QUESTION);
    await window.getByTestId("composer-send").click();
    const thinkingLive = window.getByTestId("thinking-block").first();
    await thinkingLive.waitFor({ timeout: 20_000 });
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "主会话最终回答" })
      .waitFor({ timeout: 20_000 });

    // ---- 场景 1b：同会话委派子代理（子代理思考 + 报告）----
    await window.getByTestId("composer-input").fill(A_DELEGATE);
    await window.getByTestId("composer-send").click();
    await window.getByTestId("subagent-card").waitFor({ timeout: 20_000 });
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "委派已收尾" })
      .waitFor({ timeout: 20_000 });
    console.log("[e2e] 运行期：主会话与子代理思考均已流式呈现");

    // ---- 场景 2：会话 B 纯正文（旧数据形状）----
    await window.getByTestId("new-session").click();
    await window.getByTestId("draft-select-workspace").click();
    await window.getByTestId("composer-input").fill(B_QUESTION);
    await window.getByTestId("composer-send").click();
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "旧式正文回答" })
      .waitFor({ timeout: 20_000 });

    // ---- 场景 3：运行中切走再切回，思考不重复、不丢失 ----
    await window
      .getByTestId("session-item")
      .filter({ hasText: A_QUESTION })
      .first()
      .click();
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "委派已收尾" })
      .waitFor({ timeout: 20_000 });
    await window.getByTestId("composer-input").fill(A_SLOW);
    await window.getByTestId("composer-send").click();
    // 第一段思考渲染后立刻切走（新建草稿会话），流仍在后台进行
    await thinkingLive.waitFor({ timeout: 20_000 });
    await window.getByTestId("new-session").click();
    await window.getByTestId("draft-select-workspace").click();
    // 等第二段与正文都已流出（后台执行），再切回运行中会话
    for (let i = 0; i < 100 && model.requestCount() < 5; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await window
      .getByTestId("session-item")
      .filter({ hasText: A_QUESTION })
      .first()
      .click();
    // 切回后：慢速轮的思考段唯一且内容完整（两段拼接、无重复拼接）
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "慢速正文收尾" })
      .waitFor({ timeout: 20_000 });
    // 票 04：完成后过程段收进各轮「已工作折叠区」，展开后再交互/计数
    await expandAllHistories(window);
    // 展开最后一个思考块（慢速轮）：内容含两段、不含重复
    const lastThinking = window.getByTestId("thinking-block").last();
    await lastThinking.waitFor({ timeout: 10_000 });
    await lastThinking.getByTestId("thinking-toggle").click();
    const slowText = await lastThinking
      .getByTestId("thinking-content")
      .textContent();
    assert(
      slowText !== null &&
        slowText.includes("慢速思考第一段") &&
        slowText.includes("第二段") &&
        !slowText.includes("慢速思考第一段慢速思考第一段"),
      `切回后思考内容不完整或重复：${slowText ?? "(空)"}`
    );
    // 思考块总数：A_QUESTION 轮 1 + A_SLOW 轮 1 = 2（子代理思考在卡内不占主序列）
    assert(
      (await window.getByTestId("thinking-block").count()) === 2,
      `运行中切回后思考块数量应为 2（不重复），实际 ${await window.getByTestId("thinking-block").count()}`
    );
    console.log("[e2e] 运行中切走再切回：思考不重复、不丢失");

    // ---- 场景 4：重启 → 会话 A 主会话与子代理思考可回看 ----
    await closeApp(app);
    const second = await launchApp({ homeDir, workspaceDir });
    app = second.app;
    window = second.window;

    await window
      .getByTestId("session-item")
      .filter({ hasText: A_QUESTION })
      .first()
      .click();
    await window.getByTestId("message-stream").waitFor({ timeout: 20_000 });
    // 票 04：重启恢复后正常完成的轮默认收起折叠区，展开后回看历史思考段
    await expandAllHistories(window);
    // 主会话历史思考段：重启恢复，默认收起、可展开回看
    const restoredThinking = window.getByTestId("thinking-block").first();
    await restoredThinking.waitFor({ timeout: 20_000 });
    const restoredContent = restoredThinking.getByTestId("thinking-content");
    assert(!(await restoredContent.isVisible()), "恢复的思考块应默认收起");
    await restoredThinking.getByTestId("thinking-toggle").click();
    await restoredContent.waitFor({ timeout: 10_000 });
    const restoredText = await restoredContent.textContent();
    assert(
      restoredText !== null && restoredText.includes("重启前主会话思考"),
      `重启后主会话思考不可回看：${restoredText ?? "(空)"}`
    );
    assert(
      (await window.getByTestId("thinking-block").count()) === 2,
      `重启后思考段数量应为 2，实际 ${await window.getByTestId("thinking-block").count()}`
    );
    // 子代理卡内思考折叠块不空白（票 04：卡完成自动收起一次，先展开卡）
    const subagentCard = window.getByTestId("subagent-card").first();
    await subagentCard.waitFor({ timeout: 20_000 });
    await window.getByTestId("subagent-toggle").first().click();
    const subThinking = subagentCard.getByTestId("subagent-thinking-block");
    await subThinking.waitFor({ timeout: 10_000 });
    await subThinking.getByTestId("subagent-thinking-toggle").click();
    const subText = await subThinking
      .getByTestId("subagent-thinking-content")
      .textContent();
    assert(
      subText !== null && subText.includes("子代理重启前的思考"),
      `重启后子代理思考为空白：${subText ?? "(空)"}`
    );
    const reportText = await subagentCard
      .getByTestId("subagent-report")
      .textContent();
    assert(
      reportText !== null && reportText.includes("子代理最终报告"),
      "重启后子代理报告缺失（思考恢复未破坏报告）"
    );
    console.log("[e2e] 重启后：主会话与子代理思考均可展开回看");

    // ---- 场景 5：旧会话（无思考数据）打开不报错、不产生空块 ----
    await window
      .getByTestId("session-item")
      .filter({ hasText: B_QUESTION })
      .first()
      .click();
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "旧式正文回答" })
      .waitFor({ timeout: 20_000 });
    assert(
      (await window.getByTestId("thinking-block").count()) === 0,
      "旧会话不应产生思考块"
    );
    assert(
      (await window.getByTestId("subagent-card").count()) === 0 &&
        (await window.getByTestId("subagent-thinking-block").count()) === 0,
      "旧会话不应产生子代理思考块"
    );
    console.log("[e2e] 旧会话（无思考数据）正常打开，无空思考块");

    await closeApp(app);
    console.log("[e2e] reasoning 落库与恢复全链路通过 ✅");
  } catch (error) {
    console.error("[e2e] reasoning 恢复场景失败 ❌", error);
    process.exitCode = 1;
    try {
      await closeApp(app);
    } catch {
      // 已关闭
    }
  } finally {
    model.server.close();
    rmSync(homeDir, { recursive: true, force: true });
  }
}

await main();
