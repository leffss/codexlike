import { describe, expect, it } from 'vitest';

import type { ProviderProfile } from '@codexlike/agent-core';

import {
  formatSessionStatus,
  matchProfilesForModelSwitch,
  planSlashCommand,
} from '../src/lib/slash-command-actions';
import type { SessionStatusInfo } from '@codexlike/desktop/ipc';

const profiles: ProviderProfile[] = [
  { id: 'p1', name: 'GLM', baseURL: 'https://a', apiKey: 'k', model: 'glm-4.7' },
  { id: 'p2', name: 'DeepSeek', baseURL: 'https://b', apiKey: 'k', model: 'deepseek-v4' },
  { id: 'p3', name: 'GLM 便宜档', baseURL: 'https://c', apiKey: 'k', model: 'glm-4.7-flash' },
];

/** 斜杠命令 → UI 动作的纯函数分发（命令与等效 UI 操作走同一 IPC 通道，ui 只做编排） */
describe('planSlashCommand', () => {
  it('/new：同工作区新会话', () => {
    expect(planSlashCommand({ name: 'new', argument: '' }, true)).toEqual({
      type: 'new-session',
    });
  });

  it('/rename 带参数 → rename；无参数 → 用法提示', () => {
    expect(planSlashCommand({ name: 'rename', argument: '修 bug' }, true)).toEqual({
      type: 'rename',
      title: '修 bug',
    });
    expect(planSlashCommand({ name: 'rename', argument: '' }, true)).toEqual({
      type: 'rename-missing-argument',
    });
  });

  it('/archive → archive；/status → status', () => {
    expect(planSlashCommand({ name: 'archive', argument: '' }, true)).toEqual({
      type: 'archive',
    });
    expect(planSlashCommand({ name: 'status', argument: '' }, true)).toEqual({
      type: 'status',
    });
  });

  it('除 /new 外的命令在没有会话时不可用', () => {
    expect(planSlashCommand({ name: 'status', argument: '' }, false)).toEqual({
      type: 'needs-session',
    });
    expect(planSlashCommand({ name: 'rename', argument: 'x' }, false)).toEqual({
      type: 'needs-session',
    });
    // /new 在无会话时也无法确定工作区
    expect(planSlashCommand({ name: 'new', argument: '' }, false)).toEqual({
      type: 'needs-session',
    });
  });
});

describe('matchProfilesForModelSwitch（/model 关键词匹配）', () => {
  it('唯一命中：按名称模糊匹配（含中文名）', () => {
    expect(matchProfilesForModelSwitch('deep', profiles)).toEqual({
      kind: 'unique',
      profile: profiles[1],
    });
  });

  it('多命中：列出候选交由用户再用一次 /model 精确指定', () => {
    const result = matchProfilesForModelSwitch('glm', profiles);
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates.map((p) => p.name)).toEqual(['GLM', 'GLM 便宜档']);
    }
  });

  it('空关键词与零命中：返回全部候选（无匹配时也列出可选项）', () => {
    expect(matchProfilesForModelSwitch('', profiles).kind).toBe('ambiguous');
    const none = matchProfilesForModelSwitch('不存在的模型', profiles);
    expect(none.kind).toBe('ambiguous');
    if (none.kind === 'ambiguous') {
      expect(none.candidates).toHaveLength(3);
    }
  });
});

describe('formatSessionStatus（/status 展示文案）', () => {
  it('包含模型、用量估算、消息数、AGENTS.md 来源与审批模式（中文档位说明）', () => {
    const text = formatSessionStatus({
      model: 'glm-4.7',
      providerProfileName: 'GLM',
      estimatedContextTokens: 1234,
      messageCount: 12,
      agentsMd: {
        sources: ['C:\\Users\\u\\.codexlike\\AGENTS.md', 'C:\\work\\demo\\AGENTS.md'],
        truncated: false,
      },
      approvalMode: 'suggest',
      compacted: null,
    } satisfies SessionStatusInfo);
    expect(text).toContain('模型：GLM · glm-4.7');
    expect(text).toContain('1234');
    expect(text).toContain('12');
    expect(text).toContain('AGENTS.md');
    expect(text).toContain('2 个来源');
    expect(text).toContain('审批模式：协作（suggest）：文件编辑自动应用，终端命令逐条审批');
  });

  it('readonly / full 档位的中文说明', () => {
    for (const [mode, expected] of [
      ['readonly', '只读（readonly）：禁止一切写入与终端命令'],
      ['full', '自主（full）：全自动执行'],
    ] as const) {
      const text = formatSessionStatus({
        model: null,
        providerProfileName: null,
        estimatedContextTokens: 0,
        messageCount: 0,
        agentsMd: null,
        approvalMode: mode,
        compacted: null,
      } satisfies SessionStatusInfo);
      expect(text).toContain(expected);
    }
  });

  it('未发现 AGENTS.md、未选模型时的降级文案', () => {
    const text = formatSessionStatus({
      model: null,
      providerProfileName: null,
      estimatedContextTokens: 0,
      messageCount: 0,
      agentsMd: null,
      approvalMode: 'suggest',
      compacted: null,
    } satisfies SessionStatusInfo);
    expect(text).toContain('未选择');
    expect(text).toContain('未发现');
  });
});

/** 工单 08：/compact 命令分发与 /status 已压缩文案 */
describe('/compact（手动压缩）ui 分发', () => {
  it('/compact → compact 动作；无会话时 needs-session', () => {
    expect(planSlashCommand({ name: 'compact', argument: '' }, true)).toEqual({
      type: 'compact',
    });
    expect(planSlashCommand({ name: 'compact', argument: '' }, false)).toEqual({
      type: 'needs-session',
    });
  });

  it('formatSessionStatus：已压缩时显示「已压缩」标记与压缩后用量', () => {
    const text = formatSessionStatus({
      model: 'glm-4.7',
      providerProfileName: 'GLM',
      estimatedContextTokens: 210,
      messageCount: 7,
      agentsMd: null,
      approvalMode: 'suggest',
      compacted: { at: '2026-11-11T09:00:00.000Z', messagesCompacted: 8 },
    } satisfies SessionStatusInfo);
    expect(text).toContain('已压缩');
    expect(text).toContain('8');
    expect(text).toContain('210');
  });

  it('formatSessionStatus：未压缩时不显示压缩标记', () => {
    const text = formatSessionStatus({
      model: null,
      providerProfileName: null,
      estimatedContextTokens: 0,
      messageCount: 0,
      agentsMd: null,
      approvalMode: 'suggest',
      compacted: null,
    } satisfies SessionStatusInfo);
    expect(text).not.toContain('已压缩');
  });
});
