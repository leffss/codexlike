// ADR 0010：真实 Electron 首次发送 Worktree、共享目录提示、失败重试与进程重开。
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, closeApp, launchApp, startMockProvider } from "./helpers.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}
async function main() {
  const root = mkdtempSync(join(tmpdir(), "codexlike-e2e-worktree-"));
  const homeDir = join(root, "nested", "home");
  const repo = join(root, "repo");
  const plain = join(root, "plain");
  let app;
  let toolRound = 0;
  const model = await startMockProvider((ctx, { body }) => {
    if (body.includes("共享等待")) {
      ctx.toolCallRound("shared-question", "ask_user_question", {
        questions: [
          {
            id: "q",
            header: "等待",
            question: "是否继续？",
            multiSelect: false,
            options: [{ id: "ok", label: "继续" }],
          },
        ],
      });
      return;
    }
    const request = JSON.parse(body);
    const lastUser = [...request.messages]
      .reverse()
      .find((message) => message.role === "user");
    if (JSON.stringify(lastUser).includes("隔离写入")) {
      const round = toolRound++;
      if (round === 0) {
        ctx.toolCallRound("write-wt", "write_file", {
          path: "wt-e2e.txt",
          content: "隔离成果",
        });
        return;
      }
      if (round === 1) {
        ctx.toolCallRound("terminal-wt", "run_terminal_command", {
          command: "git branch --show-current > terminal-branch.txt",
        });
        return;
      }
    }
    ctx.textRound("任务已完成");
  });
  try {
    mkdirSync(repo);
    mkdirSync(plain);
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "test@codexlike.local");
    git(repo, "config", "user.name", "Test");
    writeFileSync(join(repo, "tracked.txt"), "来源内容");
    writeFileSync(join(repo, ".gitignore"), ".env\n");
    git(repo, "add", "tracked.txt", ".gitignore");
    git(repo, "commit", "-m", "fixture");
    writeFileSync(join(repo, ".env"), "SECRET=e2e");
    writeFileSync(join(repo, ".worktreeinclude"), ".env\n");
    let window;
    ({ app, window } = await launchApp({ homeDir, workspaceDir: repo }));
    await window.getByTestId("settings-open").click();
    await window.getByTestId("profile-create").click();
    const form = window.locator("form");
    await form.getByLabel("名称").fill("Worktree Mock");
    await form.getByLabel("baseURL").fill(`http://127.0.0.1:${model.port}/v1`);
    await form.getByLabel("API Key").fill("test");
    await form.getByLabel("模型").fill("mock-model");
    await form.getByRole("button", { name: /保存|创建/ }).click();
    await window.getByText("Worktree Mock", { exact: true }).waitFor();
    await window.getByTestId("settings-back").click();
    await window.getByTestId("add-project").click();
    await window.getByTestId("project-new-session").click();
    await window.getByTestId("draft-workspace-mode").waitFor({ timeout: 5000 });
    assert(
      (await window.getByTestId("draft-workspace-mode").inputValue()) ===
        "local",
      "项目草稿默认本地"
    );
    await window.getByTestId("draft-workspace-mode").selectOption("worktree");
    await window.getByTestId("composer-input").fill("隔离写入");
    assert(!existsSync(join(homeDir, "worktrees")), "首次发送前不得创建副本");
    assert(
      git(repo, "branch", "--list", "codexlike/*").trim() === "",
      "首次发送前不得创建分支"
    );
    assert(
      (await window.getByTestId("session-item").count()) === 0,
      "首次发送前无会话"
    );
    assert(
      (await window.getByTestId("new-session-dialog").count()) === 0,
      "不恢复模式弹窗"
    );
    await window.getByTestId("approval-mode-select").selectOption("assist");
    await window.getByTestId("composer-send").dblclick();
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "任务已完成" })
      .waitFor({ timeout: 20000 });
    await window.getByTestId("composer-send").waitFor();
    const ids = readdirSync(join(homeDir, "worktrees"));
    assert(ids.length === 1, "双击仅创建一份副本");
    const worktreePath = join(homeDir, "worktrees", ids[0]);
    assert(
      readFileSync(join(worktreePath, ".env"), "utf8") === "SECRET=e2e",
      "复制声明文件"
    );
    assert(
      readFileSync(join(worktreePath, "wt-e2e.txt"), "utf8") === "隔离成果",
      "工具写入实际副本"
    );
    assert(!existsSync(join(repo, "wt-e2e.txt")), "主仓库不受影响");
    assert(
      readFileSync(join(worktreePath, "terminal-branch.txt"), "utf8").trim() ===
        `codexlike/${ids[0]}`,
      "终端命令也在隔离分支执行"
    );
    assert(
      !existsSync(join(repo, "terminal-branch.txt")),
      "终端不得写入来源目录"
    );
    assert(
      git(worktreePath, "branch", "--show-current").trim() ===
        `codexlike/${ids[0]}`,
      "独立分支"
    );
    assert(
      (await window.getByTestId("workspace-path").textContent()).includes(
        worktreePath
      ),
      "显示实际工作区"
    );
    assert(
      (await window.getByTestId("workspace-mode").textContent()).includes(
        "Worktree"
      ),
      "显示工作区模式"
    );
    assert(
      (await window.getByTestId("draft-workspace-mode").count()) === 0,
      "首次执行后模式固定"
    );

    // 独立入口使用同项目目录且等待问答，项目草稿必须出现共享风险提示。
    await window.getByTestId("new-session").click();
    assert(
      (await window.getByTestId("draft-workspace-mode").count()) === 0,
      "独立入口不直接提供 Worktree"
    );
    await window.getByTestId("draft-select-workspace").click();
    await window.getByTestId("composer-input").fill("共享等待");
    await window.getByTestId("composer-send").click();
    await window.getByTestId("interaction-panel").waitFor({ timeout: 15000 });
    await window.getByTestId("project-new-session").click();
    await window.getByTestId("workspace-sharing-warning").waitFor();
    assert(
      (
        await window.getByTestId("workspace-sharing-warning").textContent()
      ).includes("共享文件"),
      "同目录独立会话不遗漏"
    );
    await window.getByTestId("draft-workspace-mode").selectOption("worktree");
    await window
      .getByTestId("workspace-sharing-warning")
      .waitFor({ state: "hidden" });
    await window.getByTestId("draft-workspace-mode").selectOption("local");
    await window.getByTestId("workspace-sharing-warning").waitFor();
    await window.getByTestId("composer-input").fill("允许继续并行");
    await window.getByTestId("composer-send").click();
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "任务已完成" })
      .waitFor();
    assert(
      (await window.getByTestId("session-item").count()) === 3,
      "共享提示不锁死项目并行"
    );
    await window
      .getByTestId("session-item")
      .filter({ hasText: "共享等待" })
      .click();
    await window.getByTestId("composer-stop").click();
    await window.getByTestId("composer-send").waitFor();

    await closeApp(app);
    app = null;
    ({ app, window } = await launchApp({ homeDir, workspaceDir: plain }));
    await window
      .getByTestId("session-item")
      .filter({ hasText: "隔离写入" })
      .click();
    assert(
      (await window.getByTestId("workspace-path").textContent()).includes(
        worktreePath
      ),
      "重开仍使用原副本"
    );
    await window.getByTestId("add-project").click();
    await window
      .getByTestId("project-group")
      .filter({ hasText: "plain" })
      .locator("..")
      .getByTestId("project-new-session")
      .click();
    await window.getByTestId("draft-workspace-mode").selectOption("worktree");
    await window.getByTestId("composer-input").fill("非 Git 失败重试");
    await window.getByTestId("composer-send").click();
    await window.getByTestId("draft-error").waitFor();
    assert(
      (await window.getByTestId("draft-error").textContent()).includes(
        "不是 git 仓库"
      ),
      "非Git错误清晰"
    );
    assert(
      (await window.getByTestId("composer-input").inputValue()) ===
        "非 Git 失败重试",
      "失败保留草稿"
    );
    assert(
      (await window.getByTestId("session-item").count()) === 3,
      "失败无空会话"
    );
    await window.getByTestId("draft-workspace-mode").selectOption("local");
    await window.getByTestId("composer-send").click();
    await window.getByTestId("message-assistant").waitFor();
    assert(
      (await window.getByTestId("session-item").count()) === 4,
      "非Git本地模式可重试"
    );
    assert(
      readFileSync(join(worktreePath, "wt-e2e.txt"), "utf8") === "隔离成果",
      "重启与新建不清理旧成果"
    );
    await closeApp(app);
    app = null;
    console.log("[e2e] Worktree 首次发送、共享目录、失败重试与进程重开通过");
  } catch (error) {
    console.error("[e2e] Worktree 验收失败", error);
    process.exitCode = 1;
  } finally {
    if (app) await closeApp(app);
    model.server.close();
    rmSync(root, { recursive: true, force: true });
  }
}
await main();
