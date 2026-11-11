import {
  estimateTokens,
  type AgentsMdDiscovery,
  type ApprovalMode,
  type CompactRecord,
  type SessionRecord,
  type StoredMessage,
} from '@codexlike/agent-core/node';

/** /status 展示的会话状态（工单 07；审批模式自工单 04 起显示真实档位） */
export interface SessionStatusInfo {
  /** 最近一次发送消息所用模型 */
  model: string | null;
  providerProfileName: string | null;
  /**
   * 上下文 token 用量估算：系统提示（AGENTS.md）+ user/assistant 消息
   * （error 提示不进模型上下文，也不计入）。估算函数与 compact（工单 08）共用。
   * 压缩后为压缩后用量（compact-summary 摘要按上下文消息计入）。
   */
  estimatedContextTokens: number;
  /**
   * 最近一次发送消息所用模型的上下文窗口（tokens，来自 Provider Profile 的可选配置）；
   * Profile 未配置或已删除时为 null——UI 按 agent-core 默认值（128k）计算告警阈值。
   */
  contextWindowTokens: number | null;
  /** 进入上下文估算的消息条数（user + assistant + compact-summary） */
  messageCount: number;
  /** AGENTS.md 来源摘要；未发现任何文件为 null */
  agentsMd: { sources: string[]; truncated: boolean } | null;
  /** /compact 已压缩标记（最近一次压缩）；从未压缩为 null（工单 08） */
  compacted: { at: string; messagesCompacted: number } | null;
  /** 审批模式（工单 04）：readonly / suggest / full */
  approvalMode: ApprovalMode;
}

/**
 * 组装 /status 数据（纯函数，输入来自持久层与 AGENTS.md 发现）。
 */
export function buildSessionStatus(input: {
  record: SessionRecord;
  messages: StoredMessage[];
  agentsMd: AgentsMdDiscovery;
  providerProfileName: string | null;
  /** 最近一次发送消息所用 Profile 的上下文窗口（未配置/无 Profile 传 null） */
  contextWindowTokens?: number | null;
  /** 最近一次 compact 记录（listCompacts 末条）；未压缩传 null */
  latestCompact: CompactRecord | null;
}): SessionStatusInfo {
  const { record, messages, agentsMd } = input;
  const contextMessages = messages.filter(
    (message) =>
      message.role === 'user' ||
      message.role === 'assistant' ||
      message.role === 'compact-summary',
  );
  const estimated =
    estimateTokens(agentsMd.combined) +
    contextMessages.reduce((sum, message) => sum + estimateTokens(message.content), 0);

  return {
    model: record.model,
    providerProfileName: input.providerProfileName,
    estimatedContextTokens: estimated,
    contextWindowTokens: input.contextWindowTokens ?? null,
    messageCount: contextMessages.length,
    agentsMd:
      agentsMd.sections.length === 0
        ? null
        : {
            sources: agentsMd.sections.map((section) => section.path),
            truncated: agentsMd.truncated,
          },
    compacted:
      input.latestCompact === null
        ? null
        : {
            at: input.latestCompact.createdAt,
            messagesCompacted: input.latestCompact.messagesCompacted,
          },
    approvalMode: record.approvalMode,
  };
}
