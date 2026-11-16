import type { SubagentSegment } from "../lib/task-view";

import {
  Elapsed,
  StatusDot,
  statusClass,
  statusText,
} from "./SubagentRailPanel";

/**
 * 子代理消息流标记行（ADR 0020，prototype/subagent-rail 变体 A 转正）：
 * 子代理正文迁右栏「子代理」tab 后，消息流内只留这行时序锚点——
 * 单行轻量标记（子代理徽章 + 任务截断 + 状态 + 已用时），整行可点，
 * 点击经 onOpen 打开右栏、切到子代理 tab 并定位选中对应子代理。
 * 取代退役的 SubagentCard 大卡（排队/运行/完成三态正文全部在右栏）。
 */
export function SubagentStreamMarker(props: {
  subagent: SubagentSegment;
  /** 点击打开右栏子代理 tab 并定位（WorkspacePage 装配 focus 信号） */
  onOpen?: (subagentId: string) => void;
}) {
  const { subagent } = props;
  return (
    <li data-testid="subagent-stream-marker" className="max-w-full">
      <button
        type="button"
        data-testid="subagent-stream-marker-toggle"
        data-subagent-state={subagent.state}
        onClick={() => props.onOpen?.(subagent.id)}
        title="在右栏「子代理」tab 查看报告与进度"
        className="flex w-full items-center gap-2 rounded-lg border border-line bg-surface-muted px-3 py-1.5 text-left text-xs hover:bg-hover"
      >
        <span className="shrink-0 rounded bg-subagent-bg px-1.5 py-0.5 font-mono text-[11px] text-subagent-fg">
          子代理
        </span>
        <span
          className={`min-w-0 flex-1 truncate ${
            subagent.state === "done" ? "text-fg-muted" : "text-fg"
          }`}
          title={subagent.task}
        >
          {subagent.task === "" ? "（任务描述缺失）" : subagent.task}
        </span>
        <StatusDot subagent={subagent} />
        <span className={`shrink-0 ${statusClass(subagent)}`}>
          {statusText(subagent)}
        </span>
        <Elapsed subagent={subagent} />
        <span className="shrink-0 text-fg-subtle">右栏查看 →</span>
      </button>
    </li>
  );
}
