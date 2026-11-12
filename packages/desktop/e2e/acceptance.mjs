// 验收走查 E2E（工单 14）：补齐 spec 九条验收场景中既有 E2E 未串联的两条——
// 场景 2「修 bug 全流程」：read_file → grep → apply_patch（真实补丁修复）
//   → run_terminal_command（suggest 模式审批卡 → 批准 → 真实执行）→ 改动面板 diff → 一键 commit；
// 场景 5「worktree 双会话并行」：同一 git 仓库、会话 A 本目录直跑 + 会话 B worktree 模式，
//   两会话各写一个文件，断言落盘互不干扰（主仓库/副本各得其所，git status 不串）。
// 与其余九条既有 E2E（smoke/commands/approvals/compact/changes/interrupt/worktree/mcp/subagents/browser）
// 一起构成九条场景的打包产物走查；设 CODEXLIKE_PACKAGED_EXE 指向安装版/便携版 exe。
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  prepareDraft,
  startMockProvider,
} from "./helpers.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

const CALC_JS = `function sumTo(n) {
  let total = 0;
  for (let i = 1; i < n; i += 1) {
    total += i;
  }
  return total;
}

console.log('sumTo(5) = ' + sumTo(5));
`;

/** 把 calc.js 的 off-by-one（i < n）修复为 i <= n 的补丁 */
const FIX_PATCH = `*** Begin Patch
*** Update File: calc.js
@@
   let total = 0;
-  for (let i = 1; i < n; i += 1) {
+  for (let i = 1; i <= n; i += 1) {
     total += i;
*** End Patch`;

/** 配置 Provider Profile（全新数据目录首次使用的第一步） */
async function configureProfile(window, port) {
  await window.getByRole("button", { name: "设置", exact: true }).click();
  await window.getByTestId("profile-create").click();
  const profileForm = window.locator("form");
  await profileForm.getByLabel("名称").fill("Mock");
  await profileForm.getByLabel("baseURL").fill(`http://127.0.0.1:${port}/v1`);
  await profileForm.getByLabel("API Key").fill("sk-e2e");
  await profileForm.getByLabel("模型").fill("mock-model");
  await window
    .locator("form")
    .getByRole("button", { name: /保存|创建/ })
    .click();
  await window.getByText("Mock").first().waitFor();
  await window.getByRole("button", { name: "返回工作台" }).click();
}

async function main() {
  /**
   * 场景脚本：场景 2 五轮（read → grep → apply_patch → 审批命令 → 收尾）
   * 与场景 5 四轮（会话 A 写文件/收尾、会话 B 写文件/收尾）合用一个 server，
   * 以「当前阶段 + 请求序号」驱动；非流式请求（提交消息生成）返回固定中文消息。
   */
  let phase = "scenario2";
  // 只对流式请求计数（与原实现一致）：非流式的提交消息生成不打断轮次序号
  let streamCount = 0;
  const { server, port } = await startMockProvider((ctx, { body }) => {
    if (!body.includes('"stream":true')) {
      // 非流式：generateCommitMessage（改动面板「生成提交消息」）
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
              content: "修复 sumTo 的 off-by-one 边界错误",
            },
            finish_reason: "stop",
          },
        ],
      });
      return;
    }
    streamCount += 1;
    if (phase === "scenario2") {
      if (streamCount === 1)
        return ctx.toolCallRound("call-a2-read", "read_file", {
          path: "calc.js",
        });
      if (streamCount === 2)
        return ctx.toolCallRound("call-a2-grep", "grep", { pattern: "sumTo" });
      if (streamCount === 3)
        return ctx.toolCallRound("call-a2-patch", "apply_patch", {
          patch: FIX_PATCH,
        });
      if (streamCount === 4)
        return ctx.toolCallRound("call-a2-run", "run_terminal_command", {
          command: "node calc.js",
        });
      return ctx.textRound("已修复 sumTo 的边界错误：验证输出 sumTo(5) = 15。");
    }
    // scenario5：A 会话两轮（1 偏移 = 场景 2 已耗 5 次）→ B 会话两轮
    if (streamCount === 6)
      return ctx.toolCallRound("call-a5-a", "write_file", {
        path: "a-local.txt",
        content: "会话 A（本目录直跑）",
      });
    if (streamCount === 7) return ctx.textRound("A 会话文件已写入。");
    if (streamCount === 8)
      return ctx.toolCallRound("call-a5-b", "write_file", {
        path: "b-worktree.txt",
        content: "会话 B（worktree 模式）",
      });
    return ctx.textRound("B 会话文件已写入隔离副本。");
  });
  /** 切到场景 5 分支（在场景 2 的 5 次请求全部完成后调用） */
  const enterScenario5 = () => {
    phase = "scenario5";
  };
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-acceptance-"));
  const repo = join(homeDir, "repo");
  let app;
  try {
    // git repo fixture：含 off-by-one bug 的 calc.js + 基线提交
    mkdirSync(repo);
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "e2e@codexlike.local");
    git(repo, "config", "user.name", "CodexLike E2E");
    writeFileSync(join(repo, "calc.js"), CALC_JS);
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "基线提交（含 bug）");

    // ===== 场景 2：修 bug 全流程（read → grep → apply_patch → 审批命令 → diff → commit）=====
    const launched = await launchApp({ homeDir, workspaceDir: repo });
    app = launched.app;
    let window = launched.window;
    await configureProfile(window, port);
    await prepareDraft(window, { project: true, approvalMode: "assist" });
    // 显式选择 assist（帮我批准）：文件编辑与普通命令自动放行（GLOSSARY「审批模式」新三档）
    await window
      .getByTestId("composer-input")
      .fill("修复 calc.js 里 sumTo 的 off-by-one bug 并验证");
    await window.getByTestId("composer-send").click();

    // 工具链前两步：read_file 与 grep 卡片出现（调研阶段）
    const cards = window.getByTestId("tool-call-card");
    await cards.first().waitFor({ timeout: 20_000 });
    await cards
      .filter({ hasText: "grep" })
      .first()
      .waitFor({ timeout: 20_000 });
    console.log("[e2e] 场景2：read_file → grep 调研卡片出现");

    // apply_patch 真实修复：文件内容已变（i <= n）
    for (let i = 0; i < 100; i += 1) {
      if (readFileSync(join(repo, "calc.js"), "utf8").includes("i <= n")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert(
      readFileSync(join(repo, "calc.js"), "utf8").includes("i <= n"),
      "apply_patch 未真实修复 calc.js"
    );
    console.log("[e2e] 场景2：apply_patch 真实落盘（i < n → i <= n）");

    // assist 档普通命令（node calc.js 非危险）自动放行：无审批卡，直接真实执行
    const runCard = cards.filter({ hasText: "run_terminal_command" }).first();
    await runCard.waitFor({ timeout: 20_000 });
    await runCard.getByTestId("tool-call-toggle").click();
    await runCard
      .getByTestId("tool-call-output")
      .filter({ hasText: "sumTo(5) = 15" })
      .waitFor({ timeout: 20_000 });
    assert(
      (await window.getByTestId("interaction-panel").count()) === 0,
      "普通命令不应弹审批卡"
    );
    console.log(
      "[e2e] 场景2：assist 自动放行 → node calc.js 输出 sumTo(5) = 15"
    );

    await window
      .getByTestId("message-assistant")
      .getByText("已修复 sumTo 的边界错误")
      .waitFor({ timeout: 20_000 });

    // 改动面板：calc.js 显示「修改」，Monaco diff 两侧（原侧 bug 行 / 新侧修复行）
    await window.getByTestId("changes-toggle").click();
    const panel = window.getByTestId("changes-panel");
    await panel.waitFor({ timeout: 10_000 });
    const fileItem = panel
      .getByTestId("changes-file-item")
      .filter({ hasText: "calc.js" });
    await fileItem.waitFor({ timeout: 10_000 });
    assert(
      (await fileItem.textContent()).includes("修改"),
      "calc.js 未显示「修改」标识"
    );
    await fileItem.click();
    await panel
      .locator(".editor.original .view-lines")
      .first()
      .waitFor({ timeout: 30_000 });
    await panel
      .locator(".editor.modified .view-lines")
      .first()
      .waitFor({ timeout: 30_000 });
    await panel.getByTestId("changes-back").click();
    console.log("[e2e] 场景2：改动面板 Monaco 双栏 diff 可见");

    // 一键 commit：先让模型生成提交消息（与 changes.mjs 同流程），再提交
    await panel.getByTestId("changes-generate-message").click();
    const messageBox = panel.getByTestId("changes-commit-message");
    await messageBox.waitFor({ timeout: 10_000 });
    for (let i = 0; i < 50; i += 1) {
      if ((await messageBox.inputValue()) !== "") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert((await messageBox.inputValue()) !== "", "模型提交消息未生成");
    await panel.getByTestId("changes-commit").click();
    const feedback = panel.getByTestId("changes-commit-feedback");
    await feedback.waitFor({ timeout: 15_000 });
    assert((await feedback.textContent()).includes("已提交"), "提交反馈异常");
    const commitSubject = git(repo, "log", "-1", "--pretty=%s").trim();
    assert(
      commitSubject === "修复 sumTo 的 off-by-one 边界错误",
      `git 落库提交异常：${commitSubject}`
    );
    console.log("[e2e] 场景2：一键 commit 落库（模型生成消息）✅");

    // ===== 场景 5：同一仓库双会话（本目录直跑 + worktree 模式）并行互不干扰 =====
    enterScenario5();
    // 会话 A：本目录直跑（同一 repo）
    await window.getByTestId("changes-toggle").click(); // 收起面板回到消息流
    await prepareDraft(window, { project: true, approvalMode: "assist" });
    await window.getByTestId("composer-input").fill("写入 a-local.txt");
    await window.getByTestId("composer-send").click();
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "A 会话文件已写入。" })
      .waitFor({ timeout: 20_000 });
    assert(existsSync(join(repo, "a-local.txt")), "会话 A 文件未落主仓库");
    console.log("[e2e] 场景5：会话 A（本目录直跑）文件落主仓库");

    // 会话 B：worktree 模式（同一 repo，托管 Worktree 隔离副本）
    await prepareDraft(window, {
      project: true,
      worktree: true,
      approvalMode: "assist",
    });
    await window.getByTestId("composer-input").fill("写入 b-worktree.txt");
    await window.getByTestId("composer-send").click();
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "B 会话文件已写入隔离副本。" })
      .waitFor({ timeout: 20_000 });

    // 隔离断言：b 落副本不落主仓库；副本内无 a；主仓库 status 不含 b
    const worktreesRoot = join(homeDir, "worktrees");
    const copies = readdirSync(worktreesRoot).filter((name) =>
      existsSync(join(worktreesRoot, name, ".git"))
    );
    assert(
      copies.length === 1,
      `托管 Worktree 副本数异常：${copies.join(", ")}`
    );
    const copyDir = join(worktreesRoot, copies[0]);
    assert(
      existsSync(join(copyDir, "b-worktree.txt")),
      "会话 B 文件未落 worktree 副本"
    );
    assert(
      !existsSync(join(copyDir, "a-local.txt")),
      "会话 A 的文件泄漏进 worktree 副本"
    );
    assert(
      !existsSync(join(repo, "b-worktree.txt")),
      "会话 B 的文件泄漏进主仓库"
    );
    const status = git(repo, "status", "--porcelain").trim();
    assert(
      !status.includes("b-worktree.txt"),
      `主仓库 status 串入 B 会话文件：${status}`
    );
    console.log(
      "[e2e] 场景5：会话 B（worktree 模式）文件落隔离副本，双会话互不干扰 ✅"
    );

    await closeApp(app);
    console.log("[e2e] 验收走查 E2E（场景 2 + 场景 5）通过 ✅");
  } catch (error) {
    console.error("[e2e] 验收走查 E2E 失败 ❌", error);
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
