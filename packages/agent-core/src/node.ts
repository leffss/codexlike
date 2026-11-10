// Node 宿主出口（Electron 主进程 / Node 测试）。
// 相比浏览器安全的主出口（index.ts），这里额外导出依赖 Node 内置 API 的部分：
// 会话对象、会话管理器、SQLite 持久化。
export * from './index';

export type { SessionPersistence } from './session/persistence';
export { createSqliteSessionStore } from './session/persistence';
export type {
  AgentSession,
  CreateAgentSessionOptions,
  SendMessageOptions,
} from './session/agent-session';
export { createAgentSession } from './session/agent-session';
export type {
  CreateSessionManagerOptions,
  SessionManager,
} from './session/manager';
export { createSessionManager } from './session/manager';

// 工具域：注册表与六件内置工具（依赖 node:fs / node:child_process，仅 Node 宿主可用）
export { createToolRegistry, runTool } from './tools/registry';
export type { ToolRegistry } from './tools/registry';
export { createBuiltinTools } from './tools/builtin';
export type { BuiltinToolsOptions } from './tools/builtin';
export { createReadFileTool } from './tools/read-file';
export { createWriteFileTool } from './tools/write-file';
export { createApplyPatchTool } from './tools/apply-patch';
export { createGlobTool } from './tools/glob';
export { createGrepTool } from './tools/grep';
export { createTerminalTool } from './tools/terminal';
export type { TerminalShell, TerminalToolOptions } from './tools/terminal';
// web_search（工单 10）：搜索源接口 + Tavily 默认实现 + 工具定义
export { createTavilySearchSource, createWebSearchTool } from './tools/web-search';
export type {
  SearchOptions,
  SearchSource,
  SearchResult,
  TavilySearchSourceOptions,
  WebSearchToolOptions,
} from './tools/web-search';
export { resolveInWorkspace } from './tools/workspace';
// MCP 客户端（工单 12，stdio）：连接管理 + 工具发现 + ToolDefinition 适配
export {
  createMcpManager,
  MCP_DEFAULT_CALL_TIMEOUT_MS,
  MCP_DEFAULT_CONNECT_TIMEOUT_MS,
} from './mcp/manager';
export type { McpManager, McpManagerOptions } from './mcp/manager';
// AGENTS.md 发现（依赖 node:fs / git 探测，Node 宿主专用）
export {
  AGENTS_MD_MAX_BYTES,
  composeSystemPrompt,
  discoverAgentsInstructions,
} from './context/agents-md';
export type {
  AgentsMdDiscovery,
  AgentsMdSection,
  DiscoverAgentsInstructionsOptions,
} from './context/agents-md';
