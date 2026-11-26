import { GOAL_STATUS_NAMES, type GoalRecord, type GoalStatus } from "./types";

/**
 * 目标六态状态机（ADR 0035「状态机六态」，GLOSSARY「目标」）。
 * 纯函数、浏览器安全：状态词汇与转换表是单一事实来源，宿主（desktop
 * goal 编排器 / 控制面 IPC）与界面枚举都从这里取，不各自维护副本。
 *
 * 票 02 走通「进行中 → 已完成 / 已暂停」两条路径；票 03 接上续跑；控制面
 * （票 04：resume / clear / 编辑）与两道护栏（票 05：unmet / budget-limit）
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
 * 某状态下某转换是否可行（不抛错地查询转换表）：控制面的按钮可用性据此
 * 给出（能暂停 ⟺ 进行中；能恢复 ⟺ 已暂停 / 预算受限 / 未达成；能清除 ⟺
 * 未清除的任一状态），界面与状态机不会各存一份表而漂移。
 */
export function canTransitionGoal(
  status: GoalStatus,
  transition: GoalTransition
): boolean {
  return GOAL_TRANSITIONS[status].includes(transition);
}

/**
 * 可编辑目标文本的状态（票 04 控制面的「编辑」）：已暂停 / 预算受限 / 未达成
 * ——都是可以先改目标再恢复的状态。进行中不可编辑：完成判定以目标文本为
 * 判据，改文本不能与在途的判定竞态，先暂停再改；已完成与已清除是定稿的
 * 历史，逐轮验证记录是按当时的目标文本判出来的，不再修改。
 */
const GOAL_EDITABLE_STATUSES: readonly GoalStatus[] = [
  "paused",
  "budget-limited",
  "unmet",
];

/** 目标文本在该状态下是否可编辑（见 GOAL_EDITABLE_STATUSES） */
export function isGoalEditable(status: GoalStatus): boolean {
  return GOAL_EDITABLE_STATUSES.includes(status);
}

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
 * 累计时长只计进行中的区段：离开进行中闭合当前段计入 activeMs，
 * 进入进行中时以 at 另起一段（activeSince），其余状态时长原样保留。
 * 连续计数（空转 / 判定故障）同理只在本段进行中内累计：进入进行中
 * （恢复）即清零，离开进行中原样保留供回看。
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
    idleStreak: status === "active" ? 0 : goal.idleStreak,
    failureStreak: status === "active" ? 0 : goal.failureStreak,
    updatedAt: at,
  };
}

/**
 * 重启恢复为暂停态（ADR 0035「重启与恢复」）时当前进行中区段的闭合终点，
 * 供 advanceGoal(goal, "pause", 终点) 记账。
 * 进程被杀的时刻无从得知，停机时长又不得计入累计时长——所以终点不取重启
 * 时刻，而取该任务落库里最晚的时间戳（停机前最后一次有记录的活动），并夹在
 * 进行中起点与重启时刻之间：
 * - 不早于起点：落库里没有晚于起点的记录（目标刚设定 / 刚恢复就退出）时
 *   这一段按 0 计；
 * - 不晚于重启时刻：落库时间戳晚于重启时刻（系统时钟回拨后启动）时不产生
 *   「未来」的时长。
 * lastPersistedAt：该任务落库里最晚的时间戳；没有任何记录为 null。
 */
export function goalRestartPauseAt(
  goal: GoalRecord,
  lastPersistedAt: string | null,
  now: string
): string {
  const since = Date.parse(goal.activeSince ?? "");
  // 起点缺失或非法：没有可闭合的进行中区段（advanceGoal 对此按 0 计）
  if (Number.isNaN(since)) return now;
  const latest = lastPersistedAt === null ? since : Date.parse(lastPersistedAt);
  const end = Math.max(since, latest);
  const current = Date.parse(now);
  return new Date(
    Number.isNaN(current) ? end : Math.min(end, current)
  ).toISOString();
}
