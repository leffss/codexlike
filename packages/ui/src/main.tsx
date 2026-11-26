import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import type { LaunchState } from "@codexlike/desktop/ipc";
import { installScrollbarVisibility } from "./lib/scrollbar-visibility";
import "./styles.css";
// highlight.js token 色不再全局导入 github-dark.css：
// 已在 styles.css 以 --hl-* 变量随 data-theme 主题化（ADR 0006）

/**
 * dev 预览错误浮层：React 渲染期异常会卸载 root 且无 vite overlay，无此
 * 浮层时崩溃只剩空白页（2026-11-18 新建任务轮）。红条显示消息与 stack 次行，
 * 点击关闭。必须装在 stub 动态导入之前——stub 自身加载失败（模块级异常 /
 * Promise 拒绝）同样会停在空白页，此时后面的捕获器根本没装上（2026-11-26
 * card-shell 原型轮：空白页无任何提示，只能逐模块 curl 排查）。
 */
function showDevError(message: string, detail: string) {
  if (document.getElementById("dev-error-banner") !== null) return;
  const banner = document.createElement("div");
  banner.id = "dev-error-banner";
  banner.style.cssText =
    "position:fixed;top:0;left:0;right:0;z-index:9999;background:#cf222e;color:#fff;font:12px/1.6 ui-monospace,monospace;padding:8px 12px;white-space:pre-wrap;word-break:break-all;cursor:pointer";
  banner.textContent = `DEV 预览未处理错误：${message}\n${detail}（点击关闭）`;
  banner.addEventListener("click", () => banner.remove());
  document.body.appendChild(banner);
}

if (import.meta.env.DEV) {
  window.addEventListener("error", (event) => {
    showDevError(
      event.message,
      String(event.error?.stack ?? "").split("\n")[1] ?? ""
    );
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason;
    showDevError(
      reason instanceof Error ? reason.message : String(reason),
      reason instanceof Error ? (reason.stack?.split("\n")[1] ?? "") : ""
    );
  });
}

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

// 全局滚动条显隐（透明 thumb 方案）：scroll 捕获 + mousemove 边缘检测
// 给滚动容器挂 .scrollbar-live；应用生命周期内常驻，不卸载。
installScrollbarVisibility();
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
