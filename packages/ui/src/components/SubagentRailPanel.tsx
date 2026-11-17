import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import { exportFileNameBase } from "./AssistantActions";
import { DisclosureArrow } from "./DisclosureArrow";
import { WorkPlanCardFromSubagentTools } from "./WorkPlanCard";
import { formatCompletedTime } from "../lib/completed-time";
import { useCollapseState } from "../lib/collapse-memory";
import { markdownComponents } from "../lib/markdown";
import { subagentExportMarkdown } from "../lib/subagent-export";
import {
  isTerminalSubagentState,
  statusClass,
  statusDotClassName,
  statusPulses,
  statusText,
} from "../lib/subagent-status";
import { thinkingSummary } from "../lib/thinking-summary";
import { summarizeToolCall } from "../lib/tool-summary";
import type { SubagentSegment } from "../lib/task-view";
import { formatDurationCn } from "../lib/turn-view";
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
 * 定位——选中并自动展开浮层滚动到对应项（用户从消息流进来要找的就是
 * 那一项，浮层可见才可定位）。
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
  // focus 定位目标：listOpen 置位与浮层挂载不同帧，滚动延到浮层渲染后
  const [pendingScrollId, setPendingScrollId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  // 标记行点击定位：focus 信号变化时选中对应子代理、展开浮层并滚动到
  // 列表项。每个 focus.seq 只消费一次（ref 幂等）：依赖里保留 subagents
  // 是为「段晚于点击到达列表」的重试，但运行中流式会持续产生新数组引用，
  // 无幂等守卫时每次流式事件都重放 setSelectedId(focus.id)，把用户在
  // 列表里手动点选的子代理强行拉回 focus 目标（点击无法切换的回归）。
  const focus = props.focus;
  const consumedFocusSeqRef = useRef(-1);
  useEffect(() => {
    if (focus === null) return;
    if (focus.seq === consumedFocusSeqRef.current) return;
    if (!subagents.some((item) => item.id === focus.id)) return;
    consumedFocusSeqRef.current = focus.seq;
    setSelectedId(focus.id);
    setListOpen(true);
    setPendingScrollId(focus.id);
  }, [focus, subagents]);
  // 浮层挂载后定位滚动（focus effect 与浮层渲染之间隔一帧）
  useEffect(() => {
    if (!listOpen || pendingScrollId === null) return;
    listRef.current
      ?.querySelector(`[data-subagent-id="${pendingScrollId}"]`)
      ?.scrollIntoView({ block: "nearest" });
    setPendingScrollId(null);
  }, [listOpen, pendingScrollId]);
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
              ref={listRef}
              data-testid="subagent-rail-list"
              className="absolute inset-x-0 top-0 z-20 max-h-[85%] overflow-auto rounded-b-lg border border-line bg-surface py-0.5 shadow-[0_8px_24px_rgba(0,0,0,0.16)]"
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

/** 详情区：委派要求块 + 三态内容（排队提示 / 运行进度 / 报告与操作行；interrupted 留痕回看） */
function SubagentDetail(props: { subagent: SubagentSegment }) {
  const { subagent } = props;
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
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2">
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
      {subagent.state === "running" && <RunningStatus subagent={subagent} />}
      {subagent.state === "queued" && (
        <p className="text-xs text-warn-fg">
          并发上限已满：该委派在队列中等待，前面的子代理结束后自动开跑。
        </p>
      )}
      {subagent.state === "interrupted" && (
        <>
          <p
            data-testid="subagent-interrupted-note"
            className="text-xs text-warn-fg"
          >
            应用在该委派运行中退出：此委派被中断，以上为已发生的部分记录。
          </p>
          <ToolsDetails subagent={subagent} />
        </>
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
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={markdownComponents}
            >
              {subagent.report ?? ""}
            </ReactMarkdown>
          </div>
          <SubagentReportActions subagent={subagent} />
          <ToolsDetails subagent={subagent} />
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
      className="rounded border-l-2 border-accent bg-surface-muted py-2 pl-3 pr-2"
    >
      <div className="flex items-center gap-2">
        <StatusDot subagent={subagent} />
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

/** 运行态进度：当前活动工具 + 已执行次数（已用时在列表行跳动显示） */
function RunningStatus(props: { subagent: SubagentSegment }) {
  const { subagent } = props;
  const activeTool = [...subagent.tools]
    .reverse()
    .find((tool) => tool.running === true);
  return (
    <div className="rounded border border-line bg-surface-muted px-3 py-2 text-xs text-fg-muted">
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
      className="rounded-lg border border-line bg-surface-muted px-3 py-2 text-xs text-fg-muted"
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
      <div
        data-testid={`subagent-${variant}-content`}
        className={`mt-2 overflow-y-auto whitespace-pre-wrap border-t border-line pt-2 pl-4 text-sm leading-6 text-fg ${
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

/** 工具清单折叠（行尾耗时：起止对齐全才显示） */
function ToolsDetails(props: { subagent: SubagentSegment }) {
  if (props.subagent.tools.length === 0) return null;
  return (
    <details data-testid="subagent-tools" className="mt-2">
      <summary className="cursor-pointer text-xs text-fg-subtle">
        工具调用（{props.subagent.tools.length} 次）
      </summary>
      <ul className="mt-1 flex flex-col gap-1">
        {props.subagent.tools.map((tool) => (
          <li
            key={tool.id}
            className="flex items-center gap-2 rounded bg-code-bg px-2 py-1 font-mono text-xs"
          >
            <span className="text-accent">{tool.toolName}</span>
            <span className="min-w-0 flex-1 truncate text-fg-subtle">
              {summarizeToolCall(tool.toolName, tool.arguments)}
            </span>
            <span className={tool.isError ? "text-danger-fg" : "text-ok-fg"}>
              {tool.isError ? "失败" : "完成"}
            </span>
            {tool.startedAt !== undefined && tool.endedAt !== undefined && (
              <span className="shrink-0 text-fg-subtle">
                {formatDurationCn(tool.endedAt - tool.startedAt, true)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
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
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-line bg-surface-muted hover:bg-hover hover:text-fg disabled:opacity-50"
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
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-line bg-surface-muted hover:bg-hover hover:text-fg disabled:opacity-50"
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
