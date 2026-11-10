import type {
  ProviderProfile,
  ProviderProfileInput,
  SessionEvent,
  SessionRecord,
  StoredMessage,
} from '@codexlike/agent-core';

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
    /** 全部会话（侧栏列表，updatedAt 倒序） */
    list: 'sessions:list',
    /** 新建会话（绑定工作区目录） */
    create: 'sessions:create',
    /** 打开原生目录选择器；取消返回 null */
    selectWorkspace: 'sessions:select-workspace',
    /** 指定会话的消息历史 */
    messages: 'sessions:messages',
    /** 发送消息；流式事件经 sessionEvents 推送 */
    send: 'sessions:send',
  },
  /** 主→渲染：会话事件流（SessionEventEnvelope） */
  sessionEvents: 'session:events',
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
    /** 全部会话（重启后从 SQLite 恢复） */
    list(): Promise<SessionRecord[]>;
    /** 在指定工作区目录新建会话 */
    create(workspacePath: string): Promise<SessionRecord>;
    /** 原生目录选择器；取消返回 null */
    selectWorkspace(): Promise<string | null>;
    /** 指定会话的消息历史（含 error 消息） */
    messages(sessionId: string): Promise<StoredMessage[]>;
    /**
     * 发送消息：成功即启动流式回复（事件经 onSessionEvent 推送）。
     * 会话正在回复中 / Profile 不存在等启动失败以异常抛回。
     */
    send(
      sessionId: string,
      text: string,
      providerProfileId: string,
    ): Promise<void>;
  };
  /** 订阅会话事件流；返回取消订阅函数 */
  onSessionEvent(
    listener: (envelope: SessionEventEnvelope) => void,
  ): () => void;
}
