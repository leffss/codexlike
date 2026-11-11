import { randomUUID } from "node:crypto";

import {
  generateText,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolModelMessage,
  type ToolResultPart,
} from "ai";

import {
  createLanguageModelFromProfile,
  THINKING_EFFORTS,
  type CreateLanguageModelOptions,
  type ThinkingEffort,
} from "../provider/language-model";
import type { ProviderProfile } from "../provider/provider-profile";
import { runTool, toModelTools } from "../tools/registry";
import type {
  ToolCallRecord,
  ToolDefinition,
  ToolResult,
} from "../tools/types";

import {
  decideApproval,
  type ApprovalDecision,
  type ApprovalMode,
  type ApprovalRequest,
} from "./approval";
import { describeModelError, isAbortLike } from "./errors";
import type { SessionPersistence } from "./persistence";
import {
  createSubagentOrchestrator,
  SUBAGENT_TOOL_NAME,
  type SubagentOrchestrator,
  type SubagentsConfig,
} from "./subagent";
import type {
  CompactRecord,
  CompactResult,
  MentionAttachment,
  SessionEvent,
  SessionRecord,
  StoredMessage,
} from "./types";

/** 发送消息的输入：文本 + 本条消息使用的 Provider Profile（模型选择器「对下一条生效」） */
export interface SendMessageOptions {
  text: string;
  profile: ProviderProfile;
  /** @引用 的工作区文件；内容附加进本条消息的模型上下文（落库与回显保持原文） */
  mentions?: MentionAttachment[];
  /**
   * 思考档位（GLOSSARY「思考档位」）：发送入口固定快照，本条消息的全部工具轮次
   * 复用同一档位；缺省按 auto 处理（未传该字段的既有调用方不受影响）。
   */
  thinkingEffort?: ThinkingEffort;
  /** 中断信号：中断后已生成的部分文本保留为助手消息 */
  signal?: AbortSignal;
}

export interface CreateAgentSessionOptions {
  /** 会话记录（新建写入或恢复读出，由调用方负责持久化） */
  record: SessionRecord;
  persistence: SessionPersistence;
  /** 恢复会话时传入既有消息；新会话为空 */
  history?: StoredMessage[];
  /** AGENTS.md 等组装的系统提示；空串/省略时不注入 system 角色 */
  systemPrompt?: string;
  /**
   * Provider Profile → 语言模型 的工厂；测试注入 mock，默认走 OpenAI 兼容构造。
   * options 携带本条消息的思考档位快照（sendMessage 入口固定，逐轮构造时传入；
   * compact 等辅助调用传空对象 = 不附加控制参数）。
   */
  languageModelFor?: (
    profile: ProviderProfile,
    options: CreateLanguageModelOptions
  ) => LanguageModel;
  /**
   * 会话可用的工具（spec「工具注册表」）。空数组或缺省 = 纯对话（02 的行为）。
   * 支持工厂函数：每条消息发送时逐次解析——设置页对 MCP 工具的启停、
   * server 连接状态变化对后续消息即时生效（工单 12），无需重建会话。
   * 工具执行前经审批门（GLOSSARY「审批模式」）：ask 全询问、assist 仅风险命令审批、
   * full-access 全放行（见 decideApproval）。
   */
  tools?: ToolDefinition[] | (() => ToolDefinition[]);
  /**
   * 工具结果的图片附件（截图）是否回填模型（工单 11）：true（默认）作为 image 内容块
   * 附给多模态端点；false 纯文本降级（output 内已含文件路径说明，模型仍可工作）。
   */
  attachToolImages?: boolean;
  /**
   * 子代理编排配置（工单 13，GLOSSARY「子代理」）：传入即向工具表追加 spawn_subagent。
   * 子代理：独立上下文、完整工具集（剔除 spawn_subagent 防递归）、并发上限（超出的
   * 委派 FIFO 排队）；子代理工具调用同样过当前审批模式；报告以工具结果回流主会话。
   */
  subagents?: SubagentsConfig;
  /** 初始审批模式（缺省用 record.approvalMode） */
  approvalMode?: ApprovalMode;
  /** 时间与 id 生成注入（测试用固定值） */
  now?: () => string;
  generateId?: () => string;
}

export interface AgentSession {
  readonly id: string;
  /** 会话记录快照（可序列化；最新状态以 SessionManager.list 为准） */
  readonly record: SessionRecord;
  /**
   * 全部等待用户审批的请求（主会话与子代理并行等待时可能多个）。
   * UI 切回会话时据此恢复审批卡片。
   */
  readonly pendingApprovals: ApprovalRequest[];
  /** 第一个等待中的审批请求；无等待时为 null（向后兼容的单值视图） */
  readonly pendingApproval: ApprovalRequest | null;
  /**
   * 切换审批模式（三档，随时可调）：对下一次工具调用立即生效。
   * 持久化由调用方（SessionManager）负责。
   */
  setApprovalMode(mode: ApprovalMode): void;
  /**
   * 响应等待中的审批请求（审批卡片三键）：
   * - approve：本次执行；reject：拒绝并回填模型；always：记忆命令首词（随会话入库）后执行。
   * 没有等待中的请求或 id 不匹配时返回 false。
   */
  respondApproval(requestId: string, decision: ApprovalDecision): boolean;
  /**
   * 发送一条用户消息并流式聚合模型回复为会话事件流。
   * 模型可多轮调用工具：每轮 tool-call → 审批门（可能发 approval-request 并暂停等待
   * respondApproval 唤醒）→ 执行（tool-result 事件）→ 结果回填继续生成，直到最终文本回复。
   * 单会话同一时刻只允许一个流（并发发送直接抛错）；
   * 出错时发 error 事件（中文提示，落库为 error 消息），会话保持可用。
   */
  sendMessage(options: SendMessageOptions): AsyncIterable<SessionEvent>;
  /**
   * /compact 手动压缩（工单 08，GLOSSARY「Compact」）：
   * 用当前模型把既有历史压成摘要 → 摘要替换旧历史、保留最近 3 轮原始对话 →
   * 单事务落库（摘要消息 + 保留轮次 + compact 记录）。
   * 摘要生成成功前不动任何状态（失败可原样重试）；
   * 与 sendMessage 共享互斥（回复中不可压缩、压缩中不可发送）。
   */
  compact(options: { profile: ProviderProfile }): Promise<CompactResult>;
}

/** 单次回复允许的工具轮次上限（防模型失控循环） */
const MAX_TOOL_ROUNDS = 16;

/** 对话上下文只包含 user / assistant / compact-summary 消息；error 提示不进入模型 */
function toModelMessage(message: StoredMessage): ModelMessage {
  if (message.role === "assistant") {
    return { role: "assistant", content: message.content };
  }
  if (message.role === "compact-summary") {
    // 摘要以 user 角色注入；包装标签与 compact 成功后的内存上下文保持一致（重启等价）
    return {
      role: "user",
      content: composeCompactSummaryContext(message.content),
    };
  }
  // @引用 内容随消息持久化，恢复时重组进上下文（快照等价性：与发送时一致）
  return {
    role: "user",
    content: composeUserContent(message.content, message.mentions),
  };
}

/**
 * 工具结果 → 回填模型的 output（工单 11）：默认带图片附件（content 块 = 文本 +
 * file 图片，OpenAI 兼容端点转 image_url）；attachToolImages=false 或无图时纯文本
 * （降级路径依然可工作：output 文本含截图文件路径与说明）。
 */
function toolResultOutput(
  result: ToolResult,
  attachImages: boolean
): Pick<ToolResultPart, "output"> {
  if (attachImages && result.images !== undefined && result.images.length > 0) {
    return {
      output: {
        type: "content",
        value: [
          { type: "text", text: result.output },
          ...result.images.map((image) => ({
            type: "file" as const,
            data: { type: "data" as const, data: image.data },
            mediaType: image.mediaType,
          })),
        ],
      },
    };
  }
  return { output: { type: "text", value: result.output } };
}

/**
 * 组装发给模型的用户消息内容：原文 + @引用 文件内容（XML 标签 + 路径标注，
 * 内容含反引号等 markdown 语法也不会破坏结构）。
 */
function composeUserContent(
  text: string,
  mentions: MentionAttachment[] | undefined
): string {
  if (mentions === undefined || mentions.length === 0) {
    return text;
  }
  const blocks = mentions
    .map(
      (mention) =>
        `<attached-file path="${mention.path}">\n${mention.content}\n</attached-file>`
    )
    .join("\n");
  return `${text}\n\n以下为该消息 @引用 的工作区文件内容：\n\n${blocks}`;
}

/** /compact 保留的最近原始对话轮数（工单 08） */
export const COMPACT_KEEP_ROUNDS = 3;

/** 从工具参数中安全读取 command 字段（run_terminal_command 的命令原文） */
function commandOfToolInput(input: unknown): string | undefined {
  if (typeof input === "object" && input !== null && "command" in input) {
    const value = (input as Record<string, unknown>).command;
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

/** 摘要进入模型上下文的包装（XML 标签防注入；恢复与压缩后共用，保证重启等价） */
function composeCompactSummaryContext(summary: string): string {
  return `<compact-summary>\n以下是本会话此前对话历史的压缩摘要：\n${summary}\n</compact-summary>`;
}

/** 压缩请求的系统指令（一次性总结任务，不注入 AGENTS.md 的 coding 系统提示） */
const COMPACT_SYSTEM_PROMPT = [
  "你是对话历史压缩器。请把提供的会话历史压缩为一份摘要，",
  "供后续对话作为上下文继续任务。要求：",
  "- 保留任务目标、关键决策与结论、涉及的文件路径与命令、尚未完成的事项；",
  "- 丢弃寒暄、重复与无关内容；",
  "- 直接输出摘要正文，不要任何前后缀说明。",
].join("\n");

/** 把被压缩的上下文消息序列化为送模型的对话文本 */
function serializeContextForCompaction(messages: ModelMessage[]): string {
  const lines = messages.map((message) => {
    const role = message.role === "assistant" ? "assistant" : "user";
    return `[${role}] ${message.content}`;
  });
  return `以下是一次 coding agent 会话的既有对话历史（按时间顺序）：\n\n${lines.join("\n\n")}`;
}

/**
 * 计算保留边界：上下文尾部 KEEP_ROUNDS 轮（一轮 = user 开头的一段）之前的部分可压缩。
 * 返回保留部分在 context 中的起始下标；整个上下文不足 KEEP_ROUNDS 轮时返回 0。
 */
function keptRoundsStart(context: ModelMessage[]): number {
  let rounds = 0;
  for (let i = context.length - 1; i >= 0; i -= 1) {
    if (context[i]!.role === "user") {
      rounds += 1;
      if (rounds === COMPACT_KEEP_ROUNDS) {
        return i;
      }
    }
  }
  return 0;
}

/** 创建会话对象（纯 agent-core，不依赖 Electron；持久化经接口注入） */
export function createAgentSession(
  options: CreateAgentSessionOptions
): AgentSession {
  const { record, persistence } = options;
  // 模型上下文与持久化消息分离：user 消息进上下文时附加 @引用 内容，落库保持原文
  const context: ModelMessage[] = options.history
    ? options.history
        .filter((message) => message.role !== "error")
        .map(toModelMessage)
    : [];
  const systemPrompt = options.systemPrompt ?? "";
  const modelFor = options.languageModelFor ?? createLanguageModelFromProfile;
  const now = options.now ?? (() => new Date().toISOString());
  const generateId = options.generateId ?? randomUUID;
  const attachToolImages = options.attachToolImages ?? true;

  // 审批状态（GLOSSARY「审批模式」）：模式随时可切（对下一次工具调用立即生效）。
  // 「本会话总是允许」记忆已随三档重构移除（ADR 0004）：审批卡 always 键仅放行本次。
  // waiter 表（工单 13）：主会话与多个子代理可能并行等待审批，按 requestId 路由。
  let approvalMode = options.approvalMode ?? record.approvalMode ?? "assist";
  // 主会话流的中断信号（子代理审批等待与之贯通；每次 sendMessage 更新）
  let activeSignal: AbortSignal | undefined;
  const approvalWaiters = new Map<
    string,
    { request: ApprovalRequest; resolve: (decision: ApprovalDecision) => void }
  >();

  function pendingApprovalList(): ApprovalRequest[] {
    return [...approvalWaiters.values()].map((waiter) => waiter.request);
  }

  // 子代理编排器（工单 13）：审批端口接主会话审批链路（模式/waiter 表共享）
  let orchestrator: SubagentOrchestrator | null = null;
  if (options.subagents !== undefined) {
    orchestrator = createSubagentOrchestrator(options.subagents, {
      sessionId: record.id,
      workspacePath: record.workspacePath,
      approvalMode: () => approvalMode,
      requestApproval(request) {
        return requestSessionApproval(request);
      },
      now,
      generateId,
    });
  }

  /**
   * 子代理审批入口（编排器端口）：注册等待，事件经编排器缓冲以 approval-request 流出。
   * approval-resolved 同样进缓冲，UI 审批卡片与子代理进度保持同一时间线。
   */
  async function requestSessionApproval(
    request: ApprovalRequest
  ): Promise<ApprovalDecision> {
    const orch = orchestrator;
    orch?.pushEvent({ type: "approval-request", request });
    const decision = await registerApprovalWait(request, activeSignal);
    orch?.pushEvent({
      type: "approval-resolved",
      requestId: request.id,
      decision,
    });
    return decision;
  }

  /**
   * 注册一次审批等待并挂起直至 respondApproval：
   * 主会话审批在生成器内 yield 事件（见工具循环），子代理审批经编排器事件缓冲转发；
   * 等待中 signal abort 视为拒绝（防永久卡死）。
   */
  function registerApprovalWait(
    request: ApprovalRequest,
    signal: AbortSignal | undefined
  ): Promise<ApprovalDecision> {
    persistence.updateSession(record.id, {
      status: "waiting-approval",
      updatedAt: now(),
    });
    let resolveDecision!: (decision: ApprovalDecision) => void;
    const decisionPromise = new Promise<ApprovalDecision>((resolve) => {
      resolveDecision = resolve;
    });
    approvalWaiters.set(request.id, { request, resolve: resolveDecision });
    const onAbort = () => resolveDecision("reject");
    signal?.addEventListener("abort", onAbort, { once: true });
    return decisionPromise.finally(() => {
      signal?.removeEventListener("abort", onAbort);
      approvalWaiters.delete(request.id);
      if (approvalWaiters.size === 0) {
        persistence.updateSession(record.id, {
          status: "streaming",
          updatedAt: now(),
        });
      }
    });
  }

  // 工具表：宿主工具（工单 12 逐条消息解析）+ spawn_subagent（工单 13，见 sendMessage）
  function resolveSessionTools(): ToolDefinition[] {
    const resolved =
      typeof options.tools === "function"
        ? options.tools()
        : (options.tools ?? []);
    return orchestrator === null ? resolved : [...resolved, orchestrator.tool];
  }

  let busy = false;

  return {
    id: record.id,
    record,
    get pendingApprovals() {
      return pendingApprovalList();
    },
    get pendingApproval() {
      return pendingApprovalList()[0] ?? null;
    },

    setApprovalMode(mode) {
      approvalMode = mode;
      record.approvalMode = mode;
    },

    respondApproval(requestId, decision) {
      const waiter = approvalWaiters.get(requestId);
      if (waiter === undefined) {
        return false;
      }
      // 先移除再 resolve：同一请求的重复响应直接返回 false（幂等防护，04 的语义）
      approvalWaiters.delete(requestId);
      waiter.resolve(decision);
      return true;
    },

    async *sendMessage({ text, profile, mentions, thinkingEffort, signal }) {
      if (busy) {
        throw new Error("上一条消息仍在回复中，请等待完成后再发送");
      }
      // 思考档位快照（spec「生效边界」）：发送入口一次性固定，未传等价 auto；
      // 枚举外的值在此拒绝——不把伪造控制值发往服务端（与 provider 工厂同一校验）
      const effort: ThinkingEffort = thinkingEffort ?? "auto";
      if (!THINKING_EFFORTS.includes(effort)) {
        throw new Error(`无效的思考档位：${String(thinkingEffort)}`);
      }
      busy = true;
      // 主会话流的中断信号：子代理运行与审批等待与之贯通（中断一并中止，工单 13）
      activeSignal = signal;
      try {
        // 模型选择对本次及后续消息生效，落库
        persistence.updateSession(record.id, {
          providerProfileId: profile.id,
          model: profile.model,
          status: "streaming",
          updatedAt: now(),
        });

        const userMessage: StoredMessage = {
          id: generateId(),
          sessionId: record.id,
          role: "user",
          content: text,
          // @引用 随消息持久化：重启恢复后重组进模型上下文（快照等价性）
          mentions:
            mentions !== undefined && mentions.length > 0
              ? mentions
              : undefined,
          createdAt: now(),
        };
        persistence.insertMessage(userMessage);
        yield { type: "user-message", message: userMessage };

        // 工具逐条消息解析（工单 12）：工厂函数让设置页的 MCP 工具启停、
        // server 断线/重连对后续消息即时生效；数组形式行为不变。
        // spawn_subagent（工单 13）随解析一并加入工具表
        const toolsByName = new Map(
          resolveSessionTools().map((tool) => [tool.name, tool])
        );
        const modelTools =
          toolsByName.size > 0
            ? toModelTools([...toolsByName.values()])
            : undefined;

        const assistantMessageId = generateId();
        yield { type: "assistant-start", messageId: assistantMessageId };

        // 本条消息进模型上下文：原文 + @引用 内容；落库与事件保持原文
        const userContextMessage: ModelMessage = {
          role: "user",
          content: composeUserContent(text, mentions),
        };

        let accumulated = "";
        let aborted = false;
        try {
          // 工具循环：模型调工具 → 执行 → 结果回填 → 继续生成，直到最终文本（或中断/上限）
          // 初始上下文 = 历史消息 + 本条用户消息（原文 + @引用 内容）；system 为 AGENTS.md 注入
          const pending: ModelMessage[] = [...context, userContextMessage];
          let round = 0;

          while (true) {
            // 档位快照逐轮复用：本条消息的全部工具往返都构造自同一档位
            const result = streamText({
              model: modelFor(profile, { thinkingEffort: effort }),
              system: systemPrompt === "" ? undefined : systemPrompt,
              messages: pending,
              abortSignal: signal,
              tools: modelTools,
            });

            const toolCalls: {
              toolCallId: string;
              toolName: string;
              input: unknown;
            }[] = [];
            for await (const part of result.fullStream) {
              if (part.type === "reasoning-delta") {
                // 思考与正文分离：只作为事件流出（运行期展示），
                // 不累积进落库正文、不进入对话上下文
                yield {
                  type: "assistant-reasoning",
                  messageId: assistantMessageId,
                  delta: part.text,
                };
              } else if (part.type === "text-delta") {
                accumulated += part.text;
                yield {
                  type: "assistant-delta",
                  messageId: assistantMessageId,
                  delta: part.text,
                };
              } else if (part.type === "tool-call") {
                toolCalls.push({
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  input: part.input,
                });
              } else if (part.type === "error") {
                throw part.error;
              } else if (part.type === "abort") {
                aborted = true;
              }
            }

            if (aborted || toolCalls.length === 0) {
              break;
            }
            round += 1;
            if (round > MAX_TOOL_ROUNDS) {
              // 达到轮次上限：停止工具循环，已生成文本照常作为助手回复落库
              break;
            }

            // 本轮 assistant 消息（含 tool-call parts）进入对话上下文
            pending.push(...(await result.response).messages);

            // 逐个执行工具：tool-call 事件 → 审批门（工单 04）→ 执行 → tool-result 事件 + 落库。
            // spawn_subagent 委派（工单 13）例外：execute 立即返回（子代理后台运行），
            // tool-result 延迟到本轮全部委派派发完、子代理结束后以真实报告回填。
            const resultParts: ToolModelMessage["content"] = [];
            const deferredDelegations: { base: ToolCallRecord }[] = [];
            for (const call of toolCalls) {
              const base: ToolCallRecord = {
                id: call.toolCallId,
                sessionId: record.id,
                toolName: call.toolName,
                arguments: safeJsonStringify(call.input),
                output: "",
                isError: false,
                createdAt: now(),
              };
              yield { type: "tool-call", call: base };

              // 中断可能发生在上一个事件产出与本工具执行之间（生成器在 yield 处暂停）：
              // 已 abort 的 signal 不会再触发 listener，这里显式短路，不再启动执行
              const definition = toolsByName.get(call.toolName);
              let output: string;
              let isError: boolean;
              /** 实际执行的完整结果（截图等图片附件）；被拒绝/未注册时为 null */
              let executed: ToolResult | null = null;

              if (signal?.aborted === true) {
                // 中断短路（工单 06）：中断发生在上一个事件产出与本工具执行之间，
                // 不再启动执行，也不进入审批门（已 abort 的 signal 不会再触发
                // listener，进审批等待会永久卡死）
                output = "已被用户中断，未执行";
                isError = true;
              } else if (definition === undefined) {
                output = `工具 ${call.toolName} 未注册，可用工具：${[...toolsByName.keys()].join("、")}`;
                isError = true;
              } else {
                // 审批门（插在 tool-call 事件与执行之间）：
                // ask 全询问 / assist 仅危险命令审批 / full-access 放行（见 decideApproval）
                const command = commandOfToolInput(call.input);
                const gate = decideApproval({
                  mode: approvalMode,
                  permission: definition.permission,
                  toolName: definition.name,
                  command,
                });

                if (gate.kind === "blocked") {
                  output = `工具调用被审批策略拒绝：${gate.reason}`;
                  isError = true;
                } else if (gate.kind === "ask") {
                  // 暂停等待审批：事件流出卡片 → 注册等待（落库 waiting-approval）→
                  // await 外部 respondApproval 唤醒（desktop 经 IPC 桥接 UI 三键）；
                  // 等待中 signal abort 视为拒绝（registerApprovalWait 内防御）
                  const request: ApprovalRequest = {
                    id: call.toolCallId,
                    sessionId: record.id,
                    toolName: call.toolName,
                    command: command ?? call.toolName,
                    commandWord: gate.commandWord,
                    createdAt: now(),
                  };
                  // 先注册等待再 yield 事件（04 踩坑：生成器挂起在 yield 时，
                  // 外部 respondApproval 必须已能找到 waiter）
                  const decisionPromise = registerApprovalWait(request, signal);
                  yield { type: "approval-request", request };
                  const decision = await decisionPromise;
                  yield {
                    type: "approval-resolved",
                    requestId: request.id,
                    decision,
                  };

                  if (decision === "reject") {
                    output =
                      "工具调用被用户拒绝：用户未批准在当前会话执行该命令。可以改用只读工具继续，或向用户说明计划并询问如何调整。";
                    isError = true;
                  } else {
                    // always 与 approve 同效：新三档下不再写「总是允许」记忆（ADR 0004，
                    // ask 档「始终询问」、assist 档仅风险命令弹卡且不允许记忆）
                    executed = await runTool(definition, call.input, {
                      workspacePath: record.workspacePath,
                      sessionId: record.id,
                      approvalMode,
                      toolCallId: call.toolCallId,
                      signal,
                      profile,
                      // 档位快照随 profile 同一通道转发（spawn_subagent 入队捕获）
                      thinkingEffort: effort,
                    });
                    output = executed.output;
                    isError = executed.isError;
                  }
                } else {
                  executed = await runTool(definition, call.input, {
                    workspacePath: record.workspacePath,
                    sessionId: record.id,
                    approvalMode,
                    toolCallId: call.toolCallId,
                    signal,
                    profile,
                    thinkingEffort: effort,
                  });
                  output = executed.output;
                  isError = executed.isError;
                }
              }

              if (
                orchestrator !== null &&
                call.toolName === SUBAGENT_TOOL_NAME
              ) {
                // 委派：占位结果先不落库不回填，本轮末以真实报告回填（见下）
                deferredDelegations.push({ base });
                continue;
              }

              const completed = { ...base, output, isError };
              persistence.insertToolCall(completed);
              yield { type: "tool-result", call: completed };
              resultParts.push({
                type: "tool-result",
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                ...toolResultOutput(
                  { output, isError, images: executed?.images },
                  attachToolImages
                ),
                // 失败语义已在 output 文本（拒绝 /「工具 X 执行失败：…」前缀），模型可读
              });
            }

            // 子代理轮末等待（工单 13）：本轮全部委派已派发（并行运行），
            // 等待其结束并实时转发进度事件（排队 → 运行 → 工具进度 → 报告）；
            // 中断时子代理随 signal 一并中止（pump 在全部收尾后返回）。
            if (orchestrator !== null && deferredDelegations.length > 0) {
              for await (const event of orchestrator.pump()) {
                yield event;
              }
              // 真实报告作为延迟 tool-result：落库、事件流出、回填下一轮生成
              for (const { base } of deferredDelegations) {
                const reported = orchestrator.resultFor(base.id) ?? {
                  output: "子代理未返回报告（委派未被接受）",
                  isError: true,
                };
                const completed = { ...base, ...reported };
                persistence.insertToolCall(completed);
                yield { type: "tool-result", call: completed };
                resultParts.push({
                  type: "tool-result",
                  toolCallId: base.id,
                  toolName: base.toolName,
                  output: { type: "text", value: reported.output },
                });
              }
            }

            // 工具结果作为 tool 消息回填，进入下一轮生成
            pending.push({ role: "tool", content: resultParts });
          }

          // 循环结束（最终文本 / 中断 / 上限）：转发子代理事件缓冲中的残留（正常应为空）
          if (orchestrator !== null) {
            for (const event of orchestrator.drain()) {
              yield event;
            }
          }
        } catch (error) {
          if (isAbortLike(error, signal)) {
            aborted = true;
          } else {
            // 错误路径：中文提示落库并广播；不进入对话上下文，会话可继续使用
            const errorMessage: StoredMessage = {
              id: generateId(),
              sessionId: record.id,
              role: "error",
              content: describeModelError(error),
              createdAt: now(),
            };
            persistence.insertMessage(errorMessage);
            yield { type: "error", message: errorMessage };
            return;
          }
        }

        const assistantMessage: StoredMessage = {
          id: assistantMessageId,
          sessionId: record.id,
          role: "assistant",
          content: accumulated,
          // 被用户中断的回复：持久化标记，重启恢复后 UI 仍显示中断点
          aborted: aborted || undefined,
          createdAt: now(),
        };
        persistence.insertMessage(assistantMessage);
        context.push(userContextMessage, {
          role: "assistant",
          content: accumulated,
        });
        yield aborted
          ? { type: "assistant-aborted", message: assistantMessage }
          : { type: "assistant-done", message: assistantMessage };
      } finally {
        persistence.updateSession(record.id, {
          status: "idle",
          updatedAt: now(),
        });
        busy = false;
      }
    },

    async compact({ profile }) {
      if (busy) {
        throw new Error("会话正在回复或压缩中，请等待完成后再操作");
      }
      const keptStart = keptRoundsStart(context);
      if (keptStart === 0) {
        throw new Error(
          `当前历史不超过最近 ${COMPACT_KEEP_ROUNDS} 轮，没有可压缩的内容`
        );
      }
      busy = true;
      try {
        // 第一步（副本上生成）：请求当前模型压缩被替换的旧历史；失败直接抛出，
        // 库与内存上下文都未动，可原样重试
        const compactable = context.slice(0, keptStart);
        let summary = "";
        try {
          const result = await generateText({
            // compact 是辅助调用：不附加档位控制参数（空对象 = 服务端默认行为）
            model: modelFor(profile, {}),
            system: COMPACT_SYSTEM_PROMPT,
            prompt: [
              {
                role: "user",
                content: serializeContextForCompaction(compactable),
              },
            ],
          });
          summary = result.text.trim();
        } catch (error) {
          throw new Error(describeModelError(error));
        }
        if (summary === "") {
          throw new Error("压缩失败：模型返回了空摘要，请重试");
        }

        // 第二步（成功才替换）：新历史 = 摘要 + 最近 3 轮原文（重新落库，
        // 新 id 与递增时间戳保证摘要卡片排在最前）；内存上下文同步替换为
        // 包装摘要 + 保留轮次的模型消息（@引用 附加内容随内存上下文保真）
        const keptContext = context.slice(keptStart);
        const storedContext = persistence
          .listMessages(record.id)
          .filter(
            (message) => message.role === "user" || message.role === "assistant"
          )
          .slice(-keptContext.length);
        // 被压缩轮次的工具调用记录随历史一起清理：边界 = 保留轮次最老一条消息的旧时间戳
        // （保留轮次自身的工具调用晚于其 user 消息，不受影响）
        const pruneToolCallsBefore = storedContext[0]?.createdAt;
        const summaryMessage: StoredMessage = {
          id: generateId(),
          sessionId: record.id,
          role: "compact-summary",
          content: summary,
          createdAt: now(),
        };
        const keptMessages: StoredMessage[] = storedContext.map((message) => ({
          ...message,
          id: generateId(),
          createdAt: now(),
        }));
        const compactRecord: CompactRecord = {
          id: generateId(),
          sessionId: record.id,
          summary,
          messagesCompacted: compactable.length,
          createdAt: now(),
        };
        persistence.replaceHistory(
          record.id,
          [summaryMessage, ...keptMessages],
          compactRecord,
          pruneToolCallsBefore
        );
        context.splice(
          0,
          context.length,
          { role: "user", content: composeCompactSummaryContext(summary) },
          ...keptContext
        );
        persistence.updateSession(record.id, {
          providerProfileId: profile.id,
          model: profile.model,
          updatedAt: now(),
        });
        return {
          summaryMessage,
          keptMessages,
          compactedMessages: compactable.length,
        };
      } finally {
        busy = false;
      }
    },
  };
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '"<无法序列化的参数>"';
  }
}
