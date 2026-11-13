/**
 * 子代理编排（GLOSSARY「子代理」；spec「subagents」；工单 13）。
 *
 * spawn_subagent(task) 把调研/大范围搜索类任务委派给子代理：
 * - 独立上下文：固定系统指令 + 任务描述，不含主任务历史；
 * - 完整工具集但剔除 spawn_subagent（防递归，有测试）；
 * - 模型用全局子代理配置（SubagentsConfig.resolveProfile；null = 同主模型）；
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
import type { ProviderProfile } from "../provider/provider-profile";
import { runTool, toModelTools } from "../tools/registry";
import type {
  ToolCallRecord,
  ToolDefinition,
  ToolResult,
} from "../tools/types";

import { decideApproval, type ApprovalMode } from "./approval";
import { describeModelError, isAbortLike } from "./errors";
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

/** 子代理单次运行允许的工具轮次上限（与主任务 MAX_TOOL_ROUNDS 一致，防失控循环） */
const MAX_SUBAGENT_TOOL_ROUNDS = 16;

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
   * 子代理模型（Provider Profile 引用）：null = 同主模型（用本次 sendMessage 的 profile）。
   * 异步以允许宿主读取加密存储的 Profile。
   */
  resolveProfile(): Promise<ProviderProfile | null>;
}

/**
 * 任务（agent-task）向编排器提供的端口：审批状态、审批等待注册与事件出口。
 * 子代理与主任务共享冻结的审批模式、实时 autoApprove 和交互路由；
 * 任务授权不改变本轮 ToolContext 的文件访问边界。
 */
export interface SubagentHostPort {
  taskId: string;
  workspacePath: string;
  /** 读取所属主执行在发送时固定的审批模式，不读取下次发送偏好。 */
  approvalMode(): ApprovalMode;
  /** 实时读取所属任务的审批授权，不改变本轮路径权限。 */
  autoApprove?(): boolean;
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
          "id" | "sessionId" | "turnId" | "createdAt"
        >
      | Omit<
          Extract<InteractionRequest, { kind: "approval" }>,
          "id" | "sessionId" | "turnId" | "createdAt"
        >
  ): Promise<InteractionRecord>;
  emit(event: TaskEvent): void;
  now(): string;
  generateId(): string;
}

/** 子代理固定角色指令；运行时追加本轮共享资源规范与目录，不复制主任务正文。 */
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
  /** 主任务的 spawn_subagent tool call id（报告回流绑定键） */
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
  /**
   * 思考过程全文（票 02）：与报告分离累积，随 spawn_subagent 延迟 tool-result
   * 一并回流落库（tool_calls.reasoning 列），仅为恢复后展示；
   * 不回填模型（回填内容只有 output）。
   */
  reasoning: string;
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

  const modelFor = config.languageModelFor ?? createLanguageModelFromProfile;

  // 事件直接送主任务共享缓冲；仅跟踪运行 Promise，不再维护第二条事件队列。
  const running = new Set<Promise<void>>();
  const emit = port.emit;

  const entries = new Map<string, SubagentEntry>();
  /** 「同主模型」回退 Profile：spawn 时暂存本次 sendMessage 的 profile */
  const fallbackProfiles = new Map<string, ProviderProfile>();

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
    const gate = decideApproval({
      mode: approvalMode,
      autoApprove: port.autoApprove?.() ?? false,
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
      sessionId: port.taskId,
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
    // 思考与报告分离累积（票 02）：终态随 entry 一并回流（resultFor）
    let reasoning = "";
    try {
      const snapshot = port.resources?.();
      const execution = snapshot?.createExecution(entry.subagentId);
      const systemPrompt = [
        SUBAGENT_SYSTEM_PROMPT,
        snapshot?.systemPrompt ?? "",
      ]
        .filter(Boolean)
        .join("\n\n");
      // 模型解析：设置页的子代理 Profile；null = 同主模型（spawn 时暂存的任务 profile）
      const fallback = fallbackProfiles.get(entry.subagentId);
      const profile = (await config.resolveProfile()) ?? fallback;
      if (profile === undefined) {
        throw new Error("未解析到子代理模型（Provider Profile）");
      }
      const messages: ModelMessage[] = [{ role: "user", content: entry.task }];
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
      const subagentTools = resolveSubagentTools();
      if (subagentTools.some((tool) => tool.name === questionsTool.name))
        throw new Error(`工具名称冲突：${questionsTool.name}`);
      subagentTools.push(questionsTool);
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
        const result = streamText({
          // 全部轮次复用入队时捕获的档位快照（运行中主任务切档不影响本任务）
          model: modelFor(profile, { thinkingEffort: entry.thinkingEffort }),
          system: systemPrompt,
          messages,
          tools: modelTools,
          abortSignal: signal,
        });

        const toolCalls: {
          toolCallId: string;
          toolName: string;
          input: unknown;
        }[] = [];
        for await (const part of result.fullStream) {
          if (part.type === "reasoning-delta") {
            // 思考与报告分离：作为事件流出（嵌套卡片流式展示）并累积全文
            // （随终态报告回流落库，票 02）；不进入子代理消息上下文
            reasoning += part.text;
            emit({
              type: "subagent-reasoning",
              subagentId: entry.subagentId,
              delta: part.text,
            });
          } else if (part.type === "text-delta") {
            output += part.text;
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
          settled = true;
          break;
        }
        round += 1;
        if (round > MAX_SUBAGENT_TOOL_ROUNDS) {
          break;
        }

        messages.push(...(await result.response).messages);

        // 逐个执行工具：进度事件 → 审批门 → 执行 → 进度事件
        const resultParts: ToolModelMessage["content"] = [];
        for (const call of toolCalls) {
          const base: ToolCallRecord = {
            id: call.toolCallId,
            sessionId: port.taskId,
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
          } else {
            executed = await gateAndRun(
              definition,
              call.input,
              entry,
              signal,
              call.toolCallId
            );
          }

          const completed = {
            ...base,
            output: executed.output,
            isError: executed.isError,
          };
          emit({
            type: "subagent-tool",
            subagentId: entry.subagentId,
            phase: "result",
            call: completed,
          });
          resultParts.push({
            type: "tool-result",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: { type: "text", value: executed.output },
          });
        }

        // 工具结果作为 tool 消息回填，进入下一轮生成（与主任务循环一致）
        messages.push({ role: "tool", content: resultParts });
      }
    } catch (error) {
      if (isAbortLike(error, signal)) {
        aborted = true;
      } else {
        // 子代理失败不崩主任务：失败原因作为报告回流，isError 标记
        output = `子代理执行失败：${describeModelError(error)}`;
        isError = true;
      }
    }

    if (aborted) {
      // 中断：已生成的部分文本保留为报告；完全没产出则记为失败（原因可读）
      if (output.trim() === "") {
        output = "子代理已随主任务中断，未产出报告";
        isError = true;
      }
    } else if (output.trim() === "" && !isError) {
      output = "子代理已完成任务，但未产出文本报告";
    }

    entry.output = output;
    entry.isError = isError;
    entry.reasoning = reasoning;
    entry.state = "done";
    fallbackProfiles.delete(entry.subagentId);
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
        reasoning: "",
      };
      entries.set(subagentId, entry);
      if (context.profile !== undefined) {
        fallbackProfiles.set(subagentId, context.profile);
      }
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
          // 思考全文随报告一并回流（票 02）：任务侧落库进 tool_calls.reasoning 列；
          // 回填模型的仍只有 output
          return {
            output: entry.output,
            isError: entry.isError,
            ...(entry.reasoning ? { reasoning: entry.reasoning } : {}),
          };
        }
      }
      return undefined;
    },
  };
}
