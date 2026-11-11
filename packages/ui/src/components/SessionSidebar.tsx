import { useState, type KeyboardEvent } from 'react';

import type { SessionRecord } from '@codexlike/agent-core';

import { groupSessionsByProject } from '../lib/project-groups';

function toggleKey(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}

/**
 * 左栏：单一项目树（GLOSSARY「项目」，ADR 0005）。
 * 项目组 = 同一工作区目录（worktree 会话按原始仓库路径）自动聚合的会话分组，
 * 组头常驻、项目永不消失；组内活跃会话在上、「已归档」子折叠在下（工单 07
 * 的底部独立归档区已并入各组）。分组与排序见 lib/project-groups（纯派生，无持久实体）。
 * 会话项提供重命名 / 归档操作，与 /rename /archive 走同一 IPC 通道。
 */
export function SessionSidebar(props: {
  sessions: SessionRecord[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  creating: boolean;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string, archived: boolean) => void;
}) {
  // 折叠状态仅存组件内存（与刷新后全展开的既有行为一致，不持久化）
  const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [expandedArchived, setExpandedArchived] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  const groups = groupSessionsByProject(props.sessions);

  function submitRename(id: string) {
    const title = editingTitle.trim();
    setEditingId(null);
    if (title !== '') {
      props.onRename(id, title);
    }
  }

  function onRenameKeyDown(event: KeyboardEvent<HTMLInputElement>, id: string) {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitRename(id);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setEditingId(null);
    }
  }

  function renderSessionItem(session: SessionRecord) {
    return (
      <li key={session.id} className="group relative mt-1">
        {editingId === session.id ? (
          <input
            data-testid="rename-input"
            value={editingTitle}
            autoFocus
            onChange={(event) => setEditingTitle(event.target.value)}
            onKeyDown={(event) => onRenameKeyDown(event, session.id)}
            onBlur={() => submitRename(session.id)}
            className="w-full rounded border border-sky-700 bg-slate-950 px-2 py-2 text-sm text-slate-100"
          />
        ) : (
          <button
            type="button"
            data-testid="session-item"
            className={`flex w-full items-center justify-between gap-2 rounded px-2 py-2 text-left text-sm ${
              session.id === props.currentId
                ? 'bg-sky-800/40 text-slate-100'
                : 'text-slate-300 hover:bg-slate-800/70'
            }`}
            onClick={() => props.onSelect(session.id)}
          >
            <span className="truncate" title={session.workspacePath}>
              {session.title}
            </span>
            <span className="flex shrink-0 items-center gap-1">
              {session.workspaceMode === 'worktree' && (
                <span
                  data-testid="worktree-badge"
                  title={`托管 Worktree：${session.workspacePath}`}
                  className="rounded bg-violet-900/60 px-1.5 py-0.5 text-[10px] text-violet-300"
                >
                  worktree
                </span>
              )}
              {session.status === 'streaming' ? (
                <span className="shrink-0 rounded bg-emerald-900/60 px-1.5 py-0.5 text-[10px] text-emerald-300">
                  运行中
                </span>
              ) : session.status === 'waiting-approval' ? (
                <span className="shrink-0 rounded bg-amber-900/60 px-1.5 py-0.5 text-[10px] text-amber-300">
                  等待审批
                </span>
              ) : null}
            </span>
          </button>
        )}
        {editingId !== session.id && (
          <span className="absolute right-1 top-1/2 hidden -translate-y-1/2 gap-1 group-hover:flex">
            <button
              type="button"
              data-testid="rename-button"
              title="重命名（/rename）"
              className="rounded bg-slate-800/90 px-1.5 py-0.5 text-[10px] text-slate-300 hover:text-sky-300"
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
              className="rounded bg-slate-800/90 px-1.5 py-0.5 text-[10px] text-slate-300 hover:text-amber-300"
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
          data-testid="project-group"
          title={group.path}
          className="mt-2 flex w-full items-center gap-1 rounded px-1 py-1 text-left text-xs font-medium text-slate-400 hover:bg-slate-800/70 hover:text-slate-200"
          onClick={() =>
            setCollapsedProjects((prev) => toggleKey(prev, group.key))
          }
        >
          <span className="w-3 shrink-0 text-center text-slate-500">
            {expanded ? '▾' : '▸'}
          </span>
          <span className="truncate">{group.name}</span>
          <span className="ml-auto shrink-0 text-[10px] text-slate-600">
            {group.active.length}
            {group.archived.length > 0 && ` · 归档 ${group.archived.length}`}
          </span>
        </button>
        {expanded && (
          <ul className="pl-2">
            {group.active.map((session) => renderSessionItem(session))}
          </ul>
        )}
        {expanded && group.archived.length > 0 && (
          <div className="pl-3">
            <button
              type="button"
              data-testid="toggle-archived"
              className="w-full rounded px-2 py-1 text-left text-xs text-slate-500 hover:text-slate-300"
              onClick={() =>
                setExpandedArchived((prev) => toggleKey(prev, group.key))
              }
            >
              {archivedOpen ? '收起' : '展开'}已归档（{group.archived.length}）
            </button>
            {archivedOpen && (
              <ul className="mt-1" data-testid="archived-list">
                {group.archived.map((session) => (
                  <li
                    key={session.id}
                    className="mt-1 flex items-center justify-between gap-2 rounded px-2 py-1.5 text-sm text-slate-500"
                  >
                    <span className="truncate" title={session.workspacePath}>
                      {session.title}
                    </span>
                    <button
                      type="button"
                      data-testid="unarchive-button"
                      title="取消归档，回到项目活跃列表"
                      className="shrink-0 rounded bg-slate-800/90 px-1.5 py-0.5 text-[10px] text-slate-300 hover:text-sky-300"
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
    <aside className="flex w-64 shrink-0 flex-col border-r border-slate-800 bg-slate-900/50">
      <div className="flex items-center justify-between px-3 py-3">
        <h2 className="text-sm font-medium text-slate-200">会话</h2>
        <button
          type="button"
          data-testid="new-session"
          disabled={props.creating}
          title="选择工作区目录，新建会话"
          className="rounded bg-sky-700 px-2 py-1 text-xs text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-60"
          onClick={props.onCreate}
        >
          {props.creating ? '创建中…' : '+ 新建会话'}
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4">
          <p className="text-center text-xs text-slate-600">
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
