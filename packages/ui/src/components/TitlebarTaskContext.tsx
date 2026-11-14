import { useEffect, useRef, useState } from "react";

import { TaskSearch } from "./TaskSearch";

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

/** 标题栏承载的面板开关（票01 迁移位置；票03 起两开关驱动同一 overlay 抽屉）。 */
export interface TitlebarPanels {
  /** 抽屉当前 tab 为「规范与技能」时 true（与抽屉状态同步） */
  resourcesOpen: boolean;
  /** 抽屉当前 tab 为「改动」时 true（与抽屉状态同步） */
  changesOpen: boolean;
  /** 无当前任务时两个面板都不可用 */
  disabled: boolean;
  onToggleResources: () => void;
  onToggleChanges: () => void;
}

/** WorkspacePage → 标题栏的单向上下文；null task 回退品牌展示。 */
export interface TitlebarContext {
  task: TitlebarTask | null;
  /** 任务搜索整体迁入标题栏（能力不减）：工作台视图恒可用 */
  search: {
    recordsRevision: number;
    onSelect: (taskId: string) => void;
  };
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
 * 无任务：回退品牌展示。任务搜索整体迁入标题栏，两种形态下都可用。
 */
export function TitlebarTaskContext(props: { context: TitlebarContext }) {
  const { task, search } = props.context;
  const [badgeOpen, setBadgeOpen] = useState(false);
  return (
    /* 拖动区划分（审查修复 1）：根容器不设 no-drag，跟随父级
     * window-titlebar-drag 作用域——品牌、任务名与控件间空白可拖；
     * 交互控件（徽章、任务搜索）各自挂在 window-no-drag 作用域内。 */
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
      <div className="window-no-drag shrink-0 whitespace-nowrap">
        <TaskSearch
          recordsRevision={search.recordsRevision}
          onSelect={search.onSelect}
        />
      </div>
    </div>
  );
}

/**
 * 面板开关（规范与技能 / 改动）：迁入标题栏右侧（票01）；
 * 票03 起驱动同一 overlay 抽屉——aria-expanded 与抽屉状态同步，
 * 抽屉所在 tab 的开关持久高亮（accent），文案恒定。
 */
export function TitlebarPanelToggles(props: { panels: TitlebarPanels }) {
  const { panels } = props;
  const toggles: Array<{
    testid: string;
    label: string;
    open: boolean;
    onToggle: () => void;
  }> = [
    {
      testid: "resources-toggle",
      label: "规范与技能",
      open: panels.resourcesOpen,
      onToggle: panels.onToggleResources,
    },
    {
      testid: "changes-toggle",
      label: "改动",
      open: panels.changesOpen,
      onToggle: panels.onToggleChanges,
    },
  ];
  return (
    <>
      {toggles.map(({ testid, label, open, onToggle }) => (
        <button
          key={testid}
          type="button"
          data-testid={testid}
          disabled={panels.disabled}
          aria-expanded={open}
          onClick={onToggle}
          className={`shrink-0 whitespace-nowrap rounded border px-3 py-1 text-xs disabled:opacity-50 ${
            open
              ? "border-accent text-accent"
              : "border-line text-fg-muted hover:border-accent hover:text-accent"
          }`}
        >
          {label}
        </button>
      ))}
    </>
  );
}
