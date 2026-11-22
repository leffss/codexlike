// E2E 工作计划（GLOSSARY「工作计划」「计划项」「过程胶囊条」，ADR 0016 派生层
// + ADR 0019 呈现 + ADR 0034 胶囊条转正；主任务位折叠卡已退役）：
// 1) 模型调 update_plan → 计划胶囊出现（N/M 计数），浮层默认收起，点开见
//    头部当前步骤预览、toggle 收起；流内调用处只留一行极简标记，不渲染通用
//    工具卡；
// 2) 相邻两次 update_plan 不折叠成工具组（分组排除），标记行逐次累计；
// 3) 胶囊随最新调用全量替换（计数），浮层头部全部完成态 + 完整步骤清单
//    （完成项删除线）；
// 4) 工具结果（中文统计摘要）回传模型，下一轮请求体可查。
// 运行：pnpm test:e2e:work-plan（先 pnpm build）。
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

/** 从请求体解析指定 tool call 的结果（role=tool 消息内容） */
function toolResult(body, callId) {
  return JSON.parse(body).messages.find(
    (message) => message.role === "tool" && message.tool_call_id === callId
  )?.content;
}

/** 计划清单（三步：a/b/c），status 覆盖生成各版本 */
function plan(statuses) {
  const names = ["调研布局代码", "梳理分区清单", "输出布局方案"];
  return {
    steps: names.map((content, index) => ({
      content,
      status: statuses[index],
    })),
  };
}

async function main() {
  const { server, port, seenBodies } = await startMockProvider(
    (ctx, { index }) => {
      if (index === 1) {
        // 第 1 条消息：建计划（1 完成、1 进行中、1 待办）
        ctx.toolCallRound(
          "plan-c1",
          "update_plan",
          plan(["completed", "in_progress", "pending"])
        );
        return;
      }
      if (index === 2) {
        ctx.textRound("计划已建立");
        return;
      }
      if (index === 3) {
        // 第 2 条消息：相邻两次更新（验证分组排除与全量替换）
        ctx.toolCallRound(
          "plan-c2",
          "update_plan",
          plan(["completed", "completed", "in_progress"])
        );
        return;
      }
      if (index === 4) {
        ctx.toolCallRound(
          "plan-c3",
          "update_plan",
          plan(["completed", "completed", "completed"])
        );
        return;
      }
      ctx.textRound("全部完成");
    }
  );
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-plan-"));
  const workspaceDir = join(homeDir, "workspace");
  mkdirSync(workspaceDir);

  let app;
  try {
    const first = await launchApp({ homeDir });
    app = first.app;
    const window = first.window;

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

    // ---- 场景 1：首次 update_plan → 计划胶囊 + 单条流内标记 ----
    await window.getByTestId("composer-input").fill("列个计划");
    await window.getByTestId("composer-send").click();
    await window.getByTestId("process-pill-plan").waitFor({ timeout: 30_000 });
    await window
      .getByTestId("message-assistant")
      .getByText("计划已建立")
      .waitFor({ timeout: 30_000 });
    assert(
      (await window.getByTestId("process-pill-plan-count").textContent()) ===
        "1/3",
      "胶囊计数应为 1/3"
    );
    assert(
      (await window.getByTestId("process-pill-popover-plan").count()) === 0,
      "默认收起：浮层不渲染"
    );
    // 点开浮层：头部右侧预览当前（进行中）步骤，toggle 收起
    await window.getByTestId("process-pill-plan").click();
    await window.getByTestId("process-pill-popover-plan").waitFor();
    assert(
      (await window
        .getByTestId("process-pill-popover-plan-state")
        .textContent()) === "梳理分区清单",
      "浮层头部应预览当前步骤"
    );
    await window.getByTestId("process-pill-plan").click();
    assert(
      (await window.getByTestId("process-pill-popover-plan").count()) === 0,
      "toggle 后浮层收起"
    );
    assert(
      (await window.getByTestId("plan-marker-row").count()) === 1,
      "流内应只有一行计划标记（非工具卡）"
    );
    assert(
      (await window
        .locator('[data-testid="tool-call-card"][data-tool-name="update_plan"]')
        .count()) === 0,
      "update_plan 不得渲染通用工具卡"
    );
    console.log("[e2e] 首次更新：计划胶囊（1/3）+ 流内单条标记（无工具卡）");

    // ---- 场景 2：相邻两次更新 → 分组排除 + 全量替换 + 结果回传 ----
    await window.getByTestId("composer-input").fill("推进计划到完成");
    await window.getByTestId("composer-send").click();
    await window
      .getByTestId("message-assistant")
      .getByText("全部完成")
      .waitFor({ timeout: 30_000 });
    assert(
      (await window.getByTestId("plan-marker-row").count()) === 3,
      "三次更新应累计三行标记（相邻两次不折叠成组）"
    );
    assert(
      (await window.getByTestId("tool-call-group").count()) === 0,
      "相邻 update_plan 不得折叠成工具组"
    );
    assert(
      (await window.getByTestId("process-pill-plan-count").textContent()) ===
        "3/3",
      "胶囊应随最新调用全量替换为 3/3"
    );
    // 全部完成态：浮层头部显示「全部完成」
    await window.getByTestId("process-pill-plan").click();
    await window.getByTestId("process-pill-popover-plan").waitFor();
    assert(
      (await window
        .getByTestId("process-pill-popover-plan-state")
        .textContent()) === "全部完成",
      "全部完成后浮层头部应显示「全部完成」"
    );
    await window.getByTestId("process-pill-plan").click();
    const planResult = toolResult(seenBodies.at(-1) ?? "", "plan-c3");
    assert(
      typeof planResult === "string" && planResult.includes("工作计划已更新"),
      `工具结果（中文统计摘要）应回传模型：${planResult ?? "(未找到)"}`
    );
    console.log("[e2e] 相邻更新分组排除、胶囊全量替换、统计结果回传");

    // ---- 场景 3：点开计划浮层 → 完整步骤清单（完成项删除线） ----
    await window.getByTestId("process-pill-plan").click();
    await window.getByTestId("process-pill-popover-plan").waitFor();
    assert(
      (
        await window.getByTestId("process-pill-popover-plan").textContent()
      )?.includes("调研布局代码") === true,
      "浮层清单应显示完整步骤列表"
    );
    const lineThroughCount = await window.evaluate(() => {
      const panel = document.querySelector(
        '[data-testid="process-pill-popover-plan"]'
      );
      if (panel === null) return 0;
      return [...panel.querySelectorAll("span")].filter((span) =>
        span.className.includes("line-through")
      ).length;
    });
    assert(
      lineThroughCount === 3,
      `三个完成项都应有删除线，实际 ${lineThroughCount}`
    );
    console.log("[e2e] 浮层显示完整步骤（完成项删除线）");

    await closeApp(app);
    console.log("[e2e] 工作计划场景通过 ✅");
  } catch (error) {
    console.error("[e2e] 工作计划场景失败 ❌", error);
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
