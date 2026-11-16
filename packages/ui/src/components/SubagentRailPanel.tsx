import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import { exportFileNameBase } from "./AssistantActions";
import { DisclosureArrow } from "./DisclosureArrow";
import { formatCompletedTime } from "../lib/completed-time";
import { useCollapseState } from "../lib/collapse-memory";
import { markdownComponents } from "../lib/markdown";
import { thinkingSummary } from "../lib/thinking-summary";
import { summarizeToolCall } from "../lib/tool-summary";
import type { SubagentSegment } from "../lib/task-view";
import { formatDurationCn } from "../lib/turn-view";
import { useTickingNow } from "../lib/use-ticking-now";

/**
 * 子代理检视面板（ADR 0020，prototype/subagent-rail 变体 A 转正）：
 * 右栏第三 tab「子代理」的 tab 体——主从分栏（与「改动」tab 的
 * 文件列表 → diff 同构）。子代理的正文（最终报告 / 思考 / 工具进度）
 * 全部收纳于此，主消息流只留单行轻量标记（SubagentStreamMarker）。
 *
 * 结构：上段子代理列表（状态点 + 任务截断 + 状态 + 已用时，运行中每秒
 * 跳动），下段选中者完整详情（任务头 → 思考折叠 → 运行态当前工具 /
 * 完成态报告 + 操作行 + 工具清单）。无选中（或选中者已不在列表）时
 * 默认选中最后一个（最新）；消息流标记行点击经 focus prop 定位选中
 * 并滚动到列表项。
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
  const listRef = useRef<HTMLUListElement | null>(null);
  // 标记行点击定位：focus 信号变化时选中对应子代理并滚动到列表项
  const focus = props.focus;
  useEffect(() => {
    if (focus === null) return;
    if (!subagents.some((item) => item.id === focus.id)) return;
    setSelectedId(focus.id);
    listRef.current
      ?.querySelector(`[data-subagent-id="${focus.id}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [focus, subagents]);
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

  return (
    <div
      data-testid="subagents-panel-body"
      className="flex min-h-0 flex-1 flex-col"
    >
      {/* 上段：子代理列表（同改动 tab 文件清单的 max-h 配比与行样式） */}
      <ul
        ref={listRef}
        className="max-h-[45%] shrink-0 overflow-auto border-b border-line py-0.5"
      >
        {subagents.map((item) => (
          <li key={item.id} data-subagent-id={item.id}>
            <button
              type="button"
              data-testid="subagent-rail-item"
              data-subagent-state={item.state}
              onClick={() => setSelectedId(item.id)}
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
      {/* 下段：选中者详情 */}
      {selected === null ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-fg-subtle">
          点上方子代理查看详情
        </div>
      ) : (
        <SubagentDetail subagent={selected} />
      )}
    </div>
  );
}

/** 详情区：任务头 + 三态内容（排队提示 / 运行进度 / 报告与操作行） */
function SubagentDetail(props: { subagent: SubagentSegment }) {
  const { subagent } = props;
  const hasReasoning =
    subagent.reasoning !== undefined && subagent.reasoning !== "";
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2">
      <div className="flex items-start gap-2">
        <StatusDot subagent={subagent} />
        <span className="min-w-0 flex-1 break-words text-sm text-fg">
          {subagent.task === "" ? "（任务描述缺失）" : subagent.task}
        </span>
        <span className={`shrink-0 text-xs ${statusClass(subagent)}`}>
          {statusText(subagent)}
        </span>
      </div>
      {hasReasoning && (
        <SubagentThinking
          reasoning={subagent.reasoning!}
          streaming={subagent.state === "running"}
          subagentId={subagent.id}
        />
      )}
      {subagent.state === "running" && <RunningStatus subagent={subagent} />}
      {subagent.state === "queued" && (
        <p className="text-xs text-warn-fg">
          并发上限已满：该委派在队列中等待，前面的子代理结束后自动开跑。
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
 * 子代理思考折叠块（思考档位 03；票 02 起随委派记录落库）：与主任务
 * 思考块同构——流式运行中默认展开实时可见、结束自动收起、收起后以
 * 一行摘要回看（开合按 collapseKey 记忆）；与报告文本分离，重启后由
 * 落盘 reasoning 重建（旧记录自然缺失，不渲染空块）。
 * 受控 <details open> 的 onToggle 记忆规则同 ThinkingBlock（见其注释）。
 */
function SubagentThinking(props: {
  reasoning: string;
  streaming?: boolean;
  subagentId: string;
}) {
  const { reasoning, streaming } = props;
  const { open, setOpen } = useCollapseState(
    `subagent-thinking-${props.subagentId}`,
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
      className="rounded-lg border border-line bg-surface-muted px-3 py-2 text-xs text-fg-muted"
    >
      <summary
        data-testid="subagent-thinking-toggle"
        className="flex cursor-pointer select-none items-center gap-2"
      >
        <DisclosureArrow open={open} />
        <span
          data-testid="subagent-thinking-summary"
          className="min-w-0 flex-1 truncate"
        >
          {streaming === true ? "思考中" : "已思考"}
          {summary !== "" && ` · ${summary}`}
        </span>
      </summary>
      <div
        data-testid="subagent-thinking-content"
        className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap border-t border-line pt-2 pl-4 text-fg"
      >
        {reasoning}
      </div>
    </details>
  );
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
        content: report,
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
        {/* 下载（向下箭头 + 托盘） */}
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
          <path d="M12 3v12m0 0-4-4m4 4 4-4" />
          <path d="M4 17v2a2 2 2 0 0 0 2 2h12a2 2 2 0 0 0 2-2v-2" />
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

/** 状态点：排队灰 / 运行黄脉冲 / 完成绿 / 失败红 */
export function StatusDot(props: { subagent: SubagentSegment }) {
  const { subagent } = props;
  const running = subagent.state === "running";
  const cls =
    subagent.state === "done"
      ? subagent.ok === false
        ? "bg-danger-fg"
        : "bg-ok-fg"
      : subagent.state === "running"
        ? "bg-warn-fg"
        : "bg-fg-subtle";
  return (
    <span
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${cls} ${
        running ? "animate-pulse" : ""
      }`}
    />
  );
}

export function statusText(subagent: SubagentSegment): string {
  return subagent.state === "queued"
    ? "排队中"
    : subagent.state === "running"
      ? "运行中"
      : subagent.ok === false
        ? "失败"
        : "完成";
}

export function statusClass(subagent: SubagentSegment): string {
  return subagent.state === "done"
    ? subagent.ok === false
      ? "text-danger-fg"
      : "text-ok-fg"
    : "text-warn-fg";
}

/**
 * 已用时（mm:ss）：运行中以 now 实时刷新；完成态以 endedAt 定格总耗时。
 * 恢复的记录无 startedAt（或完成态缺 endedAt）则不显示数字。
 */
export function formatElapsed(
  subagent: SubagentSegment,
  now: number
): string | null {
  if (subagent.startedAt === null) return null;
  const started = Date.parse(subagent.startedAt);
  if (Number.isNaN(started)) return null;
  const end =
    subagent.state === "done"
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
