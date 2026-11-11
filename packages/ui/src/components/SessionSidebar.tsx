import { useState, type KeyboardEvent } from 'react';

import type { SessionRecord } from '@codexlike/agent-core';

/**
 * 左栏：会话列表（GLOSSARY「会话」）。新建时经原生目录选择器绑定工作区。
 * 工单 07：默认不显示已归档会话（/archive），底部可展开已归档列表；
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
  const [showArchived, setShowArchived] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  const active = props.sessions.filter(
    (session) => session.archivedAt === null,
  );
  const archived = props.sessions.filter(
    (session) => session.archivedAt !== null,
  );

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

      {active.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4">
          <p className="text-center text-xs text-slate-600">
            暂无会话
            <br />
            点击「+ 新建会话」选择工作区目录开始
          </p>
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto px-2 pb-2" data-testid="session-list">
          {active.map((session) => (
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
                    title="归档（/archive）：不在列表显示"
                    className="rounded bg-slate-800/90 px-1.5 py-0.5 text-[10px] text-slate-300 hover:text-amber-300"
                    onClick={() => props.onArchive(session.id, true)}
                  >
                    归档
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {archived.length > 0 && (
        <div className="border-t border-slate-800 px-2 py-2">
          <button
            type="button"
            data-testid="toggle-archived"
            className="w-full rounded px-2 py-1 text-left text-xs text-slate-500 hover:text-slate-300"
            onClick={() => setShowArchived((prev) => !prev)}
          >
            {showArchived ? '收起' : '展开'}已归档（{archived.length}）
          </button>
          {showArchived && (
            <ul className="mt-1" data-testid="archived-list">
              {archived.map((session) => (
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
                    title="取消归档，回到会话列表"
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
    </aside>
  );
}
