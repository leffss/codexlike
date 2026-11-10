import type {
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

// ui 侧经 `@codexlike/desktop/ipc` 引用 /status 数据形状
export type { SessionStatusInfo };

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
    /** /rename 与侧栏重命名共用（同一 IPC 通道） */
    rename: 'sessions:rename',
    /** /archive 与侧栏归档共用；archived=false 取消归档 */
    archive: 'sessions:archive',
    /** /status：上下文用量估算 + 模型 + 预留审批模式字段 */
    status: 'sessions:status',
    /** @引用 菜单候选：工作区文件相对路径列表 */
    workspaceFiles: 'sessions:workspace-files',
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
    /** 重命名（/rename 与侧栏等效 UI 操作共用）；会话不存在返回 null */
    rename(sessionId: string, title: string): Promise<SessionRecord | null>;
    /** 归档（/archive 与侧栏等效 UI 操作共用）；archived=false 取消归档 */
    archive(sessionId: string, archived: boolean): Promise<SessionRecord | null>;
    /** /status 数据；会话不存在返回 null */
    status(sessionId: string): Promise<SessionStatusInfo | null>;
    /** @引用 菜单候选（工作区文件相对路径，POSIX 分隔符） */
    workspaceFiles(sessionId: string): Promise<string[]>;
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
