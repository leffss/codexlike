import { useLayoutEffect, useRef, type ReactNode } from "react";
import type {
  ReadingPosition,
  SavedQuestionDraft,
} from "@codexlike/agent-core";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import { SESSION_CONTENT_WIDTH_CLASS } from "../lib/content-width";
import { markdownComponents } from "../lib/markdown";
import type { UiItem } from "../lib/session-view";
import { InteractionHistory } from "./InteractionHistory";
import { SubagentCard } from "./SubagentCard";
import { ToolCallCard } from "./ToolCallCard";

/** 中栏上部：消息流。用户消息、助手 markdown 流式回复、工具卡片、审批卡片、错误提示、压缩摘要卡片。 */
export function MessageStream(props: {
  items: UiItem[];
  /** /compact 压缩进行中提示（不可重复触发期间显示在消息流底部） */
  compacting?: boolean;
  emptyHint?: ReactNode;
  sessionId?: string | null;
  loading?: boolean;
  readingPosition?: ReadingPosition | null;
  onReadingPosition?: (position: ReadingPosition) => void;
  questionDraft?: (requestId: string) => SavedQuestionDraft | undefined;
  /**
   * 内容列宽度类（票 05 容器分档宽度）：由 WorkspacePage 单点选择
   * （空态 2xl / 有内容三档）并同样下发给头部与输入区，保证三处共用对齐。
   */
  contentWidthClass?: string;
}) {
  const contentWidthClass =
    props.contentWidthClass ?? SESSION_CONTENT_WIDTH_CLASS;
  const container = useRef<HTMLDivElement>(null);
  const restored = useRef<string | null | undefined>(undefined);
  useLayoutEffect(() => {
    if (props.loading) {
      // 同一会话被重新打开也会暂清历史，不能把这次归零当作用户阅读位置。
      restored.current = undefined;
      return;
    }
    if (!container.current || restored.current === props.sessionId) return;
    const element = container.current;
    element.scrollTop = props.readingPosition?.scrollTop ?? 0;
    restored.current = props.sessionId;
  }, [props.sessionId, props.loading, props.items, props.readingPosition]);
  return (
    <div
      ref={container}
      onScroll={(event) => {
        if (
          !props.loading &&
          restored.current === props.sessionId &&
          props.sessionId
        )
          props.onReadingPosition?.({
            scrollTop: event.currentTarget.scrollTop,
          });
      }}
      // overflow-x-hidden：宽内容（表格 / 代码块）由各自容器内聚横向滚动，
      // 滚动容器自身不出现横向溢出（spec 用户故事 34）
      className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto bg-canvas px-4 py-4"
      data-testid="message-stream"
    >
      {props.items.length === 0 && props.compacting !== true ? (
        <div
          data-testid="message-empty"
          className={`${contentWidthClass} flex h-full flex-col items-center justify-center gap-3 text-fg-subtle`}
        >
          <p className="text-sm">消息流为空</p>
          {props.emptyHint}
        </div>
      ) : (
        <ol
          data-testid="message-list"
          className={`${contentWidthClass} flex flex-col gap-4`}
        >
          {props.items.map((item) =>
            item.kind === "tool-call" ? (
              <ToolCallCard key={`tool-${item.id}`} call={item} />
            ) : item.kind === "interaction" ? (
              <InteractionHistory
                key={`interaction-${item.id}`}
                record={item.interaction}
                draft={props.questionDraft?.(item.id)}
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
              className="flex items-center gap-2 rounded-lg border border-info-fg/30 bg-info-bg px-3 py-2 text-xs text-info-fg"
            >
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-info-fg" />
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
    { kind: "tool-call" } | { kind: "interaction" } | { kind: "subagent" }
  >;
}) {
  const { message } = props;

  if (message.role === "user") {
    return (
      <li
        data-testid="message-user"
        // 限宽右对齐气泡（spec 用户故事 33）：相对限宽 85% 保护窄容器，
        // 绝对上限 36rem 防止内容列放宽后单段文本行长失控
        className="ml-auto max-w-[min(85%,36rem)] rounded-lg bg-selected px-3 py-2 text-sm whitespace-pre-wrap text-fg"
      >
        {message.content}
      </li>
    );
  }

  if (message.role === "error") {
    return (
      <li
        data-testid="message-error"
        className="rounded-lg border border-danger-fg/30 bg-danger-bg px-3 py-2 text-sm text-danger-fg"
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
        className="rounded-lg border border-line bg-surface px-3 py-2 text-xs whitespace-pre-wrap text-fg-muted"
      >
        {message.content}
      </li>
    );
  }

  if (message.role === "compact-summary") {
    // /compact 摘要卡片：被压缩的历史折叠显示，点击展开摘要全文（工单 08）
    return (
      <li data-testid="message-compact-summary">
        <details className="rounded-lg border border-info-fg/30 bg-info-bg px-3 py-2 text-xs text-info-fg">
          <summary className="cursor-pointer select-none">
            已压缩的历史（点击展开摘要全文）
          </summary>
          <div className="markdown mt-2 rounded border border-line bg-surface px-3 py-2 text-sm text-fg">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={markdownComponents}
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
      <div className="markdown rounded-lg border border-line bg-surface px-4 py-3 text-sm">
        {message.reasoning !== undefined && message.reasoning !== "" && (
          // 思考过程折叠块（GLOSSARY「思考档位」）：与正文分离、默认收起、
          // 可展开观察流式进度；终态（完成/中断/出错）由消息标志收敛，无残留进行中
          <details
            data-testid="thinking-block"
            className="mb-2 rounded-lg border border-line bg-surface-muted px-3 py-2 text-xs text-fg-muted"
          >
            <summary
              data-testid="thinking-toggle"
              className="flex cursor-pointer select-none items-center gap-2"
            >
              {message.streaming === true && (
                <span
                  data-testid="thinking-indicator"
                  className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent"
                  aria-label="思考中"
                />
              )}
              思考过程（点击展开 / 收起）
            </summary>
            <div
              data-testid="thinking-content"
              className="mt-2 whitespace-pre-wrap border-t border-line pt-2 text-fg"
            >
              {message.reasoning}
            </div>
          </details>
        )}
        <div data-testid="assistant-content">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={markdownComponents}
          >
            {message.content}
          </ReactMarkdown>
        </div>
        {message.streaming === true && (
          <span className="markdown-cursor" aria-label="正在生成" />
        )}
        {message.interrupted === true && (
          <p className="mt-2 text-xs text-warn-fg">
            （已中断，以上为部分回复）
          </p>
        )}
      </div>
    </li>
  );
}
