// 组内活跃任务预览限额：每组默认直显 5 条，超出折叠为「更多（N）」，
// 点击展开全量、「收起」回到前 5；展开态是会话内 state，重启回默认。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, closeApp, launchApp, startMockProvider } from "./helpers.mjs";

async function main() {
  const root = mkdtempSync(join(tmpdir(), "codexlike-sidebar-preview-"));
  const homeDir = join(root, "home");
  const workspaceDir = join(root, "workspace");
  mkdirSync(workspaceDir);
  const model = await startMockProvider((ctx) => ctx.textRound("完成"));
  let app;
  try {
    let window;
    ({ app, window } = await launchApp({ homeDir, workspaceDir }));
    await window.getByTestId("settings-open").click();
    await window.getByTestId("profile-create").click();
    const form = window.locator("form");
    await form.getByLabel("名称").fill("Preview Mock");
    await form.getByLabel("baseURL").fill(`http://127.0.0.1:${model.port}/v1`);
    await form.getByLabel("API Key").fill("test");
    await form.getByLabel("模型 1").fill("mock-model");
    await form.getByRole("button", { name: /保存|创建/ }).click();
    await window.getByText("Preview Mock", { exact: true }).waitFor();
    await window.getByTestId("settings-back").click();
    async function create(title) {
      await window.getByTestId("new-task").click();
      await window.getByTestId("draft-select-workspace").click();
      await window.getByTestId("composer-input").fill(title);
      await window.getByTestId("composer-send").click();
      await window.getByTestId("message-assistant").waitFor();
      await window.getByTestId("composer-send").waitFor();
    }
    const item = (title) =>
      window.getByTestId("task-item").filter({ hasText: title });
    const more = () => window.getByTestId("toggle-more-tasks");
    const rowCount = () => window.getByTestId("task-item").count();
    const countText = () => more().textContent();

    for (const n of [1, 2, 3, 4, 5, 6, 7]) await create(`任务${n}`);
    assert((await rowCount()) === 5, "默认仅直显前 5 条");
    assert((await countText()) === "更多（2）", "更多按钮带被折叠计数");
    // 新建任务 lastUsedAt 最新排最前，落在前 5 内直接可见（不被折叠挡住）
    await create("任务8");
    assert((await rowCount()) === 5, "新建后仍直显 5 条");
    assert(await item("任务8").isVisible(), "新建任务排最前直接可见");
    assert((await countText()) === "更多（3）", "折叠计数随总数更新");
    await more().click();
    assert((await rowCount()) === 8, "展开显示全部活跃任务");
    assert((await countText()) === "收起", "展开后按钮变收起");
    assert(await item("任务8").isVisible(), "展开后尾部任务可见");
    await more().click();
    assert((await rowCount()) === 5, "收起回到前 5 条");
    assert((await countText()) === "更多（3）", "收起恢复折叠计数");

    // 展开态是会话内 state：重启回到默认 5 条（折叠口径不持久化）
    await more().click();
    assert((await rowCount()) === 8, "重启前先展开全量");
    await closeApp(app);
    app = null;
    ({ app, window } = await launchApp({ homeDir, workspaceDir }));
    await item("任务8").waitFor();
    assert((await rowCount()) === 5, "重启回到默认直显 5 条");
    assert((await countText()) === "更多（3）", "重启恢复折叠计数");
    // 重启恢复的当前任务（最新）排序在前 5 内：无需自动展开即可选中查看
    assert(
      (await window
        .getByTestId("task-row")
        .locator('[aria-current="page"]')
        .getAttribute("data-task-id")) !== null,
      "当前任务仍在直显区内保持选中语义"
    );
  } finally {
    if (app) await closeApp(app);
    model.server.close();
    model.server.closeAllConnections();
    rmSync(root, { recursive: true, force: true });
  }
  console.log(
    "[e2e:sidebar-task-preview] 通过：组内预览限额 + 更多展开/收起 + 重启回默认"
  );
}

main().catch((error) => {
  console.error("[e2e:sidebar-task-preview] 失败", error);
  process.exitCode = 1;
});
