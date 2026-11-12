import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import { useCollapseState } from "../lib/collapse-memory";
import { markdownComponents } from "../lib/markdown";
import type { SubagentSegment } from "../lib/session-view";
import { thinkingSummary } from "../lib/thinking-summary";
import { summarizeToolCall } from "../lib/tool-summary";

/**
 * 子代理嵌套卡片（工单 13，GLOSSARY「子代理」；票 04 开合规则）：
 * 排队（并发上限等待）→ 运行中（当前活动工具 + 已用时）→ 完成（最终报告可展开）。
 * 运行→完成边沿自动收起一次：默认收起（报告折叠），用户已手动操作过则
 * 记忆值不覆盖（开合是渲染层内存态，滚动、切换会话不丢）。
 */
export function SubagentCard(props: { subagent: SubagentSegment }) {
  const { subagent } = props;
  const { open: expanded, toggle } = useCollapseState(
    `subagent-${subagent.id}`,
    false
  );
  const [nowTick, setNowTick] = useState(() => Date.now());

  // 运行中每秒刷新「已用时」；结束后停止计时
  useEffect(() => {
    if (subagent.state !== "running") {
      return;
    }
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
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
        ? "text-danger-fg"
        : "text-ok-fg"
      : "text-warn-fg";

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
      className="max-w-full rounded-lg border border-subagent-fg/30 bg-subagent-bg text-sm"
    >
      <button
        type="button"
        data-testid="subagent-toggle"
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-hover"
        onClick={toggle}
        aria-expanded={expanded}
      >
        <span className="rounded bg-subagent-bg px-1.5 py-0.5 font-mono text-xs text-subagent-fg">
          子代理
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">
          {subagent.task === "" ? "（任务描述缺失）" : subagent.task}
        </span>
        {subagent.state === "running" && (
          <span
            data-testid="subagent-elapsed"
            className="shrink-0 font-mono text-xs text-warn-fg"
          >
            {elapsed}
          </span>
        )}
        <span
          data-testid="subagent-status"
          className={`shrink-0 text-xs ${statusClass}`}
        >
          {subagent.state === "running" && (
            <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warn-fg align-middle" />
          )}
          {statusLabel}
        </span>
        <span className="shrink-0 text-fg-subtle">{expanded ? "▾" : "▸"}</span>
      </button>

      {subagent.state === "running" && (
        <div className="border-t border-line px-3 py-2 text-xs text-fg-muted">
          {hasReasoning && (
            <SubagentThinking
              reasoning={subagent.reasoning!}
              streaming
              collapseKey={`subagent-thinking-${subagent.id}`}
            />
          )}
          {activeTool !== undefined ? (
            <p>
              当前工具：
              <span className="ml-1 rounded bg-code-bg px-1.5 py-0.5 font-mono text-xs text-accent">
                {activeTool.toolName}
              </span>
              <span className="ml-2 font-mono text-fg-subtle">
                {summarizeToolCall(activeTool.toolName, activeTool.arguments)}
              </span>
            </p>
          ) : (
            <p>正在思考…</p>
          )}
          {subagent.tools.length > 0 && (
            <p className="mt-1 text-fg-subtle">
              已执行 {subagent.tools.length} 次工具调用
            </p>
          )}
        </div>
      )}

      {expanded && subagent.state === "done" && (
        <div className="border-t border-line px-3 py-2">
          {hasReasoning && (
            <SubagentThinking
              reasoning={subagent.reasoning!}
              collapseKey={`subagent-thinking-${subagent.id}`}
            />
          )}
          <div className="text-xs text-fg-subtle">最终报告</div>
          <div
            data-testid="subagent-report"
            className="markdown mt-1 max-h-72 overflow-y-auto rounded border border-line bg-surface px-3 py-2 text-sm text-fg"
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={markdownComponents}
            >
              {subagent.report ?? ""}
            </ReactMarkdown>
          </div>
          {subagent.tools.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-fg-subtle">
                子代理的工具调用（{subagent.tools.length} 次）
              </summary>
              <ul className="mt-1 flex flex-col gap-1">
                {subagent.tools.map((tool) => (
                  <li
                    key={tool.id}
                    className="flex items-center gap-2 rounded bg-code-bg px-2 py-1 font-mono text-xs"
                  >
                    <span className="text-accent">{tool.toolName}</span>
                    <span className="min-w-0 flex-1 truncate text-fg-subtle">
                      {summarizeToolCall(tool.toolName, tool.arguments)}
                    </span>
                    <span
                      className={tool.isError ? "text-danger-fg" : "text-ok-fg"}
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
        <div className="border-t border-line px-3 py-2 text-xs text-warn-fg">
          并发上限已满：该委派在队列中等待，前面的子代理结束后自动开跑。
        </div>
      )}
    </li>
  );
}

/** 已用时（运行中实时刷新；恢复的卡片无 startedAt 则不显示数字） */
function formatElapsed(subagent: SubagentSegment, now: number): string {
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
 * 子代理思考折叠块（思考档位 03；票 02 起随委派记录落库）：与主会话思考块
 * 同构——流式运行中默认展开实时可见、结束自动收起、收起后以一行摘要回看
 * （开合按 collapseKey 记忆，与卡片自身开合互不干扰）；与报告文本分离，
 * 重启后由落盘 reasoning 重建（旧记录自然缺失，不渲染空块）。
 * 受控 <details open> 的 onToggle 记忆规则同 ThinkingBlock（见其注释）。
 */
function SubagentThinking(props: {
  reasoning: string;
  streaming?: boolean;
  collapseKey: string;
}) {
  const { reasoning, streaming } = props;
  const { open, setOpen } = useCollapseState(
    props.collapseKey,
    streaming === true
  );
  const summary = thinkingSummary(reasoning);
  return (
    <details
      data-testid="subagent-thinking-block"
      open={open}
      onToggle={(event) => {
        if (event.currentTarget.open !== open) {
          setOpen(event.currentTarget.open);
        }
      }}
      className="mb-2 rounded-lg border border-line bg-surface-muted px-3 py-2 text-xs text-fg-muted"
    >
      <summary
        data-testid="subagent-thinking-toggle"
        className="flex cursor-pointer select-none items-center gap-2"
      >
        {streaming === true && (
          <span
            data-testid="subagent-thinking-indicator"
            className="generating-spinner shrink-0"
            aria-label="思考中"
          />
        )}
        <span
          data-testid="subagent-thinking-summary"
          className="min-w-0 flex-1 truncate"
        >
          {streaming === true ? "思考中" : "已思考"}
          {summary !== "" && ` · ${summary}`}
        </span>
        <span className="shrink-0 text-fg-subtle">{open ? "▾" : "▸"}</span>
      </summary>
      <div
        data-testid="subagent-thinking-content"
        className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap border-t border-line pt-2 text-fg"
      >
        {reasoning}
        {streaming === true && (
          <span className="generating-spinner ml-1" aria-hidden="true" />
        )}
      </div>
    </details>
  );
}
