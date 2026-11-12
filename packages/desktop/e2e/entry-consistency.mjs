// 票09：真实入口与跨票组合，不以静态 markup 替代用户操作。
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
import {
  selectComposerOption,
  assert,
  closeApp,
  launchApp,
  projectAction,
  sessionMenu,
  startMockProvider,
} from "./helpers.mjs";

const root = mkdtempSync(join(tmpdir(), "codexlike-entry-consistency-"));
const homeDir = join(root, "home");
const workspaceDir = join(root, "来源项目");
mkdirSync(workspaceDir);
const git = (...args) =>
  execFileSync("git", ["-C", workspaceDir, ...args], { encoding: "utf8" });
git("init", "-b", "main");
git("config", "user.email", "e2e@codexlike.local");
git("config", "user.name", "E2E");
writeFileSync(join(workspaceDir, "keep.txt"), "保留来源文件");
git("add", "keep.txt");
git("commit", "-m", "fixture");
const model = await startMockProvider((ctx) => ctx.textRound("组合验收回复"));
let app;
let window;
const input = () => window.getByTestId("composer-input");
const item = (title) =>
  window.getByTestId("session-item").filter({ hasText: title });
async function send(text) {
  await input().fill(text);
  await window.getByTestId("composer-send").click();
  await window.getByTestId("message-assistant").waitFor();
  await window.getByTestId("composer-send").waitFor();
}
async function command(text) {
  await input().fill(text);
  await input().press("Enter");
}
try {
  ({ app, window } = await launchApp({ homeDir, workspaceDir }));
  await window.getByTestId("new-session").waitFor();
  assert(
    (await window.getByTestId("new-session").textContent()).includes("独立"),
    "全局入口文案必须明确独立会话，不能与项目新建混淆"
  );
  await window.getByTestId("settings-open").click();
  const profiles = window.locator("section").filter({
    has: window.getByRole("heading", {
      name: "Provider Profiles",
      exact: true,
    }),
  });
  await window.getByTestId("profile-create").click();
  const form = window.locator("form");
  await form.getByLabel("名称", { exact: true }).fill("Entry Mock");
  await form
    .getByLabel("baseURL", { exact: true })
    .fill(`http://127.0.0.1:${model.port}/v1`);
  await form.getByLabel("API Key", { exact: true }).fill("test");
  await form.getByLabel("模型", { exact: true }).fill("mock-model");
  await form.getByRole("button", { name: /保存|创建/ }).click();
  await profiles.getByText("Entry Mock", { exact: true }).waitFor();
  await window.getByTestId("settings-back").click();
  await window.getByTestId("add-project").click();
  await projectAction(window);
  await command("/new");
  await window.getByTestId("draft-workspace-mode").waitFor();
  assert(
    (await window.getByTestId("session-item").count()) === 0,
    "项目草稿 /new 不产生空记录"
  );
  await window.getByTestId("draft-workspace-mode").selectOption("worktree");
  await send("入口隔离任务");
  const originalPath = await window.getByTestId("workspace-path").textContent();
  await projectAction(window);
  await window.getByTestId("draft-workspace-mode").waitFor();
  assert(
    (await window.getByTestId("draft-workspace-mode").inputValue()) === "local",
    "侧栏项目新建使用项目草稿默认本地"
  );
  assert(
    (await window.getByTestId("workspace-path").textContent()).includes(
      workspaceDir
    ),
    "侧栏项目新建沿用项目而非 Worktree 副本"
  );
  assert(
    (await window.getByTestId("session-item").count()) === 1,
    "侧栏入口不产生空记录"
  );
  await item("入口隔离任务").click();
  assert(
    (await window.getByTestId("workspace-path").textContent()) === originalPath,
    "新建不改变原执行目录"
  );
  console.log("[e2e] 会话侧栏入口与项目草稿保持显式归属通过");
  await window.getByTestId("session-search-toggle").click();
  await window.getByTestId("session-search-input").fill("入口隔离任务");
  await window.getByTestId("session-search-result").waitFor();
  const longTitle = "重命名后仍可搜索的长标题".repeat(12);
  await (
    await sessionMenu(window, item("入口隔离任务"))
  )
    .getByTestId("rename-button")
    .click();
  await window.getByTestId("rename-input").fill(longTitle);
  await window.getByTestId("rename-input").press("Enter");
  await item(longTitle).waitFor();
  await window
    .getByTestId("session-search-result")
    .filter({ hasText: longTitle })
    .waitFor({ timeout: 5000 });
  assert(
    (await window.getByTestId("session-search-result").count()) === 1,
    "重命名后正文搜索结果实时更新标题"
  );
  console.log("[e2e] 搜索展开期间重命名同步通过");
  await (
    await sessionMenu(
      window,
      window
        .getByTestId("session-item")
        .and(window.locator('[aria-current="page"]'))
    )
  )
    .getByTestId("archive-button")
    .click();
  await window
    .getByTestId("session-search-result")
    .waitFor({ state: "detached", timeout: 5000 });
  await window.getByTestId("session-search-archived").check();
  await window
    .getByTestId("session-search-result")
    .filter({ hasText: "已归档" })
    .waitFor();
  await window.getByTestId("session-search-result").click();
  assert(
    await window.getByTestId("composer-send").isDisabled(),
    "归档搜索只能查看历史"
  );
  await window.getByTestId("session-search-toggle").click();
  await (
    await sessionMenu(
      window,
      window
        .getByTestId("archived-session-item")
        .and(window.locator('[aria-current="page"]'))
    )
  )
    .getByTestId("unarchive-button")
    .click();
  await window
    .getByTestId("session-search-result")
    .filter({ hasNotText: "已归档" })
    .waitFor({ timeout: 5000 });
  console.log("[e2e] 搜索展开期间归档与恢复同步通过");
  await (
    await sessionMenu(
      window,
      window
        .getByTestId("session-item")
        .and(window.locator('[aria-current="page"]'))
    )
  )
    .getByTestId("session-membership")
    .click();
  await window.getByTestId("membership-confirm").click();
  await window
    .getByTestId("session-search-result")
    .filter({ hasText: "独立会话" })
    .waitFor();
  await window.getByTestId("session-search-toggle").click();
  await selectComposerOption(window, "thinking-effort-select", "high");
  await selectComposerOption(window, "approval-mode-select", "full-access");
  await window.getByTestId("full-access-confirm-ok").click();
  await command("/new");
  await window.getByTestId("draft-select-workspace").waitFor();
  assert(
    (await window.getByTestId("draft-workspace-mode").count()) === 0,
    "移出后 /new 不从 Worktree 来源派生项目"
  );
  assert(
    (await window
      .getByTestId("approval-mode-select")
      .getAttribute("data-value")) === "ask",
    "独立新建不继承完全访问"
  );
  await input().fill("独立入口保留草稿");
  await projectAction(window);
  await input().fill("项目入口保留草稿");
  await item(longTitle).click();
  await window.getByTestId("new-session").click();
  await window.getByTestId("draft-select-workspace").waitFor();
  assert(
    (await input().inputValue()) === "独立入口保留草稿",
    "移出后侧栏入口恢复独立草稿而非项目草稿"
  );
  await item(longTitle).click();
  await command("/archive");
  await item(longTitle).waitFor({ state: "detached" });
  assert(
    (await input().inputValue()) === "独立入口保留草稿",
    "最后会话归档后回到独立草稿"
  );
  const requestsBeforeRestart = model.requestCount();
  await closeApp(app);
  app = null;
  ({ app, window } = await launchApp({ homeDir, workspaceDir }));
  await window.getByTestId("new-session").click();
  await window.getByTestId("draft-select-workspace").waitFor();
  assert(
    (await input().inputValue()) === "独立入口保留草稿",
    "重启独立新建草稿完整"
  );
  await projectAction(window);
  await window.getByTestId("draft-workspace-mode").waitFor();
  assert(
    (await input().inputValue()) === "项目入口保留草稿",
    "重启项目新建草稿完整且不串用"
  );
  await window.getByTestId("session-search-toggle").click();
  await window.getByTestId("session-search-input").fill("入口隔离任务");
  await window
    .getByTestId("session-search-status")
    .filter({ hasText: "没有匹配" })
    .waitFor();
  await window.getByTestId("session-search-archived").check();
  await window
    .getByTestId("session-search-result")
    .filter({ hasText: "独立会话" })
    .click();
  await window
    .getByTestId("archived-session-item")
    .filter({ hasText: longTitle })
    .waitFor();
  assert(
    (await window.getByTestId("workspace-path").textContent()) === originalPath,
    "移出及重开不改实际工作区"
  );
  assert(
    (await window.getByTestId("workspace-origin").textContent()).includes(
      workspaceDir
    ),
    "重开仍保留来源"
  );
  assert(
    (await window
      .getByTestId("approval-mode-select")
      .getAttribute("data-value")) === "full-access",
    "恢复的是该会话明确授权偏好"
  );
  assert(
    (await window
      .getByTestId("thinking-effort-select")
      .getAttribute("data-value")) === "high",
    "会话思考偏好不串用"
  );
  assert(
    model.requestCount() === requestsBeforeRestart,
    "重启归档记录不能自动执行模型"
  );
  await (
    await sessionMenu(
      window,
      window
        .getByTestId("archived-session-item")
        .and(window.locator('[aria-current="page"]'))
    )
  )
    .getByTestId("unarchive-button")
    .click();
  await item(longTitle).waitFor();
  await (
    await sessionMenu(
      window,
      window
        .getByTestId("session-item")
        .and(window.locator('[aria-current="page"]'))
    )
  )
    .getByTestId("session-membership")
    .click();
  await window
    .getByTestId("membership-target")
    .selectOption({ label: "来源项目" });
  await window.getByTestId("membership-confirm").click();
  await window
    .getByTestId("project-header")
    .locator("..")
    .getByTestId("session-item")
    .filter({ hasText: longTitle })
    .waitFor();
  await command("/new");
  await window.getByTestId("draft-workspace-mode").waitFor();
  assert(
    (await input().inputValue()) === "项目入口保留草稿",
    "移回后 /new 按当前项目恢复草稿"
  );
  await item(longTitle).click();
  await (
    await sessionMenu(
      window,
      window
        .getByTestId("session-item")
        .and(window.locator('[aria-current="page"]'))
    )
  )
    .getByTestId("session-membership")
    .click();
  await window.getByTestId("membership-confirm").click();
  await window
    .getByTestId("standalone-header")
    .locator("..")
    .getByTestId("session-item")
    .waitFor();
  await projectAction(window);
  await send("待移除项目成员");
  await window.getByTestId("session-search-toggle").click();
  await window.getByTestId("session-search-input").fill("待移除项目成员");
  await window.getByTestId("session-search-result").waitFor();
  await projectAction(window, "project-remove");
  await window.getByTestId("project-removal-confirm").click();
  await window.getByTestId("project-group").waitFor({ state: "detached" });
  await window
    .getByTestId("session-search-result")
    .waitFor({ state: "detached" });
  await window.getByTestId("session-search-toggle").click();
  await item(longTitle).waitFor();
  await (
    await sessionMenu(window, item(longTitle))
  )
    .getByTestId("session-membership")
    .filter({ hasText: "移入项目" })
    .waitFor();
  await window.keyboard.press("Escape");
  assert(
    (await window.getByTestId("workspace-path").textContent()) === originalPath,
    "当前成员被移除后安全导航到幸存独立记录"
  );
  assert(
    readFileSync(join(workspaceDir, "keep.txt"), "utf8") === "保留来源文件",
    "移除来源项目不删除来源文件"
  );
  const worktree = originalPath.replace("工作区：", "").trim();
  assert(
    existsSync(join(worktree, ".git")) &&
      existsSync(join(worktree, "keep.txt")),
    "移除来源项目保留独立 Worktree 成果"
  );
  const geometry = await item(longTitle).evaluate((node) => ({
    right: node.getBoundingClientRect().right,
    viewport: innerWidth,
  }));
  assert(geometry.right <= geometry.viewport, "长标题不能挤出侧栏页面");
  console.log(
    "[e2e] Worktree 移出/搜索/归档/重启/移回/来源移除及草稿设置隔离通过"
  );
} finally {
  if (app) await closeApp(app);
  model.server.closeAllConnections();
  await new Promise((resolve) => model.server.close(resolve));
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
