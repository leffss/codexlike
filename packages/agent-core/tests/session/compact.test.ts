import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';

import type { ProviderProfile } from '../../src/provider/provider-profile';
import { createSqliteSessionStore } from '../../src/session/persistence';
import { createAgentSession } from '../../src/session/agent-session';
import type { SessionEvent, SessionRecord } from '../../src/session/types';

/**
 * 工单 08：/compact 手动压缩（GLOSSARY「Compact」）。
 * Seam：AgentSession.compact 公共接口 + SessionPersistence（库行为经 listMessages/listCompacts 观察）
 * + MockLanguageModelV4 的调用记录（注入模型的请求内容）。
 */
const profile: ProviderProfile = {
  id: 'profile-1',
  name: 'GLM',
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: 'sk-test',
  model: 'glm-4.7',
};

function sessionRecord(): SessionRecord {
  return {
    id: 'session-1',
    title: 'demo',
    workspacePath: 'C:\\work\\demo',
    providerProfileId: null,
    model: null,
    status: 'idle',
    archivedAt: null,
    createdAt: '2026-11-11T08:00:00.000Z',
    updatedAt: '2026-11-11T08:00:00.000Z',
  };
}

/** ai v7 起流式文本必须包裹 text-start / text-end part */
function textStream(deltas: string[]): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'text-start', id: 'text-1' });
      for (const delta of deltas) {
        controller.enqueue({ type: 'text-delta', id: 'text-1', delta });
      }
      controller.enqueue({ type: 'text-end', id: 'text-1' });
      controller.enqueue({
        type: 'finish',
        usage: {
          inputTokens: {
            total: 1,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: 2,
            text: undefined,
            reasoning: undefined,
          },
        },
        finishReason: { unified: 'stop' as const, raw: 'stop' },
      });
      controller.close();
    },
  });
}

/**
 * 脚本化双通道模型：doStream 服务对话轮次（每次调用回显轮号），
 * doGenerate 服务压缩请求（返回固定摘要）。调用记录供断言注入的 prompt。
 */
function compactableModel(summaryText: string) {
  let streamCall = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      streamCall += 1;
      return { stream: textStream([`第${streamCall}轮回复`]) };
    },
    doGenerate: async () => ({
      content: [{ type: 'text', text: summaryText }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: {
          total: 1,
          noCache: undefined,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: {
          total: 2,
          text: undefined,
          reasoning: undefined,
        },
      },
      warnings: [],
    }),
  });
}

/** 固定时钟 + 递增秒 */
function fakeClock() {
  let tick = 0;
  return () => `2026-11-11T08:00:${String(++tick).padStart(2, '0')}.000Z`;
}

const tempStores: ReturnType<typeof createSqliteSessionStore>[] = [];

function memoryStore() {
  const store = createSqliteSessionStore(':memory:');
  tempStores.push(store);
  return store;
}

afterEach(() => {
  for (const store of tempStores.splice(0)) {
    store.close();
  }
});

/** 驱动 N 轮对话（user「第k轮问题」→ assistant「第k轮回复」） */
async function talkRounds(
  session: ReturnType<typeof createAgentSession>,
  rounds: number,
): Promise<void> {
  for (let i = 1; i <= rounds; i += 1) {
    const events: SessionEvent[] = [];
    for await (const event of session.sendMessage({
      text: `第${i}轮问题`,
      profile,
    })) {
      events.push(event);
    }
    if (events.at(-1)?.type !== 'assistant-done') {
      console.log('DEBUG 最后事件', JSON.stringify(events.at(-1)));
    }
    expect(events.at(-1)?.type).toBe('assistant-done');
  }
}

describe('AgentSession.compact（手动压缩）', () => {
  it('压缩成功：摘要替换旧历史，仅保留最近 3 轮原始对话，compact 记录入库', async () => {
    const persistence = memoryStore();
    persistence.insertSession(sessionRecord());
    const model = compactableModel('此前对话的压缩摘要：修复了登录 bug。');
    const session = createAgentSession({
      record: sessionRecord(),
      persistence,
      history: [],
      languageModelFor: () => model,
      now: fakeClock(),
      generateId: (() => {
        let n = 0;
        return () => `id-${String(++n).padStart(3, '0')}`;
      })(),
    });

    await talkRounds(session, 5);

    const result = await session.compact({ profile });

    // 压缩请求确实带上了被压缩的旧历史（前 2 轮），且不含将被保留的后 3 轮
    const generateCall = model.doGenerateCalls.at(-1)!;
    expect(JSON.stringify(generateCall.prompt)).toContain('第1轮问题');
    expect(JSON.stringify(generateCall.prompt)).toContain('第2轮问题');
    expect(JSON.stringify(generateCall.prompt)).toContain('第2轮回复');
    expect(JSON.stringify(generateCall.prompt)).not.toContain('第4轮问题');

    // 库中消息历史 = 1 条摘要 + 最近 3 轮（6 条原文，顺序在前的是更早轮次）
    const stored = persistence.listMessages('session-1');
    expect(stored).toHaveLength(7);
    expect(stored[0]).toMatchObject({
      role: 'compact-summary',
      content: '此前对话的压缩摘要：修复了登录 bug。',
    });
    expect(stored.slice(1).map((m) => m.content)).toEqual([
      '第3轮问题',
      '第3轮回复',
      '第4轮问题',
      '第4轮回复',
      '第5轮问题',
      '第5轮回复',
    ]);

    // compact 记录入库
    const compacts = persistence.listCompacts('session-1');
    expect(compacts).toHaveLength(1);
    expect(compacts[0]).toMatchObject({
      sessionId: 'session-1',
      summary: '此前对话的压缩摘要：修复了登录 bug。',
      messagesCompacted: 4,
    });

    // 返回值：被压缩条数与保留轮次
    expect(result.compactedMessages).toBe(4);
    expect(result.keptMessages).toHaveLength(6);
    expect(result.summaryMessage.role).toBe('compact-summary');
  });
});
