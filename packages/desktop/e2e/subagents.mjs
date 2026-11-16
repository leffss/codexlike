// E2E（工单 13）：spawn_subagent 子代理委派的真实应用冒烟。
// 路径：建 Profile（本地 mock 按请求特征分流主/子两级）→ 设置页子代理配置区
// （并发上限改为 2 保存）→ 建任务 → 委派调研 → 嵌套卡片运行→完成、报告可展开 →
// 断言主请求的 system 委派策略与 spawn_subagent 描述契约；子请求独立上下文
// （含 task、不含主任务原文和主策略）且工具表无 spawn_subagent（防递归）
// → 主模型第二轮收到报告（回流）→ 重启后嵌套卡片恢复（报告持久化）。
// mock 固定返回委派调用，只验证提示与链路，不证明真实模型会自主选择委派。
// 运行：pnpm --filter @codexlike/desktop run test:e2e:subagents（先 pnpm build）。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  assert,
  closeApp,
  launchApp,
  openSubagentDetail,
  prepareDraft,
  startMockProvider,
} from "./helpers.mjs";

const DELEGATE_TASK = "E2E委派调研任务标记";
const REPORT_MARKER = "E2E子代理报告标记XYZ";
const SUBAGENT_SYSTEM_MARK = "CodexLike 的子代理";
const DELEGATION_POLICY_HEADING = "## 子代理委派策略";
const MAIN_TASK = "委派调研一下测试入口";
const DELEGATE_CALL_ID = "call-delegate-1";

// 只提取指定角色的正文，避免工具描述或历史引用碰巧包含标记而误判请求身份。
function messageText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function roleText(request, role) {
  return request.messages
    .filter((message) => message.role === role)
    .map(messageText)
    .join("\n");
}

function isSubagentRequest(request) {
  return roleText(request, "system").includes(SUBAGENT_SYSTEM_MARK);
}

function isMainRequest(request) {
  return (
    !isSubagentRequest(request) &&
    request.messages.some(
      (message) => message.role === "user" && messageText(message) === MAIN_TASK
    )
  );
}

function hasDelegateReport(request) {
  return request.messages.some(
    (message) =>
      message.role === "tool" &&
      message.tool_call_id === DELEGATE_CALL_ID &&
      messageText(message).includes(REPORT_MARKER)
  );
}

/**
 * 场景脚本（按请求特征分流三级）：
 * - 子代理请求（system 含子代理标记）→ SSE 回文本报告；
 * - 主任务请求且消息含委派指令 → SSE 回 spawn_subagent tool_call；
 * - 主任务请求且消息含报告（工具结果回填后）→ SSE 回汇总文本。
 * 全部请求体由骨架记录（seenBodies，主/子两级上下文隔离的真实证据）。
 */
async function main() {
  const { server, port, seenBodies } = await startMockProvider(
    (ctx, { body }) => {
      const request = JSON.parse(body);
      // 子代理请求：独立上下文（system 为子代理固定指令）
      if (isSubagentRequest(request)) {
        ctx.textRound(`${REPORT_MARKER}：调研完成，共 3 个入口。`);
        return;
      }
      // 主任务第二轮：报告已作为对应调用的工具结果回填。
      if (isMainRequest(request) && hasDelegateReport(request)) {
        ctx.textRound("子代理的报告已汇总。");
        return;
      }
      // 主任务第一轮：发起 spawn_subagent 委派
      if (isMainRequest(request)) {
        ctx.toolCallRound(DELEGATE_CALL_ID, "spawn_subagent", {
          task: DELEGATE_TASK,
        });
        return;
      }
      ctx.res.writeHead(422);
      ctx.res.end("unexpected request");
    }
  );
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-subagents-"));
  mkdirSync(join(homeDir, "workspace"), { recursive: true });

  let app;
  try {
    const { app: launchedApp, window } = await launchApp({ homeDir });
    app = launchedApp;

    // 1) 设置页创建 Profile
    await window.getByTestId("settings-open").click();
    await window.getByTestId("profile-create").click();
    const profileForm = window.locator("form");
    await profileForm.getByLabel("名称").fill("Mock");
    await profileForm.getByLabel("baseURL").fill(`http://127.0.0.1:${port}/v1`);
    await profileForm.getByLabel("API Key").fill("sk-e2e");
    await profileForm.getByLabel("模型").fill("mock-model");
    await profileForm.getByRole("button", { name: /保存|创建/ }).click();
    await window.getByText("Mock").first().waitFor();

    // 2) 子代理配置区：并发上限改为 2 保存（对后续任务生效）
    const concurrencyInput = window.getByTestId("subagent-concurrency-input");
    await concurrencyInput.fill("2");
    await window.getByTestId("subagent-settings-save").click();
    await window
      .getByTestId("subagent-settings-message")
      .waitFor({ timeout: 10_000 });
    const savedMessage = await window
      .getByTestId("subagent-settings-message")
      .textContent();
    assert(
      savedMessage?.includes("已保存") === true,
      `子代理设置保存失败：${savedMessage}`
    );
    console.log("[e2e] 设置页子代理配置区：并发上限 2 已保存");

    // 3) 建任务 + 委派调研
    await window.getByTestId("settings-back").click();
    await prepareDraft(window, { approvalMode: "assist" });
    const composer = window.getByTestId("composer-input");
    await composer.fill(MAIN_TASK);
    await composer.press("Enter");

    // 4) 子代理正文迁右栏（ADR 0020）：委派后消息流建标记行（运行中窗口
    //    短，attach 即证明建卡）；等主轮最终正文后标记行转完成态，点击
    //    打开右栏「子代理」tab 定位详情，报告直接可读（无需展开）
    await window
      .getByTestId("subagent-stream-marker-toggle")
      .waitFor({ timeout: 20_000 });
    await window
      .getByTestId("message-assistant")
      .getByText("子代理的报告已汇总。")
      .waitFor({ timeout: 20_000 });
    await window
      .locator(
        '[data-testid="subagent-stream-marker-toggle"][data-subagent-state="done"]'
      )
      .waitFor({ timeout: 20_000 });
    const subagentPanel = await openSubagentDetail(window);
    const reportText = await subagentPanel
      .getByTestId("subagent-report")
      .textContent();
    assert(
      reportText?.includes(REPORT_MARKER) === true,
      `嵌套卡片报告缺失标记：${reportText}`
    );
    console.log("[e2e] 嵌套卡片完成，最终报告可见");

    // 5) 解析真实 HTTP body：请求身份不依赖待验证的策略标题或工具存在性。
    const requests = seenBodies.map((body) => JSON.parse(body));
    const mainRequests = requests.filter(isMainRequest);
    const mainFirstRound = mainRequests.find(
      (request) => !request.messages.some((message) => message.role === "tool")
    );
    assert(mainFirstRound !== undefined, "未观察到主模型首轮请求");
    for (const request of mainRequests) {
      assert(
        roleText(request, "system").includes(DELEGATION_POLICY_HEADING),
        "主模型 system 未携带子代理委派策略"
      );
      const spawnTool = request.tools?.find(
        (tool) =>
          tool.type === "function" && tool.function?.name === "spawn_subagent"
      );
      assert(spawnTool !== undefined, "主模型工具表缺少 spawn_subagent");
      const description = spawnTool.function.description;
      assert(typeof description === "string", "spawn_subagent 缺少工具描述");
      // 锁定语义关键词而非整段提示全文；不从 system 或其他工具借词满足契约。
      const contracts = [
        ["主动委派复杂任务", [/主动.{0,15}委派/s, /复杂|多模块|跨模块/]],
        [
          "同一响应多个调用并行",
          [/同一(?:个|次|条)?(?:响应|回复).{0,40}(?:多个|多次).{0,40}并行/s],
        ],
        ["简单单点任务直接做", [/简单|单点/, /直接/]],
        [
          "避免重复调查",
          [
            /(?:不要|避免|不应|不再|不得|不).{0,30}重复.{0,30}(?:调查|调研|搜索)/s,
          ],
        ],
      ];
      for (const [contract, patterns] of contracts) {
        assert(
          patterns.every((pattern) => pattern.test(description)),
          `spawn_subagent 描述缺少契约「${contract}」：${description}`
        );
      }
    }
    console.log("[e2e] 主请求 system 委派策略 + spawn_subagent 描述契约");

    const subagentRequests = requests.filter(isSubagentRequest);
    assert(
      subagentRequests.length > 0,
      "未观察到子代理模型请求（独立上下文未发生）"
    );
    for (const request of subagentRequests) {
      assert(
        roleText(request, "user").includes(DELEGATE_TASK),
        "子代理请求未携带任务描述"
      );
      assert(
        request.messages.every(
          (message) => !messageText(message).includes(MAIN_TASK)
        ),
        "子代理请求不应包含主任务历史"
      );
      assert(
        !roleText(request, "system").includes(DELEGATION_POLICY_HEADING),
        "子代理 system 不应包含主模型委派策略"
      );
      // 子代理 system 本身会提及 spawn_subagent；只检查实际 tools[].function.name。
      const toolNames = (request.tools ?? [])
        .filter((tool) => tool.type === "function")
        .map((tool) => tool.function.name);
      assert(
        !toolNames.includes("spawn_subagent"),
        "子代理工具表不应含 spawn_subagent（防递归）"
      );
      assert(
        toolNames.includes("read_file"),
        "子代理工具表应含完整工具集（read_file 对照）"
      );
    }
    console.log(
      "[e2e] 子代理独立上下文 + 主策略隔离 + 防递归（真实请求体验证）"
    );

    // 6) 主模型第二轮：报告作为对应 spawn 调用的工具结果回流主任务上下文。
    const mainSecondRound = mainRequests.find(hasDelegateReport);
    assert(
      mainSecondRound !== undefined,
      "主模型第二轮未收到子代理报告（回流失败）"
    );
    await window.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="message-assistant"]').length >=
        1,
      null,
      { timeout: 20_000 }
    );
    console.log("[e2e] 报告回流主任务上下文（第二轮请求体验证）");

    // 7) 重启应用：标记行与右栏详情恢复（报告随 spawn_subagent 调用记录
    //    持久化；ADR 0020 恢复态完成记录在右栏直接可读）
    await closeApp(app);
    const { app: relaunchedApp, window: relaunchedWindow } = await launchApp({
      homeDir,
    });
    app = relaunchedApp;
    await relaunchedWindow
      .getByTestId("task-item")
      .first()
      .waitFor({ timeout: 15_000 });
    await relaunchedWindow.getByTestId("task-item").first().click();
    await relaunchedWindow
      .getByTestId("message-user")
      .first()
      .waitFor({ timeout: 10_000 });
    await relaunchedWindow
      .locator(
        '[data-testid="subagent-stream-marker-toggle"][data-subagent-state="done"]'
      )
      .waitFor({ timeout: 15_000 });
    const restoredPanel = await openSubagentDetail(relaunchedWindow);
    const restoredReport = await restoredPanel
      .getByTestId("subagent-report")
      .textContent();
    assert(
      restoredReport?.includes(REPORT_MARKER) === true,
      `重启后嵌套卡片报告缺失：${restoredReport}`
    );
    console.log("[e2e] 重启后嵌套卡片恢复（持久化验证）");

    await closeApp(app);
    console.log("[e2e] 工单 13 子代理冒烟通过 ✅");
  } catch (error) {
    console.error("[e2e] 子代理冒烟失败 ❌", error);
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
