import { UPDATE_PLAN } from "../tools/update-plan";
import type { GoalRecord, GoalVerificationRecord } from "./types";

/**
 * 目标模式的续跑（ADR 0035「续跑循环」，GLOSSARY「目标模式」）：一轮正常回合
 * 结束、完成判定未通过（或判定自身不可用）后，宿主以一段**内部输入**发起
 * 下一轮——这段输入不是用户发言：进模型上下文（user 角色）、随任务落库为
 * goal-continuation 角色，但消息流不产生用户气泡。
 *
 * 续跑指令在这里构造（规格「续跑 prompt 构造」归 agent-core）：判定未过时
 * 下一步方向与判定理由进入指令；判定不可用时如实告知没有结论。宿主编排器
 * 只决定何时发起（见 desktop goal-orchestrator）。
 */

/**
 * 续跑轮的发起依据：
 * - `verification`：上一轮判定的结局（未过 / 不可用）——续跑循环的常态；
 * - `resume`：目标从暂停点恢复（控制面的恢复入口复用同一接缝再入循环）。
 */
export type GoalContinuationBasis =
  | {
      kind: "verification";
      verification: Pick<
        GoalVerificationRecord,
        "outcome" | "reason" | "nextAction"
      >;
    }
  | { kind: "resume" };

/**
 * 「实质工具活动」的判据（空转计数只对「判定未过且无实质工具活动」的轮次
 * 累加，规格「护栏」）：一轮之内除 `update_plan` 外出现过任何工具调用即算
 * 有活动——只改计划不算，避免「每轮只动计划」被判为有进展而永不阻断。
 * 宿主按本轮的工具调用事件逐条套用本函数。
 * 注意：被用户拒绝或参数无效的调用同样发过工具调用事件，按本定义计入活动
 * （是否收紧到「实际执行成功」由票 05 的阻断逻辑决定）。
 */
export function isGoalToolActivity(toolName: string): boolean {
  return toolName !== UPDATE_PLAN;
}

/** 续跑指令首部：声明这是内部指令而非用户发言，并复述目标原文（长跑中不跑偏） */
function preamble(goalText: string): string[] {
  return [
    "【目标续跑】这是目标模式的内部续跑指令，不是用户发言。请直接继续推进下述目标，不要复述这段指令，也不必对它作出说明。",
    "",
    `【目标】${goalText}`,
  ];
}

/** 续跑指令尾部：说明循环机制，模型不必自行宣告完成 */
const CLOSING = [
  "",
  "每轮工作结束后会自动重新进行完成判定，目标达成后循环自然结束。请持续实际推进，直到手头可做的工作做完。",
];

/**
 * 构造一轮续跑的内部输入（GLOSSARY「完成判定」：未通过则下一步方向并入
 * 下一轮续跑指令）。
 * - 判定未过：带判定理由与下一步方向（判定模型没给方向时省略该行）；
 * - 判定不可用：如实告知上一轮完成判定没有跑成、没有结论——既不代表
 *   目标已达成，也不代表未达成，请从当前进度继续推进；
 * - 恢复：从暂停点继续。
 */
export function buildGoalContinuationInput(
  goal: Pick<GoalRecord, "text">,
  basis: GoalContinuationBasis
): string {
  let body: string[];
  if (basis.kind === "resume") {
    body = [
      "",
      "目标此前被暂停，现已恢复。请从暂停点继续推进：手头未完成的工作先收尾，再按目标文本接着做。",
    ];
  } else if (basis.verification.outcome === "unavailable") {
    body = [
      "",
      "【上一轮完成判定】完成判定不可用：判定没有跑成，本轮没有判定结论。这不代表目标已经达成，也不代表目标未达成。",
      `【原因】${basis.verification.reason}`,
      "请从当前进度继续推进目标。",
    ];
  } else {
    const { reason, nextAction } = basis.verification;
    body = [
      "",
      "【上一轮完成判定】目标尚未完成。",
      ...(reason === "" ? [] : [`【判定理由】${reason}`]),
      ...(nextAction === ""
        ? []
        : [`【下一步方向】${nextAction}`, "请按下一步方向继续工作。"]),
    ];
  }
  return [...preamble(goal.text), ...body, ...CLOSING].join("\n");
}
