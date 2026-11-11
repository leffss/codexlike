import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import type { UiSubagent } from "../lib/session-view";
import { summarizeToolCall } from "../lib/tool-summary";

/**
 * 子代理嵌套卡片（工单 13，GLOSSARY「子代理」）：
 * 排队（并发上限等待）→ 运行中（当前活动工具 + 已用时）→ 完成（最终报告可展开）。
 */
export function SubagentCard(props: { subagent: UiSubagent }) {
  const { subagent } = props;
  const [expanded, setExpanded] = useState(subagent.state === "done");
  const [nowTick, setNowTick] = useState(() => Date.now());

  // 运行中每秒刷新「已用时」；结束后停止计时
  useEffect(() => {
    if (subagent.state !== "running") {
      return;
    }
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [subagent.state]);

  // 报告到达自动展开（流式路径卡片以排队态挂载，完成时用户最关心报告）
  useEffect(() => {
    if (subagent.state === "done") {
      setExpanded(true);
    }
  }, [subagent.state]);

  const statusLabel =
    subagent.state === "queued"
      ? "排队中（并发上限已满）"
      : subagent.state === "running"
        ? "运行中"
        : subagent.ok === false
          ? "失败"
          : "完成";
  const statusClass =
    subagent.state === "done"
      ? subagent.ok === false
        ? "text-red-400"
        : "text-emerald-400"
      : "text-amber-400";

  // 当前活动工具：最后一个 running 的子代理工具调用
  const activeTool = [...subagent.tools]
    .reverse()
    .find((tool) => tool.running === true);
  const elapsed = formatElapsed(subagent, nowTick);
  const hasReasoning =
    subagent.reasoning !== undefined && subagent.reasoning !== "";

  return (
    <li
      data-testid="subagent-card"
      data-subagent-state={subagent.state}
      className="max-w-full rounded-lg border border-violet-950 bg-violet-950/20 text-sm"
    >
      <button
        type="button"
        data-testid="subagent-toggle"
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-violet-950/40"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        <span className="rounded bg-violet-900/70 px-1.5 py-0.5 font-mono text-xs text-violet-300">
          子代理
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-400">
          {subagent.task === "" ? "（任务描述缺失）" : subagent.task}
        </span>
        {subagent.state === "running" && (
          <span
            data-testid="subagent-elapsed"
            className="shrink-0 font-mono text-xs text-amber-300/80"
          >
            {elapsed}
          </span>
        )}
        <span
          data-testid="subagent-status"
          className={`shrink-0 text-xs ${statusClass}`}
        >
          {subagent.state === "running" && (
            <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400 align-middle" />
          )}
          {statusLabel}
        </span>
        <span className="shrink-0 text-slate-500">{expanded ? "▾" : "▸"}</span>
      </button>

      {subagent.state === "running" && (
        <div className="border-t border-violet-950 px-3 py-2 text-xs text-slate-400">
          {hasReasoning && (
            <SubagentThinking reasoning={subagent.reasoning!} streaming />
          )}
          {activeTool !== undefined ? (
            <p>
              当前工具：
              <span className="ml-1 rounded bg-slate-800 px-1.5 py-0.5 font-mono text-xs text-sky-300">
                {activeTool.toolName}
              </span>
              <span className="ml-2 font-mono text-slate-500">
                {summarizeToolCall(activeTool.toolName, activeTool.arguments)}
              </span>
            </p>
          ) : (
            <p>正在思考…</p>
          )}
          {subagent.tools.length > 0 && (
            <p className="mt-1 text-slate-500">
              已执行 {subagent.tools.length} 次工具调用
            </p>
          )}
        </div>
      )}

      {expanded && subagent.state === "done" && (
        <div className="border-t border-violet-950 px-3 py-2">
          {hasReasoning && <SubagentThinking reasoning={subagent.reasoning!} />}
          <div className="text-xs text-slate-500">最终报告</div>
          <div
            data-testid="subagent-report"
            className="markdown mt-1 max-h-72 overflow-y-auto rounded border border-violet-950/60 bg-slate-900/60 px-3 py-2 text-sm text-slate-200"
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
            >
              {subagent.report ?? ""}
            </ReactMarkdown>
          </div>
          {subagent.tools.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-slate-500">
                子代理的工具调用（{subagent.tools.length} 次）
              </summary>
              <ul className="mt-1 flex flex-col gap-1">
                {subagent.tools.map((tool) => (
                  <li
                    key={tool.id}
                    className="flex items-center gap-2 rounded bg-slate-950/50 px-2 py-1 font-mono text-xs"
                  >
                    <span className="text-sky-300">{tool.toolName}</span>
                    <span className="min-w-0 flex-1 truncate text-slate-500">
                      {summarizeToolCall(tool.toolName, tool.arguments)}
                    </span>
                    <span
                      className={
                        tool.isError ? "text-red-400" : "text-emerald-400"
                      }
                    >
                      {tool.isError ? "失败" : "完成"}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {expanded && subagent.state === "queued" && (
        <div className="border-t border-violet-950 px-3 py-2 text-xs text-amber-300/80">
          并发上限已满：该委派在队列中等待，前面的子代理结束后自动开跑。
        </div>
      )}
    </li>
  );
}

/** 已用时（运行中实时刷新；恢复的卡片无 startedAt 则不显示数字） */
function formatElapsed(subagent: UiSubagent, now: number): string {
  if (subagent.startedAt === null) {
    return "";
  }
  const started = Date.parse(subagent.startedAt);
  if (Number.isNaN(started)) {
    return "";
  }
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/**
 * 子代理思考折叠块（思考档位 03）：与主会话思考块同构——默认收起、
 * 流式运行中带思考指示器；与报告文本分离，仅运行期展示（历史恢复不重建）。
 */
function SubagentThinking(props: { reasoning: string; streaming?: boolean }) {
  const { reasoning, streaming } = props;
  return (
    <details
      data-testid="subagent-thinking-block"
      className="mb-2 rounded-lg border border-violet-900/60 bg-violet-950/30 px-3 py-2 text-xs text-violet-300"
    >
      <summary
        data-testid="subagent-thinking-toggle"
        className="flex cursor-pointer select-none items-center gap-2"
      >
        {streaming === true && (
          <span
            data-testid="subagent-thinking-indicator"
            className="inline-block h-2 w-2 animate-pulse rounded-full bg-violet-400"
            aria-label="思考中"
          />
        )}
        思考过程（点击展开 / 收起）
      </summary>
      <div
        data-testid="subagent-thinking-content"
        className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap border-t border-violet-900/40 pt-2 text-slate-300"
      >
        {reasoning}
      </div>
    </details>
  );
}
