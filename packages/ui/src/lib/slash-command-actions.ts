import {
  fuzzyMatch,
  type ProviderProfile,
  type SlashCommandName,
} from '@codexlike/agent-core';

import type { SessionStatusInfo } from '@codexlike/desktop/ipc';

/**
 * 斜杠命令 → UI 动作的纯函数分发。
 * 命令与等效 UI 操作最终走同一 IPC 通道（/rename ↔ 侧栏重命名、/archive ↔ 侧栏归档、
 * /model ↔ 模型选择器、/new ↔ 新建会话、/status ↔ status 查询），这里只做编排决策。
 */

export type SlashCommandAction =
  | { type: 'new-session' }
  | { type: 'compact' }
  | { type: 'rename'; title: string }
  | { type: 'rename-missing-argument' }
  | { type: 'archive' }
  | { type: 'select-model'; query: string }
  | { type: 'status' }
  | { type: 'needs-session' };

/** 所有命令都作用于「当前会话」（/new 也需要当前会话的工作区） */
export function planSlashCommand(
  command: { name: SlashCommandName; argument: string },
  hasSession: boolean,
): SlashCommandAction {
  if (!hasSession) {
    return { type: 'needs-session' };
  }
  switch (command.name) {
    case 'new':
      return { type: 'new-session' };
    case 'compact':
      return { type: 'compact' };
    case 'rename':
      return command.argument === ''
        ? { type: 'rename-missing-argument' }
        : { type: 'rename', title: command.argument };
    case 'archive':
      return { type: 'archive' };
    case 'model':
      return { type: 'select-model', query: command.argument };
    case 'status':
      return { type: 'status' };
  }
}

/** /model 关键词匹配：在 name + model 文本上模糊匹配 */
export type ModelSwitchMatch =
  | { kind: 'unique'; profile: ProviderProfile }
  | { kind: 'ambiguous'; candidates: ProviderProfile[] };

export function matchProfilesForModelSwitch(
  query: string,
  profiles: readonly ProviderProfile[],
): ModelSwitchMatch {
  const matched = fuzzyMatch(query, profiles, (profile) =>
    `${profile.name} ${profile.model}`,
  );
  if (matched.length === 1) {
    return { kind: 'unique', profile: matched[0]! };
  }
  // 多个命中：列出命中的候选；零命中（拼写误差）：列出全部供用户选择
  return {
    kind: 'ambiguous',
    candidates: matched.length === 0 ? [...profiles] : matched,
  };
}

/** 审批模式 → /status 中文文案（GLOSSARY「审批模式」） */
const APPROVAL_MODE_LABELS: Record<SessionStatusInfo['approvalMode'], string> = {
  readonly: '只读（readonly）：禁止一切写入与终端命令',
  suggest: '协作（suggest）：文件编辑自动应用，终端命令逐条审批',
  full: '自主（full）：全自动执行',
};

/** /status 展示文案（中文） */
export function formatSessionStatus(status: SessionStatusInfo): string {
  const model =
    status.model === null
      ? '未选择（发送消息后记录所用模型）'
      : `${status.providerProfileName ?? '未知 Profile'} · ${status.model}`;
  const agentsMd =
    status.agentsMd === null
      ? '未发现 AGENTS.md'
      : `${status.agentsMd.sources.length} 个来源${
          status.agentsMd.truncated ? '（总量超 32 KiB 已截断）' : ''
        }`;
  const compacted =
    status.compacted === null
      ? '未压缩'
      : `已压缩（${status.compacted.at.replace('T', ' ').slice(0, 19)}，压缩了 ${status.compacted.messagesCompacted} 条历史消息）`;
  return [
    '会话状态（/status）',
    `模型：${model}`,
    `上下文用量（估算）：约 ${status.estimatedContextTokens} tokens（${status.messageCount} 条消息 + 系统提示）`,
    `压缩状态：${compacted}`,
    `AGENTS.md：${agentsMd}`,
    `审批模式：${APPROVAL_MODE_LABELS[status.approvalMode]}`,
  ].join('\n');
}
