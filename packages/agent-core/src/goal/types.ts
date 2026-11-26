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
 * - `unmet` 未达成（连续 3 空转轮阻断，阈值 GOAL_MAX_IDLE_ROUNDS）
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
  /**
   * 空转计数（票 03 记账，票 05 据此阻断）：本段进行中内连续「判定未过且无
   * 实质工具活动」的轮数。出现通过、或出现带实质工具活动的未过轮即清零；
   * 判定自身故障的轮次不计（保持原值）；暂停后恢复从 0 起算（状态机给出）。
   */
  idleStreak: number;
  /**
   * 连续故障计数：本段进行中内连续「完成判定自身不可用」的轮数。出现一次
   * 正常结论（通过或未过）即清零；暂停后恢复从 0 起算。宿主在计数达到
   * GOAL_MAX_VERIFICATION_FAILURES 时把目标转为已暂停。
   */
  failureStreak: number;
  /**
   * token 预算（票 05 护栏，规格故事 13）：目标级参数，不进执行设置。
   * 目标设定以来的任务用量增量达到该值即转「预算受限」（非终止，加预算后
   * 可恢复）。null = 未设预算（不限，默认）。
   */
  budgetTokens: number | null;
  /**
   * 对账基线：目标设定时刻的任务用量账目（GLOSSARY「任务用量」四列之和）。
   * 目标消耗 = 当前账目 − 基线——任务此前的用量不计入，同一任务先后有多个
   * 目标时各算各的；恢复（暂停 / 预算受限 / 未达成 → 进行中）不重置基线。
   */
  baselineTokens: number;
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
 * 判定结论的种类（票 03，编排者裁决「fail-open 定案」）：验证记录必须能
 * 区分「判定正常给出未通过」与「判定自身故障」——前者的下一步方向是模型的
 * 判断，后者只是没有拿到结论，宿主的处置与界面的呈现都不同。
 * - `passed`：判定通过
 * - `unpassed`：判定正常给出未通过（reason / nextAction 是判定模型给出的）
 * - `unavailable`：判定自身故障（请求失败 / 坏输出 / 任务当前模型不可用），
 *   没有结论；passed 为 false 只为兼容，不代表目标未达成
 */
export type GoalVerificationOutcome = "passed" | "unpassed" | "unavailable";

/** 全部结论种类（固定顺序；持久化读侧校验与界面枚举共用） */
export const GOAL_VERIFICATION_OUTCOMES: readonly GoalVerificationOutcome[] = [
  "passed",
  "unpassed",
  "unavailable",
];

/**
 * 判定自身故障（outcome = unavailable）的 reason 固定前缀（ADR 0035
 * fail-open）：verifier 拼故障说明用它开头，持久化读侧回推旧库行结论也用它
 * 匹配——两处知识耦合在同一个短语上，改文案须同步这里（旧库 reason 是历史
 * 文本，值变化会匹配不上，把 unavailable 误判为 unpassed）。
 */
export const GOAL_UNAVAILABLE_REASON_PREFIX = "完成判定不可用";

/**
 * 连续多少轮完成判定不可用后暂停目标（ADR 0035 fail-open「不把目标永久
 * 卡死」：单次故障照常续跑，判定持续不可用才停下等人处理）。
 */
export const GOAL_MAX_VERIFICATION_FAILURES = 3;

/**
 * 连续多少轮「判定未过且无实质工具活动」后把目标转为「未达成」（ADR 0035
 * 「护栏」：空转阻断）。规格定值 3，不做成配置项——阈值的意义是拦住「什么
 * 都没做成却一直烧 token」的循环，对任何目标都一样。
 */
export const GOAL_MAX_IDLE_ROUNDS = 3;

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
  /** 结论是否为通过（兼容字段：unavailable 与 unpassed 同为 false，种类看 outcome） */
  passed: boolean;
  /** 结论种类：通过 / 正常未过 / 判定自身不可用 */
  outcome: GoalVerificationOutcome;
  /** 判定理由（unavailable 时为故障说明） */
  reason: string;
  /** 下一步方向（未通过时的一句话；通过时为空串） */
  nextAction: string;
  /**
   * 本轮工作是否有实质工具活动（宿主按本轮事件统计；定义见
   * isGoalToolActivity）：空转计数只对「未过且无活动」的轮次累加。
   */
  toolActivity: boolean;
  /** ISO 8601 */
  createdAt: string;
}
