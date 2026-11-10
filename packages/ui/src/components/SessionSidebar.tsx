/**
 * 左栏：会话列表（GLOSSARY「会话」）。
 * 当前为空骨架：新建会话在后续工单（工作区选择）接入后启用。
 */
export function SessionSidebar() {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-slate-800 bg-slate-900/50">
      <div className="flex items-center justify-between px-3 py-3">
        <h2 className="text-sm font-medium text-slate-200">会话</h2>
        <button
          type="button"
          disabled
          title="会话创建将在后续版本开放"
          className="cursor-not-allowed rounded bg-slate-800 px-2 py-1 text-xs text-slate-500"
        >
          + 新建会话
        </button>
      </div>
      <div className="flex flex-1 items-center justify-center px-4">
        <p className="text-center text-xs text-slate-600">
          暂无会话
          <br />
          会话创建功能即将开放
        </p>
      </div>
    </aside>
  );
}
