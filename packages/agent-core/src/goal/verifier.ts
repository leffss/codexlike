import {
  generateText,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
} from "ai";

import { composeStoredMessageContent } from "../context/stored-message";
import type { ToolCallRecord } from "../tools/types";
import { describeModelError, isAbortLike } from "../task/errors";
import type { StoredMessage } from "../task/types";
import {
  GOAL_UNAVAILABLE_REASON_PREFIX,
  type GoalRecord,
  type GoalVerdict,
  type GoalVerificationRecord,
} from "./types";

/**
 * 完成判定（GLOSSARY「完成判定」，ADR 0035 完成判定契约）：
 * 一次独立模型请求——任务当前模型、不带工具，输入 = 目标文本 + 完整消息
 * 历史，输出 {passed, reason, nextAction}。解析容忍代码围栏等包裹；判定
 * 自身故障 fail-open（见 unavailableGoalVerdict），不设独立用户态。
 */

/**
 * 判定 system prompt 的机器可识别锚（置于首部）：e2e stub provider 据此
 * 把判定请求与工作轮请求分线（goal-stub.mjs 的默认识别特征，票 01 契约）。
 */
export const GOAL_VERIFICATION_MARKER = "[goal-verification]";

/** 单条工具结果送入判定的长度上限（字符）：证据够用即可，不为超长输出付 token */
export const GOAL_TOOL_OUTPUT_MAX_CHARS = 4000;

/** 判定指令：引导「对话型非任务目标直接 pass」「证据不足不通过」 */
export const GOAL_VERIFICATION_SYSTEM_PROMPT = [
  `${GOAL_VERIFICATION_MARKER} 你是任务的完成判定评估器。用户为下述任务设定了一个目标，agent 已经进行了若干轮工作。`,
  "请依据目标文本与完整消息历史，判断目标现在是否已经达成。",
  "",
  "判定规则：",
  "- 以目标文本为完成标准（其中的期望结果、约束与验证方式），对照消息历史中真实发生的操作与结果判断。",
  "- 只依据历史中已经发生的事实，不臆测未发生的工作；证据不足以证明目标已达成时，判定为未通过。",
  "- 对话型、咨询型目标（不需要执行任务，回答已经给出）直接判定通过。",
  "- 目标已达成：passed 为 true，nextAction 为空字符串。",
  "- 目标未达成：passed 为 false，nextAction 用一句话写明下一步应该做什么。",
  "",
  "只输出一个 JSON 对象，不要输出任何其他文字，也不要用代码围栏包裹：",
  '{"passed": true 或 false, "reason": "判定理由", "nextAction": "下一步方向或空字符串"}',
].join("\n");

/** 完成判定的输入：目标文本 + 任务开始以来的全部消息与工具调用记录 */
export function buildGoalVerificationPrompt(
  goal: Pick<GoalRecord, "text">,
  history: { messages: StoredMessage[]; toolCalls: ToolCallRecord[] }
): { system: string; prompt: ModelMessage[] } {
  // 按发生时刻合并消息与工具调用（同刻消息在前）：与任务时间线同序
  const timeline: { at: string; line: string }[] = [
    ...history.messages
      // error 提示是对用户的故障说明，不是对话事实（与模型上下文同口径不进判定）
      .filter((message) => message.role !== "error")
      .map((message) => ({
        at: message.createdAt,
        line: `[${message.role}]\n${composeStoredMessageContent(message)}`,
      })),
    ...history.toolCalls.map((call) => ({
      at: call.createdAt,
      line: [
        `[tool] ${call.toolName}${call.isError ? "（执行失败）" : ""}`,
        `参数：${call.arguments}`,
        `结果：${truncateToolOutput(call.output)}`,
      ].join("\n"),
    })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return {
    system: GOAL_VERIFICATION_SYSTEM_PROMPT,
    prompt: [
      {
        role: "user",
        content: [
          "【目标】",
          goal.text,
          "",
          "【完整消息历史】（自任务开始，按时间顺序）",
          ...timeline.map((item) => item.line),
        ].join("\n\n"),
      },
    ],
  };
}

function truncateToolOutput(output: string): string {
  if (output.length <= GOAL_TOOL_OUTPUT_MAX_CHARS) return output;
  return `${output.slice(0, GOAL_TOOL_OUTPUT_MAX_CHARS)}…（已截断，共 ${output.length} 字符）`;
}

/** 把已解析的值收窄为判定结论；passed 不是布尔即为无效结论 */
function toVerdict(value: unknown): GoalVerdict | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.passed !== "boolean") return null;
  return {
    passed: record.passed,
    reason: typeof record.reason === "string" ? record.reason : "",
    nextAction: typeof record.nextAction === "string" ? record.nextAction : "",
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 字符串字面量包裹（整体再套一层 JSON 字符串的双重编码）：再解一层 */
function unwrapString(value: unknown): unknown {
  return typeof value === "string" ? parseJson(value) : value;
}

/** 取出文本中首个配平的 JSON 对象原文（跳过字符串内部的括号）；不存在返回 null */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * 解析判定输出的 {passed, reason, nextAction}（JSON 容错）：裸 JSON、代码
 * 围栏包裹、字符串字面量包裹、结论前后夹带说明文字均可得到结论。
 * 返回 null 表示无法得到有效结论（坏输出），由调用方按 fail-open 处理。
 */
export function parseGoalVerdict(text: string): GoalVerdict | null {
  let candidate = text.trim();
  // 代码围栏包裹（```json … ```）：剥掉首尾围栏行
  const fenced = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```\s*$/.exec(candidate);
  if (fenced !== null) candidate = fenced[1]!.trim();
  const whole = unwrapString(parseJson(candidate));
  const verdict = toVerdict(whole);
  if (verdict !== null) return verdict;
  // 结论前后夹带说明文字：整体不是合法 JSON，取出其中首个 JSON 对象
  const embedded = firstJsonObject(candidate);
  return embedded === null
    ? null
    : toVerdict(unwrapString(parseJson(embedded)));
}

/**
 * 判定自身故障的验证记录（ADR 0035「判定自身故障 fail-open，不设独立用户
 * 态」；票 03 编排者裁决）：请求失败 / 坏输出 / 模型不可用时没有结论——记录
 * 如实注明不可用及原因，outcome 为 unavailable，不编造判定理由与下一步方向。
 * passed 为 false 只为兼容：故障既不是通过，也不代表目标未达成。
 */
export function unavailableGoalVerdict(cause: string): GoalVerdict & {
  passed: false;
  nextAction: "";
} {
  return {
    passed: false,
    reason: `${GOAL_UNAVAILABLE_REASON_PREFIX}（${cause}），本轮没有判定结论`,
    nextAction: "",
  };
}

/**
 * 判定请求的结局：拿到有效结论，或判定自身故障（调用方记为 unavailable，
 * 目标照常续跑——ADR 0035 fail-open）。
 */
export type GoalVerdictResult =
  | { kind: "verdict"; verdict: GoalVerdict }
  | { kind: "unavailable"; cause: string };

/**
 * 发起一次完成判定请求（不落库、不改目标状态）。
 * outcome 为 null 表示请求被中断（signal 已 abort：Stop / 应用退出），不产生
 * 结论；请求失败与坏输出不抛出，以 unavailable 交调用方按 fail-open 记账。
 * usage 原样带回供调用方入任务用量账（ADR 0029）。
 */
export async function requestGoalVerdict(deps: {
  languageModel: LanguageModel;
  system: string;
  prompt: ModelMessage[];
  signal?: AbortSignal;
  /** 模型请求重试次数（GLOSSARY「执行设置」，与 compact 辅助调用同口径） */
  maxRetries: number;
}): Promise<{
  outcome: GoalVerdictResult | null;
  usage: LanguageModelUsage | undefined;
}> {
  try {
    // 判定是辅助调用：不附加档位控制参数（服务端默认行为），且不带任何工具
    const result = await generateText({
      model: deps.languageModel,
      system: deps.system,
      prompt: deps.prompt,
      abortSignal: deps.signal,
      maxRetries: deps.maxRetries,
    });
    const verdict = parseGoalVerdict(result.text);
    return {
      outcome:
        verdict === null
          ? { kind: "unavailable", cause: "模型输出不是有效的判定结论" }
          : { kind: "verdict", verdict },
      usage: result.usage,
    };
  } catch (error) {
    if (isAbortLike(error, deps.signal))
      return { outcome: null, usage: undefined };
    return {
      outcome: {
        kind: "unavailable",
        cause: describeModelError(error, deps.maxRetries),
      },
      usage: undefined,
    };
  }
}

/** TaskManager.verifyGoal 的返回 */
export type GoalVerificationResult =
  | { kind: "verified"; verification: GoalVerificationRecord }
  /** 判定被中断（Stop / 应用退出）：无结论、无验证记录 */
  | { kind: "aborted" }
  /** 目标已不在进行中（如等待期间被暂停）：未发起判定 */
  | { kind: "skipped" };
