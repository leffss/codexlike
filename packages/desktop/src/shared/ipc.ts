import type {
  ApprovalDecision,
  ApprovalMode,
  ApprovalRequest,
  ProviderProfile,
  ProviderProfileInput,
  SessionEvent,
  SessionRecord,
  TranscriptItem,
} from '@codexlike/agent-core';
import type {
  GitBranchResult,
  GitCommitResult,
  GitFileDiff,
  GitStatus,
} from '@codexlike/agent-core';

import type { SessionStatusInfo } from '../sessions/status';
import type { SearchSettings } from '../search/search-settings-store';

// ui 侧经 `@codexlike/desktop/ipc` 引用 /status 数据形状
export type { SessionStatusInfo };
export type { SearchSettings };

/**
 * 渲染进程 ←→ 主进程 的类型化 IPC 契约。
 * preload（contextBridge）暴露 `window.codexlike`，UI 通过 `@codexlike/desktop/ipc` 引用类型。
 * 主→渲染：会话事件流（`session:events` channel，按会话 ID 多路复用）。
 */
export const IPC = {
  providerProfiles: {
    list: 'provider-profiles:list',
    create: 'provider-profiles:create',
    update: 'provider-profiles:update',
    remove: 'provider-profiles:remove',
  },
  sessions: {
    /** 全部会话（含已归档，侧栏列表自行过滤；updatedAt 倒序） */
    list: 'sessions:list',
    /** 新建会话（绑定工作区目录） */
    create: 'sessions:create',
    /** 打开原生目录选择器；取消返回 null */
    selectWorkspace: 'sessions:select-workspace',
    /** 指定会话的消息历史 */
    messages: 'sessions:messages',
    /** 发送消息；流式事件经 sessionEvents 推送 */
    send: 'sessions:send',
    /** 停止按钮：打断指定会话运行中的本轮（流式输出或工具执行）；空闲返回 false */
    interrupt: 'sessions:interrupt',
    /** /rename 与侧栏重命名共用（同一 IPC 通道） */
    rename: 'sessions:rename',
    /** /archive 与侧栏归档共用；archived=false 取消归档 */
    archive: 'sessions:archive',
    /** /status：上下文用量估算 + 模型 + 审批模式 */
    status: 'sessions:status',
    /** /compact：手动压缩历史为摘要（保留最近 3 轮）；成功返回压缩概要 */
    compact: 'sessions:compact',
    /** @引用 菜单候选：工作区文件相对路径列表 */
    workspaceFiles: 'sessions:workspace-files',
    /** 审批模式切换（三档）：落库并对下一次工具调用立即生效 */
    setApprovalMode: 'sessions:set-approval-mode',
    /** 审批响应（审批卡片三键）：唤醒等待中的工具循环 */
    respondApproval: 'sessions:respond-approval',
    /** 当前等待审批的请求（切回会话时恢复审批卡片）；无等待返回 null */
    pendingApproval: 'sessions:pending-approval',
  },
  /** 搜索源设置（工单 10）：key 经 safeStorage 加密落盘 */
  searchSettings: {
    get: 'search-settings:get',
    set: 'search-settings:set',
  },
  /** 主→渲染：会话事件流（SessionEventEnvelope） */
  sessionEvents: 'session:events',
  /** 改动面板 + git 集成（工单 05）：status/diff/分支/提交消息生成/提交 */
  git: {
    /** 工作区 git 状态（非 git 工作区返回 isGitRepo=false，不报错） */
    status: 'git:status',
    /** 单文件 diff（新旧两侧全文，Monaco 双栏渲染） */
    diff: 'git:diff',
    /** 一键创建 codexlike/<会话名> 分支（分支名由会话名生成） */
    createBranch: 'git:create-branch',
    /** 由模型按会话内容生成提交消息草稿（一次不发工具的请求） */
    commitMessage: 'git:commit-message',
    /** 提交当前全部变更（消息可编辑后传入） */
    commit: 'git:commit',
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
      input: ProviderProfileInput,
    ): Promise<ProviderProfile | null>;
    /** 目标不存在时返回 false */
    remove(id: string): Promise<boolean>;
  };
  sessions: {
    /** 全部会话（重启后从 SQLite 恢复；含已归档，侧栏自行过滤） */
    list(): Promise<SessionRecord[]>;
    /** 在指定工作区目录新建会话 */
    create(workspacePath: string): Promise<SessionRecord>;
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
      mentionPaths?: string[],
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
    archive(sessionId: string, archived: boolean): Promise<SessionRecord | null>;
    /** /status 数据；会话不存在返回 null */
    status(sessionId: string): Promise<SessionStatusInfo | null>;
    /**
     * /compact：用所选 Provider Profile 的模型压缩历史为摘要（保留最近 3 轮）。
     * 压缩失败（模型错误 / 历史过短 / 会话正忙）以异常抛回，原历史不受损，可重试。
     */
    compact(
      sessionId: string,
      providerProfileId: string,
    ): Promise<{ compactedMessages: number }>;
    /** @引用 菜单候选（工作区文件相对路径，POSIX 分隔符） */
    workspaceFiles(sessionId: string): Promise<string[]>;
    /** 切换审批模式（readonly / suggest / full），对下一次工具调用立即生效；会话不存在返回 null */
    setApprovalMode(
      sessionId: string,
      mode: ApprovalMode,
    ): Promise<SessionRecord | null>;
    /**
     * 响应等待中的审批（批准 / 拒绝 / 本会话总是允许）；
     * 没有等待中的请求或 id 不匹配时返回 false。
     */
    respondApproval(
      sessionId: string,
      requestId: string,
      decision: ApprovalDecision,
    ): Promise<boolean>;
    /** 当前等待审批的请求（UI 切回会话时恢复审批卡片）；无等待或会话不存在返回 null */
    pendingApproval(sessionId: string): Promise<ApprovalRequest | null>;
  };
  searchSettings: {
    /** 当前搜索源设置（apiKey 已解密，仅存在于渲染进程内存；'' 表示未配置） */
    get(): Promise<SearchSettings>;
    /** 保存搜索源 API key（空字符串清除）；safeStorage 不可用时以异常抛回 */
    set(input: { apiKey: string }): Promise<SearchSettings>;
  };
  /** 订阅会话事件流；返回取消订阅函数 */
  onSessionEvent(
    listener: (envelope: SessionEventEnvelope) => void,
  ): () => void;
  /** 改动面板 + git 集成（工单 05） */
  git: {
    /** 工作区 git 状态；非 git 工作区返回 isGitRepo=false（面板显示降级提示） */
    status(sessionId: string): Promise<GitStatus>;
    /** 单文件改动（新旧两侧全文）；oldPath 为重命名场景的原路径 */
    diff(sessionId: string, path: string, oldPath?: string): Promise<GitFileDiff>;
    /** 创建（或切换到已存在的）codexlike/<会话名> 分支 */
    createBranch(sessionId: string): Promise<GitBranchResult>;
    /** 模型按会话内容生成提交消息草稿（可编辑后提交）；失败抛中文异常 */
    generateCommitMessage(
      sessionId: string,
      providerProfileId: string,
    ): Promise<string>;
    /** 提交当前全部变更；无变更时 committed=false */
    commit(sessionId: string, message: string): Promise<GitCommitResult>;
  };
}
