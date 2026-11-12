import { useEffect, useState } from "react";
import type { WindowState } from "@codexlike/desktop/ipc";
import { createWorkspaceState } from "./lib/workspace-state";
import { subscribeWindowState } from "./lib/window-state";
import { ApplicationExit } from "./components/ApplicationExit";
import { WindowControls } from "./components/WindowControls";

import { ThemeProvider, useTheme } from "./lib/theme";
import { SettingsPage } from "./pages/SettingsPage";
import { WorkspacePage } from "./pages/WorkspacePage";

type View = "workspace" | "settings";

/** 同一行标题栏：品牌空白区拖动，右侧主题 / 设置 / 窗口按钮不可拖动。 */
function Header(props: { view: View; onSwitch: (view: View) => void }) {
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
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        <span className="shrink-0 text-sm font-semibold tracking-wide text-fg">
          CodexLike
        </span>
        <span className="hidden truncate text-xs text-fg-subtle sm:block">
          本地 AI coding agent 工作台
        </span>
      </div>
      <nav className="window-no-drag flex shrink-0 items-center gap-1 whitespace-nowrap">
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

function AppShell() {
  const [view, setView] = useState<View>("workspace");
  const [workspaceState] = useState(() =>
    createWorkspaceState(window.codexlike.workbench)
  );
  // 设置页期间仍接收交互终态；后台会话切回不会复活已完成请求。
  useEffect(
    () =>
      window.codexlike.onSessionEvent(({ event }) => {
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
        <Header view={view} onSwitch={setView} />
        <main className="min-h-0 flex-1">
          {view === "workspace" ? (
            <WorkspacePage
              state={workspaceState}
              onOpenSettings={() => setView("settings")}
            />
          ) : (
            <SettingsPage />
          )}
        </main>
      </ApplicationExit>
    </div>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <AppShell />
    </ThemeProvider>
  );
}
