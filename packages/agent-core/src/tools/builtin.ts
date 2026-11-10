import { createApplyPatchTool } from './apply-patch';
import { createGlobTool } from './glob';
import { createGrepTool } from './grep';
import { createReadFileTool } from './read-file';
import { createTerminalTool, type TerminalShell } from './terminal';
import type { ToolDefinition } from './types';
import { createWriteFileTool } from './write-file';

export interface BuiltinToolsOptions {
  /** 宿主环境变量（终端工具按白名单过滤后透传） */
  env?: Record<string, string | undefined>;
  /** 终端 shell 偏好（默认 git-bash；设置页在后续工单接入） */
  shell?: TerminalShell;
  /** 显式 bash.exe 路径 */
  gitBashPath?: string;
}

/**
 * 六件内置工具（spec「工具注册表与内置工具」；web_search/浏览器/MCP 在工单 10-12 加入）。
 * 工具本身无状态：工作区路径经 ToolExecutionContext 逐会话注入，
 * 因此同一组工具实例可被多个会话共享。
 */
export function createBuiltinTools(options: BuiltinToolsOptions = {}): ToolDefinition[] {
  return [
    createReadFileTool(),
    createWriteFileTool(),
    createApplyPatchTool(),
    createGlobTool(),
    createGrepTool(),
    createTerminalTool({
      env: options.env,
      shell: options.shell,
      gitBashPath: options.gitBashPath,
    }),
  ];
}
