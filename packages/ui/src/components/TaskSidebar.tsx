import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { ProjectRecord } from "@codexlike/agent-core";
import type { TaskListItem } from "@codexlike/desktop/ipc";
import { TaskActivityBadge } from "./TaskActivityBadge";
import { TaskContextMenu, type TaskMenuAnchor } from "./TaskContextMenu";
import { TaskSearch } from "./TaskSearch";

import { groupTasksByProject } from "../lib/project-groups";
import { formatRelativeTime } from "../lib/relative-time";

/** 拖拽分栏约束（px，与右栏 RailPanel 同款交互）：左栏最小宽、正文最小
 *  宽（中列消息流+输入区）、默认宽（原 w-80 = 20rem） */
const SIDEBAR_MIN_WIDTH = 240;
const STREAM_MIN_WIDTH = 480;
const SIDEBAR_DEFAULT_WIDTH = 320;

/**
 * 宽度夹取（拖拽与方向键共用）：左栏最小宽 SIDEBAR_MIN_WIDTH、上限 max
 * （= 当前侧栏宽 + 正文列富余）；上限优先于最小宽（正文 STREAM_MIN_WIDTH
 * 优先，窄窗口下跟随容器收窄保布局不溢出）。导出供单测。
 */
export function clampSidebarWidth(width: number, max: number): number {
  return Math.min(max, Math.max(SIDEBAR_MIN_WIDTH, width));
}

function toggleKey(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}

/** 项目组头的文件夹图标（内联 SVG——UI 不引入图标库；开合两态） */
function FolderIcon(props: { open: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
      className="shrink-0"
    >
      <path
        d={
          props.open
            ? "M1.75 4.25A1.25 1.25 0 0 1 3 3h3l1.5 1.75H13A1.25 1.25 0 0 1 14.25 6v6A1.25 1.25 0 0 1 13 13.25H3A1.25 1.25 0 0 1 1.75 12V4.25z"
            : "M1.75 3.75A1.25 1.25 0 0 1 3 2.5h3l1.5 1.75H13A1.25 1.25 0 0 1 14.25 5.5v7A1.25 1.25 0 0 1 13 13.75H3a1.25 1.25 0 0 1-1.25-1.25v-8.75z"
        }
      />
    </svg>
  );
}

/** 独立任务分区的气泡图标（不属于任何项目的任务，与项目文件夹图标区分） */
function StandaloneIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M5.27 13.33A6 6 0 1 0 2.67 10.73L1.33 14.67Z" />
    </svg>
  );
}

/** 顶栏「添加项目」入口的文件夹加号图标（内联 SVG——UI 不引入图标库） */
function FolderPlusIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.75 3.75A1.25 1.25 0 0 1 3 2.5h3l1.5 1.75H13A1.25 1.25 0 0 1 14.25 5.5v7A1.25 1.25 0 0 1 13 13.75H3a1.25 1.25 0 0 1-1.25-1.25v-8.75z" />
      <path d="M8 6.5v4M6 8.5h4" />
    </svg>
  );
}

/** 顶栏「新建任务」入口的加号图标 */
function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

/**
 * 左栏：任务列表（ADR 0010）。
 * 顶栏两枚图标按钮（原型 prototype/sidebar-buttons 变体 A 定稿）：
 * 「+」为单一「新建任务」按钮，直达新建任务页（独立入口语境，
 * 归属在页面内选——ADR 0026 顶栏菜单退役）；添加项目为 ghost 图标。
 * 项目组头与独立任务组头悬停均出就近「+」（带语境直达）。
 * 项目组头不依赖任务存在；归属只看 projectId，绝不按目录自动聚合。
 * 组内活跃任务在上、「已归档」子折叠在下。
 * 任务标题优先占用单行空间，最近使用时间收进提示；后台输出不改变顺序。
 * 整理操作收进右键菜单，键盘与鼠标均可访问；
 * 重命名 / 归档与 /rename /archive 走同一 IPC 通道。
 * 移除项目不在组头悬停出现，收进项目组头右键菜单（整行可右键，
 * ContextMenu / Shift+F10 等效），菜单项仍走确认弹窗后才移除。
 */
export function TaskSidebar(props: {
  tasks: TaskListItem[];
  projects: ProjectRecord[];
  onAddProject: () => void;
  onCreateInProject: (projectId: string) => void;
  currentId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  creating: boolean;
  onMembership: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string, archived: boolean) => void;
  onPin: (id: string, pinned: boolean) => void;
  onPinProject: (id: string, pinned: boolean) => void;
  onCollapseProject: (id: string, collapsed: boolean) => void;
  onRemoveProject?: (id: string) => void;
  /** 任务搜索结果的失效信号（任务列表变更时递增；头部搜索消费） */
  searchRecordsRevision: number;
}) {
  const [standaloneCollapsed, setStandaloneCollapsed] = useState(false);
  const [expandedArchived, setExpandedArchived] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [menu, setMenu] = useState<{
    taskId: string;
    projectId: TaskListItem["projectId"];
    archivedAt: TaskListItem["archivedAt"];
    anchor: TaskMenuAnchor;
  } | null>(null);
  // 项目组头右键菜单：移除项目入口（悬停 × 已取消，仍走确认弹窗）
  const [projectMenu, setProjectMenu] = useState<{
    projectId: string;
    anchor: TaskMenuAnchor;
  } | null>(null);
  const menuTask = props.tasks.find((task) => task.id === menu?.taskId);
  const closeMenu = useCallback(
    (restoreFocus: boolean) => {
      if (restoreFocus && menu) {
        const active = document.activeElement;
        const activeMenu =
          active instanceof HTMLElement
            ? active.closest<HTMLElement>("[data-testid='task-context-menu']")
            : null;
        if (
          (active === document.body ||
            activeMenu?.dataset.taskId === menu.taskId) &&
          !document.querySelector("[role='dialog'][aria-modal='true']")
        ) {
          const taskTarget = Array.from(
            document.querySelectorAll<HTMLElement>("[data-task-select]")
          ).find((element) => element.dataset.taskId === menu.taskId);
          const groupTarget = Array.from(
            document.querySelectorAll<HTMLElement>(
              "[data-testid='project-header']"
            )
          )
            .find((element) => element.dataset.projectId === menu.projectId)
            ?.querySelector<HTMLElement>("button");
          const fallback =
            menu.projectId === null
              ? document.querySelector<HTMLElement>(
                  "[data-testid='standalone-group']"
                )
              : groupTarget;
          const target = menu.anchor.target.isConnected
            ? menu.anchor.target
            : (taskTarget ??
              fallback ??
              document.querySelector<HTMLElement>("[data-testid='new-task']"));
          target?.focus({ preventScroll: true });
        }
      }
      setMenu(null);
    },
    [menu]
  );

  useLayoutEffect(() => {
    if (
      menu &&
      (!menuTask ||
        menuTask.projectId !== menu.projectId ||
        menuTask.archivedAt !== menu.archivedAt ||
        !menu.anchor.target.isConnected)
    ) {
      closeMenu(true);
    }
  });

  const closeProjectMenu = useCallback(
    (restoreFocus: boolean) => {
      if (restoreFocus && projectMenu) {
        const active = document.activeElement;
        const activeMenu =
          active instanceof HTMLElement
            ? active.closest<HTMLElement>("[data-testid='task-context-menu']")
            : null;
        if (
          (active === document.body ||
            (activeMenu !== null && activeMenu.dataset.taskId === undefined)) &&
          !document.querySelector("[role='dialog'][aria-modal='true']")
        ) {
          const header = Array.from(
            document.querySelectorAll<HTMLElement>(
              "[data-testid='project-header']"
            )
          ).find(
            (element) => element.dataset.projectId === projectMenu.projectId
          );
          header
            ?.querySelector<HTMLElement>("button")
            ?.focus({ preventScroll: true });
        }
      }
      setProjectMenu(null);
    },
    [projectMenu]
  );

  // 项目被移除或组头不再挂载时收起项目菜单（对齐任务菜单的失效检查）
  useLayoutEffect(() => {
    if (
      projectMenu &&
      (!props.projects.some(
        (project) => project.id === projectMenu.projectId
      ) ||
        !projectMenu.anchor.target.isConnected)
    ) {
      closeProjectMenu(true);
    }
  });

  // 全列表共享的分钟级时钟：相对时间文案随时间推移刷新（非每行一个定时器）
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // ===== 拖拽分栏：宽度内存态（会话内保持；不持久化），与右栏 RailPanel 同款 =====
  const layoutRef = useRef<HTMLElement | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ x: number; width: number; max: number } | null>(
    null
  );

  /** 宽度上限 = 当前侧栏宽 + 正文列（本栏右侧的 @container/task section）
   *  富余（现宽 − 最小宽）。量正文列而非整行——右栏展开时正文已被压窄，
   *  行宽口径会高估富余、把正文压穿最小宽。 */
  function maxSidebarWidth(): number {
    const section = layoutRef.current?.nextElementSibling;
    const streamWidth = section?.getBoundingClientRect().width;
    if (streamWidth === undefined) return SIDEBAR_DEFAULT_WIDTH;
    return sidebarWidth + Math.max(0, streamWidth - STREAM_MIN_WIDTH);
  }

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (layoutRef.current === null) return;
    // 阻止 pointerdown 默认行为（否则合成 mouse 事件会开启原生文本划选）
    event.preventDefault();
    // 正文富余在拖动起点测一次（拖动期间窗口尺寸变化不在考虑内）
    dragStart.current = {
      x: event.clientX,
      width: sidebarWidth,
      max: maxSidebarWidth(),
    };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    // 拖动期间禁选中（防正文文字被划选）并统一光标
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  }

  function onDragMove(event: ReactPointerEvent<HTMLDivElement>) {
    const start = dragStart.current;
    if (start === null) return;
    // 左栏在左侧：向右拖 = 变宽；双端夹取
    const next = start.width + (event.clientX - start.x);
    setSidebarWidth(clampSidebarWidth(next, start.max));
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragStart.current === null) return;
    dragStart.current = null;
    setDragging(false);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function onSeparatorKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    // → 拉宽左栏，← 收窄（与拖动方向一致），步进 24px（右栏同款）
    const delta = event.key === "ArrowRight" ? 24 : -24;
    setSidebarWidth((width) =>
      clampSidebarWidth(width + delta, maxSidebarWidth())
    );
  }

  const groups = groupTasksByProject(props.tasks, props.projects);

  function submitRename(id: string) {
    const title = editingTitle.trim();
    setEditingId(null);
    if (title !== "") {
      props.onRename(id, title);
    }
  }

  function onRenameKeyDown(event: KeyboardEvent<HTMLInputElement>, id: string) {
    if (event.key === "Enter") {
      event.preventDefault();
      submitRename(id);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setEditingId(null);
    }
  }

  function renderTaskItem(task: TaskListItem) {
    const usedAt = task.lastUsedAt ?? task.createdAt;
    const relative = formatRelativeTime(usedAt, now);
    const absoluteTime = `最近使用：${new Date(usedAt).toLocaleString("zh-CN")}`;

    const archived = task.archivedAt !== null;

    return (
      <li
        key={task.id}
        data-testid="task-row"
        data-task-id={task.id}
        className={`group/task relative mt-0.5 flex items-center rounded-md ${
          task.id === props.currentId
            ? /* 当前任务 = 暖灰底 + 字重（非彩色胶囊，D 语言选中语汇） */
              "bg-selected font-medium text-fg"
            : "text-fg-muted hover:bg-hover hover:text-fg"
        }`}
        onContextMenu={(event) => {
          if (editingId === task.id) return;
          event.preventDefault();
          const target =
            event.currentTarget.querySelector<HTMLButtonElement>(
              "[data-task-select]"
            );
          if (!target) return;
          setMenu({
            taskId: task.id,
            projectId: task.projectId,
            archivedAt: task.archivedAt,
            anchor: { x: event.clientX, y: event.clientY, target },
          });
        }}
        onKeyDown={(event) => {
          if (
            editingId === task.id ||
            !(
              event.key === "ContextMenu" ||
              (event.shiftKey && event.key === "F10")
            )
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          const target = event.target as HTMLElement;
          const rect = target.getBoundingClientRect();
          setMenu({
            taskId: task.id,
            projectId: task.projectId,
            archivedAt: task.archivedAt,
            anchor: { x: rect.left, y: rect.bottom, target },
          });
        }}
      >
        {editingId === task.id ? (
          <input
            data-testid="rename-input"
            aria-label="任务名称"
            value={editingTitle}
            autoFocus
            onChange={(event) => setEditingTitle(event.target.value)}
            onKeyDown={(event) => onRenameKeyDown(event, task.id)}
            onBlur={() => submitRename(task.id)}
            className="w-full rounded-md border-[1.5px] border-accent/55 bg-canvas px-2 py-1.5 text-sm text-fg outline-none"
          />
        ) : (
          <>
            {/* 置顶图标常驻标题之前：列位固定预留（未置顶仅悬停显形，
                标题起点不随图标显隐跳动）；已置顶实心常显（accent 色） */}
            <button
              type="button"
              data-testid="pin-button"
              aria-pressed={task.pinned ?? false}
              aria-label={task.pinned ? "取消置顶" : "置顶任务"}
              title={task.pinned ? "取消置顶" : "置顶任务"}
              className={`ml-0.5 flex h-6 w-5 shrink-0 items-center justify-center rounded hover:text-accent ${
                task.pinned
                  ? "text-accent"
                  : "pointer-events-none text-fg-muted opacity-0 group-hover/task:pointer-events-auto group-hover/task:opacity-100 group-focus-within/task:pointer-events-auto group-focus-within/task:opacity-100"
              }`}
              onClick={() => props.onPin(task.id, !task.pinned)}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill={task.pinned ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 17v5" />
                <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
              </svg>
            </button>
            <button
              type="button"
              data-testid={archived ? "archived-task-item" : "task-item"}
              data-task-id={task.id}
              data-task-select="true"
              aria-current={task.id === props.currentId ? "page" : undefined}
              aria-haspopup="menu"
              aria-expanded={menu?.taskId === task.id}
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-[7px] pl-0.5 pr-1 text-left text-sm"
              onClick={() => props.onSelect(task.id)}
            >
              <span
                data-testid="task-label"
                className="min-w-0 flex-1 truncate"
                title={`${task.title}\n${relative} · ${absoluteTime}\n${task.workspacePath}`}
              >
                {task.title}
              </span>
              {task.workspaceMode === "worktree" && (
                <span
                  data-testid="worktree-badge"
                  title={`托管 Worktree：${task.workspacePath}`}
                  aria-label="worktree"
                  className="flex shrink-0 items-center text-worktree-fg"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    aria-hidden="true"
                  >
                    <circle cx="4" cy="3" r="1.5" />
                    <circle cx="4" cy="13" r="1.5" />
                    <circle cx="12" cy="3" r="1.5" />
                    <path d="M4 4.5v7M12 4.5v1A3.5 3.5 0 0 1 8.5 9H4" />
                  </svg>
                  <span className="sr-only">worktree</span>
                </span>
              )}
              <TaskActivityBadge task={task} compact />
            </button>
          </>
        )}
      </li>
    );
  }

  function renderGroup(group: (typeof groups)[number]) {
    const project = props.projects.find((item) => item.id === group.projectId);
    // 折叠只改变导航显示，不改变当前查看或待处理交互。
    const containsCurrent =
      props.currentId !== null &&
      (group.active.some((task) => task.id === props.currentId) ||
        group.archived.some((task) => task.id === props.currentId));
    const expanded =
      group.projectId === null
        ? !standaloneCollapsed
        : !props.projects.find((project) => project.id === group.projectId)
            ?.collapsed;
    const archivedOpen =
      expandedArchived.has(group.key) ||
      (containsCurrent &&
        group.archived.some((task) => task.id === props.currentId));

    return (
      <li key={group.key} className="mt-4 first:mt-2">
        <div
          data-testid={
            group.projectId === null ? "standalone-header" : "project-header"
          }
          data-project-id={group.projectId ?? undefined}
          className="group/header flex items-center rounded-md text-fg hover:bg-hover"
          onContextMenu={(event) => {
            if (group.projectId === null || !props.onRemoveProject) return;
            event.preventDefault();
            const target = event.currentTarget.querySelector<HTMLButtonElement>(
              "[data-testid='project-group']"
            );
            if (!target) return;
            setProjectMenu({
              projectId: group.projectId,
              anchor: { x: event.clientX, y: event.clientY, target },
            });
          }}
          onKeyDown={(event) => {
            if (
              group.projectId === null ||
              !props.onRemoveProject ||
              !(
                event.key === "ContextMenu" ||
                (event.shiftKey && event.key === "F10")
              )
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            const target = event.target as HTMLElement;
            const rect = target.getBoundingClientRect();
            setProjectMenu({
              projectId: group.projectId,
              anchor: { x: rect.left, y: rect.bottom, target },
            });
          }}
        >
          <button
            type="button"
            data-testid={
              group.projectId === null ? "standalone-group" : "project-group"
            }
            title={group.path}
            aria-expanded={expanded}
            className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-[7px] text-left text-sm font-semibold"
            onClick={() =>
              group.projectId === null
                ? setStandaloneCollapsed((prev) => !prev)
                : props.onCollapseProject(group.projectId, expanded)
            }
          >
            <span className="w-3 shrink-0 text-center text-fg-subtle">
              {expanded ? "▾" : "▸"}
            </span>
            {group.projectId === null ? (
              <StandaloneIcon />
            ) : (
              <FolderIcon open={expanded} />
            )}
            <span className="truncate">{group.name}</span>
            {project?.pinned && (
              <span
                data-testid="project-pinned"
                className="shrink-0 text-[10px] text-accent"
              >
                置顶
              </span>
            )}
          </button>
          <span className="mr-1 grid shrink-0 items-center">
            <span
              data-testid="project-task-count"
              className="col-start-1 row-start-1 px-1 text-right text-[10px] text-fg-subtle group-hover/header:invisible group-focus-within/header:invisible"
            >
              {group.active.length}
              {group.archived.length > 0 && ` · 归档 ${group.archived.length}`}
            </span>
            {group.projectId !== null && (
              <span className="pointer-events-none col-start-1 row-start-1 flex items-center justify-end gap-0.5 opacity-0 group-hover/header:pointer-events-auto group-hover/header:opacity-100 group-focus-within/header:pointer-events-auto group-focus-within/header:opacity-100">
                <button
                  type="button"
                  data-testid="project-pin"
                  aria-pressed={project?.pinned ?? false}
                  title={project?.pinned ? "取消项目置顶" : "置顶项目"}
                  aria-label={project?.pinned ? "取消项目置顶" : "置顶项目"}
                  className="rounded px-1 py-0.5 text-[10px] text-fg-muted hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
                  onClick={() =>
                    props.onPinProject(group.projectId!, !project?.pinned)
                  }
                >
                  {project?.pinned ? "取消置顶" : "置顶"}
                </button>
                <button
                  type="button"
                  data-testid="project-new-task"
                  title="在此项目新建任务"
                  aria-label="在此项目新建任务"
                  disabled={props.creating}
                  className="flex h-6 w-6 items-center justify-center rounded text-accent hover:bg-hover disabled:opacity-50"
                  onClick={() => props.onCreateInProject(group.projectId!)}
                >
                  <PlusIcon />
                </button>
              </span>
            )}
            {group.projectId === null && (
              <span className="pointer-events-none col-start-1 row-start-1 flex items-center justify-end opacity-0 group-hover/header:pointer-events-auto group-hover/header:opacity-100 group-focus-within/header:pointer-events-auto group-focus-within/header:opacity-100">
                <button
                  type="button"
                  data-testid="standalone-new-task"
                  title="新建独立任务"
                  aria-label="新建独立任务"
                  disabled={props.creating}
                  className="flex h-6 w-6 items-center justify-center rounded text-accent hover:bg-hover disabled:opacity-50"
                  onClick={() => props.onCreate()}
                >
                  <PlusIcon />
                </button>
              </span>
            )}
          </span>
        </div>
        {/* 无竖线缩进导轨（ml-5 收敛自原 ml-7，组缩进 ≥20px 口径保留）：
            行首置顶图标列落位在项目文件夹图标正下方，任务标题起点保持
            与项目名文字对齐（sidebar-archive e2e assertProjectHierarchy） */}
        {expanded && (
          <div data-testid="group-tasks" className="ml-5">
            <ul>{group.active.map((task) => renderTaskItem(task))}</ul>
            {group.archived.length > 0 && (
              <div>
                <button
                  type="button"
                  data-testid="toggle-archived"
                  className="w-full rounded px-2 py-1 text-left text-[11px] text-fg-subtle hover:text-fg-muted"
                  onClick={() =>
                    setExpandedArchived((prev) => toggleKey(prev, group.key))
                  }
                >
                  {archivedOpen ? "收起" : "展开"}已归档（
                  {group.archived.length}）
                </button>
                {archivedOpen && (
                  <ul className="mt-0.5" data-testid="archived-list">
                    {group.archived.map((task) => renderTaskItem(task))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </li>
    );
  }

  return (
    // ref 挂在 aside 上：maxSidebarWidth 经 nextElementSibling 取右侧正文
    // 列实测宽（拖拽上限数据源）
    <aside
      ref={layoutRef}
      aria-label="任务列表"
      style={{ width: sidebarWidth }}
      className="relative flex shrink-0 flex-col bg-canvas"
    >
      {menu && menuTask && (
        <TaskContextMenu
          taskId={menuTask.id}
          anchor={menu.anchor}
          onClose={closeMenu}
          items={[
            {
              testId: "task-membership",
              label: menuTask.projectId === null ? "移入项目" : "移出项目",
              onSelect: () => props.onMembership(menuTask.id),
            },
            {
              testId: "rename-button",
              label: "重命名",
              onSelect: () => {
                setEditingTitle(menuTask.title);
                setEditingId(menuTask.id);
              },
            },
            {
              testId:
                menuTask.archivedAt === null
                  ? "archive-button"
                  : "unarchive-button",
              label: menuTask.archivedAt === null ? "归档" : "恢复",
              onSelect: () =>
                props.onArchive(menuTask.id, menuTask.archivedAt === null),
            },
          ]}
        />
      )}
      {projectMenu && (
        <TaskContextMenu
          menuLabel="项目操作"
          anchor={projectMenu.anchor}
          onClose={closeProjectMenu}
          items={[
            {
              testId: "project-remove-menu",
              label: "移除项目",
              onSelect: () => props.onRemoveProject!(projectMenu.projectId),
            },
          ]}
        />
      )}
      <div className="relative flex items-center justify-between pl-3 pr-2 py-2.5">
        <h2 className="text-sm font-medium text-fg">任务列表</h2>
        <div className="flex items-center gap-1">
          {/* 任务搜索（ADR 0018 迁入，原标题栏入口）：添加项目之前；
              弹层 fixed 贴视口，从侧栏头部下方展开 */}
          <TaskSearch
            recordsRevision={props.searchRecordsRevision}
            onSelect={props.onSelect}
          />
          <button
            type="button"
            data-testid="add-project"
            title="添加项目"
            aria-label="添加项目"
            className="flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg"
            onClick={props.onAddProject}
          >
            <FolderPlusIcon />
          </button>
          {/* 单一「新建任务」按钮：直达新建任务页（独立入口语境，
              归属在页面内选——ADR 0026 顶栏菜单退役，单击不再弹菜单） */}
          <button
            type="button"
            data-testid="new-task"
            disabled={props.creating}
            title="新建任务"
            aria-label="新建任务"
            className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => props.onCreate()}
          >
            <PlusIcon />
          </button>
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4">
          <p className="text-center text-xs text-fg-subtle">
            暂无任务
            <br />
            点右上角 + 新建任务，首次发送才建立工作区
          </p>
        </div>
      ) : (
        <ul
          className="flex-1 overflow-y-auto px-2 pb-2"
          data-testid="task-list"
        >
          {groups.map((group) => renderGroup(group))}
        </ul>
      )}
      {/* 拖拽分隔条（右栏 rail-separator 同款交互：拖拽/双击复位/←→微调）。
          骑缝 absolute 定位（-right-1.5 压在正文列上）：不占 flex 布局——
          占位会恒压窄正文容器 6px，width-tiers 的 @min-[1280px]/task 断点
          在临界窗口宽下掉档（6xl→4xl，2026-11-19 实测回归）。 */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整任务列表宽度"
        data-testid="sidebar-separator"
        tabIndex={0}
        title="拖动调整任务列表宽度（正文有最小宽度限制）；双击复位"
        onPointerDown={startDrag}
        onPointerMove={onDragMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
        onKeyDown={onSeparatorKeyDown}
        className={`absolute inset-y-0 -right-1.5 z-10 w-1.5 cursor-col-resize select-none transition-colors ${
          // D 语言：平时隐形融入画布，hover/拖动现形为 fg 淡色条（同右栏）
          dragging ? "bg-fg/15" : "hover:bg-fg/15"
        }`}
      />
    </aside>
  );
}
