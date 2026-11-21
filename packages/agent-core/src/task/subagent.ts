/**
 * 子代理编排（GLOSSARY「子代理」；spec「subagents」；工单 13）。
 *
 * spawn_subagent(task) 把调研/大范围搜索类任务委派给子代理：
 * - 独立上下文：固定系统指令 + 任务描述，不含主任务历史；
 * - 完整工具集但剔除 spawn_subagent（防递归，有测试）；update_plan 与
 *   questionsTool 同款每次运行强制并入，策略静态注入系统提示（ADR 0023）；
 * - 模型用全局子代理配置（SubagentsConfig.resolveModel 返回 (Profile, 模型)
 *   二元组；null = 跟随主任务当前所用模型，同 Profile 同模型）；
 * - 单任务并发上限（默认 3，设置页可配）：超出的委派 FIFO 排队；
 * - 子代理工具调用同样过当前审批模式（readonly 下子代理同样只读，
 *   suggest 下的命令经主任务审批链路暂停等待用户）；
 * - 完成后报告以文本回流主任务上下文（spawn_subagent 的工具结果）。
 *
 * 执行模型：spawn_subagent 的 execute 立即返回（接受委派），子代理在后台运行；
 * 任务工具循环在本轮工具全部派发后经 pump() 等待本轮全部子代理结束，
 * 再把真实报告作为延迟的 tool-result 落库与回填（见 agent-task 的轮末等待）。
 */
import {
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolModelMessage,
} from "ai";

import { createQuestionsTool } from "../interaction/questions";
import type {
  InteractionRecord,
  InteractionRequest,
} from "../interaction/types";
import type { AgentResourceSnapshot } from "../context/resource-types";
import { createLanguageModelFromProfile } from "../provider/language-model";
import type {
  CreateLanguageModelOptions,
  ThinkingEffort,
} from "../provider/language-model";
import type {
  ProviderProfile,
  ResolvedModel,
} from "../provider/provider-profile";
import {
  createUpdatePlanTool,
  PLAN_USAGE_POLICY,
  TOOL_STYLE_POLICY,
} from "../tools/update-plan";
import { runTool, toModelTools } from "../tools/registry";
import {
  SPAWN_TERMINAL,
  TERMINAL_USAGE_POLICY,
} from "../tools/terminal-sessions";
import type {
  ToolCallRecord,
  ToolDefinition,
  ToolResult,
} from "../tools/types";

import { decideApproval, type ApprovalMode } from "./approval";
import {
  DEFAULT_MAX_SUBAGENT_TOOL_ROUNDS,
  DEFAULT_MODEL_MAX_RETRIES,
} from "./execution-settings";
import { describeModelError, isAbortLike } from "./errors";
import type { TaskPersistence } from "./persistence";
import { settleTaskUsage } from "./usage";
import type { TaskEvent } from "./types";

/** spawn_subagent 工具名（子代理工具集按此名剔除，防递归） */
export const SUBAGENT_TOOL_NAME = "spawn_subagent";

/** 仅供拥有内置委派工具的主模型使用，不写入共享资源快照或子代理角色指令。 */
export const SUBAGENT_DELEGATION_POLICY = [
  "## 子代理委派策略",
  "- 复杂多步骤任务中，主动用 spawn_subagent 委派可独立的调查、跨模块定位、实现、验证或审查；跨多文件探索优先委派，单点已知查询和小修改直接做。",
  "- 独立任务在同一响应中发起多个 spawn_subagent 以并行执行；有依赖的任务按报告有序推进，不重复已委派的调查。",
  "- task 须自包含目标、范围、线索、约束与期望输出；写入任务限定独占文件，遵守现有权限与审批，不得越权。",
  "- 并行仅限同轮派发，轮末等待全部报告后主模型才继续，不是真异步；失败时诚实说明并修正重试或自行接手，不把失败当作完成。",
].join("\n");

/** 单任务子代理并发上限默认值（spec：默认 3，设置页可配） */
export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 3;

/** 运行时子代理设置（设置页全局配置的内存快照，逐次解析以便改动即时生效） */
export interface SubagentRuntimeSettings {
  maxConcurrent: number;
}

/**
 * 宿主注入的子代理配置（desktop 主进程装配；测试注入 mock 模型）。
 * tools 为子代理可用的工具集——编排器还会再剔除 spawn_subagent 一次（防递归双保险）。
 * 工厂函数形式与主任务 tools 一致（工单 12）：每次委派时逐次解析，
 * MCP 工具启停、server 断线/重连对下一个子代理即时生效。
 */
export interface SubagentsConfig {
  /** 子代理可用工具（完整工具集，剔除 spawn_subagent 由编排器保证；支持工厂逐次解析） */
  tools: ToolDefinition[] | (() => ToolDefinition[]);
  /**
   * Provider Profile → 语言模型 工厂；缺省 OpenAI 兼容构造。
   * options 携带触发消息的思考档位快照（委派入队时捕获，全部轮次复用）；
   * 签名与主任务 languageModelFor 一致（思考档位 03）。
   */
  languageModelFor?: (
    profile: ProviderProfile,
    options: CreateLanguageModelOptions
  ) => LanguageModel;
  /** 逐次解析的运行时设置（并发上限）；改动对下一次委派生效 */
  settings(): SubagentRuntimeSettings;
  /**
   * 子代理工具轮次上限的逐次解析取值函数（执行设置 ADR 0017）：与主任务的
   * CreateAgentTaskOptions.toolRoundsLimit 同构的 resolver 范式——agent-core
   * 不依赖任何存储实现，宿主装配层注入内存缓存读取。单个子代理在开始运行时
   * 快照一次（生效语义「即时保存、回合开始快照」：运行中不受中途调小影响），
   * 排队未开跑的子代理按开跑时的值解析；未注入用默认 200
   * （DEFAULT_MAX_SUBAGENT_TOOL_ROUNDS，与设置层共用单一来源）。
   */
  toolRoundsLimit?: () => number;
  /**
   * 模型请求重试次数的逐次解析取值函数（GLOSSARY「执行设置」，ADR 0024；
   * 先例为 toolRoundsLimit 的 resolver 范式，agent-core 不依赖任何存储实现）：
   * 与主任务同款全局执行设置，作用于子代理全部模型请求。单个子代理在开始
   * 运行时快照一次（运行中不受设置页中途调整影响），排队未开跑的按开跑时
   * 的值解析；未注入用 DEFAULT_MODEL_MAX_RETRIES（=2，与 SDK 默认一致）。
   */
  modelMaxRetries?: () => number;
  /**
   * 子代理模型解析（票 02，ADR 0024 模型级）：设置页选到具体 (Profile, 模型)
   * 时返回 ResolvedModel 二元组（model 已由宿主用 resolveModelOf 归一）；
   * null = 同主模型——跟随主任务当前所用模型（同 Profile 同模型，取本次
   * sendMessage 归一后的二元组）。异步以允许宿主读取加密存储的 Profile。
   */
  resolveModel(): Promise<ResolvedModel | null>;
}

/**
 * 子代理记录持久化通道（ADR 0021）：宿主任务注入，编排器只写子代理表——
 * 票 01 为骨架行（入队即写 + 状态机推进），票 02 扩逐轮正文与逐条工具调用。
 */
export type SubagentPersistence = Pick<
  TaskPersistence,
  | "insertSubagent"
  | "updateSubagent"
  | "insertSubagentMessage"
  | "insertSubagentToolCall"
  | "addTaskUsage"
>;

/**
 * 任务（agent-task）向编排器提供的端口：审批状态、审批等待注册与事件出口。
 * 子代理与主任务共享冻结的审批模式与交互路由；任务授权不改变本轮
 * ToolContext 的文件访问边界。自动批准留痕经 requestInteraction 的
 * 控制器即时批准路径完成，端口不再单独读取授权状态。
 */
export interface SubagentHostPort {
  taskId: string;
  workspacePath: string;
  /**
   * 子代理骨架行持久化通道（ADR 0021）：「曾委派过」的事实从入队起落库，
   * 排队中被杀也有痕；启动更新 running、终态更新状态与完成时间。
   */
  persistence: SubagentPersistence;
  /** 读取所属主执行在发送时固定的审批模式，不读取下次发送偏好。 */
  approvalMode(): ApprovalMode;
  /** 本轮目录/规范快照；正文激活状态由子代理独立创建，绝不复制主任务正文。 */
  resources?(): AgentResourceSnapshot | undefined;
  /**
   * 子代理的命令审批：注册等待（主任务 waiter 表）并以 approval-request 事件
   * 推给 UI（request.subagentId 标注来源）；resolve 由 respondApproval 触发。
   */
  requestInteraction(
    request:
      | Omit<
          Extract<InteractionRequest, { kind: "questions" }>,
          "id" | "taskId" | "turnId" | "createdAt"
        >
      | Omit<
          Extract<InteractionRequest, { kind: "approval" }>,
          "id" | "taskId" | "turnId" | "createdAt"
        >
  ): Promise<InteractionRecord>;
  emit(event: TaskEvent): void;
  now(): string;
  generateId(): string;
}

/**
 * 子代理固定角色指令；运行时追加本轮共享资源规范与目录及工作计划/风格策略
 * （ADR 0023 静态注入，不复制主任务正文）。
 */
const SUBAGENT_SYSTEM_PROMPT = [
  "你是 CodexLike 的子代理：主任务把一项独立工作委派给你执行。",
  "- 你拥有独立上下文，看不到主任务历史，只会收到本条委派说明；",
  "- 你不能再委派子代理（没有 spawn_subagent 工具）；",
  "- 工作区与主任务相同，文件与命令边界一致；",
  "- 使用可用工具完成任务后，直接输出最终的中文文本报告——主任务只能看到这份报告，",
  "报告应包含结论、关键细节（文件路径/命令/数据）与未尽事项。",
].join("\n");

interface SubagentEntry {
  subagentId: string;
  /** 主任务 spawn_subagent 的宿主调用 ID（报告回流绑定键） */
  toolCallId: string;
  task: string;
  state: "queued" | "running" | "done";
  /**
   * 触发消息的思考档位快照（spec「子代理继承触发消息的档位」）：
   * 委派入队时从工具执行上下文捕获，排队等待、出队启动与全部
   * 模型/工具轮次均用它，不读 UI 当前值；缺省 auto。
   */
  thinkingEffort: ThinkingEffort;
  /** 最终报告（成功）或中文失败/中断原因 */
  output: string;
  isError: boolean;
}

export interface SubagentOrchestrator {
  /** spawn_subagent 工具定义（加入任务工具表） */
  readonly tool: ToolDefinition;
  wait(): Promise<void>;
  /** 是否还有未结束的子代理（queued 或 running） */
  hasPending(): boolean;
  /**
   * 委派的最终结果（报告/失败原因）：轮末等待后由任务取回，
   * 作为 spawn_subagent 的延迟 tool-result 落库并回填模型。
   */
  resultFor(toolCallId: string): ToolResult | undefined;
  /** 调用方完成持久化与协议回填后释放结果；resultFor 本身仍是非消费式读取。 */
  releaseResult(toolCallId: string): void;
}

/** 从工具参数中读取 command 字段（与 agent-task 的审批门同构） */
function commandOfToolInput(input: unknown): string | undefined {
  if (typeof input === "object" && input !== null && "command" in input) {
    const value = (input as Record<string, unknown>).command;
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '"<无法序列化的参数>"';
  }
}

/** 创建子代理编排器（由 createAgentTask 内部装配；port 即任务自身） */
export function createSubagentOrchestrator(
  config: SubagentsConfig,
  port: SubagentHostPort
): SubagentOrchestrator {
  // 子代理工具集：完整工具集但剔除 spawn_subagent（防递归；编排器侧的双保险）。
  // 逐次解析（工单 12 的工厂语义）：每次委派时重新取用，MCP 启停即时生效
  function resolveSubagentTools(): ToolDefinition[] {
    const resolved =
      typeof config.tools === "function" ? config.tools() : config.tools;
    return resolved.filter((tool) => tool.name !== SUBAGENT_TOOL_NAME);
  }

  // 工作计划工具（ADR 0023）：无外部依赖，编排器级单例——每次运行与 questionsTool
  // 同款强制并入子代理工具表（撞名拒绝见 runSubagent 内），复用主任务同一实现
  const planTool = createUpdatePlanTool();

  const modelFor = config.languageModelFor ?? createLanguageModelFromProfile;

  // 事件直接送主任务共享缓冲；仅跟踪运行 Promise，不再维护第二条事件队列。
  const running = new Set<Promise<void>>();
  const emit = port.emit;

  const entries = new Map<string, SubagentEntry>();
  /** 「同主模型」回退二元组：spawn 时暂存本次 sendMessage 的 (profile, model) */
  const fallbackModels = new Map<string, ResolvedModel>();

  function hasPending(): boolean {
    for (const entry of entries.values()) {
      if (entry.state === "queued" || entry.state === "running") {
        return true;
      }
    }
    return false;
  }

  function runningCount(): number {
    let count = 0;
    for (const entry of entries.values()) {
      if (entry.state === "running") {
        count += 1;
      }
    }
    return count;
  }

  /** 有空位则按 FIFO 让队首子代理开跑（委派时与子代理结束时各调用一次） */
  function startQueued(signal: AbortSignal | undefined): void {
    while (runningCount() < config.settings().maxConcurrent) {
      const next = [...entries.values()].find(
        (entry) => entry.state === "queued"
      );
      if (next === undefined) {
        return;
      }
      next.state = "running";
      port.persistence.updateSubagent(next.subagentId, {
        status: "running",
        startedAt: port.now(),
      });
      emit({
        type: "subagent-start",
        subagentId: next.subagentId,
        task: next.task,
        toolCallId: next.toolCallId,
      });
      // 后台运行：结束（成功/失败/中断）后释放槽位并推进队列
      const task = runSubagent(next, signal).finally(() => {
        running.delete(task);
        startQueued(signal);
      });
      running.add(task);
    }
  }

  /** 子代理审批门：与主任务审批门同构（复用 decideApproval + 主任务审批链路） */
  async function gateAndRun(
    definition: ToolDefinition,
    input: unknown,
    entry: SubagentEntry,
    signal: AbortSignal | undefined,
    toolCallId: string
  ): Promise<ToolResult> {
    if (signal?.aborted)
      return { output: "工具调用已取消，未执行", isError: true };
    const command = commandOfToolInput(input);
    const approvalMode = port.approvalMode();
    // 审批门按真实档位判定，不含 autoApprove（与主任务门同构，反馈2留痕）：
    // autoApprove 开启时本应询问的子代理调用也走交互通道即时批准并落库。
    const gate = decideApproval({
      mode: approvalMode,
      permission: definition.permission,
      toolName: definition.name,
      command,
    });

    if (gate.kind === "blocked") {
      return {
        output: `工具调用被审批策略拒绝：${gate.reason}`,
        isError: true,
      };
    }
    if (gate.kind === "ask") {
      const interaction = await port.requestInteraction({
        kind: "approval",
        toolCallId,
        source: {
          kind: "subagent",
          subagentId: entry.subagentId,
          task: entry.task,
        },
        toolName: definition.name,
        command: command ?? definition.name,
        commandWord: gate.commandWord,
      });
      const decision =
        interaction.response?.kind === "approval"
          ? interaction.response.decision
          : null;
      if (interaction.status === "cancelled" || signal?.aborted)
        return { output: "工具调用已取消，未执行", isError: true };
      if (decision === "reject") {
        return {
          output:
            "工具调用被用户拒绝：用户未批准子代理执行该命令。可以改用只读工具继续，或在报告中说明未完成的部分。",
          isError: true,
        };
      }
      // 授权由主任务交互控制器提交；此处不写遗留命令授权。
    }
    return runTool(definition, input, {
      workspacePath: port.workspacePath,
      approvalMode,
      // 工单 11：子代理与主任务共享同一任务级浏览器 context/Cookie
      taskId: port.taskId,
      toolCallId,
      signal,
    });
  }

  /** 子代理运行循环：独立上下文的 streamText 工具循环（结构与主任务循环同构） */
  async function runSubagent(
    entry: SubagentEntry,
    signal: AbortSignal | undefined
  ): Promise<void> {
    let output = "";
    let isError = false;
    let aborted = false;
    // 达到轮次上限被截断：报告须带标记，主模型据此知道工作未完成（不伪造成完成）
    let capped = false;
    // 工具轮次上限（执行设置 ADR 0017）：运行开始快照，声明在 try 外供截断标记
    // 使用（标记在终态区，不在 try 作用域内）；解析失败按默认值兜底
    let maxToolRounds = DEFAULT_MAX_SUBAGENT_TOOL_ROUNDS;
    // 模型请求重试次数（GLOSSARY「执行设置」，ADR 0024）：与轮次上限同一快照点
    // （运行开始时读取一次），声明在 try 外供失败报告文案使用
    let modelMaxRetries = DEFAULT_MODEL_MAX_RETRIES;
    // 本轮正文与思考缓冲（ADR 0021 票 02）：轮终态即写一行 subagent_messages
    // （轮边界即行边界）——思考的权威记录即在此表；spawn 行不再拼接
    // （票 04 contract 步：双份存储无消费者）
    let roundText = "";
    let roundReasoning = "";
    // 持久化失败不能因为 signal 已中断而被归类成正常取消。
    let roundPersistenceFailure: { error: unknown } | undefined;

    /**
     * 轮终态即写（票 02）：本轮正文与思考落一行，任意时刻强杀应用，
     * 已完成轮（含中断/截断轮的部分内容）都已在库；无内容不落空行。
     *
     * 轮边界口径的镜像在 ui 侧 appendSubagentTurnDelta（事件增量按
     * roundIndex 归并成同一套轮）：这里改轮边界（何时清零缓冲、何时
     * 落行）须同步核对那边与 subagentTurnBoundary 的口径一致。
     */
    function flushRound(): void {
      if (roundText === "" && roundReasoning === "") {
        return;
      }
      port.persistence.insertSubagentMessage({
        id: port.generateId(),
        taskId: port.taskId,
        subagentId: entry.subagentId,
        content: roundText,
        ...(roundReasoning ? { reasoning: roundReasoning } : {}),
        createdAt: port.now(),
      });
    }
    try {
      const snapshot = port.resources?.();
      const execution = snapshot?.createExecution(entry.subagentId);
      // 子代理工具表先于提示组装解析：终端会话策略按「终端四工具在表」条件
      // 注入（下方 questionsTool 强制并入沿用同一份解析结果）
      const subagentTools = resolveSubagentTools();
      const hasTerminalSessionTools = subagentTools.some(
        (tool) => tool.name === SPAWN_TERMINAL
      );
      const systemPrompt = [
        SUBAGENT_SYSTEM_PROMPT,
        snapshot?.systemPrompt ?? "",
        // 工作计划策略与通用风格条款静态注入子代理（ADR 0023 修订 ADR 0016
        // 仅主任务边界）：子代理无每轮 turnSystemPrompt 机制，复用主任务同一
        // 常量随 SUBAGENT_SYSTEM_PROMPT 一次性组装，不随轮次重复；终端会话
        // 策略（ADR 0033）同层条件注入，仅当工具表含终端四工具；风格条款
        // 殿后统摄表达方式（与主任务注入顺序同构）
        PLAN_USAGE_POLICY,
        hasTerminalSessionTools ? TERMINAL_USAGE_POLICY : "",
        TOOL_STYLE_POLICY,
      ]
        .filter(Boolean)
        .join("\n\n");
      // 模型解析（票 02 模型级）：设置页选到的具体 (Profile, 模型)；
      // null = 同主模型（spawn 时暂存的主任务二元组，同 Profile 同模型）
      const fallback = fallbackModels.get(entry.subagentId);
      const resolved = (await config.resolveModel()) ?? fallback;
      if (resolved === undefined) {
        throw new Error("未解析到子代理模型（Provider Profile）");
      }
      const { profile, model } = resolved;
      const messages: ModelMessage[] = [{ role: "user", content: entry.task }];
      // 快照点（执行设置 ADR 0017「回合开始快照」）：子代理开始运行时读取一次，
      // 运行中不受设置页中途调小影响；未注入用默认 200
      maxToolRounds =
        config.toolRoundsLimit?.() ?? DEFAULT_MAX_SUBAGENT_TOOL_ROUNDS;
      // 重试次数同一快照点（ADR 0024）：本子代理全部 streamText 与失败报告
      // 文案用同一值；未注入用默认 2
      modelMaxRetries = config.modelMaxRetries?.() ?? DEFAULT_MODEL_MAX_RETRIES;
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const questionsTool = createQuestionsTool((questions, toolCallId) =>
        port.requestInteraction({
          kind: "questions",
          questions,
          toolCallId,
          source: {
            kind: "subagent",
            subagentId: entry.subagentId,
            task: entry.task,
          },
        })
      );
      if (subagentTools.some((tool) => tool.name === questionsTool.name))
        throw new Error(`工具名称冲突：${questionsTool.name}`);
      subagentTools.push(questionsTool);
      // update_plan 强制并入（ADR 0023，同 questionsTool 模式）：宿主子代理
      // 工具撞名即拒绝；并入后资源快照 execution tools 再撞名由下方循环拒绝
      if (subagentTools.some((tool) => tool.name === planTool.name))
        throw new Error(`工具名称冲突：${planTool.name}`);
      subagentTools.push(planTool);
      const toolsByName = new Map(
        subagentTools.map((tool) => [tool.name, tool])
      );
      for (const tool of execution?.tools ?? []) {
        if (toolsByName.has(tool.name) || tool.name === SUBAGENT_TOOL_NAME) {
          throw new Error(`工具名称冲突：${tool.name}`);
        }
        toolsByName.set(tool.name, tool);
        subagentTools.push(tool);
      }
      const modelTools =
        subagentTools.length > 0 ? toModelTools(subagentTools) : undefined;
      let round = 0;

      let settled = false;
      while (!settled) {
        if (signal?.aborted) {
          aborted = true;
          break;
        }
        // 本轮缓冲清零：轮边界 = 一次流式生成（与主任务「一次 sendMessage 一轮」对齐）
        roundText = "";
        roundReasoning = "";
        const result = streamText({
          // 全部轮次复用入队时捕获的档位快照（运行中主任务切档不影响本任务）；
          // model 携带解析出的具体模型（票 02：设置指定或跟随主任务当前所用）
          model: modelFor(profile, {
            thinkingEffort: entry.thinkingEffort,
            model,
          }),
          system: systemPrompt,
          messages,
          tools: modelTools,
          abortSignal: signal,
          // 重试次数（执行设置）：运行开始快照，本子代理全部轮次复用
          maxRetries: modelMaxRetries,
        });

        const toolCalls: {
          hostCallId: string;
          providerCallId: string;
          toolName: string;
          input: unknown;
          invalid?: boolean;
          error?: unknown;
        }[] = [];
        try {
          for await (const part of result.fullStream) {
            if (part.type === "reasoning-delta") {
              // 思考与报告分离：只进子代理记录与展示，不进入模型上下文。
              roundReasoning += part.text;
              emit({
                type: "subagent-reasoning",
                subagentId: entry.subagentId,
                delta: part.text,
                // 轮键与 flushRound 的行边界同源（round 在工具轮后才递增）。
                roundIndex: round,
              });
            } else if (part.type === "text-delta") {
              output += part.text;
              roundText += part.text;
              emit({
                type: "subagent-text-delta",
                subagentId: entry.subagentId,
                delta: part.text,
                roundIndex: round,
              });
            } else if (part.type === "tool-call") {
              // 每次调用独立生成宿主 ID，不把 provider ID 当作跨轮/跨代理主键。
              toolCalls.push({
                hostCallId: port.generateId(),
                providerCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
                invalid: part.invalid,
                error: part.error,
              });
            } else if (part.type === "error") {
              throw part.error;
            } else if (part.type === "abort") {
              aborted = true;
            }
          }
        } finally {
          // 一次生成轮只有这一个收尾点：成功、abort、error part、迭代抛错
          // 都保存已展示内容；工具执行在此之后，异常不会重复写上一轮。
          try {
            flushRound();
          } catch (error) {
            roundPersistenceFailure = { error };
          }
        }
        if (roundPersistenceFailure) throw roundPersistenceFailure.error;

        // 任务用量（GLOSSARY「任务用量」，ADR 0029）：子代理本轮 usage 入任务的
        // 子代理列（并入任务总量口径，与主任务列分账）；尽力而为语义统一在
        // settleTaskUsage（未结算记 0，入账失败不影响生成）
        await settleTaskUsage(
          result.usage,
          (delta) => port.persistence.addTaskUsage(port.taskId, delta),
          "subagent"
        );

        if (aborted || toolCalls.length === 0) {
          settled = true;
          break;
        }
        round += 1;
        if (round > maxToolRounds) {
          capped = true;
          break;
        }

        // 与主任务一致：SDK 只提供 assistant 调用，结果由宿主唯一回填。
        messages.push(
          ...(await result.response).messages.filter(
            (message) => message.role === "assistant"
          )
        );

        // 逐个执行工具：进度事件 → 审批门 → 执行 → 进度事件
        const resultParts: ToolModelMessage["content"] = [];
        for (const call of toolCalls) {
          const base: ToolCallRecord = {
            id: call.hostCallId,
            taskId: port.taskId,
            toolName: call.toolName,
            arguments: safeJsonStringify(call.input),
            output: "",
            isError: false,
            createdAt: port.now(),
          };
          emit({
            type: "subagent-tool",
            subagentId: entry.subagentId,
            phase: "call",
            call: base,
          });

          const definition = toolsByName.get(call.toolName);
          let executed: ToolResult;
          if (definition === undefined) {
            executed = {
              output: `工具 ${call.toolName} 未注册（子代理不能再委派子代理），可用工具：${subagentTools.map((t) => t.name).join("、")}`,
              isError: true,
            };
          } else if (call.invalid) {
            const reason =
              call.error instanceof Error
                ? call.error.message
                : String(call.error);
            executed = {
              output: `工具 ${call.toolName} 参数无效，未执行：${reason}`,
              isError: true,
            };
          } else {
            executed = await gateAndRun(
              definition,
              call.input,
              entry,
              signal,
              call.hostCallId
            );
          }

          const completed = {
            ...base,
            output: executed.output,
            isError: executed.isError,
          };
          // 完成即写（ADR 0021 票 02）：与主代理 insertToolCall 同点同口径——
          // output 为工具自身截断后的结果，时间戳取调用发起时刻（base.createdAt）
          port.persistence.insertSubagentToolCall({
            id: completed.id,
            taskId: port.taskId,
            subagentId: entry.subagentId,
            toolName: completed.toolName,
            arguments: completed.arguments,
            output: completed.output,
            isError: completed.isError,
            createdAt: completed.createdAt,
          });
          emit({
            type: "subagent-tool",
            subagentId: entry.subagentId,
            phase: "result",
            call: completed,
          });
          resultParts.push({
            type: "tool-result",
            toolCallId: call.providerCallId,
            toolName: call.toolName,
            output: { type: "text", value: executed.output },
          });
        }

        // 工具结果作为 tool 消息回填，进入下一轮生成（与主任务循环一致）
        messages.push({ role: "tool", content: resultParts });
      }
    } catch (error) {
      if (roundPersistenceFailure) {
        const failure = roundPersistenceFailure.error;
        const reason =
          failure instanceof Error ? failure.message : String(failure);
        output = `子代理过程保存失败：${reason}`;
        isError = true;
      } else if (isAbortLike(error, signal)) {
        aborted = true;
      } else {
        // 子代理失败不崩主任务：失败原因作为报告回流，isError 标记
        // （重试耗尽文案携带运行开始快照的重试次数配置值，ADR 0024）
        output = `子代理执行失败：${describeModelError(error, modelMaxRetries)}`;
        isError = true;
      }
    }

    if (aborted) {
      // 中断：已生成的部分文本保留为报告；完全没产出则记为失败（原因可读）
      if (output.trim() === "") {
        output = "子代理已随主任务中断，未产出报告";
        isError = true;
      }
    } else if (output.trim() === "" && !isError && !capped) {
      output = "子代理已完成任务，但未产出文本报告";
    }
    if (capped) {
      // 截断标记携带运行开始时快照的上限值（文本结构不变，仅数字动态化）：
      // 主模型据此知道委派未全部完成，不伪造成完成
      const marker = `已达到子代理工具轮次上限（${maxToolRounds} 轮），工作被截断，未全部完成。`;
      output = output.trim() === "" ? marker : `${output}\n\n${marker}`;
    }

    entry.output = output;
    entry.isError = isError;
    entry.state = "done";
    fallbackModels.delete(entry.subagentId);
    // 骨架行终态更新（ADR 0021）：状态与完成时间随报告回流一并落库；
    // 进程内中断（随主任务 abort）同样走到这里——报告已回流即为终态，
    // interrupted 只属于重启收尾补记（残留 queued/running 行）
    port.persistence.updateSubagent(entry.subagentId, {
      status: isError ? "failed" : "completed",
      completedAt: port.now(),
    });
    emit({
      type: "subagent-report",
      subagentId: entry.subagentId,
      task: entry.task,
      report: output,
      ok: !isError,
    });
  }

  const tool: ToolDefinition = {
    name: SUBAGENT_TOOL_NAME,
    description:
      "复杂多步骤任务中，主动委派可独立的调查、跨模块定位、实现、验证或审查；跨多文件探索优先委派，单点已知查询和小修改直接做。" +
      "子代理拥有独立上下文与完整工具集（不可再委派），看不到主任务历史，完成后返回中文文本报告。" +
      "独立任务应在同一响应中调用多个 spawn_subagent 实现并行（并发上限见设置页），有依赖的任务须等前置报告后有序推进；不重复已委派的调查。" +
      "task 必须自包含目标、范围、线索、约束与期望输出；写入任务明确限定独占文件，避免并行写入冲突，遵守现有权限与审批，不得越权。" +
      "同轮工具派发后，轮末等待全部子代理报告再继续主模型，不是真异步，不支持跨轮后台通知。" +
      "失败时诚实说明未完成部分，根据错误修正任务重试或由主任务接手，不得伪造完成或验证证据。",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "自包含的任务描述：目标、范围、线索、约束与期望输出；涉及写入时列明独占文件和权限边界。",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
    // 委派本身是元操作：readonly 下放行（子代理内部工具仍受审批模式约束）
    permission: "readonly",
    async execute(args, context) {
      if (context.signal?.aborted)
        return { output: "委派已取消，未执行", isError: true };
      const task =
        typeof (args as { task?: unknown } | null)?.task === "string"
          ? (args as { task: string }).task.trim()
          : "";
      if (task === "") {
        return {
          output:
            "工具 spawn_subagent 执行失败：task 必须是非空字符串的任务描述",
          isError: true,
        };
      }
      const subagentId = port.generateId();
      const entry: SubagentEntry = {
        subagentId,
        toolCallId: context.toolCallId ?? subagentId,
        task,
        state: "queued",
        // 档位快照在入队时捕获（spec：排队任务不读出队时的新值）
        thinkingEffort: context.thinkingEffort ?? "auto",
        output: "",
        isError: false,
      };
      entries.set(subagentId, entry);
      if (context.profile !== undefined && context.model !== undefined) {
        // 「同主模型」= 同 Profile 同模型（票 02 细化）：暂存主任务发送时
        // 归一后的二元组，子代理运行时未配置具体模型则以此跟随
        fallbackModels.set(subagentId, {
          profile: context.profile,
          model: context.model,
        });
      }
      // 骨架行 queued 即写（ADR 0021）：入队瞬间插入，排队中被杀的委派
      // 也留有「曾委派过」的事实与委派说明；启动/终态只做状态更新
      port.persistence.insertSubagent({
        id: subagentId,
        taskId: port.taskId,
        task,
        status: "queued",
        queuedAt: port.now(),
        startedAt: null,
        completedAt: null,
      });
      emit({ type: "subagent-queued", subagentId, task });
      // 立即尝试占位开跑；并发上限满则留在 FIFO 队列（前一个结束时推进）
      startQueued(context.signal);
      // 占位输出：真实报告在任务轮末等待后作为延迟 tool-result 回填（见 resultFor）
      return {
        output:
          "已接受委派：子代理正在后台执行任务，完成后报告将回流到主任务。",
        isError: false,
      };
    },
  };

  return {
    tool,
    async wait() {
      while (running.size) await Promise.all([...running]);
    },
    hasPending,
    resultFor(toolCallId) {
      for (const entry of entries.values()) {
        if (entry.toolCallId === toolCallId && entry.state === "done") {
          // spawn 行瘦身（票 04 contract 步，ADR 0021）：回填的只有最终报告
          // （tool result 自包含性不变）；思考全文的权威记录在子代理侧
          // subagent_messages，不再随 spawn 行拼接（双份存储无消费者）
          return {
            output: entry.output,
            isError: entry.isError,
          };
        }
      }
      return undefined;
    },
    releaseResult(toolCallId) {
      for (const [id, entry] of entries) {
        if (entry.toolCallId === toolCallId && entry.state === "done") {
          entries.delete(id);
          return;
        }
      }
    },
  };
}
