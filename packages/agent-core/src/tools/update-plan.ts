import { defineTool } from "./define-tool";
import type { ToolDefinition } from "./types";

export const UPDATE_PLAN = "update_plan";

/** 计划项状态：待办 / 进行中 / 已完成（GLOSSARY「计划项」） */
export type PlanStepStatus = "pending" | "in_progress" | "completed";

/** 模型侧计划项形状（工具参数）：内容 + 状态，按执行顺序排列 */
export interface PlanStepInput {
  content: string;
  status: PlanStepStatus;
}

/** 字符数上限（按 JS 字符串长度）：计划项内容 200；清单项数 1–50。 */
const limits = {
  content: 200,
  steps: 50,
};

const STEP_STATUSES: readonly PlanStepStatus[] = [
  "pending",
  "in_progress",
  "completed",
];

function object(value: unknown, keys: string[], label: string) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label}必须是对象`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key)))
    throw new Error(`${label}包含未知字段`);
  return result;
}

function array(value: unknown, min: number, max: number, label: string) {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    throw new Error(`${label}必须包含 ${min}–${max} 项`);
  return value;
}

/**
 * 解析并校验 update_plan 参数（中文报错，与 parseQuestions 同构）。
 * 宽松字段（如旧数据的 priority）在 schema 层已被 additionalProperties:false 拒绝。
 */
export function parsePlanSteps(input: unknown): PlanStepInput[] {
  const args = object(input, ["steps"], "工作计划参数");
  return array(args.steps, 1, limits.steps, "计划项").map((value) => {
    const step = object(value, ["content", "status"], "计划项");
    if (typeof step.content !== "string" || !step.content.trim())
      throw new Error("计划项内容必须是非空字符串");
    if (step.content.length > limits.content)
      throw new Error(`计划项内容最多 ${limits.content} 个字符`);
    if (!STEP_STATUSES.includes(step.status as PlanStepStatus))
      throw new Error(`计划项状态必须是 ${STEP_STATUSES.join(" / ")} 之一`);
    return {
      content: step.content,
      status: step.status as PlanStepStatus,
    };
  });
}

/**
 * 工作计划工具（GLOSSARY「工作计划」，ADR 0016）：建立/更新任务的多步工作
 * 计划，清单同时呈现给用户（消息流顶部常驻计划条 + 流内标记行）。
 * 全量替换语义——每次发送完整清单；状态即工具调用记录本身（随 transcript
 * 落库持久化），UI 从消息段序列派生当前计划，无需额外存储。
 */
export function createUpdatePlanTool(): ToolDefinition {
  return defineTool({
    name: UPDATE_PLAN,
    description: `建立或更新当前任务的工作计划（多步骤清单，呈现给用户跟踪进度）。每次调用发送完整清单，整体替换上一次；按执行顺序排列，一次只保持一项 in_progress，完成后立即标记 completed。计划项 1–${limits.steps} 项，内容最多 ${limits.content} 个字符；status 为 pending / in_progress / completed。`,
    permission: "readonly",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["steps"],
      properties: {
        steps: {
          type: "array",
          minItems: 1,
          maxItems: limits.steps,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["content", "status"],
            properties: {
              content: {
                type: "string",
                minLength: 1,
                maxLength: limits.content,
              },
              status: { type: "string", enum: [...STEP_STATUSES] },
            },
          },
        },
      },
    },
    async execute(args) {
      const steps = parsePlanSteps(args);
      const completed = steps.filter(
        (step) => step.status === "completed"
      ).length;
      const inProgress = steps.filter(
        (step) => step.status === "in_progress"
      ).length;
      const pending = steps.filter((step) => step.status === "pending").length;
      return {
        output: `工作计划已更新（共 ${steps.length} 项：${completed} 已完成、${inProgress} 进行中、${pending} 待办）`,
        isError: false,
      };
    },
  });
}
