import type { GoalVerificationOutcome } from "@codexlike/agent-core";

import {
  goalNextStepText,
  goalVerificationText,
  goalVerifyingText,
} from "../lib/goal-view";
import type { GoalVerificationSegment } from "../lib/task-view";

/**
 * 完成判定标记行（ADR 0035，GLOSSARY「完成判定」）：一次判定在消息流原位
 * 留下的一行小字「第 N 次迭代 · 验证中 / 已完成 / 未完成 / 判定不可用」——
 * 不占过程区空间，结论明细随任务落库可回看。先例 PlanMarkerRow（update_plan
 * 的流内极简标记）。
 * 同一行有三个形态：
 * - 验证中：判定在途的占位（结论到达后原位升级为同一行）；
 * - 已完成 / 未完成：判定给出的结论，未完成附下一步方向一句摘要；
 * - 判定不可用：判定自身故障、没有结论——如实呈现，不写成「未完成」。
 */
export function GoalVerificationMarker(props: {
  segment: GoalVerificationSegment;
}) {
  const { segment } = props;

  if (segment.pending !== undefined) {
    return (
      <li
        data-testid="goal-verifying-marker"
        data-goal-round={segment.pending.round}
        className="flex min-w-0 items-center gap-2 py-0.5 text-xs text-fg-subtle"
      >
        <TargetIcon />
        <span className="shrink-0">
          {goalVerifyingText(segment.pending.round)}
        </span>
      </li>
    );
  }

  const { verification } = segment;
  if (verification === undefined) return null;
  const nextStep = goalNextStepText(verification);
  return (
    <li
      data-testid="goal-verification-marker"
      data-goal-round={verification.round}
      data-goal-verdict={verification.outcome}
      title={verification.reason}
      className="flex min-w-0 items-center gap-2 py-0.5 text-xs text-fg-subtle"
    >
      <TargetIcon />
      {/* 文案单一来源：可见文本即 goalVerificationText（已完成成功色 / 其余警示色） */}
      <span className={`shrink-0 ${CONCLUSION_CLASSES[verification.outcome]}`}>
        {goalVerificationText(verification)}
      </span>
      {nextStep !== null && (
        <>
          {" · "}
          <span
            data-testid="goal-verification-next-step"
            className="min-w-0 truncate"
            title={verification.nextAction}
          >
            {nextStep}
          </span>
        </>
      )}
    </li>
  );
}

/** 结论色：已完成成功色；未完成与判定不可用警示色（待关注） */
const CONCLUSION_CLASSES: Record<GoalVerificationOutcome, string> = {
  passed: "text-ok-fg",
  unpassed: "text-warn-fg",
  unavailable: "text-warn-fg",
};

/** 靶心图标：与目标进度行同一语汇，标记行缩小一号 */
function TargetIcon() {
  return (
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
  );
}
