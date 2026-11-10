import { randomUUID } from 'node:crypto';

import {
  APICallError,
  RetryError,
  generateText,
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

import type { SessionPersistence } from './persistence';
import type {
  CompactRecord,
  CompactResult,
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
   * 本工单内工具默认放行；审批三档在工单 04 于 tool-call 与 tool-result 之间接入。
   */
  tools?: ToolDefinition[];
  /** 时间与 id 生成注入（测试用固定值） */
  now?: () => string;
  generateId?: () => string;
}

export interface AgentSession {
  readonly id: string;
  /** 会话记录快照（可序列化；最新状态以 SessionManager.list 为准） */
  readonly record: SessionRecord;
  /**
   * 发送一条用户消息并流式聚合模型回复为会话事件流。
   * 模型可多轮调用工具：每轮 tool-call → 执行（tool-call/tool-result 事件）→
   * 结果回填继续生成，直到最终文本回复。
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

/** 对话上下文只包含 user / assistant / compact-summary 消息；error 提示不进入模型 */
function toModelMessage(message: StoredMessage): ModelMessage {
  if (message.role === 'assistant') {
    return { role: 'assistant', content: message.content };
  }
  if (message.role === 'compact-summary') {
    // 摘要以 user 角色注入；包装标签与 compact 成功后的内存上下文保持一致（重启等价）
    return { role: 'user', content: composeCompactSummaryContext(message.content) };
  }
  // @引用 内容随消息持久化，恢复时重组进上下文（快照等价性：与发送时一致）
  return { role: 'user', content: composeUserContent(message.content, message.mentions) };
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

/** /compact 保留的最近原始对话轮数（工单 08） */
export const COMPACT_KEEP_ROUNDS = 3;

/** 摘要进入模型上下文的包装（XML 标签防注入；恢复与压缩后共用，保证重启等价） */
function composeCompactSummaryContext(summary: string): string {
  return `<compact-summary>\n以下是本会话此前对话历史的压缩摘要：\n${summary}\n</compact-summary>`;
}

/** 压缩请求的系统指令（一次性总结任务，不注入 AGENTS.md 的 coding 系统提示） */
const COMPACT_SYSTEM_PROMPT = [
  '你是对话历史压缩器。请把提供的会话历史压缩为一份摘要，',
  '供后续对话作为上下文继续任务。要求：',
  '- 保留任务目标、关键决策与结论、涉及的文件路径与命令、尚未完成的事项；',
  '- 丢弃寒暄、重复与无关内容；',
  '- 直接输出摘要正文，不要任何前后缀说明。',
].join('\n');

/** 把被压缩的上下文消息序列化为送模型的对话文本 */
function serializeContextForCompaction(messages: ModelMessage[]): string {
  const lines = messages.map((message) => {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    return `[${role}] ${message.content}`;
  });
  return `以下是一次 coding agent 会话的既有对话历史（按时间顺序）：\n\n${lines.join('\n\n')}`;
}

/**
 * 计算保留边界：上下文尾部 KEEP_ROUNDS 轮（一轮 = user 开头的一段）之前的部分可压缩。
 * 返回保留部分在 context 中的起始下标；整个上下文不足 KEEP_ROUNDS 轮时返回 0。
 */
function keptRoundsStart(context: ModelMessage[]): number {
  let rounds = 0;
  for (let i = context.length - 1; i >= 0; i -= 1) {
    if (context[i]!.role === 'user') {
      rounds += 1;
      if (rounds === COMPACT_KEEP_ROUNDS) {
        return i;
      }
    }
  }
  return 0;
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

  let busy = false;

  return {
    id: record.id,
    record,

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
          // @引用 随消息持久化：重启恢复后重组进模型上下文（快照等价性）
          mentions:
            mentions !== undefined && mentions.length > 0 ? mentions : undefined,
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

            // 逐个执行工具：tool-call 事件 → 执行 → tool-result 事件 + 落库
            // 审批拦截（工单 04）将插入在事件与执行之间
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

              // 中断可能发生在上一个事件产出与本工具执行之间（生成器在 yield 处暂停）：
              // 已 abort 的 signal 不会再触发 listener，这里显式短路，不再启动执行
              const definition = toolsByName.get(call.toolName);
              const executed =
                signal?.aborted === true
                  ? { output: '已被用户中断，未执行', isError: true }
                  : definition
                    ? await runTool(definition, call.input, {
                        workspacePath: record.workspacePath,
                        signal,
                      })
                    : {
                        output: `工具 ${call.toolName} 未注册，可用工具：${[...toolsByName.keys()].join('、')}`,
                        isError: true,
                      };

              const completed = { ...base, ...executed };
              persistence.insertToolCall(completed);
              yield { type: 'tool-result', call: completed };
              resultParts.push({
                type: 'tool-result',
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                output: { type: 'text', value: executed.output },
                // 失败语义已在 output 文本（「工具 X 执行失败：…」前缀），模型可读
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
          // 被用户中断的回复：持久化标记，重启恢复后 UI 仍显示中断点
          aborted: aborted || undefined,
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

    async compact({ profile }) {
      if (busy) {
        throw new Error('会话正在回复或压缩中，请等待完成后再操作');
      }
      const keptStart = keptRoundsStart(context);
      if (keptStart === 0) {
        throw new Error(
          `当前历史不超过最近 ${COMPACT_KEEP_ROUNDS} 轮，没有可压缩的内容`,
        );
      }
      busy = true;
      try {
        // 第一步（副本上生成）：请求当前模型压缩被替换的旧历史；失败直接抛出，
        // 库与内存上下文都未动，可原样重试
        const compactable = context.slice(0, keptStart);
        let summary = '';
        try {
          const result = await generateText({
            model: modelFor(profile),
            system: COMPACT_SYSTEM_PROMPT,
            prompt: [{ role: 'user', content: serializeContextForCompaction(compactable) }],
          });
          summary = result.text.trim();
        } catch (error) {
          throw new Error(describeModelError(error));
        }
        if (summary === '') {
          throw new Error('压缩失败：模型返回了空摘要，请重试');
        }

        // 第二步（成功才替换）：新历史 = 摘要 + 最近 3 轮原文（重新落库，
        // 新 id 与递增时间戳保证摘要卡片排在最前）；内存上下文同步替换为
        // 包装摘要 + 保留轮次的模型消息（@引用 附加内容随内存上下文保真）
        const keptContext = context.slice(keptStart);
        const storedContext = persistence
          .listMessages(record.id)
          .filter((message) => message.role === 'user' || message.role === 'assistant')
          .slice(-keptContext.length);
        // 被压缩轮次的工具调用记录随历史一起清理：边界 = 保留轮次最老一条消息的旧时间戳
        // （保留轮次自身的工具调用晚于其 user 消息，不受影响）
        const pruneToolCallsBefore = storedContext[0]?.createdAt;
        const summaryMessage: StoredMessage = {
          id: generateId(),
          sessionId: record.id,
          role: 'compact-summary',
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
          pruneToolCallsBefore,
        );
        context.splice(
          0,
          context.length,
          { role: 'user', content: composeCompactSummaryContext(summary) },
          ...keptContext,
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
