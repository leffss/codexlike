import type { ToolDefinition, ToolExecutionContext, ToolResult } from "./types";

/** defineTool 的规格：与 ToolDefinition 同形（execute 可抛错） */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: ToolDefinition["parameters"];
  permission: ToolDefinition["permission"];
  execute(args: unknown, context: ToolExecutionContext): Promise<ToolResult>;
}

/**
 * 定义工具的统一入口：规格里的异常（边界拒绝、参数错误、IO 失败）
 * 一律转为 isError 结果（中文原因），保证 execute 永不抛出——
 * 模型拿到可读原因后可自行纠正重试，任务循环不被打断。
 */
export function defineTool(spec: ToolSpec): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    permission: spec.permission,
    async execute(args, context) {
      try {
        return await spec.execute(args, context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          output: `工具 ${spec.name} 执行失败：${message}`,
          isError: true,
        };
      }
    },
  };
}
