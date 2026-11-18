// 工作区打开器（GLOSSARY）：标题栏分裂按钮全链路——草稿态可用、候选
// 列表（E2E 钩子全量）、点选即打开并记默认、主按钮用默认、重启后默认保留。
// 启动经 CODEXLIKE_TEST_OPENER_LOG 注入假启动：open 只记录 JSON 行，不拉起
// 真实程序（先例 task-ipc / file-ipc 的测试钩子）。
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, closeApp, launchApp, projectAction } from "./helpers.mjs";

const OPENER_IDS = [
  "explorer",
  "terminal",
  "vscode",
  "pycharm",
  "intellij",
  "webstorm",
];

function readLog(logFile) {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/** 轮询日志行数到位（appendFileSync 在 invoke 返回前落盘，轮询兜底渲染时序） */
async function untilLogLines(logFile, count) {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (readLog(logFile).length >= count) return;
    assert(Date.now() < deadline, `打开记录未达到 ${count} 行`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function openMenu(window) {
  await window.getByTestId("workspace-opener-toggle").click();
  const menu = window.getByTestId("workspace-opener-menu");
  await menu.waitFor();
  return menu;
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "codexlike-e2e-opener-"));
  const homeDir = join(root, "home");
  const workspaceDir = join(homeDir, "workspace");
  const logFile = join(root, "openings.log");
  // opener IPC 校验目录真实存在；CODEXLIKE_TEST_WORKSPACE 缺省指向该目录
  mkdirSync(workspaceDir, { recursive: true });
  let app;
  try {
    console.log(`[e2e:workspace-opener] home=${homeDir} log=${logFile}`);
    let window;
    ({ app, window } = await launchApp({
      homeDir,
      env: { CODEXLIKE_TEST_OPENER_LOG: logFile },
    }));

    // 新建任务页无 Profile 时整页为引导卡（票 04 / ADR 0026），工作区卡与
    // 归属选择器不渲染——先建一个 Profile 再进入草稿（本场景不发模型请求，
    // baseURL 不需要可达）。
    await window.getByTestId("settings-open").click();
    await window.getByTestId("profile-create").click();
    const profileForm = window.locator("form");
    await profileForm.getByLabel("名称").fill("Opener");
    await profileForm.getByLabel("baseURL").fill("http://127.0.0.1:9/v1");
    await profileForm.getByLabel("API Key").fill("sk-e2e");
    await profileForm.getByLabel("模型 1").fill("opener-model");
    await window
      .locator("form")
      .getByRole("button", { name: /保存|创建/ })
      .click();
    await window.getByText("Opener").first().waitFor();
    await window.getByTestId("settings-back").click();

    // 建项目并进入项目草稿：标题栏打开器随草稿工作区可用
    await window.getByTestId("add-project").click();
    await projectAction(window);
    const draftInfo = window.getByTestId("draft-workspace-info");
    await draftInfo.getByTestId("draft-workspace-mode").waitFor({
      timeout: 5000,
    });
    const main = window.getByTestId("workspace-opener-main");
    const toggle = window.getByTestId("workspace-opener-toggle");
    assert(!(await main.isDisabled()), "草稿有工作区：主按钮应可用");
    assert(!(await toggle.isDisabled()), "草稿有工作区：下拉应可用");
    // 挂载预取默认：主按钮图标初始为资源管理器（图标定位器与菜单项共用，
    // 须限定在主按钮容器内查询）
    await main.getByTestId("workspace-opener-icon-explorer").waitFor();

    // 展开下拉：E2E 钩子下五项全量可用，默认 explorer 带 ✓
    let menu = await openMenu(window);
    for (const id of OPENER_IDS) {
      await menu.getByTestId(`workspace-opener-option-${id}`).waitFor();
    }
    assert(
      (await menu.getByTestId("workspace-opener-check-explorer").count()) === 1,
      "初始默认应为资源管理器"
    );
    assert(
      (await menu.getByTestId("workspace-opener-check-pycharm").count()) === 0,
      "PyCharm 初始不应是默认"
    );

    // 点选 PyCharm：记录一行（该程序 + 草稿工作区），菜单收起、主按钮图标切换
    await menu.getByTestId("workspace-opener-option-pycharm").click();
    await menu.waitFor({ state: "hidden" });
    assert(
      JSON.stringify(readLog(logFile)) ===
        JSON.stringify([{ openerId: "pycharm", workspacePath: workspaceDir }]),
      "点选应记录一次 PyCharm 打开草稿工作区"
    );
    // 用户定稿：主按钮图标跟随当前默认，点选后即切到 PyCharm
    await main.getByTestId("workspace-opener-icon-pycharm").waitFor();

    // 再展开：✓ 已迁到 PyCharm；主按钮按新默认记录
    menu = await openMenu(window);
    assert(
      (await menu.getByTestId("workspace-opener-check-pycharm").count()) === 1,
      "点选后默认应迁到 PyCharm"
    );
    assert(
      (await menu.getByTestId("workspace-opener-check-explorer").count()) === 0,
      "资源管理器应不再带 ✓"
    );
    await window.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    await main.click();
    await untilLogLines(logFile, 2);
    const afterMain = readLog(logFile);
    assert(
      afterMain.every((entry) => entry.openerId === "pycharm"),
      `主按钮应沿用默认 PyCharm，实际：${JSON.stringify(afterMain)}`
    );
    assert(afterMain.length === 2, "主按钮再记一行，共两行");

    // 重启（同一 CODEXLIKE_HOME）：默认 PyCharm 持久保留
    await closeApp(app);
    ({ app, window } = await launchApp({
      homeDir,
      env: { CODEXLIKE_TEST_OPENER_LOG: logFile },
    }));
    await window.getByTestId("project-header").waitFor({ timeout: 5000 });
    await projectAction(window);
    await window.getByTestId("draft-workspace-info").waitFor({
      timeout: 5000,
    });
    // 全局单一默认（用户定稿）：重启后主按钮图标仍为上次点选的 PyCharm
    await window
      .getByTestId("workspace-opener-main")
      .getByTestId("workspace-opener-icon-pycharm")
      .waitFor();
    menu = await openMenu(window);
    assert(
      (await menu.getByTestId("workspace-opener-check-pycharm").count()) === 1,
      "重启后默认应仍为 PyCharm（持久化）"
    );
    await window.keyboard.press("Escape");

    console.log(
      "[e2e:workspace-opener] 通过：候选/点选记默认/主按钮默认/重启保留"
    );
  } finally {
    await closeApp(app);
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
