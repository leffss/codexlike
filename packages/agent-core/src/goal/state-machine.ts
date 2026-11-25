import { GOAL_STATUS_NAMES, type GoalRecord, type GoalStatus } from "./types";

/**
 * 目标六态状态机（ADR 0035「状态机六态」，GLOSSARY「目标」）。
 * 纯函数、浏览器安全：状态词汇与转换表是单一事实来源，宿主（desktop
 * goal 编排器 / 控制面 IPC）与界面枚举都从这里取，不各自维护副本。
 *
 * 本票（02）只走到「进行中 → 已完成 / 已暂停」两条路径；续跑（票 03）、
 * 控制面（票 04：resume / clear）与两道护栏（票 05：unmet / budget-limit）
 * 在同一张转换表上接线，不新增状态。
 */

/**
 * 状态机转换（动词 = 触发它的动作或事件）：
 * - `pause` 暂停：Stop、暂停操作、回合出错（进行中 → 已暂停）
 * - `resume` 恢复：手动恢复（已暂停 / 预算受限 / 未达成 → 进行中）
 * - `complete` 完成：完成判定通过（进行中 → 已完成）
 * - `unmet` 未达成：连续空转阻断（进行中 → 未达成）
 * - `budget-limit` 预算受限：token 预算超限（进行中 → 预算受限，非终止）
 * - `clear` 清除：清除目标（任何未清除状态 → 已清除）
 */
export type GoalTransition =
  "pause" | "resume" | "complete" | "unmet" | "budget-limit" | "clear";

/** 转换的中文称谓（越界转换的拒绝提示用） */
export const GOAL_TRANSITION_NAMES: Record<GoalTransition, string> = {
  pause: "暂停",
  resume: "恢复",
  complete: "完成",
  unmet: "判定为未达成",
  "budget-limit": "转为预算受限",
  clear: "清除",
};

/** 每个状态允许的转换（规格定案：已完成后只可清除；已清除为终态） */
const GOAL_TRANSITIONS: Record<GoalStatus, readonly GoalTransition[]> = {
  active: ["pause", "complete", "unmet", "budget-limit", "clear"],
  paused: ["resume", "clear"],
  "budget-limited": ["resume", "clear"],
  unmet: ["resume", "clear"],
  completed: ["clear"],
  cleared: [],
};

/** 转换落入的状态 */
const GOAL_NEXT_STATUS: Record<GoalTransition, GoalStatus> = {
  pause: "paused",
  resume: "active",
  complete: "completed",
  unmet: "unmet",
  "budget-limit": "budget-limited",
  clear: "cleared",
};

/**
 * 未结束的目标：仍占用「一任务同时至多一个目标」的名额（进行中 / 已暂停 /
 * 预算受限 / 未达成）。已完成与已清除让出名额，任务可再设定新目标。
 */
export function isGoalOpen(status: GoalStatus): boolean {
  return status !== "completed" && status !== "cleared";
}

/** 进行中段的时长（ms）：起点缺失或非法按 0 计，不产生负时长 */
function activeSegmentMs(activeSince: string | null, at: string): number {
  if (activeSince === null) return 0;
  const since = Date.parse(activeSince);
  const until = Date.parse(at);
  if (Number.isNaN(since) || Number.isNaN(until)) return 0;
  return Math.max(0, until - since);
}

/**
 * 推进目标状态（不落库，返回新记录；原记录不变）。
 * 累计时长只计进行中的区段：离开进行中时闭合当前段计入 activeMs，
 * 进入进行中时以 at 另起一段（activeSince），其余状态时长原样保留。
 * 越界转换抛中文错误（目标<当前状态>，不能<转换>）。
 */
export function advanceGoal(
  goal: GoalRecord,
  transition: GoalTransition,
  at: string
): GoalRecord {
  if (!GOAL_TRANSITIONS[goal.status].includes(transition)) {
    throw new Error(
      `目标${GOAL_STATUS_NAMES[goal.status]}，不能${GOAL_TRANSITION_NAMES[transition]}`
    );
  }
  const wasActive = goal.status === "active";
  const status = GOAL_NEXT_STATUS[transition];
  return {
    ...goal,
    status,
    activeMs: wasActive
      ? goal.activeMs + activeSegmentMs(goal.activeSince, at)
      : goal.activeMs,
    activeSince: status === "active" ? at : wasActive ? null : goal.activeSince,
    updatedAt: at,
  };
}
