import { randomUUID } from "node:crypto";

import {
  generateText,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolModelMessage,
  type ToolResultPart,
} from "ai";

import { composeStoredMessageContent } from "../context/stored-message";
import { createInteractionController } from "../interaction/controller";
import { createEventBuffer } from "../interaction/event-buffer";
import { createQuestionsTool } from "../interaction/questions";
import type {
  InteractionRecord,
  InteractionRequest,
} from "../interaction/types";
import { extractSkillNames } from "../composer/skill-reference";
import type {
  AgentResourceSnapshot,
  ResourceSnapshotSummary,
  TaskResourceState,
} from "../context/resource-types";
import {
  createLanguageModelFromProfile,
  parseThinkingEffort,
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
  createUpdatePlanTool,
  PLAN_USAGE_POLICY,
  TOOL_STYLE_POLICY,
} from "../tools/update-plan";

import {
  decideApproval,
  type ApprovalDecision,
  type ApprovalMode,
  type ApprovalRequest,
} from "./approval";
import { describeModelError, isAbortLike } from "./errors";
import type { TaskPersistence } from "./persistence";
import {
  createSubagentOrchestrator,
  SUBAGENT_DELEGATION_POLICY,
  SUBAGENT_TOOL_NAME,
  type SubagentOrchestrator,
  type SubagentsConfig,
} from "./subagent";
import {
  DEFAULT_COMPACT_KEEP_ROUNDS,
  DEFAULT_MAX_TOOL_ROUNDS,
  DEFAULT_MODEL_MAX_RETRIES,
} from "./execution-settings";
import type {
  CompactRecord,
  CompactResult,
  MentionAttachment,
  TaskEvent,
  TaskRecord,
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
  /** 宿主在接收发送时固定；缺省取任务的下次发送偏好。 */
  approvalMode?: ApprovalMode;
  /** 中断信号：中断后已生成的部分文本保留为助手消息 */
  signal?: AbortSignal;
}

export interface CreateAgentTaskOptions {
  /** 任务记录（新建写入或恢复读出，由调用方负责持久化） */
  record: TaskRecord;
  persistence: TaskPersistence;
  /** 恢复任务时传入既有消息；新任务为空 */
  history?: StoredMessage[];
  /** AGENTS.md 等组装的系统提示；空串/省略时不注入 system 角色 */
  systemPrompt?: string;
  /** 每条消息互斥内创建资源快照；正文与工具加载状态仅本轮有效。 */
  resources?: () => AgentResourceSnapshot;
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
   * 任务可用的工具（spec「工具注册表」）。空数组或缺省 = 纯对话（02 的行为）。
   * 支持工厂函数：每条消息发送时逐次解析——设置页对 MCP 工具的启停、
   * server 连接状态变化对后续消息即时生效（工单 12），无需重建任务。
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
   * 委派 FIFO 排队）；子代理工具调用同样过当前审批模式；报告以工具结果回流主任务。
   */
  subagents?: SubagentsConfig;
  /**
   * 主任务工具轮次上限的逐次解析取值函数（执行设置 ADR 0017，GLOSSARY「工具轮次」；
   * 先例为子代理并发设置的 resolver 范式，agent-core 不依赖任何存储实现）。
   * 每个回合（sendMessage）开始时读取一次并快照——进行中回合不受中途调小影响，
   * 下一次发送按当时值重新解析；未注入（纯对话/测试）用 DEFAULT_MAX_TOOL_ROUNDS。
   * 宿主保证返回合法值（设置层校验 10–1000），agent-core 不重复校验。
   */
  toolRoundsLimit?: () => number;
  /**
   * /compact 保留最近原始对话轮数的逐次解析取值函数（执行设置票 03，ADR 0017，
   * GLOSSARY「执行设置」；先例为主任务 toolRoundsLimit 的 resolver 范式，
   * agent-core 不依赖任何存储实现）。compact 无「进行中」状态：每次执行
   * /compact 时读取一次（逐次读取，无回合快照语义）——下次压缩立即采用新值。
   * 未注入用 DEFAULT_COMPACT_KEEP_ROUNDS；宿主保证返回合法值（设置层校验
   * 1–10），agent-core 不重复校验。
   */
  compactKeepRounds?: () => number;
  /**
   * 模型请求重试次数的逐次解析取值函数（GLOSSARY「执行设置」，ADR 0024
   * 「重试不做 failover」；先例为 toolRoundsLimit 的 resolver 范式，agent-core
   * 不依赖任何存储实现）。作用于任务的全部模型请求：对话每个回合（sendMessage）
   * 开始时读取一次并快照（进行中回合不受中途调整影响，下一次发送按当时值重新
   * 解析），compact 每次执行时读取（无「进行中」状态，下次压缩立即采用新值）。
   * 未注入用 DEFAULT_MODEL_MAX_RETRIES（=2，与 SDK 默认一致）；宿主保证返回
   * 合法值（设置层校验 0–10），agent-core 不重复校验。
   */
  modelMaxRetries?: () => number;
  /** 初始审批模式（缺省用 record.approvalMode） */
  approvalMode?: ApprovalMode;
  /** 时间与 id 生成注入（测试用固定值） */
  now?: () => string;
  generateId?: () => string;
}

export interface AgentTask {
  readonly id: string;
  readonly pendingInteractions: InteractionRecord[];
  respondInteraction(requestId: string, response: unknown): boolean;
  cancelInteractions(reason: string): void;
  /** 任务记录快照（可序列化；最新状态以 TaskManager.list 为准） */
  readonly record: TaskRecord;
  /** 当前运行快照实时摘要与最近一轮摘要；不包含正文，不随持久化恢复。 */
  readonly resourceState: TaskResourceState;
  /**
   * 全部等待用户审批的请求（主任务与子代理并行等待时可能多个）。
   * UI 切回任务时据此恢复审批卡片。
   */
  readonly pendingApprovals: ApprovalRequest[];
  /** 第一个等待中的审批请求；无等待时为 null（向后兼容的单值视图） */
  readonly pendingApproval: ApprovalRequest | null;
  /**
   * 切换审批模式（三档，随时可调）：只对下一次发送生效。
   * 持久化由调用方（TaskManager）负责。
   */
  setApprovalMode(mode: ApprovalMode): void;
  /** 先持久化再撤销实时任务授权；失败不改变内存。 */
  revokeAutoApprove(): void;
  /**
   * 响应等待中的审批请求（审批卡片三键）：
   * - approve：本次执行；reject：拒绝并回填模型；always：兼容旧入口，仅批准本次。
   * 没有等待中的请求或 id 不匹配时返回 false。
   */
  respondApproval(requestId: string, decision: ApprovalDecision): boolean;
  /**
   * 发送一条用户消息并流式聚合模型回复为任务事件流。
   * 模型可多轮调用工具：每轮 tool-call → 审批门（可能发 interaction-request 并暂停等待
   * respondInteraction 唤醒）→ 执行（tool-result 事件）→ 结果回填继续生成，直到最终文本回复。
   * 单任务同一时刻只允许一个流（并发发送直接抛错）；
   * 出错时发 error 事件（中文提示，落库为 error 消息），任务保持可用。
   */
  sendMessage(options: SendMessageOptions): AsyncIterable<TaskEvent>;
  /**
   * /compact 手动压缩（工单 08，GLOSSARY「Compact」）：
   * 用当前模型把既有历史压成摘要 → 摘要替换旧历史、保留最近 N 轮原始对话
   * （N 为执行设置的保留轮数，compact 执行时逐次读取，默认 3）→
   * 单事务落库（摘要消息 + 保留轮次 + compact 记录）。
   * 摘要生成成功前不动任何状态（失败可原样重试）；
   * 与 sendMessage 共享互斥（回复中不可压缩、压缩中不可发送）。
   */
  compact(options: {
    profile: ProviderProfile;
    signal?: AbortSignal;
  }): Promise<CompactResult>;
}

/** 对话上下文只包含 user / assistant / compact-summary 消息；error 提示不进入模型 */
function toModelMessage(message: StoredMessage): ModelMessage {
  return {
    role: message.role === "assistant" ? "assistant" : "user",
    content: composeStoredMessageContent(message),
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

/** /compact 保留的最近原始对话轮数默认值迁至 execution-settings.ts（执行设置票 03 单一来源） */

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

/** 压缩请求的系统指令（一次性总结任务，不注入 AGENTS.md 的 coding 系统提示） */
const COMPACT_SYSTEM_PROMPT = [
  "你是对话历史压缩器。请把提供的任务历史压缩为一份摘要，",
  "供后续对话作为上下文继续任务。要求：",
  "- 保留任务目标、关键决策与结论、涉及的文件路径与命令、尚未完成的事项；",
  "- 保留用户问答中的答案、自定义文本、跳过状态与关键决策，区分主任务与子代理来源；",
  "- 丢弃寒暄、重复与无关内容；",
  "- 直接输出摘要正文，不要任何前后缀说明。",
].join("\n");

/** 把被压缩的上下文消息序列化为送模型的对话文本 */
function serializeContextForCompaction(messages: ModelMessage[]): string {
  const lines = messages.map((message) => {
    const role = message.role === "assistant" ? "assistant" : "user";
    return `[${role}] ${message.content}`;
  });
  return `以下是一次 coding agent 任务的既有对话历史（按时间顺序）：\n\n${lines.join("\n\n")}`;
}

/**
 * 计算保留边界：上下文尾部 keepRounds 轮（一轮 = user 开头的一段）之前的部分可压缩。
 * 返回保留部分在 context 中的起始下标；整个上下文不足 keepRounds 轮时返回 0。
 */
function keptRoundsStart(context: ModelMessage[], keepRounds: number): number {
  let rounds = 0;
  for (let i = context.length - 1; i >= 0; i -= 1) {
    if (context[i]!.role === "user") {
      rounds += 1;
      if (rounds === keepRounds) {
        return i;
      }
    }
  }
  return 0;
}

/** 创建任务对象（纯 agent-core，不依赖 Electron；持久化经接口注入） */
export function createAgentTask(options: CreateAgentTaskOptions): AgentTask {
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

  // 审批状态（GLOSSARY「审批模式」）：模式随时可切（只对下一次发送生效）。
  // autoApprove 独立实时读取；遗留 always 仅批准本次，任务授权必须来自有效 scope: task 响应。
  // waiter 表（工单 13）：主任务与多个子代理可能并行等待审批，按 requestId 路由。
  let nextApprovalMode =
    options.approvalMode ?? record.approvalMode ?? "assist";
  let approvalMode = nextApprovalMode;
  // 主任务流的中断信号（子代理审批等待与之贯通；每次 sendMessage 更新）
  let activeSignal: AbortSignal | undefined;
  let currentResources: AgentResourceSnapshot | undefined;
  let lastResources: ResourceSnapshotSummary | null = null;
  let activeController: AbortController | undefined;
  let terminated = false;
  let activeUser: StoredMessage | undefined;
  let activeUserContext: ModelMessage | undefined;
  const events = createEventBuffer<TaskEvent>();
  const interactions = createInteractionController({
    persistence,
    now,
    emit: (event) => events.push(event),
    autoApprove: () => record.autoApprove === true,
    autoApproved() {
      record.autoApprove = true;
      events.push({
        type: "task-auto-approve-changed",
        taskId: record.id,
        autoApprove: true,
      });
    },
    waiting(waiting, persisted) {
      record.status = waiting ? "waiting-user" : "streaming";
      // 批量授权事务已保存状态；提交后只更新内存，避免第二次写库失败造成部分放行。
      if (persisted) return;
      persistence.updateTask(record.id, {
        status: record.status,
        updatedAt: now(),
      });
    },
    answered(snapshot) {
      if (!activeUser || !activeUserContext) return;
      (activeUser.questionAnswers ??= []).push(snapshot);
      activeUserContext.content = composeStoredMessageContent(activeUser);
    },
  });
  function pendingApprovalList(): ApprovalRequest[] {
    return interactions.pending.flatMap(({ request }) =>
      request.kind === "approval"
        ? [
            {
              id: request.id,
              taskId: request.taskId,
              toolName: request.toolName,
              command: request.command,
              commandWord: request.commandWord,
              createdAt: request.createdAt,
              ...(request.source.kind === "subagent"
                ? { subagentId: request.source.subagentId }
                : {}),
            },
          ]
        : []
    );
  }
  function requestInteraction(
    request:
      | Omit<
          Extract<InteractionRequest, { kind: "questions" }>,
          "id" | "taskId" | "turnId" | "createdAt"
        >
      | Omit<
          Extract<InteractionRequest, { kind: "approval" }>,
          "id" | "taskId" | "turnId" | "createdAt"
        >
  ) {
    if (!activeUser || terminated)
      return Promise.resolve<InteractionRecord>({
        request: {
          ...request,
          id: generateId(),
          taskId: record.id,
          turnId: activeUser?.id ?? "",
          createdAt: now(),
        },
        status: "cancelled",
        response: null,
        resolvedAt: now(),
        cancelReason: "本轮已结束",
      });
    return interactions.request(
      {
        ...request,
        id: generateId(),
        taskId: record.id,
        turnId: activeUser.id,
        createdAt: now(),
      },
      activeSignal
    );
  }
  const questionsTool = createQuestionsTool((questions, toolCallId) =>
    requestInteraction({
      kind: "questions",
      questions,
      toolCallId,
      source: { kind: "main" },
    })
  );
  // 工作计划工具（ADR 0016）：无外部依赖——状态即工具调用记录本身
  const planTool = createUpdatePlanTool();
  let orchestrator: SubagentOrchestrator | null = null;
  if (options.subagents !== undefined) {
    orchestrator = createSubagentOrchestrator(options.subagents, {
      taskId: record.id,
      workspacePath: record.workspacePath,
      persistence,
      approvalMode: () => approvalMode,
      resources: () => currentResources,
      requestInteraction,
      emit: (event) => events.push(event),
      now,
      generateId,
    });
  }

  // 工具表：宿主工具（工单 12 逐条消息解析）+ spawn_subagent（工单 13，见 sendMessage）
  function resolveTaskTools(): ToolDefinition[] {
    const resolved =
      typeof options.tools === "function"
        ? options.tools()
        : (options.tools ?? []);
    if (resolved.some((tool) => tool.name === questionsTool.name))
      throw new Error(`工具名称冲突：${questionsTool.name}`);
    if (resolved.some((tool) => tool.name === planTool.name))
      throw new Error(`工具名称冲突：${planTool.name}`);
    return [
      ...resolved,
      questionsTool,
      planTool,
      ...(orchestrator === null ? [] : [orchestrator.tool]),
    ];
  }

  let busy = false;

  return {
    id: record.id,
    record,
    get resourceState() {
      return {
        active: currentResources?.summary() ?? null,
        last: lastResources,
      };
    },
    get pendingApprovals() {
      return pendingApprovalList();
    },
    get pendingApproval() {
      return pendingApprovalList()[0] ?? null;
    },

    setApprovalMode(mode) {
      nextApprovalMode = mode;
      record.approvalMode = mode;
    },

    revokeAutoApprove() {
      persistence.updateTask(record.id, { autoApprove: false });
      record.autoApprove = false;
      events.push({
        type: "task-auto-approve-changed",
        taskId: record.id,
        autoApprove: false,
      });
    },

    get pendingInteractions() {
      return interactions.pending;
    },
    respondInteraction: (id, response) => interactions.respond(id, response),
    cancelInteractions(reason) {
      interactions.cancel(reason);
      if (busy) {
        terminated = true;
        record.status = "idle";
        persistence.updateTask(record.id, {
          status: "idle",
          updatedAt: now(),
        });
        activeController?.abort();
      }
    },
    respondApproval(requestId, decision) {
      if (!pendingApprovalList().some((request) => request.id === requestId))
        return false;
      return interactions.respond(requestId, {
        kind: "approval",
        decision: decision === "always" ? "approve" : decision,
      });
    },

    async *sendMessage({
      text,
      profile,
      mentions,
      thinkingEffort,
      approvalMode: requestedApprovalMode,
      signal,
    }) {
      if (busy) {
        throw new Error("上一条消息仍在回复中，请等待完成后再发送");
      }
      // 思考档位快照（spec「生效边界」）：发送入口一次性固定，未传等价 auto；
      // 枚举外的值在此拒绝——不把伪造控制值发往服务端（与 provider 工厂同一校验）
      const effort = parseThinkingEffort(thinkingEffort);
      // 工具轮次上限快照（执行设置 ADR 0017）：回合开始时读取一次——进行中回合
      // 不受中途调小影响，下一次发送按当时值重新解析；未注入用默认 200
      const toolRoundsLimit =
        options.toolRoundsLimit?.() ?? DEFAULT_MAX_TOOL_ROUNDS;
      // 模型请求重试次数快照（GLOSSARY「执行设置」，ADR 0024）：回合开始时读取
      // 一次——本回合全部 streamText（含工具多轮）与失败文案用同一值；进行中
      // 回合不受中途调整影响，下一次发送按当时值重新解析
      const modelMaxRetries =
        options.modelMaxRetries?.() ?? DEFAULT_MODEL_MAX_RETRIES;
      // 每次发送冻结主执行及其子代理的权限与模型，偏好修改只用于下次发送。
      approvalMode = requestedApprovalMode ?? nextApprovalMode;
      profile = { ...profile };
      busy = true;
      // 主任务流的中断信号：子代理运行与审批等待与之贯通（中断一并中止，工单 13）
      terminated = false;
      activeController = new AbortController();
      const upstreamSignal = signal;
      const onAbort = () => activeController?.abort();
      upstreamSignal?.addEventListener("abort", onAbort, { once: true });
      if (upstreamSignal?.aborted) activeController.abort();
      signal = activeController.signal;
      activeSignal = signal;
      try {
        const snapshot = (currentResources = options.resources?.());
        const execution = snapshot?.createExecution("main");
        // 显式引用全部验证成功后才落库用户消息；正文只进入本轮 system，不污染历史。
        const explicitBody =
          execution?.loadExplicit(extractSkillNames(text)) ?? "";
        // 工具逐条消息解析（MCP 启停即时生效），资源工具重名必须显式拒绝。
        const toolsByName = new Map(
          resolveTaskTools().map((tool) => [tool.name, tool])
        );
        for (const tool of execution?.tools ?? []) {
          if (toolsByName.has(tool.name)) {
            throw new Error(`工具名称冲突：${tool.name}`);
          }
          toolsByName.set(tool.name, tool);
        }
        const turnSystemPrompt = [
          systemPrompt,
          snapshot?.systemPrompt ?? "",
          explicitBody,
          // 工作计划策略（ADR 0016）：update_plan 无条件并入工具表，
          // 策略随之常驻主任务每轮提示；子代理侧由 subagent.ts 静态注入（ADR 0023）
          PLAN_USAGE_POLICY,
          orchestrator !== null &&
          toolsByName.get(SUBAGENT_TOOL_NAME) === orchestrator.tool
            ? SUBAGENT_DELEGATION_POLICY
            : "",
          // 通用风格条款殿后：统摄前面所有策略段的表达方式（不做、不说规则本身）
          TOOL_STYLE_POLICY,
        ]
          .filter(Boolean)
          .join("\n\n");
        const modelTools =
          toolsByName.size > 0
            ? toModelTools([...toolsByName.values()])
            : undefined;

        // 模型选择对本次及后续消息生效，落库
        persistence.updateTask(record.id, {
          providerProfileId: profile.id,
          model: profile.model,
          status: "streaming",
          updatedAt: now(),
        });

        const userMessage: StoredMessage = {
          id: generateId(),
          taskId: record.id,
          role: "user",
          content: text,
          // @引用 随消息持久化：重启恢复后重组进模型上下文（快照等价性）
          mentions:
            mentions !== undefined && mentions.length > 0
              ? mentions
              : undefined,
          createdAt: now(),
        };
        activeUser = userMessage;
        activeUserContext = toModelMessage(userMessage);
        context.push(activeUserContext);
        persistence.insertMessage(userMessage);
        yield { type: "user-message", message: userMessage };

        const assistantMessageId = generateId();
        yield { type: "assistant-start", messageId: assistantMessageId };

        let accumulated = "";
        // 思考与正文分离累积（票 02）：随终态 assistant 消息落库（reasoning 字段），
        // 仅为恢复后展示；不进入对话上下文（context 只 push 正文）
        let reasoningAccumulated = "";
        let aborted = false;
        try {
          // 工具循环：模型调工具 → 执行 → 结果回填 → 继续生成，直到最终文本（或中断/上限）
          // 初始上下文 = 历史消息 + 本条用户消息（原文 + @引用 内容）；system 为 AGENTS.md 注入
          const pending: ModelMessage[] = [...context];
          let round = 0;

          while (true) {
            if (signal.aborted) {
              aborted = true;
              break;
            }
            // 档位快照逐轮复用：本条消息的全部工具往返都构造自同一档位
            const result = streamText({
              model: modelFor(profile, { thinkingEffort: effort }),
              system: turnSystemPrompt === "" ? undefined : turnSystemPrompt,
              messages: pending,
              abortSignal: signal,
              tools: modelTools,
              // 重试次数（执行设置）：回合开始快照，本回合全部轮次复用
              maxRetries: modelMaxRetries,
            });

            const toolCalls: {
              toolCallId: string;
              toolName: string;
              input: unknown;
            }[] = [];
            for await (const part of result.fullStream) {
              if (part.type === "reasoning-delta") {
                // 思考与正文分离：作为事件流出（运行期展示）并累积全文
                // （随终态消息落库，票 02）；不进入对话上下文
                reasoningAccumulated += part.text;
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
            if (round > toolRoundsLimit) {
              // 达到轮次上限（执行设置 ADR 0017：提示携带本回合快照的动态上限值，
              // 替代固定数字，让用户知道限制来自自己的配置而非固定规则）：
              // 停止工具循环，本轮剩余工具调用不再执行，已生成文本照常作为助手回复
              // 落库；落库一条 error 提示让用户知道为何停在这里
              //（role error 不进模型上下文，仅消息流可见）
              const capMessage: StoredMessage = {
                id: generateId(),
                taskId: record.id,
                role: "error",
                content: `已达到单回合工具轮次上限（${toolRoundsLimit} 轮），本轮停止执行剩余工具调用；发送消息可继续剩余工作。`,
                createdAt: now(),
              };
              persistence.insertMessage(capMessage);
              yield { type: "error", message: capMessage };
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
                taskId: record.id,
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

              if (signal.aborted) {
                // 中断短路（工单 06）：中断发生在上一个事件产出与本工具执行之间，
                // 不再启动执行，也不进入审批门（已 abort 的 signal 不会再触发
                // listener，进审批等待会永久卡死）
                output = "已被用户中断，未执行";
                isError = true;
              } else if (definition === undefined) {
                output = `工具 ${call.toolName} 未注册，可用工具：${[...toolsByName.keys()].join("、")}`;
                isError = true;
              } else {
                // 审批门（插在 tool-call 事件与执行之间）：按真实档位判定，不含
                // autoApprove——ask 全询问 / assist 仅危险命令审批 / full-access 放行
                // （见 decideApproval）。autoApprove 开启时本应询问的调用仍走交互
                // 通道，由控制器即时批准并落库留痕（反馈2）；未开启则等待用户。
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
                  const interaction = yield* events.during(
                    requestInteraction({
                      kind: "approval",
                      toolCallId: call.toolCallId,
                      source: { kind: "main" },
                      toolName: call.toolName,
                      command: command ?? call.toolName,
                      commandWord: gate.commandWord,
                    })
                  );
                  const decision =
                    interaction.response?.kind === "approval"
                      ? interaction.response.decision
                      : null;
                  if (interaction.status === "cancelled" || signal.aborted) {
                    output = "工具调用已取消，未执行";
                    isError = true;
                  } else if (decision === "reject") {
                    output =
                      "工具调用被用户拒绝：用户未批准在当前任务执行该命令。可以改用只读工具继续，或向用户说明计划并询问如何调整。";
                    isError = true;
                  } else {
                    // 授权已由交互控制器提交；执行仍沿用本轮冻结的文件访问模式。
                    executed = yield* events.during(
                      runTool(definition, call.input, {
                        workspacePath: record.workspacePath,
                        taskId: record.id,
                        approvalMode,
                        toolCallId: call.toolCallId,
                        signal,
                        profile,
                        // 档位快照随 profile 同一通道转发（spawn_subagent 入队捕获）
                        thinkingEffort: effort,
                      })
                    );
                    output = executed.output;
                    isError = executed.isError;
                  }
                } else {
                  executed = yield* events.during(
                    runTool(definition, call.input, {
                      workspacePath: record.workspacePath,
                      taskId: record.id,
                      approvalMode,
                      toolCallId: call.toolCallId,
                      signal,
                      profile,
                      thinkingEffort: effort,
                    })
                  );
                  output = executed.output;
                  isError = executed.isError;
                }
              }

              if (
                orchestrator !== null &&
                definition === orchestrator.tool &&
                executed?.isError === false
              ) {
                // 仅已接受的委派延迟回填；即时失败保留原始错误，按普通结果落库与回填。
                deferredDelegations.push({ base });
                continue;
              }

              if (terminated) return;
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
              yield* events.during(orchestrator.wait());
              if (terminated) return;
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

          for (const event of events.drain()) yield event;
        } catch (error) {
          if (terminated) return;
          const interrupted = isAbortLike(error, signal);
          // error 终态前必须广播取消：finally 不 yield，避免 iterator.return 被悬挂。
          interactions.cancel(interrupted ? "本轮已中断" : "本轮执行失败");
          activeController?.abort();
          if (orchestrator?.hasPending())
            yield* events.during(orchestrator.wait());
          for (const event of events.drain()) yield event;
          if (terminated) return;
          if (interrupted) {
            aborted = true;
          } else {
            // 错误路径：中文提示落库并广播；不进入对话上下文，任务可继续使用
            // （重试耗尽文案携带回合开始快照的重试次数配置值，ADR 0024）
            const errorMessage: StoredMessage = {
              id: generateId(),
              taskId: record.id,
              role: "error",
              content: describeModelError(error, modelMaxRetries),
              createdAt: now(),
            };
            persistence.insertMessage(errorMessage);
            yield { type: "error", message: errorMessage };
            return;
          }
        }

        if (terminated) return;
        const assistantMessage: StoredMessage = {
          id: assistantMessageId,
          taskId: record.id,
          role: "assistant",
          content: accumulated,
          // 思考全文随终态消息落库（票 02，ADR 0011）：重启/切回后重建思考段；
          // 模型上下文仍只 push 正文（思考不回传 provider 的行为不变）
          reasoning: reasoningAccumulated || undefined,
          // 被用户中断的回复：持久化标记，重启恢复后 UI 仍显示中断点
          aborted: aborted || undefined,
          createdAt: now(),
        };
        persistence.insertMessage(assistantMessage);
        context.push({
          role: "assistant",
          content: accumulated,
        });
        yield aborted
          ? { type: "assistant-aborted", message: assistantMessage }
          : { type: "assistant-done", message: assistantMessage };
      } finally {
        interactions.cancel("本轮已结束");
        activeController?.abort();
        upstreamSignal?.removeEventListener("abort", onAbort);
        if (orchestrator?.hasPending()) await orchestrator.wait();
        events.drain();
        activeUser = undefined;
        activeUserContext = undefined;
        activeController = undefined;
        try {
          if (currentResources !== undefined) {
            lastResources = currentResources.summary();
          }
        } finally {
          currentResources = undefined;
          activeSignal = undefined;
          busy = false;
          record.status = "idle";
          if (!terminated)
            persistence.updateTask(record.id, {
              status: "idle",
              updatedAt: now(),
            });
        }
      }
    },

    async compact({ profile, signal }) {
      if (busy) {
        throw new Error("任务正在回复或压缩中，请等待完成后再操作");
      }
      // 保留轮数逐次读取（执行设置票 03，ADR 0017）：compact 无「进行中」状态，
      // 每次执行读取一次——设置页保存后对下一次 /compact 立即生效
      const keepRounds =
        options.compactKeepRounds?.() ?? DEFAULT_COMPACT_KEEP_ROUNDS;
      // 重试次数同样逐次读取（GLOSSARY「执行设置」，ADR 0024）：本次压缩的
      // generateText 与失败提示共用；下一次压缩按当时值重新解析
      const modelMaxRetries =
        options.modelMaxRetries?.() ?? DEFAULT_MODEL_MAX_RETRIES;
      const keptStart = keptRoundsStart(context, keepRounds);
      if (keptStart === 0) {
        throw new Error(
          `当前历史不超过最近 ${keepRounds} 轮，没有可压缩的内容`
        );
      }
      signal?.throwIfAborted();
      busy = true;
      record.status = "streaming";
      persistence.updateTask(record.id, { status: "streaming" });
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
            abortSignal: signal,
            // 重试次数（执行设置）：本次压缩逐次读取的配置值
            maxRetries: modelMaxRetries,
            prompt: [
              {
                role: "user",
                content: serializeContextForCompaction(compactable),
              },
            ],
          });
          signal?.throwIfAborted();
          summary = result.text.trim();
        } catch (error) {
          throw new Error(describeModelError(error, modelMaxRetries), {
            cause: error,
          });
        }
        if (summary === "") {
          throw new Error("压缩失败：模型返回了空摘要，请重试");
        }

        // 第二步（成功才替换）：新历史 = 摘要 + 最近 3 轮原文（重新落库，
        // 保留消息的 id 与时间戳不变，保证交互归属与时间线稳定）；内存上下文同步替换为
        // 包装摘要 + 保留轮次的模型消息（@引用 附加内容随内存上下文保真）
        const keptContext = context.slice(keptStart);
        const storedHistory = persistence
          .listMessages(record.id)
          .filter((message) => message.role !== "error");
        const storedContext = storedHistory
          .filter(
            (message) => message.role === "user" || message.role === "assistant"
          )
          .slice(-keptContext.length);
        // 被压缩轮次的工具调用记录随历史一起清理：边界 = 保留轮次最老一条消息的旧时间戳
        // （保留轮次自身的工具调用晚于其 user 消息，不受影响）
        const pruneToolCallsBefore = storedContext[0]?.createdAt;
        const summaryMessage: StoredMessage = {
          id: generateId(),
          taskId: record.id,
          role: "compact-summary",
          content: summary,
          // 摘要先于保留轮次；保留原始消息 ID/时间，使交互 turnId 不悬空。
          createdAt: storedHistory[0]?.createdAt ?? now(),
        };
        const keptMessages: StoredMessage[] = storedContext;
        const compactRecord: CompactRecord = {
          id: generateId(),
          taskId: record.id,
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
          toModelMessage(summaryMessage),
          ...keptContext
        );
        persistence.updateTask(record.id, {
          providerProfileId: profile.id,
          model: profile.model,
          updatedAt: now(),
        });
        return {
          summaryMessage,
          keptMessages,
          compactedMessages: compactable.length,
        };
      } catch (error) {
        if (signal?.aborted) {
          const message: StoredMessage = {
            id: generateId(),
            taskId: record.id,
            role: "assistant",
            content: "压缩已中断，原有历史已保留。",
            aborted: true,
            createdAt: now(),
          };
          persistence.insertMessage(message);
          context.push(toModelMessage(message));
        }
        throw error;
      } finally {
        busy = false;
        record.status = "idle";
        persistence.updateTask(record.id, { status: "idle" });
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
