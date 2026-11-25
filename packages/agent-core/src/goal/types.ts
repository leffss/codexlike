/**
 * 目标模式领域类型（ADR 0035，GLOSSARY「目标」「目标模式」「完成判定」）。
 * 全部可 JSON 序列化：GoalRecord / GoalVerificationRecord 随任务事件信封
 * 经 Electron IPC 到达渲染进程，也是持久化与 IPC 共用的形状。
 * 纯类型与浏览器安全的常量——ui 进度行 / 标记行从这里 import。
 */

/**
 * 目标状态机六态（ADR 0035「状态机六态」）：
 * - `active` 进行中（「验证中」是进度行的副状态，不独立成态）
 * - `paused` 已暂停（Stop / 暂停操作；可恢复）
 * - `completed` 已完成（完成判定通过）
 * - `unmet` 未达成（连续 3 空转轮阻断）
 * - `budget-limited` 预算受限（token 预算超限，非终止）
 * - `cleared` 已清除
 */
export type GoalStatus =
  "active" | "paused" | "completed" | "unmet" | "budget-limited" | "cleared";

/** 六态清单（固定顺序；状态机转换表、持久化读侧校验与界面枚举共用） */
export const GOAL_STATUSES: readonly GoalStatus[] = [
  "active",
  "paused",
  "completed",
  "unmet",
  "budget-limited",
  "cleared",
];

/** 六态的中文称谓（GLOSSARY「目标」词条口径；错误提示与界面共用单一来源） */
export const GOAL_STATUS_NAMES: Record<GoalStatus, string> = {
  active: "进行中",
  paused: "已暂停",
  completed: "已完成",
  unmet: "未达成",
  "budget-limited": "预算受限",
  cleared: "已清除",
};

/**
 * 目标记录（goals 表一行，GLOSSARY「目标」）：任务级实体，一任务同时至多
 * 一个未结束的目标；同一任务的历次目标各留一行（最后一条为当前目标）。
 */
export interface GoalRecord {
  id: string;
  taskId: string;
  /** 目标原文：同时充当首条指令与完成判定标准 */
  text: string;
  status: GoalStatus;
  /** 已闭合的进行中段累计时长（ms）；当前未结束的进行中段不计入 */
  activeMs: number;
  /**
   * 当前进行中段的起点（ISO 8601）；非进行中为 null。
   * 累计时长 = activeMs + (now − activeSince)，由呈现层按需求值。
   */
  activeSince: string | null;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 */
  updatedAt: string;
}

/** 目标文本长度上限（字符；超出以「目标文本过长」拒绝） */
export const GOAL_TEXT_MAX_LENGTH = 4000;

/**
 * 完成判定的结论（GLOSSARY「完成判定」，ADR 0035 完成判定契约）：
 * passed 通过与否、reason 理由、nextAction 下一步方向（未通过时充当下轮方向）。
 */
export interface GoalVerdict {
  passed: boolean;
  reason: string;
  nextAction: string;
}

/**
 * 逐轮验证记录（goal_verifications 表一行）：目标模式下每轮判定落一条，
 * 随任务留痕——消息流标记行的数据源，重启后可回看每轮结论与理由。
 */
export interface GoalVerificationRecord {
  id: string;
  taskId: string;
  /** 归属的目标（goals.id）；同一目标内 round 递增 */
  goalId: string;
  /** 第几次迭代（轮次，1 起） */
  round: number;
  passed: boolean;
  /** 判定理由 */
  reason: string;
  /** 下一步方向（未通过时的一句话；通过时为空串） */
  nextAction: string;
  /** ISO 8601 */
  createdAt: string;
}
