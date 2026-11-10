import type { SessionRecord } from '@codexlike/agent-core';

/** 左栏：会话列表（GLOSSARY「会话」）。新建时经原生目录选择器绑定工作区。 */
export function SessionSidebar(props: {
  sessions: SessionRecord[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  creating: boolean;
}) {
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

      {props.sessions.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4">
          <p className="text-center text-xs text-slate-600">
            暂无会话
            <br />
            点击「+ 新建会话」选择工作区目录开始
          </p>
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto px-2 pb-2" data-testid="session-list">
          {props.sessions.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                data-testid="session-item"
                className={`mt-1 flex w-full items-center justify-between gap-2 rounded px-2 py-2 text-left text-sm ${
                  session.id === props.currentId
                    ? 'bg-sky-800/40 text-slate-100'
                    : 'text-slate-300 hover:bg-slate-800/70'
                }`}
                onClick={() => props.onSelect(session.id)}
              >
                <span className="truncate" title={session.workspacePath}>
                  {session.title}
                </span>
                {session.status === 'streaming' ? (
                  <span className="shrink-0 rounded bg-emerald-900/60 px-1.5 py-0.5 text-[10px] text-emerald-300">
                    运行中
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
