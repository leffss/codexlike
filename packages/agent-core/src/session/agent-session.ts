import { randomUUID } from 'node:crypto';

import {
  APICallError,
  RetryError,
  jsonSchema,
  streamText,
  tool as aiTool,
  type LanguageModel,
  type ModelMessage,
  type Tool,
  type ToolModelMessage,
} from 'ai';

import { createLanguageModelFromProfile } from '../provider/language-model';
import type { ProviderProfile } from '../provider/provider-profile';
import { runTool } from '../tools/registry';
import type { ToolCallRecord, ToolDefinition } from '../tools/types';

import {
  commandFirstWord,
  decideApproval,
  type ApprovalDecision,
  type ApprovalMode,
  type ApprovalRequest,
} from './approval';
import type { SessionPersistence } from './persistence';
import type {
  MentionAttachment,
  SessionEvent,
  SessionRecord,
  StoredMessage,
} from './types';

/** 发送消息的输入：文本 + 本条消息使用的 Provider Profile（模型选择器「对下一条生效」） */
export interface SendMessageOptions {
  text: string;
  profile: ProviderProfile;
  /** @引用 的工作区文件；内容附加进本条消息的模型上下文（落库与回显保持原文） */
  mentions?: MentionAttachment[];
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
  /** Provider Profile → 语言模型 的工厂；测试注入 mock，默认走 OpenAI 兼容构造 */
  languageModelFor?: (profile: ProviderProfile) => LanguageModel;
  /**
   * 会话可用的工具（spec「工具注册表」）。空数组或缺省 = 纯对话（02 的行为）。
   * 工具执行前经审批门（工单 04）：readonly 拒绝、suggest 命令审批、full 全放行。
   */
  tools?: ToolDefinition[];
  /** 初始审批模式（缺省用 record.approvalMode） */
  approvalMode?: ApprovalMode;
  /** 恢复会话时传入的历史「总是允许」记忆（命令首词，随会话入库） */
  approvalMemory?: string[];
  /** 时间与 id 生成注入（测试用固定值） */
  now?: () => string;
  generateId?: () => string;
}

export interface AgentSession {
  readonly id: string;
  /** 会话记录快照（可序列化；最新状态以 SessionManager.list 为准） */
  readonly record: SessionRecord;
  /** 当前等待用户审批的请求；无等待时为 null（UI 切回会话时恢复审批卡片） */
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
}

/** 单次回复允许的工具轮次上限（防模型失控循环） */
const MAX_TOOL_ROUNDS = 16;

/** 把 error 消息转成用户可读的中文提示（保留原始报错原文） */
function describeModelError(error: unknown): string {
  if (error instanceof APICallError) {
    const where = error.statusCode === undefined ? '网络错误' : `HTTP ${error.statusCode}`;
    return `模型请求失败（${where}）：${error.message}`;
  }
  if (error instanceof RetryError) {
    return `模型请求失败（已重试 ${error.errors.length} 次）：${describeModelError(error.lastError)}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `模型请求失败：${message}`;
}

function isAbortLike(error: unknown, signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

/** 对话上下文只包含 user / assistant 消息；error 提示不进入模型 */
function toModelMessage(message: StoredMessage): ModelMessage {
  if (message.role === 'assistant') {
    return { role: 'assistant', content: message.content };
  }
  return { role: 'user', content: message.content };
}

/** 工具定义 → ai SDK 的 tools 参数（不带 execute：执行由会话循环掌控，事件与落库都在循环内发生） */
function toModelTools(tools: ToolDefinition[]): Record<string, Tool> {
  const entries = tools.map((definition) => [
    definition.name,
    aiTool({
      description: definition.description,
      inputSchema: jsonSchema(definition.parameters),
    }),
  ]);
  return Object.fromEntries(entries);
}

/**
 * 组装发给模型的用户消息内容：原文 + @引用 文件内容（XML 标签 + 路径标注，
 * 内容含反引号等 markdown 语法也不会破坏结构）。
 */
function composeUserContent(
  text: string,
  mentions: MentionAttachment[] | undefined,
): string {
  if (mentions === undefined || mentions.length === 0) {
    return text;
  }
  const blocks = mentions
    .map(
      (mention) =>
        `<attached-file path="${mention.path}">\n${mention.content}\n</attached-file>`,
    )
    .join('\n');
  return `${text}\n\n以下为该消息 @引用 的工作区文件内容：\n\n${blocks}`;
}

/** 从工具参数中安全读取 command 字段（run_terminal_command 的命令原文） */
function commandOfToolInput(input: unknown): string | undefined {
  if (typeof input === 'object' && input !== null && 'command' in input) {
    const value = (input as Record<string, unknown>).command;
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

/** 创建会话对象（纯 agent-core，不依赖 Electron；持久化经接口注入） */
export function createAgentSession(options: CreateAgentSessionOptions): AgentSession {
  const { record, persistence } = options;
  // 模型上下文与持久化消息分离：user 消息进上下文时附加 @引用 内容，落库保持原文
  const context: ModelMessage[] = options.history
    ? options.history.filter((message) => message.role !== 'error').map(toModelMessage)
    : [];
  const systemPrompt = options.systemPrompt ?? '';
  const modelFor = options.languageModelFor ?? createLanguageModelFromProfile;
  const toolsByName = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
  const modelTools = toolsByName.size > 0 ? toModelTools([...toolsByName.values()]) : undefined;
  const now = options.now ?? (() => new Date().toISOString());
  const generateId = options.generateId ?? randomUUID;

  // 审批状态（工单 04）：模式随时可切（对下一次工具调用立即生效）；
  // 「总是允许」记忆 = 命令首词集合（恢复会话时从库读回）
  let approvalMode = options.approvalMode ?? record.approvalMode ?? 'suggest';
  const approvalMemory = new Set(options.approvalMemory ?? []);
  let pendingApproval: ApprovalRequest | null = null;
  let approvalWaiter: {
    requestId: string;
    resolve: (decision: ApprovalDecision) => void;
  } | null = null;

  let busy = false;

  return {
    id: record.id,
    record,
    get pendingApproval() {
      return pendingApproval;
    },

    setApprovalMode(mode) {
      approvalMode = mode;
      record.approvalMode = mode;
    },

    respondApproval(requestId, decision) {
      const waiter = approvalWaiter;
      if (waiter === null || waiter.requestId !== requestId) {
        return false;
      }
      approvalWaiter = null;
      pendingApproval = null;
      waiter.resolve(decision);
      return true;
    },

    async *sendMessage({ text, profile, mentions, signal }) {
      if (busy) {
        throw new Error('上一条消息仍在回复中，请等待完成后再发送');
      }
      busy = true;
      try {
        // 模型选择对本次及后续消息生效，落库
        persistence.updateSession(record.id, {
          providerProfileId: profile.id,
          model: profile.model,
          status: 'streaming',
          updatedAt: now(),
        });

        const userMessage: StoredMessage = {
          id: generateId(),
          sessionId: record.id,
          role: 'user',
          content: text,
          createdAt: now(),
        };
        persistence.insertMessage(userMessage);
        yield { type: 'user-message', message: userMessage };

        const assistantMessageId = generateId();
        yield { type: 'assistant-start', messageId: assistantMessageId };

        // 本条消息进模型上下文：原文 + @引用 内容；落库与事件保持原文
        const userContextMessage: ModelMessage = {
          role: 'user',
          content: composeUserContent(text, mentions),
        };

        let accumulated = '';
        let aborted = false;
        try {
          // 工具循环：模型调工具 → 执行 → 结果回填 → 继续生成，直到最终文本（或中断/上限）
          // 初始上下文 = 历史消息 + 本条用户消息（原文 + @引用 内容）；system 为 AGENTS.md 注入
          const pending: ModelMessage[] = [...context, userContextMessage];
          let round = 0;

          while (true) {
            const result = streamText({
              model: modelFor(profile),
              system: systemPrompt === '' ? undefined : systemPrompt,
              messages: pending,
              abortSignal: signal,
              tools: modelTools,
            });

            const toolCalls: { toolCallId: string; toolName: string; input: unknown }[] = [];
            for await (const part of result.fullStream) {
              if (part.type === 'text-delta') {
                accumulated += part.text;
                yield {
                  type: 'assistant-delta',
                  messageId: assistantMessageId,
                  delta: part.text,
                };
              } else if (part.type === 'tool-call') {
                toolCalls.push({
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  input: part.input,
                });
              } else if (part.type === 'error') {
                throw part.error;
              } else if (part.type === 'abort') {
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

            // 逐个执行工具：tool-call 事件 → 审批门（工单 04）→ 执行 → tool-result 事件 + 落库
            const resultParts: ToolModelMessage['content'] = [];
            for (const call of toolCalls) {
              const base: ToolCallRecord = {
                id: call.toolCallId,
                sessionId: record.id,
                toolName: call.toolName,
                arguments: safeJsonStringify(call.input),
                output: '',
                isError: false,
                createdAt: now(),
              };
              yield { type: 'tool-call', call: base };

              const definition = toolsByName.get(call.toolName);
              let output: string;
              let isError: boolean;

              if (definition === undefined) {
                output = `工具 ${call.toolName} 未注册，可用工具：${[...toolsByName.keys()].join('、')}`;
                isError = true;
              } else {
                // 审批门（插在 tool-call 事件与执行之间）：
                // readonly 拒绝 / suggest 命令审批 / full 放行（见 decideApproval）
                const command = commandOfToolInput(call.input);
                const gate = decideApproval({
                  mode: approvalMode,
                  permission: definition.permission,
                  toolName: definition.name,
                  command,
                  memory: approvalMemory,
                });

                if (gate.kind === 'blocked') {
                  output = `工具调用被审批策略拒绝：${gate.reason}`;
                  isError = true;
                } else if (gate.kind === 'ask') {
                  // 暂停等待审批：落库 waiting-approval → 事件流出卡片 →
                  // await 外部 respondApproval 唤醒（desktop 经 IPC 桥接 UI 三键）
                  const request: ApprovalRequest = {
                    id: call.toolCallId,
                    sessionId: record.id,
                    toolName: call.toolName,
                    command: command ?? call.toolName,
                    commandWord: gate.commandWord,
                    createdAt: now(),
                  };
                  persistence.updateSession(record.id, {
                    status: 'waiting-approval',
                    updatedAt: now(),
                  });
                  pendingApproval = request;
                  let resolveDecision!: (decision: ApprovalDecision) => void;
                  const decisionPromise = new Promise<ApprovalDecision>((resolve) => {
                    resolveDecision = resolve;
                  });
                  approvalWaiter = { requestId: request.id, resolve: resolveDecision };
                  // 中断防御：等待审批时被中断（06 打断）视为拒绝，避免生成器永久卡死
                  const onAbort = () => resolveDecision('reject');
                  signal?.addEventListener('abort', onAbort, { once: true });
                  let decision: ApprovalDecision;
                  try {
                    yield { type: 'approval-request', request };
                    decision = await decisionPromise;
                  } finally {
                    signal?.removeEventListener('abort', onAbort);
                    approvalWaiter = null;
                    pendingApproval = null;
                    persistence.updateSession(record.id, {
                      status: 'streaming',
                      updatedAt: now(),
                    });
                  }
                  yield { type: 'approval-resolved', requestId: request.id, decision };

                  if (decision === 'reject') {
                    output =
                      '工具调用被用户拒绝：用户未批准在当前会话执行该命令。可以改用只读工具继续，或向用户说明计划并询问如何调整。';
                    isError = true;
                  } else {
                    if (decision === 'always') {
                      // 本会话总是允许：记忆命令首词（随会话入库，恢复后仍生效）
                      approvalMemory.add(gate.commandWord);
                      persistence.insertApproval(record.id, gate.commandWord);
                    }
                    const executed = await runTool(definition, call.input, {
                      workspacePath: record.workspacePath,
                      signal,
                    });
                    output = executed.output;
                    isError = executed.isError;
                  }
                } else {
                  const executed = await runTool(definition, call.input, {
                    workspacePath: record.workspacePath,
                    signal,
                  });
                  output = executed.output;
                  isError = executed.isError;
                }
              }

              const completed = { ...base, output, isError };
              persistence.insertToolCall(completed);
              yield { type: 'tool-result', call: completed };
              resultParts.push({
                type: 'tool-result',
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                output: { type: 'text', value: output },
                // 失败语义已在 output 文本（拒绝 /「工具 X 执行失败：…」前缀），模型可读
              });
            }

            // 工具结果作为 tool 消息回填，进入下一轮生成
            pending.push({ role: 'tool', content: resultParts });
          }
        } catch (error) {
          if (isAbortLike(error, signal)) {
            aborted = true;
          } else {
            // 错误路径：中文提示落库并广播；不进入对话上下文，会话可继续使用
            const errorMessage: StoredMessage = {
              id: generateId(),
              sessionId: record.id,
              role: 'error',
              content: describeModelError(error),
              createdAt: now(),
            };
            persistence.insertMessage(errorMessage);
            yield { type: 'error', message: errorMessage };
            return;
          }
        }

        const assistantMessage: StoredMessage = {
          id: assistantMessageId,
          sessionId: record.id,
          role: 'assistant',
          content: accumulated,
          createdAt: now(),
        };
        persistence.insertMessage(assistantMessage);
        context.push(userContextMessage, {
          role: 'assistant',
          content: accumulated,
        });
        yield aborted
          ? { type: 'assistant-aborted', message: assistantMessage }
          : { type: 'assistant-done', message: assistantMessage };
      } finally {
        persistence.updateSession(record.id, { status: 'idle', updatedAt: now() });
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
