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
