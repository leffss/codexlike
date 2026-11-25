import type { GoalVerificationRecord } from "@codexlike/agent-core";

import { goalVerificationText } from "../lib/goal-view";

/**
 * 完成判定标记行（ADR 0035，GLOSSARY「完成判定」）：一次判定在消息流原位
 * 留下的一行小字「第 N 次迭代 · 已完成 / 未完成」——不占过程区空间，
 * 结论明细随任务落库可回看。先例 PlanMarkerRow（update_plan 的流内极简标记）。
 * 票 03 在此补「验证中」占位与未完成时的下一步方向摘要。
 */
export function GoalVerificationMarker(props: {
  verification: GoalVerificationRecord;
}) {
  const { verification } = props;
  return (
    <li
      data-testid="goal-verification-marker"
      data-goal-round={verification.round}
      data-goal-verdict={verification.passed ? "passed" : "unpassed"}
      title={verification.reason}
      className="flex min-w-0 items-center gap-2 py-0.5 text-xs text-fg-subtle"
    >
      {/* 靶心图标：与目标进度行同一语汇，标记行缩小一号 */}
      <svg
        viewBox="0 0 16 16"
        className="size-3 shrink-0 opacity-70"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="5.5" />
        <circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none" />
      </svg>
      {/* 文案单一来源：可见文本即 goalVerificationText（已完成成功色 / 未完成警示色） */}
      <span
        className={`shrink-0 ${
          verification.passed ? "text-ok-fg" : "text-warn-fg"
        }`}
      >
        {goalVerificationText(verification)}
      </span>
    </li>
  );
}
