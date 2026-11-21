// 开发与生产必须共用依赖边界，避免内联 Playwright 后破坏它的包内资源定位。
export const sharedBuildOptions = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  // electron 由运行时提供；Playwright 的动态 require 与资源查找保留包边界；
  // node-pty 是原生模块（票02）：不进 bundle，运行时经适配器 createRequire
  // 动态解析（开发目录走 desktop node_modules，打包走 resources/node_modules）。
  external: ["electron", "playwright-core", "node-pty"],
  // Core 保持 ESM；CJS 中用运行时产物位置构造等价 URL，不能内嵌构建机路径。
  // createRequire 据此解析外置 CLI，安装目录迁移或 cwd 改变都不会影响它。
  define: { "import.meta.url": "__codexlikeImportMetaUrl" },
  banner: {
    js: 'const __codexlikeImportMetaUrl = require("node:url").pathToFileURL(__filename).href;',
  },
  logLevel: "info",
};
