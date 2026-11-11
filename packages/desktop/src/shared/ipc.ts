import type {
  ApprovalDecision,
  ApprovalMode,
  ApprovalRequest,
  ProviderProfile,
  ProviderProfileInput,
  SessionEvent,
  SessionRecord,
  SessionResourcesView,
  TranscriptItem,
  WorkspaceMode,
} from "@codexlike/agent-core";
import type {
  GitBranchResult,
  GitCommitResult,
  GitFileDiff,
  GitStatus,
} from "@codexlike/agent-core";

import type { SessionStatusInfo } from "../sessions/status";
import type { SearchSettings } from "../search/search-settings-store";
import type { SubagentSettings } from "../subagents/subagent-settings-store";
import type { TerminalShell } from "@codexlike/agent-core/node";
import type { McpServerView } from "../mcp/mcp-service";
import type { McpServerInput } from "../mcp/mcp-store";
import type { ThemeName } from "../theme/theme-settings-store";

// ui 侧经 `@codexlike/desktop/ipc` 引用 /status 数据形状
export type { SessionStatusInfo };
export type { SearchSettings };
export type { SubagentSettings };
export type { TerminalShell };
export type { McpServerView, McpServerInput };
export type { ThemeName };

/**
 * 渲染进程 ←→ 主进程 的类型化 IPC 契约。
 * preload（contextBridge）暴露 `window.codexlike`，UI 通过 `@codexlike/desktop/ipc` 引用类型。
 * 主→渲染：会话事件流（`session:events` channel，按会话 ID 多路复用）。
 */
export const IPC = {
  providerProfiles: {
    list: "provider-profiles:list",
    create: "provider-profiles:create",
    update: "provider-profiles:update",
    remove: "provider-profiles:remove",
  },
  sessions: {
    /** 全部会话（含已归档，侧栏列表自行过滤；updatedAt 倒序） */
    list: "sessions:list",
    /** 新建会话（绑定工作区目录；可选运行位置 local/worktree） */
    create: "sessions:create",
    /** 打开原生目录选择器；取消返回 null */
    selectWorkspace: "sessions:select-workspace",
    /** 指定会话的消息历史 */
    messages: "sessions:messages",
    /** 发送消息；流式事件经 sessionEvents 推送 */
    send: "sessions:send",
    /** 停止按钮：打断指定会话运行中的本轮（流式输出或工具执行）；空闲返回 false */
    interrupt: "sessions:interrupt",
    /** /rename 与侧栏重命名共用（同一 IPC 通道） */
    rename: "sessions:rename",
    /** /archive 与侧栏归档共用；archived=false 取消归档 */
    archive: "sessions:archive",
    /** /status：上下文用量估算 + 模型 + 审批模式 */
    status: "sessions:status",
    /** 规范与技能：当前/最近运行摘要及下条消息的磁盘预览。 */
    resources: "sessions:resources",
    /** /compact：手动压缩历史为摘要（保留最近 3 轮）；成功返回压缩概要 */
    compact: "sessions:compact",
    /** @引用 菜单候选：工作区文件相对路径列表 */
    workspaceFiles: "sessions:workspace-files",
    /** 工具截图数据（dataURL）；文件不存在（如已清理）返回 null */
    toolImage: "sessions:tool-image",
    /** 审批模式切换（三档）：落库并对下一次工具调用立即生效 */
    setApprovalMode: "sessions:set-approval-mode",
    /** 审批响应（审批卡片三键）：唤醒等待中的工具循环 */
    respondApproval: "sessions:respond-approval",
    /** 当前等待审批的请求（切回会话时恢复审批卡片）；无等待返回 null */
    pendingApproval: "sessions:pending-approval",
    /** 全部等待审批的请求（工单 13：主会话与子代理可能并行等待）；按到达顺序 */
    pendingApprovals: "sessions:pending-approvals",
  },
  /** 搜索源设置（工单 10）：key 经 safeStorage 加密落盘 */
  searchSettings: {
    get: "search-settings:get",
    set: "search-settings:set",
  },
  /** 子代理全局设置（工单 13）：子代理模型引用 + 并发上限 */
  subagentSettings: {
    get: "subagent-settings:get",
    set: "subagent-settings:set",
  },
  /** 终端执行偏好（code review 修复 1）：run_terminal_command 的 shell 选择 */
  terminalSettings: {
    get: "terminal-settings:get",
    set: "terminal-settings:set",
  },
  /** 外观主题偏好（ADR 0006）：light / dark，默认浅色；主进程同步窗口底色与 nativeTheme */
  themeSettings: {
    get: "theme-settings:get",
    set: "theme-settings:set",
  },
  /** MCP servers（工单 12）：配置 + 连接状态 + 工具启停 */
  mcp: {
    overview: "mcp:overview",
    addServer: "mcp:add-server",
    removeServer: "mcp:remove-server",
    reconnect: "mcp:reconnect",
    setToolEnabled: "mcp:set-tool-enabled",
  },
  /** 主→渲染：会话事件流（SessionEventEnvelope） */
  sessionEvents: "session:events",
  /** 改动面板 + git 集成（工单 05）：status/diff/分支/提交消息生成/提交 */
  git: {
    /** 工作区 git 状态（非 git 工作区返回 isGitRepo=false，不报错） */
    status: "git:status",
    /** 单文件 diff（新旧两侧全文，Monaco 双栏渲染） */
    diff: "git:diff",
    /** 一键创建 codexlike/<会话名> 分支（分支名由会话名生成） */
    createBranch: "git:create-branch",
    /** 由模型按会话内容生成提交消息草稿（一次不发工具的请求） */
    commitMessage: "git:commit-message",
    /** 提交当前全部变更（消息可编辑后传入） */
    commit: "git:commit",
  },
} as const;

/** 事件流信封：按会话 ID 多路复用 */
export interface SessionEventEnvelope {
  sessionId: string;
  event: SessionEvent;
}

/** `window.codexlike` 的完整 API 形状 */
export interface CodexLikeApi {
  providerProfiles: {
    /** 全部 Provider Profile（apiKey 已解密，仅存在于渲染进程内存） */
    list(): Promise<ProviderProfile[]>;
    create(input: ProviderProfileInput): Promise<ProviderProfile>;
    /** 目标不存在时返回 null */
    update(
      id: string,
      input: ProviderProfileInput
    ): Promise<ProviderProfile | null>;
    /** 目标不存在时返回 false */
    remove(id: string): Promise<boolean>;
  };
  sessions: {
    /** 全部会话（重启后从 SQLite 恢复；含已归档，侧栏自行过滤） */
    list(): Promise<SessionRecord[]>;
    /**
     * 在指定工作区目录新建会话。workspaceMode 缺省 local（本目录直跑）；
     * `worktree` 在 ~/.codexlike/worktrees/<会话id> 检出托管 Worktree（独立分支），
     * 非 git 目录以中文异常抛回且会话不创建。
     */
    create(
      workspacePath: string,
      workspaceMode?: WorkspaceMode
    ): Promise<SessionRecord>;
    /** 原生目录选择器；取消返回 null */
    selectWorkspace(): Promise<string | null>;
    /** 指定会话的时间线：消息与工具卡片按发生顺序合并（含 error 消息） */
    messages(sessionId: string): Promise<TranscriptItem[]>;
    /**
     * 发送消息：成功即启动流式回复（事件经 onSessionEvent 推送）。
     * mentionPaths 为消息中 @引用 的工作区相对路径，内容由主进程读取附加进模型上下文。
     * 会话正在回复中 / Profile 不存在 / 引用文件不可读等启动失败以异常抛回。
     */
    send(
      sessionId: string,
      text: string,
      providerProfileId: string,
      mentionPaths?: string[]
    ): Promise<void>;
    /**
     * 打断指定会话运行中的本轮（停止按钮）：
     * 流式输出立即中断（已生成部分保留）、工具执行中终止子进程。
     * 会话空闲时幂等返回 false。
     */
    interrupt(sessionId: string): Promise<boolean>;
    /** 重命名（/rename 与侧栏等效 UI 操作共用）；会话不存在返回 null */
    rename(sessionId: string, title: string): Promise<SessionRecord | null>;
    /** 归档（/archive 与侧栏等效 UI 操作共用）；archived=false 取消归档 */
    archive(
      sessionId: string,
      archived: boolean
    ): Promise<SessionRecord | null>;
    /** /status 数据；会话不存在返回 null */
    status(sessionId: string): Promise<SessionStatusInfo | null>;
    /** 只返回资源元数据与加载记录，不返回全部技能正文。 */
    resources(sessionId: string): Promise<SessionResourcesView | null>;
    /**
     * /compact：用所选 Provider Profile 的模型压缩历史为摘要（保留最近 3 轮）。
     * 压缩失败（模型错误 / 历史过短 / 会话正忙）以异常抛回，原历史不受损，可重试。
     */
    compact(
      sessionId: string,
      providerProfileId: string
    ): Promise<{ compactedMessages: number }>;
    /** @引用 菜单候选（工作区文件相对路径，POSIX 分隔符） */
    workspaceFiles(sessionId: string): Promise<string[]>;
    /**
     * 工具调用截图（browser_screenshot）的图片数据：`data:image/png;base64,…`。
     * 文件不存在（其它数据目录 / 已清理 / 非截图调用）返回 null。
     */
    toolImage(sessionId: string, toolCallId: string): Promise<string | null>;
    /** 切换审批模式（readonly / suggest / full），对下一次工具调用立即生效；会话不存在返回 null */
    setApprovalMode(
      sessionId: string,
      mode: ApprovalMode
    ): Promise<SessionRecord | null>;
    /**
     * 响应等待中的审批（批准 / 拒绝 / 本会话总是允许）；
     * 没有等待中的请求或 id 不匹配时返回 false。
     */
    respondApproval(
      sessionId: string,
      requestId: string,
      decision: ApprovalDecision
    ): Promise<boolean>;
    /** 当前等待审批的请求（UI 切回会话时恢复审批卡片）；无等待或会话不存在返回 null */
    pendingApproval(sessionId: string): Promise<ApprovalRequest | null>;
    /** 全部等待审批的请求（含子代理并行等待，工单 13）；无等待返回空数组 */
    pendingApprovals(sessionId: string): Promise<ApprovalRequest[]>;
  };
  searchSettings: {
    /** 当前搜索源设置（apiKey 已解密，仅存在于渲染进程内存；'' 表示未配置） */
    get(): Promise<SearchSettings>;
    /** 保存搜索源 API key（空字符串清除）；safeStorage 不可用时以异常抛回 */
    set(input: { apiKey: string }): Promise<SearchSettings>;
  };
  subagentSettings: {
    /** 当前子代理全局设置（模型引用 null = 同主模型；并发上限默认 3） */
    get(): Promise<SubagentSettings>;
    /**
     * 保存子代理设置（providerProfileId 不存在或 null 时以异常抛回——引用必须有效）；
     * 改动对后续会话/下一次委派生效。
     */
    set(input: SubagentSettings): Promise<SubagentSettings>;
  };
  terminalSettings: {
    /** 已保存的终端 shell 偏好；未配置返回 null（此时 CODEXLIKE_SHELL 环境变量兜底） */
    get(): Promise<TerminalShell | null>;
    /** 保存 shell 偏好（git-bash / powershell / cmd），对下一次终端命令即时生效 */
    set(shell: TerminalShell): Promise<TerminalShell>;
  };
  themeSettings: {
    /** 已保存的外观主题；未配置返回 null（UI 以浅色兜底，ADR 0006） */
    get(): Promise<ThemeName | null>;
    /** 保存主题偏好（light / dark），立即生效并同步原生窗口底色 */
    set(theme: ThemeName): Promise<ThemeName>;
  };
  mcp: {
    /** 全部 MCP server：配置 + 连接状态 + 发现到的工具（含启停） */
    overview(): Promise<{ servers: McpServerView[] }>;
    /** 添加 server（保存配置并立即连接）；输入不合法以中文异常抛回 */
    addServer(input: McpServerInput): Promise<McpServerView>;
    /** 删除 server（断开连接）；不存在返回 false */
    removeServer(id: string): Promise<boolean>;
    /** 手动重连（崩溃/启动失败后的显式重连入口） */
    reconnect(id: string): Promise<McpServerView>;
    /** 工具启停：对后续会话消息即时生效 */
    setToolEnabled(toolName: string, enabled: boolean): Promise<void>;
  };
  /** 订阅会话事件流；返回取消订阅函数 */
  onSessionEvent(
    listener: (envelope: SessionEventEnvelope) => void
  ): () => void;
  /** 改动面板 + git 集成（工单 05） */
  git: {
    /** 工作区 git 状态；非 git 工作区返回 isGitRepo=false（面板显示降级提示） */
    status(sessionId: string): Promise<GitStatus>;
    /** 单文件改动（新旧两侧全文）；oldPath 为重命名场景的原路径 */
    diff(
      sessionId: string,
      path: string,
      oldPath?: string
    ): Promise<GitFileDiff>;
    /** 创建（或切换到已存在的）codexlike/<会话名> 分支 */
    createBranch(sessionId: string): Promise<GitBranchResult>;
    /** 模型按会话内容生成提交消息草稿（可编辑后提交）；失败抛中文异常 */
    generateCommitMessage(
      sessionId: string,
      providerProfileId: string
    ): Promise<string>;
    /** 提交当前全部变更；无变更时 committed=false */
    commit(sessionId: string, message: string): Promise<GitCommitResult>;
  };
}
