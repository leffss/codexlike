import type {
  InteractionRecord,
  SessionEvent,
  StoredMessage,
  ToolCallRecord,
  TranscriptItem,
} from "@codexlike/agent-core";

/**
 * 时序消息段模型（GLOSSARY「消息段」「轮次」，ADR 0011）：
 * 会话视图状态是按事件发生顺序排列的扁平消息段序列——思考段、正文段、
 * 工具调用卡、子代理卡、错误段、状态段、compact 摘要段、用户消息段
 * 全部是序列中的平等成员，不按类型归类合并；时序交错在数据层保真，
 * 渲染层只按时序分派。
 *
 * 更新操作为封闭集：尾部追加、按 id 整段替换（状态迁移保持段 id 与序号）、
 * 截断删除（compact 等结构变化由 live-session 层整体重放 initialTranscript）、
 * 流式文本追加（只允许追加到序列末尾的流态段；被工具卡等隔断后新起段）。
 * 不引入字段级 patch。
 */

/** 消息段公共底座：稳定序号 + 轮次标签 + 共享响应 id 关联 */
interface SegmentBase {
  /** 段稳定 id（渲染 key；按 id 整段替换时不变） */
  id: string;
  /** 会话内单调稳定序号：仅随尾部追加递增，永不复用；整段替换保持原值 */
  seq: number;
  /** 轮次标签（触发本轮的用户消息 id）：段上的标签而非容器 */
  turnId: string;
  /** 共享响应 id：同一模型响应产生的思考/正文段共享此 id，关联不靠嵌套 */
  responseId: string | null;
  /**
   * 段建立时刻（epoch ms）：呈现层「已工作 N 秒」工时的数据来源。
   * 历史恢复取自落库 createdAt，运行期由 reducer 尾部追加时记录；
   * 整段替换保持原值（封闭集：时间不是更新维度）。
   */
  at?: number;
}

/** 用户消息段（GLOSSARY「轮次」的起点：每个用户段开启新轮次） */
export interface UserSegment extends SegmentBase {
  kind: "user";
  content: string;
}

/** 正文段：一轮回复内的一段 assistant 正文（被工具卡隔断的正文各自成段） */
export interface AssistantSegment extends SegmentBase {
  kind: "assistant";
  content: string;
  /** 流式进行中（流式文本只追加到末尾流态段） */
  streaming?: boolean;
  /** 该段被用户中断：content 为部分内容 */
  interrupted?: boolean;
}

/** 思考段（GLOSSARY「思考档位」）：与正文分离的模型思考过程，序列中的独立成员 */
export interface ThinkingSegment extends SegmentBase {
  kind: "thinking";
  content: string;
  streaming?: boolean;
}

/** 错误段：模型 API 出错等的中文提示（不进入对话上下文） */
export interface ErrorSegment extends SegmentBase {
  kind: "error";
  content: string;
}

/** 状态段：本地命令反馈（/status、/rename 结果等），只存在于渲染层 */
export interface StatusSegment extends SegmentBase {
  kind: "status";
  content: string;
}

/** compact 摘要段（GLOSSARY「Compact」）：被压缩历史展开后的摘要卡片 */
export interface CompactSummarySegment extends SegmentBase {
  kind: "compact-summary";
  content: string;
}

/** 工具调用卡段：tool-call 事件已到、tool-result 未到时显示运行中 */
export interface ToolCallSegment extends SegmentBase {
  kind: "tool-call";
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
  /** 执行开始时刻（epoch ms，运行期 tool-call 事件打点；历史恢复缺省） */
  startedAt?: number;
  /** 执行结束时刻（epoch ms，运行期 tool-result 事件打点；历史恢复缺省） */
  endedAt?: number;
}

/**
 * 子代理卡段（GLOSSARY「子代理」）：排队 → 运行（当前活动工具 + 已用时）→
 * 完成（报告可展开）。卡内嵌套的子代理工具进度与思考是卡片内部状态，
 * 不是主序列成员。
 */
export interface SubagentSegment extends SegmentBase {
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
   * 子代理思考过程（与报告文本分开累积）；运行期由 subagent-reasoning
   * 事件累积，重启后由落库 reasoning 列重建（票 02，旧记录自然缺失）
   */
  reasoning?: string;
  report: string | null;
  /** null = 未结束；false = 失败或被中断 */
  ok: boolean | null;
  /** 子代理内部的工具调用（卡内嵌套进度列表） */
  tools: SubagentToolCall[];
}

/** 子代理卡内嵌套的工具调用进度（无段字段：不是消息流序列成员） */
export interface SubagentToolCall {
  id: string;
  sessionId: string;
  toolName: string;
  arguments: string;
  output: string;
  isError: boolean;
  running?: boolean;
}

/** 交互记录段：只读回放；操作只存在于底部 InteractionPanel */
export interface InteractionSegment extends SegmentBase {
  kind: "interaction";
  interaction: InteractionRecord;
}

/** 消息段：消息流时序序列的最小呈现单元 */
export type MessageSegment =
  | UserSegment
  | AssistantSegment
  | ThinkingSegment
  | ErrorSegment
  | StatusSegment
  | CompactSummarySegment
  | ToolCallSegment
  | SubagentSegment
  | InteractionSegment;

/** 下一个稳定序号：基于现有最大序号递增 */
function nextSeq(items: MessageSegment[]): number {
  let max = 0;
  for (const item of items) if (item.seq > max) max = item.seq;
  return max + 1;
}

/**
 * 轮次标签推导：归入最后一个用户段所在轮；序列尚无用户段时以
 * fallback（响应 id / 消息 id / 调用 id）自成兜底轮。
 */
function deriveTurnId(items: MessageSegment[], fallback: string): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item !== undefined && item.kind === "user") return item.id;
  }
  return fallback;
}

/** 最近一个响应段的共享响应 id（工具卡段归属正在进行的响应） */
function lastResponseId(items: MessageSegment[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (
      item !== undefined &&
      (item.kind === "assistant" || item.kind === "thinking")
    )
      return item.responseId;
  }
  return null;
}

/** 流态段（思考/正文）：流式文本追加的唯一合法目标 */
function isStreamingSegment(
  item: MessageSegment
): item is AssistantSegment | ThinkingSegment {
  return (
    (item.kind === "assistant" || item.kind === "thinking") &&
    item.streaming === true
  );
}

/** 同一响应内第 n 个某类段的稳定 id */
function segmentId(
  prefix: "text" | "thinking",
  messageId: string,
  items: MessageSegment[]
): string {
  let count = 0;
  for (const item of items) {
    if (
      item.responseId === messageId &&
      item.kind === (prefix === "text" ? "assistant" : "thinking")
    )
      count += 1;
  }
  return `${prefix}-${messageId}-${count + 1}`;
}

/** 尾部追加（封闭集操作一） */
function append(
  items: MessageSegment[],
  segment: MessageSegment
): MessageSegment[] {
  return [...items, segment];
}

/** 按 id 整段替换（封闭集操作二）：保持段 id 与序号不变 */
function replaceSegment(
  items: MessageSegment[],
  id: string,
  update: (segment: MessageSegment) => MessageSegment
): MessageSegment[] {
  return items.map((item) => (item.id === id ? update(item) : item));
}

/**
 * 会话时间线（消息 + 工具调用 + 交互）→ 消息段时序序列。
 * 历史恢复与运行期流式输出共用同一形状：本函数产出的段序列与
 * applySessionEvent 归并出的段序列同类同构。
 */
export function initialTranscript(history: TranscriptItem[]): MessageSegment[] {
  const segments: MessageSegment[] = [];
  for (const item of history) {
    if (item.kind === "interaction") {
      segments.push({
        kind: "interaction",
        id: item.interaction.request.id,
        seq: nextSeq(segments),
        turnId: deriveTurnId(segments, item.interaction.request.id),
        responseId: null,
        at: parseIso(item.interaction.request.createdAt),
        interaction: item.interaction,
      });
      continue;
    }
    if (item.kind === "tool-call") {
      const call = item.call;
      if (call.toolName === "spawn_subagent") {
        segments.push(subagentFromToolRecord(call, segments));
        continue;
      }
      segments.push({
        kind: "tool-call",
        id: call.id,
        seq: nextSeq(segments),
        turnId: deriveTurnId(segments, call.id),
        responseId: null,
        at: parseIso(call.createdAt),
        sessionId: call.sessionId,
        toolName: call.toolName,
        arguments: call.arguments,
        output: call.output,
        isError: call.isError,
        running: false,
        // 恢复的记录只有单一时刻：无执行耗时（呈现层省略），at 即发生时刻
        startedAt: parseIso(call.createdAt),
      });
      continue;
    }
    const message = item.message;
    segments.push(...messageSegments(message, segments));
  }
  return segments;
}

/**
 * 单条持久化消息 → 对应类型的消息段（user 开新轮，assistant 以自身 id 关联响应）。
 * 带 reasoning 的 assistant 消息重建为思考段 + 正文段（票 02：落盘思考
 * 恢复为思考段，先于正文——与流式时序一致）；旧数据无思考值时只有正文段。
 */
function messageSegments(
  message: StoredMessage,
  segments: MessageSegment[]
): MessageSegment[] {
  const base = {
    id: message.id,
    seq: nextSeq(segments),
    // user 消息开启新轮次（轮次标签 = 自身 id）；其余消息归入当前轮
    turnId:
      message.role === "user" ? message.id : deriveTurnId(segments, message.id),
    // 历史 assistant 消息以自身 id 作为响应 id（思考/正文段关联键）
    responseId: message.role === "assistant" ? message.id : null,
    at: parseIso(message.createdAt),
  };
  switch (message.role) {
    case "user":
      return [{ ...base, kind: "user", content: message.content }];
    case "assistant": {
      const restored: MessageSegment[] = [];
      // 思考段（终态全文）：id 与流式 segmentId 同一命名惯例，恢复与流式同构
      if (message.reasoning !== undefined && message.reasoning !== "") {
        restored.push({
          kind: "thinking",
          id: `thinking-${message.id}-1`,
          seq: nextSeq(segments),
          turnId: base.turnId,
          responseId: message.id,
          // 段建立时刻（票 04）：与终态消息同一落库时刻
          at: base.at,
          content: message.reasoning,
        });
      }
      restored.push({
        ...base,
        seq: nextSeq([...segments, ...restored]),
        kind: "assistant",
        content: message.content,
        // 重启恢复：被中断的助手消息仍显示中断点标记
        interrupted: message.aborted === true || undefined,
      });
      return restored;
    }
    case "error":
      return [{ ...base, kind: "error", content: message.content }];
    case "compact-summary":
      return [{ ...base, kind: "compact-summary", content: message.content }];
  }
}

/** 重启恢复：spawn_subagent 的落库记录 → 完成态子代理段（task 从参数解析、报告即 output） */
function subagentFromToolRecord(
  call: ToolCallRecord,
  segments: MessageSegment[]
): SubagentSegment {
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
    seq: nextSeq(segments),
    turnId: deriveTurnId(segments, call.id),
    responseId: null,
    at: parseIso(call.createdAt),
    toolCallId: call.id,
    task,
    state: "done",
    startedAt: null,
    // 落盘思考重建卡内思考折叠块（票 02）；旧记录自然缺失（undefined）
    ...(call.reasoning ? { reasoning: call.reasoning } : {}),
    report: call.output,
    ok: !call.isError,
    tools: [],
  };
}

/**
 * 流式事件 → 消息段序列增量更新（纯函数，React state 的归并核心）。
 * 调用方按 sessionId 隔离事件；切会话可能错过 assistant-start，
 * delta / reasoning / done 自行兜底建段。
 */
export function applySessionEvent(
  items: MessageSegment[],
  event: SessionEvent
): MessageSegment[] {
  switch (event.type) {
    case "user-message":
      if (items.some((item) => item.id === event.message.id)) return items;
      return append(items, {
        kind: "user",
        id: event.message.id,
        seq: nextSeq(items),
        turnId: event.message.id,
        responseId: null,
        at: nowEpoch(),
        content: event.message.content,
      });

    case "session-auto-approve-changed":
      // 授权状态由会话控制区展示，不生成历史消息段。
      return items;

    case "assistant-start":
      // 段由首个 delta / reasoning / 终态事件惰性建立：start 只是响应开始的标记
      return items;

    case "assistant-delta":
    case "assistant-reasoning": {
      const isText = event.type === "assistant-delta";
      const messageId = event.messageId;
      const delta = event.delta;
      const last = items[items.length - 1];
      // 流式文本追加（封闭集操作四）：只追加到末尾的流态段；
      // 任何隔断（工具卡、终态、其他响应的段）之后新起段，时序保真
      if (
        last !== undefined &&
        isStreamingSegment(last) &&
        last.responseId === messageId &&
        last.kind === (isText ? "assistant" : "thinking")
      ) {
        return [
          ...items.slice(0, -1),
          { ...last, content: last.content + delta },
        ];
      }
      return append(items, {
        kind: isText ? "assistant" : "thinking",
        id: segmentId(isText ? "text" : "thinking", messageId, items),
        seq: nextSeq(items),
        turnId: deriveTurnId(items, messageId),
        responseId: messageId,
        at: nowEpoch(),
        content: delta,
        streaming: true,
      });
    }

    case "assistant-done":
      return finalizeResponse(items, event.message, false);

    case "assistant-aborted":
      return finalizeResponse(items, event.message, true);

    case "tool-call":
      // spawn_subagent 由子代理段呈现（subagent-queued/start 事件建卡），不出普通工具卡
      if (event.call.toolName === "spawn_subagent") {
        return items;
      }
      if (
        items.some(
          (item) => item.kind === "tool-call" && item.id === event.call.id
        )
      )
        return items;
      return append(items, {
        kind: "tool-call",
        id: event.call.id,
        seq: nextSeq(items),
        turnId: deriveTurnId(items, event.call.id),
        responseId: lastResponseId(items),
        at: nowEpoch(),
        sessionId: event.call.sessionId,
        toolName: event.call.toolName,
        arguments: event.call.arguments,
        output: "",
        isError: false,
        running: true,
        startedAt: nowEpoch(),
      });

    case "tool-result":
      // spawn_subagent 的报告回填对应子代理段（按 toolCallId 匹配）
      if (event.call.toolName === "spawn_subagent") {
        if (
          !items.some(
            (item) =>
              item.kind === "subagent" && item.toolCallId === event.call.id
          )
        )
          return append(items, subagentFromToolRecord(event.call, items));
        return items.map((item) =>
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
      if (
        !items.some(
          (item) => item.kind === "tool-call" && item.id === event.call.id
        )
      ) {
        // 当前执行错过 tool-call（切会话后迟到）：由 tool-result 补齐终态卡
        // （开始时刻未观察，耗时不可知，仅记录结束时刻）
        return append(items, {
          kind: "tool-call",
          id: event.call.id,
          seq: nextSeq(items),
          turnId: deriveTurnId(items, event.call.id),
          responseId: lastResponseId(items),
          at: nowEpoch(),
          sessionId: event.call.sessionId,
          toolName: event.call.toolName,
          arguments: event.call.arguments,
          output: event.call.output,
          isError: event.call.isError,
          running: false,
          endedAt: nowEpoch(),
        });
      }
      return replaceSegment(items, event.call.id, (item) =>
        item.kind === "tool-call"
          ? {
              ...item,
              output: event.call.output,
              isError: event.call.isError,
              running: false,
              endedAt: nowEpoch(),
            }
          : item
      );

    case "subagent-queued":
      if (
        items.some(
          (item) => item.kind === "subagent" && item.id === event.subagentId
        )
      )
        return items;
      return append(items, {
        kind: "subagent",
        id: event.subagentId,
        seq: nextSeq(items),
        turnId: deriveTurnId(items, event.subagentId),
        responseId: null,
        at: nowEpoch(),
        toolCallId: "",
        task: event.task,
        state: "queued",
        startedAt: null,
        report: null,
        ok: null,
        tools: [],
      });

    case "subagent-start": {
      const seeded = items.some(
        (item) => item.kind === "subagent" && item.id === event.subagentId
      )
        ? items
        : applySessionEvent(items, {
            type: "subagent-queued",
            subagentId: event.subagentId,
            task: event.task,
          });
      return replaceSegment(seeded, event.subagentId, (item) =>
        item.kind === "subagent" && item.state !== "done"
          ? {
              ...item,
              state: "running" as const,
              toolCallId: event.toolCallId,
              startedAt: nowIso(),
            }
          : item
      );
    }

    case "subagent-tool":
      return replaceSegment(items, event.subagentId, (item) =>
        item.kind === "subagent"
          ? {
              ...item,
              tools: applySubagentTool(
                item.tools,
                event.call,
                event.phase === "call"
              ),
            }
          : item
      );

    case "subagent-reasoning":
      // 子代理思考：与报告分离累积到所属卡片；未知 subagentId（会话切换后迟到）忽略
      return replaceSegment(items, event.subagentId, (item) =>
        item.kind === "subagent"
          ? { ...item, reasoning: (item.reasoning ?? "") + event.delta }
          : item
      );

    case "subagent-report":
      return replaceSegment(items, event.subagentId, (item) =>
        item.kind === "subagent"
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
      return mergeInteractions(items, [event.interaction]);

    // 旧事件只作兼容，不再创建第二套可操作审批卡片。
    case "approval-request":
    case "approval-resolved":
      return items;

    case "error":
      // 出错即本轮终止：全部流态段收敛，尾部追加错误段
      return append(
        items.map((item) =>
          isStreamingSegment(item) ? { ...item, streaming: undefined } : item
        ),
        {
          kind: "error",
          id: event.message.id,
          seq: nextSeq(items),
          turnId: deriveTurnId(items, event.message.id),
          responseId: null,
          at: nowEpoch(),
          content: event.message.content,
        }
      );
  }
}

/** 响应终态收敛（done / aborted）：流态去除、中断标记、终稿纠错、无正文段兜底 */
function finalizeResponse(
  items: MessageSegment[],
  message: StoredMessage,
  interrupted: boolean
): MessageSegment[] {
  // 该响应的全部流态段（思考/正文）收敛：不残留进行中状态
  let next = items.map((item): MessageSegment => {
    if (isStreamingSegment(item) && item.responseId === message.id) {
      return { ...item, streaming: undefined };
    }
    return item;
  });
  const hasTextSegments = next.some(
    (item) => item.kind === "assistant" && item.responseId === message.id
  );
  if (!hasTextSegments) {
    // 响应无任何正文段（错过全部增量 / 只有思考）：终态消息落为终态正文段
    return append(next, {
      kind: "assistant",
      id: `text-${message.id}-1`,
      seq: nextSeq(next),
      turnId: deriveTurnId(next, message.id),
      responseId: message.id,
      at: parseIso(message.createdAt),
      content: message.content,
      interrupted: interrupted || undefined,
    });
  }
  if (interrupted) {
    // 中断点标记跟在最后一段正文上
    for (let i = next.length - 1; i >= 0; i--) {
      const item = next[i];
      if (
        item !== undefined &&
        item.kind === "assistant" &&
        item.responseId === message.id
      ) {
        next = next.map((candidate, index) =>
          index === i ? { ...item, interrupted: true } : candidate
        );
        break;
      }
    }
  }
  // 单正文段（未被工具卡隔断）以终稿全文整段替换，防增量缺失；
  // 多段切分保持原内容（delta 累积已完整），不做破坏时序的合并
  const textSegments = next.filter(
    (item): item is AssistantSegment =>
      item.kind === "assistant" && item.responseId === message.id
  );
  const single = textSegments.length === 1 ? textSegments[0] : undefined;
  if (single !== undefined && single.content !== message.content) {
    next = next.map((item) =>
      item === single ? { ...item, content: message.content } : item
    );
  }
  return next;
}

/** 子代理卡内嵌套的工具进度归并（call → 运行中，result → 终态） */
function applySubagentTool(
  tools: SubagentToolCall[],
  call: ToolCallRecord,
  isCall: boolean
): SubagentToolCall[] {
  if (isCall) {
    if (tools.some((tool) => tool.id === call.id)) return tools;
    return [
      ...tools,
      {
        id: call.id,
        sessionId: call.sessionId,
        toolName: call.toolName,
        arguments: call.arguments,
        output: "",
        isError: false,
        running: true,
      },
    ];
  }
  if (!tools.some((tool) => tool.id === call.id)) {
    return [
      ...tools,
      {
        id: call.id,
        sessionId: call.sessionId,
        toolName: call.toolName,
        arguments: call.arguments,
        output: call.output,
        isError: call.isError,
        running: false,
      },
    ];
  }
  return tools.map((tool) =>
    tool.id === call.id
      ? { ...tool, output: call.output, isError: call.isError, running: false }
      : tool
  );
}

/** 渲染层本地段（status / error）：不入事件流，尾部追加并归当前轮 */
export function appendLocalSegment(
  items: MessageSegment[],
  message: { kind: "status" | "error"; content: string }
): MessageSegment[] {
  const at = nowEpoch();
  const id = `local-${at}-${Math.random().toString(36).slice(2, 8)}`;
  return append(items, {
    kind: message.kind,
    id,
    seq: nextSeq(items),
    turnId: deriveTurnId(items, id),
    responseId: null,
    at,
    content: message.content,
  });
}

/** 同一交互记录在实时事件、历史与 pending 快照之间幂等合并，终态不可回退。 */
export function mergeInteractions(
  items: MessageSegment[],
  records: InteractionRecord[]
): MessageSegment[] {
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
    const item: InteractionSegment = {
      kind: "interaction",
      id: interaction.request.id,
      seq: previous !== undefined ? previous.seq : nextSeq(next),
      turnId:
        previous !== undefined
          ? previous.turnId
          : deriveTurnId(next, interaction.request.id),
      responseId: null,
      at: previous?.at ?? parseIso(interaction.request.createdAt) ?? undefined,
      interaction,
    };
    next =
      index === -1
        ? [...next, item]
        : next.map((existing, i) => (i === index ? item : existing));
  }
  return next;
}

/** 子代理开跑时间的记录基准（卡内「已用时」的计算起点） */
function nowIso(): string {
  return new Date().toISOString();
}

/** 运行期尾部追加的打点基准（epoch ms；呈现层工时计算用） */
function nowEpoch(): number {
  return Date.now();
}

/** ISO 8601 → epoch ms；非法/缺失返回 undefined（段自然缺时间数据） */
function parseIso(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}
