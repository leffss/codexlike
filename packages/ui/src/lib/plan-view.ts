/**
 * 工作计划的渲染派生层（GLOSSARY「工作计划」「计划项」，ADR 0016）。
 *
 * 数据通道是派生式：update_plan 是普通工具，状态即工具调用记录（随
 * transcript 落库，任务恢复时随段序列重建）；本模块从消息段序列解析出
 * 每次调用的计划快照，「当前计划」= 最后一次 update_plan 的参数。
 * 不新增事件类型/段类型/存储表。
 */
import type {
  MessageSegment,
  SubagentToolCall,
  ToolCallSegment,
} from "./task-view";

/** 工作计划工具名（与 agent-core UPDATE_PLAN 契约一致） */
export const PLAN_TOOL_NAME = "update_plan";

export type PlanStepStatus = "pending" | "in_progress" | "completed";

/** 计划项（GLOSSARY「计划项」）：内容 + 三态，id 为渲染 key（解析时补全） */
export interface PlanStep {
  id: string;
  content: string;
  status: PlanStepStatus;
}

/** 一次 update_plan 调用的完整快照（全量替换语义） */
export interface PlanSnapshot {
  segmentId: string;
  steps: PlanStep[];
}

export function isPlanSegment(
  segment: MessageSegment
): segment is ToolCallSegment {
  return segment.kind === "tool-call" && segment.toolName === PLAN_TOOL_NAME;
}

/**
 * 从工具调用参数解析计划项。宽容解析（对齐 agent-core 校验前的历史数据
 * 与边界情况）：非法 JSON / 非数组 / 空清单返回 []；缺失 status 按 pending
 * 兜底；id 缺失时按内容 + 序号补全（同一快照内稳定，供 React key）。
 */
export function parsePlanSteps(argsJson: string): PlanStep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const steps = (parsed as { steps?: unknown }).steps;
  if (!Array.isArray(steps) || steps.length === 0) return [];
  return steps.flatMap((item, index): PlanStep[] => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content : "";
    if (!content.trim()) return [];
    const status =
      record.status === "pending" ||
      record.status === "in_progress" ||
      record.status === "completed"
        ? record.status
        : "pending";
    return [
      {
        id: `${index}-${content}`,
        content,
        status,
      },
    ];
  });
}

/** 按段序收集全部计划快照（历史演变，旧→新） */
export function collectPlanSnapshots(items: MessageSegment[]): PlanSnapshot[] {
  return items.filter(isPlanSegment).map((segment) => ({
    segmentId: segment.id,
    steps: parsePlanSteps(segment.arguments),
  }));
}

/**
 * 子代理侧收集薄壳（ADR 0023）：子代理工具调用嵌在 SubagentSegment.tools
 * （无 kind 判别字段，isPlanSegment 不适用），按 toolName 过滤 update_plan；
 * 解析复用 parsePlanSteps，「当前计划」= 最后一次快照（全量替换语义）。
 */
export function collectSubagentPlanSnapshots(
  tools: SubagentToolCall[]
): PlanSnapshot[] {
  return tools
    .filter((tool) => tool.toolName === PLAN_TOOL_NAME)
    .map((tool) => ({
      segmentId: tool.id,
      steps: parsePlanSteps(tool.arguments),
    }));
}

/** 当前计划：最后一次 update_plan 的快照（全量替换语义下即最新状态） */
export function currentPlan(items: MessageSegment[]): PlanSnapshot | null {
  const snapshots = collectPlanSnapshots(items);
  return snapshots.at(-1) ?? null;
}

export function completedCount(steps: PlanStep[]): number {
  return steps.filter((step) => step.status === "completed").length;
}

/** 计划项三态的呈现用语（导出行前缀与统计行同源：已完成 / 进行中 / 待办） */
export const STEP_STATUS_LABELS: Record<PlanStepStatus, string> = {
  completed: "已完成",
  in_progress: "进行中",
  pending: "待办",
};

/**
 * 三态计数（票 03 收口的单一来源）：接受原始 steps 数组（宽容口径）或
 * 已解析的 PlanStep[]——非对象项 / 非法 status 项不计入任何桶，
 * N = 三态之和（与 agent-core update_plan 执行输出的防御口径一致）。
 */
export function planStatusCounts(
  steps: readonly unknown[]
): Record<PlanStepStatus, number> {
  const counts: Record<PlanStepStatus, number> = {
    completed: 0,
    in_progress: 0,
    pending: 0,
  };
  for (const step of steps) {
    if (typeof step !== "object" || step === null) continue;
    const status = (step as Record<string, unknown>)["status"];
    if (
      status === "completed" ||
      status === "in_progress" ||
      status === "pending"
    ) {
      counts[status] += 1;
    }
  }
  return counts;
}

/**
 * 计划统计行（票 03 收口的单一来源，与 agent-core 工具执行输出同口径）：
 * 「共 N 项：X 已完成、Y 进行中、Z 待办」。N = 三态之和——原始数组含
 * 非法 status 项时不随 steps.length 虚高；合法清单下 N === steps.length，
 * 文案与收口前两处手写格式串逐字符一致。
 */
export function planSummaryLine(steps: readonly unknown[]): string {
  const counts = planStatusCounts(steps);
  const total = counts.completed + counts.in_progress + counts.pending;
  return `共 ${total} 项：${counts.completed} 已完成、${counts.in_progress} 进行中、${counts.pending} 待办`;
}

/** 当前活动步骤：in_progress 优先，其次第一个未完成，兜底末项 */
export function activeStep(steps: PlanStep[]): PlanStep | undefined {
  return (
    steps.find((step) => step.status === "in_progress") ??
    steps.find((step) => step.status !== "completed") ??
    steps.at(-1)
  );
}
