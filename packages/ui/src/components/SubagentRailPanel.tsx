import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { exportFileNameBase } from "./AssistantActions";
import { BackToLatestButton } from "./BackToLatestButton";
import { DisclosureArrow } from "./DisclosureArrow";
import { WorkPlanCardFromSubagentTools } from "./WorkPlanCard";
import { ToolCallCard } from "./ToolCallCard";
import { ToolGroupView } from "./ToolSequence";
import { formatCompletedTime } from "../lib/completed-time";
import { useCollapseState } from "../lib/collapse-memory";
import { MarkdownContent } from "../lib/markdown";
import { PLAN_TOOL_NAME } from "../lib/plan-view";
import {
  anchorDecisionAfterContentChange,
  backToLatestVisible,
  followModeAfterScroll,
  INTENT_TTL_MS,
  keyVerticalIntent,
  SCRIPTED_SCROLL_TTL_MS,
  touchVerticalIntent,
  wheelVerticalIntent,
  type FollowMode,
  type ScrollGeometry,
  type VerticalIntent,
} from "../lib/scroll-follow";
import { subagentExportMarkdown } from "../lib/subagent-export";
import {
  isTerminalSubagentState,
  statusClass,
  statusDotClassName,
  statusPulses,
  statusText,
} from "../lib/subagent-status";
import { thinkingSummary } from "../lib/thinking-summary";
import type { SubagentSegment, ToolCallSegment } from "../lib/task-view";
import { groupConsecutiveTools } from "../lib/turn-view";
import { useTickingNow } from "../lib/use-ticking-now";

/**
 * 子代理检视面板（ADR 0020，prototype/subagent-rail 变体 A 转正；主次
 * 层级重构为 prototype/subagent-hierarchy 变体 C）：右栏第三 tab「子代理」
 * 的 tab 体。子代理的正文（最终报告 / 思考 / 工具进度）全部收纳于此，
 * 主消息流只留单行轻量标记（SubagentStreamMarker）。
 *
 * 结构（摘要选择器，解决「子代理多时上段列表与下段详情视觉权重相同
 * 主次不清」）：顶部计数摘要行（总数 + 进行中/排队/失败/中断非零计数）
 * + 当前选中行常驻；完整列表点开浮层按需展开（遮罩/Escape/再点收起，
 * 点选即选中并收起），详情独占剩余全部高度。无选中（或选中者已不在
 * 列表）时默认选中最后一个（最新）；消息流标记行点击经 focus prop
 * 定位——直接选中并显示详情（不展开列表浮层：用户从消息流进来要读的
 * 是那一项的详情，浮层反而多一步收起；要横向比对再手动展开列表）。
 */

/** 消息流标记行点击的定位信号（seq 递增触发 effect，id 为目标） */
export interface SubagentFocus {
  id: string;
  /** 单调递增序号：同 id 重复点击也能重新定位 */
  seq: number;
}

export function SubagentRailPanelBody(props: {
  subagents: SubagentSegment[];
  focus: SubagentFocus | null;
}) {
  const { subagents } = props;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  // 标记行点击定位：focus 信号变化时选中对应子代理、直接显示详情（不
  // 展开列表浮层，2026-11-19 呈现对齐轮）。每个 focus.seq 只消费一次
  // （ref 幂等）：依赖里保留 subagents 是为「段晚于点击到达列表」的
  // 重试，但运行中流式会持续产生新数组引用，无幂等守卫时每次流式事件
  // 都重放 setSelectedId(focus.id)，把用户在列表里手动点选的子代理
  // 强行拉回 focus 目标（点击无法切换的回归）。
  const focus = props.focus;
  const consumedFocusSeqRef = useRef(-1);
  useEffect(() => {
    if (focus === null) return;
    if (focus.seq === consumedFocusSeqRef.current) return;
    if (!subagents.some((item) => item.id === focus.id)) return;
    consumedFocusSeqRef.current = focus.seq;
    setSelectedId(focus.id);
  }, [focus, subagents]);
  // Escape 收起浮层（浮层标准交互；摘要行/遮罩/点选之外补键盘出口）
  useEffect(() => {
    if (!listOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setListOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [listOpen]);
  const selected =
    subagents.find((item) => item.id === selectedId) ??
    subagents.at(-1) ??
    null;

  // 空态占位（hooks 之后统一 return，保 Rules of Hooks）
  if (subagents.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-xs text-fg-muted">
        本任务尚无子代理委派。
      </div>
    );
  }

  const running = subagents.filter((item) => item.state === "running").length;
  const queued = subagents.filter((item) => item.state === "queued").length;
  const failed = subagents.filter(
    (item) => item.state === "done" && item.ok === false
  ).length;
  const interrupted = subagents.filter(
    (item) => item.state === "interrupted"
  ).length;

  return (
    <div
      data-testid="subagents-panel-body"
      className="relative flex min-h-0 flex-1 flex-col"
    >
      {/* 摘要行：总数 + 进行中/异常计数（非零渲染），常驻「一眼知全局」 */}
      <button
        type="button"
        data-testid="subagent-rail-summary"
        onClick={() => setListOpen(!listOpen)}
        aria-expanded={listOpen}
        className="flex w-full shrink-0 items-center gap-2 border-b border-line px-3 py-1.5 text-left hover:bg-hover"
      >
        <span className="text-xs text-fg-subtle">
          子代理 {subagents.length} 个
        </span>
        {running > 0 && (
          <span className="text-xs text-warn-fg">进行中 {running}</span>
        )}
        {queued > 0 && (
          <span className="text-xs text-fg-subtle">排队 {queued}</span>
        )}
        {failed > 0 && (
          <span className="text-xs text-danger-fg">失败 {failed}</span>
        )}
        {interrupted > 0 && (
          <span className="text-xs text-warn-fg">中断 {interrupted}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-fg-muted">
          {listOpen ? "收起列表" : "展开列表"}
          <DisclosureArrow open={listOpen} />
        </span>
      </button>
      {/* 当前选中行：详情对象的常驻锚点（点选/focus 定位都汇到这里） */}
      {selected !== null && (
        <button
          type="button"
          data-testid="subagent-rail-current"
          data-subagent-state={selected.state}
          onClick={() => setListOpen(!listOpen)}
          className="flex w-full shrink-0 items-center gap-2 border-b border-line px-3 py-1.5 text-left hover:bg-hover"
        >
          <StatusDot subagent={selected} />
          <span className="min-w-0 flex-1 truncate text-xs text-fg">
            {selected.task === "" ? "（任务描述缺失）" : selected.task}
          </span>
          <span className={`shrink-0 text-xs ${statusClass(selected)}`}>
            {statusText(selected)}
          </span>
          <Elapsed subagent={selected} />
        </button>
      )}
      {/* 内容区：详情独占；浮层与遮罩都锚定在这里——与摘要行/当前行
          物理不重叠（首版浮层 top-0 与摘要行 z-30 叠放，hover 半透明
          时列表第一行透出文字成「重叠」，且第一行常被摘要行挡住） */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* 浮层完整列表：遮罩 + 列表（absolute 覆盖，点选即选中并收起）。
            覆盖感：投影/描边/圆角与面板拉开层次 + 轻遮罩压暗底层（主题
            --overlay 降浓度——模态级 45% 对右栏内小浮层过重）（原型评审
            反馈「像内联列表」的修复） */}
        {listOpen && (
          <>
            <button
              type="button"
              aria-label="收起列表"
              onClick={() => setListOpen(false)}
              className="absolute inset-0 z-10 cursor-default bg-overlay/50"
            />
            <ul
              data-testid="subagent-rail-list"
              className="absolute inset-x-0 top-0 z-20 max-h-[85%] overflow-auto rounded-lg border border-line bg-surface py-0.5 shadow-popover"
            >
              {subagents.map((item) => (
                <li key={item.id} data-subagent-id={item.id}>
                  <button
                    type="button"
                    data-testid="subagent-rail-item"
                    data-subagent-state={item.state}
                    onClick={() => {
                      setSelectedId(item.id);
                      setListOpen(false);
                    }}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
                      selected?.id === item.id ? "bg-hover" : "hover:bg-hover"
                    }`}
                  >
                    <StatusDot subagent={item} />
                    <span
                      className={`min-w-0 flex-1 truncate text-xs ${
                        selected?.id === item.id ? "text-fg" : "text-fg-muted"
                      }`}
                      title={item.task}
                    >
                      {item.task === "" ? "（任务描述缺失）" : item.task}
                    </span>
                    <span className={`shrink-0 text-xs ${statusClass(item)}`}>
                      {statusText(item)}
                    </span>
                    <Elapsed subagent={item} />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {/* 详情：独占剩余高度 */}
        {selected !== null && <SubagentDetail subagent={selected} />}
      </div>
    </div>
  );
}

/**
 * 详情区（2026-11-19 呈现对齐轮起与主代理轮内时序同构）：委派要求块 →
 * 思考折叠 → 正文折叠 → 工具调用（主代理同款卡）→ 终态块（排队提示 /
 * 运行指示 / 中断留痕 / 报告与操作行）→ 工作计划卡。工具卡在正文流中、
 * 报告与操作行之前（过程段先于终态），不再终态堆在复制按钮之下。
 *
 * 滚动跟随（与主代理 MessageStream 同构，接线见其注释；裁决计算同在
 * lib/scroll-follow）：流式内容跟随贴底，用户上翻立即脱离并出「回到
 * 最新」入口（2026-11-19 起与主代理对齐）；切换子代理重置贴底跟随
 * （详情无阅读位置记忆，最新即默认）。
 * 滚动容器标记 data-scrollbar-content-signal="off"：运行中流式内容
 * 每秒改高度，豁免内容变化显色信号（滚动/悬停信号照旧），否则滚动条
 * 反复闪烁显色（lib/scrollbar-visibility 的豁免约定）。
 */
function SubagentDetail(props: { subagent: SubagentSegment }) {
  const { subagent } = props;
  // ===== 滚动跟随状态机（票 03 FOLLOWING/DETACHED 语汇）=====
  const container = useRef<HTMLDivElement | null>(null);
  const followRef = useRef<FollowMode>("following");
  // 跟随态的渲染镜像（驱动「回到最新」入口可见性，ref 不触发渲染）
  const [mode, setMode] = useState<FollowMode>("following");
  const pendingIntent = useRef<{ intent: VerticalIntent; at: number } | null>(
    null
  );
  const scriptedScroll = useRef<{ top: number; at: number } | null>(null);
  const lastTouchY = useRef<number | null>(null);

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

  function registerIntent(intent: VerticalIntent) {
    if (intent !== "neutral")
      pendingIntent.current = { intent, at: performance.now() };
  }

  // 切换子代理：重置贴底跟随（详情切换不保留上一个的阅读位置）
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    followRef.current = "following";
    setMode("following");
    snapToBottom(element);
  }, [subagent.id, snapToBottom]);

  // 内容变化（流式增量 / 工具卡更新）：跟随贴底、脱离保持阅读位置；
  // 上翻瞬间恰逢流式内容 commit 时用户的滚动意图优先（同主代理口径）。
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    if (anchorDecisionAfterContentChange(followRef.current) !== "snap") return;
    if (recentIntent() === "up") {
      commitMode("detached");
      return;
    }
    snapToBottom(element);
  }, [subagent, commitMode, snapToBottom, recentIntent]);

  // 分轮呈现（票 04）：turns 逐轮重建/流式；旧记录（无快照）回退拼接种思考单段
  const thinkingRounds =
    subagent.turns !== undefined
      ? subagent.turns
          .filter(
            (turn) => turn.reasoning !== undefined && turn.reasoning !== ""
          )
          .map((turn) => turn.reasoning!)
      : subagent.reasoning !== undefined && subagent.reasoning !== ""
        ? [subagent.reasoning]
        : [];
  // 空轮（工具事件预置的占位轮）不显示；最终轮即报告轮照常呈现
  const bodyRounds = (subagent.turns ?? [])
    .map((turn) => turn.content)
    .filter((content) => content !== "");
  const streaming = subagent.state === "running";
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={container}
        data-scrollbar-content-signal="off"
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
          const geometry: ScrollGeometry = {
            scrollTop: element.scrollTop,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
          };
          // 程序化贴底的回执（值匹配 + 短有效期）不动状态机（同主代理）
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
        }}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2"
      >
        <DelegationBrief subagent={subagent} />
        {thinkingRounds.length > 0 && (
          <SubagentThinking
            rounds={thinkingRounds}
            streaming={streaming}
            subagentId={subagent.id}
          />
        )}
        {bodyRounds.length > 0 && (
          <SubagentBody
            rounds={bodyRounds}
            streaming={streaming}
            subagentId={subagent.id}
          />
        )}
        <SubagentToolSequence subagent={subagent} />
        {subagent.state === "running" && <SubagentRunningIndicator />}
        {subagent.state === "queued" && (
          <p className="text-xs text-warn-fg">
            并发上限已满：该委派在队列中等待，前面的子代理结束后自动开跑。
          </p>
        )}
        {subagent.state === "interrupted" && (
          <p
            data-testid="subagent-interrupted-note"
            className="text-xs text-warn-fg"
          >
            应用在该委派运行中退出：此委派被中断，以上为已发生的部分记录。
          </p>
        )}
        {subagent.state === "done" && (
          <>
            <div className="text-xs text-fg-subtle">最终报告</div>
            <div
              data-testid="subagent-report"
              className={`markdown text-sm leading-6 ${
                subagent.ok === false ? "text-danger-fg" : "text-fg"
              }`}
            >
              <MarkdownContent content={subagent.report ?? ""} />
            </div>
            <SubagentReportActions subagent={subagent} />
          </>
        )}
        {/* 工作计划卡（ADR 0023）：详情滚动容器末尾常驻——运行中随子代理
          工具调用实时刷新（tools 逐次归并）、已完成回看终态、已中断回看
          最后快照；开合记忆按 subagentId 各自记忆（默认收起）。子代理
          没建计划时组件内部渲染 null 不占布局行。 */}
        <WorkPlanCardFromSubagentTools
          tools={subagent.tools}
          subagentId={subagent.id}
        />
      </div>
      {/* 「回到最新」入口（与主代理同款，2026-11-19 起）：脱离跟随时可见，
          点击回底并恢复跟随。详情恒有内容（委派说明块保底），计数恒真 */}
      {backToLatestVisible(mode, 1) && (
        <BackToLatestButton
          testId="subagent-back-to-latest"
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

/**
 * 子代理工具调用序列（主代理同款呈现，2026-11-19 呈现对齐轮）：内嵌
 * 工具进度以主消息流同款 ToolCallCard 呈现（运行中默认展开、完成收起、
 * 连续同名成组 ToolGroupView），挂在详情正文流——报告与操作行之前，
 * 不再以终态折叠清单堆在复制按钮之下。update_plan 排除出卡片序列：
 * 计划由底部工作计划卡呈现（与主消息流「计划不走通用卡」同源口径）。
 */
function SubagentToolSequence(props: { subagent: SubagentSegment }) {
  const { subagent } = props;
  // 适配成主流工具段形状以复用分组：seq/turnId/responseId 是流上下文
  // 字段，卡片与分组都不读，占位不参与呈现；id 保留真实调用 id（开合
  // 记忆键与截图请求按调用 id 作用域）
  const calls = useMemo(
    () =>
      subagent.tools
        .filter((tool) => tool.toolName !== PLAN_TOOL_NAME)
        .map<ToolCallSegment>((tool) => ({
          kind: "tool-call",
          id: tool.id,
          seq: 0,
          turnId: "",
          responseId: null,
          taskId: tool.taskId,
          toolName: tool.toolName,
          arguments: tool.arguments,
          output: tool.output,
          isError: tool.isError,
          running: tool.running,
          startedAt: tool.startedAt,
          endedAt: tool.endedAt,
        })),
    [subagent.tools]
  );
  if (calls.length === 0) return null;
  return (
    <ul data-testid="subagent-tool-sequence" className="flex flex-col gap-2">
      {groupConsecutiveTools(calls).map((item) =>
        item.kind === "group" ? (
          <ToolGroupView key={`group-${item.segments[0]?.id}`} item={item} />
        ) : item.kind === "single" ? (
          <ToolCallCard key={item.segment.id} call={item.segment} />
        ) : null
      )}
    </ul>
  );
}

/**
 * 运行指示（消息流底部 running-indicator 同款语汇）：子代理运行中详情
 * 底部常驻转圈行，位于工具卡之后（正文流最末尾）。已用时不在详情内
 * 重复跳动——右栏当前行/列表行的 Elapsed 已每秒刷新。
 */
function SubagentRunningIndicator() {
  return (
    <div
      data-testid="subagent-running-indicator"
      className="flex items-center gap-2 text-xs text-fg-muted"
    >
      <span className="generating-spinner shrink-0" aria-hidden="true" />
      <span>运行中</span>
    </div>
  );
}

/**
 * 委派说明块（详情首块）：主代理 spawn 时发来的委派正文——task 参数本身
 * 即完整委派说明（委派策略要求自包含目标/范围/线索/约束，多为多行长文）。
 * accent 左边框引述样式特殊标明「这是主代理的输入」，与子代理自身产出
 * （思考 / 报告）区分；默认 line-clamp-3 只露头部，挂载后测得文本实际
 * 溢出才显示「展开全部」，开合按 collapse-memory 记忆（默认部分显示）。
 */
function DelegationBrief(props: { subagent: SubagentSegment }) {
  const { subagent } = props;
  const { open, setOpen } = useCollapseState(
    `subagent-delegation-${subagent.id}`,
    false
  );
  const textRef = useRef<HTMLParagraphElement | null>(null);
  const [truncated, setTruncated] = useState(false);
  // 只在收起态测量：展开后 scrollHeight == clientHeight 会误报未截断，
  // 按钮随之消失就再也收不回去；SSR / 首帧默认 false（无按钮），挂载后修正。
  useEffect(() => {
    if (open) return;
    const el = textRef.current;
    if (el !== null) setTruncated(el.scrollHeight > el.clientHeight + 1);
  }, [open, subagent.task]);
  return (
    <div
      data-testid="subagent-delegation"
      // 卡片内距与工具卡（ToolCallCard）统一：px-3.5 py-[9px]（D 语言
      // 基准；accent 左边框保留引述语义）
      className="rounded border-l-2 border-accent bg-surface-muted px-3.5 py-[9px]"
    >
      <div className="flex items-center gap-2">
        {/* 状态在行尾以文字呈现；行首不放状态圆点——引述块以左边框定性，
            圆点与列表行状态点语汇重复（2026-11-19 呈现对齐轮去除） */}
        <span className="text-xs text-fg-subtle">主代理的委派说明</span>
        <span className={`ml-auto shrink-0 text-xs ${statusClass(subagent)}`}>
          {statusText(subagent)}
        </span>
      </div>
      <p
        ref={textRef}
        data-testid="subagent-delegation-text"
        className={`mt-1 whitespace-pre-wrap break-words text-sm text-fg ${
          open ? "" : "line-clamp-3"
        }`}
      >
        {subagent.task === "" ? "（任务描述缺失）" : subagent.task}
      </p>
      {truncated && (
        <button
          type="button"
          data-testid="subagent-delegation-toggle"
          onClick={() => setOpen(!open)}
          className="mt-1 text-xs text-accent hover:underline"
        >
          {open ? "收起" : "展开全部"}
        </button>
      )}
    </div>
  );
}

/**
 * 逐轮折叠块骨架（review Duplicated Code 修复：SubagentThinking 与
 * SubagentBody 同构提取）：流式默认展开、结束收起、collapse-memory 按
 * variant 记忆（subagent-thinking-{id} / subagent-body-{id}，语义不变）、
 * 逐轮分段（多轮时标注轮序）。data-testid 以 variant 前缀派生
 * （subagent-thinking-* / subagent-body-*），e2e 断言目标不变。
 * 受控 <details open> 的 onToggle 记忆规则同 ThinkingBlock（见其注释）。
 */
function SubagentRoundsDisclosure(props: {
  rounds: string[];
  streaming?: boolean;
  subagentId: string;
  variant: "thinking" | "body";
}) {
  const { rounds, streaming, variant } = props;
  const { open, setOpen } = useCollapseState(
    `subagent-${variant}-${props.subagentId}`,
    streaming === true
  );
  const summary = thinkingSummary(rounds[rounds.length - 1] ?? "");
  const title =
    streaming === true
      ? variant === "thinking"
        ? "思考中"
        : "生成中"
      : variant === "thinking"
        ? "已思考"
        : "正文";
  return (
    <details
      data-testid={`subagent-${variant}-block`}
      open={open}
      onToggle={(event) => {
        if (event.currentTarget.open !== open) {
          setOpen(event.currentTarget.open);
        }
      }}
      // 卡片内距与工具卡（ToolCallCard）统一：px-3.5 py-[9px]（D 语言
      // 折叠摘要行基准，2026-11-19 起与主代理思考/过程段卡同口径）
      className="rounded-lg bg-surface-muted px-3.5 py-[9px] text-xs text-fg-muted"
    >
      <summary
        data-testid={`subagent-${variant}-toggle`}
        className="flex cursor-pointer select-none items-center gap-2"
      >
        <DisclosureArrow open={open} />
        <span
          data-testid={`subagent-${variant}-summary`}
          className="min-w-0 flex-1 truncate"
        >
          {title}
          {rounds.length > 1 && ` · ${rounds.length} 轮`}
          {summary !== "" && ` · ${summary}`}
        </span>
      </summary>
      {open && (
        <div
          data-testid={`subagent-${variant}-content`}
          // 展开体缩进与工具卡展开区对齐（pl-7 ≈ 摘要行文字起点）
          className={`mt-2 overflow-y-auto whitespace-pre-wrap border-t border-line pt-2 pb-2 pl-7 pr-3 text-sm leading-6 text-fg ${
            variant === "thinking" ? "max-h-48" : "max-h-64"
          }`}
        >
          {rounds.map((text, index) => (
            <div
              key={index}
              data-testid={`subagent-${variant}-round-${index + 1}`}
            >
              {rounds.length > 1 && (
                <p className="mb-1 text-xs text-fg-subtle">第 {index + 1} 轮</p>
              )}
              <p className="mb-3 last:mb-0">{text}</p>
            </div>
          ))}
        </div>
      )}
    </details>
  );
}

/**
 * 子代理思考折叠块（思考档位 03；票 02 起随委派记录落库、票 04 起分轮）：
 * 与主任务思考块同构——流式运行中默认展开实时可见、结束自动收起、收起后
 * 以一行摘要回看；与报告文本分离，重启后由快照逐轮重建（旧记录回退
 * 拼接种单段，无轮边界）。实现为 SubagentRoundsDisclosure 的 variant 薄壳。
 */
function SubagentThinking(props: {
  rounds: string[];
  streaming?: boolean;
  subagentId: string;
}) {
  return <SubagentRoundsDisclosure {...props} variant="thinking" />;
}

/**
 * 子代理正文折叠块（ADR 0021 票 04）：与思考折叠同构（流式默认展开、
 * 结束收起、collapse-memory 独立键），逐轮分段呈现（轮边界 =
 * subagent_messages 行边界）；最终轮即报告轮——完成态报告块照旧呈现
 * 全文，本块是过程回看视角，两者并存不互斥。实现为
 * SubagentRoundsDisclosure 的 variant 薄壳。
 */
function SubagentBody(props: {
  rounds: string[];
  streaming?: boolean;
  subagentId: string;
}) {
  return <SubagentRoundsDisclosure {...props} variant="body" />;
}

/**
 * 报告操作行：与主代理 AssistantActions 同款——复制 / 导出 Markdown /
 * 完成时间，对象换成子代理报告与完成时刻。导出走 files.saveText
 * 原生保存对话框（取消静默）；完成时间显示条件对齐主代理——成功
 * 完成且 endedAt 有效（恢复态记录无起止对自然缺失、失败委派不显示）。
 */
function SubagentReportActions(props: { subagent: SubagentSegment }) {
  const { subagent } = props;
  const report = subagent.report ?? "";
  const [copyState, setCopyState] = useState<
    "idle" | "copying" | "copied" | "failed"
  >("idle");
  const [exportState, setExportState] = useState<
    "idle" | "exporting" | "exported" | "failed"
  >("idle");
  // 每次尝试独立令牌；卸载后作废，异步拒绝/成功不再更新已离开的详情。
  const attempt = useRef<object | null>(null);
  const exportAttempt = useRef<object | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exportResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      attempt.current = null;
      exportAttempt.current = null;
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
      if (exportResetTimer.current !== null)
        clearTimeout(exportResetTimer.current);
    },
    []
  );

  /** 瞬时反馈（copied / exported）到点回落 idle；令牌过期不覆盖新状态 */
  function scheduleReset(
    setState: (state: "idle") => void,
    timerRef: typeof resetTimer
  ) {
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setState("idle");
    }, 2000);
  }

  async function copy() {
    if (attempt.current !== null) return;
    if (resetTimer.current !== null) {
      clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }
    const current = {};
    attempt.current = current;
    setCopyState("copying");
    try {
      await navigator.clipboard.writeText(report);
      if (attempt.current === current) {
        setCopyState("copied");
        scheduleReset(setCopyState, resetTimer);
      }
    } catch {
      if (attempt.current === current) setCopyState("failed");
    } finally {
      if (attempt.current === current) attempt.current = null;
    }
  }

  async function exportMarkdown() {
    if (exportAttempt.current !== null) return;
    if (exportResetTimer.current !== null) {
      clearTimeout(exportResetTimer.current);
      exportResetTimer.current = null;
    }
    const current = {};
    exportAttempt.current = current;
    setExportState("exporting");
    try {
      const result = await window.codexlike.files.saveText({
        defaultFileName: `子代理-${exportFileNameBase(subagent.task)}.md`,
        // 逐轮结构导出（票 04）：委派说明 + 逐轮思考/正文 + 最终报告；
        // 复制按钮仍是纯报告文本（快速取用），两者口径不同
        content: subagentExportMarkdown(subagent),
      });
      if (exportAttempt.current !== current) return;
      if (result.saved) {
        setExportState("exported");
        scheduleReset(setExportState, exportResetTimer);
      } else {
        setExportState("idle");
      }
    } catch {
      if (exportAttempt.current === current) setExportState("failed");
    } finally {
      if (exportAttempt.current === current) exportAttempt.current = null;
    }
  }

  const completed =
    subagent.state === "done" && subagent.ok === true
      ? subagent.endedAt === null
        ? null
        : new Date(subagent.endedAt)
      : null;
  const formatted =
    completed !== null && Number.isFinite(completed.getTime())
      ? formatCompletedTime(completed, new Date())
      : null;
  const copyLabel = {
    idle: "复制报告",
    copying: "复制中",
    copied: "已复制",
    failed: "重试复制",
  }[copyState];
  const exportLabel = {
    idle: "导出为 Markdown",
    exporting: "导出中",
    exported: "已导出",
    failed: "导出失败，请重试",
  }[exportState];
  return (
    <div
      data-testid="subagent-report-actions"
      className="relative mt-1 flex flex-wrap items-center gap-3 text-xs text-fg-muted"
    >
      <button
        type="button"
        data-testid="subagent-report-copy"
        onClick={() => void copy()}
        disabled={copyState === "copying"}
        aria-label={copyLabel}
        title={copyLabel}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-muted hover:bg-hover hover:text-fg disabled:opacity-50"
      >
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {copyState === "copied" ? (
            <path d="m5 12 4 4L19 6" />
          ) : (
            <>
              <rect x="8" y="8" width="12" height="12" rx="2" />
              <path d="M16 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4" />
            </>
          )}
        </svg>
      </button>
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={copyState === "failed" ? "text-danger-fg" : "sr-only"}
      >
        {copyState === "copied"
          ? "已复制"
          : copyState === "failed"
            ? "复制失败，请重试"
            : ""}
      </span>
      <button
        type="button"
        data-testid="subagent-report-export"
        onClick={() => void exportMarkdown()}
        disabled={exportState === "exporting"}
        aria-label={exportLabel}
        title={exportLabel}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-muted hover:bg-hover hover:text-fg disabled:opacity-50"
      >
        {/* 下载（向下箭头 + 托盘，lucide download 官方 path）。旧版托盘弧
            命令多写一位参数，Chromium 解析到 h 处断链只渲染出左下小碎片。 */}
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      </button>
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={exportState === "failed" ? "text-danger-fg" : "sr-only"}
      >
        {exportState === "exported"
          ? "已导出"
          : exportState === "failed"
            ? "导出失败，请重试"
            : ""}
      </span>
      {formatted !== null && (
        <span>
          完成于{" "}
          <time
            data-testid="subagent-report-completed-at"
            dateTime={completed!.toISOString()}
            title={formatted.title}
          >
            {formatted.label}
          </time>
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 共享小件（列表行与详情头共用；标记行 SubagentStreamMarker 复用导出） */

/** 状态点：排队灰 / 运行黄脉冲 / 中断黄静态 / 完成绿 / 失败红（配色与脉冲
 *  的单一来源在 lib/subagent-status，review Repeated Switches 修复） */
export function StatusDot(props: { subagent: SubagentSegment }) {
  const { subagent } = props;
  return (
    <span
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClassName(
        subagent
      )} ${statusPulses(subagent) ? "animate-pulse" : ""}`}
    />
  );
}

// 状态文案/配色（票 04 抽到 lib/subagent-status 供导出共用；转出口保持
// SubagentStreamMarker 等既有 import 路径稳定）
export { statusText, statusClass };

/**
 * 已用时（mm:ss）：运行中以 now 实时刷新；完成/中断终态以 endedAt 定格。
 * 恢复的记录无 startedAt（或终态缺 endedAt）则不显示数字。
 */
export function formatElapsed(
  subagent: SubagentSegment,
  now: number
): string | null {
  if (subagent.startedAt === null) return null;
  const started = Date.parse(subagent.startedAt);
  if (Number.isNaN(started)) return null;
  // 终态定格口径（done/interrupted）取自 lib/subagent-status 单一来源
  const end = isTerminalSubagentState(subagent.state)
    ? subagent.endedAt === null
      ? NaN
      : Date.parse(subagent.endedAt)
    : now;
  if (Number.isNaN(end)) return null;
  const seconds = Math.max(0, Math.floor((end - started) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** 已用时展示（运行中每秒跳动，完成后定格）；缺失时间数据不渲染 */
export function Elapsed(props: { subagent: SubagentSegment }) {
  const now = useTickingNow(props.subagent.state === "running");
  const text = formatElapsed(props.subagent, now);
  if (text === null) return null;
  return (
    <span
      data-testid="subagent-elapsed"
      className="shrink-0 font-mono text-xs text-fg-subtle"
    >
      {text}
    </span>
  );
}
