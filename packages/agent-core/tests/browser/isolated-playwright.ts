import { join } from "node:path";

/** 真实 Playwright 的测试加载边界，供构建回归与安装器测试共用。 */
export function loadIsolatedPlaywright(
  require: NodeJS.Require,
  directory: string
): typeof import("playwright-core") {
  // 外置包在 VM 外求值，必须在首次同步 require 前隔离真实 process.env。
  // 只保存原对象供 finally 恢复，不读取/复制宿主 DEBUG_FILE 或其它敏感配置。
  const originalEnv = process.env;
  try {
    process.env = {
      HOME: directory,
      USERPROFILE: directory,
      LOCALAPPDATA: directory,
      APPDATA: directory,
      TEMP: directory,
      TMP: directory,
      PLAYWRIGHT_BROWSERS_PATH: join(directory, "browsers"),
    };
    return require("playwright-core") as typeof import("playwright-core");
  } finally {
    process.env = originalEnv;
  }
}
