import { describe, expect, it } from "vitest";

import type { ToolExecutionContext } from "../../src/tools/types";
import {
  createUpdatePlanTool,
  parsePlanSteps,
  type PlanStepInput,
} from "../../src/tools/update-plan";

const context: ToolExecutionContext = {
  workspacePath: "C:/ws",
  taskId: "update-plan-test",
  approvalMode: "assist",
};

/** 参数构造器：非法输入用例以 unknown 项传入（parsePlanSteps 入参即 unknown） */
function steps(items: PlanStepInput[] | unknown[]) {
  return { steps: items };
}

const sample: PlanStepInput[] = [
  { content: "调研现有布局代码", status: "in_progress" },
  { content: "梳理分区清单", status: "pending" },
  { content: "输出方案", status: "pending" },
];

describe("parsePlanSteps（工作计划参数校验）", () => {
  it("正常路径：按序解析 content 与三态 status", () => {
    expect(parsePlanSteps(steps(sample))).toEqual(sample);
  });

  it("参数必须是对象且只含 steps 字段", () => {
    expect(() => parsePlanSteps(null)).toThrow("必须是对象");
    expect(() => parsePlanSteps("[]")).toThrow("必须是对象");
    expect(() => parsePlanSteps({ steps: [], extra: 1 })).toThrow(
      "包含未知字段"
    );
  });

  it("计划项 1–50 项：空清单与超限拒绝", () => {
    expect(() => parsePlanSteps(steps([]))).toThrow("计划项必须包含 1–50 项");
    const tooMany = Array.from({ length: 51 }, () => ({
      content: "步骤",
      status: "pending" as const,
    }));
    expect(() => parsePlanSteps(steps(tooMany))).toThrow(
      "计划项必须包含 1–50 项"
    );
  });

  it("计划项只允许 content/status 字段，content 非空且最多 200 字符", () => {
    expect(() =>
      parsePlanSteps(steps([{ content: "a", status: "pending", id: "x" }]))
    ).toThrow("包含未知字段");
    expect(() =>
      parsePlanSteps(steps([{ content: "  ", status: "pending" }]))
    ).toThrow("计划项内容必须是非空字符串");
    expect(() =>
      parsePlanSteps(steps([{ content: "长".repeat(201), status: "pending" }]))
    ).toThrow("计划项内容最多 200 个字符");
  });

  it("status 必须是三态枚举之一", () => {
    expect(() =>
      parsePlanSteps(steps([{ content: "a", status: "done" }]))
    ).toThrow("计划项状态必须是 pending / in_progress / completed 之一");
  });
});

describe("update_plan 工具（ADR 0016）", () => {
  const tool = createUpdatePlanTool();

  it("契约：名称/权限/schema 与全量替换语义的描述", () => {
    expect(tool.name).toBe("update_plan");
    expect(tool.permission).toBe("readonly");
    expect(tool.description).toContain("整体替换");
    expect(tool.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["steps"],
    });
  });

  it("执行成功：输出中文统计摘要", async () => {
    const result = await tool.execute(
      steps([
        { content: "一", status: "completed" },
        { content: "二", status: "in_progress" },
        { content: "三", status: "pending" },
      ]),
      context
    );
    expect(result.isError).toBe(false);
    expect(result.output).toBe(
      "工作计划已更新（共 3 项：1 已完成、1 进行中、1 待办）"
    );
  });

  it("执行失败：非法参数经 defineTool 转为中文 isError 结果，不抛出", async () => {
    const result = await tool.execute(steps([]), context);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("工具 update_plan 执行失败");
    expect(result.output).toContain("计划项必须包含 1–50 项");
  });
});
