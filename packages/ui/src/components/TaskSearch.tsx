import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TaskSearchResult } from "@codexlike/agent-core";

/** 独立搜索入口：不依赖侧栏分组、折叠或当前加载的任务历史。 */
export function TaskSearch(props: {
  onSelect: (id: string) => void;
  recordsRevision?: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [results, setResults] = useState<TaskSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  /** 面板水平偏移（迁入标题栏，票01）：开关贴近窗口边缘时把面板收口回视口 */
  const wrapRef = useRef<HTMLDivElement>(null);
  const [panelOffset, setPanelOffset] = useState(0);

  useEffect(() => {
    setResults([]);
    setError(null);
    setLoading(false);
    if (!open || !query.trim()) return;
    setLoading(true);
    // 每次查询及关闭/清空都会淘汰旧请求；成功和失败都不能覆盖后来的查询。
    let active = true;
    void window.codexlike.tasks.search(query, includeArchived).then(
      (found) => {
        if (!active) return;
        setResults(found);
        setLoading(false);
      },
      (reason: unknown) => {
        if (!active) return;
        setError(
          `搜索失败：${reason instanceof Error ? reason.message : String(reason)}`
        );
        setLoading(false);
      }
    );
    return () => {
      active = false;
    };
  }, [open, query, includeArchived, revision, props.recordsRevision]);

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const anchor = wrap.getBoundingClientRect();
      const width = Math.min(384, window.innerWidth * 0.8);
      const margin = 8;
      const maxLeft = Math.max(margin, window.innerWidth - margin - width);
      const desired = Math.min(Math.max(anchor.left, margin), maxLeft);
      setPanelOffset(desired - anchor.left);
    }
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        data-testid="task-search-toggle"
        aria-expanded={open}
        className="rounded border border-line px-3 py-1 text-xs text-fg-muted hover:text-accent"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "关闭搜索" : "搜索任务"}
      </button>
      {open && (
        <section
          aria-label="跨项目任务搜索"
          className="absolute top-full z-20 mt-2 w-96 max-w-[80vw] whitespace-normal rounded-lg border border-line bg-surface p-3 shadow-xl"
          style={{ left: panelOffset }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setRevision((value) => value + 1);
            }}
          >
            <label className="block text-xs text-fg-muted">
              搜索所有项目与独立任务
              <input
                autoFocus
                type="search"
                data-testid="task-search-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="输入标题或消息正文"
                className="mt-2 block w-full rounded border border-line bg-code-bg px-2 py-1.5 text-sm text-fg outline-none focus:border-accent"
              />
            </label>
            <div className="mt-2 flex items-center justify-between text-xs text-fg-muted">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  data-testid="task-search-archived"
                  checked={includeArchived}
                  onChange={(event) => setIncludeArchived(event.target.checked)}
                />
                包含已归档
              </label>
              <button
                type="submit"
                className="text-accent"
                data-testid="task-search-refresh"
              >
                重新查询
              </button>
            </div>
          </form>
          <p
            role="status"
            aria-live="polite"
            data-testid="task-search-status"
            className="my-2 text-xs text-fg-subtle"
          >
            {!query.trim()
              ? "输入标题或消息正文开始搜索"
              : loading
                ? "正在搜索…"
                : (error ??
                  (results.length
                    ? `找到 ${results.length} 个任务`
                    : "没有匹配的任务"))}
          </p>
          <ul className="max-h-80 space-y-1 overflow-y-auto">
            {results.map((result) => (
              <li key={result.id}>
                <button
                  type="button"
                  data-testid="task-search-result"
                  data-task-id={result.id}
                  className="w-full rounded px-2 py-2 text-left hover:bg-hover focus:bg-hover"
                  onClick={() => {
                    setOpen(false);
                    props.onSelect(result.id);
                  }}
                >
                  <span
                    className="block truncate text-sm text-fg"
                    title={result.title}
                  >
                    {result.title}
                  </span>
                  <span className="block truncate text-xs text-fg-muted">
                    {result.projectId === null
                      ? "独立任务"
                      : `项目 · ${result.projectName ?? "未知项目"}`}
                    {result.archivedAt !== null && " · 已归档"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
