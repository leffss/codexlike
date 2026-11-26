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
// 【原型设施，prototype/card-shell 分支】整页卡片壳变体切换（?variant=）；
// 生产构建不启用（下方 shell 判定带 PROD 门控，切换条自身也 PROD 短路）。
import {
  PrototypeSwitcher,
  useSearchParamVariant,
} from "./components/PrototypeSwitcher";
import { CARD_SHELL_VARIANTS, cardShellSpec } from "./dev/card-shell";

type View = "workspace" | "settings";

/** 原型变体键（模块级常量：引用稳定，作 hook effect 依赖） */
const PROTOTYPE_VARIANT_KEYS = CARD_SHELL_VARIANTS.map((item) => item.key);

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
 * 主题切换按钮（标题栏与原型 A 变体的消息卡首行共用）。
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
 * 窗口控制按钮槽（最小化/最大化/关闭）：标题栏与原型 A 变体共用——
 * 自己订阅主进程窗口状态，放在哪一行由调用方决定。
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
 * 设置图标按钮（原型 A 变体的消息卡首行：标题栏退役后由图标按钮承担）。
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
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </button>
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
  /**
   * 【原型设施，prototype/card-shell】标题栏表面：
   * - default：现状独立白条；on-desk：透明，直接落在窗口桌面上（大卡在卡外）；
   * - in-card：收进整页大卡片内部（透明底 + 下缘发丝线）。
   */
  frame?: "default" | "on-desk" | "in-card";
}) {
  return (
    <header
      data-testid="window-titlebar"
      className={`${typeof window !== "undefined" && window.codexlike?.windowControls ? "window-titlebar-drag" : ""} flex shrink-0 items-center justify-between gap-2 px-4 py-2 ${
        props.frame === "in-card"
          ? "border-b border-line bg-transparent"
          : props.frame === "on-desk"
            ? "bg-transparent"
            : "bg-canvas"
      }`}
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
        <ThemeToggleButton />
        {props.view === "settings" ? (
          <button
            type="button"
            className="rounded-md px-3 py-1.5 text-sm text-fg-muted hover:bg-hover hover:text-fg"
            data-testid="settings-back"
            onClick={() => props.onSwitch("workspace")}
          >
            返回工作台
          </button>
        ) : (
          <button
            type="button"
            className="rounded-md px-3 py-1.5 text-sm text-fg-muted hover:bg-hover hover:text-fg"
            data-testid="settings-open"
            onClick={() => props.onSwitch("settings")}
          >
            设置
          </button>
        )}
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

  // 【原型设施，prototype/card-shell】?variant= 选择整页卡片壳变体；
  // 空串 = 无变体 = 现状渲染路径；生产构建强制回现状。
  const [prototypeVariant, setPrototypeVariant] = useSearchParamVariant(
    PROTOTYPE_VARIANT_KEYS
  );
  const shell = import.meta.env.PROD ? null : cardShellSpec(prototypeVariant);
  const headerless = shell?.header === "none";

  // 【原型 A 修订版】标题栏退役后的动作组：设置图标 + 主题 + 窗口按钮，
  // 由 WorkspacePage 决定落点与先后（消息卡首行；右栏打开时窗口按钮移到
  // 右栏首行）。主题/设置分开成两个槽：右栏开关夹在两者之间（用户指定
  // 「设置 ↔ 右栏开关」对调后的顺序）。
  const prototypeChrome = headerless
    ? {
        settingsButton: (
          <SettingsIconButton
            onClick={() => switchViewWithReport("settings", setView)}
          />
        ),
        themeToggle: <ThemeToggleButton />,
        windowControls: <WindowControlsSlot compact />,
      }
    : undefined;

  const workspacePage = (
    <WorkspacePage
      state={workspaceState}
      onOpenSettings={() => switchViewWithReport("settings", setView)}
      initialTarget={props.initialTarget}
      onTitlebarContext={setTitlebarContext}
      prototypeVariant={shell === null ? null : prototypeVariant}
      prototypeChrome={prototypeChrome}
    />
  );
  const settingsPage = <SettingsPage />;
  const page = view === "workspace" ? workspacePage : settingsPage;

  const header = (
    <Header
      view={view}
      titlebar={view === "workspace" ? titlebar : null}
      onSwitch={(next) => switchViewWithReport(next, setView)}
      frame={
        shell === null
          ? "default"
          : shell.header === "inside"
            ? "in-card"
            : "on-desk"
      }
    />
  );

  if (shell === null) {
    return (
      <div className="flex h-full flex-col">
        <ApplicationExit state={workspaceState}>
          {header}
          <main className="min-h-0 flex-1">{page}</main>
        </ApplicationExit>
      </div>
    );
  }

  // A 修订版：工作区不渲染标题栏（品牌进左栏、操作与窗口按钮进消息卡/
  // 右栏首行）；设置页仍用标题栏承载「返回工作台」。
  if (shell.header === "none") {
    return (
      <div className={shell.page}>
        <ApplicationExit state={workspaceState}>
          {view === "workspace" ? (
            <main className="min-h-0 flex-1">{workspacePage}</main>
          ) : (
            <>
              <Header
                view="settings"
                titlebar={null}
                onSwitch={(next) => switchViewWithReport(next, setView)}
                frame="on-desk"
              />
              <main className="min-h-0 flex-1">{settingsPage}</main>
            </>
          )}
        </ApplicationExit>
        <PrototypeSwitcher
          variants={CARD_SHELL_VARIANTS}
          current={prototypeVariant}
          onChange={setPrototypeVariant}
        />
      </div>
    );
  }

  // 原型路径：整页大卡片（标题栏在卡外，或收进卡内）+ 底部变体切换条
  return (
    <div className={shell.page}>
      <ApplicationExit state={workspaceState}>
        {shell.header === "inside" ? (
          <div className={shell.card}>
            {header}
            <main className="min-h-0 flex-1">{page}</main>
          </div>
        ) : (
          <>
            {header}
            <div className={shell.card}>
              <main className="min-h-0 flex-1">{page}</main>
            </div>
          </>
        )}
      </ApplicationExit>
      <PrototypeSwitcher
        variants={CARD_SHELL_VARIANTS}
        current={prototypeVariant}
        onChange={setPrototypeVariant}
      />
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
