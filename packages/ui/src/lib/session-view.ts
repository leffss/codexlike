import type {
  ApprovalDecision,
  MessageRole,
  SessionEvent,
  StoredMessage,
  ToolCallRecord,
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

/**
 * 消息流里一张子代理嵌套卡片的 UI 状态（工单 13，GLOSSARY「子代理」）：
 * 排队 → 运行（当前活动工具 + 已用时）→ 完成（报告可展开）。
 */
export interface UiSubagent {
  kind: 'subagent';
  /** 子代理 id（编排器生成，进度事件匹配键） */
  id: string;
  /** 主会话 spawn_subagent 的 tool call id（报告回流匹配；queued 阶段尚未知为空串） */
  toolCallId: string;
  /** 委派任务描述 */
  task: string;
  state: 'queued' | 'running' | 'done';
  /** 开始运行时间（ISO；已用时的计算基准） */
  startedAt: string | null;
  report: string | null;
  /** null = 未结束；false = 失败或被中断 */
  ok: boolean | null;
  /** 子代理内部的工具调用（嵌套进度列表） */
  tools: UiToolCall[];
}

/** 消息流条目：消息、工具卡片、审批卡片或子代理嵌套卡片 */
export type UiItem = UiMessage | UiToolCall | UiApproval | UiSubagent;

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
      : item.call.toolName === 'spawn_subagent'
        ? subagentFromToolRecord(item.call)
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

/** 重启恢复：spawn_subagent 的落库记录 → 完成态嵌套卡片（task 从参数解析、报告即 output） */
function subagentFromToolRecord(call: ToolCallRecord): UiSubagent {
  let task = '';
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    if (typeof parsed === 'object' && parsed !== null && 'task' in parsed) {
      const value = (parsed as { task?: unknown }).task;
      if (typeof value === 'string') {
        task = value;
      }
    }
  } catch {
    task = '';
  }
  return {
    kind: 'subagent',
    id: `restore-${call.id}`,
    toolCallId: call.id,
    task,
    state: 'done' as const,
    startedAt: null,
    report: call.output,
    ok: !call.isError,
    tools: [],
  };
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
      // spawn_subagent 由嵌套卡片呈现（subagent-queued/start 事件建卡），不出普通工具卡片
      if (event.call.toolName === 'spawn_subagent') {
        return messages;
      }
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
      // spawn_subagent 的报告回填对应嵌套卡片（按 toolCallId 匹配）
      if (event.call.toolName === 'spawn_subagent') {
        return messages.map((item) =>
          item.kind === 'subagent' && item.toolCallId === event.call.id
            ? {
                ...item,
                state: 'done' as const,
                report: event.call.output,
                ok: !event.call.isError,
              }
            : item,
        );
      }
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

    case 'subagent-queued':
      return [
        ...messages,
        {
          kind: 'subagent',
          id: event.subagentId,
          toolCallId: '',
          task: event.task,
          state: 'queued' as const,
          startedAt: null,
          report: null,
          ok: null,
          tools: [],
        },
      ];

    case 'subagent-start':
      return messages.map((item) =>
        item.kind === 'subagent' && item.id === event.subagentId
          ? { ...item, state: 'running' as const, toolCallId: event.toolCallId, startedAt: nowIso() }
          : item,
      );

    case 'subagent-tool':
      return messages.map((item) => {
        if (item.kind !== 'subagent' || item.id !== event.subagentId) {
          return item;
        }
        if (event.phase === 'call') {
          return {
            ...item,
            tools: [
              ...item.tools,
              {
                kind: 'tool-call' as const,
                id: event.call.id,
                toolName: event.call.toolName,
                arguments: event.call.arguments,
                output: '',
                isError: false,
                running: true,
              },
            ],
          };
        }
        return {
          ...item,
          tools: item.tools.map((tool) =>
            tool.id === event.call.id
              ? {
                  ...tool,
                  output: event.call.output,
                  isError: event.call.isError,
                  running: false,
                }
              : tool,
          ),
        };
      });

    case 'subagent-report':
      return messages.map((item) =>
        item.kind === 'subagent' && item.id === event.subagentId
          ? { ...item, state: 'done' as const, report: event.report, ok: event.ok }
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

/** 子代理开跑时间的记录基准（嵌套卡片「已用时」的计算起点） */
function nowIso(): string {
  return new Date().toISOString();
}
