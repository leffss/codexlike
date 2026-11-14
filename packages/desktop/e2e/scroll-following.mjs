// 票03：滚动跟随状态机（GLOSSARY「跟随」）：流式输出期间自动贴底跟随、
// 用户上翻立即脱离且内容更新不夺滚动权、「回到最新」入口恢复跟随、
// 发送新消息强制回底、阅读位置记忆含「离开时是否贴底」（贴底记忆恢复
// 到当前最新并跟随，非贴底恢复像素位置）。
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";

import {
  assert,
  closeApp,
  launchApp,
  prepareDraft,
  startMockProvider,
} from "./helpers.mjs";

/** 消息流滚动几何 + 末段正文长度（观察跟随是否随内容增长生效） */
async function streamState(window) {
  return window.evaluate(() => {
    const el = document.querySelector('[data-testid="message-stream"]');
    if (el === null) return null;
    const last = [
      ...el.querySelectorAll('[data-testid="assistant-content"]'),
    ].at(-1);
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      distance: el.scrollHeight - el.clientHeight - el.scrollTop,
      textLength: last?.textContent?.length ?? 0,
    };
  });
}

/** 轮询直到消息流状态满足谓词（状态几何随流式内容动态变化） */
async function until(window, predicate, message, timeout = 10_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const state = await streamState(window);
    if (state !== null && predicate(state)) return state;
    if (Date.now() >= end)
      assert(false, `${message}（最后状态：${JSON.stringify(state)}）`);
    await delay(50);
  }
}

/** 轮询直到取值可用（如 mock 进入 held 等待点） */
async function untilValue(getValue, message, timeout = 10_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = getValue();
    if (value) return value;
    if (Date.now() >= end) assert(false, message);
    await delay(50);
  }
}

const chunk = (i) => `第 ${i} 段：${"滚动跟随 e2e 长文本。".repeat(60)}\n\n`;
const secondAnswer = Array.from(
  { length: 60 },
  (_, i) => `第二条答复段落 ${i + 1}：强制回底验收。`
).join("\n\n");

async function main() {
  const held = new Map();
  const model = await startMockProvider((ctx, { body }) => {
    const data = JSON.parse(body);
    const text = data.messages.filter((m) => m.role === "user").at(-1)?.content;
    if (text === "流式长文") {
      // 12 个 chunk 缓慢流出（期间断言自动跟随），随后 hold 由测试控制
      let i = 0;
      const timer = setInterval(() => {
        i += 1;
        if (i <= 12)
          ctx.send({ delta: { content: chunk(i) }, finish_reason: null });
        else {
          clearInterval(timer);
          held.set("stream", ctx);
        }
      }, 60);
      ctx.res.once("close", () => clearInterval(timer));
      return;
    }
    if (text === "第二条") {
      ctx.textRound(secondAnswer);
      return;
    }
    ctx.textRound("收到");
  });
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-follow-"));
  const workspaceDir = join(homeDir, "workspace");
  mkdirSync(workspaceDir);

  let app;
  let window;
  try {
    ({ app, window } = await launchApp({ homeDir, workspaceDir }));

    // 准备：设置页创建 Profile → 新建草稿
    await window.getByTestId("settings-open").click();
    await window.getByTestId("profile-create").click();
    const form = window.locator("form");
    await form.getByLabel("名称").fill("Follow Mock");
    await form.getByLabel("baseURL").fill(`http://127.0.0.1:${model.port}/v1`);
    await form.getByLabel("API Key").fill("sk-e2e");
    await form.getByLabel("模型").fill("follow-model");
    await window
      .locator("form")
      .getByRole("button", { name: /保存|创建/ })
      .click();
    await window.getByText("Follow Mock").first().waitFor();
    await window.getByTestId("settings-back").click();
    await prepareDraft(window);

    // ---- 场景 1：流式输出期间自动贴底跟随 ----
    await window.getByTestId("composer-input").fill("流式长文");
    await window.getByTestId("composer-send").click();
    const streaming = await until(
      window,
      (s) => s.distance <= 48 && s.textLength > 800,
      "流式输出期间应自动跟随贴底"
    );
    const streamCtx = await untilValue(
      () => held.get("stream"),
      "流式应进入 held 等待点"
    );
    const fullyGrown = await until(
      window,
      (s) => s.textLength >= streaming.textLength,
      "流式内容应全部渲染"
    );
    assert(
      fullyGrown.scrollHeight - fullyGrown.clientHeight > 1000,
      `长文本应产生可滚动的消息流：${JSON.stringify(fullyGrown)}`
    );
    // held 后继续放内容：跟随中内容增长仍被拉回底部
    streamCtx.send({ delta: { content: chunk(13) }, finish_reason: null });
    await until(
      window,
      (s) => s.distance <= 48 && s.textLength > streaming.textLength,
      "跟随中新增内容应保持贴底"
    );
    console.log("[e2e] 流式输出期间自动贴底跟随");

    // ---- 场景 2：上翻立即脱离，内容更新不夺滚动权，出现「回到最新」----
    const stream = window.getByTestId("message-stream");
    await stream.hover();
    await window.mouse.wheel(0, -1600);
    const detached = await until(
      window,
      (s) => s.distance > 500,
      "用户上翻应立即脱离跟随"
    );
    await window.getByTestId("back-to-latest").waitFor();
    streamCtx.send({ delta: { content: chunk(14) }, finish_reason: null });
    streamCtx.send({ delta: { content: chunk(15) }, finish_reason: null });
    const afterGrow = await until(
      window,
      (s) => s.textLength > detached.textLength + 100,
      "脱离期间内容应继续增长"
    );
    assert(
      Math.abs(afterGrow.scrollTop - detached.scrollTop) < 4,
      `脱离期间内容更新不得夺滚动权：${detached.scrollTop} → ${afterGrow.scrollTop}`
    );
    assert(afterGrow.distance > 500, "脱离期间应保持在历史阅读位置");
    assert(
      (await window.getByTestId("back-to-latest").count()) === 1,
      "脱离跟随时「回到最新」入口保持可见"
    );
    console.log("[e2e] 上翻脱离跟随且内容更新不夺滚动权");

    // ---- 场景 3：「回到最新」恢复跟随 ----
    await window.getByTestId("back-to-latest").click();
    await until(window, (s) => s.distance <= 48, "点击回到最新应贴底");
    assert(
      (await window.getByTestId("back-to-latest").count()) === 0,
      "恢复跟随后「回到最新」入口应消失"
    );
    streamCtx.send({ delta: { content: chunk(16) }, finish_reason: null });
    await until(
      window,
      (s) => s.distance <= 48,
      "回到最新后应恢复跟随（新内容自动贴底）"
    );
    streamCtx.finishWith("stop");
    await window.getByTestId("composer-send").waitFor({ timeout: 20_000 });
    console.log("[e2e] 回到最新恢复跟随");

    // ---- 场景 4：发送新消息强制回底并进入跟随 ----
    await stream.hover();
    await window.mouse.wheel(0, -1600);
    await until(window, (s) => s.distance > 500, "发送前先脱离跟随");
    await window.getByTestId("composer-input").fill("第二条");
    await window.getByTestId("composer-send").click();
    await window
      .getByTestId("message-assistant")
      .getByText("第二条答复段落 60")
      .waitFor({ timeout: 20_000 });
    await until(window, (s) => s.distance <= 48, "发送新消息应强制回底贴底");
    assert(
      (await window.getByTestId("back-to-latest").count()) === 0,
      "强制回底后应处于跟随态"
    );
    console.log("[e2e] 发送新消息强制回底并进入跟随");

    // ---- 场景 5：阅读位置记忆含「离开时是否贴底」 ----
    // 5a. 贴底跟随状态下切走再切回：恢复到当前最新并继续跟随
    await window.getByTestId("new-task").click();
    await window.getByTestId("new-standalone-task-item").click();
    await window.getByTestId("message-empty").waitFor();
    await window
      .getByTestId("task-item")
      .filter({ hasText: "流式长文" })
      .click();
    await window.getByTestId("message-assistant").first().waitFor();
    await until(
      window,
      (s) => s.distance <= 48,
      "贴底记忆应恢复到当前最新并继续跟随"
    );
    assert(
      (await window.getByTestId("back-to-latest").count()) === 0,
      "贴底记忆恢复后应处于跟随态"
    );
    // 5b. 脱离状态下切走再切回：恢复像素阅读位置
    await stream.hover();
    await window.mouse.wheel(0, -1600);
    const leftOff = await until(
      window,
      (s) => s.distance > 500,
      "切走前先脱离跟随"
    );
    await window.getByTestId("new-task").click();
    await window.getByTestId("new-standalone-task-item").click();
    await window.getByTestId("message-empty").waitFor();
    await window
      .getByTestId("task-item")
      .filter({ hasText: "流式长文" })
      .click();
    await window.getByTestId("message-assistant").first().waitFor();
    const restored = await until(
      window,
      (s) => Math.abs(s.scrollTop - leftOff.scrollTop) < 4,
      "非贴底记忆应恢复像素阅读位置"
    );
    assert(restored.distance > 500, "恢复后应保持脱离态");
    assert(
      (await window.getByTestId("back-to-latest").count()) === 1,
      "恢复脱离态后「回到最新」入口应可见"
    );
    console.log("[e2e] 阅读位置记忆（贴底→最新跟随 / 非贴底→像素恢复）");

    await closeApp(app);
    app = null;
    console.log("[e2e] 滚动跟随状态机场景通过 ✅");
  } catch (error) {
    console.error("[e2e] 滚动跟随状态机场景失败 ❌", error);
    process.exitCode = 1;
    try {
      await closeApp(app);
    } catch {
      // 已关闭
    }
  } finally {
    model.server.close();
    model.server.closeAllConnections();
    rmSync(homeDir, { recursive: true, force: true });
  }
}

await main();
