// esbuild 打包 Electron 主进程与 preload 为 CJS 单文件。
// 选择 esbuild 而非 tsc：主进程只消费产物无需 d.ts，单文件产出避免
// __dirname/ESM 混合坑（package.json type: module 下 Electron 需要 .cjs）。
import { build } from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  // electron 由运行时提供；playwright-core 有内部动态 require 与资源定位，
  // 打进单文件不可靠，保持 external（运行时从 node_modules 解析，agent-core 依赖携带）
  external: ['electron', 'playwright-core'],
  sourcemap: false,
  logLevel: 'info',
};

await build({
  ...shared,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.cjs',
});

await build({
  ...shared,
  entryPoints: ['src/preload.ts'],
  outfile: 'dist/preload.cjs',
});
