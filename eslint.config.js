// ESLint v9+ flat config。职责边界：eslint 只抓机械问题（Hook 调用规则、
// 未用变量、可疑模式），类型检查完全交给 tsc（typecheck script）——
// 刻意不用 type-aware 规则，避免与 tsc 重复及拖慢 lint。
// 范围：packages/*/src（scripts / e2e / tests 是维护脚本、Playwright 脚本
// 与测试夹具，风格与规则诉求不同，不纳入 lint，见 CODING_STANDARDS.md）。
// react-hooks 只启用经典两条（rules-of-hooks / exhaustive-deps）：
// v7 recommended 附带的 React Compiler 系规则（set-state-in-effect 等）
// 对「effect 内异步加载后 setState」这类既有模式大量误报，不适用本仓。
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

const srcFiles = ["packages/*/src/**/*.{ts,tsx}"];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/",
      "**/dist/",
      "packages/desktop/build/",
      "packages/desktop/.dist-vendor/",
    ],
  },
  {
    files: srcFiles,
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      // 占位参数（如渲染回调里未用的 node）以下划线前缀豁免
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // React 渲染层（ui 包）
    files: ["packages/ui/src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // 只约束「组件文件只导出组件」的轻量形态，允许常量导出（样式/文案）
      "react-refresh/only-export-components": "warn",
    },
  },
  {
    // Electron 主进程 / preload / 共享类型（desktop 包）与 Node 侧核心（agent-core 包）
    files: ["packages/desktop/src/**/*.ts", "packages/agent-core/src/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
  }
);
