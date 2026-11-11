import { useEffect, useState, type KeyboardEvent } from "react";

import type { ProjectRecord, SessionRecord } from "@codexlike/agent-core";

import { groupSessionsByProject } from "../lib/project-groups";
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
      width="13"
      height="13"
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

/**
 * 左栏：独立会话分区与显式项目列表（ADR 0010）。
 * 项目组头不依赖会话存在；归属只看 projectId，绝不按目录自动聚合。
 * 组内活跃会话在上、「已归档」子折叠在下。
 * 会话行右侧显示相对更新时间（updatedAt「最近更新」口径，lib/relative-time），
 * 状态徽标弱化为小徽标，操作按钮 hover / 键盘聚焦时浮现；
 * 重命名 / 归档与 /rename /archive 走同一 IPC 通道。
 */
export function SessionSidebar(props: {
  sessions: SessionRecord[];
  projects: ProjectRecord[];
  onAddProject: () => void;
  onCreateInProject: (projectId: string) => void;
  currentId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  creating: boolean;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string, archived: boolean) => void;
}) {
  // 折叠状态仅存组件内存（与刷新后全展开的既有行为一致，不持久化）
  const [collapsedProjects, setCollapsedProjects] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [expandedArchived, setExpandedArchived] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  // 全列表共享的分钟级时钟：相对时间文案随时间推移刷新（非每行一个定时器）
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const groups = groupSessionsByProject(props.sessions, props.projects);

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

  function renderSessionItem(session: SessionRecord) {
    const relative = formatRelativeTime(session.updatedAt, now);
    const absoluteTime = new Date(session.updatedAt).toLocaleString("zh-CN");

    return (
      <li key={session.id} className="group relative mt-0.5">
        {editingId === session.id ? (
          <input
            data-testid="rename-input"
            value={editingTitle}
            autoFocus
            onChange={(event) => setEditingTitle(event.target.value)}
            onKeyDown={(event) => onRenameKeyDown(event, session.id)}
            onBlur={() => submitRename(session.id)}
            className="w-full rounded border border-accent bg-code-bg px-2 py-1.5 text-sm text-fg outline-none"
          />
        ) : (
          <button
            type="button"
            data-testid="session-item"
            data-session-id={session.id}
            className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm ${
              session.id === props.currentId
                ? "bg-selected text-fg"
                : "text-fg-muted hover:bg-hover hover:text-fg"
            }`}
            onClick={() => props.onSelect(session.id)}
          >
            <span className="truncate" title={session.workspacePath}>
              {session.title}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {session.workspaceMode === "worktree" && (
                <span
                  data-testid="worktree-badge"
                  title={`托管 Worktree：${session.workspacePath}`}
                  className="rounded bg-worktree-bg px-1 py-px text-[10px] text-worktree-fg"
                >
                  worktree
                </span>
              )}
              {session.status === "streaming" ? (
                <span
                  title="会话正在运行中"
                  className="flex items-center gap-1 rounded bg-ok-bg px-1 py-px text-[10px] text-ok-fg"
                >
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-ok-fg" />
                  运行中
                </span>
              ) : session.status === "waiting-user" ||
                session.status === "waiting-approval" ? (
                <span className="rounded bg-warn-bg px-1 py-px text-[10px] text-warn-fg">
                  等待用户
                </span>
              ) : null}
              {relative !== "" && (
                <span
                  className="text-[10px] text-fg-subtle"
                  title={absoluteTime}
                >
                  {relative}
                </span>
              )}
            </span>
          </button>
        )}
        {editingId !== session.id && (
          <span className="absolute right-1 top-1/2 hidden -translate-y-1/2 gap-1 group-hover:flex group-focus-within:flex">
            <button
              type="button"
              data-testid="rename-button"
              title="重命名（/rename）"
              className="rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] text-fg-muted shadow-sm hover:text-accent"
              onClick={() => {
                setEditingId(session.id);
                setEditingTitle(session.title);
              }}
            >
              重命名
            </button>
            <button
              type="button"
              data-testid="archive-button"
              title="归档（/archive）：收进本项目「已归档」"
              className="rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] text-fg-muted shadow-sm hover:text-warn-fg"
              onClick={() => props.onArchive(session.id, true)}
            >
              归档
            </button>
          </span>
        )}
      </li>
    );
  }

  function renderGroup(group: (typeof groups)[number]) {
    // 当前会话所在组强制展开：折叠过的组被激活时不失联
    const containsCurrent =
      props.currentId !== null &&
      (group.active.some((session) => session.id === props.currentId) ||
        group.archived.some((session) => session.id === props.currentId));
    const expanded = !collapsedProjects.has(group.key) || containsCurrent;
    const archivedOpen =
      expandedArchived.has(group.key) ||
      (containsCurrent &&
        group.archived.some((session) => session.id === props.currentId));

    return (
      <li key={group.key}>
        <button
          type="button"
          data-testid={
            group.projectId === null ? "standalone-group" : "project-group"
          }
          title={group.path}
          aria-expanded={expanded}
          className="mt-2 flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-xs font-medium text-fg-muted hover:bg-hover hover:text-fg"
          onClick={() =>
            setCollapsedProjects((prev) => toggleKey(prev, group.key))
          }
        >
          <span className="w-3 shrink-0 text-center text-fg-subtle">
            {expanded ? "▾" : "▸"}
          </span>
          <FolderIcon open={expanded} />
          <span className="truncate">{group.name}</span>
          <span className="ml-auto shrink-0 text-[10px] text-fg-subtle">
            {group.active.length}
            {group.archived.length > 0 && ` · 归档 ${group.archived.length}`}
          </span>
        </button>
        {group.projectId !== null && (
          <button
            type="button"
            data-testid="project-new-session"
            disabled={props.creating}
            className="ml-4 rounded px-2 py-1 text-xs text-accent hover:bg-hover"
            onClick={() => props.onCreateInProject(group.projectId!)}
          >
            + 新建会话
          </button>
        )}
        {expanded && (
          <ul className="pl-3">
            {group.active.map((session) => renderSessionItem(session))}
          </ul>
        )}
        {expanded && group.archived.length > 0 && (
          <div className="pl-4">
            <button
              type="button"
              data-testid="toggle-archived"
              className="w-full rounded px-2 py-1 text-left text-[11px] text-fg-subtle hover:text-fg-muted"
              onClick={() =>
                setExpandedArchived((prev) => toggleKey(prev, group.key))
              }
            >
              {archivedOpen ? "收起" : "展开"}已归档（{group.archived.length}）
            </button>
            {archivedOpen && (
              <ul className="mt-0.5" data-testid="archived-list">
                {group.archived.map((session) => (
                  <li
                    key={session.id}
                    className="mt-0.5 flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm text-fg-subtle hover:bg-hover"
                  >
                    <span className="truncate" title={session.workspacePath}>
                      {session.title}
                    </span>
                    <button
                      type="button"
                      data-testid="unarchive-button"
                      title="取消归档，回到项目活跃列表"
                      className="shrink-0 rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] text-fg-muted shadow-sm hover:text-accent"
                      onClick={() => props.onArchive(session.id, false)}
                    >
                      恢复
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </li>
    );
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-surface-muted">
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
          {props.creating ? "创建中…" : "+ 新建会话"}
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
            点击「+ 新建会话」选择工作区目录开始
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
