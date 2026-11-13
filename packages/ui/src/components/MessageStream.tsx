import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type {
  ReadingPosition,
  SavedQuestionDraft,
} from "@codexlike/agent-core";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import { useCollapseState } from "../lib/collapse-memory";
import { SESSION_CONTENT_WIDTH_CLASS } from "../lib/content-width";
import { useScrollbarGutter } from "../lib/use-scrollbar-gutter";
import { useLocalDay } from "../lib/use-local-day";
import { markdownComponents } from "../lib/markdown";
import {
  anchorDecisionAfterContentChange,
  backToLatestVisible,
  followModeAfterScroll,
  keyVerticalIntent,
  readingSpotOnLeave,
  restoreReadingPlan,
  touchVerticalIntent,
  wheelVerticalIntent,
  type FollowMode,
  type ScrollGeometry,
  type VerticalIntent,
} from "../lib/scroll-follow";
import type { MessageSegment, ThinkingSegment } from "../lib/session-view";
import { thinkingSummary } from "../lib/thinking-summary";
import {
  formatWorkDuration,
  groupConsecutiveTools,
  groupTurns,
  type ToolSequenceItem,
  type TurnView,
} from "../lib/turn-view";
import { AssistantActions } from "./AssistantActions";
import { DisclosureArrow } from "./DisclosureArrow";
import { InteractionHistory } from "./InteractionHistory";
import { SubagentCard } from "./SubagentCard";
import { ToolCallCard } from "./ToolCallCard";

/** 登记的用户输入意图有效期：覆盖 scroll 事件滞后一帧的竞争窗口 */
const INTENT_TTL_MS = 500;
/** 程序化贴底回执的有效期：过期不再拦截 scroll 裁决，防误吞用户滚动 */
const SCRIPTED_SCROLL_TTL_MS = 500;

/**
 * 中栏上部：消息流（GLOSSARY「消息流」「消息段」「轮次」「已工作折叠区」「跟随」）。
 * 渲染三层（ADR 0011 呈现分层）：单段视图按类型分派 → 轮次聚合呈现
 * （细分隔线 + 轮间距，不加 agent 名头/头像）→ 轮内以最终正文为界切分，
 * 之前的过程段在轮完成后收进「已工作 N 秒」折叠区，之后的段跟随显示；
 * 运行中的轮与中断、失败终态的轮强制展开过程（切分规则见 turn-view 纯函数，
 * 开合是渲染层内存态，见 collapse-memory）。
 *
 * 滚动跟随（票 03）：FOLLOWING/DETACHED 显式状态机（裁决计算见
 * lib/scroll-follow 纯函数模块）——贴近底部自动跟随最新内容，用户上翻
 * 立即脱离且不被流式输出拉回，提供「回到最新」入口，发送新消息强制回底；
 * 只有真实用户输入（滚轮/触摸/方向键/滚动条拖动）能改变跟随态。
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
  /** 新建、加载与已有会话共用三档内容列，头部和输入区采用相同规则。 */
  contentWidthClass?: string;
  /** 真实滚动槽宽度供同列非滚动区域补偿，不能硬编码平台滚动条宽度。 */
  onScrollbarGutterChange?: (width: number) => void;
  /** 强制回底信号（票 03）：发送新 prompt 时递增，组件立即贴底并进入跟随 */
  followSignal?: number;
}) {
  const now = useLocalDay();
  const contentWidthClass =
    props.contentWidthClass ?? SESSION_CONTENT_WIDTH_CLASS;
  const container = useRef<HTMLDivElement>(null);
  useScrollbarGutter(container, props.onScrollbarGutterChange);
  const restored = useRef<string | null | undefined>(undefined);
  const followRef = useRef<FollowMode>("following");
  // 跟随态的渲染镜像（驱动「回到最新」入口可见性，ref 不触发渲染）：
  // 直接保存 FollowMode 本身，可见性裁决无需从 boolean 反向转回
  const [mode, setMode] = useState<FollowMode>("following");
  const pendingIntent = useRef<{ intent: VerticalIntent; at: number } | null>(
    null
  );
  const scriptedScroll = useRef<{ top: number; at: number } | null>(null);
  const lastTouchY = useRef<number | null>(null);

  function geometryOf(element: HTMLElement): ScrollGeometry {
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    };
  }

  /** 贴底用直接 scrollTop 赋值（非 smooth，流式期间不抖动），并登记回执 */
  function snapToBottom(element: HTMLElement) {
    const top = element.scrollHeight - element.clientHeight;
    scriptedScroll.current = { top, at: performance.now() };
    element.scrollTop = top;
  }

  function commitMode(next: FollowMode) {
    if (followRef.current === next) return;
    followRef.current = next;
    setMode(next);
  }

  /** TTL 内最近登记的用户纵向意图；过期视为无登记 */
  function recentIntent(): VerticalIntent | undefined {
    const pending = pendingIntent.current;
    if (pending === null) return undefined;
    if (performance.now() - pending.at > INTENT_TTL_MS) {
      pendingIntent.current = null;
      return undefined;
    }
    return pending.intent;
  }

  // 会话打开/切换：恢复阅读位置并建立初始跟随态（贴底记忆 → 定位当前
  // 最新并跟随；否则恢复像素位置按当前高度夹紧；无记忆 → 定位最新）。
  useLayoutEffect(() => {
    if (props.loading) {
      // 同一会话被重新打开也会暂清历史，不能把这次归零当作用户阅读位置。
      restored.current = undefined;
      return;
    }
    if (!container.current || restored.current === props.sessionId) return;
    const element = container.current;
    const plan = restoreReadingPlan({
      saved: props.readingPosition
        ? {
            scrollTop: props.readingPosition.scrollTop,
            atBottom: props.readingPosition.atBottom,
          }
        : null,
      geometry: geometryOf(element),
    });
    scriptedScroll.current = { top: plan.scrollTop, at: performance.now() };
    element.scrollTop = plan.scrollTop;
    commitMode(plan.mode);
    restored.current = props.sessionId;
  }, [props.sessionId, props.loading, props.items, props.readingPosition]);

  // 内容变化（流式增量 / 工具卡更新 / 折叠变化 / 压缩指示）：跟随贴底、
  // 脱离保持阅读位置（不夺滚动权）。
  useLayoutEffect(() => {
    if (restored.current !== props.sessionId) return;
    const element = container.current;
    if (!element) return;
    if (anchorDecisionAfterContentChange(followRef.current) !== "snap") return;
    // 竞争对账：贴底 effect 执行前，最近用户向上意图同帧让位——
    // 上翻瞬间恰逢流式内容 commit 时用户的滚动意图优先（spec 用户故事 8）。
    if (recentIntent() === "up") {
      commitMode("detached");
      return;
    }
    snapToBottom(element);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionId 只作恢复完成 guard：会话切换的滚动由上方恢复 effect 单点负责，补全后切换当帧会叠加 snapToBottom 覆盖恢复的阅读位置
  }, [props.items, props.compacting]);

  // 发送新 prompt：强制回底并进入跟随（spec 用户故事 6）。挂载时执行一次
  // 等价初始贴底，随后被会话恢复计算覆盖，不改变恢复语义。
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    commitMode("following");
    snapToBottom(element);
  }, [props.followSignal]);

  function registerIntent(intent: VerticalIntent) {
    if (intent !== "neutral")
      pendingIntent.current = { intent, at: performance.now() };
  }

  function saveReadingPosition(geometry: ScrollGeometry) {
    if (
      !props.loading &&
      restored.current === props.sessionId &&
      props.sessionId
    )
      props.onReadingPosition?.(
        readingSpotOnLeave({ mode: followRef.current, geometry })
      );
  }

  // 轮次聚合与轮内切分（票 04）：宿主执行态补上工具间隙无 running 段的
  // 缺口——最后一轮在宿主仍执行期间保持强制展开，不闪收
  const turns = groupTurns(props.items, {
    lastTurnRunning: props.streaming === true,
  });

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={container}
        onWheelCapture={(event) =>
          registerIntent(wheelVerticalIntent(event.deltaY))
        }
        onTouchStart={(event) => {
          lastTouchY.current = event.touches[0]?.clientY ?? null;
        }}
        onTouchMove={(event) => {
          const y = event.touches[0]?.clientY;
          if (y === undefined || lastTouchY.current === null) {
            lastTouchY.current = y ?? null;
            return;
          }
          registerIntent(touchVerticalIntent(lastTouchY.current, y));
          lastTouchY.current = y;
        }}
        onKeyDownCapture={(event) => {
          const target = event.target as HTMLElement | null;
          const editable =
            target !== null &&
            (target.tagName === "TEXTAREA" ||
              target.tagName === "INPUT" ||
              target.isContentEditable);
          registerIntent(
            keyVerticalIntent({
              key: event.key,
              shiftKey: event.shiftKey,
              editable,
            })
          );
        }}
        onScroll={(event) => {
          const element = event.currentTarget;
          const geometry = geometryOf(element);
          // 程序化贴底的回执（值匹配 + 短有效期）：只记账，不动状态机，
          // 程序化贴底与布局测高产生的滚动不改变跟随态（spec 用户故事 7）。
          const scripted = scriptedScroll.current;
          const isScripted =
            scripted !== null &&
            performance.now() - scripted.at <= SCRIPTED_SCROLL_TTL_MS &&
            Math.abs(element.scrollTop - scripted.top) <= 1;
          if (isScripted) {
            scriptedScroll.current = null;
          } else {
            const next = followModeAfterScroll({
              mode: followRef.current,
              cause: "user-input",
              intent: recentIntent(),
              geometry,
            });
            pendingIntent.current = null; // 意图已被本次 scroll 消费
            commitMode(next);
          }
          // 阅读位置记忆（含「离开时是否贴底」）与跟随互不影响
          saveReadingPosition(geometry);
        }}
        // overflow-x-hidden：宽内容（表格 / 代码块）由各自容器内聚横向滚动，
        // 滚动容器自身不出现横向溢出（spec 用户故事 34）。
        // 稳定预留纵向滚动槽；同列头部和输入区消费实测槽宽保持左右缘一致。
        className="h-full overflow-x-hidden overflow-y-auto bg-canvas px-4 py-4"
        // 禁用原生 scroll anchoring：跟随/恢复由状态机自管，
        // 原生锚点会覆盖恢复值（票 03）
        style={{ overflowAnchor: "none", scrollbarGutter: "stable" }}
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
                now={now}
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
      {/* 「回到最新」入口：脱离跟随且有消息时可见；点击回底并恢复跟随 */}
      {backToLatestVisible(mode, props.items.length) && (
        <button
          type="button"
          data-testid="back-to-latest"
          aria-label="回到最新"
          title="回到最新"
          onClick={() => {
            const element = container.current;
            if (!element) return;
            commitMode("following");
            snapToBottom(element);
          }}
          className="absolute bottom-4 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-surface text-fg-muted shadow-sm hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 5v14m-6-6 6 6 6-6" />
          </svg>
        </button>
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
  now: Date;
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
            showActions={!turn.running}
            now={props.now}
            failed={turn.following.some((item) => item.kind === "error")}
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
        <DisclosureArrow open={open} />
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
 * 连续同类工具统计分组序列的形态分派（spec 用户故事 29）：只做
 * passthrough / single / group 三形态分派，自身不挂 Hook——提前
 * return 之后调用 hook 违反 Rules of Hooks，组形态的折叠开合由
 * ToolGroupView 固定子组件承载。
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
  return <ToolGroupView item={item} />;
}

/**
 * 同名连续工具组（spec 用户故事 29）：组头显示类别与计数
 * （如「read_file × 3」，含失败卡时提示），展开仍由原卡片渲染；
 * 组默认收起（过程区不被重复卡片淹没），开合同样按键记忆。
 */
function ToolGroupView(props: {
  item: Extract<ToolSequenceItem, { kind: "group" }>;
}) {
  const { item } = props;
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
        <DisclosureArrow open={open} />
        <span className="rounded bg-code-bg px-1.5 py-0.5 font-mono text-accent">
          {item.toolName}
        </span>
        <span className="text-fg-muted">× {item.segments.length}</span>
        {item.hasError && (
          <span data-testid="tool-call-group-error" className="text-danger-fg">
            含失败
          </span>
        )}
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
  showActions?: boolean;
  now?: Date;
  failed?: boolean;
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
  return (
    <MessageBubble
      segment={segment}
      showActions={props.showActions}
      now={props.now}
      failed={props.failed}
    />
  );
}

/**
 * 思考段（GLOSSARY「思考档位」）：消息流时序序列中的独立成员——
 * 流式进行中默认展开实时可见，思考结束自动收起，收起后的卡片
 * 以一行摘要回看（thinkingSummary 纯函数）；与正文段分离。
 *
 * 受控 <details open>：内容在收起态仍留在 DOM（e2e 以 textContent
 * 回读收起块全文）；onToggle 只在事件事实与渲染值不一致时写记忆——
 * React 写 open 属性也会触发 toggle 事件，若不区分会把「流式默认展开」
 * 误记为手动展开，导致思考结束时不能自动收起。
 */
function ThinkingBlock(props: { segment: ThinkingSegment }) {
  const { segment } = props;
  const streaming = segment.streaming === true;
  const { open, setOpen } = useCollapseState(segment.id, streaming);
  const summary = thinkingSummary(segment.content);
  return (
    <li>
      <details
        data-testid="thinking-block"
        open={open}
        onToggle={(event) => {
          if (event.currentTarget.open !== open) {
            setOpen(event.currentTarget.open);
          }
        }}
        className="rounded-lg border border-line bg-surface-muted px-3 py-2 text-xs text-fg-muted"
      >
        <summary
          data-testid="thinking-toggle"
          className="flex cursor-pointer select-none items-center gap-2"
        >
          <DisclosureArrow open={open} />
          {streaming && (
            <span
              data-testid="thinking-indicator"
              className="generating-spinner shrink-0"
              aria-label="思考中"
            />
          )}
          <span
            data-testid="thinking-summary"
            className="min-w-0 flex-1 truncate"
          >
            {streaming ? "思考中" : "已思考"}
            {summary !== "" && ` · ${summary}`}
          </span>
        </summary>
        <div
          data-testid="thinking-content"
          className="mt-2 whitespace-pre-wrap border-t border-line pt-2 text-fg"
        >
          {segment.content}
          {streaming && (
            <span className="generating-spinner ml-1" aria-hidden="true" />
          )}
        </div>
      </details>
    </li>
  );
}

/** 消息型消息段：用户消息、助手正文、错误提示、本地状态、压缩摘要 */
function MessageBubble(props: {
  showActions?: boolean;
  now?: Date;
  failed?: boolean;
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
          <span className="generating-spinner" aria-label="正在生成" />
        )}
        {segment.interrupted === true && (
          <p className="mt-2 text-xs text-warn-fg">
            （已中断，以上为部分回复）
          </p>
        )}
      </div>
      {props.showActions && props.now !== undefined && (
        <AssistantActions
          key={segment.content}
          segment={segment}
          now={props.now}
          failed={props.failed}
        />
      )}
    </li>
  );
}
