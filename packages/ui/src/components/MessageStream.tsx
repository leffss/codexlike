import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type {
  ReadingPosition,
  SavedQuestionDraft,
} from "@codexlike/agent-core";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import { SESSION_CONTENT_WIDTH_CLASS } from "../lib/content-width";
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
import { InteractionHistory } from "./InteractionHistory";
import { SubagentCard } from "./SubagentCard";
import { ToolCallCard } from "./ToolCallCard";

/** 登记的用户输入意图有效期：覆盖 scroll 事件滞后一帧的竞争窗口 */
const INTENT_TTL_MS = 500;
/** 程序化贴底回执的有效期：过期不再拦截 scroll 裁决，防误吞用户滚动 */
const SCRIPTED_SCROLL_TTL_MS = 500;

/**
 * 中栏上部：消息流（GLOSSARY「消息流」「消息段」「跟随」）。
 * 数据层已按事件发生时序排列消息段，本组件按时序如实分派渲染：
 * 思考段、正文段、工具卡、子代理卡、错误段、状态段、compact 摘要段
 * 都是序列中的平等成员（保持现有折叠交互与 data-testid）。
 *
 * 滚动跟随（票 03）：FOLLOWING/DETACHED 显式状态机（裁决计算见
 * lib/scroll-follow 纯函数模块）——贴近底部自动跟随最新内容，用户上翻
 * 立即脱离且不被流式输出拉回，提供「回到最新」入口，发送新消息强制回底；
 * 只有真实用户输入（滚轮/触摸/方向键/滚动条拖动）能改变跟随态。
 */
export function MessageStream(props: {
  items: MessageSegment[];
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
  /** 强制回底信号（票 03）：发送新 prompt 时递增，组件立即贴底并进入跟随 */
  followSignal?: number;
}) {
  const contentWidthClass =
    props.contentWidthClass ?? SESSION_CONTENT_WIDTH_CLASS;
  const container = useRef<HTMLDivElement>(null);
  const restored = useRef<string | null | undefined>(undefined);
  const followRef = useRef<FollowMode>("following");
  // 跟随态的渲染镜像（驱动「回到最新」入口可见性，ref 不触发渲染）
  const [following, setFollowing] = useState(true);
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

  function commitMode(mode: FollowMode) {
    if (followRef.current === mode) return;
    followRef.current = mode;
    setFollowing(mode === "following");
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
        // scrollbar-gutter:stable 未启用：常驻滚动条槽会使消息列比头部/
        // 输入区（票 05 三处左右缘对齐）恒窄一个滚动条宽度，且基础档
        // 「内容列 = 容器 - padding」的宽度断言（width-tiers 场景 5）无法
        // 同时成立——两票断言冲突，本票保持票 05 绿色，偏差记于票 03。
        className="h-full overflow-x-hidden overflow-y-auto bg-canvas px-4 py-4"
        // 禁用原生 scroll anchoring：跟随/恢复由状态机自管，
        // 原生锚点会覆盖恢复值（票 03）
        style={{ overflowAnchor: "none" }}
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
              ) : item.kind === "thinking" ? (
                <ThinkingBlock key={item.id} segment={item} />
              ) : (
                <MessageBubble key={item.id} segment={item} />
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
      {/* 「回到最新」入口：脱离跟随且有消息时可见；点击回底并恢复跟随 */}
      {backToLatestVisible(
        following ? "following" : "detached",
        props.items.length
      ) && (
        <button
          type="button"
          data-testid="back-to-latest"
          onClick={() => {
            const element = container.current;
            if (!element) return;
            commitMode("following");
            snapToBottom(element);
          }}
          className="absolute bottom-4 right-4 z-10 rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-fg-muted shadow-sm hover:border-accent hover:text-accent"
        >
          回到最新
        </button>
      )}
    </div>
  );
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
