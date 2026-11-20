import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ReadingPosition,
  SavedQuestionDraft,
} from "@codexlike/agent-core";

import { useCollapseState } from "../lib/collapse-memory";
import { TASK_CONTENT_WIDTH_CLASS } from "../lib/content-width";
import {
  collectPlanSnapshots,
  isPlanSegment,
  parsePlanSteps,
} from "../lib/plan-view";
import { useScrollbarGutter } from "../lib/use-scrollbar-gutter";
import { useLocalDay } from "../lib/use-local-day";
import {
  ContentCommitContext,
  MarkdownContent,
  StreamingMarkdownContent,
} from "../lib/markdown";
import {
  anchorDecisionAfterContentChange,
  backToLatestVisible,
  followModeAfterScroll,
  INTENT_TTL_MS,
  keyVerticalIntent,
  readingSpotOnLeave,
  restoreReadingPlan,
  SCRIPTED_SCROLL_TTL_MS,
  touchVerticalIntent,
  wheelVerticalIntent,
  type FollowMode,
  type ScrollGeometry,
  type VerticalIntent,
} from "../lib/scroll-follow";
import type {
  AssistantSegment,
  MessageSegment,
  ThinkingSegment,
} from "../lib/task-view";
import { thinkingSummary } from "../lib/thinking-summary";
import {
  formatDurationCn,
  formatWorkDuration,
  groupConsecutiveTools,
  groupTurns,
  type ToolSequenceItem,
  type TurnView,
} from "../lib/turn-view";
import { useTickingNow } from "../lib/use-ticking-now";
import { AssistantActions } from "./AssistantActions";
import { BackToLatestButton } from "./BackToLatestButton";
import { DisclosureArrow } from "./DisclosureArrow";
import { InteractionHistory } from "./InteractionHistory";
import { SubagentStreamMarker } from "./SubagentStreamMarker";
import { ToolCallCard } from "./ToolCallCard";
import { ToolGroupView } from "./ToolSequence";
import { PlanMarkerRow } from "./WorkPlanCard";

/**
 * 中栏上部：消息流（GLOSSARY「消息流」「消息段」「轮次」「过程段」「跟随」）。
 * 渲染三层（ADR 0011 呈现分层、ADR 0015 逐段呈现）：单段视图按类型分派 →
 * 轮次聚合呈现（轮间距，不加 agent 名头/头像）→ 轮内消息段
 * 按事件原序平铺：过程段逐段自带工时，活动段默认展开、完成后自动收起
 * （聚合规则见 turn-view 纯函数，开合是渲染层内存态，见 collapse-memory）。
 *
 * 滚动跟随（票 03）：FOLLOWING/DETACHED 显式状态机（裁决计算见
 * lib/scroll-follow 纯函数模块）——贴近底部自动跟随最新内容，用户上翻
 * 立即脱离且不被流式输出拉回，提供「回到最新」入口，发送新消息强制回底；
 * 只有真实用户输入（滚轮/触摸/方向键/滚动条拖动）能改变跟随态。
 */
export function MessageStream(props: {
  items: MessageSegment[];
  /** 宿主执行态：最后一轮在执行期间视为运行中（操作栏不提前出现，工具间隙不闪断） */
  streaming?: boolean;
  /**
   * 当前运行的起始时刻（epoch ms，WorkspacePage 在进入执行态时记账）：
   * 底部「运行中」工时的数据来源；宿主执行态期间与 streaming 成对出现。
   */
  runStartedAt?: number | null;
  /** /compact 压缩进行中提示（不可重复触发期间显示在消息流底部） */
  compacting?: boolean;
  emptyHint?: ReactNode;
  taskId?: string | null;
  loading?: boolean;
  readingPosition?: ReadingPosition | null;
  onReadingPosition?: (position: ReadingPosition) => void;
  questionDraft?: (requestId: string) => SavedQuestionDraft | undefined;
  /** 新建、加载与已有任务共用三档内容列，头部和输入区采用相同规则。 */
  contentWidthClass?: string;
  /** 真实滚动槽宽度供同列非滚动区域补偿，不能硬编码平台滚动条宽度。 */
  onScrollbarGutterChange?: (width: number) => void;
  /** 强制回底信号（票 03）：发送新 prompt 时递增，组件立即贴底并进入跟随 */
  followSignal?: number;
  /** 当前任务标题：最终正文「导出为 Markdown」的默认文件名来源 */
  taskTitle?: string | null;
  /** 子代理标记行点击（ADR 0020）：开右栏子代理 tab 并定位选中 */
  onOpenSubagent?: (subagentId: string) => void;
  /** /status 报告块关闭（ADR 0031）：按段 id 从消息列表移除该报告 */
  onDismissStatus?: (id: string) => void;
}) {
  const now = useLocalDay();
  const contentWidthClass = props.contentWidthClass ?? TASK_CONTENT_WIDTH_CLASS;
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
  const snapToBottom = useCallback((element: HTMLElement) => {
    const top = element.scrollHeight - element.clientHeight;
    scriptedScroll.current = { top, at: performance.now() };
    element.scrollTop = top;
  }, []);

  const commitMode = useCallback((next: FollowMode) => {
    if (followRef.current === next) return;
    followRef.current = next;
    setMode(next);
  }, []);

  /** TTL 内最近登记的用户纵向意图；过期视为无登记 */
  const recentIntent = useCallback((): VerticalIntent | undefined => {
    const pending = pendingIntent.current;
    if (pending === null) return undefined;
    if (performance.now() - pending.at > INTENT_TTL_MS) {
      pendingIntent.current = null;
      return undefined;
    }
    return pending.intent;
  }, []);

  const followContentCommit = useCallback(() => {
    if (props.loading || restored.current !== props.taskId) return;
    const element = container.current;
    if (
      !element ||
      anchorDecisionAfterContentChange(followRef.current) !== "snap"
    )
      return;
    if (recentIntent() === "up") {
      commitMode("detached");
      return;
    }
    snapToBottom(element);
  }, [props.loading, props.taskId, recentIntent, commitMode, snapToBottom]);

  // 任务打开/切换：恢复阅读位置并建立初始跟随态（贴底记忆 → 定位当前
  // 最新并跟随；否则恢复像素位置按当前高度夹紧；无记忆 → 定位最新）。
  useLayoutEffect(() => {
    if (props.loading) {
      // 同一任务被重新打开也会暂清历史，不能把这次归零当作用户阅读位置。
      restored.current = undefined;
      return;
    }
    if (!container.current || restored.current === props.taskId) return;
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
    restored.current = props.taskId;
  }, [
    props.taskId,
    props.loading,
    props.items,
    props.readingPosition,
    commitMode,
  ]);

  // 内容变化（流式增量 / 工具卡更新 / 折叠变化 / 压缩指示）：跟随贴底、
  // 脱离保持阅读位置（不夺滚动权）。
  useLayoutEffect(() => {
    if (restored.current !== props.taskId) return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- taskId 只作恢复完成 guard：任务切换的滚动由上方恢复 effect 单点负责，补全后切换当帧会叠加 snapToBottom 覆盖恢复的阅读位置
  }, [props.items, props.compacting]);

  // 发送新 prompt：强制回底并进入跟随（spec 用户故事 6）。挂载时执行一次
  // 等价初始贴底，随后被任务恢复计算覆盖，不改变恢复语义。
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    commitMode("following");
    snapToBottom(element);
  }, [props.followSignal, commitMode, snapToBottom]);

  function registerIntent(intent: VerticalIntent) {
    if (intent !== "neutral")
      pendingIntent.current = { intent, at: performance.now() };
  }

  function saveReadingPosition(geometry: ScrollGeometry) {
    if (!props.loading && restored.current === props.taskId && props.taskId)
      props.onReadingPosition?.(
        readingSpotOnLeave({ mode: followRef.current, geometry })
      );
  }

  // 轮次聚合（票 04）：宿主执行态补上工具间隙无 running 段的缺口——
  // 最后一轮在宿主仍执行期间保持运行态，操作栏不提前出现
  const turns = groupTurns(props.items, {
    lastTurnRunning: props.streaming === true,
  });

  // 工作计划（ADR 0016）：计划段序号（流内标记行「计划更新 N」的 N，
  // 跨轮累计），一次遍历供各轮标记行共用
  const planIndexById = new Map(
    collectPlanSnapshots(props.items).map((snapshot, index) => [
      snapshot.segmentId,
      index,
    ])
  );

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
        className="h-full overflow-x-hidden overflow-y-auto bg-canvas px-4 py-5"
        // 禁用原生 scroll anchoring：跟随/恢复由状态机自管，
        // 原生锚点会覆盖恢复值（票 03）
        style={{ overflowAnchor: "none", scrollbarGutter: "stable" }}
        data-testid="message-stream"
      >
        {/* min-h-full 弹性列：空流态（新任务发送瞬间尚无用户段）也能把
            运行指示压到可视区左下角；有消息时紧跟在消息列表之后 */}
        <div className="flex min-h-full flex-col">
          {/* 工作计划进度折叠卡已迁往 WorkspacePage 中列（ADR 0019）：
              挂消息流与输入区之间，本组件只留流内极简标记行 */}
          {props.items.length === 0 && props.compacting !== true ? (
            <div
              data-testid="message-empty"
              className={`${contentWidthClass} flex flex-1 flex-col items-center justify-center gap-3 text-fg-subtle`}
            >
              <p className="text-sm">消息流为空</p>
              {props.emptyHint}
            </div>
          ) : (
            <ol
              data-testid="message-list"
              className={`${contentWidthClass} flex flex-col gap-6`}
            >
              <ContentCommitContext.Provider
                key={props.taskId}
                value={followContentCommit}
              >
                {turns.map((turn) => (
                  <TurnGroupItem
                    key={turn.turnId}
                    turn={turn}
                    now={now}
                    questionDraft={props.questionDraft}
                    taskTitle={props.taskTitle}
                    planIndexById={planIndexById}
                    onOpenSubagent={props.onOpenSubagent}
                    onDismissStatus={props.onDismissStatus}
                  />
                ))}
              </ContentCommitContext.Provider>
              {props.compacting === true && (
                <li
                  data-testid="compacting-indicator"
                  className="flex items-center gap-2 rounded-lg bg-info-bg px-3 py-2 text-xs text-info-fg"
                >
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-info-fg" />
                  正在压缩历史为摘要…（压缩期间输入已暂停）
                </li>
              )}
            </ol>
          )}
          {/* 运行指示（消息流最底部左下角）：输入已发出即显示，模型尚无输出
              的间隙也持续可见；与正文列同宽对齐，工时实时跳动；与上一条
              消息的间距对齐正文与复制按钮行（AssistantActions mt-2）。
              /compact 压缩期间由 compacting-indicator 表达进行中，不重复显示 */}
          {props.streaming === true && props.compacting !== true && (
            <div
              data-testid="running-indicator"
              className={`${contentWidthClass} mt-2 flex items-center gap-2 text-xs text-fg-muted`}
            >
              <span
                className="generating-spinner shrink-0"
                aria-hidden="true"
              />
              <span data-testid="running-label">运行中</span>
              <RunningElapsed startedAt={props.runStartedAt} />
            </div>
          )}
        </div>
      </div>
      {/* 「回到最新」入口：脱离跟随且有消息时可见；点击回底并恢复跟随 */}
      {backToLatestVisible(mode, props.items.length) && (
        <BackToLatestButton
          testId="back-to-latest"
          onClick={() => {
            const element = container.current;
            if (!element) return;
            commitMode("following");
            snapToBottom(element);
          }}
        />
      )}
    </div>
  );
}

/** 计时只更新数字叶节点，不驱动消息树每秒重走。 */
function RunningElapsed(props: { startedAt?: number | null }) {
  const now = useTickingNow(props.startedAt != null);
  if (props.startedAt == null) return null;
  return (
    <span data-testid="running-elapsed" className="font-mono text-fg-subtle">
      {formatWorkDuration(Math.max(0, now - props.startedAt))}
    </span>
  );
}

/**
 * 轮次分组呈现单位（GLOSSARY「轮次」）：轮间距（pt-4 + 外层 gap-4），
 * 不加 agent 名头/头像（票 04）；轮内依次为用户消息段与全部消息段
 * （过程段逐段平铺，ADR 0015）。
 */
function TurnGroupItem(props: {
  turn: TurnView;
  now: Date;
  questionDraft?: (requestId: string) => SavedQuestionDraft | undefined;
  taskTitle?: string | null;
  /** 计划段序号（跨轮累计，流内标记行「计划更新 N」用，ADR 0016） */
  planIndexById?: Map<string, number>;
  /** 子代理标记行点击（ADR 0020）：开右栏子代理 tab 并定位 */
  onOpenSubagent?: (subagentId: string) => void;
  /** /status 报告块关闭（ADR 0031）：透传至 SegmentView → MessageBubble */
  onDismissStatus?: (id: string) => void;
}) {
  const { turn } = props;
  const failed = turn.segments.some((segment) => segment.kind === "error");
  return (
    <li
      data-testid="message-turn"
      data-turn-id={turn.turnId}
      // 轮间距（D 设计语言五变体最大档）：24px 全由外层 message-list 的
      // gap-6 提供，轮内不再叠加顶部留白，段间距节奏单一可预期
    >
      <ol className="flex flex-col gap-[14px]">
        {turn.user !== null && (
          <SegmentView
            key={turn.user.id}
            segment={turn.user}
            questionDraft={props.questionDraft}
          />
        )}
        {groupConsecutiveTools(turn.segments).map((item) => (
          <ToolSequenceView
            key={
              item.kind === "group"
                ? `group-${item.segments[0]?.id}`
                : `single-${item.segment.id}`
            }
            item={item}
            showActions={
              !turn.running &&
              item.kind !== "group" &&
              item.segment.id === turn.finalAssistantId
            }
            processAssistant={
              item.kind === "passthrough" &&
              item.segment.kind === "assistant" &&
              item.segment.id !== turn.finalAssistantId
            }
            now={props.now}
            failed={failed}
            questionDraft={props.questionDraft}
            taskTitle={props.taskTitle}
            planIndexById={props.planIndexById}
            onOpenSubagent={props.onOpenSubagent}
            onDismissStatus={props.onDismissStatus}
          />
        ))}
      </ol>
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
  showActions?: boolean;
  processAssistant?: boolean;
  now?: Date;
  failed?: boolean;
  questionDraft?: (requestId: string) => SavedQuestionDraft | undefined;
  taskTitle?: string | null;
  /** 计划段序号（跨轮累计，流内标记行「计划更新 N」用，ADR 0016） */
  planIndexById?: Map<string, number>;
  /** 子代理标记行点击（ADR 0020）：开右栏子代理 tab 并定位 */
  onOpenSubagent?: (subagentId: string) => void;
  /** /status 报告块关闭（ADR 0031）：透传至 SegmentView → MessageBubble */
  onDismissStatus?: (id: string) => void;
}) {
  const { item } = props;
  if (item.kind === "passthrough") {
    return (
      <SegmentView
        segment={item.segment}
        showActions={props.showActions}
        processAssistant={props.processAssistant}
        now={props.now}
        failed={props.failed}
        questionDraft={props.questionDraft}
        taskTitle={props.taskTitle}
        onOpenSubagent={props.onOpenSubagent}
        onDismissStatus={props.onDismissStatus}
      />
    );
  }
  if (item.kind === "single") {
    // 工作计划更新（ADR 0016）：流内只留极简标记行（当前状态看顶部常驻条），
    // 不渲染通用工具卡——全量参数 JSON 对用户没有阅读价值
    if (isPlanSegment(item.segment)) {
      return (
        <PlanMarkerRow
          snapshot={{
            segmentId: item.segment.id,
            steps: parsePlanSteps(item.segment.arguments),
          }}
          index={props.planIndexById?.get(item.segment.id) ?? 0}
        />
      );
    }
    return <ToolCallCard call={item.segment} />;
  }
  return <ToolGroupView item={item} />;
}

/** 单段视图分派（渲染第一层）：按消息段类型选择呈现组件，每段一个 li */
function SegmentView(props: {
  segment: MessageSegment;
  showActions?: boolean;
  /** 正文段是过程段（非轮内最终正文）：以折叠卡呈现（ADR 0015） */
  processAssistant?: boolean;
  now?: Date;
  failed?: boolean;
  questionDraft?: (requestId: string) => SavedQuestionDraft | undefined;
  taskTitle?: string | null;
  /** 子代理标记行点击（ADR 0020）：开右栏子代理 tab 并定位 */
  onOpenSubagent?: (subagentId: string) => void;
  /** /status 报告块关闭（ADR 0031）：透传至 MessageBubble */
  onDismissStatus?: (id: string) => void;
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
    // 子代理正文迁右栏（ADR 0020）：流内只留单行标记，点击开右栏定位
    return (
      <SubagentStreamMarker subagent={segment} onOpen={props.onOpenSubagent} />
    );
  }
  if (segment.kind === "thinking") {
    return <ThinkingBlock segment={segment} />;
  }
  if (segment.kind === "assistant" && props.processAssistant === true) {
    return <ProcessTextBlock segment={segment} />;
  }
  return (
    <MessageBubble
      segment={segment}
      showActions={props.showActions}
      now={props.now}
      failed={props.failed}
      taskTitle={props.taskTitle}
      onDismissStatus={props.onDismissStatus}
    />
  );
}

/**
 * 思考段（GLOSSARY「思考档位」）：消息流时序序列中的独立成员——
 * 流式进行中默认展开实时可见，思考结束自动收起，收起后的卡片
 * 以一行摘要回看（thinkingSummary 纯函数）；与正文段分离。
 *
 * 受控 <details open>：关闭时卸载详情，展开才挂载完整内容；
 * onToggle 只在事件事实与渲染值不一致时写记忆——
 * React 写 open 属性也会触发 toggle 事件，若不区分会把「流式默认展开」
 * 误记为手动展开，导致思考结束时不能自动收起。
 */
function ThinkingBlock(props: { segment: ThinkingSegment }) {
  const { segment } = props;
  const streaming = segment.streaming === true;
  const { open, setOpen } = useCollapseState(segment.id, streaming);
  // 思考耗时：流式中实时跳动，收敛后以 endedAt 定格；缺时间数据则不显示
  const liveNow = useTickingNow(streaming && segment.at !== undefined);
  const thinkingMs =
    segment.at === undefined
      ? null
      : streaming
        ? Math.max(0, liveNow - segment.at)
        : segment.endedAt !== undefined
          ? segment.endedAt - segment.at
          : null;
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
        // 卡片内距与工具卡（ToolCallCard）统一：px-3.5 py-[9px]（D 语言
        // 折叠摘要行基准），相邻卡片文字起点一致
        className="rounded-lg bg-surface-muted px-3.5 py-[9px] text-xs text-fg-muted"
      >
        <summary
          data-testid="thinking-toggle"
          className="flex cursor-pointer select-none items-center gap-2"
        >
          <DisclosureArrow open={open} />
          {/* 运行提示统一收敛到消息流底部运行行：正文（含思考卡）不再内联转圈，
              思考进行中靠「思考中」文案与橙色工时跳动表达 */}
          <span
            data-testid="thinking-summary"
            className="min-w-0 flex-1 truncate"
          >
            {streaming ? "思考中" : "已思考"}
            {summary !== "" && ` · ${summary}`}
          </span>
          {thinkingMs !== null && (
            <span
              data-testid="thinking-duration"
              className={`shrink-0 font-mono ${streaming ? "text-warn-fg" : "text-fg-subtle"}`}
            >
              {formatDurationCn(thinkingMs)}
            </span>
          )}
        </summary>
        {open && (
          <div
            data-testid="thinking-content"
            // 展开体缩进与工具卡展开区对齐（pl-7 ≈ 摘要行文字起点）
            className="mt-2 whitespace-pre-wrap border-t border-line pt-2 pb-2 pl-7 pr-3 text-fg"
          >
            {segment.content}
          </div>
        )}
      </details>
    </li>
  );
}

/**
 * 中间正文段折叠卡（GLOSSARY「过程段」，ADR 0015）：被工具卡等隔断的正文
 * 各自成段，以过程段呈现。流式正文只追加到序列末尾（隔断前它就是轮内
 * 最后一段正文，仍以气泡实时可见），被隔断即失活并打点 endedAt——因此
 * 过程卡默认收起，以首行摘要 + 段耗时回看，展开可读全文；恢复的历史段
 * 缺打点则省略耗时。与思考块同构的受控 <details>：关闭时不解析正文，
 * onToggle 只在事件事实与渲染值不一致时写记忆。
 */
function ProcessTextBlock(props: { segment: AssistantSegment }) {
  const { segment } = props;
  const { open, setOpen } = useCollapseState(segment.id, false);
  // 段耗时：隔断收敛时定格（endedAt）；恢复的历史段缺打点则省略
  const textMs =
    segment.at !== undefined && segment.endedAt !== undefined
      ? segment.endedAt - segment.at
      : null;
  const summary = thinkingSummary(segment.content);
  return (
    <li>
      <details
        data-testid="process-text-block"
        open={open}
        onToggle={(event) => {
          if (event.currentTarget.open !== open) {
            setOpen(event.currentTarget.open);
          }
        }}
        // 卡片内距与工具卡统一（同 ThinkingBlock）
        className="rounded-lg bg-surface-muted px-3.5 py-[9px] text-xs text-fg-muted"
      >
        <summary
          data-testid="process-text-toggle"
          className="flex cursor-pointer select-none items-center gap-2"
        >
          <DisclosureArrow open={open} />
          <span
            data-testid="process-text-summary"
            className="min-w-0 flex-1 truncate"
          >
            {summary !== "" ? summary : "（空正文）"}
          </span>
          {textMs !== null && (
            <span
              data-testid="process-text-duration"
              className="shrink-0 font-mono text-fg-subtle"
            >
              {formatDurationCn(textMs)}
            </span>
          )}
        </summary>
        {open && (
          <div
            data-testid="process-text-content"
            className="markdown mt-2 border-t border-line pt-2 pb-2 pl-7 pr-3 text-sm text-fg"
          >
            <MarkdownContent content={segment.content} />
          </div>
        )}
      </details>
    </li>
  );
}

/** 压缩摘要与过程正文同样按需解析，不让关闭的历史承担解析成本。 */
function CompactSummaryBlock(props: {
  segment: Extract<MessageSegment, { kind: "compact-summary" }>;
}) {
  const { segment } = props;
  const { open, setOpen } = useCollapseState(`compact-${segment.id}`, false);
  return (
    <li data-testid="message-compact-summary">
      <details
        open={open}
        onToggle={(event) => {
          if (event.currentTarget.open !== open)
            setOpen(event.currentTarget.open);
        }}
        // 卡片内距与工具卡统一（同 ThinkingBlock；info 底色区分语义）
        className="rounded-lg bg-info-bg px-3.5 py-[9px] text-xs text-info-fg"
      >
        <summary
          data-testid="compact-summary-toggle"
          className="cursor-pointer select-none"
        >
          已压缩的历史（点击展开摘要全文）
        </summary>
        {open && (
          <div
            data-testid="compact-summary-content"
            className="markdown mt-2 rounded-lg bg-surface px-3 py-2 text-sm text-fg"
          >
            <MarkdownContent content={segment.content} />
          </div>
        )}
      </details>
    </li>
  );
}

/** 消息型消息段：用户消息、助手正文、错误提示、本地状态、压缩摘要 */
function MessageBubble(props: {
  showActions?: boolean;
  now?: Date;
  failed?: boolean;
  taskTitle?: string | null;
  segment: Extract<
    MessageSegment,
    | { kind: "user" }
    | { kind: "assistant" }
    | { kind: "error" }
    | { kind: "status" }
    | { kind: "compact-summary" }
  >;
  /** /status 报告块关闭（ADR 0031）：未提供时按钮不渲染 */
  onDismissStatus?: (id: string) => void;
}) {
  const { segment } = props;

  if (segment.kind === "user") {
    return (
      <li
        data-testid="message-user"
        // 限宽右对齐气泡（spec 用户故事 33）：相对限宽 85% 保护窄容器，
        // 绝对上限 36rem 防止内容列放宽后单段文本行长失控；
        // D 设计语言：暖灰圆角块（10px、内距 10/14、行高 1.7）
        className="ml-auto max-w-[min(85%,36rem)] rounded-[10px] bg-surface-muted px-3.5 py-2.5 text-sm leading-[1.7] whitespace-pre-wrap text-fg"
      >
        {segment.content}
      </li>
    );
  }

  if (segment.kind === "error") {
    return (
      <li
        data-testid="message-error"
        className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg"
      >
        {segment.content}
      </li>
    );
  }

  if (segment.kind === "status") {
    // /status 报告（ADR 0031）：多行报告驻留消息流可细看，逐条可关闭
    return (
      <li
        data-testid="message-status"
        className="rounded-lg bg-surface-muted px-3 py-2 text-xs whitespace-pre-wrap text-fg-muted"
      >
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 break-words">{segment.content}</p>
          {props.onDismissStatus && (
            <button
              type="button"
              data-testid="message-status-close"
              aria-label="关闭状态报告"
              onClick={() => props.onDismissStatus?.(segment.id)}
              className="shrink-0 rounded px-1 opacity-70 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-accent"
            >
              ×
            </button>
          )}
        </div>
      </li>
    );
  }

  if (segment.kind === "compact-summary") {
    return <CompactSummaryBlock segment={segment} />;
  }

  return (
    <li data-testid="message-assistant" className="max-w-full">
      {/* 正文无框纯文本流：与子代理报告（SubagentRailPanel）同构，
          不再以边框气泡呈现；左右与工具卡对齐，段间距由流 gap-[14px] 提供。
          D 设计语言：正文 15px + 行高 1.75（组件级规则，原型 message-assistant 段） */}
      <div className="markdown text-[0.9375rem] leading-[1.75]">
        <div data-testid="assistant-content">
          <StreamingMarkdownContent
            content={segment.content}
            streaming={segment.streaming === true}
          />
        </div>
        {/* 流式指示已统一到消息流底部「运行中」行（running-indicator），
            气泡内不再内联转圈 */}
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
          taskTitle={props.taskTitle}
        />
      )}
    </li>
  );
}
