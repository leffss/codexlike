// ADR 0010：真实 Electron / preload / IPC / React / SQLite 的首次发送纵向验收。
import {
  existsSync,
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
  const root = mkdtempSync(join(tmpdir(), "codexlike-workbench-"));
  const homeDir = join(root, "fresh", "home");
  const workspaceDir = join(root, "普通项目");
  mkdirSync(workspaceDir);
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(join(homeDir, "codexlike.db"), "旧管理数据原样保留");
  for (let index = 0; index < 17; index += 1) {
    const old = join(homeDir, "worktrees", `old-${index}`);
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "keep.txt"), "旧成果");
  }
  const model = await startMockProvider((ctx) =>
    ctx.textRound("工作台任务已完成")
  );
  let app;
  try {
    ({ app } = await launchApp({ homeDir, workspaceDir }));
    let window = await app.firstWindow();
    await window.getByTestId("add-project").click();
    await window.getByTestId("project-group").waitFor();
    assert(
      (await window.getByTestId("session-item").count()) === 0,
      "添加空项目不创建会话"
    );
    await closeApp(app);
    app = null;
    ({ app, window } = await launchApp({ homeDir, workspaceDir }));
    await window.getByTestId("project-group").waitFor();
    assert(
      (await window.getByTestId("session-item").count()) === 0,
      "真进程重开仍为空项目"
    );
    await window.getByTestId("settings-open").click();
    await window.getByTestId("profile-create").click();
    const form = window.locator("form");
    await form.getByLabel("名称").fill("Workbench Mock");
    await form.getByLabel("baseURL").fill(`http://127.0.0.1:${model.port}/v1`);
    await form.getByLabel("API Key").fill("test");
    await form.getByLabel("模型").fill("mock-model");
    await form.getByRole("button", { name: /保存|创建/ }).click();
    await window.getByText("Workbench Mock", { exact: true }).waitFor();
    await window.getByTestId("settings-back").click();
    await window.getByTestId("project-new-session").click();
    await window.getByTestId("composer-input").fill("项目草稿");
    assert(
      (await window.getByTestId("session-item").count()) === 0,
      "新建仅草稿"
    );
    await window.getByTestId("new-session").click();
    await window.getByTestId("composer-input").fill("独立草稿");
    assert(!existsSync(join(homeDir, "sessions")), "首次发送前不分配专用目录");
    await window.getByTestId("project-new-session").click();
    assert(
      (await window.getByTestId("composer-input").inputValue()) === "项目草稿",
      "项目草稿切换不丢"
    );
    await window.getByTestId("composer-send").click();
    await window.getByTestId("message-assistant").waitFor();
    await window.getByTestId("composer-send").waitFor();
    assert(
      (await window.getByTestId("workspace-path").textContent()).includes(
        workspaceDir
      ),
      "项目目录明确展示"
    );
    const projectSession = await window
      .getByTestId("session-item")
      .getAttribute("data-session-id");
    await window
      .getByTestId("approval-mode-select")
      .selectOption("full-access");
    await window.getByTestId("full-access-confirm-ok").click();
    await window.getByTestId("new-session").click();
    assert(
      (await window.getByTestId("approval-mode-select").inputValue()) === "ask",
      "新草稿不继承完全访问"
    );
    assert(
      (await window.getByTestId("composer-input").inputValue()) === "独立草稿",
      "独立草稿切换不丢"
    );
    writeFileSync(join(homeDir, "sessions"), "保留原文件");
    await window.getByTestId("composer-send").click();
    await window.getByTestId("draft-error").waitFor();
    assert(
      (await window.getByTestId("composer-input").inputValue()) === "独立草稿",
      "失败保留输入"
    );
    assert(
      (await window.getByTestId("session-item").count()) === 1,
      "失败没有空会话"
    );
    assert(
      readFileSync(join(homeDir, "sessions"), "utf8") === "保留原文件",
      "失败不删已有文件"
    );
    rmSync(join(homeDir, "sessions"));
    await window.getByTestId("composer-send").dblclick();
    await window.getByTestId("message-assistant").waitFor();
    await window.getByTestId("composer-send").waitFor();
    assert(
      (await window.getByTestId("session-item").count()) === 2,
      "双击只创建一次"
    );
    assert(
      (await window
        .getByTestId("standalone-group")
        .locator("..")
        .getByTestId("session-item")
        .count()) === 1,
      "独立分区不伪造项目"
    );
    const standalonePath = await window
      .getByTestId("workspace-path")
      .getAttribute("title");
    assert(existsSync(standalonePath), "专用持久目录真实存在");
    await window
      .getByTestId("session-item")
      .filter({ hasText: "独立草稿" })
      .hover();
    await window
      .getByTestId("standalone-group")
      .locator("..")
      .getByTestId("rename-button")
      .click();
    await window.getByTestId("rename-input").fill("独立新标题");
    await window.getByTestId("rename-input").press("Enter");
    await window
      .getByTestId("session-item")
      .filter({ hasText: "独立新标题" })
      .waitFor();
    await window.getByTestId("new-session").click();
    await window.getByTestId("draft-select-workspace").click();
    await window.getByTestId("composer-input").fill("同目录但独立");
    await window.getByTestId("composer-send").click();
    await window.getByTestId("message-assistant").waitFor();
    await window.getByTestId("composer-send").waitFor();
    assert(
      (await window
        .getByTestId("standalone-group")
        .locator("..")
        .getByTestId("session-item")
        .count()) === 2,
      "同项目目录仍是独立会话"
    );
    assert(
      (await window.getByTestId("project-group").count()) === 1,
      "选目录不创建项目"
    );
    await window
      .getByTestId("session-item")
      .filter({ hasText: "项目草稿" })
      .click();
    assert(
      (await window
        .getByTestId("session-item")
        .filter({ hasText: "项目草稿" })
        .getAttribute("data-session-id")) === projectSession,
      "会话标识稳定"
    );
    await window
      .getByTestId("message-user")
      .filter({ hasText: "项目草稿" })
      .waitFor();
    assert(model.requestCount() === 3, "首条消息仅执行三次");
    await closeApp(app);
    app = null;
    ({ app, window } = await launchApp({ homeDir, workspaceDir }));
    await window
      .getByTestId("session-item")
      .filter({ hasText: "独立新标题" })
      .click();
    await window
      .getByTestId("message-user")
      .filter({ hasText: "独立草稿" })
      .waitFor();
    assert(
      (await window.getByTestId("workspace-path").getAttribute("title")) ===
        standalonePath,
      "重启后工作区固定且标题持久"
    );
    assert(model.requestCount() === 3, "重启不自动发送");
    assert(
      readFileSync(join(homeDir, "codexlike.db"), "utf8") ===
        "旧管理数据原样保留",
      "新库隔离不改旧库"
    );
    for (let index = 0; index < 17; index += 1)
      assert(
        readFileSync(
          join(homeDir, "worktrees", `old-${index}`, "keep.txt"),
          "utf8"
        ) === "旧成果",
        "不按数量清理旧 Worktree"
      );
    console.log(
      "[e2e] 空项目重开、项目/独立草稿、延迟创建、失败重试、双击、显式归属、标题与目录恢复通过"
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
