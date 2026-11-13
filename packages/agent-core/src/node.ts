// Node 宿主出口（Electron 主进程 / Node 测试）。
// 相比浏览器安全的主出口（index.ts），这里额外导出依赖 Node 内置 API 的部分：
// 任务对象、任务管理器、SQLite 持久化。
// 「会话→任务」改名 expand 阶段（ADR 0014）：同 index.ts，暂留旧名别名供
// desktop 既有 import 编译，票 06（contract 阶段）统一删除。
export * from "./index";

export type {
  TaskPersistence,
  TaskPersistence as SessionPersistence,
} from "./task/persistence";
export {
  createSqliteTaskStore,
  createSqliteTaskStore as createSqliteSessionStore,
} from "./task/persistence";
export type {
  AgentTask,
  AgentTask as AgentSession,
  CreateAgentTaskOptions,
  CreateAgentTaskOptions as CreateAgentSessionOptions,
  SendMessageOptions,
} from "./task/agent-task";
export {
  createAgentTask,
  createAgentTask as createAgentSession,
} from "./task/agent-task";
export type {
  CreateTaskManagerOptions,
  CreateTaskManagerOptions as CreateSessionManagerOptions,
  TaskManager,
  TaskManager as SessionManager,
} from "./task/manager";
export {
  createTaskManager,
  createTaskManager as createSessionManager,
} from "./task/manager";

// 子代理编排（工单 13，GLOSSARY「子代理」）：spawn_subagent 工具由 createAgentTask
// 在 subagents 配置存在时自动追加；此处导出常量与类型供宿主装配与测试
export type {
  SubagentOrchestrator,
  SubagentHostPort,
  SubagentsConfig,
  SubagentRuntimeSettings,
} from "./task/subagent";
export {
  DEFAULT_SUBAGENT_MAX_CONCURRENT,
  SUBAGENT_TOOL_NAME,
} from "./task/subagent";

// 工具域：注册表与六件内置工具（依赖 node:fs / node:child_process，仅 Node 宿主可用）
export { createToolRegistry, runTool } from "./tools/registry";
export type { ToolRegistry } from "./tools/registry";
export { createBuiltinTools } from "./tools/builtin";
export type { BuiltinToolsOptions } from "./tools/builtin";
export { createReadFileTool } from "./tools/read-file";
export { createWriteFileTool } from "./tools/write-file";
export { createApplyPatchTool } from "./tools/apply-patch";
export { createGlobTool } from "./tools/glob";
export { createGrepTool } from "./tools/grep";
export { createTerminalTool } from "./tools/terminal";
export type { TerminalShell, TerminalToolOptions } from "./tools/terminal";
// web_search（工单 10）：搜索源接口 + Tavily 默认实现 + 工具定义
export {
  createTavilySearchSource,
  createWebSearchTool,
} from "./tools/web-search";
export type {
  SearchOptions,
  SearchSource,
  SearchResult,
  TavilySearchSourceOptions,
  WebSearchToolOptions,
} from "./tools/web-search";
export { resolveInWorkspace } from "./tools/workspace";
// MCP 客户端（工单 12，stdio）：连接管理 + 工具发现 + ToolDefinition 适配
export {
  createMcpManager,
  MCP_DEFAULT_CALL_TIMEOUT_MS,
  MCP_DEFAULT_CONNECT_TIMEOUT_MS,
} from "./mcp/manager";
export type { McpManager, McpManagerOptions } from "./mcp/manager";
// AGENTS.md 发现（依赖 node:fs / git 探测，Node 宿主专用）
export {
  AGENTS_MD_MAX_BYTES,
  composeSystemPrompt,
  discoverAgentsInstructions,
} from "./context/agents-md";
export type {
  AgentsMdDiscovery,
  AgentsMdSection,
  DiscoverAgentsInstructionsOptions,
} from "./context/agents-md";
// 消息级规范与技能发现/按需加载（ADR 0007，宿主与预览共用）。
export { createAgentResourceSnapshot } from "./context/agent-resources";
// 浏览器工具组（工单 11）：Playwright headless Chromium，会话级复用（依赖 playwright-core，仅 Node 宿主）
export {
  createBrowserTaskManager,
  createBrowserTaskManager as createBrowserSessionManager,
} from "./browser/manager";
export type {
  BrowserTaskManager,
  BrowserTaskManager as BrowserSessionManager,
  BrowserTaskManagerOptions,
  BrowserTaskManagerOptions as BrowserSessionManagerOptions,
} from "./browser/manager";
export { createBrowserTools, BROWSER_READ_MAX_CHARS } from "./browser/tools";
export type { BrowserToolsOptions } from "./browser/tools";
export {
  createCliChromiumInstaller,
  DEFAULT_PLAYWRIGHT_DOWNLOAD_HOST,
  ensureChromiumReady,
} from "./browser/chromium";
export type {
  ChromiumInstaller,
  CliChromiumInstallerOptions,
} from "./browser/chromium";
// git 服务（simple-git，改动面板的数据源；工单 05）
export { createGitService } from "./git/git-service";
// 托管 Worktree 管理（worktree 模式会话的隔离副本；工单 09）
export {
  WORKTREE_INCLUDE_FILE,
  createWorktreeService,
} from "./worktree/worktree-service";
export type {
  ManagedWorktree,
  WorktreeService,
} from "./worktree/worktree-service";
// commit 消息生成（一次不发工具的 LLM 请求；mock 依赖注入，可脱离 Electron 测试）
export { generateCommitMessage } from "./git/commit-message";
