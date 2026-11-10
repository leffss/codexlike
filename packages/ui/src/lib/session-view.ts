import type { MessageRole, SessionEvent, StoredMessage } from '@codexlike/agent-core';

/** 消息流里一条消息的 UI 状态（含流式/中断标记） */
export interface UiMessage {
  id: string;
  role: MessageRole;
  content: string;
  /** 助手消息流式进行中 */
  streaming?: boolean;
  /** 助手消息被用户中断，content 为部分内容 */
  interrupted?: boolean;
}

/** 会话切换 / 应用启动时，把持久化历史映射为消息流初始状态 */
export function initialMessages(history: StoredMessage[]): UiMessage[] {
  return history.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
  }));
}

/**
 * 流式事件 → 消息流增量更新（纯函数，React state 的归并核心）。
 * 未知 messageId 的 delta/完成事件被忽略：事件流可能在会话切换后迟到。
 */
export function applySessionEvent(
  messages: UiMessage[],
  event: SessionEvent,
): UiMessage[] {
  switch (event.type) {
    case 'user-message':
      return [
        ...messages,
        {
          id: event.message.id,
          role: 'user',
          content: event.message.content,
        },
      ];

    case 'assistant-start':
      return [
        ...messages,
        {
          id: event.messageId,
          role: 'assistant',
          content: '',
          streaming: true,
        },
      ];

    case 'assistant-delta':
      return messages.map((message) =>
        message.id === event.messageId
          ? { ...message, content: message.content + event.delta }
          : message,
      );

    case 'assistant-done':
      return messages.map((message) =>
        message.id === event.message.id
          ? { ...message, content: event.message.content, streaming: undefined }
          : message,
      );

    case 'assistant-aborted':
      return messages.map((message) =>
        message.id === event.message.id
          ? {
              ...message,
              content: event.message.content,
              streaming: undefined,
              interrupted: true,
            }
          : message,
      );

    case 'error':
      return [
        ...messages,
        {
          id: event.message.id,
          role: 'error',
          content: event.message.content,
        },
      ];
  }
}
