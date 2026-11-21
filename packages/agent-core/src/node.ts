// Node 宿主出口（Electron 主进程 / Node 测试）。
// 相比浏览器安全的主出口（index.ts），这里额外导出依赖 Node 内置 API 的部分：
// 任务对象、任务管理器、SQLite 持久化。
export * from "./index";

export type { TaskPersistence } from "./task/persistence";
export { createSqliteTaskStore } from "./task/persistence";
export type {
  AgentTask,
  CreateAgentTaskOptions,
  SendMessageOptions,
} from "./task/agent-task";
export { createAgentTask } from "./task/agent-task";
export type { CreateTaskManagerOptions, TaskManager } from "./task/manager";
export { createTaskManager } from "./task/manager";

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
export type {
  TerminalShell,
  TerminalToolOptions,
  TimeoutOption,
} from "./tools/terminal";
// 终端环境白名单与 Git Bash 安装位候选（code review 修复轮：单一来源）——
// desktop 终端会话侧（session-env / node-pty-port）经此复用，不再各自维护副本
export {
  ENV_ALLOWLIST,
  GIT_BASH_CANDIDATES,
  filterEnv,
} from "./tools/terminal";
// 终端会话四工具（ADR 0033 票05）：createBuiltinTools 注入 terminalSessions
// 时追加；desktop 装配管理器单例后经此注入
export { createTerminalSessionTools } from "./tools/terminal-sessions";
export type { TerminalSessionToolsOptions } from "./tools/terminal-sessions";
// 终端命令超时默认值（执行设置票04）：常量本体移至 execution-settings.ts 后
// 经上方 export * from "./index" 随根出口导出（code review 修复 3：单一出口
// 路径，不再从 ./tools/terminal 二次转发）
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
// 浏览器工具组（工单 11）：Playwright headless Chromium，任务级复用（依赖 playwright-core，仅 Node 宿主）
export { createBrowserTaskManager } from "./browser/manager";
export type {
  BrowserTaskManager,
  BrowserTaskManagerOptions,
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
// 托管 Worktree 管理（worktree 模式任务的隔离副本；工单 09）
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
// 任务用量尽力而为入账（ADR 0029）：宿主为任务域辅助调用补记真实 usage
export { settleTaskUsage } from "./task/usage";
// 终端会话（ADR 0033）：管理器核心 + PtyPort 端口接口——node-pty 适配器
// （02 票）在 desktop 实现该端口后注入；agent-core 不引入任何原生依赖
export { createTerminalSessionManager } from "./terminal/manager";
export type {
  TerminalSessionManager,
  TerminalSessionManagerOptions,
} from "./terminal/manager";
export type {
  PtyExitEvent,
  PtyPort,
  PtyProcess,
  PtySize,
  PtySpawnRequest,
} from "./terminal/pty-port";
export {
  DEFAULT_TERMINAL_BUFFER_MAX_BYTES,
  DEFAULT_TERMINAL_MAX_ALIVE_PER_TASK,
  TERMINAL_SNAPSHOT_BYTES,
  TERMINAL_TITLE_MAX_CHARS,
} from "./terminal/types";
// OSC 0/2 标题扫描（标题功能轮）：纯逻辑无 IO，宿主侧无直接消费方
// （管理器内部消费），导出供测试与后续宿主复用
export { createOscTitleScanner } from "./terminal/osc-title";
export type { OscTitleScanner } from "./terminal/osc-title";
