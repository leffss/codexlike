import type { GoalRecord, GoalVerificationRecord } from "@codexlike/agent-core";

/**
 * 目标模式呈现层纯函数（ADR 0035，GLOSSARY「目标」「完成判定」）：
 * 累计时长的求值与文案、进度行摘要、判定标记行文案。
 * 状态称谓取 agent-core 的 GOAL_STATUS_NAMES（单一来源），这里不另存副本。
 */

/** 进度行摘要的截断长度（字符）：超出以省略号收尾，全文由 title 承载 */
const SUMMARY_MAX_CHARS = 60;

/**
 * 目标累计时长（ms）：已闭合的进行中段（activeMs）+ 当前进行中段的已过时间。
 * 非进行中（activeSince 为 null）只返回 activeMs；起点缺失或系统时钟回拨
 * 不产生负时长。
 */
export function goalElapsedMs(goal: GoalRecord, now: number): number {
  if (goal.activeSince === null) return goal.activeMs;
  const since = Date.parse(goal.activeSince);
  if (Number.isNaN(since)) return goal.activeMs;
  return goal.activeMs + Math.max(0, now - since);
}

/** 时长文案：不足一分钟「N 秒」；不足一小时「N 分 [M 秒]」；以上「N 小时 [M 分]」 */
export function formatGoalElapsed(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0)
    return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
}

/** 进度行摘要：取目标文本的首个非空行，超长截断（全文见 title） */
export function goalSummary(text: string): string {
  const firstLine =
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "") ?? "";
  return firstLine.length > SUMMARY_MAX_CHARS
    ? `${firstLine.slice(0, SUMMARY_MAX_CHARS)}…`
    : firstLine;
}

/** 判定标记行文案（GLOSSARY「完成判定」）：「第 N 次迭代 · 已完成 / 未完成」 */
export function goalVerificationText(
  verification: Pick<GoalVerificationRecord, "round" | "passed">
): string {
  return `第 ${verification.round} 次迭代 · ${
    verification.passed ? "已完成" : "未完成"
  }`;
}
