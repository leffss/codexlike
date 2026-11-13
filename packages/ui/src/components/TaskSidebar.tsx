import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type KeyboardEvent,
} from "react";

import type { ProjectRecord } from "@codexlike/agent-core";
import type { TaskListItem } from "@codexlike/desktop/ipc";
import { TaskActivityBadge } from "./TaskActivityBadge";
import { TaskContextMenu, type TaskMenuAnchor } from "./TaskContextMenu";

import { groupTasksByProject } from "../lib/project-groups";
import { formatRelativeTime } from "../lib/relative-time";

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
      width="14"
      height="14"
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

/** 独立会话分区的气泡图标（不属于任何项目的会话，与项目文件夹图标区分） */
function StandaloneIcon() {
  return (
    <svg
      width="14"
      height="14"
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

/**
 * 左栏：独立会话分区与显式项目列表（ADR 0010）。
 * 项目组头不依赖会话存在；归属只看 projectId，绝不按目录自动聚合。
 * 组内活跃会话在上、「已归档」子折叠在下。
 * 会话标题优先占用单行空间，最近使用时间收进提示；后台输出不改变顺序。
 * 整理操作收进右键菜单，键盘与鼠标均可访问；
 * 重命名 / 归档与 /rename /archive 走同一 IPC 通道。
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
}) {
  const [standaloneCollapsed, setStandaloneCollapsed] = useState(false);
  const [expandedArchived, setExpandedArchived] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [menu, setMenu] = useState<{
    sessionId: string;
    projectId: TaskListItem["projectId"];
    archivedAt: TaskListItem["archivedAt"];
    anchor: TaskMenuAnchor;
  } | null>(null);
  const menuTask = props.tasks.find((task) => task.id === menu?.sessionId);
  const closeMenu = useCallback(
    (restoreFocus: boolean) => {
      if (restoreFocus && menu) {
        const active = document.activeElement;
        const activeMenu =
          active instanceof HTMLElement
            ? active.closest<HTMLElement>(
                "[data-testid='session-context-menu']"
              )
            : null;
        if (
          (active === document.body ||
            activeMenu?.dataset.sessionId === menu.sessionId) &&
          !document.querySelector("[role='dialog'][aria-modal='true']")
        ) {
          const taskTarget = Array.from(
            document.querySelectorAll<HTMLElement>("[data-session-select]")
          ).find((element) => element.dataset.sessionId === menu.sessionId);
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
              document.querySelector<HTMLElement>(
                "[data-testid='new-session']"
              ));
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

  // 全列表共享的分钟级时钟：相对时间文案随时间推移刷新（非每行一个定时器）
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

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
        data-testid="session-row"
        data-session-id={task.id}
        className={`group/task relative mt-0.5 flex items-center rounded-md ${
          task.id === props.currentId
            ? "bg-selected text-fg"
            : "text-fg-muted hover:bg-hover hover:text-fg"
        }`}
        onContextMenu={(event) => {
          if (editingId === task.id) return;
          event.preventDefault();
          const target = event.currentTarget.querySelector<HTMLButtonElement>(
            "[data-session-select]"
          );
          if (!target) return;
          setMenu({
            sessionId: task.id,
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
            sessionId: task.id,
            projectId: task.projectId,
            archivedAt: task.archivedAt,
            anchor: { x: rect.left, y: rect.bottom, target },
          });
        }}
      >
        {editingId === task.id ? (
          <input
            data-testid="rename-input"
            aria-label="会话名称"
            value={editingTitle}
            autoFocus
            onChange={(event) => setEditingTitle(event.target.value)}
            onKeyDown={(event) => onRenameKeyDown(event, task.id)}
            onBlur={() => submitRename(task.id)}
            className="w-full rounded border border-accent bg-code-bg px-2 py-1.5 text-sm text-fg outline-none"
          />
        ) : (
          <>
            <button
              type="button"
              data-testid={archived ? "archived-session-item" : "session-item"}
              data-session-id={task.id}
              data-session-select="true"
              aria-current={task.id === props.currentId ? "page" : undefined}
              aria-haspopup="menu"
              aria-expanded={menu?.sessionId === task.id}
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1.5 pl-2 pr-1 text-left text-sm"
              onClick={() => props.onSelect(task.id)}
            >
              <span
                data-testid="session-label"
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
            <button
              type="button"
              data-testid="pin-button"
              aria-pressed={task.pinned ?? false}
              aria-label={task.pinned ? "取消置顶" : "置顶会话"}
              title={task.pinned ? "取消置顶" : "置顶会话"}
              className={`mr-1 flex h-6 w-5 shrink-0 items-center justify-center rounded hover:text-accent ${
                task.pinned
                  ? "text-accent"
                  : "pointer-events-none text-fg-muted opacity-0 group-hover/task:pointer-events-auto group-hover/task:opacity-100 group-focus-within/task:pointer-events-auto group-focus-within/task:opacity-100"
              }`}
              onClick={() => props.onPin(task.id, !task.pinned)}
            >
              {/* 图钉两态：已置顶实心常显（accent 色），未置顶空心仅悬停出现 */}
              <svg
                width="12"
                height="12"
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
        >
          <button
            type="button"
            data-testid={
              group.projectId === null ? "standalone-group" : "project-group"
            }
            title={group.path}
            aria-expanded={expanded}
            className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-1.5 text-left text-xs font-semibold"
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
              data-testid="project-session-count"
              className={`col-start-1 row-start-1 px-1 text-right text-[10px] text-fg-subtle ${
                group.projectId !== null
                  ? "group-hover/header:invisible group-focus-within/header:invisible"
                  : ""
              }`}
            >
              {group.active.length}
              {group.archived.length > 0 && ` · 归档 ${group.archived.length}`}
            </span>
            {group.projectId !== null && (
              <span className="pointer-events-none col-start-1 row-start-1 flex justify-end gap-0.5 opacity-0 group-hover/header:pointer-events-auto group-hover/header:opacity-100 group-focus-within/header:pointer-events-auto group-focus-within/header:opacity-100">
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
                  data-testid="project-new-session"
                  title="在此项目新建会话"
                  aria-label="在此项目新建会话"
                  disabled={props.creating}
                  className="rounded px-1.5 py-0.5 text-xs text-accent hover:bg-hover disabled:opacity-50"
                  onClick={() => props.onCreateInProject(group.projectId!)}
                >
                  +
                </button>
                {props.onRemoveProject && (
                  <button
                    type="button"
                    data-testid="project-remove"
                    title="移除项目"
                    aria-label="移除项目"
                    className="rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-hover hover:text-warn-fg"
                    onClick={() => props.onRemoveProject!(group.projectId!)}
                  >
                    ×
                  </button>
                )}
              </span>
            )}
          </span>
        </div>
        {/* 无竖线缩进导轨：会话标题起点对齐原竖线位置（ml-7 + 行内 pl-2），为标题让出宽度 */}
        {expanded && (
          <div data-testid="group-sessions" className="ml-7">
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
    <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-surface-muted">
      {menu && menuTask && (
        <TaskContextMenu
          sessionId={menuTask.id}
          anchor={menu.anchor}
          onClose={closeMenu}
          items={[
            {
              testId: "session-membership",
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
      <div className="flex items-center justify-between px-3 py-3">
        <h2 className="text-sm font-medium text-fg">会话</h2>
        <button
          type="button"
          data-testid="new-session"
          disabled={props.creating}
          title="新建独立会话草稿"
          className="rounded-md bg-accent px-2 py-1 text-xs text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
          onClick={props.onCreate}
        >
          {props.creating ? "创建中…" : "+ 新建独立会话"}
        </button>
      </div>

      <button
        type="button"
        data-testid="add-project"
        className="mx-3 rounded border border-line px-2 py-1 text-xs text-fg-muted hover:text-accent"
        onClick={props.onAddProject}
      >
        添加项目
      </button>
      {groups.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4">
          <p className="text-center text-xs text-fg-subtle">
            暂无会话
            <br />
            点击「+ 新建独立会话」准备输入，首次发送才建立工作区
          </p>
        </div>
      ) : (
        <ul
          className="flex-1 overflow-y-auto px-2 pb-2"
          data-testid="session-list"
        >
          {groups.map((group) => renderGroup(group))}
        </ul>
      )}
    </aside>
  );
}
