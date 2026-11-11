// CodexLike Agent Core 公共出口。
// 本包是纯 TypeScript 的 agent 运行时，禁止 import 任何 Electron API（ADR-0002）。
//
// 出口分两层：
// - `.`（本文件）：浏览器可打包——只含类型与 provider/校验的值导出，
//   不引入任何 Node 内置模块（渲染进程的 ui 包从这里值导入）；
// - `./node`（node.ts）：Node 宿主（Electron 主进程）专用，
//   含会话对象、会话管理器与 SQLite 持久化（依赖 node:sqlite 等 Node API）。
export type {
  ProviderProfile,
  ProviderProfileErrors,
  ProviderProfileInput,
} from "./provider/provider-profile";
export { validateProviderProfile } from "./provider/provider-profile";

export type {
  CreateLanguageModelOptions,
  ThinkingEffort,
} from "./provider/language-model";
export {
  createLanguageModelFromProfile,
  THINKING_EFFORTS,
} from "./provider/language-model";

// 会话域类型：type-only 再导出，浏览器侧 import type 会被完全擦除
// （ApprovalMode 定义在 ./session/approval，经下方审批域出口统一导出）
export type {
  ApprovalDecisionRecord,
  CompactRecord,
  CompactResult,
  MentionAttachment,
  MessageRole,
  SessionEvent,
  SessionRecord,
  SessionStatus,
  StoredMessage,
  TranscriptItem,
  WorkspaceMode,
} from "./session/types";

// 审批域（GLOSSARY「审批模式」）：类型与状态机纯函数均浏览器安全（ui 审批卡片 / 模式选择器共用）
export type {
  ApprovalDecision,
  ApprovalGate,
  ApprovalMode,
  ApprovalRequest,
} from "./session/approval";
export {
  APPROVAL_MODES,
  APPROVAL_MODE_NAMES,
  commandFirstWord,
  decideApproval,
  isRiskyCommand,
} from "./session/approval";

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

// 上下文用量估算（/status 与 compact 共用的稳定接口）
export { estimateTokens } from "./context/tokens";
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
// 会话名 → codexlike/<会话名> 分支名与提交消息 prompt 组装（纯函数，浏览器安全）
export { codexlikeBranchName } from "./git/branch-name";
export { buildCommitMessagePrompt } from "./git/commit-message";
