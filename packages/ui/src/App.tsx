import { useEffect, useState } from "react";
import type { WindowState } from "@codexlike/desktop/ipc";
import type { WorkbenchTarget } from "@codexlike/agent-core";
import { createWorkspaceState } from "./lib/workspace-state";
import { subscribeWindowState } from "./lib/window-state";
import { reportLaunchState } from "./lib/launch-state";
import { ApplicationExit } from "./components/ApplicationExit";
import { WindowControls } from "./components/WindowControls";

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
 * 主题切换按钮（设置顶栏与工作台消息卡首行共用）。
 */
function ThemeToggleButton() {
  const { theme, setTheme } = useTheme();
  return (
    <button
      type="button"
      data-testid="theme-toggle"
      title={theme === "dark" ? "切换为浅色主题" : "切换为深色主题"}
      className="rounded-md px-2 py-1.5 text-sm text-fg-muted hover:bg-hover hover:text-fg"
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
  );
}

/**
 * 窗口控制按钮槽（最小化/最大化/关闭）：自己订阅主进程窗口状态，
 * 放在哪一行由调用方决定。
 */
function WindowControlsSlot(props: { compact?: boolean }) {
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
    <WindowControls api={api} state={windowState} compact={props.compact} />
  );
}

/**
 * 设置图标按钮（工作台消息卡首行：标题栏退役后由图标按钮承担）。
 */
function SettingsIconButton(props: { onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid="settings-open"
      title="设置"
      aria-label="设置"
      onClick={props.onClick}
      className="rounded-md px-2 py-1.5 text-fg-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
    >
      {/* 齿轮图标（设置语汇；与主题的日/月图标明确区分） */}
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </button>
  );
}

/**
 * 设置视图顶栏（工作台视图已无标题栏——任务标题/目录与操作并入消息卡首行）。
 * 透明直接落在窗口桌面上；「返回工作台」回工作区。拖动区按控件归属划分：
 * 根节点整体 window-titlebar-drag，交互控件各自 window-no-drag。
 */
function SettingsHeader(props: { onBack: () => void }) {
  return (
    <header
      data-testid="window-titlebar"
      className={`${typeof window !== "undefined" && window.codexlike?.windowControls ? "window-titlebar-drag" : ""} flex shrink-0 items-center justify-between gap-2 bg-transparent px-4 py-2`}
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
        <ThemeToggleButton />
        <button
          type="button"
          className="rounded-md px-3 py-1.5 text-sm text-fg-muted hover:bg-hover hover:text-fg"
          data-testid="settings-back"
          onClick={props.onBack}
        >
          返回工作台
        </button>
        <WindowControlsSlot />
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

  // 桌面双卡（A）定稿：工作台无标题栏，消息卡首行右侧的动作为
  // 设置图标 + 主题 + 窗口按钮，落点由 WorkspacePage 决定（消息卡首行；
  // 右栏打开时窗口按钮移到右栏首行）。
  const chrome = {
    settingsButton: (
      <SettingsIconButton
        onClick={() => switchViewWithReport("settings", setView)}
      />
    ),
    themeToggle: <ThemeToggleButton />,
    windowControls: <WindowControlsSlot compact />,
  };

  const workspacePage = (
    <WorkspacePage
      state={workspaceState}
      onOpenSettings={() => switchViewWithReport("settings", setView)}
      initialTarget={props.initialTarget}
      chrome={chrome}
    />
  );
  const settingsPage = <SettingsPage />;

  return (
    // 页根即窗口桌面：p-2（8px）为卡片壳与窗口边缘的留白（2026-11-26
    // 用户反馈「卡片边框离程序最外层边框太窄」由 p-1 放宽一档）
    <div className="flex h-full flex-col bg-fg/5 p-2">
      <ApplicationExit state={workspaceState}>
        {view === "workspace" ? (
          <main className="min-h-0 flex-1">{workspacePage}</main>
        ) : (
          <>
            <SettingsHeader
              onBack={() => switchViewWithReport("workspace", setView)}
            />
            <main className="min-h-0 flex-1">{settingsPage}</main>
          </>
        )}
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
