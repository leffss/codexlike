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

const { app, window } = await launchApp({ homeDir });
try {
  // firstWindow 已隐含「窗口创建」断言（无窗口则超时抛错）；标题再显式确认
  assert((await window.title()).length > 0, "窗口标题为空（窗口未真正创建）");
  assert(existsSync(homeDir), "数据目录未自动创建（打包冷启动黑屏回归）");
  assert(existsSync(join(homeDir, "task-workbench.db")), "SQLite 库文件未落盘");
  // 窗口标题/数据库存在不等于 React 页面加载成功；通过真实 preload 与草稿界面确认。
  await window.getByTestId("add-project").waitFor();
  await window.getByTestId("new-task").click();
  await window.getByTestId("draft-select-workspace").waitFor();

  // 票01 标题栏任务上下文：草稿无任务回退品牌展示（任务名/徽章不渲染），
  // 任务搜索随票01 迁入标题栏（冷启动即可用）。
  const titlebar = window.getByTestId("window-titlebar");
  await titlebar
    .getByText("本地 AI coding agent 工作台", { exact: true })
    .waitFor();
  assert(
    (await window.getByTestId("task-title").count()) === 0,
    "草稿态标题栏不得渲染任务名（应回退品牌展示）"
  );
  assert(
    (await window.getByTestId("workspace-badge").count()) === 0,
    "草稿态标题栏不得渲染工作区徽章"
  );
  assert(
    (await titlebar.getByTestId("task-search-toggle").count()) === 1,
    "任务搜索未迁入标题栏"
  );

  // 票01 workspace-info 常驻行取消：完整路径只出现在草稿就地收纳行
  // （正式任务的路径收进标题栏徽章，冷启动无任务态可对照负断言唯一性）。
  const draftInfo = window.getByTestId("draft-workspace-info");
  await draftInfo.waitFor();
  assert(
    (await window.getByTestId("workspace-path").count()) === 1,
    "workspace-path 应只存在于草稿收纳行（常驻 workspace-info 行须保持取消）"
  );
  assert(
    (await draftInfo.getByTestId("workspace-path").textContent()).includes(
      "专用持久目录"
    ),
    "产物独立草稿未显示默认工作区"
  );

  // 票02 提示条 toast 化：toast 为渲染层内存态，冷启动无任何提示残留；
  // 右下角 toast 区域仅在确有提示时渲染。
  assert(
    (await window.getByTestId("toast-region").count()) === 0,
    "冷启动不得有 toast 残留（提示条须为内存态）"
  );

  // 票03 面板 overlay 抽屉：草稿无面板入口（标题栏开关禁用），
  // 抽屉仅在任务态打开时渲染（tab 头不出现）。
  assert(
    await window.getByTestId("resources-toggle").isDisabled(),
    "草稿态规范与技能开关应为禁用（无面板入口）"
  );
  assert(
    await window.getByTestId("changes-toggle").isDisabled(),
    "草稿态改动开关应为禁用（无面板入口）"
  );
  assert(
    (await window.getByTestId("drawer-tab-resources").count()) === 0 &&
      (await window.getByTestId("drawer-tab-changes").count()) === 0,
    "草稿态不得渲染抽屉 tab 头"
  );

  assert(
    (await window.getByTestId("task-item").count()) === 0,
    "冷启动新建不能产生空历史"
  );
  assert(
    (await window
      .getByTestId("approval-mode-select")
      .getAttribute("data-value")) === "ask",
    "产物新任务默认必须为 ask"
  );
  assert(!existsSync(join(homeDir, "tasks")), "未发送不得创建专用工作区");
  assert(!existsSync(join(homeDir, "codexlike.db")), "新应用不能创建旧库");
  console.log(
    "[packaged] 冷启动冒烟通过：父目录自建、新库落盘、真实侧栏与独立草稿/权限默认正常；票05 新布局断言（标题栏上下文回退/无常驻 workspace-info/toast 内存态/抽屉关闭态）全过"
  );
} finally {
  await closeApp(app);
  rmSync(homeRoot, { recursive: true, force: true });
}
