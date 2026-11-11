import type {
  InteractionRecord,
  MessageRole,
  SessionEvent,
  StoredMessage,
  ToolCallRecord,
  TranscriptItem,
} from "@codexlike/agent-core";

/** 消息流里一条消息的 UI 状态（含流式/中断标记）；kind 为联合判别保留位 */
/**
 * 本地状态消息角色（工单 07）：命令反馈与 /status 展示。
 * 只存在于渲染层（不落库、不进模型上下文、不来自 SessionEvent）。
 */
export type LocalMessageRole = "status";

/** 消息流里一条消息的 UI 状态（含流式/中断标记） */
export interface UiMessage {
  kind?: undefined;
  id: string;
  role: MessageRole | LocalMessageRole;
  content: string;
  /**
   * 模型思考过程（GLOSSARY「思考档位」）：仅运行期展示，与正文分开累积；
   * 不来自持久化（历史加载不重建），终态由 done/aborted/error 事件收敛。
   */
  reasoning?: string;
  /** 助手消息流式进行中 */
  streaming?: boolean;
  /** 助手消息被用户中断，content 为部分内容 */
  interrupted?: boolean;
}

/** 消息流里一张工具卡片的 UI 状态 */
export interface UiToolCall {
  kind: "tool-call";
  id: string;
  /** 所属会话（截图卡片按会话+调用 id 向主进程请求图片数据） */
  sessionId: string;
  toolName: string;
  /** 参数 JSON 字符串（展示时解析） */
  arguments: string;
  /** 截断后的执行输出 */
  output: string;
  isError: boolean;
  /** tool-call 事件已到、tool-result 未到 */
  running?: boolean;
}

/** 消息流只读交互记录；操作只存在于底部 InteractionPanel。 */
export interface UiInteraction {
  kind: "interaction";
  id: string;
  interaction: InteractionRecord;
}

/**
 * 消息流里一张子代理嵌套卡片的 UI 状态（工单 13，GLOSSARY「子代理」）：
 * 排队 → 运行（当前活动工具 + 已用时）→ 完成（报告可展开）。
 */
export interface UiSubagent {
  kind: "subagent";
  /** 子代理 id（编排器生成，进度事件匹配键） */
  id: string;
  /** 主会话 spawn_subagent 的 tool call id（报告回流匹配；queued 阶段尚未知为空串） */
  toolCallId: string;
  /** 委派任务描述 */
  task: string;
  state: "queued" | "running" | "done";
  /** 开始运行时间（ISO；已用时的计算基准） */
  startedAt: string | null;
  /**
   * 子代理思考过程（GLOSSARY「思考档位」，思考档位 03）：与报告文本分开累积，
   * 仅运行期展示（历史加载不重建）；终态由 subagent-report 收敛。
   */
  reasoning?: string;
  report: string | null;
  /** null = 未结束；false = 失败或被中断 */
  ok: boolean | null;
  /** 子代理内部的工具调用（嵌套进度列表） */
  tools: UiToolCall[];
}

/** 消息流条目：消息、工具卡片、审批卡片或子代理嵌套卡片 */
export type UiItem = UiMessage | UiToolCall | UiInteraction | UiSubagent;

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
    item.kind === "message"
      ? {
          id: item.message.id,
          role: item.message.role,
          content: item.message.content,
          // 重启恢复：被中断的助手消息仍显示中断点标记
          interrupted: item.message.aborted === true || undefined,
        }
      : item.kind === "interaction"
        ? {
            kind: "interaction",
            id: item.interaction.request.id,
            interaction: item.interaction,
          }
        : item.call.toolName === "spawn_subagent"
          ? subagentFromToolRecord(item.call)
          : {
              kind: "tool-call",
              id: item.call.id,
              sessionId: item.call.sessionId,
              toolName: item.call.toolName,
              arguments: item.call.arguments,
              output: item.call.output,
              isError: item.call.isError,
              running: false,
            }
  );
}

/** 重启恢复：spawn_subagent 的落库记录 → 完成态嵌套卡片（task 从参数解析、报告即 output） */
function subagentFromToolRecord(call: ToolCallRecord): UiSubagent {
  let task = "";
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    if (typeof parsed === "object" && parsed !== null && "task" in parsed) {
      const value = (parsed as { task?: unknown }).task;
      if (typeof value === "string") {
        task = value;
      }
    }
  } catch {
    task = "";
  }
  return {
    kind: "subagent",
    id: `restore-${call.id}`,
    toolCallId: call.id,
    task,
    state: "done" as const,
    startedAt: null,
    report: call.output,
    ok: !call.isError,
    tools: [],
  };
}

/**
 * 流式事件 → 消息流增量更新（纯函数，React state 的归并核心）。
 * 调用方按 sessionId 隔离事件；切会话/设置可能错过 start，后续事件负责重建助手消息。
 */
export function applySessionEvent(
  messages: UiItem[],
  event: SessionEvent
): UiItem[] {
  switch (event.type) {
    case "user-message":
      return [
        ...messages,
        {
          id: event.message.id,
          role: "user",
          content: event.message.content,
        },
      ];

    case "assistant-start":
      if (
        messages.some(
          (item) => item.kind === undefined && item.id === event.messageId
        )
      )
        return messages;
      return [
        ...messages,
        {
          id: event.messageId,
          role: "assistant",
          content: "",
          streaming: true,
        },
      ];

    case "assistant-delta":
      if (
        !messages.some(
          (item) => item.kind === undefined && item.id === event.messageId
        )
      ) {
        return [
          ...messages,
          {
            id: event.messageId,
            role: "assistant",
            content: event.delta,
            streaming: true,
          },
        ];
      }
      return messages.map((message) =>
        message.kind === undefined && message.id === event.messageId
          ? { ...message, content: message.content + event.delta }
          : message
      );

    case "assistant-reasoning":
      if (
        !messages.some(
          (item) => item.kind === undefined && item.id === event.messageId
        )
      ) {
        return [
          ...messages,
          {
            id: event.messageId,
            role: "assistant",
            content: "",
            reasoning: event.delta,
            streaming: true,
          },
        ];
      }
      // 思考与正文分离累积。
      return messages.map((message) =>
        message.kind === undefined && message.id === event.messageId
          ? { ...message, reasoning: (message.reasoning ?? "") + event.delta }
          : message
      );

    case "assistant-done":
      if (
        !messages.some(
          (item) => item.kind === undefined && item.id === event.message.id
        )
      ) {
        return [
          ...messages,
          {
            id: event.message.id,
            role: "assistant",
            content: event.message.content,
          },
        ];
      }
      return messages.map((message) =>
        message.kind === undefined && message.id === event.message.id
          ? { ...message, content: event.message.content, streaming: undefined }
          : message
      );

    case "assistant-aborted":
      if (
        !messages.some(
          (item) => item.kind === undefined && item.id === event.message.id
        )
      ) {
        return [
          ...messages,
          {
            id: event.message.id,
            role: "assistant",
            content: event.message.content,
            interrupted: true,
          },
        ];
      }
      return messages.map((message) =>
        message.kind === undefined && message.id === event.message.id
          ? {
              ...message,
              content: event.message.content,
              streaming: undefined,
              interrupted: true,
            }
          : message
      );

    case "tool-call":
      // spawn_subagent 由嵌套卡片呈现（subagent-queued/start 事件建卡），不出普通工具卡片
      if (event.call.toolName === "spawn_subagent") {
        return messages;
      }
      return [
        ...messages,
        {
          kind: "tool-call",
          id: event.call.id,
          sessionId: event.call.sessionId,
          toolName: event.call.toolName,
          arguments: event.call.arguments,
          output: "",
          isError: false,
          running: true,
        },
      ];

    case "tool-result":
      // spawn_subagent 的报告回填对应嵌套卡片（按 toolCallId 匹配）
      if (event.call.toolName === "spawn_subagent") {
        return messages.map((item) =>
          item.kind === "subagent" && item.toolCallId === event.call.id
            ? {
                ...item,
                state: "done" as const,
                report: event.call.output,
                ok: !event.call.isError,
              }
            : item
        );
      }
      return messages.map((item) =>
        item.kind === "tool-call" && item.id === event.call.id
          ? {
              ...item,
              output: event.call.output,
              isError: event.call.isError,
              running: false,
            }
          : item
      );

    case "subagent-queued":
      return [
        ...messages,
        {
          kind: "subagent",
          id: event.subagentId,
          toolCallId: "",
          task: event.task,
          state: "queued" as const,
          startedAt: null,
          report: null,
          ok: null,
          tools: [],
        },
      ];

    case "subagent-start":
      return messages.map((item) =>
        item.kind === "subagent" && item.id === event.subagentId
          ? {
              ...item,
              state: "running" as const,
              toolCallId: event.toolCallId,
              startedAt: nowIso(),
            }
          : item
      );

    case "subagent-tool":
      return messages.map((item) => {
        if (item.kind !== "subagent" || item.id !== event.subagentId) {
          return item;
        }
        if (event.phase === "call") {
          return {
            ...item,
            tools: [
              ...item.tools,
              {
                kind: "tool-call" as const,
                id: event.call.id,
                sessionId: event.call.sessionId,
                toolName: event.call.toolName,
                arguments: event.call.arguments,
                output: "",
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
              : tool
          ),
        };
      });

    case "subagent-reasoning":
      // 子代理思考：与报告分离累积到所属卡片；未知 subagentId（会话切换后迟到）忽略
      return messages.map((item) =>
        item.kind === "subagent" && item.id === event.subagentId
          ? { ...item, reasoning: (item.reasoning ?? "") + event.delta }
          : item
      );

    case "subagent-report":
      return messages.map((item) =>
        item.kind === "subagent" && item.id === event.subagentId
          ? {
              ...item,
              state: "done" as const,
              report: event.report,
              ok: event.ok,
            }
          : item
      );

    case "interaction-request":
    case "interaction-resolved":
      return mergeInteractions(messages, [event.interaction]);

    // 旧事件只作兼容，不再创建第二套可操作审批卡片。
    case "approval-request":
    case "approval-resolved":
      return messages;

    case "error":
      return [
        // 出错即本轮终止：正在流式中的助手消息（含思考块）收敛，不残留进行中状态
        ...messages.map((message) =>
          message.kind === undefined && message.streaming === true
            ? { ...message, streaming: undefined }
            : message
        ),
        {
          id: event.message.id,
          role: "error",
          content: event.message.content,
        },
      ];
  }
}

/** 加载期间缓冲事件：快照已有的消息/工具不再重复回放。 */
export function hydrateTranscript(
  history: TranscriptItem[],
  events: SessionEvent[]
): UiItem[] {
  const messageIds = new Set(
    history.flatMap((item) =>
      item.kind === "message" ? [item.message.id] : []
    )
  );
  const toolIds = new Set(
    history.flatMap((item) => (item.kind === "tool-call" ? [item.call.id] : []))
  );
  let items = initialTranscript(history);
  for (const event of events) {
    if ("messageId" in event && messageIds.has(event.messageId)) continue;
    if ("message" in event && messageIds.has(event.message.id)) continue;
    if (
      (event.type === "tool-call" || event.type === "tool-result") &&
      toolIds.has(event.call.id)
    )
      continue;
    items = applySessionEvent(items, event);
  }
  return items;
}

/** 同一记录在实时事件、历史与 pending 快照之间幂等合并，终态不可回退。 */
export function mergeInteractions(
  items: UiItem[],
  records: InteractionRecord[]
): UiItem[] {
  let next = items;
  for (const interaction of records) {
    const index = next.findIndex(
      (item) =>
        item.kind === "interaction" && item.id === interaction.request.id
    );
    const previous = next[index];
    if (
      previous?.kind === "interaction" &&
      previous.interaction.status !== "pending"
    )
      continue;
    const item: UiInteraction = {
      kind: "interaction",
      id: interaction.request.id,
      interaction,
    };
    next =
      index === -1
        ? [...next, item]
        : next.map((existing, i) => (i === index ? item : existing));
  }
  return next;
}

/** 子代理开跑时间的记录基准（嵌套卡片「已用时」的计算起点） */
function nowIso(): string {
  return new Date().toISOString();
}
