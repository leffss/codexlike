import { createApplyPatchTool } from "./apply-patch";
import { createGlobTool } from "./glob";
import { createGrepTool } from "./grep";
import { createReadFileTool } from "./read-file";
import {
  createTerminalTool,
  type TerminalShell,
  type TimeoutOption,
} from "./terminal";
import type { ToolDefinition } from "./types";
import { createWebSearchTool, type WebSearchToolOptions } from "./web-search";
import { createWriteFileTool } from "./write-file";

export interface BuiltinToolsOptions {
  /** 宿主环境变量（终端工具按白名单过滤后透传） */
  env?: Record<string, string | undefined>;
  /** 终端 shell 偏好（静态值或逐次解析函数；默认 git-bash） */
  shell?: TerminalShell | (() => TerminalShell);
  /**
   * 终端命令默认超时（毫秒，执行设置票04）：静态值或逐次解析函数；
   * 宿主注入设置缓存，设置页保存后对下一次命令即时生效。
   */
  defaultTimeoutMs?: TimeoutOption;
  /** 终端命令超时上限（毫秒）；形态与默认超时相同 */
  maxTimeoutMs?: TimeoutOption;
  /** 显式 bash.exe 路径 */
  gitBashPath?: string;
  /**
   * web_search 配置（工单 10）：传入即在工具表中追加 web_search；
   * searchSource 每次调用时解析，设置页改 key 无需重启。
   */
  webSearch?: WebSearchToolOptions;
}

/**
 * 内置工具（spec「工具注册表与内置工具」；浏览器/MCP 在工单 11-12 加入）。
 * 工具本身无状态：工作区路径经 ToolExecutionContext 逐任务注入，
 * 因此同一组工具实例可被多个任务共享。
 */
export function createBuiltinTools(
  options: BuiltinToolsOptions = {}
): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createReadFileTool(),
    createWriteFileTool(),
    createApplyPatchTool(),
    createGlobTool(),
    createGrepTool(),
    createTerminalTool({
      env: options.env,
      shell: options.shell,
      defaultTimeoutMs: options.defaultTimeoutMs,
      maxTimeoutMs: options.maxTimeoutMs,
      gitBashPath: options.gitBashPath,
    }),
  ];
  if (options.webSearch !== undefined) {
    tools.push(createWebSearchTool(options.webSearch));
  }
  return tools;
}
