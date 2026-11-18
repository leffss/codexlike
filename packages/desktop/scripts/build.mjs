// esbuild 打包 Electron 主进程与 preload 为 CJS 单文件。
// 选择 esbuild 而非 tsc：主进程只消费产物无需 d.ts，单文件产出避免
// __dirname/ESM 混合坑（package.json type: module 下 Electron 需要 .cjs）。
import { build } from "esbuild";

import { sharedBuildOptions } from "./build-options.mjs";

const shared = { ...sharedBuildOptions, sourcemap: false };

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
