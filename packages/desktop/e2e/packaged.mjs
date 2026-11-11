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
  assert(existsSync(join(homeDir, "codexlike.db")), "SQLite 库文件未落盘");
  console.log("[packaged] 冷启动冒烟通过：窗口已开，数据目录自建，库文件落盘");
} finally {
  await closeApp(app);
  rmSync(homeRoot, { recursive: true, force: true });
}
