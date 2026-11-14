// 导出 Markdown：最终正文操作栏的导出按钮 → files:save-text IPC →
// 原生保存对话框（E2E 钩子 CODEXLIKE_TEST_EXPORT_DIR 固定写盘目录，
// 先例：tasks.selectWorkspace 的 CODEXLIKE_TEST_WORKSPACE）→ 主进程落盘。
// 验证：默认文件名取任务标题、文件内容为当前段原始 markdown 正文。
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, closeApp, launchApp, startMockProvider } from "./helpers.mjs";

const REPLY = "# 导出正文\n\n- 星河一行\n- **加粗**一段";

async function main() {
  const root = mkdtempSync(join(tmpdir(), "codexlike-export-"));
  const homeDir = join(root, "home");
  const workspaceDir = join(homeDir, "workspace");
  const exportDir = join(root, "exports");
  mkdirSync(workspaceDir, { recursive: true });
  const model = await startMockProvider((ctx) => {
    ctx.textRound(REPLY);
  });
  let app;
  let window;
  try {
    ({ app, window } = await launchApp({
      homeDir,
      workspaceDir,
      env: { CODEXLIKE_TEST_EXPORT_DIR: exportDir },
    }));
    window.setDefaultTimeout(8000);
    // 配置 mock 模型（先例：task-search.mjs 的 Profile 创建流程）
    await window.getByTestId("settings-open").click();
    await window.getByTestId("profile-create").click();
    const form = window.locator("form");
    await form.getByLabel("名称").fill("Export Mock");
    await form.getByLabel("baseURL").fill(`http://127.0.0.1:${model.port}/v1`);
    await form.getByLabel("API Key").fill("secret-never-exported");
    await form.getByLabel("模型").fill("mock-model");
    await form.getByRole("button", { name: /保存|创建/ }).click();
    await window.getByText("Export Mock", { exact: true }).waitFor();
    await window.getByTestId("settings-back").click();

    await window.getByTestId("new-task").click();
    await window.getByTestId("draft-select-workspace").click();
    await window.getByTestId("composer-input").fill("导出冒烟任务");
    await window.getByTestId("composer-send").click();
    await window.getByTestId("message-assistant").waitFor();
    // 操作栏出现即轮完成（复制入口是操作栏首个控件）
    await window.getByTestId("assistant-copy").waitFor();

    await window.getByTestId("assistant-export").click();
    // 默认文件名 = 任务标题（非法字符在渲染层替换；此处标题合法）
    const target = join(exportDir, "导出冒烟任务.md");
    let content = null;
    for (let i = 0; i < 50 && content === null; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (existsSync(target)) content = readFileSync(target, "utf8");
    }
    assert(content !== null, `导出文件应落盘：${target}`);
    assert(
      content === REPLY,
      `导出内容应为当前段原始 markdown：${JSON.stringify(content)}`
    );
    console.log(
      "[e2e] 导出 Markdown 全链（按钮 → IPC → 对话框钩子落盘）通过 ✅"
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
