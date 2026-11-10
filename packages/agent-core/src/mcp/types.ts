import type { ToolParametersSchema } from '../tools/types';

/** stdio MCP server 的用户配置（设置页「MCP servers」区维护） */
export interface McpServerConfig {
  id: string;
  /** 展示名；同时决定工具前缀（归一化为 mcp_<name>_<tool>） */
  name: string;
  /** 启动命令（可执行文件路径或名称） */
  command: string;
  /** 命令行参数 */
  args: string[];
  /** 附加环境变量（在基础白名单之上合并） */
  env: Record<string, string>;
}

/** server 连接生命周期状态（设置页状态徽标） */
export type McpServerStatus =
  | 'connecting'
  | 'connected'
  | 'failed'
  | 'disconnected';

/** 连接后发现的一个 MCP 工具（尚未适配为 ToolDefinition 的原始形状） */
export interface McpDiscoveredTool {
  serverId: string;
  /** 归一化后的 server 名（工具前缀成分） */
  serverName: string;
  /** server 端原始工具名 */
  originalName: string;
  /** 适配后的工具全名：mcp_<server>_<tool>（防止与内置工具及其它 server 撞名） */
  name: string;
  description: string;
  parameters: ToolParametersSchema;
}

/** 一个 server 的连接状态快照（IPC 返回给设置页） */
export interface McpServerState {
  serverId: string;
  status: McpServerStatus;
  /** 发现到的全部工具（含被禁用的；启停状态由宿主层叠加） */
  tools: McpDiscoveredTool[];
  /** failed / disconnected 时的中文原因；正常为 null */
  error: string | null;
}
