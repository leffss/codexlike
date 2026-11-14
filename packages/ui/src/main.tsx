import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import type { LaunchState } from "@codexlike/desktop/ipc";
import "./styles.css";
// highlight.js token 色不再全局导入 github-dark.css：
// 已在 styles.css 以 --hl-* 变量随 data-theme 主题化（ADR 0006）

// dev 浏览器预览设施：纯浏览器 vite dev（无 Electron preload）时注入样例 mock，
// 让渲染层独立于 Electron 挂载完整工作台；Electron 下 window.codexlike 已存在，
// 生产构建不含此分支（动态引入 + DEV 门控）。见 dev/browser-stub.ts。
if (import.meta.env.DEV && window.codexlike === undefined) {
  await import("./dev/browser-stub");
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("找不到 #root 挂载点");
}
const root = createRoot(container);

function render(launchState: LaunchState | null) {
  root.render(
    <StrictMode>
      <App
        initialView={
          launchState?.view === "settings" ? "settings" : "workspace"
        }
        initialTarget={launchState?.workbenchTarget ?? null}
      />
    </StrictMode>
  );
}

// 启动现场（票03）：首帧渲染前读现场——顶层视图初始值取启动现场，避免先闪
// 工作区再跳设置页（不走 localStorage 镜像，现场文件随数据目录隔离）。
// 读取失败按无现场渲染，不挡启动。
window.codexlike.launchState.get().then(render, () => render(null));
