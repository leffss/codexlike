// 票02：真实 Electron + preload/IPC/React/SQLite，仅外部模型由可控 SSE 闸门替代。
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  assert,
  closeApp,
  launchApp,
  projectAction,
  startMockProvider,
} from "./helpers.mjs";

async function until(fn, message) {
  const end = Date.now() + 15_000;
  while (!fn()) {
    assert(Date.now() < end, message);
    await delay(20);
  }
}
async function main() {
  const root = mkdtempSync(join(tmpdir(), "codexlike-live-"));
  const workspaceDir = join(root, "项目");
  mkdirSync(workspaceDir);
  const gates = new Map();
  const model = await startMockProvider((ctx, { body }) => {
    const messages = JSON.parse(body).messages;
    const text =
      messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
    const tools = messages.filter((m) => m.role === "tool");
    if (text === "失败C") {
      ctx.res.writeHead(401, { "content-type": "application/json" });
      ctx.res.end(
        JSON.stringify({
          error: { message: "测试失败", type: "invalid_api_key" },
        })
      );
    } else if (
      text.startsWith("项目A") &&
      tools.some((m) => m.tool_call_id === "question-a")
    ) {
      gates.set("A-final", ctx);
      ctx.send({ delta: { content: "A问答之后" }, finish_reason: null });
    } else if (
      text.startsWith("项目A") &&
      tools.some((m) => m.tool_call_id === "write-a")
    ) {
      gates.set("A-question", ctx);
    } else {
      gates.set(text, ctx);
      ctx.send({ delta: { content: `${text}前半段。` }, finish_reason: null });
    }
  });
  let app;
  try {
    const launched = await launchApp({
      homeDir: join(root, "nested", "home"),
      workspaceDir,
    });
    app = launched.app;
    const window = launched.window;
    await window.getByTestId("settings-open").click();
    const profiles = window.locator("section").filter({
      has: window.getByRole("heading", {
        name: "模型",
        exact: true,
      }),
    });
    await window.getByTestId("profile-create").click();
    const form = window.locator("form");
    await form.getByLabel("名称", { exact: true }).fill("Live Mock");
    await form
      .getByLabel("baseURL", { exact: true })
      .fill(`http://127.0.0.1:${model.port}/v1`);
    await form.getByLabel("API Key", { exact: true }).fill("test");
    await form.getByLabel("模型 1", { exact: true }).fill("mock");
    await form.getByRole("button", { name: "创建", exact: true }).click();
    await profiles.getByText("Live Mock", { exact: true }).waitFor();
    await window.getByTestId("settings-back").click();
    await window.getByTestId("add-project").click();
    await projectAction(window);
    await window.getByTestId("composer-input").fill("项目A");
    await window.getByTestId("composer-send").click();
    const a = window.getByTestId("task-item").filter({ hasText: "项目A" });
    await a.waitFor();
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "项目A前半段。" })
      .waitFor();
    await window.getByTestId("new-task").click();
    await window.getByTestId("composer-input").fill("独立B");
    await window.getByTestId("composer-send").click();
    const b = window.getByTestId("task-item").filter({ hasText: "独立B" });
    await b.waitFor();
    await until(() => gates.has("独立B"), "B模型收到请求");
    gates
      .get("项目A")
      .send({ delta: { content: "后台第二段。" }, finish_reason: null });
    await a.click();
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "项目A前半段。后台第二段。" })
      .waitFor({ timeout: 5_000 });
    assert(
      await window.getByTestId("composer-stop").isVisible(),
      "A仍在执行，不能等最终结果补全"
    );
    assert(
      (await window.getByTestId("message-assistant").count()) === 1,
      "现场与事件不重复气泡"
    );
    await b.click();
    gates.get("项目A").toolCallRound("write-a", "write_file", {
      path: "result.txt",
      content: "审批后的成果",
    });
    await a
      .getByTestId("task-activity")
      .filter({ hasText: "等待用户" })
      .waitFor();
    await a.click();
    await window.getByTestId("interaction-panel").waitFor();
    const requestId = await window
      .getByTestId("interaction-panel")
      .getAttribute("data-interaction-id");
    const aId = await a.getAttribute("data-task-id");
    const bId = await b.getAttribute("data-task-id");
    const wrong = await window.evaluate(
      async ({ id, requestId }) =>
        window.codexlike.tasks.respondInteraction(id, requestId, {
          kind: "approval",
          decision: "approve",
        }),
      { id: bId, requestId }
    );
    assert(wrong === false, "跨任务响应不会批准A");
    assert(
      (await window.getByTestId("tool-call-card").count()) === 1,
      "后台工具开始仍完整建卡"
    );
    await window.getByTestId("approval-approve").click();
    await until(() => gates.has("A-question"), "审批后继续模型");
    await b.click();
    gates.get("A-question").toolCallRound("question-a", "ask_user_question", {
      questions: [
        {
          id: "direction",
          header: "方向",
          question: "A要继续吗？",
          multiSelect: false,
          options: [
            { id: "yes", label: "继续A" },
            { id: "no", label: "暂停A" },
          ],
        },
      ],
    });
    await a
      .getByTestId("task-activity")
      .filter({ hasText: "等待用户" })
      .waitFor();
    await a.click();
    await window
      .getByTestId("question-title")
      .filter({ hasText: "A要继续吗？" })
      .waitFor();
    const tool = window
      .getByTestId("tool-call-card")
      .filter({ hasText: "write_file" });
    await tool.getByTestId("tool-call-toggle").click();
    assert(
      (await tool.getByTestId("tool-call-output").textContent()).length > 0,
      "工具结束输出恢复"
    );
    assert(
      readFileSync(join(workspaceDir, "result.txt"), "utf8") === "审批后的成果",
      "审批工具只在正确目录执行"
    );
    await window.getByTestId("question-option-yes").check();
    await b.click();
    await a.click();
    assert(
      await window.getByTestId("question-option-yes").isChecked(),
      "切换不取消问答"
    );
    await window.getByTestId("question-submit").click();
    await until(() => gates.has("A-final"), "问答恢复A模型");
    gates.get("独立B").finishWith("stop");
    await b
      .getByTestId("task-activity")
      .filter({ hasText: "完成未查看" })
      .waitFor();
    await b.click();
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "独立B前半段。" })
      .waitFor();
    await b.getByTestId("task-activity").waitFor({ state: "hidden" });
    await a.click();
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "A问答之后" })
      .waitFor();
    await window.getByTestId("composer-stop").click();
    // 停止时任务正被查看：中断只作短暂未读提醒，markViewed 落地后
    // 徽章熄灭（2026-11-19 未读口径——常驻断言翻转为终态隐藏）
    await a.getByTestId("task-activity").waitFor({ state: "hidden" });
    await until(() => gates.get("A-final").res.destroyed, "显式停止关闭模型流");
    const stopped = await window.evaluate(
      (id) => window.codexlike.tasks.view(id),
      aId
    );
    assert(stopped.activity.outcome === "interrupted", "停止终态由宿主保存");
    await window.getByTestId("new-task").click();
    await window.getByTestId("composer-input").fill("失败C");
    await window.getByTestId("composer-send").click();
    await window
      .getByTestId("task-item")
      .filter({ hasText: "失败C" })
      .getByTestId("task-activity")
      .filter({ hasText: "失败" })
      .waitFor();
    await a.click();
    // 消息段时序（消息流票 01；断言按 ADR 0015 过程段语义同步，0a89d66
    // 引入过程段折叠卡时漏改本场景，与 d749aa1 worktree 断言漏网同款）：
    // 工具调用之后产生的正文独立成段、显示在工具卡之后（不再合并回靠前
    // 段）；中断切回不丢内容——被工具卡隔断的早段正文以过程段折叠卡常驻
    // 留痕（收起态内容仍在 DOM，textContent 可回读），两段正文共同构成
    // 完整回复
    await window
      .getByTestId("process-text-block")
      .filter({ hasText: "项目A前半段。后台第二段。" })
      .waitFor();
    const finalSegment = window
      .getByTestId("message-assistant")
      .filter({ hasText: "A问答之后" });
    await finalSegment.waitFor();
    const earlyText = await window
      .getByTestId("process-text-block")
      .filter({ hasText: "项目A前半段。后台第二段。" })
      .textContent();
    assert(
      earlyText !== null && !earlyText.includes("A问答之后"),
      "工具卡之后的正文不应合并回靠前段"
    );
    const order = await window.evaluate(() => {
      const stream = document.querySelector('[data-testid="message-stream"]');
      return [...stream.querySelectorAll("ol > li")].map((li) =>
        li.hasAttribute("data-testid")
          ? li.dataset.testid
          : (li.querySelector("[data-testid]")?.dataset.testid ?? null)
      );
    });
    const lastAssistant = order.lastIndexOf("message-assistant");
    const lastTool = order.lastIndexOf("tool-call-card");
    assert(
      lastTool > 0 && lastAssistant > lastTool,
      `末段正文应显示在全部工具卡之后：${JSON.stringify(order)}`
    );
    assert(
      (await window.getByTestId("tool-call-card").count()) === 2,
      "审批与问答工具结果无丢失无重复"
    );
    console.log(
      "[e2e] live tasks：未完成A→B→A、后台工具/审批/问答、跨任务响应隔离、未查看/失败/中断通过"
    );
  } finally {
    if (app) await closeApp(app);
    model.server.close();
    model.server.closeAllConnections();
    rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
