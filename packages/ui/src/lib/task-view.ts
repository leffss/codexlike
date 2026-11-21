import type {
  InteractionRecord,
  SubagentSnapshot,
  TaskEvent,
  StoredMessage,
  ToolCallRecord,
  TranscriptItem,
} from "@codexlike/agent-core";

import { subagentSegmentState } from "./subagent-status";

/**
 * 时序消息段模型（GLOSSARY「消息段」「轮次」，ADR 0011）：
 * 任务视图状态是按事件发生顺序排列的扁平消息段序列——思考段、正文段、
 * 工具调用卡、子代理卡、错误段、状态段、compact 摘要段、用户消息段
 * 全部是序列中的平等成员，不按类型归类合并；时序交错在数据层保真，
 * 渲染层只按时序分派。
 *
 * 更新操作为封闭集：尾部追加、按 id 整段替换（状态迁移保持段 id 与序号）、
 * 截断删除（compact 等结构变化由 live-task 层整体重放 initialTranscript）、
 * 流式文本追加（只允许追加到序列末尾的流态段；被工具卡等隔断后新起段）。
 * 不引入字段级 patch。
 */

/** 消息段公共底座：稳定序号 + 轮次标签 + 共享响应 id 关联 */
interface SegmentBase {
  /** 段稳定 id（渲染 key；按 id 整段替换时不变） */
  id: string;
  /** 任务内单调稳定序号：仅随尾部追加递增，永不复用；整段替换保持原值 */
  seq: number;
  /** 轮次标签（触发本轮的用户消息 id）：段上的标签而非容器 */
  turnId: string;
  /** 共享响应 id：同一模型响应产生的思考/正文段共享此 id，关联不靠嵌套 */
  responseId: string | null;
  /**
   * 段建立时刻（epoch ms）：呈现层各段卡耗时（活动段实时跳动、完成定格）
   * 的数据来源。历史恢复取自落库 createdAt，运行期由 reducer 尾部追加时
   * 记录；整段替换保持原值（封闭集：时间不是更新维度）。
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
  /** 流态收敛时刻（epoch ms）：被隔断新起段/终态/错误收敛时打点；段耗时 = endedAt - at */
  endedAt?: number;
  /** 正常终态消息的完成时刻（epoch ms），独立于段建立时刻 at。 */
  completedAt?: number;
  /** 该段被用户中断：content 为部分内容 */
  interrupted?: boolean;
}

/** 思考段（GLOSSARY「思考档位」）：与正文分离的模型思考过程，序列中的独立成员 */
export interface ThinkingSegment extends SegmentBase {
  kind: "thinking";
  content: string;
  streaming?: boolean;
  /** 流态收敛时刻（epoch ms）：思考结束（切换正文/终态/错误）时打点；缺省则无耗时 */
  endedAt?: number;
}

/** 错误段：模型 API 出错等的中文提示（不进入对话上下文） */
export interface ErrorSegment extends SegmentBase {
  kind: "error";
  content: string;
}

/** /status 报告段（ADR 0031）：多行状态报告驻留消息流、可逐条关闭 */
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
  /** 所属任务（截图卡片按任务+调用 id 向主进程请求图片数据） */
  taskId: string;
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
 * 完成（报告可展开）｜运行中被中断（重启收尾补记的终态，ADR 0021）。
 * 卡内嵌套的子代理工具进度与思考是卡片内部状态，不是主序列成员。
 */
export interface SubagentSegment extends SegmentBase {
  kind: "subagent";
  /** 子代理 id（编排器生成，进度事件匹配键；恢复新路径 = 骨架行 id） */
  id: string;
  /** 主任务 spawn_subagent 的 tool call id（报告回流匹配；queued 阶段尚未知为空串） */
  toolCallId: string;
  /** 委派任务描述 */
  task: string;
  state: "queued" | "running" | "done" | "interrupted";
  /** 开始运行时间（ISO；已用时的计算基准） */
  startedAt: string | null;
  /** 结束时间（ISO；完成态总耗时定格的计算基准，运行期为 null） */
  endedAt: string | null;
  /**
   * 子代理思考跨轮全文（票 02）：运行期由 subagent-reasoning 事件累积，
   * 旧记录恢复时由落库 reasoning 列重建（无轮边界）；分轮呈现见 turns
   */
  reasoning?: string;
  /**
   * 逐轮正文与思考（ADR 0021 票 04）：一轮 = 一次流式生成（思考先于正文，
   * 轮边界即 subagent_messages 行边界）；运行期由 subagent-reasoning /
   * subagent-text-delta 逐轮累积（工具事件后新起轮），恢复新路径由快照
   * messages 逐行重建；旧记录（无快照）自然缺失 undefined
   */
  turns?: SubagentTurn[];
  report: string | null;
  /** null = 未结束；false = 失败或被中断 */
  ok: boolean | null;
  /** 子代理内部的工具调用（卡内嵌套进度列表） */
  tools: SubagentToolCall[];
}

/** 子代理一个模型轮（GLOSSARY「轮次」）：思考 + 正文（各自可缺） */
export interface SubagentTurn {
  /** 本轮思考；本轮无思考时缺失 */
  reasoning?: string;
  /** 本轮正文；纯工具轮无正文 */
  content: string;
}

/** 子代理卡内嵌套的工具调用进度（无段字段：不是消息流序列成员） */
export interface SubagentToolCall {
  id: string;
  taskId: string;
  toolName: string;
  arguments: string;
  output: string;
  isError: boolean;
  running?: boolean;
  /** 执行开始时刻（epoch ms，call 事件打点；列表行耗时的起点） */
  startedAt?: number;
  /** 执行结束时刻（epoch ms，result 事件打点；缺省则行不显示耗时） */
  endedAt?: number;
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

/**
 * 收敛全部流态段（streaming 去除）并打 endedAt（段耗时数据来源）。
 * 新流态段建立（思考→正文切换、工具卡隔断后再起正文）与终态/错误
 * 收敛共用：任一时刻至多一个流态段，被隔断的旧段不再显示流式指示。
 */
function settleStreamingSegments(
  items: MessageSegment[],
  endedAt: number
): MessageSegment[] {
  return items.map((item) =>
    isStreamingSegment(item) ? { ...item, streaming: undefined, endedAt } : item
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
 * 任务时间线（消息 + 工具调用 + 交互）→ 消息段时序序列。
 * 历史恢复与运行期流式输出共用同一形状：本函数产出的段序列与
 * applyTaskEvent 归并出的段序列同类同构。
 *
 * 恢复新路径（ADR 0021 票 04）：载荷带并行子代理快照时，spawn_subagent
 * 行按委派说明匹配快照（task 参数原文 == 骨架行 task），命中即由快照
 * 重建完整过程（骨架状态与起止时间 + 逐轮正文与思考 + 工具清单），
 * 报告与 ok 仍取自行本身（行 output 含截断标记等终稿口径）；未命中的
 * 行回退 subagentFromToolRecord 旧路径（旧任务照旧）。
 *
 * 匹配键为何是委派说明文本而非 id（review 显式化的顺序对齐假设）：
 * 数据模型两侧无共享 id 可桥——spawn 行（tool_calls）与骨架行（subagents）
 * 互不持有对方 id，快照亦不带 toolCallId；桥接须给 subagents 表加列并做
 * 旧库迁移，与 ADR 0021「建表即兼容、无数据迁移」冲突。文本匹配在
 * 同文本多委派场景下靠顺序对齐保证正确，且该顺序有结构性保证：
 * 行侧 listToolCalls 按（created_at=委派时刻, rowid=回填插入序）排序，
 * 轮末回填（agent-task deferredDelegations）按派发序落库；快照侧
 * listSubagents 按（queued_at=入队时刻, rowid）排序——两序同源（同一
 * 任务时钟、同一执行序），findIndex 取首个文本匹配即按序配对。
 * 守护测试见 tests/subagent-view.test.ts「同文本多委派」。
 *
 * 无 spawn 行的快照（运行中被杀 / 排队中被杀：行随轮末回填、进程死亡
 * 未落）按委派时点（queuedAt）插入时间线的正确位置留痕——排队被杀的
 * 委派回到委派时点附近，而非堆积在末尾。
 */
export function initialTranscript(
  history: TranscriptItem[],
  subagents: SubagentSnapshot[] = []
): MessageSegment[] {
  const segments: MessageSegment[] = [];
  // 待匹配快照（匹配即消费）：骨架按排队时间正序，行按 transcript 序出现
  const pending = subagents.slice();
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
        const task = subagentTaskOf(call);
        // 顺序对齐假设（见函数注释）：同文本时 findIndex 首个匹配 = 按委派序配对
        const matched = pending.findIndex(
          (entry) => entry.record.task === task
        );
        if (matched >= 0) {
          const [entry] = pending.splice(matched, 1);
          segments.push(subagentFromSnapshot(entry!, call, segments));
        } else {
          segments.push(subagentFromToolRecord(call, segments));
        }
        continue;
      }
      segments.push({
        kind: "tool-call",
        id: call.id,
        seq: nextSeq(segments),
        turnId: deriveTurnId(segments, call.id),
        responseId: null,
        at: parseIso(call.createdAt),
        taskId: call.taskId,
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
  // 无 spawn 行的快照（运行中被杀 / 排队中被杀）：按委派时点插入正确位置
  // （pending 已按 queuedAt 正序，逐个插入自然保序）；queuedAt 缺失或晚于
  // 全部已落库条目时落末尾。段 seq 仍取全局递增（永不复用），只有数组
  // 位置反映时序；turnId 以插入点之前的段推导（归入委派发生时的轮）。
  for (const entry of pending) {
    const at = parseIso(entry.record.queuedAt);
    let index = segments.length;
    if (at !== undefined) {
      // 从尾向前找第一个不晚于委派时点的段，插到它后面（同时刻稳定居后）
      while (index > 0) {
        const prev = segments[index - 1]!;
        if (prev.at === undefined || prev.at <= at) break;
        index -= 1;
      }
    }
    segments.splice(
      index,
      0,
      subagentFromSnapshot(entry, null, segments, segments.slice(0, index))
    );
  }
  return segments;
}

/** spawn 行参数里的委派说明（task 原文）；解析失败返回空串（不匹配任何快照） */
function subagentTaskOf(call: ToolCallRecord): string {
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    if (typeof parsed === "object" && parsed !== null && "task" in parsed) {
      const value = (parsed as { task?: unknown }).task;
      if (typeof value === "string") return value;
    }
  } catch {
    // 参数非 JSON（旧数据防御）：按空委派说明处理
  }
  return "";
}

/**
 * 恢复新路径（ADR 0021 票 04）：子代理快照 → 子代理段。
 * call 为匹配到的 spawn 行（报告 / ok / 段时序位置与 toolCallId 来源）；
 * 无行的快照（call=null，运行中/排队中被杀）：报告为空、按委派时点插回
 * 时间线（见 initialTranscript 尾部插入）。
 * segments 为 seq 与兜底轮的推导基准；turnScope 为 turnId 推导基准
 * （无行快照插回中段时 = 插入点之前缀，缺省同 segments）。
 */
function subagentFromSnapshot(
  entry: SubagentSnapshot,
  call: ToolCallRecord | null,
  segments: MessageSegment[],
  turnScope: MessageSegment[] = segments
): SubagentSegment {
  const { record } = entry;
  return {
    kind: "subagent",
    id: record.id,
    seq: nextSeq(segments),
    turnId: deriveTurnId(turnScope, record.id),
    responseId: null,
    at: parseIso(record.queuedAt),
    toolCallId: call?.id ?? "",
    task: record.task,
    // 骨架 status → 段 state 的唯一映射在 lib/subagent-status（单一来源）
    state: subagentSegmentState(record.status),
    startedAt: record.startedAt,
    endedAt: record.completedAt,
    // 逐轮重建（轮边界即行边界）；空行不落库，这里不产生空轮
    turns: entry.messages.map((row) => ({
      ...(row.reasoning ? { reasoning: row.reasoning } : {}),
      content: row.content,
    })),
    report: call?.output ?? null,
    ok: call !== null ? !call.isError : false,
    tools: entry.toolCalls.map((row) => ({
      id: row.id,
      taskId: row.taskId,
      toolName: row.toolName,
      arguments: row.arguments,
      output: row.output,
      isError: row.isError,
      running: false,
      // 行内只有完成时刻单一时间戳（发起时刻即落库时刻）：不显示行耗时
      startedAt: parseIso(row.createdAt),
    })),
  };
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
        // 完成时间沿用终态落库时刻，不取打开历史的当前时间。
        completedAt: message.aborted === true ? undefined : base.at,
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

/** 重启恢复（旧路径）：spawn_subagent 的落库记录 → 完成态子代理段（task 从参数解析、报告即 output） */
function subagentFromToolRecord(
  call: ToolCallRecord,
  segments: MessageSegment[]
): SubagentSegment {
  return {
    kind: "subagent",
    id: `restore-${call.id}`,
    seq: nextSeq(segments),
    turnId: deriveTurnId(segments, call.id),
    responseId: null,
    at: parseIso(call.createdAt),
    toolCallId: call.id,
    task: subagentTaskOf(call),
    state: "done",
    startedAt: null,
    // 恢复的记录无起止时间对：完成态不显示总耗时
    endedAt: null,
    // 落盘思考重建卡内思考折叠块（票 02）；旧记录自然缺失（undefined）
    ...(call.reasoning ? { reasoning: call.reasoning } : {}),
    report: call.output,
    ok: !call.isError,
    tools: [],
  };
}

/**
 * 流式事件 → 消息段序列增量更新（纯函数，React state 的归并核心）。
 * 调用方按 taskId 隔离事件；切任务可能错过 assistant-start，
 * delta / reasoning / done 自行兜底建段。
 */
export function applyTaskEvent(
  items: MessageSegment[],
  event: TaskEvent
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

    case "task-auto-approve-changed":
      // 授权状态由任务控制区展示，不生成历史消息段。
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
      // 新起段前收敛既有流态段：隔断即终结（思考→正文切换、工具卡隔断），
      // 旧段不再残留 streaming（否则每段各渲染一个流式指示，出现多个转圈）
      return append(settleStreamingSegments(items, nowEpoch()), {
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
      return finalizeResponse(
        items,
        event.message,
        event.message.aborted === true
      );

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
        taskId: event.call.taskId,
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
                endedAt: nowIso(),
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
        // 当前执行错过 tool-call（切任务后迟到）：由 tool-result 补齐终态卡
        // （开始时刻未观察，耗时不可知，仅记录结束时刻）
        return append(items, {
          kind: "tool-call",
          id: event.call.id,
          seq: nextSeq(items),
          turnId: deriveTurnId(items, event.call.id),
          responseId: lastResponseId(items),
          at: nowEpoch(),
          taskId: event.call.taskId,
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
        endedAt: null,
        turns: [],
        report: null,
        ok: null,
        tools: [],
      });

    case "subagent-start": {
      const seeded = items.some(
        (item) => item.kind === "subagent" && item.id === event.subagentId
      )
        ? items
        : applyTaskEvent(items, {
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
              // 工具后正文/思考属下一轮：预置空轮占位（轮边界与落库行同构）
              turns: subagentTurnBoundary(item.turns ?? []),
            }
          : item
      );

    case "subagent-reasoning":
    case "subagent-text-delta": {
      // 子代理思考/正文增量（ADR 0021）：逐轮累积到所属卡片（未知
      // subagentId——任务切换后迟到——忽略）；思考另累积跨轮全文
      // （reasoning 字段，旧记录恢复同构），分轮呈现读 turns；
      // 轮次按事件显式轮键（roundIndex，子代理循环同源计数）归并
      const isText = event.type === "subagent-text-delta";
      return replaceSegment(items, event.subagentId, (item) =>
        item.kind === "subagent"
          ? {
              ...item,
              turns: appendSubagentTurnDelta(
                item.turns ?? [],
                isText,
                event.delta,
                event.roundIndex
              ),
              ...(isText
                ? {}
                : { reasoning: (item.reasoning ?? "") + event.delta }),
            }
          : item
      );
    }

    case "subagent-report":
      return replaceSegment(items, event.subagentId, (item) =>
        item.kind === "subagent"
          ? {
              ...item,
              state: "done" as const,
              endedAt: nowIso(),
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

    // 终端会话生命周期（ADR 0033，03 票并入通道）：渲染端消费（消息流
    // 工具卡与 rail 终端 tab 归并）是 04 票——本票事件先不产生消息段。
    case "terminal-started":
    case "terminal-exited":
      return items;

    case "error":
      // 出错即本轮终止：全部流态段收敛（打 endedAt），尾部追加错误段
      return append(settleStreamingSegments(items, nowEpoch()), {
        kind: "error",
        id: event.message.id,
        seq: nextSeq(items),
        turnId: deriveTurnId(items, event.message.id),
        responseId: null,
        at: nowEpoch(),
        content: event.message.content,
      });
  }
}

/** 响应终态收敛（done / aborted）：流态去除、中断标记、终稿纠错、无正文段兜底 */
function finalizeResponse(
  items: MessageSegment[],
  message: StoredMessage,
  interrupted: boolean
): MessageSegment[] {
  // 全部流态段（思考/正文）收敛：不残留进行中状态（单任务单流，
  // 与 error 分支同策略）；收敛时刻取终态消息落库时刻（真实完成点，
  // 段耗时以此定格）
  let next = settleStreamingSegments(
    items,
    parseIso(message.createdAt) ?? nowEpoch()
  );
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
      completedAt: interrupted ? undefined : parseIso(message.createdAt),
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
  const lastText = textSegments[textSegments.length - 1];
  if (!interrupted && lastText !== undefined) {
    next = replaceSegment(next, lastText.id, (item) => ({
      ...item,
      completedAt: parseIso(message.createdAt),
    }));
  }
  return next;
}

/**
 * 子代理轮增量归并：一轮 = 一次流式生成（与 agent-core 子代理循环
 * flushRound 的行边界同构——那边改轮边界须同步核对这里）。
 *
 * 轮次判定优先读显式轮键 roundIndex（事件携带，与落库 round 计数同源，
 * review 修复消灭双写启发式）：目标轮不足则以空轮补齐（与
 * subagentTurnBoundary 的工具占位轮同构），增量落入对应轮。
 * 键缺失（构造点未升级的旧事件 / fixtures）回退增量启发式：思考先于
 * 正文，正文已出现后的思考增量属新轮；工具事件由 subagentTurnBoundary
 * 预置空轮占位，正文增量追加到当前轮（流内正文连续），思考增量在
 * 无正文的当前轮累积。两条路径产出的轮结构同构（守护测试见
 * tests/subagent-view.test.ts「显式轮键」）。
 */
function appendSubagentTurnDelta(
  turns: SubagentTurn[],
  isText: boolean,
  delta: string,
  roundIndex?: number
): SubagentTurn[] {
  if (roundIndex !== undefined) {
    if (!Number.isInteger(roundIndex) || roundIndex < 0) {
      // 非法轮键（防御）：按缺失回退启发式，不产生稀疏数组
      return appendSubagentTurnDelta(turns, isText, delta);
    }
    let next = turns;
    while (next.length <= roundIndex) {
      next = [...next, { content: "" }];
    }
    const target = next[roundIndex]!;
    return [
      ...next.slice(0, roundIndex),
      isText
        ? { ...target, content: target.content + delta }
        : {
            ...target,
            reasoning: (target.reasoning ?? "") + delta,
          },
      ...next.slice(roundIndex + 1),
    ];
  }
  const last = turns[turns.length - 1];
  if (last === undefined) {
    return [isText ? { content: delta } : { content: "", reasoning: delta }];
  }
  if (isText) {
    return [...turns.slice(0, -1), { ...last, content: last.content + delta }];
  }
  // 思考在正文之后出现 = 新一轮开始（轮内思考恒先于正文）
  if (last.content !== "") {
    return [...turns, { content: "", reasoning: delta }];
  }
  return [
    ...turns.slice(0, -1),
    { ...last, reasoning: (last.reasoning ?? "") + delta },
  ];
}

/** 工具事件后的轮边界：当前轮已有内容则预置空轮（承接下一轮增量） */
function subagentTurnBoundary(turns: SubagentTurn[]): SubagentTurn[] {
  const last = turns[turns.length - 1];
  if (last === undefined || (last.content === "" && !last.reasoning)) {
    return turns;
  }
  return [...turns, { content: "" }];
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
        taskId: call.taskId,
        toolName: call.toolName,
        arguments: call.arguments,
        output: "",
        isError: false,
        running: true,
        startedAt: nowEpoch(),
      },
    ];
  }
  if (!tools.some((tool) => tool.id === call.id)) {
    return [
      ...tools,
      {
        id: call.id,
        taskId: call.taskId,
        toolName: call.toolName,
        arguments: call.arguments,
        output: call.output,
        isError: call.isError,
        running: false,
        endedAt: nowEpoch(),
      },
    ];
  }
  return tools.map((tool) =>
    tool.id === call.id
      ? {
          ...tool,
          output: call.output,
          isError: call.isError,
          running: false,
          endedAt: nowEpoch(),
        }
      : tool
  );
}

/**
 * compact 整体重放后的子代理富段回接（ADR 0021：子代理记录与 compact
 * 无关）。compact 事件只携带替换后的 history（spawn 行按旧路径重建为
 * 过程空段），这里按 toolCallId 把 compact 前的过程富数据（轮次/工具/
 * 起止时间/中断态）接回重建段。未匹配记录仍保留，按旧时间线的后继锚点
 * 插回，不能直接堆到最新轮之后（否则 lastTurnRunning 会指向旧轮）。
 * 不恢复被裁正文/用户消息，不引入并行 store；骨架 id 保持选中与开合身份。
 */
export function mergeSubagentsAfterCompact(
  rebuilt: MessageSegment[],
  previous: MessageSegment[]
): MessageSegment[] {
  const rich = previous.filter(
    (item): item is SubagentSegment => item.kind === "subagent"
  );
  const byId = new Map(rich.map((item) => [item.id, item]));
  const byCall = new Map(
    rich
      .filter((item) => item.toolCallId !== "")
      .map((item) => [item.toolCallId, item])
  );
  const retained = new Set<string>();
  const next = rebuilt.map((item) => {
    if (item.kind !== "subagent") return item;
    const before = byId.get(item.id) ?? byCall.get(item.toolCallId);
    if (before === undefined) return item;
    retained.add(before.id);
    return { ...before, seq: item.seq, turnId: item.turnId };
  });
  for (let position = 0; position < previous.length; position += 1) {
    const before = previous[position]!;
    if (before.kind !== "subagent" || retained.has(before.id)) continue;
    retained.add(before.id);
    // 以仍存活的后继段作锚点；正文的流态段 id 与恢复 id 可不同，responseId 同源。
    let index = -1;
    for (const following of previous.slice(position + 1)) {
      index = next.findIndex(
        (item) =>
          item.id === following.id ||
          (following.kind === "assistant" &&
            item.kind === "assistant" &&
            following.responseId !== null &&
            following.responseId === item.responseId)
      );
      if (index >= 0) break;
    }
    if (index < 0) {
      // 无后继锚点时按发生时刻找下一轮；compact 摘要生成于现在，不是时间锚点。
      index = next.findIndex(
        (item) =>
          item.kind !== "compact-summary" &&
          before.at !== undefined &&
          item.at !== undefined &&
          item.at > before.at
      );
    }
    if (index < 0) index = next.length;
    const anchor = next[index];
    // 被裁旧轮只能在后继整轮之前，不能把后继 user 与正文拆开成同名两轮。
    if (anchor !== undefined && anchor.turnId !== before.turnId) {
      while (index > 0 && next[index - 1]?.turnId === anchor.turnId) index -= 1;
    }
    next.splice(index, 0, { ...before, seq: nextSeq(next) });
  }
  return next;
}

/** 渲染层本地段（/status 报告 status / 错误 error）：不入事件流，
 *  尾部追加并归当前轮（其余本地命令反馈走右下角 toast，ADR 0030/0031） */
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
