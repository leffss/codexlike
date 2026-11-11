import { jsonSchema, tool as aiTool, type Tool } from 'ai';

import type { ToolDefinition, ToolExecutionContext, ToolResult } from './types';

/** 工具定义 → ai SDK 的 tools 参数（不带 execute：执行由会话循环掌控，事件与落库都在循环内发生） */
export function toModelTools(tools: ToolDefinition[]): Record<string, Tool> {
  const entries = tools.map((definition) => [
    definition.name,
    aiTool({
      description: definition.description,
      inputSchema: jsonSchema(definition.parameters),
    }),
  ]);
  return Object.fromEntries(entries);
}

/**
 * 工具注册表（GLOSSARY）：内置工具与 MCP 工具统一注册、统一调度的接口。
 * 纯逻辑无 Node 依赖；工具实例由宿主（或测试）注入。
 */
export interface ToolRegistry {
  /** 注册工具；同名重复注册抛错（注册表是稳定契约） */
  register(tool: ToolDefinition): void;
  get(name: string): ToolDefinition | undefined;
  /** 全部工具（注册顺序） */
  list(): ToolDefinition[];
}

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();
  return {
    register(tool) {
      if (tools.has(tool.name)) {
        throw new Error(`工具 ${tool.name} 已注册，不可重复注册`);
      }
      tools.set(tool.name, tool);
    },
    get(name) {
      return tools.get(name);
    },
    list() {
      return [...tools.values()];
    },
  };
}

/** 包装执行器：定义层异常统一转为 isError 结果（中文原因），模型可据此重试 */
export async function runTool(
  tool: ToolDefinition,
  args: unknown,
  context: ToolExecutionContext,
): Promise<ToolResult> {
  try {
    return await tool.execute(args, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { output: `工具 ${tool.name} 执行失败：${message}`, isError: true };
  }
}
