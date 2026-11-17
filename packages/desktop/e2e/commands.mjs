// E2E（工单 07）：斜杠命令 + @引用 + AGENTS.md 注入的真实应用冒烟。
// 路径：预置全局/项目 AGENTS.md 与工作区文件 → 设置页建 Profile（本地 mock SSE）
// → 建任务 → /status 展示 AGENTS.md 来源 → @引用 发消息并断言真实请求体
// 含 AGENTS.md 与被引用文件内容 → /rename /model /new /archive 逐一验证。
// 运行：pnpm --filter @codexlike/desktop run test:e2e:commands（先 pnpm build）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  assert,
  closeApp,
  launchApp,
  prepareDraft,
  taskMenu,
  startMockProvider,
} from "./helpers.mjs";

async function main() {
  // mock：记录请求体（断言 AGENTS.md / @引用 内容真实进入模型请求），固定回复「收到。」
  const { server, port, seenBodies } = await startMockProvider((ctx) => {
    ctx.textRound("收到。");
  });
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-cmd-"));

  // 预置：全局 + 项目 AGENTS.md（/status 与请求体断言用）、@引用 目标文件
  mkdirSync(join(homeDir, "workspace", "src"), { recursive: true });
  writeFileSync(join(homeDir, "AGENTS.md"), "E2E全局规范标记XYZ");
  writeFileSync(join(homeDir, "workspace", "AGENTS.md"), "E2E项目规范标记UVW");
  writeFileSync(
    join(homeDir, "workspace", "README.md"),
    "README 内容：这是被 @引用 的文件。"
  );
  writeFileSync(
    join(homeDir, "workspace", "src", "app.ts"),
    "export const app = 1;"
  );

  let app;
  try {
    const { app: launchedApp, window } = await launchApp({ homeDir });
    app = launchedApp;

    // 1) 设置页创建 Profile（本地 mock）
    await window.getByTestId("settings-open").click();
    await window.getByTestId("profile-create").click();
    const profileForm = window.locator("form");
    await profileForm.getByLabel("名称").fill("Mock");
    await profileForm.getByLabel("baseURL").fill(`http://127.0.0.1:${port}/v1`);
    await profileForm.getByLabel("API Key").fill("sk-e2e");
    await profileForm.getByLabel("模型 1").fill("mock-model");
    // 设置页现在有两个「保存」按钮（Profile 表单与搜索源区），限定在表单内点击
    await window
      .locator("form")
      .getByRole("button", { name: /保存|创建/ })
      .click();
    await window.getByText("Mock").first().waitFor();

    // 2) 建任务（目录经 CODEXLIKE_TEST_WORKSPACE 钩子固定）
    await window.getByTestId("settings-back").click();
    await prepareDraft(window);

    const composer = window.getByTestId("composer-input");
    await composer.fill("命令验收初始任务");
    await window.getByTestId("composer-send").click();
    await window.getByTestId("message-assistant").waitFor();
    await window.getByTestId("composer-send").waitFor();

    // 3) 斜杠命令菜单：输入 /st 弹菜单（模糊匹配 status），Enter 选中无参命令即执行
    await composer.fill("/st");
    const menu = window.getByTestId("composer-menu");
    await menu.waitFor({ timeout: 5_000 });
    assert(
      (await menu.textContent())?.includes("/status") === true,
      "命令菜单未展示 /status"
    );
    await composer.press("Enter"); // 选中 /status（无参命令）直接执行
    assert((await menu.count()) === 0, "执行后菜单应关闭");

    const statusCard = window.getByTestId("message-status").first();
    await statusCard.waitFor({ timeout: 10_000 });
    const statusText = await statusCard.textContent();
    // 正式任务只能由首次发送建立；模型、用量与 AGENTS.md 来源仍必须展示。
    assert(
      statusText?.includes("mock-model") === true,
      `/status 应显示实际模型：${statusText}`
    );
    assert(
      statusText?.includes("tokens") === true,
      "/status 未显示 token 估算"
    );
    assert(
      statusText?.includes("2 个来源") === true &&
        statusText?.includes("AGENTS.md") === true,
      `/status 未显示 AGENTS.md 来源：${statusText}`
    );
    console.log("[e2e] /status：用量估算 + AGENTS.md 来源可见");

    // 4) @引用 菜单：输入 @REA 模糊匹配 README.md，Enter 写回，发送后断言真实请求体
    await composer.fill("请阅读 @REA");
    await menu.waitFor({ timeout: 5_000 });
    assert(
      (await menu.textContent())?.includes("README.md") === true,
      "@菜单未展示 README.md"
    );
    await composer.press("Enter"); // 选中写回 @README.md
    assert(
      (await composer.inputValue()) === "请阅读 @README.md ",
      `@选中未写回输入框：${await composer.inputValue()}`
    );
    await composer.pressSequentially("并总结", { delay: 10 });
    await window.getByTestId("composer-send").click();
    await window
      .getByTestId("message-user")
      .filter({ hasText: "请阅读 @README.md" })
      .waitFor({ timeout: 10_000 });
    // 初始任务已有第一条回复，必须等本次引用请求完成，不能让旧气泡满足等待。
    await window
      .getByTestId("message-assistant")
      .nth(1)
      .waitFor({ timeout: 20_000 });
    await window.getByTestId("composer-send").waitFor();

    const requestBodies = seenBodies.join("\n");
    assert(
      requestBodies.includes("E2E全局规范标记XYZ") === true,
      "全局 AGENTS.md 未进入模型请求"
    );
    assert(
      requestBodies.includes("E2E项目规范标记UVW") === true,
      "项目 AGENTS.md 未进入模型请求"
    );
    assert(
      requestBodies.includes("README 内容：这是被 @引用 的文件。") === true,
      "@引用 文件内容未进入模型请求"
    );
    assert(
      requestBodies.includes("attached-file") === true,
      "@引用 未按 attached-file 结构附加"
    );
    console.log("[e2e] @引用 与 AGENTS.md 内容真实进入模型请求体");

    // 4.5) 消息往返后再查 /status：模型已记录
    await composer.fill("/status");
    await composer.press("Enter");
    const statusAfter = window.getByTestId("message-status").nth(1);
    await statusAfter.waitFor({ timeout: 10_000 });
    const statusAfterText = await statusAfter.textContent();
    assert(
      statusAfterText?.includes("mock-model") === true,
      `/status 未显示已用模型：${statusAfterText}`
    );
    console.log("[e2e] /status：发送消息后显示所用模型");

    // 5) /rename：侧栏标题更新
    await composer.fill("/rename E2E改名任务");
    await composer.press("Enter");
    await window
      .getByTestId("task-item")
      .filter({ hasText: "E2E改名任务" })
      .waitFor({ timeout: 5_000 });
    console.log("[e2e] /rename：侧栏标题已更新");

    // 6) /model：唯一命中切换
    await composer.fill("/model Mock");
    await composer.press("Enter");
    await window
      .getByText("模型已切换：Mock · mock-model")
      .first()
      .waitFor({ timeout: 5_000 });
    console.log("[e2e] /model：模型切换提示可见");

    // 7) /new：独立归属打开独立草稿，不继承旧工作区，不产生空历史。
    await composer.fill("/new");
    await composer.press("Enter");
    await window.getByTestId("draft-select-workspace").waitFor();
    assert(
      (await window.getByTestId("task-item").count()) === 1,
      "/new 只打开草稿"
    );
    assert(
      (await window.getByTestId("workspace-path").textContent()).includes(
        "专用持久目录"
      ),
      "独立新建不继承执行目录"
    );
    await composer.fill("第二个独立任务");
    await window.getByTestId("composer-send").click();
    await window.getByTestId("task-item").nth(1).waitFor();
    await window.getByTestId("message-assistant").waitFor();
    await window.getByTestId("composer-send").waitFor();
    console.log("[e2e] /new：首次发送才创建第二个独立任务");

    // 8) /archive：当前任务归档后侧栏只剩 1 个，已归档区可展开恢复
    await composer.fill("/archive");
    await composer.press("Enter");
    await window
      .getByTestId("task-item")
      .filter({ hasText: "E2E改名任务" })
      .waitFor();
    await window.waitForFunction(
      () => document.querySelectorAll('[data-testid="task-item"]').length === 1,
      undefined,
      { timeout: 5_000 }
    );
    await window.getByTestId("toggle-archived").click();
    await (
      await taskMenu(
        window,
        window
          .getByTestId("archived-task-item")
          .filter({ hasText: "第二个独立任务" })
      )
    )
      .getByTestId("unarchive-button")
      .click();
    await window.waitForFunction(
      () => document.querySelectorAll('[data-testid="task-item"]').length === 2,
      undefined,
      { timeout: 5_000 }
    );
    console.log(
      "[e2e] /archive 与恢复：归档收进项目组内「已归档」子折叠，可展开恢复"
    );

    await closeApp(app);
    console.log("[e2e] 工单 07 命令冒烟通过 ✅");
  } catch (error) {
    console.error("[e2e] 冒烟失败 ❌", error);
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
