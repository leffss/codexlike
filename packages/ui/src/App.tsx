import { useEffect, useState } from "react";
import type { WindowState } from "@codexlike/desktop/ipc";
import type { WorkbenchTarget } from "@codexlike/agent-core";
import { createWorkspaceState } from "./lib/workspace-state";
import { subscribeWindowState } from "./lib/window-state";
import { reportLaunchState } from "./lib/launch-state";
import { ApplicationExit } from "./components/ApplicationExit";
import { WindowControls } from "./components/WindowControls";
import {
  TitlebarResourceToggle,
  TitlebarTaskContext,
  type TitlebarContext,
} from "./components/TitlebarTaskContext";

import { ThemeProvider, useTheme } from "./lib/theme";
import { SettingsPage } from "./pages/SettingsPage";
import { WorkspacePage } from "./pages/WorkspacePage";

type View = "workspace" | "settings";

/**
 * 顶层视图切换：即时上报启动现场（票03，低频事件不防抖），
 * 重开回到退出前所在视图；上报失败不阻塞界面（共用 lib/launch-state 形状）。
 */
function switchViewWithReport(view: View, setView: (view: View) => void) {
  setView(view);
  reportLaunchState(
    window.codexlike.launchState.setView(view),
    "保存顶层视图现场失败"
  );
}

/**
 * 同一行标题栏（票01 任务上下文行）：工作台视图左区承载任务上下文
 * （品牌 › 任务名 + 徽章），设置视图左区仅品牌展示。
 * 拖动区按控件归属划分（审查修复 1）：header 根元素 window-titlebar-drag
 * 提供整体拖动作用域，左区不再整块免拖——只有真正的交互控件（工作区徽章、
 * 右侧开关/按钮）各自挂在 window-no-drag 作用域内，任务名文本、
 * 徽章间空白与品牌回退态区域恢复可拖动。
 */
function Header(props: {
  view: View;
  /** 工作台视图的标题栏上下文；设置视图不渲染任务上下文 */
  titlebar: TitlebarContext | null;
  onSwitch: (view: View) => void;
}) {
  const { theme, setTheme } = useTheme();
  const api =
    typeof window === "undefined"
      ? undefined
      : window.codexlike?.windowControls;
  const [windowState, setWindowState] = useState<WindowState>({
    maximized: false,
  });
  useEffect(() => {
    if (api) return subscribeWindowState(api, setWindowState);
  }, [api]);

  return (
    <header
      data-testid="window-titlebar"
      className={`${api ? "window-titlebar-drag" : ""} flex shrink-0 items-center justify-between gap-2 border-b border-line bg-surface px-4 py-2`}
    >
      {props.view === "workspace" && props.titlebar ? (
        /* 左区交给父级 drag 作用域：任务名/品牌/空白可拖，
         * 交互控件由 TitlebarTaskContext 内部各自免拖（审查修复 1） */
        <TitlebarTaskContext context={props.titlebar} />
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <span className="shrink-0 text-sm font-semibold tracking-wide text-fg">
            CodexLike
          </span>
          <span className="hidden truncate text-xs text-fg-subtle sm:block">
            本地 AI coding agent 工作台
          </span>
        </div>
      )}
      <nav className="window-no-drag flex shrink-0 items-center gap-1 whitespace-nowrap">
        {props.view === "workspace" && props.titlebar && (
          <>
            {/* 「右栏开关」图标入口：主题切换之前（ADR 0018；任务搜索
             * 已迁任务列表头部，见 TaskSidebar） */}
            <TitlebarResourceToggle panels={props.titlebar.panels} />
          </>
        )}
        <button
          type="button"
          data-testid="theme-toggle"
          title={theme === "dark" ? "切换为浅色主题" : "切换为深色主题"}
          className="rounded px-2 py-1.5 text-sm text-fg-muted hover:bg-hover hover:text-fg"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? (
            /* 太阳（当前深色，点击切浅） */
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <circle cx="8" cy="8" r="3.2" />
              <path d="M8 1v1.8M8 13.2V15M1 8h1.8M13.2 8H15M3 3l1.3 1.3M11.7 11.7L13 13M13 3l-1.3 1.3M4.3 11.7L3 13" />
            </svg>
          ) : (
            /* 月亮（当前浅色，点击切深） */
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M13.5 9.5A6 6 0 0 1 6.5 2.5a6 6 0 1 0 7 7z" />
            </svg>
          )}
        </button>
        {props.view === "settings" ? (
          <button
            type="button"
            className="rounded px-3 py-1.5 text-sm text-fg-muted hover:bg-hover hover:text-fg"
            data-testid="settings-back"
            onClick={() => props.onSwitch("workspace")}
          >
            返回工作台
          </button>
        ) : (
          <button
            type="button"
            className="rounded px-3 py-1.5 text-sm text-fg-muted hover:bg-hover hover:text-fg"
            data-testid="settings-open"
            onClick={() => props.onSwitch("settings")}
          >
            设置
          </button>
        )}
        <WindowControls api={api} state={windowState} />
      </nav>
    </header>
  );
}

function AppShell(props: {
  /** 启动现场的顶层视图（票03）；缺省为工作区 */
  initialView?: View;
  /** 启动现场的工作台目标（票03）：冷启动恢复的第一优先级 */
  initialTarget?: WorkbenchTarget | null;
}) {
  const [view, setView] = useState<View>(props.initialView ?? "workspace");
  /** 标题栏任务上下文（票01）：由 WorkspacePage 上报，设置视图不渲染 */
  const [titlebar, setTitlebarContext] = useState<TitlebarContext | null>(null);
  const [workspaceState] = useState(() =>
    createWorkspaceState(window.codexlike.workbench)
  );
  // 设置页期间仍接收交互终态；后台任务切回不会复活已完成请求。
  useEffect(
    () =>
      window.codexlike.onTaskEvent(({ event }) => {
        if (
          event.type === "interaction-request" ||
          event.type === "interaction-resolved"
        )
          workspaceState.observe(event.interaction);
      }),
    [workspaceState]
  );

  return (
    <div className="flex h-full flex-col">
      <ApplicationExit state={workspaceState}>
        <Header
          view={view}
          titlebar={view === "workspace" ? titlebar : null}
          onSwitch={(next) => switchViewWithReport(next, setView)}
        />
        <main className="min-h-0 flex-1">
          {view === "workspace" ? (
            <WorkspacePage
              state={workspaceState}
              onOpenSettings={() => switchViewWithReport("settings", setView)}
              initialTarget={props.initialTarget}
              onTitlebarContext={setTitlebarContext}
            />
          ) : (
            <SettingsPage />
          )}
        </main>
      </ApplicationExit>
    </div>
  );
}

export function App(props: {
  initialView?: View;
  initialTarget?: WorkbenchTarget | null;
}) {
  return (
    <ThemeProvider>
      <AppShell
        initialView={props.initialView}
        initialTarget={props.initialTarget}
      />
    </ThemeProvider>
  );
}
