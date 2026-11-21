// 真件冒烟编排（票02）：esbuild 把冒烟入口（含 PtyPort 适配器）打成 CJS 单
// 文件 → electron 运行 → 退出码转发。与 build.mjs 共用依赖边界
// （sharedBuildOptions：electron / node-pty external，import.meta.url banner），
// 保证冒烟验证的加载路径与 dist/main.cjs 完全同构。
// 运行：pnpm --filter @codexlike/desktop run smoke:pty
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { sharedBuildOptions } from "./build-options.mjs";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  ...sharedBuildOptions,
  sourcemap: false,
  entryPoints: [resolve(PKG_DIR, "scripts", "pty-smoke-main.mjs")],
  outfile: resolve(PKG_DIR, "dist", "pty-smoke.cjs"),
});

// node 上下文里 require("electron") 返回 electron 二进制路径
const requireHere = createRequire(import.meta.url);
const electronPath = requireHere("electron");

const child = spawn(electronPath, [resolve(PKG_DIR, "dist", "pty-smoke.cjs")], {
  stdio: "inherit",
});
child.on("error", (error) => {
  console.error(`[pty-smoke] electron 启动失败：${error.message}`);
  process.exit(1);
});
child.on("exit", (code) => {
  process.exit(code ?? 1);
});
