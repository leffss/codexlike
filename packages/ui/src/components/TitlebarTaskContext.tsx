import { useEffect, useRef, useState } from "react";

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

/** WorkspacePage → 标题栏的单向上下文；null task 回退品牌展示。
 * 任务搜索已迁入任务列表头部（TaskSidebar，添加项目之前）。 */
export interface TitlebarContext {
  task: TitlebarTask | null;
  panels: TitlebarPanels;
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
      className="absolute left-0 top-full z-30 mt-2 w-96 max-w-[80vw] rounded-lg border border-line bg-surface p-3 shadow-xl"
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

/** 「项目 · Worktree/本地」徽章：hover 提示完整路径，点击弹层展示详情。 */
function WorkspaceBadge(props: {
  task: TitlebarTask;
  open: boolean;
  onToggle: () => void;
}) {
  const { task, open, onToggle } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    // 点击外部关闭（先例：ComposerSelect / TaskContextMenu 的 pointerdown
    // 捕获）与焦点移出（focusin）判定完全相同，共用一个处理器。
    function outside(event: Event) {
      const root = rootRef.current;
      if (event.target instanceof Node && root && !root.contains(event.target))
        onToggle();
    }
    function keyClose(event: KeyboardEvent) {
      if (event.key === "Escape") onToggle();
    }
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", keyClose);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", keyClose);
    };
  }, [open, onToggle]);

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
        className="flex shrink-0 items-center gap-1 rounded border border-line bg-surface px-2 py-0.5 text-xs text-fg-muted hover:border-accent hover:text-accent"
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
 * 标题栏左区（工作台视图，票01）：任务上下文行。
 * 有当前任务：品牌 › 任务名 +「项目 · Worktree/本地」徽章（完整路径收进徽章）；
 * 无任务：回退品牌展示。任务搜索迁入标题栏右侧 nav（图标入口，见 App Header）。
 */
export function TitlebarTaskContext(props: { context: TitlebarContext }) {
  const { task } = props.context;
  const [badgeOpen, setBadgeOpen] = useState(false);
  return (
    /* 拖动区划分（审查修复 1）：根容器不设 no-drag，跟随父级
     * window-titlebar-drag 作用域——品牌、任务名与控件间空白可拖；
     * 交互控件（徽章）挂在 window-no-drag 作用域内。 */
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
        </>
      ) : (
        <>
          <span className="shrink-0 text-sm font-semibold tracking-wide text-fg">
            CodexLike
          </span>
          <span className="hidden truncate text-xs text-fg-subtle sm:block">
            本地 AI coding agent 工作台
          </span>
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
      className={`relative shrink-0 rounded border px-2 py-1.5 disabled:opacity-50 ${
        panels.open
          ? "border-accent text-accent"
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
