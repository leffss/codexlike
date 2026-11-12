// 打包冷启动冒烟（retro 2026-11-11）：dist 产物在「数据目录不存在」的干净机器
// 状态下启动。当日事故：createSqliteSessionStore 不建父目录，~/.codexlike 缺失时
// whenReady 断链无窗口；而 11 条 E2E 均以 mkdtempSync 预建 CODEXLIKE_HOME，
// 恰好掩盖该分支。本脚本刻意指向一个不创建的嵌套目录，断言窗口出现且目录自建。
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
  assert(
    existsSync(join(homeDir, "session-workbench.db")),
    "SQLite 库文件未落盘"
  );
  // 窗口标题/数据库存在不等于 React 页面加载成功；通过真实 preload 与草稿界面确认。
  await window.getByTestId("add-project").waitFor();
  await window.getByTestId("new-session").click();
  await window.getByTestId("draft-select-workspace").waitFor();
  assert(
    (await window.getByTestId("workspace-path").textContent()).includes(
      "专用持久目录"
    ),
    "产物独立草稿未显示默认工作区"
  );
  assert(
    (await window.getByTestId("session-item").count()) === 0,
    "冷启动新建不能产生空历史"
  );
  assert(
    (await window
      .getByTestId("approval-mode-select")
      .getAttribute("data-value")) === "ask",
    "产物新会话默认必须为 ask"
  );
  assert(!existsSync(join(homeDir, "sessions")), "未发送不得创建专用工作区");
  assert(!existsSync(join(homeDir, "codexlike.db")), "新应用不能创建旧库");
  console.log(
    "[packaged] 冷启动冒烟通过：父目录自建、新库落盘、真实侧栏与独立草稿/权限默认正常"
  );
} finally {
  await closeApp(app);
  rmSync(homeRoot, { recursive: true, force: true });
}
