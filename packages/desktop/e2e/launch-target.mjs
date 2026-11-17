// E2E 启动目标（工单 14 抽出）：默认开发目录模式（本仓 Electron 二进制 +
// packages/desktop 生产产物）；设 CODEXLIKE_PACKAGED_EXE 时切换为打包产物
// （NSIS 安装版 / 便携 zip 解压版），exe 自身即应用、无需 args——九条验收场景
// 走查用同一套 E2E 脚本指向打包产物执行。
import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "playwright-core";

const require = createRequire(import.meta.url);

export const DESKTOP_DIR = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  ".."
);
// pnpm 隔离下 playwright-core 自解析 electron 不可靠，显式指定本包依赖的 Electron 二进制
export const ELECTRON_BIN = require("electron");

/** src/ 下最新源文件的 mtime（构建输入是整个 src，任一文件变化都该重建） */
function newestSrcMtime(dir, extensions) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSrcMtime(path, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      newest = Math.max(newest, statSync(path).mtimeMs);
    }
  }
  return newest;
}

/**
 * 源码 → dist 断链检查（retro 2026-11-18）：开发目录模式的 e2e 加载
 * desktop 的 dist/main.cjs（package.json main）与 ui 的 dist（主进程以
 * file:// 加载 ui/dist/index.html），任一侧源码改动后未重建都会让 e2e
 * **无报错地验证旧代码**——启动前对比各 src 最新 mtime，产物更旧直接失败。
 */
function assertDistFresh() {
  const checks = [
    {
      srcDir: join(DESKTOP_DIR, "src"),
      extensions: [".ts"],
      artifacts: ["dist/main.cjs", "dist/preload.cjs"],
      rebuild: "pnpm --filter @codexlike/desktop run build",
    },
    {
      srcDir: join(DESKTOP_DIR, "..", "ui", "src"),
      extensions: [".ts", ".tsx"],
      artifacts: [join("..", "ui", "dist", "index.html")],
      rebuild: "pnpm --filter @codexlike/ui run build",
    },
  ];
  for (const { srcDir, extensions, artifacts, rebuild } of checks) {
    const srcNewest = newestSrcMtime(srcDir, extensions);
    for (const artifact of artifacts) {
      if (statSync(join(DESKTOP_DIR, artifact)).mtimeMs < srcNewest) {
        throw new Error(
          `[e2e] ${artifact} 比 src/ 旧——源码改动后先跑 ${rebuild} 再跑 e2e（否则在静默验证旧代码）`
        );
      }
    }
  }
}

/** electron.launch 的启动参数：打包产物优先，开发目录兜底 */
export function launchTarget(env) {
  const packagedExe = process.env.CODEXLIKE_PACKAGED_EXE;
  if (packagedExe) {
    return { executablePath: packagedExe, env };
  }
  assertDistFresh();
  return { executablePath: ELECTRON_BIN, args: [DESKTOP_DIR], env };
}

export { electron };
