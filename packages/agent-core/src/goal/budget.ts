import type { TaskRecord } from "../task/types";
import type { GoalRecord } from "./types";

/**
 * 目标模式的 token 预算（ADR 0035「护栏」，规格故事 13）：对账口径对接
 * GLOSSARY「任务用量」/ ADR 0029——目标是任务上的实体，不另记一套账。
 * 纯函数、浏览器安全：宿主编排器（idle 边界对账）与界面（进度行的用量显示）
 * 共用同一口径，不各自维护副本。
 */

/** 任务用量账目的四列：主任务 / 子代理 × 输入 / 输出 */
type UsageColumns = Pick<
  TaskRecord,
  | "mainInputTokens"
  | "mainOutputTokens"
  | "subagentInputTokens"
  | "subagentOutputTokens"
>;

/**
 * 任务用量账目（tokens）= 四列之和。主任务各轮、子代理、压缩与完成判定自身
 * 的模型调用都在这四列里（ADR 0029：凡以任务身份发起的模型调用全部计入）。
 * 列缺失（旧记录 / 未入账）按 0 计。
 */
export function taskUsageTokens(record: UsageColumns | undefined): number {
  if (record === undefined) return 0;
  return (
    (record.mainInputTokens ?? 0) +
    (record.mainOutputTokens ?? 0) +
    (record.subagentInputTokens ?? 0) +
    (record.subagentOutputTokens ?? 0)
  );
}

/**
 * 目标消耗（tokens）= 当前任务用量账目 − 对账基线：目标设定以来该任务的用量
 * 增量，涵盖主任务各轮、子代理、压缩与完成判定自身；任务此前的用量不计入。
 */
export function goalSpentTokens(
  goal: Pick<GoalRecord, "baselineTokens">,
  usageTokens: number
): number {
  return usageTokens - goal.baselineTokens;
}

/**
 * 目标用量是否达到预算（宿主据此转「预算受限」）：用量达到预算即超——预算
 * 是最多可消耗的量，用尽之后没有余量再跑一轮。未设预算（null）恒不超。
 */
export function isGoalBudgetExceeded(
  goal: Pick<GoalRecord, "budgetTokens" | "baselineTokens">,
  usageTokens: number
): boolean {
  return (
    goal.budgetTokens !== null &&
    goalSpentTokens(goal, usageTokens) >= goal.budgetTokens
  );
}
