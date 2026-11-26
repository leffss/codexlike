import { useEffect, useRef, useState, type ReactNode } from "react";

import type {
  OpenerListResult,
  OpenerOpenInput,
  OpenerOpenResult,
} from "@codexlike/desktop/ipc";

/** 标题栏任务上下文（票01）：WorkspacePage 上报当前任务，Header 装配渲染。 */
export interface TitlebarTask {
  taskId: string;
  /** 任务名（GLOSSARY「任务」）：标题栏主文案 */
  title: string;
  /** 管理项目名；null 为独立任务 */
  projectName: string | null;
  workspaceMode: "local" | "worktree";
  /** 完整工作区路径（徽章 hover 提示与点击弹层展示） */
  workspacePath: string;
  /** 托管 Worktree 的来源目录；local 为 null */
  workspaceOriginPath: string | null;
}

/**
 * 标题栏承载的「右栏开关」（ADR 0018，prototype/panels-redesign 变体 A
 * 折叠）：驱动检视右栏（RailPanel）的开合——aria-expanded 与右栏状态
 * 同步，右栏展开时持久高亮（accent）。图标承载语义（panel-right），
 * 文案进无障碍名与 hover 提示；未提交变更数以红色角标提示（>0 显示，
 * >99 折叠 99+，精确数在右栏「改动」tab）。
 */
export interface TitlebarPanels {
  /** 右栏展开态（与 RailPanel 状态同步） */
  open: boolean;
  /** 无当前任务且草稿无工作区时不可用（资源预览与改动都无内容） */
  disabled: boolean;
  onToggle: () => void;
  /** 未提交变更文件数；null（非 git / 无任务）不显示角标 */
  changesCount: number | null;
}

/**
 * 标题栏「工作区打开器」（GLOSSARY）上下文：候选与打开经 page 层注入
 * （组件不直接触碰 window.codexlike，保持纯 props 可测）；workspacePath
 * 为 null（无任务且草稿未选目录）时按钮禁用。
 */
export interface TitlebarOpener {
  /** 当前可打开的工作区路径（任务的 workspacePath 或草稿已选目录） */
  workspacePath: string | null;
  /** 展开下拉时拉取候选与当前默认 */
  listOpeners(): Promise<OpenerListResult>;
  /** 打开工作区（openerId 省略 = 主按钮用默认打开） */
  openWorkspace(input: OpenerOpenInput): Promise<OpenerOpenResult>;
  /** 失败提示出口（page 层接 toast） */
  notifyError(message: string): void;
}

/** WorkspacePage → 标题栏的单向上下文；null task 回退品牌展示。
 * 任务搜索已迁入任务列表头部（TaskSidebar，添加项目之前）。 */
export interface TitlebarContext {
  task: TitlebarTask | null;
  panels: TitlebarPanels;
  opener: TitlebarOpener;
}

const MODE_LABEL: Record<TitlebarTask["workspaceMode"], string> = {
  local: "本地",
  worktree: "Worktree",
};

/** 工作区徽章点击弹层（纯展示）：完整工作区路径与来源目录。 */
export function WorkspaceBadgePopover(props: { task: TitlebarTask }) {
  return (
    <div
      role="dialog"
      aria-label="工作区信息"
      data-testid="workspace-popover"
      // 弹层统一语汇（ADR 0028，票 02 转办）：白卡 + line 发丝线 + shadow-popover 档 + 10px 圆角
      className="absolute left-0 top-full z-30 mt-2 w-96 max-w-[80vw] rounded-[10px] border border-line bg-surface p-3 shadow-popover"
    >
      <div className="text-xs text-fg-subtle">工作区</div>
      <div
        data-testid="workspace-path"
        className="mt-1 break-all text-xs text-fg"
      >
        {props.task.workspacePath}
      </div>
      {props.task.workspaceOriginPath && (
        <>
          <div className="mt-2 text-xs text-fg-subtle">来源目录</div>
          <div
            data-testid="workspace-origin"
            className="mt-1 break-all text-xs text-fg"
          >
            {props.task.workspaceOriginPath}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 浮层关闭三连（点击外部捕获 / 焦点移出 / Escape）：徽章弹层与打开器
 * 下拉共用的判定（先例：ComposerSelect / TaskContextMenu 的 pointerdown
 * 捕获）；open 为 false 时不订阅。返回挂载容器的 ref。
 */
function useDismissOnBlur(open: boolean, onClose: () => void) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    function outside(event: Event) {
      const root = rootRef.current;
      if (event.target instanceof Node && root && !root.contains(event.target))
        onClose();
    }
    function keyClose(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", keyClose);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", keyClose);
    };
  }, [open, onClose]);
  return rootRef;
}

/** 「项目 · Worktree/本地」徽章：hover 提示完整路径，点击弹层展示详情。 */
function WorkspaceBadge(props: {
  task: TitlebarTask;
  open: boolean;
  onToggle: () => void;
}) {
  const { task, open, onToggle } = props;
  const rootRef = useDismissOnBlur(open, onToggle);

  const hoverTitle = `工作区：${task.workspacePath}${
    task.workspaceOriginPath ? `\n来源目录：${task.workspaceOriginPath}` : ""
  }`;
  return (
    /* 免拖作用域（审查修复 1）：徽章是交互控件，弹层内路径文本需可选中，
     * 整个容器（含弹层）挂在 window-no-drag 内，其余左区保持可拖。 */
    <div className="window-no-drag relative shrink-0" ref={rootRef}>
      <button
        type="button"
        data-testid="workspace-badge"
        title={hoverTitle}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={onToggle}
        className="flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs text-fg-muted hover:bg-hover hover:text-fg"
      >
        <span className="max-w-40 truncate">
          {task.projectName ?? "独立任务"}
        </span>
        <span aria-hidden="true">·</span>
        <span
          data-testid="workspace-mode"
          title="首次执行后工作区固定，调整项目归属不会改变目录、分支和历史；不代表文件只读或权限受限。"
        >
          {MODE_LABEL[task.workspaceMode]}
        </span>
      </button>
      {open && <WorkspaceBadgePopover task={task} />}
    </div>
  );
}

/**
 * 打开器品牌图标（14px，用户定稿：用工具自身默认观感、颜色不统一没关系；
 * JetBrains 三款即其「色块 + 产品缩写」官方语言）。每个图标带独立定位器，
 * 主按钮与菜单项共用同一份（查询须按容器限定，避免默认项两处命中）。
 */
const OPENER_ICONS: Record<string, ReactNode> = {
  explorer: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      data-testid="workspace-opener-icon-explorer"
      aria-hidden="true"
    >
      {/* 双色文件夹：背板深黄 + 面板亮黄（系统资源管理器观感） */}
      <path
        d="M1.8 4.3c0-.66.54-1.2 1.2-1.2h3.2l1.4 1.6h5.4c.66 0 1.2.54 1.2 1.2v6.8c0 .66-.54 1.2-1.2 1.2H3c-.66 0-1.2-.54-1.2-1.2z"
        fill="#F0A32C"
      />
      <path
        d="M3 6.4h10a.9.9 0 0 1 .88 1.08l-.88 3.9a1.2 1.2 0 0 1-1.17.96H3.17a1.2 1.2 0 0 1-1.17-.96l-.88-3.9A.9.9 0 0 1 3 6.4z"
        fill="#FFD056"
      />
    </svg>
  ),
  terminal: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      data-testid="workspace-opener-icon-terminal"
      aria-hidden="true"
    >
      {/* 终端提示符观感：外框 + &gt;_ （跟随文字色，无单一品牌） */}
      <rect
        x="1.5"
        y="2.5"
        width="13"
        height="11"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M4.2 5.8l2.2 2.2-2.2 2.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.8 10.4h4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  ),
  vscode: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      data-testid="workspace-opener-icon-vscode"
      aria-hidden="true"
    >
      {/* 品牌蓝的带侧翼箭头带（VS Code 官方标记观感） */}
      <path
        d="M12.9 1.5 5.5 6.9 3.2 5.2 1.8 5.9 4.5 8 1.8 10.1l1.4.7 2.3-1.7 7.4 5.4 1.6-.8V2.3z"
        fill="#0078D4"
      />
    </svg>
  ),
  pycharm: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      data-testid="workspace-opener-icon-pycharm"
      aria-hidden="true"
    >
      <rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="#21D789" />
      <text
        x="8"
        y="10.3"
        textAnchor="middle"
        fontSize="6.2"
        fontWeight="700"
        fill="#FFFFFF"
        fontFamily="Segoe UI, system-ui, sans-serif"
      >
        PC
      </text>
    </svg>
  ),
  intellij: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      data-testid="workspace-opener-icon-intellij"
      aria-hidden="true"
    >
      <rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="#087CFA" />
      <text
        x="8"
        y="10.3"
        textAnchor="middle"
        fontSize="6.2"
        fontWeight="700"
        fill="#FFFFFF"
        fontFamily="Segoe UI, system-ui, sans-serif"
      >
        IJ
      </text>
    </svg>
  ),
  webstorm: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      data-testid="workspace-opener-icon-webstorm"
      aria-hidden="true"
    >
      <rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="#00B8D9" />
      <text
        x="8"
        y="10.3"
        textAnchor="middle"
        fontSize="6.2"
        fontWeight="700"
        fill="#FFFFFF"
        fontFamily="Segoe UI, system-ui, sans-serif"
      >
        WS
      </text>
    </svg>
  ),
};

function openerIcon(id: string) {
  return OPENER_ICONS[id] ?? OPENER_ICONS.explorer;
}

/**
 * 「工作区打开器」分裂按钮（GLOSSARY）：主按钮用默认程序打开工作区，
 * 图标跟随当前默认（挂载即预取一次候选；失败静默回退资源管理器图标）；
 * 下拉列出本机探测到的候选（展开时重拉，✓ 标当前默认）；点选即以该程序
 * 打开并记为默认（行为即设置）。无路径时整组禁用；失败经 notifyError 提示。
 *
 * 导出给原型 A 修订版复用：按钮从标题栏迁到消息卡首行右侧（打开目录）。
 *
 * compact（原型 A 首行专用，2026-11-26 用户反馈）：收起主图标与下拉箭头
 * 之间的间隔（16px → 8px）——那里只有一组紧凑图标，留白不必像标题栏
 * 那样宽。默认路径不传，保持原样。
 */
export function WorkspaceOpenerButton(props: {
  opener: TitlebarOpener;
  compact?: boolean;
}) {
  const { workspacePath, listOpeners, openWorkspace, notifyError } =
    props.opener;
  const disabled = workspacePath === null;
  const compact = props.compact === true;
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<OpenerListResult["openers"] | null>(null);
  const [defaultId, setDefaultId] = useState<
    OpenerListResult["defaultId"] | null
  >(null);
  const rootRef = useDismissOnBlur(open, () => setOpen(false));
  useEffect(() => {
    // 主按钮图标需要当前默认：可用即预取一次（静默失败——错误留给用户
    // 显式动作（展开/打开）时再报，避免标题栏挂载即弹 toast 打扰）
    if (disabled) return;
    let cancelled = false;
    listOpeners()
      .then((result) => {
        if (cancelled) return;
        setItems(result.openers);
        setDefaultId(result.defaultId);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [disabled, listOpeners]);

  async function toggleMenu() {
    if (open) {
      setOpen(false);
      return;
    }
    try {
      const result = await listOpeners();
      setItems(result.openers);
      setDefaultId(result.defaultId);
      setOpen(true);
    } catch (error) {
      notifyError(
        `打开器列表获取失败：${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  async function openMain() {
    if (workspacePath === null) return;
    try {
      const result = await openWorkspace({ workspacePath });
      setDefaultId(result.defaultId);
    } catch (error) {
      notifyError(error instanceof Error ? error.message : String(error));
    }
  }

  async function pick(id: OpenerListResult["openers"][number]["id"]) {
    if (workspacePath === null) return;
    try {
      const result = await openWorkspace({ workspacePath, openerId: id });
      setDefaultId(result.defaultId);
      setOpen(false);
    } catch (error) {
      // 打开失败保持菜单展开：用户可换一个程序重试
      notifyError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    /* 免拖作用域（同徽章）：交互控件整体挂 window-no-drag。
       compact（原型 A 首行）：整组外加一圈发丝线，读作「一个」分裂按钮，
       而不是两个散落的图标——默认路径不加框，保持原样。 */
    <div
      className={`window-no-drag relative flex shrink-0 items-stretch${
        compact ? " rounded-md border border-line" : ""
      }`}
      ref={rootRef}
    >
      <button
        type="button"
        data-testid="workspace-opener-main"
        disabled={disabled}
        title={disabled ? "未选择工作区" : "用默认程序打开工作区"}
        aria-label="打开工作区"
        onClick={() => void openMain()}
        className={`rounded-l-md ${
          compact
            ? "py-1.5 pl-2 pr-0.5"
            : "border border-r-0 border-transparent px-2 py-0.5"
        } text-xs text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-50`}
      >
        {/* 主按钮图标跟随当前默认（用户定稿）；未拉到列表前回退资源管理器 */}
        {openerIcon(defaultId ?? "explorer")}
      </button>
      <button
        type="button"
        data-testid="workspace-opener-toggle"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="menu"
        title={disabled ? "未选择工作区" : "选择打开工作区的程序"}
        onClick={() => void toggleMenu()}
        className={`rounded-r-md ${
          compact
            ? "py-1.5 pl-0.5 pr-1"
            : "border border-transparent px-1 py-0.5"
        } text-xs text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-50`}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      {open && items !== null && (
        <div
          role="menu"
          aria-label="打开工作区的程序"
          data-testid="workspace-opener-menu"
          // 弹层统一语汇（ADR 0028，票 02 转办）：白卡 + line 发丝线 + shadow-popover 档 + 10px 圆角
          className="absolute left-0 top-full z-30 mt-2 w-52 rounded-[10px] border border-line bg-surface p-1 shadow-popover"
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={item.id === defaultId}
              data-testid={`workspace-opener-option-${item.id}`}
              onClick={() => void pick(item.id)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-fg-muted hover:bg-hover hover:text-fg"
            >
              {openerIcon(item.id)}
              <span className="flex-1">{item.label}</span>
              {item.id === defaultId && (
                <span
                  data-testid={`workspace-opener-check-${item.id}`}
                  aria-label="当前默认"
                  className="text-accent"
                >
                  ✓
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 标题栏左区（工作台视图，票01）：任务上下文行。
 * 有当前任务：品牌 › 任务名 +「项目 · Worktree/本地」徽章（完整路径收进徽章）
 * +「打开工作区」分裂按钮；无任务：回退品牌展示（按钮禁用占位）。
 * 任务搜索迁入标题栏右侧 nav（图标入口，见 App Header）。
 */
export function TitlebarTaskContext(props: { context: TitlebarContext }) {
  const { task, opener } = props.context;
  const [badgeOpen, setBadgeOpen] = useState(false);
  return (
    /* 拖动区划分（审查修复 1）：根容器不设 no-drag，跟随父级
     * window-titlebar-drag 作用域——品牌、任务名与控件间空白可拖；
     * 交互控件（徽章、打开器）挂在 window-no-drag 作用域内。 */
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {task ? (
        <>
          <span className="shrink-0 text-sm font-semibold tracking-wide text-fg">
            CodexLike
          </span>
          <span className="text-fg-subtle" aria-hidden="true">
            ›
          </span>
          <span
            data-testid="task-title"
            title={task.title}
            className="min-w-0 max-w-80 shrink truncate text-sm font-semibold text-fg"
          >
            {task.title}
          </span>
          <WorkspaceBadge
            task={task}
            open={badgeOpen}
            onToggle={() => setBadgeOpen((prev) => !prev)}
          />
          <WorkspaceOpenerButton opener={opener} />
        </>
      ) : (
        <>
          <span className="shrink-0 text-sm font-semibold tracking-wide text-fg">
            CodexLike
          </span>
          <span className="hidden truncate text-xs text-fg-subtle sm:block">
            本地 AI coding agent 工作台
          </span>
          <WorkspaceOpenerButton opener={opener} />
        </>
      )}
    </div>
  );
}

/**
 * 「右栏开关」图标按钮（标题栏右侧 nav，主题切换之前）：驱动检视右栏。
 * 有未提交变更时右上角红色角标（>99 显示 99+，精确数在右栏改动 tab）。
 */
export function TitlebarResourceToggle(props: { panels: TitlebarPanels }) {
  const { panels } = props;
  const count = panels.changesCount ?? 0;
  const showBadge = count > 0;
  const badgeText = count > 99 ? "99+" : String(count);
  return (
    <button
      type="button"
      data-testid="resources-toggle"
      disabled={panels.disabled}
      aria-expanded={panels.open}
      aria-label={showBadge ? `右栏开关，${badgeText} 个文件改动` : "右栏开关"}
      title={panels.open ? "收起右栏" : "展开右栏"}
      onClick={panels.onToggle}
      className={`relative shrink-0 rounded-md border px-2 py-1.5 disabled:opacity-50 ${
        panels.open
          ? /* 展开态持久高亮 = 暖灰底 + 字重（D 语言激活语汇，非彩色描边） */
            "border-transparent bg-surface-muted font-semibold text-fg"
          : "border-transparent text-fg-muted hover:bg-hover hover:text-fg"
      }`}
    >
      {/* 面板图标：外框 + 右格实心（右栏语义） */}
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="1.8" y="2.5" width="12.4" height="11" rx="1.5" />
        <path d="M9.8 2.5v11" />
        <path d="M11.2 4.2h1.7v7.6h-1.7z" fill="currentColor" stroke="none" />
      </svg>
      {showBadge && (
        <span
          aria-hidden="true"
          data-testid="resources-toggle-badge"
          className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger-fg px-1 text-[10px] font-medium leading-none text-white"
        >
          {badgeText}
        </span>
      )}
    </button>
  );
}
