// 票03：真实 Electron 的草稿、设置、滚动与空闲进程重启恢复。
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectComposerOption,
  assert,
  closeApp,
  launchApp,
  projectAction,
  startMockProvider,
} from "./helpers.mjs";

async function main() {
  const root = mkdtempSync(join(tmpdir(), "codexlike-persistent-workbench-"));
  const homeDir = join(root, "fresh", "home");
  const workspaceDir = join(root, "project");
  mkdirSync(workspaceDir);
  const model = await startMockProvider((ctx, { body }) => {
    const request = JSON.parse(body);
    if (!request.stream) {
      ctx.respondJson({
        id: "draft-compact",
        object: "chat.completion",
        created: 0,
        model: "persistent-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "已压缩旧问答任务" },
            finish_reason: "stop",
          },
        ],
      });
      return;
    }
    const lastUser = request.messages
      .filter((m) => m.role === "user")
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
    await window.getByTestId("profile-create").click();
    const form = window.locator("form");
    await form.getByLabel("名称").fill("Persistent Mock");
    await form.getByLabel("baseURL").fill(`http://127.0.0.1:${model.port}/v1`);
    await form.getByLabel("API Key").fill("test");
    await form.getByLabel("模型").fill("persistent-model");
    await form.getByRole("button", { name: /保存|创建/ }).click();
    await window.getByText("Persistent Mock", { exact: true }).waitFor();
    await window.getByTestId("profile-create").click();
    await form.getByLabel("名称").fill("Second Mock");
    await form.getByLabel("baseURL").fill(`http://127.0.0.1:${model.port}/v1`);
    await form.getByLabel("API Key").fill("test-second");
    await form.getByLabel("模型").fill("second-model");
    await form.getByRole("button", { name: /保存|创建/ }).click();
    await window.getByText("Second Mock", { exact: true }).waitFor();
    const profiles = await window.evaluate(() =>
      window.codexlike.providerProfiles.list()
    );
    const defaultProfileId = profiles.find(
      (p) => p.name === "Persistent Mock"
    )?.id;
    const secondProfileId = profiles.find((p) => p.name === "Second Mock")?.id;
    assert(defaultProfileId && secondProfileId, "两个模型均已创建并有稳定 ID");
    await window.getByTestId("settings-back").click();
    await window.getByTestId("add-project").click();
    await projectAction(window);
    await window.getByTestId("composer-input").fill("项目新建草稿");
    await window.getByTestId("new-session").click();
    await window.getByTestId("composer-input").fill("独立新建草稿");
    await selectComposerOption(window, "thinking-effort-select", "high");
    await projectAction(window);
    await closeApp(app);
    app = null;
    ({ app, window } = await launchApp({ homeDir, workspaceDir }));
    await projectAction(window);
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
      (await window
        .getByTestId("thinking-effort-select")
        .getAttribute("data-value")) === "high",
      "独立草稿设置重开恢复"
    );
    await window.getByTestId("composer-send").click();
    await window.getByTestId("message-assistant").waitFor();
    await window.getByTestId("composer-send").waitFor();
    await selectComposerOption(window, "profile-select", secondProfileId);
    assert(
      (await window
        .getByTestId("profile-select")
        .getAttribute("data-value")) === secondProfileId,
      "鼠标切换模型提交 Profile ID"
    );
    await window.getByTestId("composer-input").fill("正式会话未发送输入");
    await selectComposerOption(window, "thinking-effort-select", "off");
    await selectComposerOption(window, "approval-mode-select", "full-access");
    await window.getByTestId("full-access-confirm-ok").click();
    const stream = window.getByTestId("message-stream");
    await stream.hover();
    await window.mouse.wheel(0, 812);
    await window.waitForFunction(
      () =>
        document.querySelector('[data-testid="message-stream"]').scrollTop > 500
    );
    const readingTop = await stream.evaluate((el) => el.scrollTop);
    await projectAction(window);
    await window.getByTestId("composer-send").click();
    await window.getByTestId("message-assistant").waitFor();
    await window.getByTestId("composer-send").waitFor();
    await window.getByTestId("composer-input").fill("项目会话独立输入");
    await selectComposerOption(window, "thinking-effort-select", "low");
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
      (await window
        .getByTestId("thinking-effort-select")
        .getAttribute("data-value")) === "off",
      "会话思考隔离"
    );
    assert(
      (await window
        .getByTestId("approval-mode-select")
        .getAttribute("data-value")) === "full-access",
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
      (await window
        .getByTestId("thinking-effort-select")
        .getAttribute("data-value")) === "off",
      "思考真实重启恢复"
    );
    assert(
      (await window
        .getByTestId("profile-select")
        .getAttribute("data-value")) === secondProfileId &&
        (await window.getByTestId("profile-select").textContent()).includes(
          "Second Mock · second-model"
        ),
      "模型 ID 与显示名称真实重启恢复"
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
      (await window
        .getByTestId("approval-mode-select")
        .getAttribute("data-value")) === "full-access",
      "权限真实重启恢复"
    );
    await window.getByTestId("new-session").click();
    assert(
      (await window
        .getByTestId("approval-mode-select")
        .getAttribute("data-value")) === "ask",
      "新会话不能继承完全访问"
    );
    await window.waitForFunction(
      (id) =>
        document
          .querySelector('[data-testid="profile-select"]')
          ?.getAttribute("data-value") === id,
      defaultProfileId
    );
    assert(
      (await window.getByTestId("profile-select").textContent()).includes(
        "Persistent Mock · persistent-model"
      ),
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
    for (let round = 0; round < 4; round++) {
      await window.getByTestId("composer-input").fill(`问答后继续${round}`);
      await window.getByTestId("composer-send").click();
      await window.waitForFunction(async (text) => {
        const sessions = await window.codexlike.sessions.list();
        const session = sessions.find((s) => s.title === "提问草稿验收");
        const view = await window.codexlike.sessions.view(session.id);
        const history = await window.codexlike.sessions.messages(session.id);
        return (
          !view.activity.running &&
          history.some(
            (item) => item.kind === "message" && item.message.content === text
          )
        );
      }, `问答后继续${round}`);
    }
    await window.getByTestId("composer-input").fill("/compact");
    await window.getByTestId("composer-input").press("Enter");
    await window.getByTestId("message-compact-summary").waitFor();
    await window.getByTestId("saved-question-draft").waitFor();
    assert(
      (await window.getByTestId("saved-question-draft").textContent()).includes(
        "尚未提交的问答文本"
      ),
      "Compact后只读草稿不丢失"
    );
    await window.getByTestId("composer-input").fill("Compact后保存并退出");
    await window.waitForFunction(async () => {
      const session = (await window.codexlike.sessions.list()).find(
        (s) => s.title === "提问草稿验收"
      );
      return (
        (
          await window.codexlike.workbench.read({
            kind: "session",
            sessionId: session.id,
          })
        ).value.text === "Compact后保存并退出"
      );
    });
    // 不使用closeApp的强杀兜底作为验收：必须经保存屏障正常退出。
    const exited = new Promise((resolve) =>
      app.process().once("exit", resolve)
    );
    await app.evaluate(({ app }) => app.quit());
    let timeout;
    try {
      await Promise.race([
        exited,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Compact后flush阻塞退出")),
            10_000
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    app = null;
    ({ app, window } = await launchApp({ homeDir, workspaceDir }));
    await window
      .getByTestId("session-item")
      .filter({ hasText: "提问草稿验收" })
      .click();
    await window.getByTestId("saved-question-draft").waitFor();
    await window.waitForFunction(
      () =>
        document.querySelector('[data-testid="composer-input"]')?.value ===
        "Compact后保存并退出"
    );
    await window.getByTestId("composer-send").click();
    await window.waitForFunction(async () => {
      const session = (await window.codexlike.sessions.list()).find(
        (s) => s.title === "提问草稿验收"
      );
      return (
        !(await window.codexlike.sessions.execution(session.id)).running &&
        (await window.codexlike.sessions.messages(session.id)).some(
          (item) =>
            item.kind === "message" &&
            item.message.content === "Compact后保存并退出"
        )
      );
    });
    assert(model.requestCount() === 9, "Compact与显式继续之外没有重放请求");
    console.log(
      "[e2e] 草稿、偏好、阅读、真实重启及Compact→编辑→flush→正常退出→继续发送通过"
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
