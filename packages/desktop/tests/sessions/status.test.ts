import { describe, expect, it } from 'vitest';

import {
  buildSessionStatus,
  type SessionStatusInfo,
} from '../../src/sessions/status';
import type { AgentsMdDiscovery } from '@codexlike/agent-core/node';
import type { SessionRecord, StoredMessage } from '@codexlike/agent-core';

/** 工单 07：/status 的数据组装（token 估算 = 系统提示 + user/assistant 消息） */
function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 's1',
    title: 'demo',
    workspacePath: 'C:\\work\\demo',
    providerProfileId: 'profile-1',
    model: 'glm-4.7',
    status: 'idle',
    workspaceMode: 'local',
    approvalMode: 'suggest',
    archivedAt: null,
    createdAt: '2026-11-10T08:00:00.000Z',
    updatedAt: '2026-11-10T08:00:00.000Z',
    ...overrides,
  };
}

const emptyDiscovery: AgentsMdDiscovery = {
  sections: [],
  combined: '',
  truncated: false,
};

const messages: StoredMessage[] = [
  { id: 'm1', sessionId: 's1', role: 'user', content: '你好', createdAt: 't' },
  { id: 'm2', sessionId: 's1', role: 'assistant', content: '你好，有什么可以帮你？', createdAt: 't' },
  { id: 'm3', sessionId: 's1', role: 'error', content: '模型请求失败（HTTP 500）：x', createdAt: 't' },
];

describe('buildSessionStatus（/status 数据组装）', () => {
  it('返回模型、token 估算、消息数、AGENTS.md 来源与预留审批模式字段', () => {
    const discovery: AgentsMdDiscovery = {
      sections: [
        { source: 'global', path: 'C:\\Users\\u\\.codexlike\\AGENTS.md', content: '规范' },
      ],
      combined: '规范',
      truncated: false,
    };

    const status: SessionStatusInfo = buildSessionStatus({
      record: record(),
      messages,
      agentsMd: discovery,
      providerProfileName: 'GLM',
      latestCompact: null,
    });

    expect(status.model).toBe('glm-4.7');
    expect(status.providerProfileName).toBe('GLM');
    // 估算 = 系统提示 + user + assistant（error 不计入）。
    // 手工按估算规则算：'规范' 2 CJK → 2；'你好' 2 CJK → 2；
    // '你好，有什么可以帮你？' 11 个 CJK/全角字符 → ceil(11/1.5) = 8。合计 12。
    expect(status.estimatedContextTokens).toBe(12);
    expect(status.messageCount).toBe(2);
    expect(status.agentsMd).toEqual({
      sources: ['C:\\Users\\u\\.codexlike\\AGENTS.md'],
      truncated: false,
    });
    // 审批模式（工单 04）：/status 显示会话真实档位
    expect(status.approvalMode).toBe('suggest');
  });

  it('审批模式随会话记录透传（readonly / full）', () => {
    for (const mode of ['readonly', 'full'] as const) {
      const status = buildSessionStatus({
        record: record({ approvalMode: mode }),
        messages: [],
        agentsMd: emptyDiscovery,
        providerProfileName: null,
        latestCompact: null,
      });
      expect(status.approvalMode).toBe(mode);
    }
  });

  it('无 AGENTS.md、未发过消息的最小会话', () => {
    const status = buildSessionStatus({
      record: record({ model: null, providerProfileId: null }),
      messages: [],
      agentsMd: emptyDiscovery,
      providerProfileName: null,
      latestCompact: null,
    });
    expect(status.model).toBeNull();
    expect(status.estimatedContextTokens).toBe(0);
    expect(status.messageCount).toBe(0);
    expect(status.agentsMd).toBeNull();
  });

  it('AGENTS.md 超限截断时 truncated 标记透传', () => {
    const discovery: AgentsMdDiscovery = {
      sections: [{ source: 'global', path: 'g', content: 'c' }],
      combined: 'c',
      truncated: true,
    };
    const status = buildSessionStatus({
      record: record(),
      messages: [],
      agentsMd: discovery,
      providerProfileName: null,
      latestCompact: null,
    });
    expect(status.agentsMd).toEqual({ sources: ['g'], truncated: true });
  });
});

describe('buildSessionStatus 已压缩标记（工单 08）', () => {
  it('compact-summary 消息计入压缩后用量；latestCompact 透传摘要信息', () => {
    const compactedMessages: StoredMessage[] = [
      { id: 's1', sessionId: 's1', role: 'compact-summary', content: '摘要内容', createdAt: 't' },
      { id: 'm4', sessionId: 's1', role: 'user', content: '继续', createdAt: 't' },
    ];
    const status = buildSessionStatus({
      record: record(),
      messages: compactedMessages,
      agentsMd: emptyDiscovery,
      providerProfileName: null,
      latestCompact: {
        id: 'c1',
        sessionId: 's1',
        summary: '摘要内容',
        messagesCompacted: 8,
        createdAt: '2026-11-11T09:00:00.000Z',
      },
    });

    // 压缩后用量：摘要（4 CJK → 3）+ '继续'（2 CJK → 2）= 5；摘要按上下文消息计入
    expect(status.estimatedContextTokens).toBe(5);
    expect(status.messageCount).toBe(2);
    expect(status.compacted).toEqual({
      at: '2026-11-11T09:00:00.000Z',
      messagesCompacted: 8,
    });
  });

  it('从未压缩的会话 compacted 为 null', () => {
    const status = buildSessionStatus({
      record: record(),
      messages,
      agentsMd: emptyDiscovery,
      providerProfileName: null,
      latestCompact: null,
    });
    expect(status.compacted).toBeNull();
  });
});
