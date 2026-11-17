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
import {
  selectComposerOption,
  assert,
  closeApp,
  launchApp,
  projectAction,
  startMockProvider,
  workspaceBadgeInfo,
} from "./helpers.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}
async function main() {
  const root = mkdtempSync(join(tmpdir(), "codexlike-e2e-worktree-"));
  const screenshots = mkdtempSync(
    join(tmpdir(), "codexlike-worktree-screenshots-")
  );
  console.log(`[e2e:worktree] 布局截图目录 ${screenshots}`);
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
    await form.getByLabel("模型 1").fill("mock-model");
    await form.getByRole("button", { name: /保存|创建/ }).click();
    await window.getByText("Worktree Mock", { exact: true }).waitFor();
    await window.getByTestId("settings-back").click();
    await window.getByTestId("add-project").click();
    await projectAction(window);
    const draftInfo = window.getByTestId("draft-workspace-info");
    const workspacePath = draftInfo.getByTestId("workspace-path");
    const draftMode = draftInfo.getByTestId("draft-workspace-mode");
    await draftMode.waitFor({ timeout: 5000 });
    await workspacePath.waitFor();
    const pathBox = await workspacePath.boundingBox();
    const composerBox = await window.getByTestId("composer-card").boundingBox();
    // 83219f0「输入卡与消息列同宽」定稿：composer-card 去 -mx-2 外扩，与
    // 内容列左右缘完全对齐（width-tiers 断言同款 ±1px 亚像素容差）。
    assert(
      pathBox !== null &&
        composerBox !== null &&
        Math.abs(pathBox.x - composerBox.x) <= 1 &&
        Math.abs(composerBox.width - pathBox.width) <= 1,
      "顶部工作区路径与内容列对齐，输入卡与内容列左右缘一致"
    );
    assert(
      (await window.getByTestId("workspace-sharing-notice").count()) === 0,
      "无风险项目草稿不渲染共享提示 toast"
    );
    assert(
      (await window.getByTestId("draft-workspace-mode").inputValue()) ===
        "local",
      "项目草稿默认本地"
    );
    await window.screenshot({ path: join(screenshots, "project-draft.png") });
    await draftMode.selectOption("worktree");
    await window.getByTestId("composer-input").fill("隔离写入");
    assert(!existsSync(join(homeDir, "worktrees")), "首次发送前不得创建副本");
    assert(
      git(repo, "branch", "--list", "feature/*").trim() === "",
      "首次发送前不得创建分支"
    );
    assert(
      (await window.getByTestId("task-item").count()) === 0,
      "首次发送前无任务"
    );
    assert(
      (await window.getByTestId("new-task-dialog").count()) === 0,
      "不恢复模式弹窗"
    );
    await selectComposerOption(window, "approval-mode-select", "assist");
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
        `feature/${ids[0]}`,
      "终端命令也在隔离分支执行"
    );
    assert(
      !existsSync(join(repo, "terminal-branch.txt")),
      "终端不得写入来源目录"
    );
    assert(
      git(worktreePath, "branch", "--show-current").trim() ===
        `feature/${ids[0]}`,
      "独立分支"
    );
    // 正式任务的路径/模式收进标题栏徽章（票01）：弹层读完整工作区
    const badge = await workspaceBadgeInfo(window);
    assert(badge.path.includes(worktreePath), "显示实际工作区");
    const fixedMode = window
      .getByTestId("workspace-badge")
      .getByTestId("workspace-mode");
    assert(
      (await fixedMode.textContent()).includes("Worktree"),
      "正式任务模式标签位于标题栏徽章内"
    );
    const modeTitle = (await fixedMode.getAttribute("title")) ?? "";
    assert(
      modeTitle.includes("首次执行后工作区固定") &&
        /(?:非|不是|不代表|并非)(?:文件)?只读/.test(modeTitle),
      "固定模式标签解释首次执行后工作区固定且并非只读"
    );
    assert(
      (await window.getByTestId("draft-workspace-mode").count()) === 0,
      "首次执行后模式固定"
    );
    assert(
      (await window.getByTestId("workspace-sharing-notice").count()) === 0,
      "无风险正式任务不渲染共享提示 toast"
    );
    await window.screenshot({
      path: join(screenshots, "existing-task.png"),
    });

    await window.getByTestId("new-task").click();
    await window.getByTestId("new-standalone-task-item").click();
    await window.getByTestId("draft-select-workspace").waitFor();
    assert(
      (await window.getByTestId("draft-workspace-mode").count()) === 0,
      "独立入口不直接提供 Worktree"
    );
    assert(
      (await window.getByTestId("workspace-mode").count()) === 0,
      "独立草稿不显示已固定模式标签"
    );

    // 只让真实 IPC 检查失败一次；同一正式任务再次发送，靠事件订阅刷新恢复。
    // 不切换 target、不重挂组件、不新增任务，避免掩盖 effect 订阅回归。
    await app.evaluate(({ ipcMain }) => {
      const channel = "tasks:workspace-sharing";
      const original = ipcMain._invokeHandlers.get(channel);
      if (!original) throw new Error("未注册工作区共享检查 IPC");
      globalThis.worktreeSharingOriginal = original;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (event, target) => {
        if (!target?.taskId) return original(event, target);
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, original);
        throw new Error("E2E 工作区检查故障");
      });
    });
    try {
      await window
        .getByTestId("task-item")
        .filter({ hasText: "隔离写入" })
        .click();
      const sharingError = window
        .getByTestId("workspace-sharing-notice")
        .getByTestId("workspace-sharing-error");
      await sharingError.waitFor();
      const errorText = await sharingError.textContent();
      assert(
        errorText.includes("工作区检查失败") &&
          errorText.includes("E2E 工作区检查故障"),
        "共享检查失败显示真实 IPC 错误而非静默隐藏"
      );
      assert(
        (await window.getByTestId("workspace-sharing-warning").count()) === 0,
        "检查失败不误报共享文件风险"
      );
      await window.getByTestId("composer-input").fill("检查刷新恢复");
      await window.getByTestId("composer-send").click();
      await window
        .getByTestId("message-assistant")
        .filter({ hasText: "任务已完成" })
        .nth(1)
        .waitFor({ timeout: 15000 });
      await window.getByTestId("composer-send").waitFor();
      await window
        .getByTestId("workspace-sharing-notice")
        .waitFor({ state: "detached" });
      assert(
        (await window.getByTestId("task-item").count()) === 1,
        "真实发送触发刷新清除检查错误，且不额外创建任务"
      );
    } finally {
      await app.evaluate(({ ipcMain }) => {
        const channel = "tasks:workspace-sharing";
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, globalThis.worktreeSharingOriginal);
        delete globalThis.worktreeSharingOriginal;
      });
    }

    // 独立入口使用同项目目录且等待问答，项目草稿必须出现共享风险提示。
    await window.getByTestId("new-task").click();
    await window.getByTestId("new-standalone-task-item").click();
    await window.getByTestId("draft-select-workspace").click();
    await window.getByTestId("composer-input").fill("共享等待");
    await window.getByTestId("composer-send").click();
    await window.getByTestId("interaction-panel").waitFor({ timeout: 15000 });
    await projectAction(window);
    const sharingWarning = window
      .getByTestId("workspace-sharing-notice")
      .getByTestId("workspace-sharing-warning");
    await sharingWarning.waitFor();
    assert(
      (await sharingWarning.textContent()).includes("共享文件"),
      "同目录独立任务不遗漏，风险以共享提示 toast 常驻右下角"
    );
    assert(
      (await draftInfo.getByTestId("workspace-sharing-notice").count()) === 0,
      "草稿收纳行不包含底部风险提示"
    );
    await window.screenshot({ path: join(screenshots, "sharing-warning.png") });
    await draftMode.selectOption("worktree");
    await window
      .getByTestId("workspace-sharing-notice")
      .waitFor({ state: "detached" });
    assert(
      (await window.getByTestId("workspace-sharing-warning").count()) === 0,
      "切换 Worktree 后风险提示随状态撤除，toast 一起消失"
    );
    await draftMode.selectOption("local");
    await window.getByTestId("workspace-sharing-warning").waitFor();
    await window.getByTestId("composer-input").fill("允许继续并行");
    await window.getByTestId("composer-send").click();
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "任务已完成" })
      .waitFor();
    assert(
      (await window.getByTestId("task-item").count()) === 3,
      "共享提示不锁死项目并行"
    );
    await window
      .getByTestId("task-item")
      .filter({ hasText: "共享等待" })
      .click();
    await window.getByTestId("composer-stop").click();
    await window.getByTestId("composer-send").waitFor();

    await closeApp(app);
    app = null;
    ({ app, window } = await launchApp({ homeDir, workspaceDir: plain }));
    await window
      .getByTestId("task-item")
      .filter({ hasText: "隔离写入" })
      .click();
    const reopened = await workspaceBadgeInfo(window);
    assert(reopened.path.includes(worktreePath), "重开仍使用原副本");
    await window.getByTestId("add-project").click();
    await projectAction(
      window,
      "project-new-task",
      window.getByTestId("project-header").filter({ hasText: "plain" })
    );
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
      (await window.getByTestId("task-item").count()) === 3,
      "失败无空任务"
    );
    await window.getByTestId("draft-workspace-mode").selectOption("local");
    await window.getByTestId("composer-send").click();
    await window.getByTestId("message-assistant").waitFor();
    assert(
      (await window.getByTestId("task-item").count()) === 4,
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
