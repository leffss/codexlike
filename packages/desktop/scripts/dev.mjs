// 开发流程：esbuild 打包主进程/preload → 等 ui 包的 vite dev server 就绪 → 启动 Electron。
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import process from "node:process";

import { build } from "esbuild";
import waitOn from "wait-on";

import { sharedBuildOptions } from "./build-options.mjs";

const require = createRequire(import.meta.url);
const shared = { ...sharedBuildOptions, sourcemap: true };

await build({
  ...shared,
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.cjs",
});
await build({
  ...shared,
  entryPoints: ["src/preload.ts"],
  outfile: "dist/preload.cjs",
});

// ui 包的 vite dev server（root `pnpm dev` 并行拉起）；单独跑 desktop 时自行等待
const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? "http://localhost:5173";
await waitOn({ resources: [devServerUrl], timeout: 60_000 });

const electronCli = require.resolve("electron/cli.js");
const electron = spawn(process.execPath, [electronCli, "."], {
  stdio: "inherit",
  env: { ...process.env, VITE_DEV_SERVER_URL: devServerUrl },
});

electron.on("exit", (code) => process.exit(code ?? 0));
