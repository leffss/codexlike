/**
 * 子代理编排（GLOSSARY「子代理」；spec「subagents」；工单 13）。
 *
 * spawn_subagent(task) 把调研/大范围搜索类任务委派给子代理：
 * - 独立上下文：固定系统指令 + 任务描述，不含主会话历史；
 * - 完整工具集但剔除 spawn_subagent（防递归，有测试）；
 * - 模型用全局子代理配置（SubagentsConfig.resolveProfile；null = 同主模型）；
 * - 单会话并发上限（默认 3，设置页可配）：超出的委派 FIFO 排队；
 * - 子代理工具调用同样过当前审批模式（readonly 下子代理同样只读，
 *   suggest 下的命令经主会话审批链路暂停等待用户）；
 * - 完成后报告以文本回流主会话上下文（spawn_subagent 的工具结果）。
 *
 * 执行模型：spawn_subagent 的 execute 立即返回（接受委派），子代理在后台运行；
 * 会话工具循环在本轮工具全部派发后经 pump() 等待本轮全部子代理结束，
 * 再把真实报告作为延迟的 tool-result 落库与回填（见 agent-session 的轮末等待）。
 */
import {
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolModelMessage,
} from "ai";

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

import {
  decideApproval,
  type ApprovalDecision,
  type ApprovalMode,
  type ApprovalRequest,
} from "./approval";
import { describeModelError, isAbortLike } from "./errors";
import type { SessionEvent } from "./types";

/** spawn_subagent 工具名（子代理工具集按此名剔除，防递归） */
export const SUBAGENT_TOOL_NAME = "spawn_subagent";

/** 单会话子代理并发上限默认值（spec：默认 3，设置页可配） */
export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 3;

/** 子代理单次运行允许的工具轮次上限（与主会话 MAX_TOOL_ROUNDS 一致，防失控循环） */
const MAX_SUBAGENT_TOOL_ROUNDS = 16;

/** 运行时子代理设置（设置页全局配置的内存快照，逐次解析以便改动即时生效） */
export interface SubagentRuntimeSettings {
  maxConcurrent: number;
}

/**
 * 宿主注入的子代理配置（desktop 主进程装配；测试注入 mock 模型）。
 * tools 为子代理可用的工具集——编排器还会再剔除 spawn_subagent 一次（防递归双保险）。
 * 工厂函数形式与主会话 tools 一致（工单 12）：每次委派时逐次解析，
 * MCP 工具启停、server 断线/重连对下一个子代理即时生效。
 */
export interface SubagentsConfig {
  /** 子代理可用工具（完整工具集，剔除 spawn_subagent 由编排器保证；支持工厂逐次解析） */
  tools: ToolDefinition[] | (() => ToolDefinition[]);
  /**
   * Provider Profile → 语言模型 工厂；缺省 OpenAI 兼容构造。
   * options 携带触发消息的思考档位快照（委派入队时捕获，全部轮次复用）；
   * 签名与主会话 languageModelFor 一致（思考档位 03）。
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
 * 会话（agent-session）向编排器提供的端口：审批状态、审批等待注册与事件出口。
 * 子代理审批与主会话共用同一审批模式 / respondApproval 路由
 * （「总是允许」记忆已随三档重构移除，ADR 0004）。
 */
export interface SubagentHostPort {
  sessionId: string;
  workspacePath: string;
  /** 实时读取当前审批模式（切换对子代理的下一次工具调用立即生效） */
  approvalMode(): ApprovalMode;
  /** 本轮目录/规范快照；正文激活状态由子代理独立创建，绝不复制主会话正文。 */
  resources?(): AgentResourceSnapshot | undefined;
  /**
   * 子代理的命令审批：注册等待（主会话 waiter 表）并以 approval-request 事件
   * 推给 UI（request.subagentId 标注来源）；resolve 由 respondApproval 触发。
   */
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
  now(): string;
  generateId(): string;
}

/** 子代理固定角色指令；运行时追加本轮共享资源规范与目录，不复制主会话正文。 */
const SUBAGENT_SYSTEM_PROMPT = [
  "你是 CodexLike 的子代理：主会话把一项独立任务委派给你执行。",
  "- 你拥有独立上下文，看不到主会话历史，只会收到本条任务描述；",
  "- 你不能再委派子代理（没有 spawn_subagent 工具）；",
  "- 工作区与主会话相同，文件与命令边界一致；",
  "- 使用可用工具完成任务后，直接输出最终的中文文本报告——主会话只能看到这份报告，",
  "报告应包含结论、关键细节（文件路径/命令/数据）与未尽事项。",
].join("\n");

interface SubagentEntry {
  subagentId: string;
  /** 主会话的 spawn_subagent tool call id（报告回流绑定键） */
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
  /** spawn_subagent 工具定义（加入会话工具表） */
  readonly tool: ToolDefinition;
  /**
   * 会话侧注入事件（子代理的 approval-request / approval-resolved）：
   * 与子代理进度事件共用同一缓冲，保持时间线顺序（工具卡片 → 审批卡片 → 结果）。
   */
  pushEvent(event: SessionEvent): void;
  /**
   * 转发子代理事件直至全部结束（排队→运行→报告）。
   * 会话工具循环在轮末调用：内部 await 至全部子代理 settle，期间实时产出进度事件。
   */
  pump(): AsyncGenerator<SessionEvent>;
  /** 非阻塞取出事件缓冲（break/error 路径的兜底转发） */
  drain(): SessionEvent[];
  /** 是否还有未结束的子代理（queued 或 running） */
  hasPending(): boolean;
  /**
   * 委派的最终结果（报告/失败原因）：轮末等待后由会话取回，
   * 作为 spawn_subagent 的延迟 tool-result 落库并回填模型。
   */
  resultFor(toolCallId: string): ToolResult | undefined;
}

/** 从工具参数中读取 command 字段（与 agent-session 的审批门同构） */
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

/** 创建子代理编排器（由 createAgentSession 内部装配；port 即会话自身） */
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

  // 事件缓冲 + 唤醒（pump 的实时转发机制）
  const buffer: SessionEvent[] = [];
  let wake: (() => void) | null = null;

  function emit(event: SessionEvent): void {
    buffer.push(event);
    wake?.();
  }

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
      void runSubagent(next, signal).finally(() => startQueued(signal));
    }
  }

  /** 子代理审批门：与主会话审批门同构（复用 decideApproval + 主会话审批链路） */
  async function gateAndRun(
    definition: ToolDefinition,
    input: unknown,
    entry: SubagentEntry,
    signal: AbortSignal | undefined
  ): Promise<ToolResult> {
    const command = commandOfToolInput(input);
    const approvalMode = port.approvalMode();
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
      const request: ApprovalRequest = {
        id: port.generateId(),
        sessionId: port.sessionId,
        toolName: definition.name,
        command: command ?? definition.name,
        commandWord: gate.commandWord,
        createdAt: port.now(),
        subagentId: entry.subagentId,
      };
      const decision = await port.requestApproval(request);
      if (decision === "reject") {
        return {
          output:
            "工具调用被用户拒绝：用户未批准子代理执行该命令。可以改用只读工具继续，或在报告中说明未完成的部分。",
          isError: true,
        };
      }
      // always 与 approve 同效：不再写「总是允许」记忆（ADR 0004）
    }
    return runTool(definition, input, {
      workspacePath: port.workspacePath,
      approvalMode,
      // 工单 11：子代理与主会话共享同一会话级浏览器 context/Cookie
      sessionId: port.sessionId,
      signal,
    });
  }

  /** 子代理运行循环：独立上下文的 streamText 工具循环（结构与主会话循环同构） */
  async function runSubagent(
    entry: SubagentEntry,
    signal: AbortSignal | undefined
  ): Promise<void> {
    let output = "";
    let isError = false;
    let aborted = false;
    try {
      const snapshot = port.resources?.();
      const execution = snapshot?.createExecution(entry.subagentId);
      const systemPrompt = [
        SUBAGENT_SYSTEM_PROMPT,
        snapshot?.systemPrompt ?? "",
      ]
        .filter(Boolean)
        .join("\n\n");
      // 模型解析：设置页的子代理 Profile；null = 同主模型（spawn 时暂存的会话 profile）
      const fallback = fallbackProfiles.get(entry.subagentId);
      const profile = (await config.resolveProfile()) ?? fallback;
      if (profile === undefined) {
        throw new Error("未解析到子代理模型（Provider Profile）");
      }
      const messages: ModelMessage[] = [{ role: "user", content: entry.task }];
      const subagentTools = resolveSubagentTools();
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
        const result = streamText({
          // 全部轮次复用入队时捕获的档位快照（运行中主会话切档不影响本任务）
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
            // 思考与报告分离：只作为事件流出（嵌套卡片流式展示），
            // 不累积进报告文本、不进入子代理消息上下文
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
            sessionId: port.sessionId,
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
            executed = await gateAndRun(definition, call.input, entry, signal);
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

        // 工具结果作为 tool 消息回填，进入下一轮生成（与主会话循环一致）
        messages.push({ role: "tool", content: resultParts });
      }
    } catch (error) {
      if (isAbortLike(error, signal)) {
        aborted = true;
      } else {
        // 子代理失败不崩主会话：失败原因作为报告回流，isError 标记
        output = `子代理执行失败：${describeModelError(error)}`;
        isError = true;
      }
    }

    if (aborted) {
      // 中断：已生成的部分文本保留为报告；完全没产出则记为失败（原因可读）
      if (output.trim() === "") {
        output = "子代理已随主会话中断，未产出报告";
        isError = true;
      }
    } else if (output.trim() === "" && !isError) {
      output = "子代理已完成任务，但未产出文本报告";
    }

    entry.output = output;
    entry.isError = isError;
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
      "把一项独立任务（调研、大范围搜索、资料整理等）委派给后台子代理执行。" +
      "子代理拥有独立上下文与完整工具集（不可再委派子代理），完成后返回中文文本报告。" +
      "多个委派并行执行（并发上限见设置页），适合把大范围搜索从主会话上下文中卸载出去。" +
      "task 应当自包含：写清目标、范围与期望的报告内容（子代理看不到本会话历史）。",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "委派给子代理的任务描述（自包含：目标、范围、期望产出）",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
    // 委派本身是元操作：readonly 下放行（子代理内部工具仍受审批模式约束）
    permission: "readonly",
    async execute(args, context) {
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
      if (context.profile !== undefined) {
        fallbackProfiles.set(subagentId, context.profile);
      }
      emit({ type: "subagent-queued", subagentId, task });
      // 立即尝试占位开跑；并发上限满则留在 FIFO 队列（前一个结束时推进）
      startQueued(context.signal);
      // 占位输出：真实报告在会话轮末等待后作为延迟 tool-result 回填（见 resultFor）
      return {
        output:
          "已接受委派：子代理正在后台执行任务，完成后报告将回流到主会话。",
        isError: false,
      };
    },
  };

  return {
    tool,
    pushEvent(event) {
      emit(event);
    },
    drain() {
      return buffer.splice(0, buffer.length);
    },
    hasPending,
    resultFor(toolCallId) {
      for (const entry of entries.values()) {
        if (entry.toolCallId === toolCallId && entry.state === "done") {
          return { output: entry.output, isError: entry.isError };
        }
      }
      return undefined;
    },
    async *pump() {
      while (true) {
        while (buffer.length > 0) {
          yield buffer.shift()!;
        }
        if (!hasPending() && buffer.length === 0) {
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    },
  };
}
