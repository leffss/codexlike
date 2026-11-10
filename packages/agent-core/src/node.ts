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
export { resolveInWorkspace } from './tools/workspace';
