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
