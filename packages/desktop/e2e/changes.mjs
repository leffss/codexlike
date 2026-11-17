// E2E（工单 05：改动面板 + git 集成）：真实 Electron 应用走完整 git 链路——
// git repo 工作区（预置基线提交）→ 建任务 → 消息驱动 write_file 产生真实变更
// → 改动面板列出「新增」文件 → 点开 Monaco 双栏 diff → 一键创建任务分支（类型/<slug>）
// → 模型生成提交消息（可编辑）→ 一键提交 → 面板刷新干净 + git 命令行侧验证落库
// → 再开非 git 工作区任务，断言面板降级提示不报错。
// 运行：pnpm --filter @codexlike/desktop run test:e2e:changes（先全仓 build）。
import { execFileSync } from "node:child_process";
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
import process from "node:process";

import {
  assert,
  closeApp,
  launchApp,
  openRailPanel,
  prepareDraft,
  startMockProvider,
} from "./helpers.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

/**
 * 场景脚本（mock 分流）：
 * - 流式请求（streamText）：第 1 次 tool_call（write_file，真实写盘）→ 第 2 次流式收尾文本；
 * - 非流式请求（generateText，生成提交消息）：返回 JSON 文本「添加 e2e-change.txt 示例文件」。
 */
async function main() {
  let streamCount = 0;
  const { server, port } = await startMockProvider((ctx, { body }) => {
    if (!body.includes('"stream":true')) {
      // 生成提交消息：非流式 JSON（generateCommitMessage 走一次不发工具的请求）
      ctx.respondJson({
        id: "chatcmpl-commit",
        object: "chat.completion",
        created: 0,
        model: "mock-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "添加 e2e-change.txt 示例文件",
            },
            finish_reason: "stop",
          },
        ],
      });
      return;
    }
    streamCount += 1;
    if (streamCount === 1) {
      ctx.toolCallRound("call-changes-e2e", "write_file", {
        path: "e2e-change.txt",
        content: "改动面板 E2E 内容",
      });
      return;
    }
    ctx.textRound("文件已创建。");
  });
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-changes-"));
  const repo = join(homeDir, "workspace");
  const plain = join(homeDir, "plain-workspace");
  let app;
  try {
    // git repo fixture：基线提交 + 本地身份（commit 需要）
    mkdirSync(repo);
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "e2e@codexlike.local");
    git(repo, "config", "user.name", "CodexLike E2E");
    writeFileSync(join(repo, "README.md"), "# 基线\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "基线提交");
    mkdirSync(plain);

    // 1) 启动 → 配置 Profile → 建任务 → 消息驱动 write_file（真实写盘）
    const first = await launchApp({ homeDir });
    app = first.app;
    let window = first.window;
    await window.getByTestId("settings-open").click();
    await window.getByTestId("profile-create").click();
    const profileForm = window.locator("form");
    await profileForm.getByLabel("名称").fill("Mock");
    await profileForm.getByLabel("baseURL").fill(`http://127.0.0.1:${port}/v1`);
    await profileForm.getByLabel("API Key").fill("sk-e2e");
    await profileForm.getByLabel("模型 1").fill("mock-model");
    // 设置页有两个「保存」按钮（Profile 表单与搜索源区，工单 10），限定在表单内点击
    await window
      .locator("form")
      .getByRole("button", { name: /保存|创建/ })
      .click();
    await window.getByText("Mock").first().waitFor();
    await window.getByTestId("settings-back").click();

    await prepareDraft(window, { approvalMode: "assist" });
    await window.getByTestId("composer-input").fill("创建 e2e-change.txt");
    await window.getByTestId("composer-send").click();
    await window
      .getByTestId("message-assistant")
      .getByText("文件已创建。")
      .waitFor({ timeout: 20_000 });
    assert(existsSync(join(repo, "e2e-change.txt")), "write_file 未真实落盘");
    console.log("[e2e] 任务产生真实文件变更");

    // 2) 打开右栏改动 tab → 列表出现「新增」标识的文件
    await openRailPanel(window);
    const panel = window.getByTestId("changes-panel");
    await panel.waitFor({ timeout: 10_000 });
    const fileItem = panel
      .getByTestId("changes-file-item")
      .filter({ hasText: "e2e-change.txt" });
    await fileItem.waitFor({ timeout: 10_000 });
    assert(
      (await fileItem.textContent()).includes("新增"),
      "变更文件未显示「新增」标识"
    );
    assert(
      (await panel.getByTestId("changes-branch").textContent()) === "main",
      "未显示当前分支 main"
    );
    console.log("[e2e] 改动面板：变更文件列表 + 类型标识 + 当前分支");

    // 3) 点文件 → Monaco 双栏 diff（原侧空、新侧有内容）
    await fileItem.click();
    await panel.getByTestId("changes-diff-path").waitFor({ timeout: 10_000 });
    // monaco 为懒加载 chunk；DiffEditor 的原/新两个编辑器分别渲染出行内容区
    await panel
      .locator(".editor.original .view-lines")
      .first()
      .waitFor({ timeout: 30_000 });
    await panel
      .locator(".editor.modified .view-lines")
      .first()
      .waitFor({ timeout: 30_000 });
    console.log("[e2e] Monaco 双栏 diff 渲染（原/新两侧）");

    // 4) 一键创建任务分支（类型/<slug>）→ 成功反馈
    await panel.getByTestId("changes-create-branch").click();
    await panel
      .getByTestId("changes-branch-feedback")
      .waitFor({ timeout: 10_000 });
    const branchFeedback = await panel
      .getByTestId("changes-branch-feedback")
      .textContent();
    assert(
      branchFeedback.includes("已创建并切换到分支"),
      `分支反馈异常：${branchFeedback}`
    );
    // 等面板刷新后徽标真正切到新分支（refresh 异步完成前仍是旧值）
    await panel
      .getByTestId("changes-branch")
      .filter({ hasText: /^feature\// })
      .waitFor({ timeout: 10_000 });
    const branchShown = await panel.getByTestId("changes-branch").textContent();
    console.log(`[e2e] 一键创建分支：${branchShown}`);

    // 5) 模型生成提交消息（可编辑）→ 提交 → 面板刷新干净 + git 侧验证
    await panel.getByTestId("changes-generate-message").click();
    const messageBox = panel.getByTestId("changes-commit-message");
    await messageBox.waitFor({ timeout: 10_000 });
    for (let i = 0; i < 50; i += 1) {
      const value = await messageBox.inputValue();
      if (value !== "") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert(
      (await messageBox.inputValue()) === "添加 e2e-change.txt 示例文件",
      "模型生成的提交消息未填充到可编辑输入框"
    );
    await messageBox.fill("添加 e2e-change.txt 示例文件（人工修订）"); // 可编辑
    await panel.getByTestId("changes-commit").click();
    await panel
      .getByTestId("changes-commit-feedback")
      .waitFor({ timeout: 10_000 });
    assert(
      (
        await panel.getByTestId("changes-commit-feedback").textContent()
      ).includes("已提交"),
      "提交反馈异常"
    );
    await fileItem.waitFor({ state: "detached", timeout: 10_000 });
    const commitSubject = git(repo, "log", "-1", "--pretty=%s").trim();
    assert(
      commitSubject === "添加 e2e-change.txt 示例文件（人工修订）",
      `git 落库的提交消息异常：${commitSubject}`
    );
    const dirty = git(repo, "status", "--porcelain").trim();
    assert(dirty === "", `提交后工作区仍有残留变更：${dirty}`);
    console.log(
      "[e2e] 一键提交：模型生成 → 可编辑 → 提交 → 面板刷新，git 侧验证通过"
    );

    // 6) 非 git 工作区：降级提示、不报错
    await closeApp(app);
    const homeSecond = homeDir; // 复用同一数据目录：Profile 已配置
    const second = await launchApp({
      homeDir: homeSecond,
      workspaceDir: plain,
    });
    app = second.app;
    window = second.window;
    await prepareDraft(window, { approvalMode: "assist" });
    await window.getByTestId("composer-input").fill("检查非 Git 目录");
    await window.getByTestId("composer-send").click();
    await window.getByTestId("message-assistant").waitFor();
    await window.getByTestId("composer-send").waitFor();
    await openRailPanel(window);
    await window.getByTestId("changes-not-git").waitFor({ timeout: 10_000 });
    assert(
      (await window.getByTestId("changes-not-git").textContent()).includes(
        "非 git 工作区"
      ),
      "非 git 工作区提示未出现"
    );
    console.log("[e2e] 非 git 工作区：面板降级提示，不报错");

    await closeApp(app);
    console.log("[e2e] 改动面板 + git 集成 E2E 通过 ✅");
  } catch (error) {
    console.error("[e2e] 改动面板 E2E 失败 ❌", error);
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
