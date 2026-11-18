// E2E（工单 05，ADR 0021）：正常重启后子代理详情完整回看。
// 路径：双轮子代理（思考 + 正文 + read_file 工具 → 第二轮报告）→ 主任务收尾 →
// closeApp → 重启 → 打开任务，断言快照新路径恢复的三类密度：
// 1) 工具清单完整（工具名 + 成败标记）；
// 2) 逐轮正文与逐轮思考（两轮轮边界保留，非拼接单段）；
// 3) 起止时间（列表行已用时定格 + 详情完成时刻）。
// 旧路径（subagentFromToolRecord）无工具清单、无起止时间——以上断言即
// 「新路径真发生」的判别性证据，非与旧路径二义性地重合。
// 运行：pnpm --filter @codexlike/desktop run test:e2e:subagent-recovery（先 pnpm build）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  assert,
  closeApp,
  createMockProfile,
  collapseSubagentList,
  launchApp,
  openSubagentDetail,
  prepareDraft,
  startMockProvider,
} from "./helpers.mjs";

/** 委派说明（spawn task 参数，同时是子代理请求首条 user 消息） */
const DELEGATE_TASK = "读取 note.txt 并总结要点";
const NOTE_CONTENT = "恢复回看预置文件内容XYZ";
const SUB_REASONING_1 = "恢复回看子代理第一轮思考AAA";
const SUB_REASONING_2 = "恢复回看子代理第二轮思考BBB";
const SUB_TEXT_1 = "恢复回看子代理第一轮正文：先读文件。";
const REPORT_TEXT = "恢复回看子代理最终报告CCC：已总结。";
/** 子代理请求识别标记（子代理 system 固定指令，见 agent-core subagent.ts） */
const SUBAGENT_SYSTEM_MARK = "CodexLike 的子代理";
const MAIN_TASK = "委派读取笔记并总结";

async function main() {
  const model = await startMockProvider((ctx, { body }) => {
    const request = JSON.parse(body);
    if (request.stream !== true) {
      ctx.respondJson({
        id: "compact-subagent-review",
        object: "chat.completion",
        created: 0,
        model: "mock-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "已压缩第一轮委派历史。" },
            finish_reason: "stop",
          },
        ],
      });
      return;
    }
    const lastUser = request.messages.findLast(
      (entry) => entry.role === "user"
    );
    if (
      typeof lastUser?.content === "string" &&
      lastUser.content.startsWith("后续问题")
    ) {
      ctx.textRound(`续聊完成：${lastUser.content}`);
      return;
    }
    const isSub = body.includes(SUBAGENT_SYSTEM_MARK);
    if (isSub && !body.includes(NOTE_CONTENT)) {
      // 子代理第一轮：思考 + 正文 + read_file 工具调用（一轮内三件齐发，
      // 落库后成为一条 subagent_messages 行 + 一条 subagent_tool_calls 行）
      ctx.send({
        delta: { reasoning_content: SUB_REASONING_1 },
        finish_reason: null,
      });
      ctx.send({ delta: { content: SUB_TEXT_1 }, finish_reason: null });
      ctx.toolCallRound("call-sub-read-1", "read_file", { path: "note.txt" });
      return;
    }
    if (isSub) {
      // 子代理第二轮（工具结果已回填）：思考 + 最终报告
      ctx.send({
        delta: { reasoning_content: SUB_REASONING_2 },
        finish_reason: null,
      });
      ctx.textRound(REPORT_TEXT);
      return;
    }
    // 主任务：委派指令轮 → spawn；报告回填轮 → 收尾
    if (body.includes(REPORT_TEXT)) {
      ctx.textRound("委派已收尾。");
      return;
    }
    if (body.includes(MAIN_TASK)) {
      ctx.toolCallRound("call-delegate-review", "spawn_subagent", {
        task: DELEGATE_TASK,
      });
      return;
    }
    ctx.res.writeHead(422);
    ctx.res.end("unexpected request");
  });
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-sub-recovery-"));
  const workspaceDir = join(homeDir, "workspace");
  mkdirSync(workspaceDir);
  writeFileSync(join(workspaceDir, "note.txt"), NOTE_CONTENT);

  let app;
  try {
    const first = await launchApp({ homeDir, workspaceDir });
    app = first.app;
    let window = first.window;

    // 建 Profile → 建任务 → 委派 → 等运行期完成（标记行转 done）
    await createMockProfile(window, {
      name: "Recovery Mock",
      port: model.port,
    });
    await prepareDraft(window, { approvalMode: "assist" });
    await window.getByTestId("composer-input").fill(MAIN_TASK);
    await window.getByTestId("composer-send").click();
    await window
      .locator(
        '[data-testid="subagent-stream-marker-toggle"][data-subagent-state="done"]'
      )
      .waitFor({ timeout: 20_000 });
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "委派已收尾" })
      .waitFor({ timeout: 20_000 });
    console.log("[e2e] 运行期：双轮子代理委派完成（思考/正文/工具/报告齐备）");

    // ---- 重启：同 homeDir 再启动，打开任务回看 ----
    await closeApp(app);
    const second = await launchApp({ homeDir, workspaceDir });
    app = second.app;
    window = second.window;
    await window
      .getByTestId("task-item")
      .filter({ hasText: MAIN_TASK })
      .first()
      .click();
    await window.getByTestId("message-stream").waitFor({ timeout: 20_000 });
    await window
      .locator(
        '[data-testid="subagent-stream-marker-toggle"][data-subagent-state="done"]'
      )
      .waitFor({ timeout: 15_000 });
    const panel = await openSubagentDetail(window);

    // 1) 起止时间：列表行已用时定格（mm:ss）+ 详情完成时刻（起止对齐产物）
    const elapsed = panel
      .getByTestId("subagent-rail-item")
      .getByTestId("subagent-elapsed");
    await elapsed.waitFor({ timeout: 10_000 });
    assert(
      /^\d{2}:\d{2}$/.test((await elapsed.textContent()) ?? ""),
      `恢复后已用时格式异常：${await elapsed.textContent()}`
    );
    const completedAt = panel.getByTestId("subagent-report-completed-at");
    await completedAt.waitFor({ timeout: 10_000 });
    assert(
      (await completedAt.getAttribute("dateTime")) !== null,
      "恢复后完成时刻缺失（endedAt 未恢复）"
    );
    console.log("[e2e] 起止时间恢复：已用时定格 + 完成时刻可读");

    // 2) 逐轮正文：两轮轮边界保留（第一轮过程正文 + 第二轮报告）。
    //    focus 定位展开的浮层盖住详情区拦截点击——列表行断言已完成，
    //    收起浮层（Escape 标准出口）再做详情内展开交互
    await collapseSubagentList(window);
    const bodyBlock = panel.getByTestId("subagent-body-block");
    await bodyBlock.waitFor({ timeout: 10_000 });
    await bodyBlock.getByTestId("subagent-body-toggle").click();
    const bodyText = await bodyBlock
      .getByTestId("subagent-body-content")
      .textContent();
    assert(
      bodyText !== null &&
        bodyText.includes(SUB_TEXT_1) &&
        bodyText.includes(REPORT_TEXT),
      `重启后逐轮正文不完整：${bodyText ?? "(空)"}`
    );
    assert(
      (await bodyBlock.getByTestId("subagent-body-round-1").count()) === 1 &&
        (await bodyBlock.getByTestId("subagent-body-round-2").count()) === 1,
      "正文折叠块应含两轮轮边界（非拼接单段）"
    );
    // 逐轮思考：两轮思考各自可见（轮边界保留）
    const thinkingBlock = panel.getByTestId("subagent-thinking-block");
    await thinkingBlock.waitFor({ timeout: 10_000 });
    await thinkingBlock.getByTestId("subagent-thinking-toggle").click();
    const thinkingText = await thinkingBlock
      .getByTestId("subagent-thinking-content")
      .textContent();
    assert(
      thinkingText !== null &&
        thinkingText.includes(SUB_REASONING_1) &&
        thinkingText.includes(SUB_REASONING_2),
      `重启后逐轮思考不完整：${thinkingText ?? "(空)"}`
    );
    assert(
      (await thinkingBlock.getByTestId("subagent-thinking-round-1").count()) ===
        1 &&
        (await thinkingBlock
          .getByTestId("subagent-thinking-round-2")
          .count()) === 1,
      "思考折叠块应含两轮轮边界（非拼接单段）"
    );
    console.log("[e2e] 逐轮正文/思考恢复：两轮边界完整保留");

    // 3) 工具清单：工具名 + 成败标记（旧路径此清单恒空，判别性断言）
    const tools = panel.getByTestId("subagent-tools");
    await tools.waitFor({ timeout: 10_000 });
    await tools.getByTestId("subagent-tools-toggle").click();
    await tools.getByText("read_file").waitFor({ timeout: 10_000 });
    const toolsText = await tools.textContent();
    assert(
      toolsText !== null &&
        toolsText.includes("完成") &&
        !toolsText.includes("失败"),
      `恢复后工具清单成败标记异常：${toolsText ?? "(空)"}`
    );
    // F26：两级按需展开后，真实工具参数和结果必须完整可读。
    const toolDetails = tools
      .getByTestId("subagent-tool-details")
      .filter({ hasText: "read_file" });
    await toolDetails.getByTestId("subagent-tool-toggle").click();
    assert(
      (
        await toolDetails.getByTestId("subagent-tool-arguments").textContent()
      )?.includes("note.txt"),
      "恢复后的子代理工具完整参数应可展开查看"
    );
    assert(
      (
        await toolDetails.getByTestId("subagent-tool-output").textContent()
      )?.includes(NOTE_CONTENT),
      "恢复后的子代理工具输出应可展开查看"
    );
    // 报告块照旧（恢复不破坏完成态呈现）
    const reportText = await panel.getByTestId("subagent-report").textContent();
    assert(
      reportText !== null && reportText.includes(REPORT_TEXT),
      `重启后报告缺失：${reportText ?? "(空)"}`
    );
    console.log("[e2e] 工具清单恢复：read_file + 成败标记完整");

    // F24：把含委派的首轮压掉，右栏检视数据仍应保留，不必重开任务才能回看。
    for (let index = 1; index <= 3; index += 1) {
      await window.getByTestId("composer-input").fill(`后续问题${index}`);
      await window.getByTestId("composer-send").click();
      await window
        .getByTestId("message-assistant")
        .filter({ hasText: `续聊完成：后续问题${index}` })
        .waitFor({ timeout: 20_000 });
      await window.getByTestId("composer-send").waitFor();
    }
    await window.getByTestId("composer-input").fill("/compact");
    await window.getByTestId("composer-input").press("Enter");
    await window
      .getByTestId("message-compact-summary")
      .waitFor({ timeout: 20_000 });
    await panel
      .getByTestId("subagent-report")
      .filter({ hasText: REPORT_TEXT })
      .waitFor();
    assert(
      (await panel.getByTestId("subagent-tool-output").textContent())?.includes(
        NOTE_CONTENT
      ),
      "压缩掉委派轮次后仍应保留已展开工具详情"
    );
    const taskId = await window.evaluate(
      async (title) =>
        (await window.codexlike.tasks.list()).find(
          (record) => record.title === title
        )?.id,
      MAIN_TASK
    );
    assert(typeof taskId === "string", "原任务仍存在");
    const persistedSubagents = await window.evaluate(
      async (id) => (await window.codexlike.tasks.view(id)).subagents.length,
      taskId
    );
    assert(persistedSubagents === 1, "压缩不会删除独立子代理记录");
    console.log("[e2e] 压缩后子代理详情与工具输出仍可检视");

    await closeApp(app);
    console.log("[e2e] 工单 05 正常重启回看场景通过 ✅");
  } catch (error) {
    console.error("[e2e] 正常重启回看场景失败 ❌", error);
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
