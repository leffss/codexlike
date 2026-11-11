// 票05：真实 Electron 用户整理、查看归档、恢复与进程重开。
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, closeApp, launchApp, startMockProvider } from "./helpers.mjs";

async function main() {
  const root = mkdtempSync(join(tmpdir(), "codexlike-sidebar-"));
  const homeDir = join(root, "home");
  const workspaceDir = join(root, "项目");
  mkdirSync(workspaceDir);
  const marker = join(workspaceDir, "keep.txt");
  writeFileSync(marker, "归档不能删除成果");
  const model = await startMockProvider((ctx, { index }) => {
    if (index === 4)
      ctx.toolCallRound("question", "ask_user_question", {
        questions: [
          {
            id: "q",
            header: "任务",
            question: "选择后继续？",
            multiSelect: false,
            options: [{ id: "yes", label: "继续" }],
          },
        ],
      });
    else ctx.textRound("整理验收完成");
  });
  let app;
  try {
    let window;
    ({ app, window } = await launchApp({ homeDir, workspaceDir }));
    await window.getByTestId("add-project").click();
    await window.getByTestId("project-group").waitFor();
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
    await form.getByLabel("名称").fill("Sidebar Mock");
    await form.getByLabel("baseURL").fill(`http://127.0.0.1:${model.port}/v1`);
    await form.getByLabel("API Key").fill("test");
    await form.getByLabel("模型").fill("mock-model");
    await form.getByRole("button", { name: /保存|创建/ }).click();
    await window.getByText("Sidebar Mock", { exact: true }).waitFor();
    await window.getByTestId("settings-back").click();
    async function create(title, project = false) {
      await window
        .getByTestId(project ? "project-new-session" : "new-session")
        .click();
      if (!project) await window.getByTestId("draft-select-workspace").click();
      await window.getByTestId("composer-input").fill(title);
      await window.getByTestId("composer-send").click();
      await window.getByTestId("message-assistant").waitFor();
      await window.getByTestId("composer-send").waitFor();
    }
    const item = (title) =>
      window.getByTestId("session-item").filter({ hasText: title });
    const group = () => window.getByTestId("standalone-group").locator("..");
    await create("项目任务", true);
    await create("独立A");
    await create("独立B");
    assert(
      (await window.getByTestId("pin-button").count()) === 3,
      "两类会话都有置顶入口"
    );
    await item("独立A").hover();
    await item("独立A").locator("..").getByTestId("pin-button").click();
    assert(
      (
        await group().getByTestId("session-item").first().textContent()
      ).includes("独立A"),
      "置顶优先"
    );
    await item("独立B").click();
    assert(
      (
        await group().getByTestId("session-item").first().textContent()
      ).includes("独立A"),
      "查看其他会话不越过置顶"
    );
    await item("独立A").locator("..").getByTestId("pin-button").click();
    await window
      .getByTestId("pin-button")
      .filter({ hasText: "取消置顶" })
      .waitFor({ state: "detached" });
    assert(
      (
        await group().getByTestId("session-item").first().textContent()
      ).includes("独立B"),
      "取消置顶后最近查看的B在前"
    );
    await item("独立A").click();
    await window
      .getByTestId("message-user")
      .filter({ hasText: "独立A" })
      .waitFor();
    assert(
      (
        await group().getByTestId("session-item").first().textContent()
      ).includes("独立A"),
      "用户查看更新最近使用顺序"
    );
    await item("独立A").locator("..").getByTestId("pin-button").click();
    await item("独立B").click();
    await window.getByTestId("project-group").click();
    assert((await item("项目任务").count()) === 0, "折叠隐藏项目会话");
    // 侧栏与斜杠命令统一跳离被归档的当前会话。
    await item("独立B").hover();
    await item("独立B").locator("..").getByTestId("archive-button").click();
    await item("独立B").waitFor({ state: "detached" });
    await window
      .getByTestId("message-user")
      .filter({ hasText: "独立A" })
      .waitFor();
    await group().getByTestId("toggle-archived").click();
    await window
      .getByTestId("archived-session-item")
      .filter({ hasText: "独立B" })
      .click();
    await window
      .getByTestId("message-user")
      .filter({ hasText: "独立B" })
      .waitFor();
    assert(
      await window.getByTestId("composer-send").isDisabled(),
      "归档不能发送，先恢复再发送"
    );
    await window.getByTestId("session-restore").click();
    await item("独立B").waitFor();
    assert(
      (await group().getByTestId("session-item").count()) === 2,
      "同目录独立会话恢复不归入项目"
    );
    await window.getByTestId("composer-input").fill("/archive");
    await window.getByTestId("composer-send").click();
    await item("独立B").waitFor({ state: "detached" });
    await window
      .getByTestId("message-user")
      .filter({ hasText: "独立A" })
      .waitFor();
    assert(
      readFileSync(marker, "utf8") === "归档不能删除成果",
      "目录成果不删除"
    );
    await closeApp(app);
    app = null;
    ({ app, window } = await launchApp({ homeDir, workspaceDir }));
    await item("独立A").waitFor();
    assert(
      (await window
        .getByTestId("project-group")
        .getAttribute("aria-expanded")) === "false",
      "真正重开保留折叠"
    );
    assert(
      (await item("独立A")
        .locator("..")
        .getByTestId("pin-button")
        .getAttribute("aria-pressed")) === "true",
      "真正重开保留置顶"
    );
    await group().getByTestId("toggle-archived").click();
    const archived = window
      .getByTestId("archived-session-item")
      .filter({ hasText: "独立B" });
    await archived.waitFor();
    await archived.locator("..").getByTestId("unarchive-button").click();
    await item("独立B").waitFor();
    await window.getByTestId("project-group").click();
    await item("项目任务").click();
    await window
      .getByTestId("message-user")
      .filter({ hasText: "项目任务" })
      .waitFor();
    await window.getByTestId("session-archive").click();
    await item("项目任务").waitFor({ state: "detached" });
    await window
      .getByTestId("message-user")
      .filter({ hasText: "独立A" })
      .waitFor();
    const project = window.getByTestId("project-group").locator("..");
    await project.getByTestId("toggle-archived").click();
    await project.getByTestId("unarchive-button").click();
    await project
      .getByTestId("session-item")
      .filter({ hasText: "项目任务" })
      .waitFor();
    assert(
      model.requestCount() === 3,
      "整理、查看、恢复与重启均不重放模型请求"
    );
    await item("项目任务").click();
    await window.getByTestId("composer-input").fill("请求问答");
    await window.getByTestId("composer-send").click();
    await window.getByTestId("interaction-panel").waitFor();
    const waitingId = await window
      .getByTestId("interaction-panel")
      .getAttribute("data-interaction-id");
    await item("项目任务").locator("..").getByTestId("pin-button").click();
    await window.getByTestId("project-group").click();
    assert(
      (await window
        .getByTestId("interaction-panel")
        .getAttribute("data-interaction-id")) === waitingId,
      "折叠置顶不取消等待请求"
    );
    await window.getByTestId("session-archive").click();
    await window.getByText(/归档失败.*先停止/).waitFor();
    assert(
      (await window
        .getByTestId("interaction-panel")
        .getAttribute("data-interaction-id")) === waitingId,
      "归档拒绝不消费问答"
    );
    await window.getByTestId("question-option-yes").click();
    await window.getByTestId("question-submit").click();
    await window
      .getByTestId("interaction-panel")
      .waitFor({ state: "detached" });
    await window.getByTestId("composer-send").waitFor();
    assert(model.requestCount() === 5, "拒绝归档后原执行仍可正常回答完成");
    console.log(
      "[e2e] 置顶、项目折叠重开、归档查看恢复、三入口导航、成果保留与等待保护通过"
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
