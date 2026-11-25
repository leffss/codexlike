import {
  GOAL_MAX_VERIFICATION_FAILURES,
  GOAL_STATUS_NAMES,
  canTransitionGoal,
  isGoalEditable,
  type GoalRecord,
  type GoalVerificationRecord,
} from "@codexlike/agent-core";

/**
 * 目标模式呈现层纯函数（ADR 0035，GLOSSARY「目标」「完成判定」）：
 * 累计时长的求值与文案、进度行摘要与状态、判定标记行文案。
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

/**
 * 进度行状态：六态称谓；进行中的目标在完成判定在途时显示副状态「验证中」
 * （ADR 0035「进行中（验证中为进度行副状态）」）。「验证中」只属于进行中。
 */
export function goalStatusText(goal: GoalRecord, verifying: boolean): string {
  if (goal.status === "active" && verifying) return "验证中";
  return GOAL_STATUS_NAMES[goal.status];
}

/** 进度行控制面四个操作的可用性（票 04，ADR 0035「控制面」） */
export interface GoalControls {
  /** 暂停：与停止按钮同一语义（Stop = 暂停） */
  pause: boolean;
  /** 恢复：从暂停点续跑 */
  resume: boolean;
  /** 编辑：修改目标文本 */
  edit: boolean;
  /** 清除：目标转「已清除」，任务回到普通对话 */
  clear: boolean;
}

/**
 * 控制面按钮组的六态可用性矩阵（ADR 0035「状态机六态」）：直接取自状态机的
 * 转换表与可编辑状态，界面不另存一份——能暂停 ⟺ 进行中；能恢复 ⟺ 已暂停 /
 * 预算受限 / 未达成；能清除 ⟺ 未清除的任一状态；能编辑 ⟺ 三种可恢复态
 * （进行中需先暂停，已完成是定稿的历史）。已清除没有任何可用的操作。
 */
export function goalControls(goal: Pick<GoalRecord, "status">): GoalControls {
  return {
    pause: canTransitionGoal(goal.status, "pause"),
    resume: canTransitionGoal(goal.status, "resume"),
    edit: isGoalEditable(goal.status),
    clear: canTransitionGoal(goal.status, "clear"),
  };
}

/**
 * 进度行的停留原因说明：目标不在进行中、且停留有可说明的原因时写明。
 * - 已暂停：因「完成判定连续不可用」被暂停时写明（票 03 编排者裁决：原因对
 *   用户可见，复用既有「已暂停」态，不新设用户态）；手动暂停 / 出错暂停没有
 *   对应的持久化原因，不显示；
 * - 未达成：连续空转阻断（票 05 护栏）——连续 GOAL_MAX_IDLE_ROUNDS 轮判定
 *   未过且无实质工具活动；
 * - 预算受限：token 预算阻断（票 05 护栏）——具体用量与预算由预算控件呈现。
 * 进行中与终态（已完成 / 已清除）没有停留原因，返回 null。
 */
export function goalPauseReason(goal: GoalRecord): string | null {
  if (goal.status === "unmet")
    return `连续 ${goal.idleStreak} 轮判定未过且无实质工具活动`;
  if (goal.status === "budget-limited") return "目标用量已达到 token 预算";
  if (goal.status !== "paused") return null;
  if (goal.failureStreak < GOAL_MAX_VERIFICATION_FAILURES) return null;
  return `完成判定连续 ${goal.failureStreak} 次不可用`;
}

/** 判定在途的标记行占位文案：「第 N 次迭代 · 验证中」 */
export function goalVerifyingText(round: number): string {
  return `第 ${round} 次迭代 · 验证中`;
}

/**
 * token 数量文案（进度行的用量 / 预算）：千分位分组。与地区设置无关的稳定
 * 格式（1,234,567），不随系统语言变化。
 */
export function formatGoalTokens(tokens: number): string {
  return String(Math.trunc(tokens)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * 预算输入解析（进度行上的预算设置，ADR 0035「护栏」）：输入框文本 → token 数。
 * 接受正整数（数字输入框的值，允许首尾空白）；空输入、零与负数、小数、科学
 * 计数、非数字一律无效（返回 null，由调用方提示）。合法性与宿主同源——正整数。
 */
export function parseGoalBudgetInput(text: string): number | null {
  const normalized = text.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const value = Number(normalized);
  return value > 0 && Number.isSafeInteger(value) ? value : null;
}

/**
 * 判定标记行文案（GLOSSARY「完成判定」）：「第 N 次迭代 · 已完成 / 未完成 /
 * 判定不可用」。判定不可用是判定自身故障、没有结论——如实呈现，不写成
 * 判定给出的「未完成」。
 */
export function goalVerificationText(
  verification: Pick<GoalVerificationRecord, "round" | "outcome">
): string {
  const conclusion =
    verification.outcome === "passed"
      ? "已完成"
      : verification.outcome === "unpassed"
        ? "未完成"
        : "判定不可用";
  return `第 ${verification.round} 次迭代 · ${conclusion}`;
}

/**
 * 未完成时的下一步方向一句摘要（规格故事 10）：「下一步：…」。
 * 判定没有给出方向、或结论不是未完成（通过 / 判定不可用）时没有摘要。
 */
export function goalNextStepText(
  verification: Pick<GoalVerificationRecord, "outcome" | "nextAction">
): string | null {
  if (verification.outcome !== "unpassed" || verification.nextAction === "")
    return null;
  return `下一步：${verification.nextAction}`;
}
