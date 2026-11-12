import { useLayoutEffect, useRef, type ReactNode } from "react";
import type {
  ReadingPosition,
  SavedQuestionDraft,
} from "@codexlike/agent-core";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import { useCollapseState } from "../lib/collapse-memory";
import { SESSION_CONTENT_WIDTH_CLASS } from "../lib/content-width";
import { markdownComponents } from "../lib/markdown";
import type { MessageSegment, ThinkingSegment } from "../lib/session-view";
import {
  formatWorkDuration,
  groupConsecutiveTools,
  groupTurns,
  type ToolSequenceItem,
  type TurnView,
} from "../lib/turn-view";
import { InteractionHistory } from "./InteractionHistory";
import { SubagentCard } from "./SubagentCard";
import { ToolCallCard } from "./ToolCallCard";

/**
 * 中栏上部：消息流（GLOSSARY「消息流」「消息段」「轮次」「已工作折叠区」）。
 * 渲染三层（ADR 0011 呈现分层）：单段视图按类型分派 → 轮次聚合呈现
 * （细分隔线 + 轮间距，不加 agent 名头/头像）→ 轮内以最终正文为界切分，
 * 之前的过程段在轮完成后收进「已工作 N 秒」折叠区，之后的段跟随显示；
 * 运行中的轮与中断、失败终态的轮强制展开过程（切分规则见 turn-view 纯函数，
 * 开合是渲染层内存态，见 collapse-memory）。
 */
export function MessageStream(props: {
  items: MessageSegment[];
  /** 宿主执行态：最后一轮在执行期间保持强制展开（工具间隙不闪收，票 04） */
  streaming?: boolean;
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
  const turns = groupTurns(props.items, {
    lastTurnRunning: props.streaming === true,
  });
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
          {turns.map((turn) => (
            <TurnGroupItem
              key={turn.turnId}
              turn={turn}
              questionDraft={props.questionDraft}
            />
          ))}
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

/**
 * 轮次分组呈现单位（GLOSSARY「轮次」）：细分隔线 + 轮间距，
 * 不加 agent 名头/头像（票 04）；轮内依次为用户消息段、
 * 已工作折叠区（有过程段时）、跟随区。
 */
function TurnGroupItem(props: {
  turn: TurnView;
  questionDraft?: (requestId: string) => SavedQuestionDraft | undefined;
}) {
  const { turn } = props;
  return (
    <li
      data-testid="message-turn"
      data-turn-id={turn.turnId}
      // 细分隔线 + 轮间距：首轮无线，其后各轮顶部细分隔线（外层 gap-4 提供基本轮间距）
      className="[&:not(:first-child)]:border-t [&:not(:first-child)]:border-line [&:not(:first-child)]:pt-4"
    >
      <ol className="flex flex-col gap-3">
        {turn.user !== null && (
          <SegmentView
            key={turn.user.id}
            segment={turn.user}
            questionDraft={props.questionDraft}
          />
        )}
        {turn.history.length > 0 && (
          <WorkedHistory turn={turn} questionDraft={props.questionDraft} />
        )}
        {turn.following.map((segment) => (
          <SegmentView
            key={segment.id}
            segment={segment}
            questionDraft={props.questionDraft}
          />
        ))}
      </ol>
    </li>
  );
}

/**
 * 已工作折叠区（GLOSSARY「已工作折叠区」）：轮内最终正文之前的过程段
 * （思考、工具卡、中间正文）在轮完成后默认收起，摘要行显示工时；
 * 运行中与中断、失败终态由默认值强制展开；用户手动开合按键记忆
 * （默认值变化不覆盖已记忆的键——轮完成自动收起只作用于未操作过的折叠区）。
 */
function WorkedHistory(props: {
  turn: TurnView;
  questionDraft?: (requestId: string) => SavedQuestionDraft | undefined;
}) {
  const { turn } = props;
  const { open, toggle } = useCollapseState(
    `history-${turn.turnId}`,
    turn.historyDefaultOpen
  );
  return (
    <li
      data-testid="worked-history"
      data-turn-id={turn.turnId}
      data-open={open ? "true" : "false"}
      data-duration-ms={turn.durationMs ?? ""}
    >
      <button
        type="button"
        data-testid="worked-history-toggle"
        aria-expanded={open}
        onClick={toggle}
        className="flex w-full items-center gap-2 rounded-lg border border-line bg-surface-muted px-3 py-2 text-left text-xs text-fg-muted hover:bg-hover"
      >
        {turn.running && (
          <span
            data-testid="worked-history-indicator"
            className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent"
            aria-label="工作中"
          />
        )}
        <span data-testid="worked-history-summary">
          {turn.running ? "工作中" : "已工作"}
          {turn.durationMs !== null &&
            ` ${formatWorkDuration(turn.durationMs)}`}
          {" · "}
          {turn.history.length} 个过程段
        </span>
        <span className="flex-1" />
        <span className="text-fg-subtle">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <ol
          data-testid="worked-history-items"
          className="mt-3 flex flex-col gap-3"
        >
          {groupConsecutiveTools(turn.history).map((item) => (
            <ToolSequenceView
              key={
                item.kind === "group"
                  ? `group-${item.segments[0]?.id}`
                  : `single-${item.segment.id}`
              }
              item={item}
              questionDraft={props.questionDraft}
            />
          ))}
        </ol>
      )}
    </li>
  );
}

/**
 * 连续同类工具统计分组（spec 用户故事 29）：组头显示类别与计数
 * （如「read_file × 3」，含失败卡时提示），展开仍由原卡片渲染；
 * 组默认收起（过程区不被重复卡片淹没），开合同样按键记忆。
 */
function ToolSequenceView(props: {
  item: ToolSequenceItem;
  questionDraft?: (requestId: string) => SavedQuestionDraft | undefined;
}) {
  const { item } = props;
  if (item.kind === "passthrough") {
    return (
      <SegmentView segment={item.segment} questionDraft={props.questionDraft} />
    );
  }
  if (item.kind === "single") {
    return <ToolCallCard call={item.segment} />;
  }
  const first = item.segments[0];
  const { open, toggle } = useCollapseState(
    `tool-group-${first?.id ?? ""}`,
    false
  );
  return (
    <li
      data-testid="tool-call-group"
      data-tool-name={item.toolName}
      data-count={item.segments.length}
    >
      <button
        type="button"
        data-testid="tool-call-group-toggle"
        aria-expanded={open}
        onClick={toggle}
        className="flex w-full items-center gap-2 rounded-lg border border-line bg-surface-muted px-3 py-2 text-left text-xs hover:bg-hover"
      >
        <span className="rounded bg-code-bg px-1.5 py-0.5 font-mono text-accent">
          {item.toolName}
        </span>
        <span className="text-fg-muted">× {item.segments.length}</span>
        {item.hasError && (
          <span data-testid="tool-call-group-error" className="text-danger-fg">
            含失败
          </span>
        )}
        <span className="flex-1" />
        <span className="text-fg-subtle">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <ol
          data-testid="tool-call-group-items"
          className="mt-2 flex flex-col gap-2"
        >
          {item.segments.map((call) => (
            <ToolCallCard key={call.id} call={call} />
          ))}
        </ol>
      )}
    </li>
  );
}

/** 单段视图分派（渲染第一层）：按消息段类型选择呈现组件，每段一个 li */
function SegmentView(props: {
  segment: MessageSegment;
  questionDraft?: (requestId: string) => SavedQuestionDraft | undefined;
}) {
  const { segment } = props;
  if (segment.kind === "tool-call") {
    return <ToolCallCard call={segment} />;
  }
  if (segment.kind === "interaction") {
    return (
      <InteractionHistory
        record={segment.interaction}
        draft={props.questionDraft?.(segment.id)}
      />
    );
  }
  if (segment.kind === "subagent") {
    return <SubagentCard subagent={segment} />;
  }
  if (segment.kind === "thinking") {
    return <ThinkingBlock segment={segment} />;
  }
  return <MessageBubble segment={segment} />;
}

/**
 * 思考段（GLOSSARY「思考档位」）：消息流时序序列中的独立成员——
 * 默认收起、可展开观察内容、流式进行中带思考指示器；
 * 与正文段分离，不再提升合并进气泡顶部。
 */
function ThinkingBlock(props: { segment: ThinkingSegment }) {
  const { segment } = props;
  return (
    <li>
      <details
        data-testid="thinking-block"
        className="rounded-lg border border-line bg-surface-muted px-3 py-2 text-xs text-fg-muted"
      >
        <summary
          data-testid="thinking-toggle"
          className="flex cursor-pointer select-none items-center gap-2"
        >
          {segment.streaming === true && (
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
          {segment.content}
        </div>
      </details>
    </li>
  );
}

/** 消息型消息段：用户消息、助手正文、错误提示、本地状态、压缩摘要 */
function MessageBubble(props: {
  segment: Extract<
    MessageSegment,
    | { kind: "user" }
    | { kind: "assistant" }
    | { kind: "error" }
    | { kind: "status" }
    | { kind: "compact-summary" }
  >;
}) {
  const { segment } = props;

  if (segment.kind === "user") {
    return (
      <li
        data-testid="message-user"
        // 限宽右对齐气泡（spec 用户故事 33）：相对限宽 85% 保护窄容器，
        // 绝对上限 36rem 防止内容列放宽后单段文本行长失控
        className="ml-auto max-w-[min(85%,36rem)] rounded-lg bg-selected px-3 py-2 text-sm whitespace-pre-wrap text-fg"
      >
        {segment.content}
      </li>
    );
  }

  if (segment.kind === "error") {
    return (
      <li
        data-testid="message-error"
        className="rounded-lg border border-danger-fg/30 bg-danger-bg px-3 py-2 text-sm text-danger-fg"
      >
        {segment.content}
      </li>
    );
  }

  if (segment.kind === "status") {
    // 本地命令反馈（/status、/rename 结果等）：不落库、不进模型上下文
    return (
      <li
        data-testid="message-status"
        className="rounded-lg border border-line bg-surface px-3 py-2 text-xs whitespace-pre-wrap text-fg-muted"
      >
        {segment.content}
      </li>
    );
  }

  if (segment.kind === "compact-summary") {
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
              {segment.content}
            </ReactMarkdown>
          </div>
        </details>
      </li>
    );
  }

  return (
    <li data-testid="message-assistant" className="max-w-full">
      <div className="markdown rounded-lg border border-line bg-surface px-4 py-3 text-sm">
        <div data-testid="assistant-content">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={markdownComponents}
          >
            {segment.content}
          </ReactMarkdown>
        </div>
        {segment.streaming === true && (
          <span className="markdown-cursor" aria-label="正在生成" />
        )}
        {segment.interrupted === true && (
          <p className="mt-2 text-xs text-warn-fg">
            （已中断，以上为部分回复）
          </p>
        )}
      </div>
    </li>
  );
}
