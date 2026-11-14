// 票07：真实Electron点击归属与移除确认，仅使用临时目录及外部模型替身。
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assert,
  assertSemanticOverlay,
  closeApp,
  launchApp,
  projectAction,
  taskMenu,
  startMockProvider,
} from "./helpers.mjs";

async function main() {
  const root = mkdtempSync(join(tmpdir(), "codexlike-membership-"));
  const homeDir = join(root, "home");
  const workspaceDir = join(root, "项目");
  mkdirSync(workspaceDir);
  const marker = join(workspaceDir, "keep.txt");
  writeFileSync(marker, "项目移除不删除文件");
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
    else ctx.textRound("归属验收完成");
  });
  let app;
  try {
    let window;
    ({ app, window } = await launchApp({ homeDir, workspaceDir }));
    await window.getByTestId("add-project").click();
    await window.getByTestId("project-group").waitFor();
    await window.getByTestId("settings-open").click();
    await window.getByTestId("profile-create").click();
    const form = window.locator("form");
    await form.getByLabel("名称").fill("Membership Mock");
    await form.getByLabel("baseURL").fill(`http://127.0.0.1:${model.port}/v1`);
    await form.getByLabel("API Key").fill("test");
    await form.getByLabel("模型").fill("mock-model");
    await form.getByRole("button", { name: /保存|创建/ }).click();
    await window.getByText("Membership Mock", { exact: true }).waitFor();
    await window.getByTestId("settings-back").click();
    const item = (title) =>
      window.getByTestId("task-item").filter({ hasText: title });
    const standalone = () =>
      window.getByTestId("standalone-header").locator("..");
    const project = () => window.getByTestId("project-header").locator("..");
    async function create(title, inProject = false) {
      if (inProject) await projectAction(window);
      else {
        await window.getByTestId("new-task").click();
        await window.getByTestId("new-standalone-task-item").click();
      }
      if (!inProject)
        await window.getByTestId("draft-select-workspace").click();
      await window.getByTestId("composer-input").fill(title);
      await window.getByTestId("composer-send").click();
      await window.getByTestId("message-assistant").waitFor();
      await window.getByTestId("composer-send").waitFor();
    }
    await create("待移动");
    await window.getByTestId("composer-input").fill("保留当前草稿");
    await (
      await taskMenu(
        window,
        window
          .getByTestId("task-item")
          .and(window.locator('[aria-current="page"]'))
      )
    )
      .getByTestId("task-membership")
      .click();
    await assertSemanticOverlay(window.getByTestId("membership-dialog"));
    await window
      .getByTestId("membership-target")
      .selectOption({ label: "项目" });
    await window.getByTestId("membership-confirm").click();
    await project()
      .getByTestId("task-item")
      .filter({ hasText: "待移动" })
      .waitFor();
    assert(
      (await window.getByTestId("composer-input").inputValue()) ===
        "保留当前草稿",
      "移入不丢草稿"
    );
    await (
      await taskMenu(
        window,
        window
          .getByTestId("task-item")
          .and(window.locator('[aria-current="page"]'))
      )
    )
      .getByTestId("task-membership")
      .click();
    await window.getByTestId("membership-confirm").click();
    await standalone()
      .getByTestId("task-item")
      .filter({ hasText: "待移动" })
      .waitFor();
    await create("归档所属", true);
    await (
      await taskMenu(
        window,
        window
          .getByTestId("task-item")
          .and(window.locator('[aria-current="page"]'))
      )
    )
      .getByTestId("archive-button")
      .click();
    await item("归档所属").waitFor({ state: "detached" });
    await create("当前所属", true);
    await projectAction(window, "project-remove");
    await window.getByTestId("project-removal-dialog").waitFor();
    await assertSemanticOverlay(window.getByTestId("project-removal-dialog"));
    assert(
      (
        await window.getByTestId("project-removal-dialog").textContent()
      ).includes("磁盘文件"),
      "明确告知保留文件"
    );
    assert(
      (
        await window.getByTestId("project-removal-dialog").textContent()
      ).includes("归档"),
      "明确包含归档记录"
    );
    await window.getByTestId("project-removal-cancel").click();
    await item("当前所属").waitFor();
    await window.getByTestId("composer-input").fill("请求等待");
    await window.getByTestId("composer-send").click();
    await window.getByTestId("interaction-panel").waitFor();
    await (
      await taskMenu(
        window,
        window
          .getByTestId("task-item")
          .and(window.locator('[aria-current="page"]'))
      )
    )
      .getByTestId("task-membership")
      .click();
    await window.getByTestId("membership-confirm").click();
    await window
      .getByTestId("membership-error")
      .filter({ hasText: "先停止" })
      .waitFor();
    await window.getByTestId("membership-cancel").click();
    await projectAction(window, "project-remove");
    await window.getByTestId("project-removal-confirm").click();
    await window
      .getByTestId("project-removal-error")
      .filter({ hasText: "先停止" })
      .waitFor();
    await window.getByTestId("project-removal-cancel").click();
    await window.getByTestId("question-option-yes").click();
    await window.getByTestId("question-submit").click();
    await window
      .getByTestId("interaction-panel")
      .waitFor({ state: "detached" });
    await window.getByTestId("composer-send").waitFor();
    // 票05：搜索面板随票01 迁入标题栏左区（384px 浮层），打开时覆盖左栏顶部
    // project-header 右端的悬浮操作区（project-remove 不可命中）——移除项目前
    // 先收起面板；移除后重开搜索（query 跨开合保留并自动重查）验证结果随项目
    // 移除消失。结果列表由实时状态派生，产品语义与原「面板开着时结果即时消失」一致。
    await window.getByTestId("task-search-toggle").click();
    await window.getByTestId("task-search-input").fill("当前所属");
    await window.getByTestId("task-search-result").waitFor();
    await window.getByTestId("task-search-toggle").click();
    await projectAction(window, "project-remove");
    await window.getByTestId("project-removal-confirm").click();
    await window.getByTestId("project-group").waitFor({ state: "detached" });
    await window.getByTestId("task-search-toggle").click();
    await window
      .getByTestId("task-search-status")
      .filter({ hasText: "没有匹配的任务" })
      .waitFor();
    await window.getByTestId("task-search-toggle").click();
    await window
      .getByTestId("message-user")
      .filter({ hasText: "待移动" })
      .waitFor();
    assert(
      (await window.getByTestId("task-item").count()) === 1,
      "所属含归档移除，同目录独立保留"
    );
    assert(
      (await window.getByTestId("composer-input").inputValue()) ===
        "保留当前草稿",
      "幸存任务草稿不被清理"
    );
    assert(
      readFileSync(marker, "utf8") === "项目移除不删除文件",
      "项目文件仍存在"
    );
    await closeApp(app);
    app = null;
    ({ app, window } = await launchApp({ homeDir, workspaceDir }));
    await item("待移动").waitFor();
    assert(
      (await window.getByTestId("project-group").count()) === 0,
      "重开没有项目悬挂记录"
    );
    assert(model.requestCount() === 5, "整理不重放模型请求");
    await window.getByTestId("composer-input").fill("幸存任务继续");
    await window.getByTestId("composer-send").click();
    await window
      .getByTestId("message-user")
      .filter({ hasText: "幸存任务继续" })
      .waitFor();
    await window.getByTestId("composer-send").waitFor();
    await window.getByTestId("add-project").click();
    await projectAction(window);
    await window.getByTestId("composer-input").fill("只属于移除项目的草稿");
    await projectAction(window, "project-remove");
    await window.getByTestId("project-removal-confirm").click();
    await window.getByTestId("project-group").waitFor({ state: "detached" });
    await window
      .getByTestId("message-user")
      .filter({ hasText: "待移动" })
      .waitFor();
    await window.getByTestId("add-project").click();
    await projectAction(window);
    assert(
      (await window.getByTestId("composer-input").inputValue()) === "",
      "重新添加项目不恢复已移除草稿"
    );
    await projectAction(window, "project-remove");
    await window.getByTestId("project-removal-confirm").click();
    await window.getByTestId("project-group").waitFor({ state: "detached" });
    console.log(
      "[e2e] 移入移出、草稿保持/清理、移除取消及确认、等待保护、重开与文件保留通过"
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
