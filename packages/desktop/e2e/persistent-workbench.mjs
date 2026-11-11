// 票03：真实 Electron 的草稿、设置、滚动与空闲进程重启恢复。
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, closeApp, launchApp, startMockProvider } from "./helpers.mjs";

async function main() {
  const root = mkdtempSync(join(tmpdir(), "codexlike-persistent-workbench-"));
  const homeDir = join(root, "fresh", "home");
  const workspaceDir = join(root, "project");
  mkdirSync(workspaceDir);
  const model = await startMockProvider((ctx, { body }) => {
    const lastUser = JSON.parse(body)
      .messages.filter((m) => m.role === "user")
      .at(-1)?.content;
    if (lastUser === "提问草稿验收")
      ctx.toolCallRound("persistent-question", "ask_user_question", {
        questions: [
          {
            id: "q",
            header: "方向",
            question: "下一步怎么做？",
            multiSelect: false,
            options: [{ id: "a", label: "继续" }],
          },
        ],
      });
    else
      ctx.textRound(
        Array.from(
          { length: 100 },
          (_, i) => `段落 ${i + 1}：长历史阅读位置验收。`
        ).join("\n\n")
      );
  });
  let app;
  try {
    let window;
    ({ app, window } = await launchApp({ homeDir, workspaceDir }));
    await window.getByTestId("settings-open").click();
    await window
      .locator("section")
      .filter({
        has: window.getByRole("heading", {
          name: "Provider Profiles",
          exact: true,
        }),
      })
      .getByRole("button", { name: "+ 新建 Profile", exact: true })
      .click();
    const form = window.locator("form");
    await form.getByLabel("名称").fill("Persistent Mock");
    await form.getByLabel("baseURL").fill(`http://127.0.0.1:${model.port}/v1`);
    await form.getByLabel("API Key").fill("test");
    await form.getByLabel("模型").fill("persistent-model");
    await form.getByRole("button", { name: /保存|创建/ }).click();
    await window.getByText("Persistent Mock", { exact: true }).waitFor();
    await window
      .locator("section")
      .filter({
        has: window.getByRole("heading", {
          name: "Provider Profiles",
          exact: true,
        }),
      })
      .getByRole("button", { name: "+ 新建 Profile", exact: true })
      .click();
    await form.getByLabel("名称").fill("Second Mock");
    await form.getByLabel("baseURL").fill(`http://127.0.0.1:${model.port}/v1`);
    await form.getByLabel("API Key").fill("test-second");
    await form.getByLabel("模型").fill("second-model");
    await form.getByRole("button", { name: /保存|创建/ }).click();
    await window.getByText("Second Mock", { exact: true }).waitFor();
    await window.getByTestId("settings-back").click();
    await window.getByTestId("add-project").click();
    await window.getByTestId("project-new-session").click();
    await window.getByTestId("composer-input").fill("项目新建草稿");
    await window.getByTestId("new-session").click();
    await window.getByTestId("composer-input").fill("独立新建草稿");
    await window.getByTestId("thinking-effort-select").selectOption("high");
    await window.getByTestId("project-new-session").click();
    await closeApp(app);
    app = null;
    ({ app, window } = await launchApp({ homeDir, workspaceDir }));
    await window.getByTestId("project-new-session").click();
    await window.waitForFunction(
      () =>
        document.querySelector('[data-testid="composer-input"]')?.value ===
        "项目新建草稿"
    );
    assert(
      (await window.getByTestId("session-item").count()) === 0,
      "草稿不是正式历史"
    );
    await window.getByTestId("new-session").click();
    await window.waitForFunction(
      () =>
        document.querySelector('[data-testid="composer-input"]')?.value ===
        "独立新建草稿"
    );
    assert(
      (await window.getByTestId("thinking-effort-select").inputValue()) ===
        "high",
      "独立草稿设置重开恢复"
    );
    await window.getByTestId("composer-send").click();
    await window.getByTestId("message-assistant").waitFor();
    await window.getByTestId("composer-send").waitFor();
    await window
      .getByTestId("profile-select")
      .selectOption({ label: "Second Mock · second-model" });
    await window.getByTestId("composer-input").fill("正式会话未发送输入");
    await window.getByTestId("thinking-effort-select").selectOption("off");
    await window
      .getByTestId("approval-mode-select")
      .selectOption("full-access");
    await window.getByTestId("full-access-confirm-ok").click();
    const stream = window.getByTestId("message-stream");
    await stream.hover();
    await window.mouse.wheel(0, 812);
    await window.waitForFunction(
      () =>
        document.querySelector('[data-testid="message-stream"]').scrollTop > 500
    );
    const readingTop = await stream.evaluate((el) => el.scrollTop);
    await window.getByTestId("project-new-session").click();
    await window.getByTestId("composer-send").click();
    await window.getByTestId("message-assistant").waitFor();
    await window.getByTestId("composer-send").waitFor();
    await window.getByTestId("composer-input").fill("项目会话独立输入");
    await window.getByTestId("thinking-effort-select").selectOption("low");
    await window
      .getByTestId("session-item")
      .filter({ hasText: "独立新建草稿" })
      .click();
    await window.getByTestId("message-assistant").waitFor();
    await window.waitForFunction(
      (top) =>
        Math.abs(
          document.querySelector('[data-testid="message-stream"]').scrollTop -
            top
        ) < 4,
      readingTop
    );
    assert(
      (await window.getByTestId("composer-input").inputValue()) ===
        "正式会话未发送输入",
      "正式草稿隔离"
    );
    assert(
      (await window.getByTestId("thinking-effort-select").inputValue()) ===
        "off",
      "会话思考隔离"
    );
    assert(
      (await window.getByTestId("approval-mode-select").inputValue()) ===
        "full-access",
      "显式权限记忆"
    );
    await closeApp(app);
    app = null;
    ({ app, window } = await launchApp({ homeDir, workspaceDir }));
    await window
      .getByTestId("session-item")
      .filter({ hasText: "独立新建草稿" })
      .click();
    await window.getByTestId("message-assistant").waitFor();
    await window.waitForFunction(
      (top) =>
        Math.abs(
          document.querySelector('[data-testid="message-stream"]').scrollTop -
            top
        ) < 4,
      readingTop
    );
    assert(
      (await window.getByTestId("composer-input").inputValue()) ===
        "正式会话未发送输入",
      "正式草稿真实重启恢复"
    );
    assert(
      (await window.getByTestId("thinking-effort-select").inputValue()) ===
        "off",
      "思考真实重启恢复"
    );
    assert(
      (
        await window
          .getByTestId("profile-select")
          .locator("option:checked")
          .textContent()
      ).includes("Second Mock"),
      "模型真实重启恢复"
    );
    await window
      .getByTestId("composer-input")
      .fill("$missing-skill 启动失败仍保留");
    await window.getByTestId("composer-send").click();
    await window.getByTestId("message-error").waitFor();
    assert(
      (await window.getByTestId("composer-input").inputValue()) ===
        "$missing-skill 启动失败仍保留",
      "发送失败不清空正式输入"
    );
    assert(
      (await window.getByTestId("approval-mode-select").inputValue()) ===
        "full-access",
      "权限真实重启恢复"
    );
    await window.getByTestId("new-session").click();
    assert(
      (await window.getByTestId("approval-mode-select").inputValue()) === "ask",
      "新会话不能继承完全访问"
    );
    assert(
      (
        await window
          .getByTestId("profile-select")
          .locator("option:checked")
          .textContent()
      ).includes("Persistent Mock"),
      "新会话采用应用默认而非上一个会话模型"
    );
    assert(model.requestCount() === 2, "切换与重启不自动发送");
    await window.getByTestId("composer-input").fill("提问草稿验收");
    await window.getByTestId("composer-send").click();
    await window.getByTestId("question-custom").fill("尚未提交的问答文本");
    await window
      .getByTestId("session-item")
      .filter({ hasText: "项目新建草稿" })
      .click();
    await window.getByTestId("message-assistant").waitFor();
    await window
      .getByTestId("session-item")
      .filter({ hasText: "提问草稿验收" })
      .click();
    await window.getByTestId("question-custom").waitFor();
    assert(
      (await window.getByTestId("question-custom").inputValue()) ===
        "尚未提交的问答文本",
      "问答切换隔离恢复"
    );
    await window.getByTestId("composer-stop").click();
    await window.getByTestId("composer-input").waitFor();
    await closeApp(app);
    app = null;
    ({ app, window } = await launchApp({ homeDir, workspaceDir }));
    await window
      .getByTestId("session-item")
      .filter({ hasText: "提问草稿验收" })
      .click();
    await window.getByTestId("saved-question-draft").waitFor();
    assert(
      (await window.getByTestId("saved-question-draft").textContent()).includes(
        "尚未提交的问答文本"
      ),
      "失效问答文本仍可查看"
    );
    assert(
      (await window.getByTestId("question-submit").count()) === 0,
      "失效请求不能重新提交或授权"
    );
    assert(model.requestCount() === 3, "问答重启不自动请求模型");
    console.log(
      "[e2e] 两类新建/正式草稿、独立偏好、滚动、三次真实进程重启恢复通过"
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
