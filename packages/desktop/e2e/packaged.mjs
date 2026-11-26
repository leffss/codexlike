// 打包冷启动冒烟（retro 2026-11-11）：dist 产物在「数据目录不存在」的干净机器
// 状态下启动。当日事故：createSqliteSessionStore 不建父目录，~/.codexlike 缺失时
// whenReady 断链无窗口；而 11 条 E2E 均以 mkdtempSync 预建 CODEXLIKE_HOME，
// 恰好掩盖该分支。本脚本刻意指向一个不创建的嵌套目录，断言窗口出现且目录自建。
// 票05：冷启动断言随 ui-redesign 新布局重基线——标题栏任务上下文（草稿回退
// 品牌展示）、workspace-info 常驻行取消（草稿就地收纳）、提示条 toast 化
// （内存态冷启动无残留）、面板 overlay 抽屉（草稿关闭态）。
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { DESKTOP_DIR } from "./launch-target.mjs";
import { assert, closeApp, launchApp } from "./helpers.mjs";

// 打包产物优先取 CODEXLIKE_PACKAGED_EXE（launchTarget 同名机制），缺省指向
// 本包 release 产物；写回 process.env 让 launchTarget 的打包分支生效。
const exe =
  process.env.CODEXLIKE_PACKAGED_EXE ??
  join(DESKTOP_DIR, "release", "win-unpacked", "CodexLike.exe");
process.env.CODEXLIKE_PACKAGED_EXE = exe;
assert(existsSync(exe), `打包产物不存在：${exe}（先 pnpm dist）`);

// 刻意不创建的嵌套数据目录（rmSync 清理用根层）
const homeRoot = join(tmpdir(), `codexlike-packaged-${Date.now()}`);
const homeDir = join(homeRoot, "nested", "deeper");

const { app, window } = await launchApp({
  homeDir,
  // Electron 缓存与业务库分离，不能由测试隔离提前建好缺失的业务父目录。
  env: { CODEXLIKE_TEST_USER_DATA: join(homeRoot, "electron-user-data") },
});
try {
  // firstWindow 已隐含「窗口创建」断言（无窗口则超时抛错）；标题再显式确认
  assert((await window.title()).length > 0, "窗口标题为空（窗口未真正创建）");
  assert(existsSync(homeDir), "数据目录未自动创建（打包冷启动黑屏回归）");
  assert(existsSync(join(homeDir, "task-workbench.db")), "SQLite 库文件未落盘");
  // 窗口标题/数据库存在不等于 React 页面加载成功；通过真实 preload 与新建页确认。
  await window.getByTestId("add-project").waitFor();
  // 票01（spec 用户故事 10）：无 Provider Profile 时新建页整体为配置引导卡
  // （品牌语 + 一键去设置），不渲染残缺表单——顶栏单按钮单击直达（票03）。
  await window.getByTestId("new-task").click();
  await window.getByTestId("draft-empty-start").waitFor();
  await window.getByTestId("draft-goto-settings").waitFor();
  assert(
    (await window.getByTestId("draft-workspace-info").count()) === 0 &&
      (await window.getByTestId("composer-input").count()) === 0,
    "无 Profile 冷启动不得渲染残缺表单（应整体为引导卡）"
  );

  // 桌面双卡（A）：工作台无独立标题栏，消息卡首行常驻任务标题（草稿态为
  // 「新建任务」）+ 目录；任务搜索迁入任务列表头部（冷启动即可用）。
  const topbar = window.getByTestId("workspace-topbar");
  await topbar.getByText("新建任务", { exact: true }).waitFor();
  assert(
    (await topbar.getByTestId("task-title").count()) === 1 &&
      (await topbar.getByTestId("task-title").textContent()) === "新建任务",
    "草稿态消息卡首行应显示「新建任务」（标题栏退役后由首行承载任务标题）"
  );
  assert(
    (await window.getByTestId("task-search-toggle").count()) === 1,
    "任务搜索应在任务列表头部（ADR 0018 自标题栏迁位）"
  );
  assert(
    (await topbar.getByTestId("task-search-toggle").count()) === 0,
    "任务搜索不得留在消息卡首行（ADR 0018 已迁任务列表头部）"
  );

  // 票02 提示条 toast 化：toast 为渲染层内存态，冷启动无任何提示残留；
  // 右下角 toast 区域仅在确有提示时渲染。
  assert(
    (await window.getByTestId("toast-region").count()) === 0,
    "冷启动不得有 toast 残留（提示条须为内存态）"
  );

  // ADR 0018 检视右栏：冷启动草稿（未选工作区）开关禁用（无面板入口），
  // 右栏默认关闭不渲染（tab 头不出现）。
  assert(
    await window.getByTestId("resources-toggle").isDisabled(),
    "冷启动草稿态右栏开关应为禁用（无面板入口）"
  );
  assert(
    (await window.getByTestId("rail-panel").count()) === 0,
    "右栏默认关闭，不得渲染面板节点"
  );
  assert(
    (await window.getByTestId("rail-tab-resources").count()) === 0 &&
      (await window.getByTestId("rail-tab-changes").count()) === 0,
    "右栏关闭态不得渲染 tab 头"
  );

  assert(
    (await window.getByTestId("task-item").count()) === 0,
    "冷启动新建不能产生空历史"
  );
  assert(!existsSync(join(homeDir, "tasks")), "未发送不得创建专用工作区");
  assert(!existsSync(join(homeDir, "codexlike.db")), "新应用不能创建旧库");

  // 表单态（原草稿界面断言）：经真实 UI 建 Profile（不发消息，baseURL 无需
  // 可用）后再次进入新建页——工作区卡/决策行就位，完整路径只出现在工作区
  // 卡（票01：常驻 workspace-info 行取消，正式任务的路径收进标题栏徽章）。
  await window.getByTestId("settings-open").click();
  await window.getByTestId("profile-create").click();
  const form = window.locator("form");
  await form.getByLabel("名称").fill("Packaged Mock");
  await form.getByLabel("baseURL").fill("http://127.0.0.1:9/v1");
  await form.getByLabel("API Key").fill("test");
  await form.getByLabel("模型 1").fill("mock-model");
  await form.getByRole("button", { name: /保存|创建/ }).click();
  await window.getByText("Packaged Mock", { exact: true }).waitFor();
  await window.getByTestId("settings-back").click();
  await window.getByTestId("new-task").click();
  const draftInfo = window.getByTestId("draft-workspace-info");
  await draftInfo.waitFor();
  assert(
    (await window.getByTestId("workspace-path").count()) === 1,
    "workspace-path 应只存在于新建页工作区卡（常驻 workspace-info 行须保持取消）"
  );
  assert(
    (await draftInfo.getByTestId("workspace-path").textContent()).includes(
      "专用持久目录"
    ),
    "产物独立草稿未显示默认工作区"
  );
  assert(
    (await window
      .getByTestId("approval-mode-select")
      .getAttribute("data-value")) === "ask",
    "产物新任务默认必须为 ask"
  );
  console.log(
    "[packaged] 冷启动冒烟通过：父目录自建、新库落盘、真实侧栏、无 Profile 引导卡与建后表单态/权限默认正常；桌面双卡布局断言（消息卡首行任务标题位/无常驻 workspace-info/toast 内存态/右栏默认关闭）全过"
  );
} finally {
  await closeApp(app);
  rmSync(homeRoot, { recursive: true, force: true });
}
