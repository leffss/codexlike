import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import type { UiItem } from "../lib/session-view";
import { ApprovalCard } from "./ApprovalCard";
import { SubagentCard } from "./SubagentCard";
import { ToolCallCard } from "./ToolCallCard";

/** 中栏上部：消息流。用户消息、助手 markdown 流式回复、工具卡片、审批卡片、错误提示、压缩摘要卡片。 */
export function MessageStream(props: {
  items: UiItem[];
  /** /compact 压缩进行中提示（不可重复触发期间显示在消息流底部） */
  compacting?: boolean;
  emptyHint?: ReactNode;
  /** 审批响应（三键）：传 null 时等待中的审批卡片只读展示 */
  onApprovalRespond?:
    ((id: string, decision: "approve" | "reject" | "always") => void) | null;
}) {
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto bg-slate-950/40 px-4 py-4"
      data-testid="message-stream"
    >
      {props.items.length === 0 && props.compacting !== true ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-600">
          <p className="text-sm">消息流为空</p>
          {props.emptyHint}
        </div>
      ) : (
        <ol className="mx-auto flex max-w-3xl flex-col gap-4">
          {props.items.map((item) =>
            item.kind === "tool-call" ? (
              <ToolCallCard key={`tool-${item.id}`} call={item} />
            ) : item.kind === "approval" ? (
              <ApprovalCard
                key={`approval-${item.id}`}
                approval={item}
                onRespond={props.onApprovalRespond ?? (() => {})}
              />
            ) : item.kind === "subagent" ? (
              <SubagentCard key={`subagent-${item.id}`} subagent={item} />
            ) : (
              <MessageBubble key={item.id} message={item} />
            )
          )}
          {props.compacting === true && (
            <li
              data-testid="compacting-indicator"
              className="flex items-center gap-2 rounded-lg border border-indigo-800/60 bg-indigo-950/40 px-3 py-2 text-xs text-indigo-300"
            >
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
              正在压缩历史为摘要…（压缩期间输入已暂停）
            </li>
          )}
        </ol>
      )}
    </div>
  );
}

function MessageBubble(props: {
  message: Exclude<
    UiItem,
    { kind: "tool-call" } | { kind: "approval" } | { kind: "subagent" }
  >;
}) {
  const { message } = props;

  if (message.role === "user") {
    return (
      <li
        data-testid="message-user"
        className="ml-auto max-w-[85%] rounded-lg bg-sky-800/50 px-3 py-2 text-sm whitespace-pre-wrap text-slate-100"
      >
        {message.content}
      </li>
    );
  }

  if (message.role === "error") {
    return (
      <li
        data-testid="message-error"
        className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300"
      >
        {message.content}
      </li>
    );
  }

  if (message.role === "status") {
    // 本地命令反馈（/status、/rename 结果等）：不落库、不进模型上下文
    return (
      <li
        data-testid="message-status"
        className="rounded-lg border border-slate-700/60 bg-slate-900/70 px-3 py-2 text-xs whitespace-pre-wrap text-slate-400"
      >
        {message.content}
      </li>
    );
  }

  if (message.role === "compact-summary") {
    // /compact 摘要卡片：被压缩的历史折叠显示，点击展开摘要全文（工单 08）
    return (
      <li data-testid="message-compact-summary">
        <details className="rounded-lg border border-indigo-900/60 bg-indigo-950/30 px-3 py-2 text-xs text-indigo-300">
          <summary className="cursor-pointer select-none">
            已压缩的历史（点击展开摘要全文）
          </summary>
          <div className="markdown mt-2 rounded border border-indigo-900/40 bg-slate-900/60 px-3 py-2 text-sm text-slate-200">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
            >
              {message.content}
            </ReactMarkdown>
          </div>
        </details>
      </li>
    );
  }

  return (
    <li data-testid="message-assistant" className="max-w-full">
      <div className="markdown rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3 text-sm">
        {message.reasoning !== undefined && message.reasoning !== "" && (
          // 思考过程折叠块（GLOSSARY「思考档位」）：与正文分离、默认收起、
          // 可展开观察流式进度；终态（完成/中断/出错）由消息标志收敛，无残留进行中
          <details
            data-testid="thinking-block"
            className="mb-2 rounded-lg border border-violet-900/60 bg-violet-950/30 px-3 py-2 text-xs text-violet-300"
          >
            <summary
              data-testid="thinking-toggle"
              className="flex cursor-pointer select-none items-center gap-2"
            >
              {message.streaming === true && (
                <span
                  data-testid="thinking-indicator"
                  className="inline-block h-2 w-2 animate-pulse rounded-full bg-violet-400"
                  aria-label="思考中"
                />
              )}
              思考过程（点击展开 / 收起）
            </summary>
            <div
              data-testid="thinking-content"
              className="mt-2 whitespace-pre-wrap border-t border-violet-900/40 pt-2 text-slate-300"
            >
              {message.reasoning}
            </div>
          </details>
        )}
        <div data-testid="assistant-content">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
          >
            {message.content}
          </ReactMarkdown>
        </div>
        {message.streaming === true && (
          <span className="markdown-cursor" aria-label="正在生成" />
        )}
        {message.interrupted === true && (
          <p className="mt-2 text-xs text-amber-400">
            （已中断，以上为部分回复）
          </p>
        )}
      </div>
    </li>
  );
}
