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
import { setTimeout as delay } from "node:timers/promises";
import {
  selectComposerOption,
  assert,
  closeApp,
  launchApp,
  projectAction,
  taskMenu,
  startMockProvider,
  untilDraft,
  workspaceBadgeInfo,
} from "./helpers.mjs";

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
      (await window.getByTestId("task-item").count()) === 0,
      "添加空项目不创建任务"
    );
    await closeApp(app);
    app = null;
    ({ app, window } = await launchApp({ homeDir, workspaceDir }));
    await window.getByTestId("project-group").waitFor();
    assert(
      (await window.getByTestId("task-item").count()) === 0,
      "真进程重开仍为空项目"
    );
    await window.getByTestId("settings-open").click();
    await window.getByTestId("profile-create").click();
    const form = window.locator("form");
    await form.getByLabel("名称").fill("Workbench Mock");
    await form.getByLabel("baseURL").fill(`http://127.0.0.1:${model.port}/v1`);
    await form.getByLabel("API Key").fill("test");
    await form.getByLabel("模型 1").fill("mock-model");
    await form.getByRole("button", { name: /保存|创建/ }).click();
    await window.getByText("Workbench Mock", { exact: true }).waitFor();
    await window.getByTestId("settings-back").click();
    await projectAction(window);
    await window.getByTestId("composer-input").fill("项目草稿");
    assert((await window.getByTestId("task-item").count()) === 0, "新建仅草稿");
    await window.getByTestId("new-task").click();
    await window.getByTestId("composer-input").fill("独立草稿");
    assert(!existsSync(join(homeDir, "tasks")), "首次发送前不分配专用目录");
    await projectAction(window);
    await untilDraft(window, "项目草稿", "项目草稿切换不丢");
    await window.getByTestId("composer-send").click();
    await window.getByTestId("message-assistant").waitFor();
    await window.getByTestId("composer-send").waitFor();
    // 项目目录明确展示：路径收进标题栏徽章（票01），弹层读完整路径
    const projectBadge = await workspaceBadgeInfo(window);
    assert(projectBadge.path.includes(workspaceDir), "项目目录明确展示");
    const projectTask = await window
      .getByTestId("task-item")
      .getAttribute("data-task-id");
    await selectComposerOption(window, "approval-mode-select", "full-access");
    await window.getByTestId("full-access-confirm-ok").click();
    await window.getByTestId("new-task").click();
    assert(
      (await window
        .getByTestId("approval-mode-select")
        .getAttribute("data-value")) === "ask",
      "新草稿不继承完全访问"
    );
    assert(
      (await window.getByTestId("composer-input").inputValue()) === "独立草稿",
      "独立草稿切换不丢"
    );
    writeFileSync(join(homeDir, "tasks"), "保留原文件");
    await window.getByTestId("composer-send").click();
    await window.getByTestId("draft-error").waitFor();
    assert(
      (await window.getByTestId("composer-input").inputValue()) === "独立草稿",
      "失败保留输入"
    );
    assert(
      (await window.getByTestId("task-item").count()) === 1,
      "失败没有空任务"
    );
    assert(
      readFileSync(join(homeDir, "tasks"), "utf8") === "保留原文件",
      "失败不删已有文件"
    );
    rmSync(join(homeDir, "tasks"));
    // Windows 删除竞态：外部句柄（杀毒实时扫描等）尚未释放时文件处于
    // delete-pending，立即以同名创建目录会 EPERM，被 tasks:start 兜底
    // 成"无法创建独立任务专用目录"。以同名目录可重建为确定信号后再重发。
    for (let attempt = 0; ; attempt++) {
      try {
        mkdirSync(join(homeDir, "tasks"));
        break;
      } catch (error) {
        if (attempt >= 40) throw error;
        await delay(50);
      }
    }
    await window.getByTestId("composer-send").dblclick();
    await window.getByTestId("message-assistant").waitFor();
    await window.getByTestId("composer-send").waitFor();
    assert(
      (await window.getByTestId("task-item").count()) === 2,
      "双击只创建一次"
    );
    assert(
      (await window
        .getByTestId("standalone-header")
        .locator("..")
        .getByTestId("task-item")
        .count()) === 1,
      "独立分区不伪造项目"
    );
    const standaloneBadge = await workspaceBadgeInfo(window);
    const standalonePath = standaloneBadge.path;
    assert(existsSync(standalonePath), "专用持久目录真实存在");
    await (
      await taskMenu(
        window,
        window.getByTestId("task-item").filter({ hasText: "独立草稿" })
      )
    )
      .getByTestId("rename-button")
      .click();
    await window.getByTestId("rename-input").fill("独立新标题");
    await window.getByTestId("rename-input").press("Enter");
    await window
      .getByTestId("task-item")
      .filter({ hasText: "独立新标题" })
      .waitFor();
    await window.getByTestId("new-task").click();
    await window.getByTestId("draft-select-workspace").click();
    await window.getByTestId("composer-input").fill("同目录但独立");
    await window.getByTestId("composer-send").click();
    await window.getByTestId("message-assistant").waitFor();
    await window.getByTestId("composer-send").waitFor();
    assert(
      (await window
        .getByTestId("standalone-header")
        .locator("..")
        .getByTestId("task-item")
        .count()) === 2,
      "同项目目录仍是独立任务"
    );
    assert(
      (await window.getByTestId("project-group").count()) === 1,
      "选目录不创建项目"
    );
    await window
      .getByTestId("task-item")
      .filter({ hasText: "项目草稿" })
      .click();
    assert(
      (await window
        .getByTestId("task-item")
        .filter({ hasText: "项目草稿" })
        .getAttribute("data-task-id")) === projectTask,
      "任务标识稳定"
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
      .getByTestId("task-item")
      .filter({ hasText: "独立新标题" })
      .click();
    await window
      .getByTestId("message-user")
      .filter({ hasText: "独立草稿" })
      .waitFor();
    const reopenedBadge = await workspaceBadgeInfo(window);
    assert(reopenedBadge.path === standalonePath, "重启后工作区固定且标题持久");
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
// 复用原生目录选择的 E2E 接缝；项目创建、置顶与取消全部经过真实 UI。
async function projectPinningScenario() {
  const root = mkdtempSync(join(tmpdir(), "codexlike-project-pinning-"));
  const homeDir = join(root, "home");
  const workspaces = [join(root, "Alpha"), join(root, "Beta")];
  for (const workspace of workspaces) mkdirSync(workspace);
  let app;
  try {
    let window;
    ({ app, window } = await launchApp({
      homeDir,
      workspaceDir: workspaces[0],
    }));
    for (const workspace of workspaces) {
      await app.evaluate((_electron, directory) => {
        process.env.CODEXLIKE_TEST_WORKSPACE = directory;
      }, workspace);
      await window.getByTestId("add-project").click();
      await window
        .getByTestId("project-group")
        .and(window.locator(`[title=${JSON.stringify(workspace)}]`))
        .waitFor();
    }
    const header = (id) =>
      window
        .getByTestId("project-header")
        .and(window.locator(`[data-project-id="${id}"]`));
    const normalOrder = await window
      .getByTestId("project-header")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.projectId));
    assert(normalOrder.length === 2, "真实 UI 创建两个空项目");
    const pinnedId = normalOrder[1];
    async function waitOrder(ids) {
      await window.waitForFunction((expected) => {
        const headers = [
          ...document.querySelectorAll(
            '[data-testid="project-header"], [data-testid="standalone-header"]'
          ),
        ];
        return (
          JSON.stringify(
            headers.map((node) => node.dataset.projectId ?? "standalone")
          ) === JSON.stringify([...expected, "standalone"])
        );
      }, ids);
    }
    async function assertPinned(expected) {
      await header(pinnedId)
        .getByTestId("project-pin")
        .and(window.locator(`[aria-pressed="${expected}"]`))
        .waitFor();
      assert(
        (await header(pinnedId).getByTestId("project-pinned").count()) ===
          Number(expected),
        "项目置顶标识与按钮状态一致"
      );
      assert(
        (await header(pinnedId)
          .getByTestId("project-group")
          .getAttribute("aria-expanded")) === "true",
        "置顶按钮不触发项目折叠"
      );
      assert(
        (await window.getByTestId("task-item").count()) === 0,
        "置顶操作不能创建任务"
      );
    }
    await waitOrder(normalOrder);
    await projectAction(window, "project-pin", header(pinnedId));
    await assertPinned(true);
    await waitOrder([pinnedId, normalOrder[0]]);
    await closeApp(app);
    app = null;
    ({ app, window } = await launchApp({ homeDir }));
    await assertPinned(true);
    await waitOrder([pinnedId, normalOrder[0]]);
    await projectAction(window, "project-pin", header(pinnedId));
    await assertPinned(false);
    await waitOrder(normalOrder);
    await closeApp(app);
    app = null;
    ({ app, window } = await launchApp({ homeDir }));
    await assertPinned(false);
    await waitOrder(normalOrder);
    console.log(
      "[e2e] 项目置顶→普通项目→独立分区、取消恢复原序、两次真重启持久通过"
    );
  } finally {
    if (app) await closeApp(app);
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}

main()
  .then(projectPinningScenario)
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
