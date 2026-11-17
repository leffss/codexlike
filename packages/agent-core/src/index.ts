// CodexLike Agent Core 公共出口。
// 本包是纯 TypeScript 的 agent 运行时，禁止 import 任何 Electron API（ADR-0002）。
//
// 出口分两层：
// - `.`（本文件）：浏览器可打包——只含类型与 provider/校验的值导出，
//   不引入任何 Node 内置模块（渲染进程的 ui 包从这里值导入）；
// - `./node`（node.ts）：Node 宿主（Electron 主进程）专用，
//   含任务对象、任务管理器与 SQLite 持久化（依赖 node:sqlite 等 Node API）。
//
export type {
  ProviderProfile,
  ProviderProfileErrors,
  ProviderProfileInput,
} from "./provider/provider-profile";
export {
  validateProviderProfile,
  firstModelOf,
  resolveModelOf,
} from "./provider/provider-profile";

export type {
  CreateLanguageModelOptions,
  ThinkingEffort,
} from "./provider/language-model";
export {
  createLanguageModelFromProfile,
  parseThinkingEffort,
  THINKING_EFFORTS,
} from "./provider/language-model";

export type {
  WorkbenchTarget,
  WorkbenchValue,
  WorkbenchEntry,
  TaskPreferences,
  ReadingPosition,
  SavedQuestionDraft,
} from "./task/workbench-state";
export { workbenchKey } from "./task/workbench-state";

// 任务域类型：type-only 再导出，浏览器侧 import type 会被完全擦除
// （ApprovalMode 定义在 ./task/approval，经下方审批域出口统一导出）
export type {
  ApprovalDecisionRecord,
  CompactRecord,
  CompactResult,
  MentionAttachment,
  MessageRole,
  ProjectRecord,
  SubagentMessageRecord,
  SubagentRecord,
  SubagentSnapshot,
  SubagentStatus,
  SubagentToolCallRecord,
  TaskEvent,
  TaskRecord,
  TaskStatus,
  StoredMessage,
  TranscriptItem,
  WorkspaceMode,
} from "./task/types";

export type { TaskSearchResult } from "./task/search";

// 执行设置常量（ADR 0017，GLOSSARY「执行设置」「工具轮次」）：纯常量浏览器安全，
// desktop 存储校验与 ui 表单回退共用同一默认值/范围来源
export {
  COMMAND_TIMEOUT_SECONDS_MAX,
  COMMAND_TIMEOUT_SECONDS_MIN,
  COMPACT_KEEP_ROUNDS_MAX,
  COMPACT_KEEP_ROUNDS_MIN,
  CONTEXT_WARNING_PERCENT_MAX,
  CONTEXT_WARNING_PERCENT_MIN,
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  DEFAULT_COMPACT_KEEP_ROUNDS,
  DEFAULT_CONTEXT_WARNING_PERCENT,
  DEFAULT_MAX_COMMAND_TIMEOUT_SECONDS,
  DEFAULT_MAX_SUBAGENT_TOOL_ROUNDS,
  DEFAULT_MAX_TOOL_ROUNDS,
  DEFAULT_MCP_CALL_TIMEOUT_SECONDS,
  DEFAULT_MCP_CONNECT_TIMEOUT_SECONDS,
  DEFAULT_MODEL_MAX_RETRIES,
  DEFAULT_TASK_CONCURRENCY_LIMIT,
  MAX_COMMAND_TIMEOUT_SECONDS_MAX,
  MAX_COMMAND_TIMEOUT_SECONDS_MIN,
  MODEL_MAX_RETRIES_MAX,
  MODEL_MAX_RETRIES_MIN,
  MCP_CALL_TIMEOUT_SECONDS_MAX,
  MCP_CALL_TIMEOUT_SECONDS_MIN,
  MCP_CONNECT_TIMEOUT_SECONDS_MAX,
  MCP_CONNECT_TIMEOUT_SECONDS_MIN,
  TASK_CONCURRENCY_LIMIT_MAX,
  TASK_CONCURRENCY_LIMIT_MIN,
  TOOL_ROUNDS_MAX,
  TOOL_ROUNDS_MIN,
} from "./task/execution-settings";

// 审批域（GLOSSARY「审批模式」）：类型与状态机纯函数均浏览器安全（ui 审批卡片 / 模式选择器共用）
export type {
  ApprovalDecision,
  ApprovalGate,
  ApprovalMode,
  ApprovalRequest,
} from "./task/approval";
export {
  APPROVAL_MODES,
  APPROVAL_MODE_NAMES,
  commandFirstWord,
  decideApproval,
  isRiskyCommand,
} from "./task/approval";

// 工具域类型（GLOSSARY「工具注册表」）：type-only，工具实现（Node 专属）在 ./node 出口
export type {
  ToolCallRecord,
  ToolDefinition,
  ToolExecutionContext,
  ToolParametersSchema,
  ToolPermission,
  ToolResult,
} from "./tools/types";

// MCP 域类型（GLOSSARY「MCP」，工单 12）：type-only，连接管理实现（Node 专属）在 ./node 出口
export type {
  McpDiscoveredTool,
  McpServerConfig,
  McpServerState,
  McpServerStatus,
} from "./mcp/types";
// 输入框解析层（纯函数，浏览器安全；ui 的命令菜单与发送分发直接值导入）
export {
  extractMentionPaths,
  parseComposerDraft,
  resolveComposerSubmission,
  SLASH_COMMANDS,
} from "./composer/parse";
export type { ComposerDraftMenu, ComposerSubmission } from "./composer/parse";
export { fuzzyMatch } from "./composer/fuzzy";
export { extractSkillNames } from "./composer/skill-reference";

// 规范与技能元数据（浏览器安全；正文发现/加载实现只从 /node 导出）
export type {
  AgentInstructionSource,
  AgentResourceSnapshot,
  ResourceCatalog,
  ResourceDiagnostic,
  ResourceExecution,
  ResourceSnapshotSummary,
  TaskResourcesView,
  TaskResourceState,
  SkillDescriptor,
  SkillLoadRecord,
} from "./context/resource-types";

// 上下文用量估算（/status 与 compact 共用的稳定接口）
export { estimateTokens } from "./context/tokens";
export { composeStoredMessageContent } from "./context/stored-message";
export type {
  InteractionSource,
  QuestionOption,
  InteractiveQuestion,
  ApprovalInteractionRequest,
  QuestionsInteractionRequest,
  InteractionRequest,
  QuestionAnswer,
  InteractionResponse,
  InteractionRecord,
  QuestionAnswerSnapshot,
} from "./interaction/types";
// 上下文告警（code review 修复 2）：估算 → 阈值触发的纯逻辑（spec 验收场景 4）
export {
  CONTEXT_WARNING_THRESHOLD_RATIO,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  evaluateContextWarning,
} from "./context/context-warning";
export type { ContextUsageWarning } from "./context/context-warning";
export type {
  SlashCommandDef,
  SlashCommandName,
} from "./composer/slash-command";

// git 域类型（改动面板数据形状）：type-only，git 服务实现（simple-git，Node 专属）在 ./node 出口
export type {
  GitBranchResult,
  GitChangeKind,
  GitCommitResult,
  GitFileChange,
  GitFileDiff,
  GitService,
  GitStatus,
} from "./git/git-service";
// 任务名 → 类型/<slug> 分支名与提交消息 prompt 组装（纯函数，浏览器安全）
export { taskBranchName } from "./git/branch-name";
export { buildCommitMessagePrompt } from "./git/commit-message";
