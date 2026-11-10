import type {
  ApprovalDecision,
  MessageRole,
  SessionEvent,
  StoredMessage,
  TranscriptItem,
} from '@codexlike/agent-core';

/** 消息流里一条消息的 UI 状态（含流式/中断标记）；kind 为联合判别保留位 */
/**
 * 本地状态消息角色（工单 07）：命令反馈与 /status 展示。
 * 只存在于渲染层（不落库、不进模型上下文、不来自 SessionEvent）。
 */
export type LocalMessageRole = 'status';

/** 消息流里一条消息的 UI 状态（含流式/中断标记） */
export interface UiMessage {
  kind?: undefined;
  id: string;
  role: MessageRole | LocalMessageRole;
  content: string;
  /** 助手消息流式进行中 */
  streaming?: boolean;
  /** 助手消息被用户中断，content 为部分内容 */
  interrupted?: boolean;
}

/** 消息流里一张工具卡片的 UI 状态 */
export interface UiToolCall {
  kind: 'tool-call';
  id: string;
  toolName: string;
  /** 参数 JSON 字符串（展示时解析） */
  arguments: string;
  /** 截断后的执行输出 */
  output: string;
  isError: boolean;
  /** tool-call 事件已到、tool-result 未到 */
  running?: boolean;
}

/** 消息流里一张审批卡片的 UI 状态（工单 04：批准 / 拒绝 / 本会话总是允许） */
export interface UiApproval {
  kind: 'approval';
  /** 审批 id（即对应 tool call id） */
  id: string;
  toolName: string;
  /** 命令原文 */
  command: string;
  /** 命令首词（「本会话总是允许」的记忆键） */
  commandWord: string;
  /** null = 等待用户决定；响应后变为对应决定（卡片转结果态） */
  decision: ApprovalDecision | null;
}

/** 消息流条目：消息、工具卡片或审批卡片 */
export type UiItem = UiMessage | UiToolCall | UiApproval;

/** 会话切换 / 应用启动时，把持久化历史映射为消息流初始状态 */
export function initialMessages(history: StoredMessage[]): UiMessage[] {
  return history.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
  }));
}

/** 会话时间线（消息 + 工具调用）→ 消息流初始状态 */
export function initialTranscript(items: TranscriptItem[]): UiItem[] {
  return items.map((item) =>
    item.kind === 'message'
      ? {
          id: item.message.id,
          role: item.message.role,
          content: item.message.content,
          // 重启恢复：被中断的助手消息仍显示中断点标记
          interrupted: item.message.aborted === true || undefined,
        }
      : {
          kind: 'tool-call',
          id: item.call.id,
          toolName: item.call.toolName,
          arguments: item.call.arguments,
          output: item.call.output,
          isError: item.call.isError,
          running: false,
        },
  );
}

/**
 * 流式事件 → 消息流增量更新（纯函数，React state 的归并核心）。
 * 未知 messageId 的 delta/完成事件被忽略：事件流可能在会话切换后迟到。
 */
export function applySessionEvent(
  messages: UiItem[],
  event: SessionEvent,
): UiItem[] {
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
        message.kind === undefined && message.id === event.messageId
          ? { ...message, content: message.content + event.delta }
          : message,
      );

    case 'assistant-done':
      return messages.map((message) =>
        message.kind === undefined && message.id === event.message.id
          ? { ...message, content: event.message.content, streaming: undefined }
          : message,
      );

    case 'assistant-aborted':
      return messages.map((message) =>
        message.kind === undefined && message.id === event.message.id
          ? {
              ...message,
              content: event.message.content,
              streaming: undefined,
              interrupted: true,
            }
          : message,
      );

    case 'tool-call':
      return [
        ...messages,
        {
          kind: 'tool-call',
          id: event.call.id,
          toolName: event.call.toolName,
          arguments: event.call.arguments,
          output: '',
          isError: false,
          running: true,
        },
      ];

    case 'tool-result':
      return messages.map((item) =>
        item.kind === 'tool-call' && item.id === event.call.id
          ? {
              ...item,
              output: event.call.output,
              isError: event.call.isError,
              running: false,
            }
          : item,
      );

    case 'approval-request':
      return [
        ...messages,
        {
          kind: 'approval',
          id: event.request.id,
          toolName: event.request.toolName,
          command: event.request.command,
          commandWord: event.request.commandWord,
          decision: null,
        },
      ];

    case 'approval-resolved':
      return messages.map((item) =>
        item.kind === 'approval' && item.id === event.requestId
          ? { ...item, decision: event.decision }
          : item,
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
