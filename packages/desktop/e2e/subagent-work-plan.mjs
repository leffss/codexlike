// E2E（票 04，ADR 0023）：子代理工作计划全链——委派 → 建计划 → 更新
// （步骤推进）→ 完成 → 右栏详情底部计划卡终态 → 重启回看。
// 路径：主任务委派子代理读 note.txt 并总结 → 子代理四轮：
// 1) update_plan 建清单（1 完成 + 1 进行中 + 1 待办）+ read_file（一帧双
//    工具调用，同轮派发）→ 2) update_plan 推进（2 完成 + 1 进行中）→
// 3) update_plan 终态（3 完成）→ 4) 最终报告；主任务收尾 → closeApp →
// 同 homeDir 重启，断言：
// 1) 运行期详情底部计划卡终态（3/3、100%、全部完成，展开清单完成项
//    删除线）——与主任务卡同款 testid（plan-card 系），容器限定右栏；
// 2) 三次 update_plan 的中文统计摘要都真实执行并逐轮回传子代理模型
//    （报告轮请求体含全部三版统计串，步骤推进链路证据）；
// 3) 工具清单含 update_plan 行（计数 4 次：3 计划 + 1 读文件）；
// 4) 重启后计划卡照常回看（已完成子代理，数据走子代理工具调用表恢复
//    快照，不依赖运行期内存）；开合记忆是渲染进程内存，重启回默认收起。
// 运行：pnpm --filter @codexlike/desktop run test:e2e:subagent-work-plan（先 pnpm build）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  assert,
  closeApp,
  launchApp,
  openSubagentDetail,
  collapseSubagentList,
  prepareDraft,
  startMockProvider,
} from "./helpers.mjs";

/** 委派说明（spawn task 参数，同时是子代理请求首条 user 消息） */
const DELEGATE_TASK = "读取 note.txt 并总结要点";
const NOTE_CONTENT = "子代理计划预置文件内容XYZ";
const REPORT_TEXT = "子代理计划最终报告CCC：已按计划完成总结。";
/** 子代理请求识别标记（子代理 system 固定指令，见 agent-core subagent.ts） */
const SUBAGENT_SYSTEM_MARK = "CodexLike 的子代理";
const MAIN_TASK = "委派读取笔记并按计划总结";
/** 计划步骤（三步，versions 覆盖生成各版本清单） */
const PLAN_STEPS = ["通读 note.txt 全文", "核对要点与细节", "输出总结报告"];
/** 各版统计摘要独特片段（工具执行输出，逐轮回传后成为轮次判别特征） */
const PLAN_V1_MARK = "1 已完成、1 进行中、1 待办";
const PLAN_V2_MARK = "2 已完成、1 进行中、0 待办";
const PLAN_V3_MARK = "3 已完成、0 进行中、0 待办";

/** 计划清单（三步），statuses 覆盖生成各版本（work-plan 场景同构） */
function plan(statuses) {
  return {
    steps: PLAN_STEPS.map((content, index) => ({
      content,
      status: statuses[index],
    })),
  };
}

async function main() {
  const model = await startMockProvider((ctx, { body }) => {
    const isSub = body.includes(SUBAGENT_SYSTEM_MARK);
    if (isSub && !body.includes(PLAN_V1_MARK)) {
      // 子代理第一轮：建计划 + 读文件（一帧双工具调用，单响应同轮派发，
      // subagent-interrupted 多 tool_calls 同帧先例）
      ctx.send({
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call-sub-plan-1",
              type: "function",
              function: {
                name: "update_plan",
                arguments: JSON.stringify(
                  plan(["completed", "in_progress", "pending"])
                ),
              },
            },
            {
              index: 1,
              id: "call-sub-read-1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"note.txt"}' },
            },
          ],
        },
        finish_reason: null,
      });
      setTimeout(() => ctx.finishWith("tool_calls"), 30);
      return;
    }
    if (isSub && !body.includes(PLAN_V2_MARK)) {
      // 子代理第二轮：计划推进（步骤 2 进行中）
      ctx.toolCallRound(
        "call-sub-plan-2",
        "update_plan",
        plan(["completed", "completed", "in_progress"])
      );
      return;
    }
    if (isSub && !body.includes(PLAN_V3_MARK)) {
      // 子代理第三轮：计划终态（全部完成）
      ctx.toolCallRound(
        "call-sub-plan-3",
        "update_plan",
        plan(["completed", "completed", "completed"])
      );
      return;
    }
    if (isSub) {
      // 子代理第四轮（终态计划结果已回填）：最终报告
      ctx.textRound(REPORT_TEXT);
      return;
    }
    // 主任务：委派指令轮 → spawn；报告回填轮 → 收尾
    if (body.includes(REPORT_TEXT)) {
      ctx.textRound("委派已收尾。");
      return;
    }
    if (body.includes(MAIN_TASK)) {
      ctx.toolCallRound("call-delegate-plan", "spawn_subagent", {
        task: DELEGATE_TASK,
      });
      return;
    }
    ctx.res.writeHead(422);
    ctx.res.end("unexpected request");
  });
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-sub-plan-"));
  const workspaceDir = join(homeDir, "workspace");
  mkdirSync(workspaceDir);
  writeFileSync(join(workspaceDir, "note.txt"), NOTE_CONTENT);

  let app;
  try {
    const first = await launchApp({ homeDir, workspaceDir });
    app = first.app;
    let window = first.window;

    // 建 Profile → 建任务 → 委派 → 等运行期完成（标记行转 done）
    await window.evaluate(async (port) => {
      await window.codexlike.providerProfiles.create({
        name: "Sub Plan Mock",
        baseURL: `http://127.0.0.1:${port}/v1`,
        apiKey: "sk-e2e",
        model: "mock-model",
      });
    }, model.port);
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
    console.log("[e2e] 运行期：子代理四轮走完（建计划→推进→终态→报告）");

    // ---- 运行期：右栏详情底部计划卡终态 ----
    const panel = await openSubagentDetail(window);
    // focus 定位自动展开的浮层盖住详情区，收起后详情才可点击
    await collapseSubagentList(window);
    // 与主任务卡同款 testid，容器限定子代理详情（本轮主任务未建计划）
    await panel.getByTestId("plan-card").waitFor({ timeout: 10_000 });
    assert(
      (await panel.getByTestId("plan-card-count").textContent()) === "3/3",
      "子代理计划卡计数应为 3/3（终态全量替换）"
    );
    assert(
      (await panel.getByTestId("plan-card-percent").textContent()) === "100%",
      "子代理计划卡百分比徽章应为 100%"
    );
    assert(
      (await panel.getByTestId("plan-card-done").textContent()) === "全部完成",
      "收起态应显示「全部完成」"
    );
    const cardLabel = await panel
      .getByTestId("plan-card-toggle")
      .getAttribute("aria-label");
    assert(
      cardLabel !== null && cardLabel.includes("全部完成"),
      `卡 aria 应含「全部完成」：${cardLabel ?? "(空)"}`
    );
    // 展开：完整清单三步骤，完成项删除线（work-plan 场景同构）
    await panel.getByTestId("plan-card-toggle").click();
    await panel.getByTestId("plan-card-panel").waitFor();
    for (const step of PLAN_STEPS) {
      assert(
        (await panel.getByTestId("plan-card-panel").textContent())?.includes(
          step
        ) === true,
        `展开清单应含步骤「${step}」`
      );
    }
    const lineThroughCount = await panel
      .getByTestId("plan-card-panel")
      .evaluate(
        (node) =>
          [...node.querySelectorAll("span")].filter((span) =>
            span.className.includes("line-through")
          ).length
      );
    assert(
      lineThroughCount === 3,
      `三个完成项都应有删除线，实际 ${lineThroughCount}`
    );
    console.log("[e2e] 运行期详情：计划卡终态 3/3（100%）+ 展开清单删除线");

    // 工具清单：含 update_plan 行（3 计划 + 1 读文件 = 4 次）
    const tools = panel.getByTestId("subagent-tools");
    await tools.waitFor({ timeout: 10_000 });
    await tools.locator("summary").click();
    const toolsText = await tools.textContent();
    assert(
      toolsText !== null &&
        toolsText.includes("update_plan") &&
        toolsText.includes("read_file"),
      `工具清单应含 update_plan 与 read_file：${toolsText ?? "(空)"}`
    );
    assert(
      toolsText.includes("工具调用（4 次）") === true,
      `工具调用计数应为 4 次：${toolsText}`
    );
    console.log("[e2e] 工具清单：update_plan ×3 + read_file（4 次计数）");

    // 步骤推进链路证据：子代理报告轮请求体含全部三版中文统计摘要
    // （三次 update_plan 都真实执行并逐轮回传模型）
    const reportBody = model.seenBodies.find(
      (item) =>
        item.includes(SUBAGENT_SYSTEM_MARK) && item.includes(PLAN_V3_MARK)
    );
    assert(reportBody !== undefined, "未找到含终态计划的子代理请求体");
    assert(
      reportBody.includes(PLAN_V1_MARK) &&
        reportBody.includes(PLAN_V2_MARK) &&
        reportBody.includes(PLAN_V3_MARK),
      "报告轮请求体应含三版计划统计摘要（建计划/推进/终态都回传）"
    );
    console.log("[e2e] 请求体证据：三版计划统计摘要逐轮回传子代理模型");

    // ---- 重启：同 homeDir 再启动，计划卡照常回看（恢复快照路径） ----
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
    const restored = await openSubagentDetail(window);
    await collapseSubagentList(window);

    // 恢复路径计划卡：数据走子代理工具调用表快照（subagent_tool_calls），
    // 不依赖运行期内存；开合记忆是渲染进程内存，重启回默认收起
    await restored.getByTestId("plan-card").waitFor({ timeout: 10_000 });
    assert(
      (await restored.getByTestId("plan-card-count").textContent()) === "3/3",
      "重启后子代理计划卡计数应为 3/3"
    );
    assert(
      (await restored.getByTestId("plan-card-percent").textContent()) ===
        "100%",
      "重启后子代理计划卡百分比应为 100%"
    );
    assert(
      (await restored.getByTestId("plan-card-done").count()) === 1,
      "重启后默认收起：收起态「全部完成」行应渲染"
    );
    await restored.getByTestId("plan-card-toggle").click();
    await restored.getByTestId("plan-card-panel").waitFor();
    const restoredPanelText = await restored
      .getByTestId("plan-card-panel")
      .textContent();
    for (const step of PLAN_STEPS) {
      assert(
        restoredPanelText?.includes(step) === true,
        `重启后展开清单应含步骤「${step}」`
      );
    }
    const restoredLineThrough = await restored
      .getByTestId("plan-card-panel")
      .evaluate(
        (node) =>
          [...node.querySelectorAll("span")].filter((span) =>
            span.className.includes("line-through")
          ).length
      );
    assert(
      restoredLineThrough === 3,
      `重启后三个完成项都应有删除线，实际 ${restoredLineThrough}`
    );
    // 恢复后工具清单照常含 update_plan 行（快照 tools 通道）
    const restoredTools = restored.getByTestId("subagent-tools");
    await restoredTools.waitFor({ timeout: 10_000 });
    await restoredTools.locator("summary").click();
    assert(
      (await restoredTools.textContent())?.includes("update_plan") === true,
      "重启后工具清单应含 update_plan（子代理工具调用表恢复）"
    );
    console.log("[e2e] 重启回看：计划卡 3/3 终态照常（恢复快照路径）");

    await closeApp(app);
    console.log("[e2e] 票 04 子代理工作计划全链场景通过 ✅");
  } catch (error) {
    console.error("[e2e] 子代理工作计划场景失败 ❌", error);
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
