import {
  GOAL_STATUS_NAMES,
  type GoalRecord,
  type GoalStatus,
} from "@codexlike/agent-core";

import {
  formatGoalElapsed,
  goalElapsedMs,
  goalSummary,
} from "../lib/goal-view";
import { useTickingNow } from "../lib/use-ticking-now";

/** 状态色：进行中主张色、已完成成功色、暂停类警示色、已清除弱化（已完成后清除前的回看态） */
const STATUS_CLASSES: Record<GoalStatus, string> = {
  active: "text-accent",
  completed: "text-ok-fg",
  paused: "text-warn-fg",
  unmet: "text-warn-fg",
  "budget-limited": "text-warn-fg",
  cleared: "text-fg-subtle",
};

/** 目标图标：同心圆靶（线条对齐 D 设计语言，size-3 与工具名徽章同语汇） */
function GoalIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0 text-accent"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * 目标进度行（ADR 0035，GLOSSARY「目标」）：输入框上方常驻的一行——目标
 * 摘要、状态（六态称谓）、累计时长。进行中时长达实时跳动，离开进行中
 * （已暂停 / 已完成等）即定格。没有目标时不占布局行（空态）。
 * 暂停 / 恢复 / 编辑 / 清除按钮组在票 04 接入本行。
 */
export function GoalProgressRow(props: { goal: GoalRecord | null }) {
  const { goal } = props;
  // Hook 不受早退影响：是否计时由「目标进行中」决定，空态不起计时器
  const now = useTickingNow(goal?.status === "active");
  if (goal === null) return null;
  return (
    <div
      data-testid="goal-progress-row"
      data-goal-status={goal.status}
      role="status"
      aria-label="目标进度"
      // 卡片内距与工具卡（ToolCallCard）统一：px-3.5 py-[9px]（D 语言折叠摘要行基准）
      className="flex items-center gap-2 rounded-lg bg-surface-muted px-3.5 py-[9px] text-xs text-fg-muted"
    >
      <GoalIcon />
      <span className="shrink-0 font-medium text-fg">目标</span>
      <span
        data-testid="goal-progress-summary"
        className="min-w-0 flex-1 truncate text-fg"
        title={goal.text}
      >
        {goalSummary(goal.text)}
      </span>
      <span
        data-testid="goal-progress-status"
        className={`shrink-0 font-medium ${STATUS_CLASSES[goal.status]}`}
      >
        {GOAL_STATUS_NAMES[goal.status]}
      </span>
      <span
        data-testid="goal-progress-elapsed"
        className="shrink-0 font-mono text-fg-subtle"
        title="累计时长"
      >
        {formatGoalElapsed(goalElapsedMs(goal, now))}
      </span>
    </div>
  );
}
